import type { RuleCategory } from "../analysis/rule.js";
import type { AuditSeverity } from "./audit.js";
import type { FindingDisposition, TriageActor } from "./finding-ledger.js";

/**
 * `draft → pending-review → approved → ready-for-publication`, plus `rejected` and `stale`.
 *
 * Every step is an explicit action by a person. Nothing in Conclave approves a proposal on its
 * own, and nothing in this release publishes one.
 */
export type ProposalStatus = "draft" | "pending-review" | "approved" | "ready-for-publication" | "rejected" | "stale";

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["draft", "pending-review", "approved", "ready-for-publication", "stale", "rejected"];

/**
 * A person's approval of one exact revision of a proposal, for the evidence that existed then.
 * A publisher must compare both digests with the proposal and the ledger as they are at
 * publication time; the `status` field alone is not authorization.
 */
export interface ProposalApproval {
  /** Content digest of the title, body and labels that were approved. */
  readonly revision: string;
  /** Evidence digest of each linked finding at approval time, keyed by fingerprint. */
  readonly evidence: Readonly<Record<string, string>>;
  readonly approvedAt: string;
  readonly approvedBy: TriageActor;
  /** How intent was expressed: the revision typed on the command line, a terminal prompt, or the local API. */
  readonly method: "cli-revision" | "cli-interactive" | "api-revision";
}

export interface InvalidatedApproval extends ProposalApproval {
  readonly invalidatedAt: string;
  readonly reason: string;
}

export interface ProposalFindingLink {
  readonly id: string;
  readonly fingerprint: string;
  /** Evidence digest the proposal text was written against. */
  readonly evidenceDigest: string;
}

export interface ProposalEvidenceReference {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly symbol?: string;
}

export interface ProposalHistoryEntry {
  readonly at: string;
  readonly action: "created" | "edited" | "regenerated" | "submitted" | "approved" | "approval-invalidated" | "marked-ready" | "rejected" | "marked-stale" | "refreshed";
  readonly from?: ProposalStatus;
  readonly to: ProposalStatus;
  readonly by?: TriageActor;
  readonly detail?: string;
}

export const PROPOSAL_SCHEMA_VERSION = 1;

export interface IssueProposal {
  readonly schemaVersion: typeof PROPOSAL_SCHEMA_VERSION;
  /** Stable for a set of findings and an attempt number; the same request never yields two ids. */
  readonly id: string;
  /** 1 for the first proposal about these findings; higher after a rejection or staleness was superseded. */
  readonly attempt: number;
  readonly repository: { readonly id: string; readonly name: string };
  readonly findings: readonly ProposalFindingLink[];
  readonly source: {
    readonly runId: string;
    readonly snapshot: string;
    readonly headCommit?: string;
    readonly analyzerVersion: string;
  };
  readonly title: string;
  /** Markdown. Contains locations and rule statements, never source text. */
  readonly body: string;
  readonly labels: readonly string[];
  readonly severity: AuditSeverity;
  readonly category: RuleCategory;
  readonly ruleId: string;
  readonly evidence: readonly ProposalEvidenceReference[];
  /** An audit never executes code, so this is `not-attempted` until a later phase reproduces. */
  readonly reproduction: "not-attempted" | "reproduced" | "not-reproduced";
  /** The finding's human disposition when the text was generated. */
  readonly humanDisposition: FindingDisposition;
  /** True unless a person confirmed the finding: the body then says it is an unconfirmed hypothesis. */
  readonly hypothesis: boolean;
  readonly coverageLimitations: readonly string[];
  readonly status: ProposalStatus;
  /** Content digest of the current title, body and labels. */
  readonly revision: string;
  /** Revision of the last generated text; differs from `revision` once a person edited it. */
  readonly generatedRevision: string;
  readonly approval?: ProposalApproval;
  readonly invalidatedApprovals: readonly InvalidatedApproval[];
  readonly rejection?: { readonly reason: string; readonly at: string; readonly by: TriageActor; readonly revision: string; readonly evidence: Readonly<Record<string, string>> };
  readonly stale?: { readonly reason: string; readonly at: string; readonly previousStatus: ProposalStatus };
  /** Set when this proposal replaces an earlier rejected or stale one, with the reason given. */
  readonly supersedes?: { readonly proposalId: string; readonly reason: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Oldest first (capped). */
  readonly history: readonly ProposalHistoryEntry[];
}

export interface IssueProposalStore {
  readonly schemaVersion: typeof PROPOSAL_SCHEMA_VERSION;
  readonly repository: { readonly id: string; readonly name: string };
  /** Keyed by proposal id. */
  readonly proposals: Readonly<Record<string, IssueProposal>>;
  readonly updatedAt: string;
}

/** Result of checking a proposal against everything publication would require. */
export interface PublicationGate {
  readonly publishable: boolean;
  /** Every unmet requirement; empty exactly when `publishable`. */
  readonly blockers: readonly string[];
}
