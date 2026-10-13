import { isGated } from "./analysis/audit-policy.js";
import { AUDIT_DIRECTORY, AUDIT_LATEST_FILENAME, auditRepositoryWithLedger, severityAtLeast, type RecordedAudit } from "./analysis/repository-audit.js";
import type { SemanticAuditOptions } from "./analysis/semantic-discovery.js";
import { resolveSemanticSetup, type SemanticRequest } from "./analysis/semantic-setup.js";
import type { AuditFinding, AuditReport, AuditSemanticSection, AuditSeverity } from "./domain/audit.js";
import type { FindingLedger } from "./domain/finding-ledger.js";
import { explainCoverageGap } from "./validation/coverage.js";

/**
 * Exit codes of `conclave audit`. They describe an audit run and are unrelated to the
 * pass / warn / block / inconclusive verdicts of pull-request review.
 */
export const AUDIT_EXIT = {
  /** The audit ran and no finding reached the `--fail-on` severity. */
  completed: 0,
  /** At least one finding reached the `--fail-on` severity. */
  findings: 1,
  /** `--require-complete` was given and some source was not analyzed. */
  partialCoverage: 2,
  /** The audit could not run (unreadable path, invalid option). No report was produced. */
  failed: 3,
} as const;

const MAX_ROWS = 60;
const USAGE = "Usage: conclave audit [REPOSITORY] [--json] [--no-write] [--fail-on high|medium|low|none] [--require-complete] [--no-baseline] [--update-baseline] [--semantic [--deep] [--discovery-model MODEL] [--verifier-model MODEL] [--max-calls N] [--max-input-tokens N] [--max-output-tokens N] [--max-minutes N] [--max-regions N] [--investigate N] [--price-input USD --price-output USD]]";

/** Numeric options of `--semantic`, with the budget field or price each one sets. */
const SEMANTIC_NUMBERS = {
  "--max-calls": "maxModelCalls",
  "--max-input-tokens": "maxInputTokens",
  "--max-output-tokens": "maxOutputTokens",
  "--max-minutes": "maxDurationMs",
  "--max-regions": "maxRegions",
  "--investigate": "maxInvestigations",
  "--price-input": "priceInput",
  "--price-output": "priceOutput",
} as const;

export type SemanticArguments = SemanticRequest;

export interface AuditArguments {
  readonly path: string;
  readonly json: boolean;
  readonly write: boolean;
  readonly failOn: AuditSeverity | "none";
  readonly requireComplete: boolean;
  /** False with `--no-baseline`: audit as if no baseline file existed. */
  readonly baseline: boolean;
  /** `--update-baseline`: replace the baseline with this audit's findings. */
  readonly updateBaseline: boolean;
  /** Present only with `--semantic`. Without it the audit calls no model. */
  readonly semantic?: SemanticArguments;
}

