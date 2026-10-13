import type { AuditFinding, AuditReport } from "../domain/audit.js";
import {
  LEDGER_FINGERPRINT_SCHEME,
  LEDGER_SCHEMA_VERSION,
  type AuditEvaluation,
  type FindingLedger,
  type FindingLifecycleState,
  type LedgerDisposition,
  type LedgerFinding,
  type LedgerRun,
  type LedgerRunReference,
  type LedgerTransition,
} from "../domain/finding-ledger.js";
import { stableId } from "./finding-identity.js";

/** Audit runs kept, newest first. Older runs remain referenced by id from findings. */
export const LEDGER_RUN_LIMIT = 100;
const TRANSITION_LIMIT = 20;
/** A resolved finding nobody classified is dropped this long after it was resolved. */
export const RESOLVED_RETENTION_DAYS = 180;

export function auditRunId(report: AuditReport): string {
  return stableId("audit_run", report.snapshot.id, report.generatedAt);
}

function runReference(report: AuditReport): LedgerRunReference {
  return {
    runId: auditRunId(report),
    snapshot: report.snapshot.id,
    at: report.generatedAt,
    ...(report.snapshot.headCommit === undefined ? {} : { headCommit: report.snapshot.headCommit }),
  };
}

/**
 * Why an audit that did not observe a finding could not have observed it, or `undefined` when
 * the audit did examine the place and the finding is really absent.
 *
 * A finding is resolved only on positive grounds: its rule ran and examined every file the
 * finding involves, or such a file no longer exists at all. A file that is still there and was
 * ignored, withheld for safety, unparseable or outside the rule's reach leaves the question open.
 */
export function notEvaluatedReason(finding: Pick<LedgerFinding, "ruleId" | "location" | "evidence" | "origin">, evaluation: AuditEvaluation): string | undefined {
  const involved = [...new Set([finding.location.path, ...finding.evidence.map((item) => item.path)])].filter((path) => path !== "");
  const gapFor = (path: string) => evaluation.gaps.find((item) => item.path === path) ?? evaluation.gaps.find((item) => item.path.endsWith("/") && path.startsWith(item.path));
  if (finding.origin === "ai-hypothesis") {
    // A model that stays silent has not shown the defect is gone: its output varies between runs
    // and it may not have been asked. Only the file disappearing settles a hypothesis.
    if (evaluation.exclusionsKnown && involved.some((path) => !evaluation.analyzed.has(path) && gapFor(path) === undefined)) return undefined;
    return evaluation.semanticDiscovery === true
      ? "Semantic discovery did not propose this hypothesis again; a model's silence is not evidence that the defect is gone"
      : "Semantic discovery did not run in this audit";
  }
  const examined = evaluation.examinedByRule.get(finding.ruleId);
  if (examined === undefined) return `Rule ${finding.ruleId} did not run in this audit`;
  // A file that is neither analyzed nor recorded as skipped is gone, and a finding that
  // involves it is gone with it, whatever happened to the other files.
  if (evaluation.exclusionsKnown && involved.some((path) => !evaluation.analyzed.has(path) && gapFor(path) === undefined)) return undefined;
  for (const path of involved) {
    if (examined.has(path)) continue;
    const gap = gapFor(path);
    if (gap !== undefined) return `${path} was not analyzed in this audit (${gap.reason})`;
    if (evaluation.analyzed.has(path)) return `Rule ${finding.ruleId} did not examine ${path} in this audit`;
    return `This audit recorded no exclusions, so the absence of ${path} is not established`;
  }
  return undefined;
}

function transition(previous: LedgerFinding | undefined, to: FindingLifecycleState, run: LedgerRunReference): readonly LedgerTransition[] {
  const history = previous?.transitions ?? [];
  if (previous?.state === to) return history;
  return [...history, { runId: run.runId, at: run.at, ...(previous === undefined ? {} : { from: previous.state }), to }].slice(-TRANSITION_LIMIT);
}

function observedState(previous: LedgerFinding | undefined): FindingLifecycleState {
  if (previous === undefined) return "new";
  return previous.state === "resolved" ? "reappeared" : "persistent";
}

function observed(finding: AuditFinding, previous: LedgerFinding | undefined, run: LedgerRunReference, aliases: readonly string[], disposition: LedgerDisposition): LedgerFinding {
  const state = observedState(previous);
  return {
    id: finding.id,
    fingerprint: finding.fingerprint,
    aliases,
    ruleId: finding.ruleId,
    ...(finding.origin === "deterministic-rule" ? {} : { origin: finding.origin }),
    ...(finding.hypothesis === undefined ? {} : { hypothesis: finding.hypothesis }),
    category: finding.category,
    severity: finding.severity,
    title: finding.title,
    explanation: finding.explanation,
    remediation: finding.remediation,
    location: finding.location,
    evidence: finding.evidence,
    limitations: finding.limitations,
    evidenceDigest: finding.evidenceDigest,
    state,
    firstSeen: previous?.firstSeen ?? run,
    lastSeen: run,
    lastEvaluated: run,
    // Kept after a reappearance: it records when the finding was last believed gone.
    ...(previous?.resolvedAt === undefined ? {} : { resolvedAt: previous.resolvedAt }),
    timesSeen: (previous?.timesSeen ?? 0) + 1,
    transitions: transition(previous, state, run),
    suppressed: finding.suppression !== undefined,
    baselined: finding.baseline !== undefined,
    ...(finding.applicability === undefined ? {} : { applicability: finding.applicability }),
    disposition,
  };
}

