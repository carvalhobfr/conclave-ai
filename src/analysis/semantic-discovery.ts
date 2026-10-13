import { createHash } from "node:crypto";

import type {
  AuditFinding,
  AuditSemanticSection,
  HypothesisConfidence,
  HypothesisReachability,
  HypothesisReviewStatus,
  HypothesisTriggerKind,
  SemanticBudget,
  SemanticBudgetLimit,
  SemanticCost,
  SemanticPipeline,
  SemanticRegion,
  SemanticRegionState,
  SemanticStageUsage,
} from "../domain/audit.js";
import type { IndexedCodeUnit, IndexedFile, RepositoryCodeIndex } from "../domain/code-index.js";
import type { ContextBundle, PackedEvidenceUnit } from "../domain/context-bundle.js";
import type { LlmProvider } from "../domain/provider.js";
import { DEFAULT_REASONING_LIMITS, type AgentAssignment, type Claim, type ReasoningLimits, type ReasoningPreset } from "../domain/reasoning.js";
import { LocalHashEmbeddingProvider } from "../embeddings/local-hash-embedding.js";
import { AgentExecutionError, StructuredAgentRuntime, type AgentCallRecord } from "../reasoning/agent-runtime.js";
import { ReasoningEngine } from "../reasoning/reasoning-engine.js";
import { DISCOVERY_OUTPUT_JSON_SCHEMA, discoveryPrompt, discoverySystemPrompt, verifierPrompt, type DiscoveryRegionPrompt } from "../reasoning/role-prompts.js";
import { parseDiscoveryOutput, parseVerifierOutput, type DiscoveryHypothesisOutput, type DiscoveryOutput } from "../reasoning/structured-outputs.js";
import { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";
import { approximateTokenCount } from "../retrieval/context-packer.js";
import { EXCLUDED_CONTEXT_MARKER, ModelContextLedger } from "../security/model-context.js";
import { STRUCTURAL_SOURCE } from "../validation/coverage.js";
import { enclosingSymbol, occurrenceAnchor, stableId } from "../validation/finding-identity.js";
import { hasIgnoreDirective } from "../validation/finding-suppression.js";
import { evidenceDigest, plain } from "./finding-text.js";

/**
 * Semantic discovery: a model reads bounded regions of the indexed repository and proposes
 * behavioral defects that no rule describes. It starts from the code, never from a rule match.
 *
 * Everything it produces is a hypothesis. The deterministic checks are that the line a hypothesis
 * quotes exists in the file and, for a trigger that needs invalid input, whether the call site it
 * cites exists (when none does the hypothesis is kept and marked as unproven, never dropped). Selected hypotheses are then verified by one independent model (the default
 * `smart` pipeline) or challenged by the five reasoning roles (`deep`); either verdict is another
 * model judgement, and a verification that fails leaves the hypothesis inconclusive. Nothing here
 * executes code, and nothing here can confirm a defect, classify a finding or approve an issue.
 */

export const SEMANTIC_RULE_ID = "semantic-discovery";

/** Part of every cache key: change it whenever the prompt or the validation of its output changes. */
const PROMPT_VERSION = "3";
const REGION_MAX_BYTES = 12_000;
const RELATED_MAX_BYTES = 5_000;
const RELATED_MAX_UNITS = 6;
const RELATED_MAX_LINES = 30;
const MAX_HYPOTHESES_PER_REGION = 4;
const MAX_REGIONS_LISTED = 500;
const MAX_DISMISSED_LISTED = 100;
const CACHE_ENTRY_LIMIT = 5_000;
/** Calls one hypothesis may need: a verifier call and its repair, or the reasoning roles. */
const CALLS_PER_INVESTIGATION: Readonly<Record<SemanticPipeline, number>> = { smart: 2, deep: 4 };
const VERIFICATION_QUESTION = "A reviewer proposed the defect hypothesis in the claim. Test it against the source; do not assume it is true. Decide whether the code really behaves that way and whether that is a defect of this code as written.";
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?|fixtures?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/iu;

export const DEFAULT_SEMANTIC_BUDGET: SemanticBudget = {
  maxModelCalls: 40,
  maxInputTokens: 200_000,
  maxOutputTokens: 40_000,
  maxDurationMs: 15 * 60_000,
  maxRegions: 30,
  maxInvestigations: 10,
};

/** Supplied by the operator. Conclave has no price list and never guesses one. */
export interface SemanticPricing {
  readonly inputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
}

export interface SemanticAuditOptions {
  readonly providers: ReadonlyMap<string, LlmProvider>;
  /** Role assignments used to challenge hypotheses, as Ask and Investigate use them. */
  readonly assignments: readonly AgentAssignment[];
  /** Model that reads regions. Normally the cheapest one configured. */
  readonly discovery: { readonly providerId: string; readonly modelId: string; readonly fallbackModelId?: string };
  readonly preset: ReasoningPreset;
  /** `smart` (default): one verifier call per hypothesis. `deep`: the five reasoning roles. */
  readonly pipeline?: SemanticPipeline;
  /** Smart pipeline: the model that verifies. Defaults to the Verifier role's assignment. */
  readonly verifier?: { readonly providerId: string; readonly modelId: string; readonly fallbackModelId?: string };
  readonly privacyBoundary: "local-only" | "external";
  readonly budget?: Partial<SemanticBudget>;
  readonly pricing?: SemanticPricing;
  /** Called between model calls with a one-line status. Never receives source text. */
  readonly onProgress?: (message: string) => void;
}

interface GroundedHypothesis {
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly defectClass: DiscoveryHypothesisOutput["defectClass"];
  readonly severity: DiscoveryHypothesisOutput["severity"];
  readonly confidence: HypothesisConfidence;
  readonly trigger: string;
  readonly consequence: string;
  readonly suggestion?: string;
  readonly triggerKind: HypothesisTriggerKind;
  readonly reachability?: HypothesisReachability;
  readonly reachedBy?: { readonly path: string; readonly line: number };
}

interface CachedDiscovery {
  readonly at: string;
  readonly proposed: number;
  readonly ungrounded: number;
  readonly reachabilityUnproven: number;
  readonly hypotheses: readonly GroundedHypothesis[];
}

interface CachedReview {
  readonly at: string;
  readonly status: HypothesisReviewStatus;
  readonly detail?: string;
  readonly explanation?: string;
}

/** Leading name of a model id, for telling whether two models are of one family. A reading of names only. */
export function modelFamily(modelId: string): string {
  const name = modelId.toLowerCase().split("/").at(-1) ?? "";
  return /^[^a-z]*([a-z]+)/u.exec(name)?.[1] ?? name;
}

/**
 * Results of earlier runs, keyed by a digest of everything the model was shown and of the model
 * itself. An unchanged region costs no call the next time, so a bounded audit continues where
 * the previous one stopped. It holds model output and paths, never source text.
 */
export interface SemanticCache {
  readonly schemaVersion: 1;
  readonly discoveries: Readonly<Record<string, CachedDiscovery>>;
  readonly reviews: Readonly<Record<string, CachedReview>>;
}

export const EMPTY_SEMANTIC_CACHE: SemanticCache = { schemaVersion: 1, discoveries: {}, reviews: {} };

export function parseSemanticCache(value: unknown): SemanticCache {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const isMap = (item: unknown): item is Record<string, never> => typeof item === "object" && item !== null && !Array.isArray(item);
  if (record["schemaVersion"] !== 1 || !isMap(record["discoveries"]) || !isMap(record["reviews"])) return EMPTY_SEMANTIC_CACHE;
  return { schemaVersion: 1, discoveries: record["discoveries"], reviews: record["reviews"] };
}

interface PlannedRegion {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

interface RelatedExcerpt {
  readonly unitId: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly relation: string;
  readonly excerpt: string;
}

function sourceLines(file: IndexedFile): readonly string[] {
  const lines = file.sourceText.split(/\r?\n/u);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function unitPath(index: RepositoryCodeIndex, node: { readonly kind: string; readonly id: string }): string | undefined {
  return node.kind === "file" ? node.id : index.units[node.id]?.path;
}

/** Files a model can usefully read, most connected first; tests and fixtures after product code. */
function eligibleFiles(index: RepositoryCodeIndex): readonly IndexedFile[] {
  const degree = new Map<string, number>();
  for (const edge of index.graphEdges) {
    const [from, to] = [unitPath(index, edge.from), unitPath(index, edge.to)];
    if (from === undefined || to === undefined || from === to) continue;
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  }
  return Object.values(index.files)
    .filter((file) => STRUCTURAL_SOURCE.test(file.path) && file.sourceText.trim() !== "")
    .sort((left, right) =>
      Number(TEST_PATH.test(left.path)) - Number(TEST_PATH.test(right.path)) ||
      (degree.get(right.path) ?? 0) - (degree.get(left.path) ?? 0) ||
      left.path.localeCompare(right.path));
}

/** One region per file, or several for a file too large for one prompt, cut at top-level symbols where possible. */
function regionsOf(index: RepositoryCodeIndex, file: IndexedFile): readonly PlannedRegion[] {
  const lines = sourceLines(file);
  if (Buffer.byteLength(file.sourceText) <= REGION_MAX_BYTES) return [{ path: file.path, startLine: 1, endLine: Math.max(1, lines.length) }];
  const boundaries = new Set(file.symbolIds
    .map((id) => index.units[id])
    .filter((unit): unit is IndexedCodeUnit => unit !== undefined && unit.parentSymbol === undefined)
    .map((unit) => unit.startLine));
  const regions: PlannedRegion[] = [];
  let start = 1;
  let bytes = 0;
  let lastBoundary = 0;
  for (let line = 1; line <= lines.length; line += 1) {
    const size = Buffer.byteLength(lines[line - 1] ?? "") + 1;
    if (bytes + size > REGION_MAX_BYTES && line > start) {
      const cut = lastBoundary > start ? lastBoundary : line;
      regions.push({ path: file.path, startLine: start, endLine: cut - 1 });
      bytes = lines.slice(cut - 1, line - 1).reduce((total, text) => total + Buffer.byteLength(text) + 1, 0);
      start = cut;
      lastBoundary = 0;
    }
    if (boundaries.has(line) && line > start) lastBoundary = line;
    bytes += size;
  }
  regions.push({ path: file.path, startLine: start, endLine: lines.length });
  return regions;
}

function inRegion(unit: IndexedCodeUnit, region: PlannedRegion): boolean {
  return unit.path === region.path && unit.startLine <= region.endLine && unit.endLine >= region.startLine;
}

function excerptOf(index: RepositoryCodeIndex, unit: IndexedCodeUnit): string {
  const file = index.files[unit.path];
  if (file === undefined) return "";
  const end = Math.min(unit.endLine, unit.startLine + RELATED_MAX_LINES - 1);
  return sourceLines(file).slice(unit.startLine - 1, end).join("\n");
}

/** Code the region uses and code that uses the region, taken from the graph, within a byte budget. */
function relatedCode(index: RepositoryCodeIndex, region: PlannedRegion, ledger: ModelContextLedger, extra: readonly IndexedCodeUnit[] = []): readonly RelatedExcerpt[] {
  const candidates: { readonly unit: IndexedCodeUnit; readonly relation: string; readonly order: number }[] = extra.map((unit) => ({ unit, relation: "requested definition", order: 0 }));
  for (const edge of index.graphEdges) {
    if (edge.relation === "belongs-to-file" || edge.relation === "contains-symbol" || edge.relation === "exports-symbol") continue;
    const from = edge.from.kind === "symbol" ? index.units[edge.from.id] : undefined;
    const to = edge.to.kind === "symbol" ? index.units[edge.to.id] : undefined;
    const fromInside = from !== undefined ? inRegion(from, region) : edge.from.kind === "file" && edge.from.id === region.path;
    const toInside = to !== undefined && inRegion(to, region);
    if (fromInside && to !== undefined && !toInside) candidates.push({ unit: to, relation: `${edge.relation}: used by the target region`, order: edge.relation === "calls-symbol" ? 1 : 3 });
    else if (toInside && from !== undefined && !fromInside) candidates.push({ unit: from, relation: `${edge.relation}: uses the target region`, order: 2 });
  }
  const selected: RelatedExcerpt[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const candidate of candidates.sort((left, right) => left.order - right.order || left.unit.path.localeCompare(right.unit.path) || left.unit.startLine - right.unit.startLine)) {
    if (selected.length >= RELATED_MAX_UNITS || seen.has(candidate.unit.id)) continue;
    seen.add(candidate.unit.id);
    const excerpt = ledger.protect(candidate.unit.path, excerptOf(index, candidate.unit));
    if (excerpt === "" || excerpt === EXCLUDED_CONTEXT_MARKER || bytes + Buffer.byteLength(excerpt) > RELATED_MAX_BYTES) continue;
    bytes += Buffer.byteLength(excerpt);
    selected.push({
      unitId: candidate.unit.id,
      path: candidate.unit.path,
      startLine: candidate.unit.startLine,
      endLine: Math.min(candidate.unit.endLine, candidate.unit.startLine + RELATED_MAX_LINES - 1),
      relation: candidate.relation,
      excerpt,
    });
  }
  return selected;
}

function normalized(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * The line a hypothesis quotes, or `undefined` when the quote is not in the region. The model's
 * own line number only breaks a tie: small models miscount lines, and they cannot fake a quote.
 */
function locateQuote(lines: readonly string[], region: PlannedRegion, hypothesis: DiscoveryHypothesisOutput): number | undefined {
  const quote = normalized((hypothesis.quote.split(/\r?\n/u).find((line) => line.trim() !== "") ?? "").replace(/^\s*\d+\|\s?/u, ""));
  if (quote.replace(/\s/gu, "").length < 4) return undefined;
  let best: number | undefined;
  for (let line = region.startLine; line <= region.endLine; line += 1) {
    const text = normalized(lines[line - 1] ?? "");
    if (text === "" || !(text.includes(quote) || (text.length >= 12 && quote.includes(text)))) continue;
    if (best === undefined || Math.abs(line - hypothesis.line) < Math.abs(best - hypothesis.line)) best = line;
  }
  return best;
}

function innermostUnit(index: RepositoryCodeIndex, path: string, line: number): IndexedCodeUnit | undefined {
  return (index.files[path]?.symbolIds ?? [])
    .map((id) => index.units[id])
    .filter((unit): unit is IndexedCodeUnit => unit !== undefined && unit.startLine <= line && unit.endLine >= line)
    .sort((left, right) => left.endLine - left.startLine - (right.endLine - right.startLine))[0];
}

/**
 * The call site an invalid-input hypothesis cites, or `undefined` when the shown code has none
 * (which leaves reachability unproven; it does not show the input cannot arrive).
 * It must be a shown line outside the function itself that calls it by name and contains the
 * quote. That establishes a real caller exists; whether it passes the bad value is the verifier's
 * question.
 */
function locateCaller(
  index: RepositoryCodeIndex,
  lines: readonly string[],
  region: PlannedRegion,
  related: readonly RelatedExcerpt[],
  defectLine: number,
  quote: string | undefined,
): { readonly path: string; readonly line: number } | undefined {
  const unit = innermostUnit(index, region.path, defectLine);
  const wanted = normalized((quote ?? "").replace(/^\s*\d+\|\s?/u, ""));
  if (unit === undefined || wanted.replace(/\s/gu, "").length < 4) return undefined;
  const call = new RegExp(`(?<![\\w$])${unit.symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\(`, "u");
  const matches = (text: string): boolean => call.test(text) && normalized(text).includes(wanted);
  for (let line = region.startLine; line <= region.endLine; line += 1) {
    if (line >= unit.startLine && line <= unit.endLine) continue;
    if (matches(lines[line - 1] ?? "")) return { path: region.path, line };
  }
  for (const item of related) {
    if (item.unitId === unit.id) continue;
    const offset = item.excerpt.split("\n").findIndex(matches);
    if (offset !== -1) return { path: item.path, line: item.startLine + offset };
  }
  return undefined;
}

const CONFIDENCE_ORDER: Readonly<Record<HypothesisConfidence, number>> = { high: 0, medium: 1, low: 2 };
const SEVERITY_ORDER: Readonly<Record<AuditFinding["severity"], number>> = { high: 0, medium: 1, low: 2 };

function digest(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40);
}

class UsageMeter {
  readonly #stages = new Map<string, SemanticStageUsage>();
  public calls = 0;
  public failedCalls = 0;
  public inputTokens = 0;
  public outputTokens = 0;

  public add(usage: SemanticStageUsage): void {
    const key = `${usage.stage}\0${usage.providerId}\0${usage.modelId}`;
    const earlier = this.#stages.get(key);
    this.#stages.set(key, earlier === undefined ? usage : {
      ...earlier,
      calls: earlier.calls + usage.calls,
      ...(usage.failedCalls === undefined ? {} : { failedCalls: (earlier.failedCalls ?? 0) + usage.failedCalls }),
      approximateInputTokens: earlier.approximateInputTokens + usage.approximateInputTokens,
      approximateOutputTokens: earlier.approximateOutputTokens + usage.approximateOutputTokens,
      providerReportedInputTokens: earlier.providerReportedInputTokens + usage.providerReportedInputTokens,
      providerReportedOutputTokens: earlier.providerReportedOutputTokens + usage.providerReportedOutputTokens,
      latencyMs: earlier.latencyMs + usage.latencyMs,
    });
    this.calls += usage.calls;
    this.failedCalls += usage.failedCalls ?? 0;
    this.inputTokens += usage.approximateInputTokens;
    this.outputTokens += usage.approximateOutputTokens;
  }

  public addCalls(stage: SemanticStageUsage["stage"], records: readonly AgentCallRecord[]): void {
    for (const record of records) {
      this.add({
        stage,
        providerId: record.providerId,
        modelId: record.modelId,
        calls: 1,
        failedCalls: record.failed ? 1 : 0,
        approximateInputTokens: record.approximateInputTokens,
        approximateOutputTokens: record.approximateOutputTokens,
        providerReportedInputTokens: record.providerUsage?.inputTokens ?? 0,
        providerReportedOutputTokens: record.providerUsage?.outputTokens ?? 0,
        latencyMs: record.latencyMs,
      });
    }
  }

  public stages(): readonly SemanticStageUsage[] {
    return [...this.#stages.values()].sort((left, right) => left.stage.localeCompare(right.stage) || left.modelId.localeCompare(right.modelId));
  }
}

function costOf(stages: readonly SemanticStageUsage[], options: SemanticAuditOptions): SemanticCost {
  if (options.pricing === undefined) return options.privacyBoundary === "local-only" ? { status: "local-inference" } : { status: "not-priced" };
  const sum = (pick: (stage: SemanticStageUsage) => number): number => stages.reduce((total, stage) => total + pick(stage), 0);
  // Provider counts are used only when every stage has them; mixing the two would describe neither.
  const reported = stages.length > 0 && stages.every((stage) => stage.providerReportedInputTokens > 0);
  const input = reported ? sum((stage) => stage.providerReportedInputTokens) : sum((stage) => stage.approximateInputTokens);
  const output = reported ? sum((stage) => stage.providerReportedOutputTokens) : sum((stage) => stage.approximateOutputTokens);
  return {
    status: "estimated",
    currency: "USD",
    amount: Math.round((input * options.pricing.inputPerMillionTokens + output * options.pricing.outputPerMillionTokens) / 1_000_000 * 1_000_000) / 1_000_000,
    inputPerMillionTokens: options.pricing.inputPerMillionTokens,
    outputPerMillionTokens: options.pricing.outputPerMillionTokens,
    basis: reported ? "provider-reported" : "approximate",
  };
}

interface Candidate extends GroundedHypothesis {
  readonly region: PlannedRegion;
  readonly fingerprint: string;
  readonly symbol?: string;
  readonly evidence: AuditFinding["evidence"];
  readonly evidenceDigest: string;
}

function investigationQuestion(candidate: Candidate): string {
  return [
    "A reviewer proposed the defect hypothesis below. Test it against the source; do not assume it is true.",
    `Location: ${candidate.path}:${String(candidate.line)}${candidate.symbol === undefined ? "" : ` in ${candidate.symbol}`}.`,
    `Hypothesis: ${candidate.title}`,
    `Claimed trigger: ${candidate.trigger}`,
    `Claimed consequence: ${candidate.consequence}`,
    "State as claims only what must hold for this to be a real defect. Read the complete function, and check whether its callers or callees already prevent the trigger or the consequence.",
  ].join("\n");
}

export interface SemanticDiscoveryInput {
  readonly index: RepositoryCodeIndex;
  /** `snapshot.id` of the audited content. */
  readonly snapshot: string;
  /** Rule findings of the same audit: shown to the model as already reported, and used to drop duplicates. */
  readonly ruleFindings: readonly AuditFinding[];
  readonly options: SemanticAuditOptions;
  readonly cache?: SemanticCache;
}

export interface SemanticDiscoveryResult {
  /** Hypotheses as findings, not yet annotated with baseline or applicability. */
  readonly findings: readonly Omit<AuditFinding, "baseline" | "applicability">[];
  readonly section: AuditSemanticSection;
  readonly cache: SemanticCache;
}

export async function runSemanticDiscovery(input: SemanticDiscoveryInput): Promise<SemanticDiscoveryResult> {
  const { index, options } = input;
  const started = performance.now();
  const budget: SemanticBudget = { ...DEFAULT_SEMANTIC_BUDGET, ...options.budget };
  const progress = options.onProgress ?? (() => undefined);
  const meter = new UsageMeter();
  const ledger = new ModelContextLedger();
  const discoveries: Record<string, CachedDiscovery> = { ...(input.cache?.discoveries ?? {}) };
  const reviews: Record<string, CachedReview> = { ...(input.cache?.reviews ?? {}) };
  const limits: ReasoningLimits = { ...DEFAULT_REASONING_LIMITS, maxOutputTokensPerCall: 2_000 };
  const discoveryRuntime = new StructuredAgentRuntime(
    options.providers,
    [{ role: "investigator", providerId: options.discovery.providerId, modelId: options.discovery.modelId, ...(options.discovery.fallbackModelId === undefined ? {} : { fallbackModelId: options.discovery.fallbackModelId }) }],
    limits,
  );
  const task = { systemPrompt: discoverySystemPrompt(), responseSchema: DISCOVERY_OUTPUT_JSON_SCHEMA };
  const systemTokens = approximateTokenCount(Buffer.byteLength(task.systemPrompt));
  const pipeline: SemanticPipeline = options.pipeline ?? "smart";
  const verifierAssignment = options.verifier ?? options.assignments.find((item) => item.role === "verifier") ?? options.discovery;
  const independent = verifierAssignment.providerId !== options.discovery.providerId || verifierAssignment.modelId !== options.discovery.modelId;
  const verifierRecord = { providerId: verifierAssignment.providerId, modelId: verifierAssignment.modelId, independent, sameModelFamily: modelFamily(verifierAssignment.modelId) === modelFamily(options.discovery.modelId) };
  const verifierRuntime = new StructuredAgentRuntime(
    options.providers,
    [{ role: "verifier", providerId: verifierAssignment.providerId, modelId: verifierAssignment.modelId, ...(verifierAssignment.fallbackModelId === undefined ? {} : { fallbackModelId: verifierAssignment.fallbackModelId }) }],
    limits,
  );
  // Calls kept back so that checking the best hypotheses is not starved by reading more regions.
  const reserved = Math.min(budget.maxInvestigations * CALLS_PER_INVESTIGATION[pipeline], Math.floor(budget.maxModelCalls * 0.4));

  const exhausted = (callLimit: number, nextInputTokens: number): SemanticBudgetLimit | undefined => {
    if (meter.calls >= callLimit) return "model-calls";
    if (meter.inputTokens + nextInputTokens > budget.maxInputTokens) return "input-tokens";
    if (meter.outputTokens >= budget.maxOutputTokens) return "output-tokens";
    if (performance.now() - started >= budget.maxDurationMs) return "duration";
    return undefined;
  };

  const files = eligibleFiles(index);
  const planned = files.flatMap((file) => regionsOf(index, file));
  const states = new Map<PlannedRegion, SemanticRegionState>();
  const grounded: { readonly region: PlannedRegion; readonly hypothesis: GroundedHypothesis }[] = [];
  const dismissed: { path: string; line?: number; title: string; reason: string }[] = [];
  // What each region's model was shown, kept so that the verifier is shown exactly the same.
  const materials = new Map<PlannedRegion, { readonly numbered: string; readonly related: readonly RelatedExcerpt[] }>();
  let proposed = 0;
  let ungrounded = 0;
  let reachabilityUnproven = 0;
  let stoppedBy: SemanticBudgetLimit | undefined;
  let regionsSent = 0;

  for (const region of planned) {
    const file = index.files[region.path];
    if (file === undefined) continue;
    const lines = sourceLines(file);
    const regionText = lines.slice(region.startLine - 1, region.endLine).join("\n");
    const protectedText = ledger.protect(region.path, regionText);
    // A redaction that changes the line count would make every reported line number wrong.
    if (protectedText === EXCLUDED_CONTEXT_MARKER || protectedText.split("\n").length !== region.endLine - region.startLine + 1) {
      states.set(region, "not-examined-withheld");
      continue;
    }
    const numbered = protectedText.split("\n").map((line, offset) => `${String(region.startLine + offset)}| ${line}`).join("\n");
    const alreadyReported = input.ruleFindings
      .filter((finding) => finding.location.path === region.path && (finding.location.startLine ?? 0) >= region.startLine && (finding.location.startLine ?? 0) <= region.endLine)
      .map((finding) => ({ line: finding.location.startLine ?? 0, title: finding.title }));
    const promptFor = (extra: readonly IndexedCodeUnit[] = []): { readonly prompt: string; readonly related: readonly RelatedExcerpt[] } => {
      const related = relatedCode(index, region, ledger, extra);
      const record: DiscoveryRegionPrompt = { path: region.path, startLine: region.startLine, endLine: region.endLine, numberedSource: numbered, related: related.map((item) => ({ path: item.path, startLine: item.startLine, endLine: item.endLine, relation: item.relation, excerpt: item.excerpt })), alreadyReported };
      return { prompt: discoveryPrompt(record), related };
    };
    const first = promptFor();
    materials.set(region, { numbered, related: first.related });
    const key = digest(PROMPT_VERSION, options.discovery.providerId, options.discovery.modelId, first.prompt);
    const cached = discoveries[key];
    if (cached !== undefined) {
      states.set(region, "examined-cached");
      proposed += cached.proposed;
      ungrounded += cached.ungrounded;
      reachabilityUnproven += cached.reachabilityUnproven;
      for (const hypothesis of cached.hypotheses) grounded.push({ region, hypothesis });
      continue;
    }
    if (stoppedBy === undefined && regionsSent >= budget.maxRegions) stoppedBy = "regions";
    stoppedBy ??= exhausted(budget.maxModelCalls - reserved, systemTokens + approximateTokenCount(Buffer.byteLength(first.prompt)));
    if (stoppedBy !== undefined) {
      states.set(region, "not-examined-budget");
      continue;
    }
    regionsSent += 1;
    progress(`discovery ${String(regionsSent)}: ${region.path}:${String(region.startLine)}-${String(region.endLine)}`);
    const call = async (prompt: string): Promise<DiscoveryOutput | undefined> => {
      try {
        const execution = await discoveryRuntime.execute("investigator", prompt, parseDiscoveryOutput, Math.min(2, budget.maxModelCalls - reserved - meter.calls), task);
        meter.addCalls("discovery", execution.calls);
        for (const record of execution.calls) if (record.contextRedactions !== undefined) ledger.recordOutgoing(record.contextRedactions);
        return execution.output;
      } catch (error) {
        if (!(error instanceof AgentExecutionError)) throw error;
        meter.addCalls("discovery", error.calls);
        return undefined;
      }
    };
    let output = await call(first.prompt);
    if (output === undefined) {
      states.set(region, "not-examined-failed");
      continue;
    }
    // One targeted follow-up: definitions the model asked for and was not shown.
    if (output.needsContext.length > 0) {
      const shown = new Set(first.related.map((item) => item.unitId));
      const wanted = output.needsContext.flatMap((name) => Object.values(index.units).filter((unit) =>
        (unit.symbol === name || `${unit.parentSymbol ?? ""}.${unit.symbol}` === name) && !inRegion(unit, region) && !shown.has(unit.id)).slice(0, 2));
      const second = wanted.length === 0 ? undefined : promptFor(wanted);
      if (second !== undefined && exhausted(budget.maxModelCalls - reserved, systemTokens + approximateTokenCount(Buffer.byteLength(second.prompt))) === undefined) {
        const answered = await call(second.prompt);
        if (answered !== undefined) {
          output = answered;
          materials.set(region, { numbered, related: second.related });
        }
      }
    }
    states.set(region, "examined");
    const shownRelated = materials.get(region)?.related ?? first.related;
    let regionUngrounded = 0;
    let regionUnproven = 0;
    const regionHypotheses: GroundedHypothesis[] = [];
    for (const hypothesis of output.hypotheses) {
      const line = locateQuote(lines, region, hypothesis);
      if (line === undefined) {
        regionUngrounded += 1;
        dismissed.push({ path: region.path, title: plain(hypothesis.title), reason: "The quoted line was not found in the region" });
        continue;
      }
      // A trigger that needs invalid input is checked for a cited call site that exists. Finding
      // none leaves reachability unproven: the hypothesis is kept and says so.
      const reachedBy = hypothesis.triggerKind === "invalid-input" ? locateCaller(index, lines, region, shownRelated, line, hypothesis.reachedBy) : undefined;
      const reachability: HypothesisReachability | undefined = hypothesis.triggerKind !== "invalid-input" ? undefined : reachedBy === undefined ? "unproven" : "call-site-cited";
      if (reachability === "unproven") regionUnproven += 1;
      regionHypotheses.push({
        path: region.path,
        line,
        title: plain(hypothesis.title),
        defectClass: hypothesis.defectClass,
        severity: hypothesis.severity,
        confidence: hypothesis.confidence,
        trigger: plain(hypothesis.trigger),
        consequence: plain(hypothesis.consequence),
        ...(hypothesis.suggestion === undefined ? {} : { suggestion: plain(hypothesis.suggestion) }),
        triggerKind: hypothesis.triggerKind,
        ...(reachability === undefined ? {} : { reachability }),
        ...(reachedBy === undefined ? {} : { reachedBy }),
      });
    }
    proposed += output.hypotheses.length;
    ungrounded += regionUngrounded;
    reachabilityUnproven += regionUnproven;
    discoveries[key] = { at: new Date().toISOString(), proposed: output.hypotheses.length, ungrounded: regionUngrounded, reachabilityUnproven: regionUnproven, hypotheses: regionHypotheses };
    for (const hypothesis of regionHypotheses) grounded.push({ region, hypothesis });
  }

  // Filtering: one hypothesis per quoted line, nothing a rule already reported, a cap per region.
  let duplicates = 0;
  let coveredByRule = 0;
  const byFingerprint = new Map<string, Candidate>();
  const perRegion = new Map<PlannedRegion, number>();
  for (const { region, hypothesis } of [...grounded].sort((left, right) => CONFIDENCE_ORDER[left.hypothesis.confidence] - CONFIDENCE_ORDER[right.hypothesis.confidence])) {
    if (input.ruleFindings.some((finding) => finding.location.path === hypothesis.path && Math.abs((finding.location.startLine ?? -10) - hypothesis.line) <= 1)) {
      coveredByRule += 1;
      dismissed.push({ path: hypothesis.path, line: hypothesis.line, title: hypothesis.title, reason: "A rule finding already covers this line" });
      continue;
    }
    const location = { path: hypothesis.path, startLine: hypothesis.line, endLine: hypothesis.line, reason: "Line the model quoted as the location of the defect" };
    const fingerprint = stableId("audit", SEMANTIC_RULE_ID, hypothesis.path, occurrenceAnchor(index, location) ?? String(hypothesis.line));
    if (byFingerprint.has(fingerprint)) {
      duplicates += 1;
      continue;
    }
    if ((perRegion.get(region) ?? 0) >= MAX_HYPOTHESES_PER_REGION) {
      duplicates += 1;
      dismissed.push({ path: hypothesis.path, line: hypothesis.line, title: hypothesis.title, reason: `More than ${String(MAX_HYPOTHESES_PER_REGION)} hypotheses for one region; the less confident ones were dropped` });
      continue;
    }
    perRegion.set(region, (perRegion.get(region) ?? 0) + 1);
    const symbol = enclosingSymbol(index, hypothesis.path, hypothesis.line);
    const evidence = [
      { ...location, ...(symbol === undefined ? {} : { symbol }) },
      ...(hypothesis.reachedBy === undefined ? [] : [{ path: hypothesis.reachedBy.path, startLine: hypothesis.reachedBy.line, endLine: hypothesis.reachedBy.line, reason: "Call site the model cited as passing the triggering input" }]),
    ];
    byFingerprint.set(fingerprint, { ...hypothesis, region, fingerprint, ...(symbol === undefined ? {} : { symbol }), evidence, evidenceDigest: evidenceDigest(index, SEMANTIC_RULE_ID, evidence) });
  }

  // Verification. Smart: one independent model reads what discovery read. Deep: the five roles.
  const candidates = [...byFingerprint.values()].sort((left, right) =>
    CONFIDENCE_ORDER[left.confidence] - CONFIDENCE_ORDER[right.confidence] || SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    left.path.localeCompare(right.path) || left.line - right.line);
  const reviewerKey = pipeline === "smart"
    ? digest("smart", verifierAssignment.providerId, verifierAssignment.modelId)
    : digest(...options.assignments.map((item) => `${item.role}:${item.providerId}:${item.modelId}`), options.preset);
  const outcomes = new Map<string, { readonly status: CachedReview["status"]; readonly detail?: string; readonly explanation?: string; readonly modelCalls: number; readonly failed?: boolean }>();
  let investigated = 0;
  let verificationFailed = 0;
  let retrieval: CodeRetrievalService | undefined;

  const verify = async (candidate: Candidate): Promise<{ readonly status: CachedReview["status"]; readonly detail: string; readonly explanation?: string; readonly modelCalls: number; readonly failed?: boolean }> => {
    const material = materials.get(candidate.region);
    const unit = (id: string, path: string, startLine: number, endLine: number, excerpt: string, reason: string, rank: number): PackedEvidenceUnit =>
      ({ id, path, startLine, endLine, excerpt, rank, symbols: [], sourceEvidenceIds: [id], sourceUnitIds: [], reasons: [reason], contentHash: "" });
    const units = [
      unit("evidence_target", candidate.region.path, candidate.region.startLine, candidate.region.endLine, material?.numbered ?? "", "target region", 1),
      ...(material?.related ?? []).map((item, position) => unit(`evidence_related_${String(position)}`, item.path, item.startLine, item.endLine, item.excerpt, item.relation, position + 2)),
    ];
    const context: ContextBundle = {
      evidence: units,
      relationships: [],
      stats: { inputEvidenceCount: units.length, selectedEvidenceCount: units.length, packedEvidenceCount: units.length, sourceBytes: 0, approximateTokens: 0, filesRepresented: new Set(units.map((item) => item.path)).size, symbolsRepresented: 0, duplicateOrOverlappingUnitsRemoved: 0, truncated: false },
      budget: { graphDepth: 0, graphNodes: 0, retrievalCandidates: units.length, finalEvidence: units.length, sourceBytes: 0, approximateTokens: 0 },
    };
    const claim: Claim = {
      id: "claim_hypothesis",
      statement: [
        `${candidate.title}. Location ${candidate.path}:${String(candidate.line)}${candidate.symbol === undefined ? "" : ` in ${candidate.symbol}`}.`,
        `Trigger: ${candidate.trigger} Consequence: ${candidate.consequence}`,
        ...(candidate.reachedBy === undefined ? [] : [`The trigger is a value outside the function's evident domain. The cited call site is ${candidate.reachedBy.path}:${String(candidate.reachedBy.line)}. Reject the claim unless that call can really pass such a value.`]),
        ...(candidate.reachability === "unproven" ? ["The trigger is a value outside the function's evident domain, and no call site passing it was shown. Say uncertain, not rejected, when the code would misbehave on that value but nothing shown shows whether it can arrive."] : []),
      ].join(" "),
      evidenceIds: units.map((item) => item.id),
      challengeIds: [],
      verificationIds: [],
      status: "proposed",
      uncertainty: "hypothesis",
      origin: { role: "investigator", iteration: 0 },
    };
    const by = `${verifierAssignment.modelId}${independent ? "" : " (the discovery model, so not an independent check)"}`;
    try {
      const execution = await verifierRuntime.execute(
        "verifier",
        verifierPrompt(VERIFICATION_QUESTION, [claim], [], [], context, ledger),
        (raw) => parseVerifierOutput(raw, new Set([claim.id]), new Set(claim.evidenceIds), new Set()),
        Math.min(2, budget.maxModelCalls - meter.calls),
      );
      meter.addCalls("investigation", execution.calls);
      for (const record of execution.calls) if (record.contextRedactions !== undefined) ledger.recordOutgoing(record.contextRedactions);
      const decision = execution.output.decisions.find((entry) => entry.claimId === claim.id);
      const explanation = decision === undefined ? {} : { explanation: plain(decision.explanation).slice(0, 1_200) };
      if (decision?.outcome === "supported") return { status: "model-supported", detail: `Supported by verifier ${by}. A model judgement, not a reproduction.`, ...explanation, modelCalls: execution.calls.length };
      if (decision?.outcome === "rejected") return { status: "model-disputed", detail: `Rejected by verifier ${by}. A model judgement that can differ between runs.`, ...explanation, modelCalls: execution.calls.length };
      return { status: "inconclusive", detail: decision === undefined ? `Verifier ${by} returned no decision.` : `Verifier ${by} could not decide.`, ...explanation, modelCalls: execution.calls.length };
    } catch (error) {
      if (!(error instanceof AgentExecutionError)) throw error;
      meter.addCalls("investigation", error.calls);
      // A verification that did not happen supports nothing and rejects nothing.
      return { status: "inconclusive", detail: `Verification failed, so the hypothesis was not verified: ${plain(error.message).slice(0, 200)}`, modelCalls: error.calls.length, failed: true };
    }
  };

  for (const candidate of candidates) {
    const reviewKey = digest(PROMPT_VERSION, candidate.fingerprint, candidate.evidenceDigest, reviewerKey);
    const cached = reviews[reviewKey];
    if (cached !== undefined) {
      outcomes.set(candidate.fingerprint, { status: cached.status, ...(cached.detail === undefined ? {} : { detail: cached.detail }), ...(cached.explanation === undefined ? {} : { explanation: cached.explanation }), modelCalls: 0 });
      continue;
    }
    if (investigated >= budget.maxInvestigations) {
      outcomes.set(candidate.fingerprint, { status: "not-reviewed", detail: `Not among the ${String(budget.maxInvestigations)} hypotheses this run verified`, modelCalls: 0 });
      continue;
    }
    // The verifier is shown the target region and its related excerpts again, so its first
    // request is at least that large. Repair calls are metered after the fact.
    const shown = materials.get(candidate.region);
    const shownBytes = Buffer.byteLength(shown?.numbered ?? "") + (shown?.related ?? []).reduce((total, item) => total + Buffer.byteLength(item.excerpt), 0);
    const stop = exhausted(budget.maxModelCalls - (pipeline === "smart" ? 0 : 1), Math.max(2_000, systemTokens + approximateTokenCount(shownBytes)));
    if (stop !== undefined) {
      outcomes.set(candidate.fingerprint, { status: "not-reviewed", detail: `The ${stop} budget was exhausted before this hypothesis was verified`, modelCalls: 0 });
      continue;
    }
    investigated += 1;
    progress(`${pipeline === "smart" ? "verification" : "investigation"} ${String(investigated)}: ${candidate.path}:${String(candidate.line)}`);
    if (pipeline === "smart") {
      const outcome = await verify(candidate);
      if (outcome.failed === true) verificationFailed += 1;
      else reviews[reviewKey] = { at: new Date().toISOString(), status: outcome.status, detail: outcome.detail, ...(outcome.explanation === undefined ? {} : { explanation: outcome.explanation }) };
      outcomes.set(candidate.fingerprint, outcome);
      continue;
    }
    retrieval ??= new CodeRetrievalService(index, new LocalHashEmbeddingProvider());
    const engineLimits: ReasoningLimits = {
      ...limits,
      maxAgentCalls: Math.min(6, budget.maxModelCalls - meter.calls),
      maxApproximateInputTokens: Math.min(limits.maxApproximateInputTokens, budget.maxInputTokens - meter.inputTokens),
    };
    const result = await new ReasoningEngine({
      retrieval,
      runtime: new StructuredAgentRuntime(options.providers, options.assignments, engineLimits),
      preset: options.preset,
      limits: engineLimits,
    }).ask(investigationQuestion(candidate), "conclave");
    for (const usage of result.metrics.roleUsage) {
      if (usage.calls === 0) continue;
      meter.add({
        stage: "investigation",
        providerId: usage.providerIds.join("+"),
        modelId: usage.modelIds.join("+"),
        calls: usage.calls,
        approximateInputTokens: usage.approximateInputTokens,
        approximateOutputTokens: usage.approximateOutputTokens,
        providerReportedInputTokens: usage.providerReportedInputTokens,
        providerReportedOutputTokens: usage.providerReportedOutputTokens,
        latencyMs: usage.latencyMs,
      });
    }
    ledger.merge(result.contextProtection);
    const { supported, rejected, uncertain } = result.metrics.finalClaims;
    const counts = `${String(supported)} claim(s) supported, ${String(rejected)} rejected, ${String(uncertain)} uncertain`;
    const outcome: CachedReview = supported + rejected + uncertain === 0
      ? { at: new Date().toISOString(), status: "not-reviewed", detail: `The reasoning roles produced no claims (${result.terminationReason})` }
      : supported > 0 && rejected === 0
        ? { at: new Date().toISOString(), status: "model-supported", detail: `Model review: ${counts}. A model judgement, not a reproduction.` }
        : rejected > 0 && supported === 0
          ? { at: new Date().toISOString(), status: "model-disputed", detail: `Model review: ${counts}.` }
          : { at: new Date().toISOString(), status: "inconclusive", detail: `Model review: ${counts}.` };
    // A run cut short by its budget or by a provider failure says nothing durable about the hypothesis.
    if (result.terminationReason === "completed" && outcome.status !== "not-reviewed") reviews[reviewKey] = outcome;
    outcomes.set(candidate.fingerprint, { status: outcome.status, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }), modelCalls: result.metrics.modelCalls });
  }

  const byReview: Record<HypothesisReviewStatus, number> = { "not-reviewed": 0, "model-supported": 0, inconclusive: 0, "model-disputed": 0 };
  let rejectedByReview = 0;
  const findings: Omit<AuditFinding, "baseline" | "applicability">[] = [];
  const investigatedFiles = new Set<string>();
  for (const candidate of candidates) {
    const outcome = outcomes.get(candidate.fingerprint) ?? { status: "not-reviewed" as const, modelCalls: 0 };
    if (outcome.status !== "not-reviewed") investigatedFiles.add(candidate.path);
    if (outcome.status === "model-disputed") rejectedByReview += 1;
    byReview[outcome.status] += 1;
    const suppressed = hasIgnoreDirective(sourceLines(index.files[candidate.path] as IndexedFile), candidate.line, SEMANTIC_RULE_ID);
    findings.push({
      id: stableId("audit_finding", candidate.fingerprint),
      fingerprint: candidate.fingerprint,
      ruleId: SEMANTIC_RULE_ID,
      category: "correctness",
      severity: candidate.severity,
      title: candidate.title,
      explanation: `Trigger: ${candidate.trigger} Consequence: ${candidate.consequence}`,
      remediation: candidate.suggestion ?? "The model gave no suggestion. Establish the behavior first, for example with a test that exercises the stated trigger.",
      location: { path: candidate.path, startLine: candidate.line, endLine: candidate.line, ...(candidate.symbol === undefined ? {} : { symbol: candidate.symbol }) },
      evidence: candidate.evidence,
      evidenceDigest: candidate.evidenceDigest,
      origin: "ai-hypothesis",
      hypothesis: {
        providerId: options.discovery.providerId,
        modelId: options.discovery.modelId,
        defectClass: candidate.defectClass,
        confidence: candidate.confidence,
        trigger: candidate.trigger,
        consequence: candidate.consequence,
        triggerKind: candidate.triggerKind,
        ...(candidate.reachability === undefined ? {} : { reachability: candidate.reachability }),
        ...(candidate.reachedBy === undefined ? {} : { reachedBy: candidate.reachedBy }),
        grounding: "quote-located",
        review: {
          status: outcome.status,
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          modelCalls: outcome.modelCalls,
          ...(outcome.explanation === undefined ? {} : { explanation: outcome.explanation }),
          ...(pipeline === "smart" && outcome.status !== "not-reviewed" ? { verifier: verifierRecord } : {}),
        },
      },
      status: { ruleMatched: false, evidence: "source-located", reproduction: "not-attempted", humanConfirmation: "none", publication: "not-requested" },
      snapshot: input.snapshot,
      limitations: [
        "Proposed by a language model from the source it was shown. No rule matched and nothing was executed, so the behavior was not observed.",
        "The severity and confidence are the model's own and are not calibrated.",
        ...(outcome.status === "model-supported" ? ["The verification that supported it was done by a model. Its agreement is not independent proof."] : []),
        ...(outcome.status === "model-disputed" ? ["A model rejected this hypothesis. That is a judgement that can differ between runs, not a demonstration that the code is correct."] : []),
        ...(candidate.reachability === "call-site-cited" ? ["The trigger needs input outside the function's evident domain. A call site exists and was cited; that it passes such a value was not established."] : []),
        ...(candidate.reachability === "unproven" ? ["The trigger needs input outside the function's evident domain, and no call site passing it was found in the code the model was shown. Reachability is unproven; it was not shown to be unreachable."] : []),
      ],
      ...(suppressed ? { suppression: { directive: "conclave-ignore" as const } } : {}),
    });
  }
  findings.sort((left, right) => left.location.path.localeCompare(right.location.path) || (left.location.startLine ?? 0) - (right.location.startLine ?? 0));

  const regionsByState: Record<SemanticRegionState, number> = { examined: 0, "examined-cached": 0, "not-examined-budget": 0, "not-examined-failed": 0, "not-examined-withheld": 0 };
  const regions: SemanticRegion[] = [];
  const perFile = new Map<string, { examined: number; total: number }>();
  let linesExamined = 0;
  let eligibleLines = 0;
  for (const region of planned) {
    const state = states.get(region) ?? "not-examined-budget";
    regionsByState[state] += 1;
    regions.push({ ...region, state });
    const size = region.endLine - region.startLine + 1;
    const examined = state === "examined" || state === "examined-cached";
    eligibleLines += size;
    if (examined) linesExamined += size;
    const entry = perFile.get(region.path) ?? { examined: 0, total: 0 };
    perFile.set(region.path, { examined: entry.examined + Number(examined), total: entry.total + 1 });
  }
  const fileStates = [...perFile.values()];
  const filesExamined = fileStates.filter((entry) => entry.examined === entry.total).length;
  const filesNotExamined = fileStates.filter((entry) => entry.examined === 0).length;
  const complete = planned.length > 0 && regionsByState.examined + regionsByState["examined-cached"] === planned.length;
  const stages = meter.stages();
  const protection = ledger.summary();
  const sectionLimits = [
    "Every hypothesis is a language model's reading of source text. None was reproduced, and none is a confirmed defect until a person says so.",
    "A region with no hypothesis is not evidence that it is free of defects. Model output varies between runs and between models.",
    "Verification is done by a model. Its agreement or rejection is a judgement, not independent proof, and it can differ between runs; a rejected hypothesis is kept as model-disputed, not removed.",
    ...(pipeline === "smart" && !independent ? [`The verifier is the discovery model (${verifierAssignment.modelId}), so verification is not an independent check. Set a different verifier model to get one.`] : []),
    ...(verificationFailed > 0 ? [`${String(verificationFailed)} verification call(s) failed. Those hypotheses are recorded as inconclusive, not as supported or rejected.`] : []),
    ...(complete ? [] : [`${String(planned.length - regionsByState.examined - regionsByState["examined-cached"])} of ${String(planned.length)} eligible region(s) were not examined by a model${stoppedBy === undefined ? "" : ` (stopped by the ${stoppedBy} budget)`}. Run the audit again to continue: regions already examined are reused from the cache when the audit is allowed to write.`]),
    ...(planned.length === 0 ? ["No indexed source file was eligible for semantic discovery."] : []),
    ...(protection.redactions.length + protection.exclusions.length > 0 ? [`${String(protection.redactions.reduce((total, item) => total + item.count, 0))} recognized secret(s) were redacted and ${String(protection.exclusions.length)} excerpt(s) withheld before any model call. The model did not see that content.`] : []),
    "Token counts marked approximate are estimated from bytes. A time budget is checked between calls and cannot interrupt one in progress.",
  ];

  const prune = <T extends { readonly at: string }>(entries: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(entries).sort(([, left], [, right]) => right.at.localeCompare(left.at)).slice(0, CACHE_ENTRY_LIMIT));

  return {
    findings,
    section: {
      pipeline,
      discovery: { providerId: options.discovery.providerId, modelId: options.discovery.modelId },
      ...(pipeline === "smart" ? { verifier: verifierRecord } : {}),
      investigation: pipeline === "smart" ? [] : options.assignments.map((item) => ({ role: item.role, providerId: item.providerId, modelId: item.modelId })),
      privacyBoundary: options.privacyBoundary,
      budget,
      ...(stoppedBy === undefined ? {} : { stoppedBy }),
      usage: {
        modelCalls: meter.calls,
        failedCalls: meter.failedCalls,
        approximateInputTokens: meter.inputTokens,
        approximateOutputTokens: meter.outputTokens,
        providerReportedInputTokens: stages.reduce((total, stage) => total + stage.providerReportedInputTokens, 0),
        providerReportedOutputTokens: stages.reduce((total, stage) => total + stage.providerReportedOutputTokens, 0),
        durationMs: Math.max(0, performance.now() - started),
        byStage: stages,
        cost: costOf(stages, options),
      },
      coverage: {
        eligibleFiles: files.length,
        filesExamined,
        filesPartiallyExamined: fileStates.length - filesExamined - filesNotExamined,
        filesNotExamined,
        filesInvestigated: investigatedFiles.size,
        eligibleLines,
        linesExamined,
        regionsPlanned: planned.length,
        regionsByState,
        regions: regions.slice(0, MAX_REGIONS_LISTED),
        regionsOmitted: Math.max(0, regions.length - MAX_REGIONS_LISTED),
        complete,
      },
      hypotheses: { proposed, ungrounded, duplicates, coveredByRule, reachabilityUnproven, rejectedByReview, verificationFailed, recorded: findings.length, byReview },
      dismissed: dismissed.slice(0, MAX_DISMISSED_LISTED),
      dismissedOmitted: Math.max(0, dismissed.length - MAX_DISMISSED_LISTED),
      limits: sectionLimits,
    },
    cache: { schemaVersion: 1, discoveries: prune(discoveries), reviews: prune(reviews) },
  };
}
