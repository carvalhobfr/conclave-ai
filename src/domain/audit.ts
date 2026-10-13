import type { RuleExecution } from "../analysis/pipeline.js";
import type { RuleCategory } from "../analysis/rule.js";
import type { CoverageGap, CoverageGapReason } from "./code-index.js";
import type { SourceLanguage } from "./repository.js";
import type { ValidationEvidence } from "./validation.js";

/**
 * Repository audit results. Deliberately separate from the pull-request `ValidationReport`:
 * an audit describes one snapshot, has no objective, contract, diff or merge verdict, and its
 * severities are not merge gates.
 */

export type AuditSeverity = "high" | "medium" | "low";

/**
 * How far a finding has been established. Each field is a separate fact and none implies the
 * next. A repository audit only ever sets the first two: it matches rules and attaches source
 * evidence. It never executes code, so it reproduces nothing; confirmation and approval are
 * decisions people make later.
 */
export interface AuditFindingStatus {
  /** A deterministic rule's pattern matched. False for a model hypothesis: no rule is behind it. */
  readonly ruleMatched: boolean;
  /** Source locations supporting the match are attached. */
  readonly evidence: "source-located";
  /** Whether the problem was observed happening. */
  readonly reproduction: "not-attempted" | "reproduced" | "not-reproduced";
  /** Whether a person judged the finding to be a real problem. */
  readonly humanConfirmation: "none" | "confirmed" | "dismissed";
  /** Whether a person approved publishing it, for example as an issue. */
  readonly publication: "not-requested" | "approved";
}

/**
 * An explicit, repository-declared statement about where a finding sits, from
 * `.conclave-audit.json`. It never hides a finding; it only records that this location is, for
 * example, a deliberately invalid fixture, and what follows from that.
 */
export interface AuditFindingApplicability {
  /** Free label chosen by the repository, such as `fixture` or `generated`. */
  readonly role: string;
  /** Whether an issue proposal may be drafted for the finding. */
  readonly issueProposals: boolean;
  /** Whether the finding counts toward `--fail-on`. */
  readonly gate: boolean;
  readonly reason: string;
  /** The declaration that matched, as `file#index`. */
  readonly source: string;
}

/**
 * Where a finding came from. A rule match is reproducible from the source alone. A model
 * hypothesis is a language model's reading of the source: it can be wrong, it can differ between
 * runs, and a second model agreeing with it is not independent proof.
 */
export type AuditFindingOrigin = "deterministic-rule" | "ai-hypothesis";

export type HypothesisConfidence = "high" | "medium" | "low";

export type HypothesisDefectClass =
  | "authorization"
  | "logic"
  | "boundary"
  | "async"
  | "fallback"
  | "cache"
  | "state"
  | "resource"
  | "error-handling"
  | "contract"
  | "other";

/**
 * How far the existing reasoning roles got when they challenged a hypothesis. Every value is a
 * model judgement. None of them means the defect was observed happening.
 */
/** `invalid-input`: the trigger needs a caller to pass a value outside the code's evident domain. */
export type HypothesisTriggerKind = "normal-use" | "invalid-input";

/**
 * Whether anything shows the triggering input reaching the code. Only stated for `invalid-input`.
 *
 * `call-site-cited`: the model cited a call site and that line exists. It shows a caller exists,
 * not that it passes the bad value.
 * `unproven`: no call site in the shown code was cited. That is an absence of evidence: callers
 * outside the repository, or outside what the model was shown, are not ruled out. The hypothesis
 * is kept and marked, never discarded for this reason.
 */
export type HypothesisReachability = "call-site-cited" | "unproven";

/** `smart`: one independent verifier call per hypothesis. `deep`: the five reasoning roles. */
export type SemanticPipeline = "smart" | "deep";

/**
 * `model-disputed`: the verifier rejected it. The hypothesis is still recorded, because repeated
 * verification of the same hypotheses showed a verifier rejecting true ones in some runs and
 * changing its answer on about a quarter of them. A rejection lowers priority; it removes nothing.
 */
