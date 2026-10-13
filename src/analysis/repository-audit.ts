import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AuditCoverage, AuditCoverageAccounting, AuditFinding, AuditReport, AuditSeverity } from "../domain/audit.js";
import type { AuditEvaluation, FindingLedger } from "../domain/finding-ledger.js";
import type { CoverageGap, CoverageGapReason, RepositoryCodeIndex } from "../domain/code-index.js";
import type { SourceLanguage } from "../domain/repository.js";
import { resolveImport } from "../graph/code-graph.js";
import { conclaveStateDirectory, existingStateDirectory, readStateFile, writeStateFile } from "../storage/state-file.js";
import { formatReasonCounts, isSafetyGap, STRUCTURAL_SOURCE } from "../validation/coverage.js";
import { createDeterministicValidationIndex } from "../validation/deterministic-index.js";
import { enclosingSymbol, occurrenceAnchor, stableId } from "../validation/finding-identity.js";
import { hasIgnoreDirective } from "../validation/finding-suppression.js";
import { headCommit } from "../workflow/repository-inspector.js";
import { recordAuditInLedger } from "../workflow/triage-service.js";
import { applyAuditPolicy, BASELINE_FILENAME, createBaseline, isGated, loadAuditPolicy, type AuditPolicy } from "./audit-policy.js";
import { evidenceDigest, plain } from "./finding-text.js";
import { runRules, type RuleRun } from "./pipeline.js";
import { AnalysisContext, repositoryScopeFiles, type AnalysisRule, type RuleMatch } from "./rule.js";
import { REPOSITORY_RULES } from "./rules.js";
import { parseSemanticCache, runSemanticDiscovery, type SemanticAuditOptions, type SemanticCache } from "./semantic-discovery.js";

const MAX_UNANALYZED_SOURCE = 100;

const SEVERITY: Readonly<Record<string, AuditSeverity>> = {
  "parser-diagnostic": "high",
  "discarded-error": "medium",
  "unreleased-resource": "medium",
  "inconsistent-key": "medium",
  "unresolved-import": "medium",
  "import-cycle": "low",
};

const SEVERITY_ORDER: Readonly<Record<AuditSeverity, number>> = { high: 0, medium: 1, low: 2 };

const UNEXAMINED_SOURCE_REASONS: ReadonlySet<CoverageGapReason> = new Set(["binary", "oversized", "symlink", "unreadable"]);

/** Source the audit was expected to read and did not: a supported file type, or anything withheld for safety. */
function limitsCoverage(gap: CoverageGap): boolean {
  if (isSafetyGap(gap) || gap.reason === "parser-failure") return true;
  return UNEXAMINED_SOURCE_REASONS.has(gap.reason) && STRUCTURAL_SOURCE.test(gap.path);
}

const SAFETY_REASONS: ReadonlySet<CoverageGapReason> = new Set(["safety-excluded-path", "safety-excluded-content"]);

/**
 * Counts files, not entries. Each discovered file lands in exactly one bucket; an ignored
 * directory is not a file and is counted on its own, because its contents were never listed.
 */
export function accountForFiles(analyzed: number, gaps: readonly CoverageGap[]): AuditCoverageAccounting {
  const notAnalyzed = { ignored: 0, safetyExcluded: 0, unsupported: 0, parserFailure: 0, unexamined: 0 };
  let ignoredDirectories = 0;
  let eligibleUnanalyzed = 0;
  for (const gap of gaps) {
    if (gap.path.endsWith("/")) {
      ignoredDirectories += 1;
      continue;
    }
    if (gap.reason === "ignored") notAnalyzed.ignored += 1;
    else if (SAFETY_REASONS.has(gap.reason)) notAnalyzed.safetyExcluded += 1;
    else if (gap.reason === "unsupported-language") notAnalyzed.unsupported += 1;
    else if (gap.reason === "parser-failure") notAnalyzed.parserFailure += 1;
    else notAnalyzed.unexamined += 1;
    // Supported source that exists and is not ignored. A parser failure is by definition a supported language.
    if (gap.reason !== "ignored" && gap.reason !== "unsupported-language" && (gap.reason === "parser-failure" || STRUCTURAL_SOURCE.test(gap.path))) eligibleUnanalyzed += 1;
  }
  const unanalyzedFiles = Object.values(notAnalyzed).reduce((total, count) => total + count, 0);
  return {
    filesDiscovered: analyzed + unanalyzedFiles,
    filesAnalyzed: analyzed,
    filesNotAnalyzed: notAnalyzed,
    eligibleSourceFiles: analyzed + eligibleUnanalyzed,
    ignoredDirectories,
  };
}

