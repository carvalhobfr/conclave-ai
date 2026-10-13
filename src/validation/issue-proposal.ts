import { createHash } from "node:crypto";

import type { FindingDisposition, LedgerFinding, LedgerRun, TriageActor } from "../domain/finding-ledger.js";
import {
  PROPOSAL_SCHEMA_VERSION,
  type IssueProposal,
  type ProposalApproval,
  type ProposalHistoryEntry,
  type ProposalStatus,
  type PublicationGate,
} from "../domain/issue-proposal.js";
import { redactSecrets } from "../security/model-context.js";
import { stableId } from "./finding-identity.js";

const HISTORY_LIMIT = 50;
const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const MAX_LABELS = 10;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 :._/-]{0,49}$/u;
const WITHHELD = "[withheld: matched a credential detector]";

export class ProposalError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

/**
 * Text generated from a finding. A recognized credential is replaced by a marker; text that
 * still matches a detector afterwards is withheld whole. Detection is pattern based, so this
 * reduces what a draft can carry and does not prove a draft is free of secrets.
 */
export function protectGeneratedText(text: string): string {
  const result = redactSecrets(text);
  return result.residual ? WITHHELD : result.text;
}

/** Text a person wrote. Never rewritten silently: a detected credential is refused. */
function assertNoSecret(text: string, label: string): void {
  const result = redactSecrets(text);
  if (result.residual || Object.keys(result.redactions).length > 0) throw new ProposalError("secret_detected", `${label} matched a credential detector. Remove the value before saving; a proposal may later be published.`);
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

function normalizeLabels(labels: readonly string[]): readonly string[] {
  return [...new Set(labels.map((label) => label.trim()).filter((label) => label !== ""))].sort((left, right) => left.localeCompare(right));
}

/**
 * Identity of what a reviewer reads and approves: title, body and labels. Trailing whitespace,
 * line-ending style and label order are not material; anything else is.
 */
export function proposalRevision(content: { readonly title: string; readonly body: string; readonly labels: readonly string[] }): string {
  const canonical = JSON.stringify([content.title.trim(), normalizeBody(content.body), normalizeLabels(content.labels)]);
  return "rev_" + createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// Repository-derived text goes into code spans and fenced blocks, where Markdown, HTML, links
// and @mentions are inert. These keep such text from closing the span or fence it sits in.
function inlineCode(text: string): string {
  return "`" + text.replace(/`/gu, "'").replace(/\s+/gu, " ").trim() + "`";
}

function fenced(text: string): string {
  return "```text\n" + text.replace(/`{3,}/gu, "'''").trim() + "\n```";
}

function locationText(item: { readonly path: string; readonly startLine?: number; readonly endLine?: number }): string {
  const lines = item.startLine === undefined ? "" : item.endLine !== undefined && item.endLine !== item.startLine ? `:${String(item.startLine)}-${String(item.endLine)}` : `:${String(item.startLine)}`;
  return `${item.path}${lines}`;
}

const DISPOSITION_TEXT: Readonly<Record<FindingDisposition, string>> = {
  unreviewed: "Not reviewed by a person",
  confirmed: "Confirmed by a person as a real problem",
  "false-positive": "Classified by a person as a false positive",
  "accepted-risk": "Classified by a person as an accepted risk",
  "needs-investigation": "Marked by a person as needing investigation",
};

export interface ProposalContext {
  readonly repository: { readonly id: string; readonly name: string };
  readonly run: Pick<LedgerRun, "id" | "snapshot" | "headCommit" | "analyzerVersion" | "coverageStatus" | "filesAnalyzed" | "filesDiscovered">;
}

interface GeneratedContent {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly coverageLimitations: readonly string[];
  readonly hypothesis: boolean;
}

/**
 * The issue text for one finding, from fixed templates. It states what a rule observed and
 * where, and says in so many words what is not known: nothing was reproduced, impact was not
 * assessed, and no expected behavior is asserted. It contains no source text.
 */
export function generateProposalContent(finding: LedgerFinding, context: ProposalContext): GeneratedContent {
  const hypothesis = finding.disposition.classification !== "confirmed";
  // A model hypothesis is described as one everywhere a rule match would be named.
  const ai = finding.origin === "ai-hypothesis";
  const model = finding.hypothesis === undefined ? "a language model" : `model ${inlineCode(protectGeneratedText(finding.hypothesis.modelId))} via ${inlineCode(protectGeneratedText(finding.hypothesis.providerId))}`;
  const review = { "model-supported": "Supported by model review (a model judgement, not proof)", inconclusive: "Inconclusive", "not-reviewed": "Not reviewed", "model-disputed": "Disputed: a model rejected it (a judgement, not proof)" }[finding.hypothesis?.review.status ?? "not-reviewed"];
  const where = locationText({ path: finding.location.path, ...(finding.location.startLine === undefined ? {} : { startLine: finding.location.startLine }), ...(finding.location.endLine === undefined ? {} : { endLine: finding.location.endLine }) });
  const coverageLimitations = [
    ...finding.limitations.map(protectGeneratedText),
    ...(context.run.coverageStatus === "partial"
      ? [`The audit covered ${String(context.run.filesAnalyzed)} of ${String(context.run.filesDiscovered)} discovered files; coverage was partial, so related code may not have been analyzed.`]
      : []),
    ai
      ? "A language model read the source and proposed this. No code was executed and no types were checked, so the behavior was not observed."
      : "The audit read syntax and the import graph only. It executed no code and checked no types.",
  ];
  const commit = context.run.headCommit === undefined ? "no Git commit (plain directory)" : `commit ${inlineCode(context.run.headCommit.slice(0, 12))} plus any uncommitted changes present at the time`;
  const evidence = finding.evidence.slice(0, 20).map((item) => `- ${inlineCode(locationText(item))}${item.symbol === undefined ? "" : ` in ${inlineCode(item.symbol)}`} — ${inlineCode(protectGeneratedText(item.reason))}`);
  if (finding.evidence.length > 20) evidence.push(`- and ${String(finding.evidence.length - 20)} more location(s) in the local finding record`);
  const body = [
    ...(hypothesis ? [ai
      ? "> **Unconfirmed model hypothesis.** A language model proposed this from source it read. No rule matched, no person has confirmed it is a defect, and it was not reproduced."
      : "> **Unconfirmed hypothesis.** A deterministic rule matched this location. No person has confirmed it is a defect, and it was not reproduced.", ""] : []),
    ai ? "## What the model proposed" : "## What was observed",
    "",
    ai
      ? `A hypothesis from ${model} about ${inlineCode(where)}${finding.location.symbol === undefined ? "" : ` in ${inlineCode(finding.location.symbol)}`}. The text below is the model's and was not verified.`
      : `Rule ${inlineCode(finding.ruleId)} matched at ${inlineCode(where)}${finding.location.symbol === undefined ? "" : ` in ${inlineCode(finding.location.symbol)}`}.`,
    "",
    fenced(protectGeneratedText(finding.explanation)),
    "",
    "## Evidence",
    "",
    ...evidence,
    "",
    "## What is established",
    "",
    "| Fact | Status |",
    "| --- | --- |",
    ...(ai
      ? ["| A deterministic rule matched | No |", "| Proposed by a language model | Yes |", "| Quoted line exists in the file | Yes |", `| Challenged by model review | ${review} |`]
      : ["| A deterministic rule matched | Yes |", "| Source locations identified | Yes |"]),
    "| Problem reproduced | No, not attempted |",
    `| Human review | ${DISPOSITION_TEXT[finding.disposition.classification]} |`,
    "",
    "## Reproduction",
    "",
    "Not attempted. No reproduction steps are available.",
    "",
    "## Potential impact",
    "",
    ai ? "Not assessed. The consequence stated above is the model's claim and was not observed." : "Not assessed. The rule match does not establish that anything fails at run time.",
    "",
    "## Suggested direction",
    "",
    ai ? "The model's suggestion, not a verified fix:" : "The rule's general guidance, not a verified fix:",
    "",
    fenced(protectGeneratedText(finding.remediation)),
    "",
    "## Limitations",
    "",
    ...coverageLimitations.map((item) => `- ${item.replace(/`/gu, "'")}`),
    "",
    "## Provenance",
    "",
    ai
      ? `- Conclave ${inlineCode(context.run.analyzerVersion)}, repository audit with semantic discovery, ${model}`
      : `- Conclave ${inlineCode(context.run.analyzerVersion)}, repository audit, deterministic rules only (no model call)`,
    `- Observed at ${commit}`,
    `- Snapshot ${inlineCode(context.run.snapshot)}, finding ${inlineCode(finding.fingerprint)}`,
  ].join("\n");
  return {
    title: protectGeneratedText(`${hypothesis ? "[Unconfirmed] " : ""}${finding.title} (${finding.location.path})`).slice(0, MAX_TITLE),
    body,
    labels: normalizeLabels(["conclave-audit", ...(ai ? ["ai-hypothesis"] : []), `severity:${finding.severity}`, `category:${finding.category}`, ...(hypothesis ? ["needs-triage"] : [])]),
    coverageLimitations,
    hypothesis,
  };
}

function evidenceReferences(finding: LedgerFinding): IssueProposal["evidence"] {
  return finding.evidence.map((item) => ({
    path: item.path,
    ...(item.startLine === undefined ? {} : { startLine: item.startLine }),
    ...(item.endLine === undefined ? {} : { endLine: item.endLine }),
    ...(item.symbol === undefined ? {} : { symbol: item.symbol }),
  }));
}

function log(proposal: IssueProposal, entry: ProposalHistoryEntry): readonly ProposalHistoryEntry[] {
  return [...proposal.history, entry].slice(-HISTORY_LIMIT);
}

export function proposalId(repositoryId: string, fingerprints: readonly string[], attempt: number): string {
  return stableId("proposal", repositoryId, ...[...fingerprints].sort(), String(attempt));
}

export interface DraftOptions {
  readonly attempt: number;
  readonly actor: TriageActor;
  readonly now: string;
  readonly supersedes?: { readonly proposalId: string; readonly reason: string };
}

export function draftProposal(finding: LedgerFinding, context: ProposalContext, options: DraftOptions): IssueProposal {
  const content = generateProposalContent(finding, context);
  const revision = proposalRevision(content);
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    id: proposalId(context.repository.id, [finding.fingerprint], options.attempt),
    attempt: options.attempt,
    repository: context.repository,
    findings: [{ id: finding.id, fingerprint: finding.fingerprint, evidenceDigest: finding.evidenceDigest }],
    source: {
      runId: context.run.id,
      snapshot: context.run.snapshot,
      ...(context.run.headCommit === undefined ? {} : { headCommit: context.run.headCommit }),
      analyzerVersion: context.run.analyzerVersion,
    },
    title: content.title,
    body: content.body,
    labels: content.labels,
    severity: finding.severity,
    category: finding.category,
    ruleId: finding.ruleId,
    evidence: evidenceReferences(finding),
    reproduction: "not-attempted",
    humanDisposition: finding.disposition.classification,
    hypothesis: content.hypothesis,
    coverageLimitations: content.coverageLimitations,
    status: "draft",
    revision,
    generatedRevision: revision,
    invalidatedApprovals: [],
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
    createdAt: options.now,
    updatedAt: options.now,
    history: [{ at: options.now, action: "created", to: "draft", by: options.actor, ...(options.supersedes === undefined ? {} : { detail: `Supersedes ${options.supersedes.proposalId}: ${options.supersedes.reason}` }) }],
  };
}

function without<K extends keyof IssueProposal>(proposal: IssueProposal, ...keys: readonly K[]): Omit<IssueProposal, K> {
  return Object.fromEntries(Object.entries(proposal).filter(([key]) => !(keys as readonly string[]).includes(key))) as unknown as Omit<IssueProposal, K>;
}

/** Moves a live approval into the invalidated list. No approval survives a change it did not cover. */
function invalidateApproval(proposal: IssueProposal, reason: string, now: string): IssueProposal {
  if (proposal.approval === undefined) return proposal;
  return {
    ...without(proposal, "approval"),
    invalidatedApprovals: [...proposal.invalidatedApprovals, { ...proposal.approval, invalidatedAt: now, reason }],
    history: log(proposal, { at: now, action: "approval-invalidated", from: proposal.status, to: proposal.status, detail: reason }),
  };
}

function assertStatus(proposal: IssueProposal, allowed: readonly ProposalStatus[], action: string): void {
  if (!allowed.includes(proposal.status)) throw new ProposalError("invalid_transition", `Cannot ${action} a proposal that is ${proposal.status}; it must be ${allowed.join(" or ")}.`);
}

export interface ProposalEdit {
  readonly title?: string;
  readonly body?: string;
  readonly labels?: readonly string[];
}

/**
 * Applies a person's edit. A material change (a different revision) invalidates any approval
 * and returns an approved proposal to review; an edit that leaves the revision unchanged, such
 * as trailing whitespace or label order, changes nothing.
 */
export function editProposal(proposal: IssueProposal, edit: ProposalEdit, actor: TriageActor, now: string): IssueProposal {
  assertStatus(proposal, ["draft", "pending-review", "approved", "ready-for-publication"], "edit");
  const title = (edit.title ?? proposal.title).replace(/\s+/gu, " ").trim();
  const body = normalizeBody(edit.body ?? proposal.body);
  const labels = normalizeLabels(edit.labels ?? proposal.labels);
  if (title === "" || title.length > MAX_TITLE) throw new ProposalError("invalid_edit", `Title must be 1 to ${String(MAX_TITLE)} characters`);
  if (body === "" || body.length > MAX_BODY) throw new ProposalError("invalid_edit", `Body must be 1 to ${String(MAX_BODY)} characters`);
  if (labels.length > MAX_LABELS || labels.some((label) => !LABEL.test(label))) throw new ProposalError("invalid_edit", `Labels: at most ${String(MAX_LABELS)}, each up to 50 letters, digits, spaces or : . _ / -`);
  assertNoSecret(title, "Title");
  assertNoSecret(body, "Body");
  for (const label of labels) assertNoSecret(label, "Label");
  const revision = proposalRevision({ title, body, labels });
  if (revision === proposal.revision) return proposal;
  const status: ProposalStatus = proposal.status === "draft" ? "draft" : "pending-review";
  const cleared = invalidateApproval(proposal, `Edited: revision changed from ${proposal.revision} to ${revision}`, now);
  return { ...cleared, title, body, labels, revision, status, updatedAt: now, history: log(cleared, { at: now, action: "edited", from: proposal.status, to: status, by: actor, detail: revision }) };
}

export function submitProposal(proposal: IssueProposal, actor: TriageActor, now: string): IssueProposal {
  assertStatus(proposal, ["draft"], "submit");
  return { ...proposal, status: "pending-review", updatedAt: now, history: log(proposal, { at: now, action: "submitted", from: "draft", to: "pending-review", by: actor }) };
}

export interface ApprovalRequest {
  /** The exact revision the person reviewed. A proposal edited since then is not approved by this. */
  readonly revision: string;
  readonly actor: TriageActor;
  readonly method: ProposalApproval["method"];
}

/**
 * Records a person's approval of one revision. The only way a proposal becomes approved; no
 * other function sets that status. The linked findings supply the evidence the approval is
 * bound to.
 */
export function approveProposal(proposal: IssueProposal, request: ApprovalRequest, findings: readonly LedgerFinding[], now: string): IssueProposal {
  assertStatus(proposal, ["pending-review"], "approve");
  if (request.revision !== proposal.revision) throw new ProposalError("revision_mismatch", `Approval names revision ${request.revision}, but the proposal is at ${proposal.revision}. Review the current text and approve that revision.`);
  const evidence: Record<string, string> = {};
  for (const link of proposal.findings) {
    const finding = findings.find((item) => item.fingerprint === link.fingerprint);
    if (finding === undefined) throw new ProposalError("finding_missing", `Finding ${link.fingerprint} is no longer in the ledger`);
    if (finding.evidenceDigest !== link.evidenceDigest) throw new ProposalError("evidence_changed", "The source behind this proposal changed since it was written. Refresh the proposal and review it again.");
    evidence[link.fingerprint] = finding.evidenceDigest;
  }
  const approval: ProposalApproval = { revision: proposal.revision, evidence, approvedAt: now, approvedBy: request.actor, method: request.method };
  return { ...proposal, status: "approved", approval, updatedAt: now, history: log(proposal, { at: now, action: "approved", from: "pending-review", to: "approved", by: request.actor, detail: proposal.revision }) };
}

export function rejectProposal(proposal: IssueProposal, reason: string, actor: TriageActor, now: string): IssueProposal {
  assertStatus(proposal, ["draft", "pending-review", "approved", "ready-for-publication", "stale"], "reject");
  const text = reason.replace(/\s+/gu, " ").trim();
  if (text === "" || text.length > 500) throw new ProposalError("invalid_reason", "Rejecting a proposal requires a reason of 1 to 500 characters");
  assertNoSecret(text, "Reason");
  const cleared = invalidateApproval(proposal, "Proposal rejected", now);
  return {
    ...without(cleared, "stale"),
    status: "rejected",
    rejection: { reason: text, at: now, by: actor, revision: proposal.revision, evidence: Object.fromEntries(proposal.findings.map((link) => [link.fingerprint, link.evidenceDigest])) },
    updatedAt: now,
    history: log(cleared, { at: now, action: "rejected", from: proposal.status, to: "rejected", by: actor, detail: text }),
  };
}

/** Marks a proposal stale and voids its approval. A no-op for one that is already rejected or stale. */
export function markProposalStale(proposal: IssueProposal, reason: string, now: string): IssueProposal {
  if (proposal.status === "rejected" || proposal.status === "stale") return proposal;
  const cleared = invalidateApproval(proposal, reason, now);
  return { ...cleared, status: "stale", stale: { reason, at: now, previousStatus: proposal.status }, updatedAt: now, history: log(cleared, { at: now, action: "marked-stale", from: proposal.status, to: "stale", detail: reason }) };
}

/** Why the current ledger no longer supports a proposal's text, or `undefined` when it still does. */
export function staleReason(proposal: IssueProposal, findings: Readonly<Record<string, LedgerFinding>>): string | undefined {
  for (const link of proposal.findings) {
    const finding = findings[link.fingerprint];
    if (finding === undefined) return `Finding ${link.fingerprint} is no longer in the ledger`;
    if (finding.state === "resolved") return `Finding ${link.fingerprint} was resolved: the latest audit that examined its location no longer observed it`;
    if (finding.evidenceDigest !== link.evidenceDigest) return `The source text behind finding ${link.fingerprint} changed since the proposal was written`;
    if (finding.disposition.classification !== proposal.humanDisposition) return `Finding ${link.fingerprint} was reclassified from ${proposal.humanDisposition} to ${finding.disposition.classification} after the proposal was written`;
  }
  return undefined;
}

/**
 * Everything publication requires, checked against the proposal's own content and the ledger
 * as they are now. This is what a future publisher must call: it recomputes the revision from
 * the text instead of believing the stored `status` or `revision`, so editing the state file
 * to say "approved" does not produce a publishable proposal.
 */
export function publicationGate(proposal: IssueProposal, findings: Readonly<Record<string, LedgerFinding>>, options: { readonly requireReady?: boolean } = {}): PublicationGate {
  const blockers: string[] = [];
  const actual = proposalRevision(proposal);
  if (options.requireReady !== false && proposal.status !== "ready-for-publication") blockers.push(`Status is ${proposal.status}, not ready-for-publication`);
  if (actual !== proposal.revision) blockers.push("Stored revision does not match the proposal text");
  const approval = proposal.approval;
  if (approval === undefined) blockers.push("No approval is recorded");
  else if (approval.revision !== actual) blockers.push(`Approval covers revision ${approval.revision}; the text is now ${actual}`);
  for (const link of proposal.findings) {
    const finding = findings[link.fingerprint];
    if (finding === undefined) {
      blockers.push(`Finding ${link.fingerprint} is not in the ledger`);
      continue;
    }
    if (finding.state === "resolved") blockers.push(`Finding ${link.fingerprint} is resolved`);
    if (finding.state === "not-evaluated") blockers.push(`Finding ${link.fingerprint} was not evaluated by the latest audit, so its evidence is unverified`);
    if (finding.evidenceDigest !== link.evidenceDigest) blockers.push(`Source evidence of finding ${link.fingerprint} changed since the proposal was written`);
    if (approval !== undefined && approval.evidence[link.fingerprint] !== finding.evidenceDigest) blockers.push(`Approval was given for different source evidence of finding ${link.fingerprint}`);
    if (finding.disposition.classification === "false-positive") blockers.push(`Finding ${link.fingerprint} is classified as a false positive`);
    if (finding.disposition.classification !== proposal.humanDisposition) blockers.push(`Finding ${link.fingerprint} was reclassified after the proposal was written`);
    if (finding.suppressed) blockers.push(`Finding ${link.fingerprint} is suppressed inline`);
    if (finding.applicability?.issueProposals === false) blockers.push(`Finding ${link.fingerprint} is declared ineligible for issue proposals (${finding.applicability.source})`);
  }
  for (const [label, text] of [["Title", proposal.title], ["Body", proposal.body], ["Labels", proposal.labels.join("\n")]] as const) {
    const scan = redactSecrets(text);
    if (scan.residual || Object.keys(scan.redactions).length > 0) blockers.push(`${label} matches a credential detector`);
  }
  return { publishable: blockers.length === 0, blockers };
}

/** `approved → ready-for-publication`, only when every publication requirement holds right now. */
export function markProposalReady(proposal: IssueProposal, findings: Readonly<Record<string, LedgerFinding>>, actor: TriageActor, now: string): IssueProposal {
  assertStatus(proposal, ["approved"], "mark ready");
  const gate = publicationGate(proposal, findings, { requireReady: false });
  if (!gate.publishable) throw new ProposalError("not_publishable", `Proposal is not ready for publication: ${gate.blockers.join("; ")}`);
  return { ...proposal, status: "ready-for-publication", updatedAt: now, history: log(proposal, { at: now, action: "marked-ready", from: "approved", to: "ready-for-publication", by: actor }) };
}

/**
 * Rebinds a stale or draft proposal to the finding as it is now and returns it to `draft`.
 * Text nobody edited is regenerated; edited text is kept for the person to revise, because
 * regenerating it would discard their words.
 */
export function refreshProposal(proposal: IssueProposal, finding: LedgerFinding, context: ProposalContext, actor: TriageActor | undefined, now: string): IssueProposal {
  assertStatus(proposal, ["stale", "draft"], "refresh");
  if (finding.state === "resolved") throw new ProposalError("finding_resolved", "The finding is resolved; there is nothing current to propose. Reject the proposal instead.");
  const edited = proposal.revision !== proposal.generatedRevision;
  const content = generateProposalContent(finding, context);
  const generatedRevision = proposalRevision(content);
  const text = edited ? { title: proposal.title, body: proposal.body, labels: proposal.labels, revision: proposal.revision } : { title: content.title, body: content.body, labels: content.labels, revision: generatedRevision };
  const base = without(proposal, "stale");
  return {
    ...base,
    ...text,
    // An edited text keeps its own revision, so it stays distinguishable from generated text.
    generatedRevision: edited ? proposal.generatedRevision : generatedRevision,
    findings: [{ id: finding.id, fingerprint: finding.fingerprint, evidenceDigest: finding.evidenceDigest }],
    source: { runId: context.run.id, snapshot: context.run.snapshot, ...(context.run.headCommit === undefined ? {} : { headCommit: context.run.headCommit }), analyzerVersion: context.run.analyzerVersion },
    severity: finding.severity,
    evidence: evidenceReferences(finding),
    humanDisposition: finding.disposition.classification,
    hypothesis: content.hypothesis,
    coverageLimitations: content.coverageLimitations,
    status: "draft",
    updatedAt: now,
    history: log(proposal, { at: now, action: edited ? "refreshed" : "regenerated", from: proposal.status, to: "draft", ...(actor === undefined ? {} : { by: actor }), detail: edited ? "Evidence rebound; edited text kept and needs revising" : "Text regenerated from the current finding" }),
  };
}