export type HypothesisReviewStatus = "not-reviewed" | "model-supported" | "inconclusive" | "model-disputed";

/** What a model proposed, kept apart from the fields a rule would have filled. */
export interface AuditHypothesis {
  readonly providerId: string;
  readonly modelId: string;
  readonly defectClass: HypothesisDefectClass;
  /** The model's own estimate. Not calibrated and not a probability. */
  readonly confidence: HypothesisConfidence;
  /** Input or sequence the model says exposes the defect. */
  readonly trigger: string;
  /** Wrong behavior the model says follows. Not observed. */
  readonly consequence: string;
  readonly triggerKind: HypothesisTriggerKind;
  /** Present exactly for `invalid-input`. */
  readonly reachability?: HypothesisReachability;
  /** For `call-site-cited`: the existing call site the model cited as passing the triggering value. */
  readonly reachedBy?: { readonly path: string; readonly line: number };
  /** The quoted line was found verbatim in the file, which is the only deterministic check applied. */
  readonly grounding: "quote-located";
  readonly review: {
    readonly status: HypothesisReviewStatus;
    /** Why it was not reviewed, or what the review left open. A failed verification is `inconclusive`, never supported. */
    readonly detail?: string;
    readonly modelCalls: number;
    /** What the verifier wrote about its decision: its reasons for support, or the contradiction it saw. Model text. */
    readonly explanation?: string;
    /**
     * The model that verified it in the smart pipeline. `independent` is false when it is the
     * discovery model. `sameModelFamily` compares the leading name of the two model ids
     * (`deepseek-v4.1-flash` and `deepseek-v4-pro` are one family); it is a reading of names, not
     * knowledge of how the models were trained.
     */
    readonly verifier?: { readonly providerId: string; readonly modelId: string; readonly independent: boolean; readonly sameModelFamily: boolean };
  };
}

export interface AuditFinding {
  /** Handle inside this report. */
  readonly id: string;
  /** Identity across audits of the same code; unchanged when unrelated lines move. */
  readonly fingerprint: string;
  readonly ruleId: string;
  readonly category: RuleCategory;
  readonly severity: AuditSeverity;
  readonly title: string;
  readonly explanation: string;
  readonly remediation: string;
  readonly location: {
    readonly path: string;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly symbol?: string;
  };
  readonly evidence: readonly ValidationEvidence[];
  /**
   * Digest of the source text at the evidence locations (whitespace collapsed, line numbers
   * left out). It changes when that text changes and not when the code merely moves. Only the
   * digest is recorded, never the text.
   */
  readonly evidenceDigest: string;
  /**
   * A deterministic audit only ever produces `deterministic-rule`. `ai-hypothesis` appears only
   * when semantic discovery was explicitly requested, and always with `hypothesis` set.
   */
  readonly origin: AuditFindingOrigin;
  /** Present exactly when `origin` is `ai-hypothesis`. */
  readonly hypothesis?: AuditHypothesis;
  readonly status: AuditFindingStatus;
  /** `snapshot.id` of the audited content. */
  readonly snapshot: string;
  /** What this finding does not establish. */
  readonly limitations: readonly string[];
  /**
   * Present when an inline `conclave-ignore` directive covers the location. The finding stays
   * in the report so the decision is auditable, and is left out of the summary and exit code.
   */
  readonly suppression?: { readonly directive: "conclave-ignore" };
  /**
   * Present when the repository's baseline lists this fingerprint: the finding predates the
   * baseline. It stays in the report and in the counts and is left out of the exit code. A
   * baseline entry is not a judgement that the finding is wrong.
   */
  readonly baseline?: { readonly createdAt: string };
  /** Present when a declaration in `.conclave-audit.json` covers the location. */
  readonly applicability?: AuditFindingApplicability;
}