function assessCoverage(index: RepositoryCodeIndex): AuditCoverage {
  const gaps = index.coverage?.gaps;
  const analyzed = Object.values(index.files);
  const accounting = accountForFiles(analyzed.length, gaps ?? []);
  const excluded: Partial<Record<CoverageGapReason, number>> = {};
  for (const gap of gaps ?? []) excluded[gap.reason] = (excluded[gap.reason] ?? 0) + 1;
  const analyzedByLanguage: Partial<Record<SourceLanguage, number>> = {};
  for (const file of analyzed) analyzedByLanguage[file.language] = (analyzedByLanguage[file.language] ?? 0) + 1;
  const unanalyzed = (gaps ?? []).filter(limitsCoverage);
  const limits = ["Rules read syntax and the import graph. No rule executes code, checks types or observes run-time behavior, so the absence of a match is not evidence of correctness."];
  if (gaps === undefined) limits.push("The index recorded no coverage information, so what was excluded from this audit is unknown.");
  if (unanalyzed.length > 0) limits.push(`${String(unanalyzed.length)} source file(s) were not analyzed (${formatReasonCounts(countReasons(unanalyzed))}). No rule result applies to them, and relationships through them are missing from the graph.`);
  if ((excluded.ignored ?? 0) > 0) limits.push(`${String(excluded.ignored)} entries matched an ignore rule (.gitignore, .conclaveignore or a built-in default) and were not examined: ${String(accounting.filesNotAnalyzed.ignored)} file(s) and ${String(accounting.ignoredDirectories)} director${accounting.ignoredDirectories === 1 ? "y" : "ies"}. Files inside an ignored directory were never listed and are in no file count.`);
  if ((excluded["unsupported-language"] ?? 0) > 0) limits.push(`${String(excluded["unsupported-language"])} file(s) of a type without a parser were not analyzed.`);
  return {
    status: gaps === undefined || unanalyzed.length > 0 ? "partial" : "supported-source-analyzed",
    filesDiscovered: accounting.filesDiscovered,
    filesAnalyzed: accounting.filesAnalyzed,
    excluded,
    accounting,
    analyzedByLanguage,
    unanalyzedSource: unanalyzed.slice(0, MAX_UNANALYZED_SOURCE),
    unanalyzedSourceOmitted: Math.max(0, unanalyzed.length - MAX_UNANALYZED_SOURCE),
    limits,
  };
}

function countReasons(gaps: readonly CoverageGap[]): Partial<Record<CoverageGapReason, number>> {
  const counts: Partial<Record<CoverageGapReason, number>> = {};
  for (const gap of gaps) counts[gap.reason] = (counts[gap.reason] ?? 0) + 1;
  return counts;
}

/**
 * Identity of the audited content: the same analyzed files with the same bytes, and the same
 * files left unanalyzed, give the same id. Ignored entries are not part of it, so build output,
 * dependencies and Conclave's own `.conclave` state do not change what was audited.
 */
function snapshotId(index: RepositoryCodeIndex): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(index.files).sort()) hash.update(`file\0${path}\0${index.files[path]?.contentHash ?? ""}\n`);
  for (const gap of (index.coverage?.gaps ?? []).filter((item) => item.reason !== "ignored").sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    hash.update(`gap\0${gap.path}\0${gap.reason}\n`);
  }
  return "snapshot_" + hash.digest("hex").slice(0, 32);
}