export function parseAuditArguments(args: readonly string[]): AuditArguments {
  let path: string | undefined;
  let json = false;
  let write = true;
  let failOn: AuditArguments["failOn"] = "high";
  let requireComplete = false;
  let baseline = true;
  let updateBaseline = false;
  let semantic = false;
  let discoveryModel: string | undefined;
  let verifierModel: string | undefined;
  let deep = false;
  const numbers: Partial<Record<(typeof SEMANTIC_NUMBERS)[keyof typeof SEMANTIC_NUMBERS], number>> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const [name, inline] = argument.startsWith("--") && argument.includes("=") ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)] : [argument, undefined];
    if (argument === "--semantic") semantic = true;
    else if (argument === "--deep") deep = true;
    else if (name === "--discovery-model" || name === "--verifier-model") {
      const model = (inline ?? args[index += 1] ?? "").trim();
      if (model === "" || model.startsWith("--")) throw new Error(`${name} needs a model name. ${USAGE}`);
      if (name === "--discovery-model") discoveryModel = model;
      else verifierModel = model;
    } else if (Object.hasOwn(SEMANTIC_NUMBERS, name)) {
      const field = SEMANTIC_NUMBERS[name as keyof typeof SEMANTIC_NUMBERS];
      const value = Number(inline ?? args[index += 1]);
      const price = field === "priceInput" || field === "priceOutput";
      if (!Number.isFinite(value) || value < 0 || (!price && !Number.isInteger(value)) || (!price && field !== "maxInvestigations" && value < 1)) throw new Error(`${name} needs a ${price ? "non-negative number" : "whole number"}. ${USAGE}`);
      numbers[field] = value;
    } else if (argument === "--json") json = true;
    else if (argument === "--no-write") write = false;
    else if (argument === "--require-complete") requireComplete = true;
    else if (argument === "--no-baseline") baseline = false;
    else if (argument === "--update-baseline") updateBaseline = true;
    else if (argument === "--fail-on" || argument.startsWith("--fail-on=")) {
      const value = argument === "--fail-on" ? args[index += 1] : argument.slice("--fail-on=".length);
      if (value !== "high" && value !== "medium" && value !== "low" && value !== "none") throw new Error(`--fail-on must be high, medium, low or none. ${USAGE}`);
      failOn = value;
    } else if (argument.startsWith("--")) throw new Error(`Unknown audit option: ${argument}. ${USAGE}`);
    else if (path === undefined) path = argument;
    else throw new Error(`audit takes one repository path. ${USAGE}`);
  }
  // The baseline is a committed file. Writing it is its own explicit request and cannot hide behind --no-write.
  if (updateBaseline && !write) throw new Error(`--update-baseline writes .conclave-baseline.json and cannot be combined with --no-write. ${USAGE}`);
  if (updateBaseline && !baseline) throw new Error(`--update-baseline and --no-baseline contradict each other. ${USAGE}`);
  if (deep && verifierModel !== undefined) throw new Error(`--verifier-model applies to the default pipeline, not to --deep. ${USAGE}`);
  if (!semantic && (deep || discoveryModel !== undefined || verifierModel !== undefined || Object.keys(numbers).length > 0)) throw new Error(`Model options apply only with --semantic. ${USAGE}`);
  if ((numbers.priceInput === undefined) !== (numbers.priceOutput === undefined)) throw new Error(`--price-input and --price-output are given together. ${USAGE}`);
  const { priceInput, priceOutput, maxDurationMs, ...limits } = numbers;
  const semanticArguments: SemanticArguments | undefined = !semantic ? undefined : {
    budget: { ...limits, ...(maxDurationMs === undefined ? {} : { maxDurationMs: maxDurationMs * 60_000 }) },
    ...(discoveryModel === undefined ? {} : { discoveryModel }),
    ...(verifierModel === undefined ? {} : { verifierModel }),
    deep,
    ...(priceInput === undefined || priceOutput === undefined ? {} : { pricing: { inputPerMillionTokens: priceInput, outputPerMillionTokens: priceOutput } }),
  };
  return { path: path ?? ".", json, write, failOn, requireComplete, baseline, updateBaseline, ...(semanticArguments === undefined ? {} : { semantic: semanticArguments }) };
}

export function auditExitCode(report: AuditReport, options: Pick<AuditArguments, "failOn" | "requireComplete">): number {
  const threshold = options.failOn;
  if (threshold !== "none" && report.findings.some((finding) => isGated(finding) && severityAtLeast(finding.severity, threshold))) return AUDIT_EXIT.findings;
  if (options.requireComplete && report.coverage.status === "partial") return AUDIT_EXIT.partialCoverage;
  return AUDIT_EXIT.completed;
}

function location(finding: AuditFinding): string {
  const line = finding.location.startLine === undefined ? "" : `:${String(finding.location.startLine)}`;
  return `${finding.location.path}${line}`;
}

function marks(finding: AuditFinding): string {
  const notes = [...(finding.baseline === undefined ? [] : ["baseline"]), ...(finding.applicability === undefined ? [] : [finding.applicability.role])];
  return notes.length === 0 ? "" : ` [${notes.join(", ")}]`;
}

export function table(rows: readonly (readonly string[])[]): readonly string[] {
  const widths = (rows[0] ?? []).map((_, column) => Math.min(56, Math.max(...rows.map((row) => (row[column] ?? "").length))));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join("  ").trimEnd());
}