export interface AuditSnapshot {
  /** Digest of every analyzed file's path and content hash plus the recorded exclusions. */
  readonly id: string;
  /**
   * The audit reads the directory as it is on disk. `headCommit` is the commit checked out at
   * that moment, when the directory is a Git work tree; uncommitted edits are part of the
   * audited content and of `id`, so the commit alone does not identify the snapshot.
   */
  readonly kind: "working-tree" | "directory";
  readonly headCommit?: string;
}

/**
 * File counts with exact meanings.
 *
 * `filesNotAnalyzed` is a partition: every discovered file that was not analyzed has exactly
 * one reason, so `filesAnalyzed` plus its values equals `filesDiscovered`.
 *
 * `eligibleSourceFiles` is not part of that partition. It overlaps it: a source file withheld
 * for safety is counted both under `safetyExcluded` and as eligible source.
 *
 * Files inside an ignored directory are never enumerated, so they appear in no file count;
 * `ignoredDirectories` says how many such directories there were.
 */
export interface AuditCoverageAccounting {
  /** Individual files the walk reached. A symbolic link counts as one file whatever it points to. */
  readonly filesDiscovered: number;
  /** Files parsed and given to the rules. */
  readonly filesAnalyzed: number;
  readonly filesNotAnalyzed: {
    /** Matched an ignore rule by name (not a credential pattern). */
    readonly ignored: number;
    /** Withheld by a credential safeguard, by file name or by content. */
    readonly safetyExcluded: number;
    /** A file type without a parser. */
    readonly unsupported: number;
    /** The parser threw. */
    readonly parserFailure: number;
    /** Binary, oversized, unreadable or a symbolic link. */
    readonly unexamined: number;
  };
  /**
   * Discovered, non-ignored files of a language Conclave parses: the analyzed files plus the
   * supported-language files that were withheld, failed to parse or could not be examined.
   */
  readonly eligibleSourceFiles: number;
  /** Ignored directories, each one entry whose contents were not enumerated. */
  readonly ignoredDirectories: number;
}

export interface AuditCoverage {
  /**
   * `partial` when a source file of a supported language exists and was not analyzed, or any
   * file was withheld for safety. `supported-source-analyzed` says only that; it does not say
   * the repository is free of problems.
   */
  readonly status: "supported-source-analyzed" | "partial";
  readonly filesDiscovered: number;
  readonly filesAnalyzed: number;
  /**
   * Entries (not files) the walk skipped, per recorded reason. An ignored directory is one
   * entry, so these values do not sum to `filesDiscovered - filesAnalyzed`; `accounting` holds
   * the per-file partition.
   */
  readonly excluded: Readonly<Partial<Record<CoverageGapReason, number>>>;
  readonly accounting: AuditCoverageAccounting;
  readonly analyzedByLanguage: Readonly<Partial<Record<SourceLanguage, number>>>;
  /** Supported-language source and safety-withheld files that were not analyzed (capped). */
  readonly unanalyzedSource: readonly CoverageGap[];
  readonly unanalyzedSourceOmitted: number;
  /** Plain statements of what this audit could not see. Never empty. */
  readonly limits: readonly string[];
}

export interface AuditSummary {
  /**
   * Rule findings not suppressed inline; the counts below describe these. Model hypotheses are
   * never counted here: see `semantic.hypotheses`.
   */
  readonly findings: number;
  readonly suppressed: number;
  /** Of `findings`: listed in the repository baseline. */
  readonly baselined: number;
  /** Of `findings`: not baselined, and exempted from the exit code by an applicability declaration. */
  readonly exempt: number;
  /** Of `findings`: the ones `--fail-on` considers. `baselined + exempt + gated` equals `findings`. */
  readonly gated: number;
  readonly bySeverity: Readonly<Record<AuditSeverity, number>>;
  readonly byCategory: Readonly<Partial<Record<RuleCategory, number>>>;
  readonly byRule: Readonly<Record<string, number>>;
}