function absent(previous: LedgerFinding, run: LedgerRunReference, evaluation: AuditEvaluation): LedgerFinding {
  // A resolved finding stays resolved whatever later audits cover; only seeing it again changes that.
  if (previous.state === "resolved") return previous;
  const reason = notEvaluatedReason(previous, evaluation);
  const base = Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "notEvaluatedReason")) as unknown as LedgerFinding;
  if (reason !== undefined) return { ...base, state: "not-evaluated", notEvaluatedReason: reason, transitions: transition(previous, "not-evaluated", run) };
  return { ...base, state: "resolved", lastEvaluated: run, resolvedAt: run, transitions: transition(previous, "resolved", run) };
}

export interface ReconcileOptions {
  /**
   * Current fingerprint to the fingerprint the same finding had under an earlier identity
   * scheme. Applied one-to-one: a stored entry is inherited by at most one current finding,
   * and never when its old fingerprint is itself still a current finding.
   */
  readonly migrations?: ReadonlyMap<string, string>;
}

export interface LedgerChange {
  readonly fingerprint: string;
  readonly from?: FindingLifecycleState;
  readonly to: FindingLifecycleState;
}

export interface Reconciliation {
  readonly ledger: FindingLedger;
  /** Findings whose state differs from before this audit, new ones included. */
  readonly changes: readonly LedgerChange[];
}

const UNREVIEWED: LedgerDisposition = { classification: "unreviewed" };

/**
 * Folds one audit into the ledger. Pure: the same ledger, report and evaluation always give
 * the same result, and the stored human dispositions pass through untouched.
 */
export function reconcileLedger(previous: FindingLedger | undefined, report: AuditReport, evaluation: AuditEvaluation, options: ReconcileOptions = {}): Reconciliation {
  const run = runReference(report);
  const stored = new Map(Object.entries(previous?.findings ?? {}));
  const current = new Set(report.findings.map((finding) => finding.fingerprint));
  const claimed = new Set<string>();
  const next = new Map<string, LedgerFinding>();
  const changes: LedgerChange[] = [];

  for (const finding of report.findings) {
    // A report never carries one fingerprint twice; if it did, the first occurrence owns the history.
    if (next.has(finding.fingerprint)) continue;
    let earlier = stored.get(finding.fingerprint);
    let aliases = earlier?.aliases ?? [];
    if (earlier === undefined) {
      const legacy = options.migrations?.get(finding.fingerprint);
      if (legacy !== undefined && !current.has(legacy) && !claimed.has(legacy) && stored.has(legacy)) {
        earlier = stored.get(legacy);
        claimed.add(legacy);
        aliases = [...new Set([...(earlier?.aliases ?? []), legacy])];
      }
    }
    const entry = observed(finding, earlier, run, aliases, earlier?.disposition ?? UNREVIEWED);
    next.set(finding.fingerprint, entry);
    if (earlier?.state !== entry.state) changes.push({ fingerprint: entry.fingerprint, ...(earlier === undefined ? {} : { from: earlier.state }), to: entry.state });
  }

  for (const [fingerprint, entry] of stored) {
    if (next.has(fingerprint) || claimed.has(fingerprint)) continue;
    const updated = absent(entry, run, evaluation);
    next.set(fingerprint, updated);
    if (updated.state !== entry.state) changes.push({ fingerprint, from: entry.state, to: updated.state });
  }

  // Retention: a finding that was resolved long ago and that nobody ever classified carries no
  // decision worth keeping. Anything a person classified is kept indefinitely.
  const cutoff = Date.parse(run.at) - RESOLVED_RETENTION_DAYS * 86_400_000;
  for (const [fingerprint, entry] of next) {
    if (entry.state !== "resolved" || entry.disposition.classification !== "unreviewed" || entry.resolvedAt === undefined) continue;
    if (Date.parse(entry.resolvedAt.at) < cutoff) next.delete(fingerprint);
  }

  const byState: Record<FindingLifecycleState, number> = { new: 0, persistent: 0, resolved: 0, reappeared: 0, "not-evaluated": 0 };
  for (const entry of next.values()) byState[entry.state] += 1;
  const record: LedgerRun = {
    id: run.runId,
    snapshot: run.snapshot,
    ...(run.headCommit === undefined ? {} : { headCommit: run.headCommit }),
    at: run.at,
    analyzerVersion: report.analyzer.version,
    coverageStatus: report.coverage.status,
    filesDiscovered: report.coverage.filesDiscovered,
    filesAnalyzed: report.coverage.filesAnalyzed,
    rulesExecuted: report.rules.filter((rule) => rule.status === "executed").map((rule) => rule.ruleId),
    findingsObserved: report.findings.length,
    byState,
  };
  const formerIds = previous === undefined || previous.repository.id === report.repository.id
    ? previous?.repository.formerIds ?? []
    : [...new Set([...previous.repository.formerIds, previous.repository.id])];
  return {
    ledger: {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      fingerprintScheme: LEDGER_FINGERPRINT_SCHEME,
      repository: { id: report.repository.id, name: report.repository.name, formerIds },
      runs: [record, ...(previous?.runs ?? []).filter((item) => item.id !== record.id)].slice(0, LEDGER_RUN_LIMIT),
      findings: Object.fromEntries([...next].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
      updatedAt: run.at,
    },
    changes,
  };
}