function findingsFrom(index: RepositoryCodeIndex, run: RuleRun, rules: readonly AnalysisRule[], snapshot: string): readonly Omit<AuditFinding, "baseline" | "applicability">[] {
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  const positioned = (match: RuleMatch): { readonly path: string; readonly line: number } => ({
    path: match.evidence[0]?.path ?? "",
    line: match.evidence[0]?.startLine ?? 0,
  });
  const ordered = [...run.matches].sort((left, right) => {
    const [a, b] = [positioned(left), positioned(right)];
    return (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line ||
      (left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0) || left.sequence - right.sequence;
  });
  // Rule, file, enclosing symbol and flagged line identify a finding; every file a multi-file
  // match involves is part of it. Matches still identical after that are numbered in source order.
  const occurrences = new Map<string, number>();
  return ordered.map((match) => {
    const primary = match.evidence[0];
    const involved = [...new Set(match.evidence.map((item) => item.path))].sort();
    const base = stableId("audit", match.ruleId, ...involved, occurrenceAnchor(index, primary) ?? match.title);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const fingerprint = occurrence === 0 ? base : stableId("audit", base, "occurrence", String(occurrence));
    const symbol = primary?.startLine === undefined ? undefined : enclosingSymbol(index, primary.path, primary.startLine);
    const rule = ruleById.get(match.ruleId);
    const suppressed = primary?.startLine !== undefined &&
      hasIgnoreDirective((index.files[primary.path]?.sourceText ?? "").split(/\r?\n/u), primary.startLine, match.ruleId);
    return {
      id: stableId("audit_finding", fingerprint),
      fingerprint,
      ruleId: match.ruleId,
      category: rule?.category ?? "correctness",
      severity: SEVERITY[match.ruleId] ?? "medium",
      title: plain(match.title),
      explanation: plain(match.detail),
      remediation: plain(match.remediation),
      location: {
        path: primary?.path ?? "",
        ...(primary?.startLine === undefined ? {} : { startLine: primary.startLine }),
        ...(primary?.endLine === undefined ? {} : { endLine: primary.endLine }),
        ...(symbol === undefined ? {} : { symbol }),
      },
      evidence: match.evidence.map((item) => ({ ...item, reason: plain(item.reason) })),
      evidenceDigest: evidenceDigest(index, match.ruleId, match.evidence),
      origin: "deterministic-rule" as const,
      status: { ruleMatched: true as const, evidence: "source-located" as const, reproduction: "not-attempted" as const, humanConfirmation: "none" as const, publication: "not-requested" as const },
      snapshot,
      limitations: rule === undefined ? [] : [rule.limitation],
      ...(suppressed ? { suppression: { directive: "conclave-ignore" as const } } : {}),
    };
  });
}

function importMetrics(index: RepositoryCodeIndex): { readonly relative: number; readonly resolved: number } {
  let relative = 0;
  let resolved = 0;
  for (const file of Object.values(index.files)) {
    if (file.language === "python" || file.language === "java") continue;
    for (const reference of file.imports) {
      if (!reference.source.startsWith(".")) continue;
      relative += 1;
      if (resolveImport(file.path, reference.source, file.language, index.files).status === "resolved") resolved += 1;
    }
  }
  return { relative, resolved };
}

function crossFileEdges(index: RepositoryCodeIndex): number {
  const pathOf = (node: { readonly kind: string; readonly id: string }): string | undefined =>
    node.kind === "file" ? node.id : index.units[node.id]?.path;
  return index.graphEdges.filter((edge) => {
    const [from, to] = [pathOf(edge.from), pathOf(edge.to)];
    return from !== undefined && to !== undefined && from !== to;
  }).length;
}

function conclusion(findings: number, coverage: AuditCoverage): string {
  const partial = coverage.status === "partial"
    ? " Coverage is partial: some source was not analyzed, so this result does not describe the whole repository."
    : "";
  return findings === 0
    ? `No rule matched in ${String(coverage.filesAnalyzed)} analyzed file(s). That is the result of the listed rules only, not evidence that the repository is free of defects.${partial}`
    : `${String(findings)} rule match(es) in ${String(coverage.filesAnalyzed)} analyzed file(s). Each is an observation with source evidence to review, not a confirmed or reproduced defect.${partial}`;
}

export interface AuditIndexInput {
  readonly index: RepositoryCodeIndex;
  readonly analyzerVersion: string;
  readonly headCommit?: string;
  readonly rules?: readonly AnalysisRule[];
  /** Milliseconds spent building the index, when the caller measured it. */
  readonly indexMs?: number;
  /** Baseline and applicability declarations to annotate findings with. */
  readonly policy?: AuditPolicy;
}

export interface AuditResult {
  readonly report: AuditReport;
  /** What this audit examined, for telling a resolved finding from one that was not looked at. */
  readonly evaluation: AuditEvaluation;
}

/**
 * Audits one already-built index. Pure with respect to the repository: it reads the index and
 * nothing else, so it cannot run repository code, reach a network or call a model.
 */
export function auditIndex(input: AuditIndexInput): AuditReport {
  return auditIndexWithEvaluation(input).report;
}

export function auditIndexWithEvaluation(input: AuditIndexInput): AuditResult {
  const started = performance.now();
  const { index } = input;
  const rules = input.rules ?? REPOSITORY_RULES;
  // The snapshot's own files, each examined whole. No change set exists in this scope.
  const run = runRules(rules, new AnalysisContext("repository", index, repositoryScopeFiles(index)));
  const snapshot = snapshotId(index);
  const policed = applyAuditPolicy(findingsFrom(index, run, rules, snapshot), input.policy ?? {});
  const findings = policed.findings;
  const coverage = assessCoverage(index);
  const rulesMs = Math.max(0, performance.now() - started);
  const imports = importMetrics(index);
  const memory = process.memoryUsage();
  const bySeverity: Record<AuditSeverity, number> = { high: 0, medium: 0, low: 0 };
  const byCategory: Partial<Record<AuditFinding["category"], number>> = {};
  const byRule: Record<string, number> = {};
  const active = findings.filter((finding) => finding.suppression === undefined);
  for (const finding of active) {
    bySeverity[finding.severity] += 1;
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
  }
  const gated = active.filter(isGated).length;
  const baselined = active.filter((finding) => finding.baseline !== undefined).length;
  const report: AuditReport = {
    schemaVersion: 1,
    kind: "repository-audit",
    scope: "repository",
    analyzer: { name: "conclave-ai", version: input.analyzerVersion, parser: index.parserId },
    repository: { id: index.repository.id, name: index.repository.name },
    snapshot: {
      id: snapshot,
      kind: input.headCommit === undefined ? "directory" : "working-tree",
      ...(input.headCommit === undefined ? {} : { headCommit: input.headCommit }),
    },
    generatedAt: new Date().toISOString(),
    conclusion: conclusion(active.length, coverage),
    coverage,
    summary: { findings: active.length, suppressed: findings.length - active.length, baselined, exempt: active.length - baselined - gated, gated, bySeverity, byCategory, byRule },
    findings,
    rules: run.executions,
    policy: policed.summary,
    metrics: {
      filesDiscovered: coverage.filesDiscovered,
      filesAnalyzed: coverage.filesAnalyzed,
      filesExcluded: coverage.filesDiscovered - coverage.filesAnalyzed,
      symbols: Object.keys(index.units).length,
      graphEdges: index.graphEdges.length,
      crossFileEdges: crossFileEdges(index),
      relativeImports: imports.relative,
      resolvedRelativeImports: imports.resolved,
      rulesExecuted: run.executions.filter((item) => item.status === "executed").length,
      rulesSkipped: run.executions.filter((item) => item.status === "skipped").length,
      indexMs: input.indexMs ?? 0,
      rulesMs,
      totalMs: (input.indexMs ?? 0) + Math.max(0, performance.now() - started),
      heapUsedBytes: memory.heapUsed,
      rssBytes: memory.rss,
    },
    trustBoundary: { deterministic: true, modelCalls: 0, repositoryCodeExecuted: false, networkOperations: false },
  };
  return {
    report,
    evaluation: {
      examinedByRule: new Map([...run.examined].map(([ruleId, paths]) => [ruleId, new Set(paths)])),
      analyzed: new Set(Object.keys(index.files)),
      gaps: (index.coverage?.gaps ?? []).map((gap) => ({ path: gap.path, reason: gap.reason })),
      exclusionsKnown: index.coverage !== undefined,
    },
  };
}

export async function analyzerVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "0.0.0";
}

