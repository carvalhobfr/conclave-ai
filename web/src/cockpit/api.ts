import type { AuditReport, SemanticBudget } from "../../../src/domain/audit.js";
import type { FindingDisposition, LedgerRun } from "../../../src/domain/finding-ledger.js";
import type { IssueProposal } from "../../../src/domain/issue-proposal.js";
import type { ArchitectureView, AuditJobView, AuditMode, AuditPreflightView } from "../../../src/web/contracts.js";
import type { EvidenceExcerpt, FindingDetail, FindingView, ProposalCreation, ProposalDetail } from "../../../src/workflow/triage-service.js";

/** A finding with its source excerpts, as the local API returns it. */
export type FindingDetailView = FindingDetail & { readonly source: readonly EvidenceExcerpt[] };

export interface AuditOptions {
  readonly budget: Partial<SemanticBudget>;
  readonly discoveryModel?: string;
  readonly verifierModel?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error((payload as { error?: { message?: string } }).error?.message ?? "Conclave request failed.");
  return payload as T;
}

const post = (value: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
const project = (id: string): string => `projectId=${encodeURIComponent(id)}`;

function optionQuery(options: AuditOptions): string {
  const entries: readonly (readonly [string, string | number | undefined])[] = [...Object.entries(options.budget), ["discoveryModel", options.discoveryModel], ["verifierModel", options.verifierModel]];
  return entries.filter(([, value]) => value !== undefined && value !== "").map(([name, value]) => `&${name}=${encodeURIComponent(String(value))}`).join("");
}

export const cockpitApi = {
  latestAudit: (id: string) => request<{ readonly report: AuditReport | null }>(`/api/audit/latest?${project(id)}`).then((value) => value.report),
  auditRuns: (id: string) => request<readonly LedgerRun[]>(`/api/audit/runs?${project(id)}`),
  auditStatus: (id: string) => request<{ readonly job: AuditJobView | null }>(`/api/audit/status?${project(id)}`).then((value) => value.job),
  auditPreflight: (id: string, mode: AuditMode, options: AuditOptions) => request<AuditPreflightView>(`/api/audit/preflight?${project(id)}&mode=${mode}${optionQuery(options)}`),
  startAudit: (id: string, mode: AuditMode, options: AuditOptions, acknowledgedModelCalls: boolean) => request<AuditJobView>("/api/audit/start", post({ projectId: id, mode, acknowledgedModelCalls, ...options })),
  findings: (id: string) => request<readonly FindingView[]>(`/api/findings?${project(id)}`),
  finding: (id: string, finding: string) => request<FindingDetailView>(`/api/findings/detail?${project(id)}&id=${encodeURIComponent(finding)}`),
  classify: (id: string, finding: string, classification: FindingDisposition, note: string) => request<FindingView>("/api/findings/classify", post({ projectId: id, id: finding, classification, ...(note.trim() === "" ? {} : { note }) })),
  proposals: (id: string) => request<readonly IssueProposal[]>(`/api/issues?${project(id)}`),
  proposal: (id: string, proposal: string) => request<ProposalDetail>(`/api/issues/detail?${project(id)}&id=${encodeURIComponent(proposal)}`),
  propose: (id: string, findingId: string, reason: string) => request<ProposalCreation>("/api/issues/propose", post({ projectId: id, findingId, ...(reason.trim() === "" ? {} : { reason }) })),
  editProposal: (id: string, proposal: string, edit: { readonly title: string; readonly body: string; readonly labels: readonly string[] }) => request<ProposalDetail>("/api/issues/edit", post({ projectId: id, id: proposal, ...edit })),
  submitProposal: (id: string, proposal: string) => request<ProposalDetail>("/api/issues/submit", post({ projectId: id, id: proposal })),
  /** `revision` is the one the person was shown. The server refuses it when the text has changed since. */
  approveProposal: (id: string, proposal: string, revision: string) => request<ProposalDetail>("/api/issues/approve", post({ projectId: id, id: proposal, revision })),
  rejectProposal: (id: string, proposal: string, reason: string) => request<ProposalDetail>("/api/issues/reject", post({ projectId: id, id: proposal, reason })),
  refreshProposal: (id: string, proposal: string) => request<ProposalDetail>("/api/issues/refresh", post({ projectId: id, id: proposal })),
  architecture: (id: string) => request<ArchitectureView>(`/api/architecture?${project(id)}`),
};
