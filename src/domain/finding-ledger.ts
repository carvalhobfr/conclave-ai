import type { RuleCategory } from "../analysis/rule.js";
import type { AuditCoverage, AuditFinding, AuditFindingApplicability, AuditFindingOrigin, AuditHypothesis, AuditSeverity } from "./audit.js";

/**
 * Where a finding stands across audits of one repository. Derived only from which audits
 * observed it; it says nothing about whether the finding is a real problem.
 *
 * `new`            first observed in the latest audit that evaluated it
 * `persistent`     observed before and again in the latest audit
 * `resolved`       evaluated by the latest audit and no longer observed
 * `reappeared`     observed again after having been `resolved`
 * `not-evaluated`  absent from the latest audit, which could not have observed it either
 *                  (its file or its rule was outside that audit); nothing is concluded
 */
export type FindingLifecycleState = "new" | "persistent" | "resolved" | "reappeared" | "not-evaluated";

export const FINDING_LIFECYCLE_STATES: readonly FindingLifecycleState[] = ["new", "persistent", "reappeared", "not-evaluated", "resolved"];

/**
 * What a person decided about a finding. Independent of lifecycle and of evidence: a rule
 * match never sets it, and no model output may.
 */
export type FindingDisposition = "unreviewed" | "confirmed" | "false-positive" | "accepted-risk" | "needs-investigation";

export const FINDING_DISPOSITIONS: readonly FindingDisposition[] = ["unreviewed", "confirmed", "false-positive", "accepted-risk", "needs-investigation"];

/** Who performed a recorded action. `name` is informational, not authentication. */
export interface TriageActor {
  readonly kind: "cli" | "api";
  readonly name?: string;
}

export interface LedgerRunReference {
  readonly runId: string;
  readonly snapshot: string;
  readonly at: string;
  readonly headCommit?: string;
}

export interface LedgerDisposition {
  readonly classification: FindingDisposition;
  readonly note?: string;
  readonly classifiedAt?: string;
  readonly classifiedBy?: TriageActor;
  /** The `finding-feedback.jsonl` record this disposition came from. */
  readonly feedbackId?: string;
}

export interface LedgerTransition {
  readonly runId: string;
  readonly at: string;
  readonly from?: FindingLifecycleState;
  readonly to: FindingLifecycleState;
}

export interface LedgerFinding {
  readonly id: string;
  readonly fingerprint: string;
  /** Fingerprints this finding carried under an earlier identity scheme. */
  readonly aliases: readonly string[];
  readonly ruleId: string;
  /** Absent on entries recorded before model hypotheses existed; those are rule matches. */
  readonly origin?: AuditFindingOrigin;
  /** The model's proposal as last observed. Present exactly for `ai-hypothesis`. */
  readonly hypothesis?: AuditHypothesis;
  readonly category: RuleCategory;
  readonly severity: AuditSeverity;
  readonly title: string;
  readonly explanation: string;
  readonly remediation: string;
  readonly location: AuditFinding["location"];
  readonly evidence: AuditFinding["evidence"];
  readonly limitations: readonly string[];
  /** Digest of the source text behind the evidence, as last observed. */
  readonly evidenceDigest: string;
  readonly state: FindingLifecycleState;
  /** Why the latest audit could not evaluate it; present only for `not-evaluated`. */
  readonly notEvaluatedReason?: string;
  readonly firstSeen: LedgerRunReference;
  readonly lastSeen: LedgerRunReference;
  /** Latest audit that either observed the finding or established its absence. */
  readonly lastEvaluated: LedgerRunReference;
  readonly resolvedAt?: LedgerRunReference;
  /** Audits that observed it. Repeating an audit of the same snapshot counts again. */
  readonly timesSeen: number;
  /** Most recent state changes, oldest first (capped). */
  readonly transitions: readonly LedgerTransition[];
  readonly suppressed: boolean;
  readonly baselined: boolean;
  readonly applicability?: AuditFindingApplicability;
  readonly disposition: LedgerDisposition;
}

export interface LedgerRun {
  readonly id: string;
  readonly snapshot: string;
  readonly headCommit?: string;
  readonly at: string;
  readonly analyzerVersion: string;
  readonly coverageStatus: AuditCoverage["status"];
  readonly filesDiscovered: number;
  readonly filesAnalyzed: number;
  readonly rulesExecuted: readonly string[];
  /** Findings this audit observed, suppressed ones included. */
  readonly findingsObserved: number;
  readonly byState: Readonly<Record<FindingLifecycleState, number>>;
}

export const LEDGER_SCHEMA_VERSION = 1;
/** Identity scheme of the stored fingerprints. A change requires an explicit one-to-one migration. */
export const LEDGER_FINGERPRINT_SCHEME = "audit-v1";

export interface FindingLedger {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly fingerprintScheme: typeof LEDGER_FINGERPRINT_SCHEME;
  readonly repository: {
    readonly id: string;
    readonly name: string;
    /** Earlier ids of the same ledger, kept when the directory was moved or renamed. */
    readonly formerIds: readonly string[];
  };
  /** Newest first (capped). */
  readonly runs: readonly LedgerRun[];
  /** Keyed by fingerprint. */
  readonly findings: Readonly<Record<string, LedgerFinding>>;
  readonly updatedAt: string;
}

/**
 * What one audit was able to observe. Needed to tell "the finding is gone" from "this audit
 * never looked": a report alone lists what matched, not everything that was examined.
 */
export interface AuditEvaluation {
  /** Paths each executed rule examined. A skipped rule has no entry. */
  readonly examinedByRule: ReadonlyMap<string, ReadonlySet<string>>;
  /** True when this audit ran semantic discovery. Absent means it did not. */
  readonly semanticDiscovery?: boolean;
  /** Every analyzed path. */
  readonly analyzed: ReadonlySet<string>;
  /** Paths the audit saw and did not analyze, with the reason; an ignored directory ends in `/`. */
  readonly gaps: readonly { readonly path: string; readonly reason: string }[];
  /** False when the index recorded no exclusions, so an absent path proves nothing. */
  readonly exclusionsKnown: boolean;
}