export interface AuditOptions {
  /**
   * Save the report under `.conclave/audits/` and record the run in the finding ledger under
   * `.conclave/findings/`. Off by default: an audit writes nothing unless asked.
   */
  readonly write?: boolean;
  readonly rules?: readonly AnalysisRule[];
  /** False to audit as if `.conclave-baseline.json` did not exist. */
  readonly baseline?: boolean;
  /**
   * Replace `.conclave-baseline.json` with the findings of this audit. The one place an audit
   * writes outside `.conclave`, and only on this explicit request.
   */
  readonly updateBaseline?: boolean;
  /**
   * Run semantic discovery after the rules: a model reads regions of the repository and proposes
   * hypotheses. Absent by default, and then no model is called. The caller chooses the provider.
   */
  readonly semantic?: SemanticAuditOptions;
}

export interface RecordedAudit extends AuditResult {
  /** Present when the run was recorded (`write`). */
  readonly ledger?: FindingLedger;
  /** Repository-relative path of the baseline written by `updateBaseline`. */
  readonly baselineWritten?: string;
}

export const AUDIT_DIRECTORY = "audits";
export const AUDIT_LATEST_FILENAME = "latest.json";
export const SEMANTIC_CACHE_FILENAME = "semantic-cache.json";

/**
 * Adds the semantic stage to a finished rule audit. The rule findings, their summary and their
 * exit-code meaning are left exactly as they were; hypotheses are appended and counted apart.
 */