/** Plain text: no color is needed to read it, and severity is a word, not a hue. */
export function renderAuditReport(report: AuditReport, saved: string | undefined, recorded: { readonly ledger?: FindingLedger; readonly baselineWritten?: string } = {}): string {
  const lines: string[] = [];
  const commit = report.snapshot.headCommit === undefined ? "directory (no Git commit)" : `working tree at ${report.snapshot.headCommit.slice(0, 12)}`;
  lines.push(`Conclave audit · ${report.repository.name}`);
  lines.push(`Snapshot ${report.snapshot.id} · ${commit} · analyzer ${report.analyzer.version}`);
  lines.push("");
  const coverage = report.coverage;
  lines.push(`Coverage  ${coverage.status === "partial" ? "PARTIAL" : "supported source analyzed"} · ${String(coverage.filesAnalyzed)} of ${String(coverage.filesDiscovered)} files analyzed`);
  const accounting = coverage.accounting;
  const notAnalyzed = accounting.filesNotAnalyzed;
  lines.push(`  eligible source files: ${String(accounting.eligibleSourceFiles)} (${String(accounting.filesAnalyzed)} analyzed, ${String(accounting.eligibleSourceFiles - accounting.filesAnalyzed)} not)`);
  const reasons = ([["ignored", notAnalyzed.ignored], ["safety-excluded", notAnalyzed.safetyExcluded], ["unsupported type", notAnalyzed.unsupported], ["parser failure", notAnalyzed.parserFailure], ["binary, oversized, unreadable or symlink", notAnalyzed.unexamined]] as const)
    .filter(([, count]) => count > 0).map(([label, count]) => `${String(count)} ${label}`);
  if (reasons.length > 0) lines.push(`  files not analyzed (${String(accounting.filesDiscovered - accounting.filesAnalyzed)}): ${reasons.join(", ")}`);
  if (accounting.ignoredDirectories > 0) lines.push(`  not enumerated: ${String(accounting.ignoredDirectories)} ignored director${accounting.ignoredDirectories === 1 ? "y" : "ies"} (files inside are in no count)`);
  if (coverage.unanalyzedSource.length > 0) {
    lines.push(`  source or safety-withheld files not analyzed (${String(coverage.unanalyzedSource.length + coverage.unanalyzedSourceOmitted)}):`);
    for (const gap of coverage.unanalyzedSource.slice(0, 20)) lines.push(`    ${gap.path} — ${explainCoverageGap(gap)}`);
    const hidden = coverage.unanalyzedSource.length - 20 + coverage.unanalyzedSourceOmitted;
    if (hidden > 0) lines.push(`    +${String(hidden)} more (see --json)`);
  }
  lines.push("");
  const { bySeverity } = report.summary;
  const suppressed = report.summary.suppressed === 0 ? "" : ` · ${String(report.summary.suppressed)} suppressed by conclave-ignore`;
  lines.push(`Findings  ${String(report.summary.findings)} · high ${String(bySeverity.high)} · medium ${String(bySeverity.medium)} · low ${String(bySeverity.low)}${suppressed}`);
  if (report.summary.baselined > 0 || report.summary.exempt > 0) {
    lines.push(`  counted by --fail-on: ${String(report.summary.gated)} · in baseline: ${String(report.summary.baselined)} · exempt by ${report.policy.applicability?.path ?? "declaration"}: ${String(report.summary.exempt)}`);
  }
  const unsuppressed = report.findings.filter((finding) => finding.suppression === undefined);
  const active = unsuppressed.filter((finding) => finding.origin !== "ai-hypothesis");
  const hypotheses = unsuppressed.filter((finding) => finding.origin === "ai-hypothesis");
  if (active.length > 0) {
    lines.push("");
    const shown = active.slice(0, MAX_ROWS);
    lines.push(...table([
      ["SEVERITY", "RULE", "LOCATION", "FINDING"],
      ...shown.map((finding) => [finding.severity, finding.ruleId, location(finding), finding.title + marks(finding)]),
    ]));
    if (active.length > shown.length) lines.push(`+${String(active.length - shown.length)} more (see --json)`);
  }
  lines.push("");
  lines.push("Rules");
  lines.push(...table(report.rules.map((rule) => [
    `  ${rule.ruleId}`,
    rule.status,
    rule.status === "executed" ? `${String(rule.filesExamined)} files` : "",
    rule.status === "executed" ? `${String(rule.matches)} matches` : rule.reason ?? "",
  ])));
  if (report.semantic !== undefined) lines.push("", ...renderSemantic(report.semantic, hypotheses));
  lines.push("");
  lines.push("Limits");
  for (const limit of [...coverage.limits, ...(report.semantic?.limits ?? [])]) lines.push(`  - ${limit}`);
  lines.push("");
  lines.push(report.conclusion);
  lines.push(report.semantic === undefined
    ? `No model was called and no repository code was executed. ${String(report.metrics.graphEdges)} graph edges, ${String(Math.round(report.metrics.totalMs))} ms.`
    : `${String(report.trustBoundary.modelCalls)} model call(s) were made${report.trustBoundary.networkOperations ? " to a provider outside this machine" : " on this machine"}; no repository code was executed. Rules: ${String(report.metrics.graphEdges)} graph edges, ${String(Math.round(report.metrics.totalMs))} ms.`);
  if (recorded.baselineWritten !== undefined) lines.push(`Baseline written: ${recorded.baselineWritten} (${String(report.policy.baseline?.entries ?? 0)} finding(s)). Commit it to share it.`);
  lines.push(saved === undefined ? "Not saved (--no-write)." : `Saved: ${saved}`);
  const run = recorded.ledger?.runs[0];
  if (run !== undefined) {
    const state = run.byState;
    lines.push(`Ledger: ${String(state.new)} new · ${String(state.persistent)} persistent · ${String(state.reappeared)} reappeared · ${String(state.resolved)} resolved · ${String(state["not-evaluated"])} not evaluated. Next: conclave findings list`);
  }
  return lines.join("\n");
}

