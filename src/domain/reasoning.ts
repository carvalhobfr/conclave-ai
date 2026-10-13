import type { GraphEdge } from "./code-index.js";
import type { ContextBundle } from "./context-bundle.js";
import type { Evidence } from "./evidence.js";
import type { PlannedRetrieval } from "./retrieval-plan.js";
import type { ModelContextProtection } from "../security/model-context.js";

export type AgentRole = "investigator" | "skeptic" | "architect" | "verifier" | "judge";

export type ReasoningPreset = "free-like" | "full" | "local";

export type ReasoningChangeContextSource = "workspace" | "working" | "latest-commit";

/** Deterministic Git hints used only to seed repository retrieval, never as model instructions. */
/** A bounded slice of the unified diff, so agents can see what changed and not only where. */
export interface ReasoningChangeHunk {
  readonly path: string;
  readonly patch: string;
}

export interface ReasoningChangeContext {
  readonly source: ReasoningChangeContextSource;
  readonly paths: readonly string[];
  readonly symbols: readonly string[];
  readonly relatedSymbols: readonly string[];
  readonly hunks: readonly ReasoningChangeHunk[];
  /** Deterministic review dimensions selected from the diff, not defect descriptions. */
  readonly reviewDimensions: readonly string[];
  /** What was redacted or withheld from `hunks` when they were collected. */
  readonly protection?: ModelContextProtection;
}

export interface AgentAssignment {
  readonly role: AgentRole;
  readonly providerId: string;
  readonly modelId: string;
  readonly fallbackModelId?: string;
}

export type ClaimStatus = "proposed" | "challenged" | "supported" | "rejected" | "uncertain";

export type ClaimUncertainty = "none" | "possible" | "hypothesis";

export type ClaimCheck =
  | { readonly kind: "symbol-exists"; readonly symbol: string; readonly expectation: "present" | "absent" }
  | { readonly kind: "callers"; readonly symbol: string; readonly expectation: "present" | "absent" }
  | { readonly kind: "callees"; readonly symbol: string; readonly expectation: "present" | "absent" }
  | { readonly kind: "references"; readonly symbol: string; readonly expectation: "present" | "absent" }
  | {
      readonly kind: "path";
      readonly from: string;
      readonly to: string;
      readonly maxDepth?: number;
      readonly expectation: "present" | "absent";
    }
  | { readonly kind: "text"; readonly text: string; readonly expectation: "present" | "absent" };

export interface Claim {
  readonly id: string;
  readonly statement: string;
  readonly evidenceIds: readonly string[];
  readonly challengeIds: readonly string[];
  readonly verificationIds: readonly string[];
  readonly status: ClaimStatus;
  readonly uncertainty: ClaimUncertainty;
  readonly check?: ClaimCheck;
  readonly origin: {
    readonly role: AgentRole;
    readonly iteration: number;
  };
}

export type ChallengeType =
  | "insufficient-evidence"
  | "contradictory-evidence"
  | "missing-caller"
  | "missing-lifecycle-path"
  | "alternative-explanation"
  | "ambiguous-symbol"
  | "unsupported-causal-inference";

export interface Challenge {
  readonly id: string;
  readonly claimId: string;
  readonly type: ChallengeType;
  readonly explanation: string;
  readonly retrievalRequestIds: readonly string[];
  readonly origin: {
    readonly role: "skeptic" | "architect";
    readonly iteration: number;
  };
}

export type VerificationMethod = "source" | "symbol" | "graph" | "text" | "retrieval" | "model";
export type VerificationOutcome = "supported" | "rejected" | "uncertain";

export interface VerificationResult {
  readonly id: string;
  readonly claimId: string;
  readonly outcome: VerificationOutcome;
  readonly method: VerificationMethod;
  readonly explanation: string;
  readonly evidenceIds: readonly string[];
  readonly graphEdgeIds: readonly string[];
  readonly deterministic: boolean;
  readonly iteration: number;
}

export type RetrievalRequest =
  | { readonly kind: "symbol"; readonly name: string }
  | { readonly kind: "references"; readonly symbol: string }
  | { readonly kind: "callers"; readonly symbol: string }
  | { readonly kind: "callees"; readonly symbol: string }
  | { readonly kind: "path"; readonly from: string; readonly to: string; readonly maxDepth?: number }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "search"; readonly query: string };

export interface ReasoningRetrievalRequest {
  readonly id: string;
  readonly request: RetrievalRequest;
  readonly requestedBy: AgentRole;
  readonly claimId?: string;
  readonly challengeId?: string;
  readonly iteration: number;
}

export interface FollowUpRetrievalResult {
  readonly requestId: string;
  readonly evidence: readonly Evidence[];
  readonly graphEdges: readonly GraphEdge[];
  readonly deterministicOperations: readonly string[];
  readonly approximateTokens: number;
}