async function withSemanticDiscovery(result: AuditResult, index: RepositoryCodeIndex, policy: AuditPolicy, options: SemanticAuditOptions, cache: SemanticCache | undefined): Promise<AuditResult & { readonly cache: SemanticCache }> {
  const { report } = result;
  const discovery = await runSemanticDiscovery({ index, snapshot: report.snapshot.id, ruleFindings: report.findings, options, ...(cache === undefined ? {} : { cache }) });
  const hypotheses = applyAuditPolicy(discovery.findings, policy).findings;
  const recorded = hypotheses.filter((finding) => finding.suppression === undefined).length;
  const section = discovery.section;
  return {
    report: {
      ...report,
      conclusion: `${report.conclusion} Semantic discovery (${section.discovery.modelId}) examined ${String(section.coverage.linesExamined)} of ${String(section.coverage.eligibleLines)} eligible source line(s) and recorded ${String(recorded)} unconfirmed hypothesis(es); none was reproduced.`,
      findings: [...report.findings, ...hypotheses],
      semantic: section,
      trustBoundary: { deterministic: false, modelCalls: section.usage.modelCalls, repositoryCodeExecuted: false, networkOperations: section.privacyBoundary === "external" && section.usage.modelCalls > 0 },
    },
    evaluation: { ...result.evaluation, semanticDiscovery: true },
    cache: discovery.cache,
  };
}

/**
 * Audits the repository at `path` as it is on disk: loads it, indexes it with the local
 * deterministic index (held in memory, never the configured embedding provider), builds the
 * graph once and runs the repository-scope rules.
 */
export async function auditRepository(path: string, options: AuditOptions = {}): Promise<AuditReport> {
  return (await auditRepositoryWithLedger(path, options)).report;
}

export async function auditRepositoryWithLedger(path: string, options: AuditOptions = {}): Promise<RecordedAudit> {
  const started = performance.now();
  const { index } = await createDeterministicValidationIndex(resolve(path));
  const indexMs = Math.max(0, performance.now() - started);
  const root = index.repository.rootPath;
  const [commit, policy, version] = await Promise.all([headCommit(root), loadAuditPolicy(root, { baseline: options.baseline !== false && options.updateBaseline !== true }), analyzerVersion()]);
  const input: AuditIndexInput = {
    index,
    analyzerVersion: version,
    indexMs,
    ...(commit === undefined ? {} : { headCommit: commit }),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  };
  let result: AuditResult & { readonly index: RepositoryCodeIndex } = { ...auditIndexWithEvaluation({ ...input, policy }), index };
  let baselineWritten: string | undefined;
  if (options.updateBaseline === true) {
    const baseline = createBaseline(result.report);
    await writeStateFile(join(root, BASELINE_FILENAME), baseline);
    baselineWritten = BASELINE_FILENAME;
    // Report the audit as the new baseline sees it; the snapshot changes because the baseline file did.
    const reindexed = await createDeterministicValidationIndex(root);
    result = { ...auditIndexWithEvaluation({ ...input, index: reindexed.index, policy: { ...policy, baseline: { path: BASELINE_FILENAME, value: baseline } } }), index: reindexed.index };
  }
  if (options.semantic !== undefined) {
    // The cache is local state like the ledger: read and written only when the audit may write.
    const existing = options.write === true ? await existingStateDirectory(root, AUDIT_DIRECTORY) : undefined;
    const cache = existing === undefined ? undefined : parseSemanticCache((await readStateFile(join(existing, SEMANTIC_CACHE_FILENAME)).catch(() => undefined))?.value);
    const semantic = await withSemanticDiscovery(result, result.index, policy, options.semantic, cache);
    result = { ...semantic, index: result.index };
    if (options.write === true) await writeStateFile(join(await conclaveStateDirectory(root, AUDIT_DIRECTORY), SEMANTIC_CACHE_FILENAME), semantic.cache);
  }
  if (options.write !== true) return { report: result.report, evaluation: result.evaluation, ...(baselineWritten === undefined ? {} : { baselineWritten }) };
  const directory = await conclaveStateDirectory(root, AUDIT_DIRECTORY);
  await writeStateFile(join(directory, AUDIT_LATEST_FILENAME), result.report);
  const ledger = await recordAuditInLedger(root, result.report, result.evaluation);
  return { report: result.report, evaluation: result.evaluation, ledger, ...(baselineWritten === undefined ? {} : { baselineWritten }) };
}

export function severityAtLeast(severity: AuditSeverity, threshold: AuditSeverity): boolean {
  return SEVERITY_ORDER[severity] <= SEVERITY_ORDER[threshold];
}