const REVIEW_TEXT = { "model-supported": "supported by a model", inconclusive: "inconclusive", "not-reviewed": "not verified", "model-disputed": "disputed by a model" } as const;

function renderSemantic(semantic: AuditSemanticSection, hypotheses: readonly AuditFinding[]): readonly string[] {
  const { coverage, usage, budget } = semantic;
  const lines = [
    `Semantic discovery  ${semantic.pipeline} pipeline · ${semantic.discovery.providerId} · ${semantic.discovery.modelId}${semantic.verifier === undefined ? "" : ` · verifier ${semantic.verifier.modelId}${semantic.verifier.independent ? "" : " (NOT independent)"}`} · ${semantic.privacyBoundary === "external" ? "EXTERNAL provider: source excerpts left this machine" : "local provider: nothing left this machine"}`,
    `  AI coverage: ${coverage.complete ? "all eligible regions examined" : "PARTIAL"} · ${String(coverage.linesExamined)} of ${String(coverage.eligibleLines)} eligible lines · files: ${String(coverage.filesExamined)} examined, ${String(coverage.filesPartiallyExamined)} partly, ${String(coverage.filesNotExamined)} not examined (of ${String(coverage.eligibleFiles)}) · ${String(coverage.filesInvestigated)} investigated in depth`,
    `  regions: ${String(coverage.regionsByState.examined)} examined now, ${String(coverage.regionsByState["examined-cached"])} reused from cache, ${String(coverage.regionsByState["not-examined-budget"])} not reached (budget), ${String(coverage.regionsByState["not-examined-failed"])} failed, ${String(coverage.regionsByState["not-examined-withheld"])} withheld${semantic.stoppedBy === undefined ? "" : ` · stopped by ${semantic.stoppedBy}`}`,
    `  usage: ${String(usage.modelCalls)} of ${String(budget.maxModelCalls)} calls (${String(usage.failedCalls)} failed) · ~${String(usage.approximateInputTokens)} input / ~${String(usage.approximateOutputTokens)} output tokens (approximate)${usage.providerReportedInputTokens > 0 ? ` · provider reported ${String(usage.providerReportedInputTokens)} / ${String(usage.providerReportedOutputTokens)}` : ""} · ${String(Math.round(usage.durationMs / 1000))} s`,
    `  cost: ${usage.cost.status === "estimated" ? `about ${usage.cost.amount.toFixed(4)} USD from the prices you gave (${usage.cost.basis} tokens)` : usage.cost.status === "local-inference" ? "no per-token charge (local inference; machine time not measured)" : "not computed (no price given; see --price-input and --price-output)"}`,
    `  hypotheses: ${String(semantic.hypotheses.proposed)} proposed · ${String(semantic.hypotheses.recorded)} recorded · dropped: ${String(semantic.hypotheses.ungrounded)} without a real quote, ${String(semantic.hypotheses.duplicates)} duplicate, ${String(semantic.hypotheses.coveredByRule)} covered by a rule · ${String(semantic.hypotheses.rejectedByReview)} disputed by verification (kept) · ${String(semantic.hypotheses.reachabilityUnproven)} with unproven reachability (kept)${semantic.hypotheses.verificationFailed === 0 ? "" : ` · ${String(semantic.hypotheses.verificationFailed)} verification(s) failed (kept as inconclusive)`}`,
  ];
  if (hypotheses.length > 0) {
    const shown = hypotheses.slice(0, MAX_ROWS);
    lines.push("", "Hypotheses (unconfirmed, not reproduced, never counted by --fail-on)", ...table([
      ["MODEL SAYS", "CONFIDENCE", "VERIFICATION", "LOCATION", "HYPOTHESIS"],
      ...shown.map((finding) => [finding.severity, finding.hypothesis?.confidence ?? "", REVIEW_TEXT[finding.hypothesis?.review.status ?? "not-reviewed"], location(finding), finding.title + marks(finding)]),
    ]));
    if (hypotheses.length > shown.length) lines.push(`+${String(hypotheses.length - shown.length)} more (see --json)`);
  }
  return lines;
}