export interface AuditMetrics {
  readonly filesDiscovered: number;
  readonly filesAnalyzed: number;
  readonly filesExcluded: number;
  readonly symbols: number;
  readonly graphEdges: number;
  readonly crossFileEdges: number;
  readonly relativeImports: number;
  readonly resolvedRelativeImports: number;
  readonly rulesExecuted: number;
  readonly rulesSkipped: number;
  readonly indexMs: number;
  readonly rulesMs: number;
  readonly totalMs: number;
  readonly heapUsedBytes: number;
  readonly rssBytes: number;
}

export interface AuditPolicySummary {
  readonly baseline?: {
    readonly path: string;
    readonly createdAt: string;
    readonly entries: number;
    /** Baseline entries observed again in this audit. */
    readonly matched: number;
  };
  readonly applicability?: {
    readonly path: string;
    readonly declarations: number;
    /** Findings covered by a declaration. */
    readonly matched: number;
  };
}

export type SemanticRegionState =
  /** Sent to the discovery model in this run. */
  | "examined"
  /** Unchanged since an earlier run examined it with the same model; that result was reused. */
  | "examined-cached"
  /** The budget ran out before this region was reached. */
  | "not-examined-budget"
  /** The provider call failed or returned output that could not be validated. */
  | "not-examined-failed"
  /** The region matched a secret detector and could not be sanitized, so it was not sent. */
  | "not-examined-withheld";

export interface SemanticRegion {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly state: SemanticRegionState;
}

export type SemanticBudgetLimit = "model-calls" | "input-tokens" | "output-tokens" | "duration" | "regions";

export interface SemanticBudget {
  readonly maxModelCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxDurationMs: number;
  readonly maxRegions: number;
  /** Hypotheses handed to the verifier (smart) or to the reasoning roles (deep). */
  readonly maxInvestigations: number;
}

export interface SemanticStageUsage {
  readonly stage: "discovery" | "investigation";
  readonly providerId: string;
  readonly modelId: string;
  readonly calls: number;
  /** Absent for investigation: the reasoning engine reports calls per role without separating failed ones. */
  readonly failedCalls?: number;
  /** Estimated from bytes, for every call. */
  readonly approximateInputTokens: number;
  readonly approximateOutputTokens: number;
  /** As returned by the provider; zero when it reported none. */
  readonly providerReportedInputTokens: number;
  readonly providerReportedOutputTokens: number;
  readonly latencyMs: number;
}

/**
 * Money is reported only from prices the operator supplied. Conclave holds no price list.
 * `local-inference` means no per-token charge applies; machine time and energy are not measured.
 */
export type SemanticCost =
  | { readonly status: "not-priced" }
  | { readonly status: "local-inference" }
  | {
      readonly status: "estimated";
      readonly currency: "USD";
      readonly amount: number;
      readonly inputPerMillionTokens: number;
      readonly outputPerMillionTokens: number;
      /** Which token counts the amount was computed from. */
      readonly basis: "provider-reported" | "approximate";
    };

