import type { ChangeSource, ValidationReport } from "../domain/validation.js";
import type { ProviderId } from "../domain/provider.js";
import type { ProviderDiagnostics } from "../providers/provider-diagnostics.js";

export type ProductIntent = "validate" | "ask" | "investigate";
export type ProductRunStatus = "completed" | "completed-with-uncertainty" | "failed" | "blocked" | "error";

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly source: "demo" | "local";
  readonly gitStatus: "demo" | "clean" | "unknown";
  readonly languages: readonly string[];
  readonly indexedFiles: number;
  readonly symbols: number;
  readonly graphNodes: number;
  readonly graphEdges: number;
  readonly updatedAt: string;
  readonly git?: {
    readonly currentBranch: string;
    readonly defaultBase: string;
    readonly branches: readonly string[];
    readonly staged: number;
    readonly unstaged: number;
    readonly untracked: number;
  };
}

export interface EvidenceView {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
  readonly excerpt: string;
  readonly origin: string;
}

export interface ClaimView {
  readonly id: string;
  readonly statement: string;
  readonly status: "supported" | "rejected" | "uncertain";
  readonly role: string;
  readonly evidenceIds: readonly string[];
  readonly challengeCount: number;
  readonly verificationCount: number;
}

export interface GraphView {
  readonly query: string;
  readonly status: "resolved" | "ambiguous" | "not-found";
  readonly nodes: readonly { readonly id: string; readonly label: string; readonly path: string }[];
  readonly edges: readonly { readonly id: string; readonly from: string; readonly to: string; readonly relation: string; readonly provenance: string }[];
  readonly message?: string;
}

export interface TraceView {
  readonly role: string;
  readonly status: "ran" | "skipped" | "pending";
  readonly reason: string;
}

export interface RetrievalView {
  readonly operations: readonly { readonly label: string; readonly status: "executed" | "skipped" }[];
  readonly evidenceCount: number;
  readonly sourceBytes: number;
  readonly approximateTokens: number;
}

export interface ProductRunView {
  readonly intent: Exclude<ProductIntent, "validate">;
  readonly status: ProductRunStatus;
  readonly title: string;
  readonly answer: string;
  readonly claims: readonly ClaimView[];
  readonly evidence: readonly EvidenceView[];
  readonly trace: readonly TraceView[];
  readonly retrieval: RetrievalView;
  readonly metrics: readonly { readonly label: string; readonly value: string }[];
  readonly graph: GraphView;
  readonly error?: { readonly code: string; readonly message: string; readonly action: string };
}

export interface ValidationRequestView {
  readonly projectId: string;
  readonly source: ChangeSource;
  readonly objective: string;
  readonly contract?: unknown;
}

export interface ValidationRunView {
  readonly intent: "validate";
  readonly verdict: ValidationReport["verdict"];
  readonly headline: string;
  readonly explanation: string;
  readonly recommendation: string;
  readonly largestRisk?: {
    readonly title: string;
    readonly detail: string;
    readonly severity: ValidationReport["findings"][number]["severity"];
  };
  readonly counts: {
    readonly blocking: number;
    readonly warning: number;
    readonly supportedClaims: number;
    readonly totalClaims: number;
  };
  readonly report: ValidationReport;
  readonly patch: string;
  readonly handoff: string;
  readonly demo: boolean;
}

export interface ReviewHistoryView {
  readonly id: string;
  readonly createdAt: string;
  readonly objective: string;
  readonly verdict: ValidationReport["verdict"];
  readonly title: string;
  readonly report?: ValidationReport;
  readonly handoff?: string;
}

export interface RuntimeModeView {
  readonly active: "free" | "api" | "local" | "demo";
  readonly available: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly credentialConfigured?: boolean;
  readonly credentialHint?: string;
  readonly reasoningPreset?: "free-like" | "full" | "local";
  readonly message: string;
  readonly roles: readonly { readonly role: string; readonly provider: string; readonly model: string }[];
}

export type ConfigurableProviderId = Exclude<ProviderId, "fake" | "gemini">;

export const REASONING_ROLE_NAMES = ["investigator", "skeptic", "architect", "verifier", "judge"] as const;
export type ReasoningRoleName = (typeof REASONING_ROLE_NAMES)[number];

export interface RoleModelChoice {
  /** Defaults to the request provider; must share its vendor credential. */
  readonly provider?: ConfigurableProviderId;
  readonly model: string;
}

export interface RuntimeConfigurationRequest {
  readonly mode: "api" | "local";
  readonly provider: ConfigurableProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly reasoningPreset: "free-like" | "full" | "local";
  readonly apiKey?: string;
  /** Per-role overrides; roles left out use `provider` and `model`. */
  readonly roles?: Partial<Record<ReasoningRoleName, RoleModelChoice>>;
  /** Model retried when a role's primary model fails or returns invalid output. */
  readonly fallbackModel?: string;
}

export interface RuntimeConfigurationResult {
  readonly saved: true;
  readonly credentialUpdated: boolean;
  readonly runtime: RuntimeModeView;
  readonly diagnostic: ProviderDiagnostics;
}

export interface RuntimeModelDiscoveryRequest {
  readonly mode: "api" | "local";
  readonly provider: ConfigurableProviderId;
  readonly baseUrl: string;
  readonly apiKey?: string;
}

export interface RuntimeModelsView {
  readonly provider: ConfigurableProviderId;
  readonly endpoint: string;
  readonly models: readonly string[];
}