/** Resolves `--semantic` and prints what will be called before anything is. */
function semanticOptions(args: SemanticArguments, announce: (line: string) => void): SemanticAuditOptions {
  const { options, disclosure } = resolveSemanticSetup(args);
  const discovery = `${disclosure.discovery.providerId}/${disclosure.discovery.modelId}`;
  announce(disclosure.verifier === undefined
    ? `Semantic discovery will call a model. Pipeline: deep. Discovery: ${discovery}. Challenge roles: ${disclosure.challengeRoles.join(", ")}.`
    : `Semantic discovery will call a model. Pipeline: smart. Discovery: ${discovery}. Verifier: ${disclosure.verifier.providerId}/${disclosure.verifier.modelId}.`);
  if (disclosure.verifier?.independent === false) announce("The verifier is the discovery model, so verification is a second reading by the same model. Use --verifier-model to name another.");
  announce(disclosure.privacyBoundary === "external"
    ? `EXTERNAL provider${disclosure.providerHost === undefined ? "" : ` at ${disclosure.providerHost}`}: sanitized source excerpts will leave this machine and the provider may charge for them. Sanitization recognizes known credential formats only.`
    : "Local provider: source stays on this machine.");
  const budget = disclosure.budget;
  announce(`Budget: ${String(budget.maxModelCalls)} calls, ${String(budget.maxInputTokens)} input tokens, ${String(budget.maxOutputTokens)} output tokens, ${String(Math.round(budget.maxDurationMs / 60_000))} min, ${String(budget.maxRegions)} regions, ${String(budget.maxInvestigations)} investigations.`);
  return { ...options, onProgress: (message) => announce(`  ${message}`) };
}

export async function auditCommand(args: readonly string[]): Promise<void> {
  let options: AuditArguments;
  let result: RecordedAudit;
  try {
    options = parseAuditArguments(args);
    // Disclosure and progress go to stderr so that --json output stays a single document.
    const semantic = options.semantic === undefined ? undefined : semanticOptions(options.semantic, (line) => console.error(line));
    result = await auditRepositoryWithLedger(options.path, { write: options.write, baseline: options.baseline, updateBaseline: options.updateBaseline, ...(semantic === undefined ? {} : { semantic }) });
  } catch (error) {
    console.error(`Conclave audit could not run: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = AUDIT_EXIT.failed;
    return;
  }
  const { report } = result;
  if (options.json) console.log(JSON.stringify(report, undefined, 2));
  else console.log(renderAuditReport(report, options.write ? `.conclave/${AUDIT_DIRECTORY}/${AUDIT_LATEST_FILENAME}` : undefined, result));
  process.exitCode = auditExitCode(report, options);
}
