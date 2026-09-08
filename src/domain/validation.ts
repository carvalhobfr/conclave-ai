import type { GraphRelation } from "./code-index.js";

export type ChangeSource =
  | { readonly kind: "working" }
  | { readonly kind: "workspace"; readonly base: string }
  | { readonly kind: "staged" }
  | { readonly kind: "branch"; readonly base: string; readonly head?: string }
  | { readonly kind: "commit"; readonly commit: string };

export type ValidationChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";

export interface ChangedLineRange {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

export interface ValidationChangedFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: ValidationChangedFileStatus;
  readonly hunks: readonly ChangedLineRange[];
}

export interface ChangeSet {
  readonly source: ChangeSource;
  readonly headSha: string;
  readonly files: readonly ValidationChangedFile[];
  readonly patch: string;
  readonly collectedAt: string;
}

export type ValidationClaimCheck =
  | {
      readonly kind: "symbol-exists";
      readonly symbol: string;
      readonly expectation: "present" | "absent";
    }
  | {
      readonly kind: "callers";
      readonly symbol: string;
      readonly expectation: "present" | "absent";
    }
  | {
      readonly kind: "references";
      readonly symbol: string;
      readonly expectation: "present" | "absent";
    }
  | {
      readonly kind: "text";
      readonly text: string;
      readonly expectation: "present" | "absent";
    }
  | {
      readonly kind: "file-changed";
      readonly path: string;
      readonly expectation: "present" | "absent";
    };

export interface ValidationClaim {
  readonly id: string;
  readonly statement: string;
  readonly check: ValidationClaimCheck;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  readonly verificationPlan: string;
  readonly kind: "structural" | "test" | "runtime" | "human";
  readonly confirmed: boolean;
  readonly claimIds: readonly string[];
  readonly implementationPaths: readonly string[];
}

export interface CriterionResult {
  readonly criterion: AcceptanceCriterion;
  readonly digest: string;
  readonly status: "supported" | "contradicted" | "not-verified" | "human-decision";
  readonly reasons: readonly string[];
  readonly receiptIds: readonly string[];
  readonly previousStatus?: CriterionResult["status"];
}

export interface ValidationContract {
  readonly objective: string;
  readonly criteria?: readonly AcceptanceCriterion[];
  readonly claims: readonly ValidationClaim[];
  readonly allowedPathPrefixes: readonly string[];
}

export type ValidationVerdict = "pass" | "warn" | "block" | "inconclusive";
export type ValidationFindingSeverity = "info" | "warning" | "blocking";

export type ValidationFindingKind =
  | "no-change"
  | "missing-objective"
  | "scope-expansion"
  | "parser-diagnostic"
  | "impact-outside-diff"
  | "exported-change-without-tests"
  | "head-only-deletion"
  | "claim-contradicted"
  | "claim-inconclusive"
  | "contract-drift"
  | "receipt-invalid"
  | "receipt-stale"
  | "receipt-failed"
  | "unreleased-resource"
  | "discarded-error"
  | "inconsistent-key";

export interface ValidationEvidence {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly symbol?: string;
  readonly relation?: GraphRelation;
  readonly reason: string;
}

export interface ValidationFinding {
  readonly id: string;
  readonly fingerprint: string;
  readonly kind: ValidationFindingKind;
  readonly severity: ValidationFindingSeverity;
  readonly title: string;
  readonly detail: string;
  readonly evidence: readonly ValidationEvidence[];
  readonly remediation: string;
}

export type ValidationClaimOutcome = "supported" | "rejected" | "inconclusive";

export interface ValidationClaimResult {
  readonly claim: ValidationClaim;
  readonly outcome: ValidationClaimOutcome;
  readonly explanation: string;
  readonly evidence: readonly ValidationEvidence[];
}

export interface ValidationMetrics {
  readonly filesChanged: number;
  readonly symbolsChanged: number;
  readonly impactedFiles: number;
  readonly impactedSymbols: number;
  readonly graphEdgesInspected: number;
  readonly deterministicChecks: number;
  readonly durationMs: number;
}

export interface ValidationTrustBoundary {
  readonly deterministic: true;
  readonly reasoningModelCalls: 0;
  readonly repositoryScriptsExecuted: false;
  readonly knowledge: {
    readonly parser: string;
    readonly graph: "syntax-aware";
    readonly embedding: {
      readonly id: string;
      readonly kind: "deterministic-feature-hash";
      readonly remoteCalls: 0;
    };
  };
}

export interface ValidationContractSnapshot {
  readonly allowedPathPrefixes: readonly string[];
  readonly claims: readonly {
    readonly id: string;
    readonly digest: string;
  }[];
}

export type ValidationContractStatus =
  | "initial"
  | "preserved"
  | "strengthened"
  | "rebaseline-required";

export interface ValidationContractDelta {
  readonly objectiveChanged: boolean;
  readonly addedClaimIds: readonly string[];
  readonly removedClaimIds: readonly string[];
  readonly changedClaimIds: readonly string[];
  readonly allowedPathPrefixesAdded: readonly string[];
  readonly allowedPathPrefixesRemoved: readonly string[];
}

export type ValidationBaselineTrust = "none" | "unattested" | "invalid";