/** Present on a report only when semantic discovery was requested. */
export interface AuditSemanticSection {
  readonly pipeline: SemanticPipeline;
  readonly discovery: { readonly providerId: string; readonly modelId: string };
  /** Smart pipeline only. */
  readonly verifier?: { readonly providerId: string; readonly modelId: string; readonly independent: boolean; readonly sameModelFamily: boolean };
  readonly investigation: readonly { readonly role: string; readonly providerId: string; readonly modelId: string }[];
  /** `external` means repository excerpts left this machine. */
  readonly privacyBoundary: "local-only" | "external";
  readonly budget: SemanticBudget;
  /** The limit that ended discovery early, when one did. */
  readonly stoppedBy?: SemanticBudgetLimit;
  readonly usage: {
    /** Every provider request, failed and repaired ones included. */
    readonly modelCalls: number;
    /** Failed discovery requests. */
    readonly failedCalls: number;
    readonly approximateInputTokens: number;
    readonly approximateOutputTokens: number;
    readonly providerReportedInputTokens: number;
    readonly providerReportedOutputTokens: number;
    readonly durationMs: number;
    readonly byStage: readonly SemanticStageUsage[];
    readonly cost: SemanticCost;
  };
  readonly coverage: {
    /** Indexed source files a model could be asked about. Other indexed files (JSON, Markdown, ...) are not eligible. */
    readonly eligibleFiles: number;
    /** Files with every region examined, in this run or from the cache. */
    readonly filesExamined: number;
    readonly filesPartiallyExamined: number;
    readonly filesNotExamined: number;
    /** Files holding at least one hypothesis the reasoning roles challenged. */
    readonly filesInvestigated: number;
    readonly eligibleLines: number;
    readonly linesExamined: number;
    readonly regionsPlanned: number;
    readonly regionsByState: Readonly<Record<SemanticRegionState, number>>;
    /** Every planned region with its state (capped). */
    readonly regions: readonly SemanticRegion[];
    readonly regionsOmitted: number;
    /** True only when every eligible region was examined. It never means the code is free of defects. */
    readonly complete: boolean;
  };
  readonly hypotheses: {
    readonly proposed: number;
    /** Dropped: the quoted line is not in the file. */
    readonly ungrounded: number;
    readonly duplicates: number;
    /** Dropped: a rule finding already covers the same line. */
    readonly coveredByRule: number;
    /** Recorded with `reachability: "unproven"`: invalid-input hypotheses without a cited call site that exists. */
    readonly reachabilityUnproven: number;
    /** Recorded as `model-disputed`: the verifier or the reasoning roles rejected it. */
    readonly rejectedByReview: number;
    /** Recorded as `inconclusive` because the verification call failed. */
    readonly verificationFailed: number;
    /** Entered `findings` as `ai-hypothesis`. */
    readonly recorded: number;
    readonly byReview: Readonly<Record<HypothesisReviewStatus, number>>;
  };
  /** Hypotheses that were proposed and not recorded, with the reason (capped). */
  readonly dismissed: readonly { readonly path: string; readonly line?: number; readonly title: string; readonly reason: string }[];
  readonly dismissedOmitted: number;
  /** Plain statements of what this stage does not establish. Never empty. */
  readonly limits: readonly string[];
}

export interface AuditReport {
  readonly schemaVersion: 1;
  readonly kind: "repository-audit";
  readonly scope: "repository";
  readonly analyzer: { readonly name: "conclave-ai"; readonly version: string; readonly parser: string };
  /** `id` is derived from the canonical local path; it identifies this checkout, not the project. */
  readonly repository: { readonly id: string; readonly name: string };
  readonly snapshot: AuditSnapshot;
  readonly generatedAt: string;
  /** One sentence a reader can quote without overstating the result. */
  readonly conclusion: string;
  readonly coverage: AuditCoverage;
  readonly summary: AuditSummary;
  readonly findings: readonly AuditFinding[];
  /** Every rule considered, including those skipped and why. */
  readonly rules: readonly RuleExecution[];
  /** Repository-declared noise management that was applied. Absent files are simply not listed. */
  readonly policy: AuditPolicySummary;
  readonly metrics: AuditMetrics;
  /** What semantic discovery did. Absent from a deterministic audit. */
  readonly semantic?: AuditSemanticSection;
  /**
   * A deterministic audit reports `deterministic: true`, `modelCalls: 0` and no network. With
   * semantic discovery the first is false, the second is the real count, and `networkOperations`
   * is true when a provider outside this machine was called. Repository code is never executed.
   */
  readonly trustBoundary: {
    readonly deterministic: boolean;
    readonly modelCalls: number;
    readonly repositoryCodeExecuted: false;
    readonly networkOperations: boolean;
  };
}