export interface AgentSelection {
  readonly role: AgentRole;
  readonly selected: boolean;
  readonly reason: string;
}

export interface ReasoningLimits {
  readonly maxRounds: number;
  readonly maxFollowUpRequests: number;
  readonly maxAgentCalls: number;
  readonly maxEvidenceUnits: number;
  readonly maxApproximateInputTokens: number;
  readonly maxRepeatedRequestCount: number;
  readonly structuredOutputRepairAttempts: number;
  readonly maxOutputTokensPerCall: number;
}

export const DEFAULT_REASONING_LIMITS: ReasoningLimits = {
  maxRounds: 3,
  maxFollowUpRequests: 8,
  maxAgentCalls: 10,
  maxEvidenceUnits: 30,
  maxApproximateInputTokens: 18_000,
  maxRepeatedRequestCount: 1,
  structuredOutputRepairAttempts: 1,
  maxOutputTokensPerCall: 4_000,
};

export type ReasoningTraceEventType =
  | "reasoning_started"
  | "context_protected"
  | "agent_selected"
  | "agent_skipped"
  | "agent_started"
  | "agent_completed"
  | "agent_output_repair_requested"
  | "agent_output_sanitized"
  | "claim_proposed"
  | "claim_challenged"
  | "retrieval_requested"
  | "retrieval_completed"
  | "verification_started"
  | "claim_supported"
  | "claim_rejected"
  | "claim_uncertain"
  | "judge_started"
  | "verdict_completed"
  | "reasoning_budget_exhausted"
  | "reasoning_no_progress";

export interface ReasoningTraceEvent {
  readonly sequence: number;
  readonly type: ReasoningTraceEventType;
  readonly occurredAt: string;
  readonly iteration: number;
  readonly role?: AgentRole;
  readonly claimId?: string;
  readonly requestId?: string;
  readonly detail: string;
  readonly data?: Readonly<Record<string, string | number | boolean>>;
}

export interface RoleUsage {
  readonly role: AgentRole;
  readonly providerIds: readonly string[];
  readonly modelIds: readonly string[];
  readonly calls: number;
  readonly approximateInputTokens: number;
  readonly approximateOutputTokens: number;
  readonly providerReportedInputTokens: number;
  readonly providerReportedOutputTokens: number;
  readonly latencyMs: number;
}

export interface ReasoningMetrics {
  readonly modelCalls: number;
  readonly retrievalRounds: number;
  readonly followUpRequests: number;
  readonly deterministicOperations: number;
  readonly evidenceCount: number;
  readonly approximateInputTokens: number;
  readonly approximateOutputTokens: number;
  readonly providerReportedInputTokens: number;
  readonly providerReportedOutputTokens: number;
  readonly latencyMs: number;
  readonly roleUsage: readonly RoleUsage[];
  readonly finalClaims: Readonly<Record<VerificationOutcome, number>>;
}

export interface Verdict {
  readonly answer: string;
  readonly claims: {
    readonly supported: readonly Claim[];
    readonly rejected: readonly Claim[];
    readonly uncertain: readonly Claim[];
  };
  readonly evidence: readonly Evidence[];
  readonly traceSummary: {
    readonly agentsExecuted: readonly AgentRole[];
    readonly agentsSkipped: readonly AgentSelection[];
    readonly retrievalRounds: number;
    readonly modelCalls: number;
  };
}

export interface ReasoningCaseState {
  readonly question: string;
  readonly changeContext?: ReasoningChangeContext;
  readonly iteration: number;
  readonly initialRetrieval: PlannedRetrieval;
  readonly initialContext: ContextBundle;
  readonly claims: readonly Claim[];
  readonly challenges: readonly Challenge[];
  readonly verifications: readonly VerificationResult[];
  readonly retrievalRequests: readonly ReasoningRetrievalRequest[];
  readonly retrievalResults: readonly FollowUpRetrievalResult[];
  readonly evidence: readonly Evidence[];
  readonly graphEdges: readonly GraphEdge[];
  readonly selections: readonly AgentSelection[];
}

export interface ReasoningResult {
  readonly verdict: Verdict;
  readonly state: ReasoningCaseState;
  readonly trace: readonly ReasoningTraceEvent[];
  readonly metrics: ReasoningMetrics;
  readonly terminationReason: "completed" | "budget-exhausted" | "no-progress" | "agent-failure";
  /**
   * Repository context that was redacted or withheld before any provider call. A non-empty
   * record is a coverage limitation: the model reasoned without that content. Paths and
   * categories only. Absent on results produced before this was recorded.
   */
  readonly contextProtection?: ModelContextProtection;
}