export interface ValidationLineage {
  readonly seriesId: string;
  readonly reviewId: string;
  readonly previousReviewId?: string;
  readonly previousReportDigest?: string;
  readonly baselineTrust: ValidationBaselineTrust;
  readonly objectiveDigest: string;
  readonly contractDigest: string;
  readonly diffDigest: string;
  readonly artifactDigest: string;
  readonly reportDigest: string;
  readonly contractStatus: ValidationContractStatus;
  readonly rebaselineRequired: boolean;
  readonly contractDelta: ValidationContractDelta;
  readonly contractSnapshot: ValidationContractSnapshot;
}

export type ValidationFindingLifecycleStatus = "new" | "persistent" | "regressed";
export type ValidationReviewProgress =
  | "initial"
  | "duplicate-recheck"
  | "progress"
  | "stagnant"
  | "regression"
  | "mixed";

export interface ValidationFindingOccurrence {
  readonly fingerprint: string;
  readonly status: ValidationFindingLifecycleStatus;
  readonly occurrences: number;
  readonly consecutive: number;
}

export interface ValidationFindingLifecycle {
  readonly progress: ValidationReviewProgress;
  readonly current: readonly ValidationFindingOccurrence[];
  readonly resolved: readonly string[];
  readonly seen: readonly string[];
  readonly stagnating: readonly string[];
}

export type EvidenceReceiptType = "test" | "build" | "lint" | "typecheck" | "benchmark" | "runtime" | "other";
export type EvidenceReceiptClaimedTrust = "self-reported" | "locally-observed" | "ci-attested";
export type EvidenceReceiptStatus = "current" | "stale" | "invalid" | "failed" | "unbound";

export interface EvidenceReceiptInput {
  readonly id: string;
  readonly type: EvidenceReceiptType;
  readonly command?: string;
  readonly exitCode?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly headSha?: string;
  readonly artifactDigest?: string;
  readonly diffDigest?: string;
  readonly outputDigest?: string;
  readonly criterionDigests?: Readonly<Record<string, string>>;
  readonly artifactDigests?: readonly string[];
  readonly runner?: string;
  readonly claimedTrustLevel?: EvidenceReceiptClaimedTrust;
  readonly summary?: string;
  readonly validationErrors?: readonly string[];
}

export interface ValidatedEvidenceReceipt {
  readonly id: string;
  readonly receiptDigest: string;
  readonly type: EvidenceReceiptType;
  readonly status: EvidenceReceiptStatus;
  readonly claimedTrustLevel: EvidenceReceiptClaimedTrust;
  readonly effectiveTrustLevel: "self-reported";
  readonly command?: string;
  readonly exitCode?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly headSha?: string;
  readonly artifactDigest?: string;
  readonly diffDigest?: string;
  readonly outputDigest?: string;
  readonly criterionDigests?: Readonly<Record<string, string>>;
  readonly artifactDigests?: readonly string[];
  readonly runner?: string;
  readonly summary?: string;
  readonly reasons: readonly string[];
}

export interface ValidationReceiptSummary {
  readonly items: readonly ValidatedEvidenceReceipt[];
  readonly counts: Readonly<Record<EvidenceReceiptStatus, number>>;
}

export type ValidationChallengeStrategy =
  | "baseline"
  | "security"
  | "data-integrity"
  | "lifecycle-state"
  | "public-api-compatibility"
  | "blast-radius"
  | "performance"
  | "ux-accessibility"
  | "test-gap";

export interface ValidationChallenge {
  readonly strategy: ValidationChallengeStrategy;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly suggestedProbes: readonly string[];
}

export interface ValidationRuleCheck {
  readonly rule: ValidationFindingKind;
  readonly status: "finding" | "no-finding" | "not-applicable";
  readonly scope: string;
  readonly paths: readonly string[];
  readonly findingIds: readonly string[];
}

export interface ValidationEscalation {
  readonly recommended: boolean;
  readonly dimensions: readonly {
    readonly dimension: ValidationChallengeStrategy;
    /** evidenced/checked-clean are historical v2 values only. */
    readonly coverage: "partial" | "evidenced" | "checked-clean" | "unchecked";
    readonly reason: string;
    /** Absent in historical v2 reports; absence is not complete coverage. */
    readonly checks?: readonly ValidationRuleCheck[];
    readonly remainingQuestions?: readonly string[];
  }[];
  readonly reasons: readonly string[];
}

export interface ValidationReport {
  readonly criteria?: readonly CriterionResult[];
  readonly schemaVersion: 2 | 3 | 4;
  readonly verdict: ValidationVerdict;
  readonly summary: string;
  readonly objective: string;
  readonly changeSet: Omit<ChangeSet, "patch"> & { readonly patchBytes: number };
  readonly findings: readonly ValidationFinding[];
  readonly claims: readonly ValidationClaimResult[];
  readonly impact: {
    readonly changedSymbols: readonly string[];
    readonly impactedFiles: readonly string[];
    readonly impactedSymbols: readonly string[];
  };
  readonly metrics: ValidationMetrics;
  readonly trustBoundary: ValidationTrustBoundary;
  readonly lineage: ValidationLineage;
  readonly findingLifecycle: ValidationFindingLifecycle;
  readonly receipts: ValidationReceiptSummary;
  readonly challengePlan: readonly ValidationChallenge[];
  /** Whether focused verification remains (tests, human review or optional reasoning). */
  readonly escalation: ValidationEscalation;
}
