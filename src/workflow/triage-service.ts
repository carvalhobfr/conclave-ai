import { lstat, readFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { relative, resolve, sep } from "node:path";

import type { AuditReport, AuditSeverity } from "../domain/audit.js";
import type {
  AuditEvaluation,
  FindingDisposition,
  FindingLedger,
  FindingLifecycleState,
  LedgerFinding,
  LedgerRun,
  TriageActor,
} from "../domain/finding-ledger.js";
import { PROPOSAL_SCHEMA_VERSION, type IssueProposal, type IssueProposalStore, type ProposalStatus, type PublicationGate } from "../domain/issue-proposal.js";
import { isSensitivePath } from "../repositories/ignore-rules.js";
import { assessRepositoryContent } from "../security/content-safety.js";
import { isPathInside, resolveRepositoryRoot } from "../security/path-policy.js";
import { latestAuditFeedback, listFindingFeedback, recordAuditFindingFeedback, type FindingFeedback } from "../storage/finding-feedback.js";
import { loadFindingLedger, loadIssueProposals, saveFindingLedger, saveIssueProposals, withTriageLock } from "../storage/finding-ledger.js";
import { existingStateDirectory } from "../storage/state-file.js";
import { reconcileLedger } from "../validation/finding-lifecycle.js";
import {
  approveProposal,
  draftProposal,
  editProposal,
  markProposalReady,
  markProposalStale,
  ProposalError,
  protectGeneratedText,
  publicationGate,
  refreshProposal,
  rejectProposal,
  staleReason,
  submitProposal,
  type ApprovalRequest,
  type ProposalContext,
  type ProposalEdit,
} from "../validation/issue-proposal.js";

/**
 * The local triage workflow over audit results: the finding ledger, human classifications and
 * issue proposals. The CLI and the loopback API call the same methods.
 *
 * Nothing here calls a model, a network or GitHub, and nothing here runs a command. Identifiers
 * come from the caller; text from the repository is only ever stored or displayed.
 */

export class TriageError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TriageError";
  }
}

const ACTIVE: readonly ProposalStatus[] = ["draft", "pending-review", "approved", "ready-for-publication"];
const MAX_EXCERPT_BYTES = 1_000_000;
const MAX_EXCERPT_LINES = 40;
const EXCERPT_CONTEXT = 2;

/** The person at this terminal. Informational: local state has no authentication. */
export function cliActor(): TriageActor {
  try {
    const name = userInfo().username.replace(/[^\w.@ -]/gu, "").slice(0, 100);
    return name === "" ? { kind: "cli" } : { kind: "cli", name };
  } catch {
    return { kind: "cli" };
  }
}

function live(proposals: Readonly<Record<string, IssueProposal>>): IssueProposal[] {
  return Object.values(proposals);
}

function emptyStore(ledger: FindingLedger, now: string): IssueProposalStore {
  return { schemaVersion: PROPOSAL_SCHEMA_VERSION, repository: { id: ledger.repository.id, name: ledger.repository.name }, proposals: {}, updatedAt: now };
}

function contextFor(ledger: FindingLedger, finding: LedgerFinding): ProposalContext {
  const run = ledger.runs.find((item) => item.id === finding.lastSeen.runId) ?? ledger.runs[0];
  if (run === undefined) throw new TriageError("no_audit", "No audit run is recorded. Run `conclave audit` first.");
  return { repository: { id: ledger.repository.id, name: ledger.repository.name }, run };
}

/**
 * Brings proposals in line with the ledger: one whose finding was resolved, whose source text
 * changed or whose finding was reclassified no longer says what the ledger supports. A draft
 * nobody edited is regenerated; anything a person reviewed or edited becomes stale, which voids
 * its approval and requires a new review.
 */
function syncProposals(ledger: FindingLedger, store: IssueProposalStore, now: string): IssueProposalStore {
  let changed = false;
  const proposals: Record<string, IssueProposal> = {};
  for (const proposal of live(store.proposals)) {
    let next = proposal;
    const reason = ACTIVE.includes(proposal.status) ? staleReason(proposal, ledger.findings) : undefined;
    if (reason !== undefined) {
      const finding = ledger.findings[proposal.findings[0]?.fingerprint ?? ""];
      const regenerable = proposal.status === "draft" && proposal.revision === proposal.generatedRevision && finding !== undefined && finding.state !== "resolved";
      next = regenerable ? refreshProposal(proposal, finding, contextFor(ledger, finding), undefined, now) : markProposalStale(proposal, reason, now);
      changed = true;
    }
    proposals[next.id] = next;
  }
  return changed ? { ...store, proposals, updatedAt: now } : store;
}

/**
 * Records one audit: folds it into the ledger, restores any classification the feedback log
 * holds that the ledger lost, and marks proposals the new evidence no longer supports.
 */
export async function recordAuditInLedger(root: string, report: AuditReport, evaluation: AuditEvaluation): Promise<FindingLedger> {
  return withTriageLock(root, async () => {
    const previous = (await loadFindingLedger(root)).value;
    let { ledger } = reconcileLedger(previous, report, evaluation);
    // The append-only feedback log is the durable record of human decisions. If the ledger was
    // lost or restored from its previous version, the latest decision per finding is reapplied.
    const feedback = await latestAuditFeedback(root);
    const findings: Record<string, LedgerFinding> = { ...ledger.findings };
    for (const [fingerprint, record] of feedback) {
      const entry = findings[fingerprint];
      if (entry === undefined || (entry.disposition.classifiedAt ?? "") >= record.createdAt) continue;
      findings[fingerprint] = { ...entry, disposition: dispositionFrom(record) };
    }
    ledger = { ...ledger, findings };
    await saveFindingLedger(root, ledger);
    const store = (await loadIssueProposals(root)).value;
    if (store !== undefined) {
      const synced = syncProposals(ledger, store, report.generatedAt);
      if (synced !== store) await saveIssueProposals(root, synced);
    }
    return ledger;
  });
}

function dispositionFrom(record: FindingFeedback): LedgerFinding["disposition"] {
  return {
    classification: record.classification,
    ...(record.note === "" ? {} : { note: record.note }),
    classifiedAt: record.createdAt,
    ...(record.actor === undefined ? {} : { classifiedBy: record.actor }),
    feedbackId: record.id,
  };
}

export interface FindingFilter {
  readonly states?: readonly FindingLifecycleState[];
  readonly dispositions?: readonly FindingDisposition[];
  readonly ruleId?: string;
  readonly severity?: AuditSeverity;
  /** Repository-relative path prefix. */
  readonly path?: string;
  /** Include findings suppressed by an inline `conclave-ignore`. Default false. */
  readonly suppressed?: boolean;
  /** `true` only baselined findings, `false` only findings outside the baseline. */
  readonly baselined?: boolean;
}

export interface IssueEligibility {
  readonly eligible: boolean;
  /** Present when not eligible. */
  readonly reason?: string;
}

export interface FindingView extends LedgerFinding {
  readonly proposals: readonly { readonly id: string; readonly status: ProposalStatus; readonly attempt: number }[];
  readonly issueEligibility: IssueEligibility;
}

export interface EvidenceExcerpt {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly reason: string;
  /** Source lines as they are on disk now, with recognized secrets redacted. Absent when withheld. */
  readonly lines?: readonly { readonly number: number; readonly text: string }[];
  /** Why no lines are shown. */
  readonly withheld?: string;
}

export interface FindingDetail {
  readonly finding: FindingView;
  /** Every classification recorded for this finding, oldest first. */
  readonly feedback: readonly FindingFeedback[];
  readonly proposals: readonly IssueProposal[];
}

export interface ProposalFilter {
  readonly statuses?: readonly ProposalStatus[];
  readonly findingId?: string;
}

export interface ProposalDetail {
  readonly proposal: IssueProposal;
  /** What publication would still require. Informational: nothing here publishes. */
  readonly gate: PublicationGate;
}

export interface ProposalCreation {
  readonly proposal: IssueProposal;
  /** False when an existing proposal for the finding was returned instead of a new one. */
  readonly created: boolean;
}

function eligibility(finding: LedgerFinding): IssueEligibility {
  if (finding.state === "resolved") return { eligible: false, reason: "The finding is resolved" };
  if (finding.state === "not-evaluated") return { eligible: false, reason: `The latest audit did not evaluate it (${finding.notEvaluatedReason ?? "reason not recorded"}); run an audit that covers it` };
  if (finding.suppressed) return { eligible: false, reason: "The finding is suppressed by an inline conclave-ignore directive" };
  if (finding.applicability?.issueProposals === false) return { eligible: false, reason: `Declared as ${finding.applicability.role} in ${finding.applicability.source}: ${finding.applicability.reason}` };
  if (finding.disposition.classification === "false-positive") return { eligible: false, reason: "The finding is classified as a false positive" };
  return { eligible: true };
}

function matchReference<T extends { readonly id: string }>(items: readonly T[], reference: string, kind: string, alternatives: (item: T) => readonly string[] = () => []): T {
  const wanted = reference.trim();
  if (!/^[A-Za-z0-9_]{6,80}$/u.test(wanted)) throw new TriageError("invalid_reference", `A ${kind} reference is its id or at least 6 leading characters of it`);
  const exact = items.find((item) => item.id === wanted || alternatives(item).includes(wanted));
  if (exact !== undefined) return exact;
  const matches = items.filter((item) => item.id.startsWith(wanted) || item.id.slice(item.id.lastIndexOf("_") + 1).startsWith(wanted));
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  throw new TriageError(matches.length === 0 ? "not_found" : "ambiguous_reference", matches.length === 0 ? `No ${kind} matches ${wanted}` : `${String(matches.length)} ${kind}s match ${wanted}; use more characters`);
}

export class TriageService {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  /** `path` is the repository directory; it is resolved to its canonical location once. */
  public static async open(path: string): Promise<TriageService> {
    return new TriageService(await resolveRepositoryRoot(path));
  }

  public get root(): string {
    return this.#root;
  }

  async #ledger(): Promise<FindingLedger> {
    const ledger = (await loadFindingLedger(this.#root)).value;
    if (ledger === undefined) throw new TriageError("no_audit", "No audit has been recorded for this repository. Run `conclave audit` first (without --no-write).");
    return ledger;
  }

  /**
   * Runs a change under the triage lock. The ledger is checked first, outside the lock, so a
   * command against a repository that was never audited fails without creating `.conclave`.
   */
  async #locked<T>(action: () => Promise<T>): Promise<T> {
    await this.#ledger();
    return withTriageLock(this.#root, action);
  }

  async #proposals(ledger: FindingLedger): Promise<IssueProposalStore> {
    return (await loadIssueProposals(this.#root)).value ?? emptyStore(ledger, new Date().toISOString());
  }

  #view(finding: LedgerFinding, store: IssueProposalStore): FindingView {
    return {
      ...finding,
      proposals: live(store.proposals)
        .filter((proposal) => proposal.findings.some((link) => link.fingerprint === finding.fingerprint))
        .sort((left, right) => left.attempt - right.attempt)
        .map((proposal) => ({ id: proposal.id, status: proposal.status, attempt: proposal.attempt })),
      issueEligibility: eligibility(finding),
    };
  }

  public async listAuditRuns(): Promise<readonly LedgerRun[]> {
    return (await loadFindingLedger(this.#root)).value?.runs ?? [];
  }

  /** Findings in the ledger, ordered by path, line and rule. An unaudited repository has none. */
  public async listFindings(filter: FindingFilter = {}): Promise<readonly FindingView[]> {
    const ledger = (await loadFindingLedger(this.#root)).value;
    if (ledger === undefined) return [];
    const store = await this.#proposals(ledger);
    return Object.values(ledger.findings)
      .filter((finding) =>
        (filter.states === undefined || filter.states.includes(finding.state)) &&
        (filter.dispositions === undefined || filter.dispositions.includes(finding.disposition.classification)) &&
        (filter.ruleId === undefined || finding.ruleId === filter.ruleId) &&
        (filter.severity === undefined || finding.severity === filter.severity) &&
        (filter.path === undefined || finding.location.path.startsWith(filter.path)) &&
        (filter.suppressed === true || !finding.suppressed) &&
        (filter.baselined === undefined || finding.baselined === filter.baselined))
      .sort((left, right) => left.location.path.localeCompare(right.location.path) || (left.location.startLine ?? 0) - (right.location.startLine ?? 0) || left.ruleId.localeCompare(right.ruleId) || left.fingerprint.localeCompare(right.fingerprint))
      .map((finding) => this.#view(finding, store));
  }

  #find(ledger: FindingLedger, reference: string): LedgerFinding {
    return matchReference(Object.values(ledger.findings), reference, "finding", (finding) => [finding.fingerprint, ...finding.aliases]);
  }

  public async getFinding(reference: string): Promise<FindingDetail> {
    const ledger = await this.#ledger();
    const store = await this.#proposals(ledger);
    const finding = this.#find(ledger, reference);
    const feedback = await existingStateDirectory(this.#root) === undefined ? [] : await listFindingFeedback(this.#root);
    return {
      finding: this.#view(finding, store),
      feedback: feedback.filter((record) => record.origin === "audit" && record.fingerprint === finding.fingerprint),
      proposals: live(store.proposals).filter((proposal) => proposal.findings.some((link) => link.fingerprint === finding.fingerprint)).sort((left, right) => left.attempt - right.attempt),
    };
  }

  /**
   * The source lines behind a finding, read from disk now. Each path is resolved and must stay
   * inside the repository; credential files and content matching a secret detector are withheld.
   */
  public async readFindingEvidence(reference: string): Promise<readonly EvidenceExcerpt[]> {
    const finding = this.#find(await this.#ledger(), reference);
    return Promise.all(finding.evidence.slice(0, 20).map(async (item): Promise<EvidenceExcerpt> => {
      const base = { path: item.path, ...(item.startLine === undefined ? {} : { startLine: item.startLine }), ...(item.endLine === undefined ? {} : { endLine: item.endLine }), reason: item.reason };
      if (item.startLine === undefined) return { ...base, withheld: "The evidence names the file, not specific lines" };
      // The path comes from stored state. It is confined lexically first and again after resolving links.
      const absolute = resolve(this.#root, item.path);
      if (absolute === this.#root || !isPathInside(this.#root, absolute)) return { ...base, withheld: "Path leaves the repository" };
      if (isSensitivePath(relative(this.#root, absolute).split(sep).join("/"))) return { ...base, withheld: "File name matches a credential pattern" };
      try {
        const details = await lstat(absolute);
        if (details.isSymbolicLink() || !details.isFile()) return { ...base, withheld: "Not a regular file" };
        if (!isPathInside(this.#root, await realpath(absolute))) return { ...base, withheld: "Path leaves the repository" };
        if (details.size > MAX_EXCERPT_BYTES) return { ...base, withheld: "File is too large" };
        const content = await readFile(absolute, "utf8");
        if (!assessRepositoryContent(content).externalTransmissionAllowed) return { ...base, withheld: "File content matches a credential detector" };
        const source = content.split(/\r?\n/u);
        const first = Math.max(1, item.startLine - EXCERPT_CONTEXT);
        const last = Math.min(source.length, (item.endLine ?? item.startLine) + EXCERPT_CONTEXT, first + MAX_EXCERPT_LINES - 1);
        const lines = [];
        // eslint-disable-next-line no-control-regex
        for (let number = first; number <= last; number += 1) lines.push({ number, text: protectGeneratedText((source[number - 1] ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, " ")) });
        return { ...base, lines };
      } catch {
        return { ...base, withheld: "The file can no longer be read" };
      }
    }));
  }

  /**
   * Records what a person decided about a finding. It changes the disposition and nothing
   * else: lifecycle state, evidence and any proposal approval are separate facts.
   */
  public async classifyFinding(reference: string, input: { readonly classification: FindingDisposition; readonly note?: string; readonly actor: TriageActor }): Promise<FindingView> {
    return this.#locked(async () => {
      const ledger = await this.#ledger();
      const finding = this.#find(ledger, reference);
      const record = await recordAuditFindingFeedback(this.#root, { fingerprint: finding.fingerprint, runId: finding.lastEvaluated.runId, snapshot: finding.lastEvaluated.snapshot }, input);
      const updated: LedgerFinding = { ...finding, disposition: dispositionFrom(record) };
      const next: FindingLedger = { ...ledger, findings: { ...ledger.findings, [finding.fingerprint]: updated }, updatedAt: record.createdAt };
      await saveFindingLedger(this.#root, next);
      const store = (await loadIssueProposals(this.#root)).value;
      const synced = store === undefined ? undefined : syncProposals(next, store, record.createdAt);
      if (synced !== undefined && synced !== store) await saveIssueProposals(this.#root, synced);
      return this.#view(updated, synced ?? emptyStore(next, record.createdAt));
    });
  }

  /**
   * Drafts an issue proposal for a finding. Idempotent: a finding with a live proposal gets
   * that proposal back. A finding whose proposal was rejected gets a new one only for a stated
   * reason, or when its source evidence changed after the rejection.
   */
  public async createProposal(reference: string, input: { readonly actor: TriageActor; readonly reason?: string }): Promise<ProposalCreation> {
    return this.#locked(async () => {
      const ledger = await this.#ledger();
      const now = new Date().toISOString();
      const finding = this.#find(ledger, reference);
      const store = syncProposals(ledger, await this.#proposals(ledger), now);
      const earlier = live(store.proposals).filter((proposal) => proposal.findings.some((link) => link.fingerprint === finding.fingerprint)).sort((left, right) => right.attempt - left.attempt);
      const latest = earlier[0];
      if (latest !== undefined && ACTIVE.includes(latest.status)) {
        await saveIssueProposals(this.#root, store);
        return { proposal: latest, created: false };
      }
      const eligible = eligibility(finding);
      if (!eligible.eligible) throw new TriageError("not_eligible", `No issue proposal can be drafted for this finding: ${eligible.reason ?? ""}`);
      const context = contextFor(ledger, finding);
      let proposal: IssueProposal;
      if (latest?.status === "stale") {
        proposal = refreshProposal(latest, finding, context, input.actor, now);
      } else {
        let supersedes: { readonly proposalId: string; readonly reason: string } | undefined;
        if (latest?.status === "rejected") {
          const stated = (input.reason ?? "").replace(/\s+/gu, " ").trim();
          const evidenceChanged = latest.rejection?.evidence[finding.fingerprint] !== finding.evidenceDigest;
          if (stated === "" && !evidenceChanged) {
            throw new TriageError("previously_rejected", `Proposal ${latest.id} for this finding was rejected (${latest.rejection.reason}) and its source evidence has not changed. Give a reason to propose it again.`);
          }
          if (stated.length > 300) throw new TriageError("invalid_reason", "The reason must be at most 300 characters");
          supersedes = { proposalId: latest.id, reason: stated === "" ? "Source evidence changed since the rejection" : protectGeneratedText(stated) };
        }
        proposal = draftProposal(finding, context, { attempt: (latest?.attempt ?? 0) + 1, actor: input.actor, now, ...(supersedes === undefined ? {} : { supersedes }) });
      }
      await saveIssueProposals(this.#root, { ...store, proposals: { ...store.proposals, [proposal.id]: proposal }, updatedAt: now });
      return { proposal, created: latest?.status !== "stale" };
    });
  }

  public async listProposals(filter: ProposalFilter = {}): Promise<readonly IssueProposal[]> {
    const ledger = (await loadFindingLedger(this.#root)).value;
    if (ledger === undefined) return [];
    const store = await this.#proposals(ledger);
    const finding = filter.findingId === undefined ? undefined : this.#find(ledger, filter.findingId);
    return live(store.proposals)
      .filter((proposal) => (filter.statuses === undefined || filter.statuses.includes(proposal.status)) && (finding === undefined || proposal.findings.some((link) => link.fingerprint === finding.fingerprint)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  }

  public async getProposal(reference: string): Promise<ProposalDetail> {
    const ledger = await this.#ledger();
    const proposal = matchReference(live((await this.#proposals(ledger)).proposals), reference, "proposal");
    return { proposal, gate: publicationGate(proposal, ledger.findings) };
  }

  /** Loads, syncs with the ledger, applies one change to one proposal and saves. */
  async #change(reference: string, apply: (proposal: IssueProposal, ledger: FindingLedger, now: string) => IssueProposal): Promise<ProposalDetail> {
    return this.#locked(async () => {
      const ledger = await this.#ledger();
      const now = new Date().toISOString();
      const loaded = await this.#proposals(ledger);
      const store = syncProposals(ledger, loaded, now);
      const current = matchReference(live(store.proposals), reference, "proposal");
      let proposal: IssueProposal;
      try {
        proposal = apply(current, ledger, now);
      } catch (error) {
        // Staleness discovered on the way is real and is kept even though the requested change failed.
        if (store !== loaded) await saveIssueProposals(this.#root, store);
        throw error;
      }
      if (proposal !== current || store !== loaded) await saveIssueProposals(this.#root, { ...store, proposals: { ...store.proposals, [proposal.id]: proposal }, updatedAt: now });
      return { proposal, gate: publicationGate(proposal, ledger.findings) };
    });
  }

  public async editProposal(reference: string, edit: ProposalEdit, actor: TriageActor): Promise<ProposalDetail> {
    return this.#change(reference, (proposal, _ledger, now) => editProposal(proposal, edit, actor, now));
  }

  public async submitProposal(reference: string, actor: TriageActor): Promise<ProposalDetail> {
    return this.#change(reference, (proposal, _ledger, now) => submitProposal(proposal, actor, now));
  }

  /**
   * Approves one revision of a proposal. `request.revision` must be the full revision the
   * person reviewed: this method never looks the current one up on the caller's behalf.
   */
  public async approveProposal(reference: string, request: ApprovalRequest): Promise<ProposalDetail> {
    return this.#change(reference, (proposal, ledger, now) => approveProposal(proposal, request, Object.values(ledger.findings), now));
  }

  public async rejectProposal(reference: string, input: { readonly reason: string; readonly actor: TriageActor }): Promise<ProposalDetail> {
    return this.#change(reference, (proposal, _ledger, now) => rejectProposal(proposal, input.reason, input.actor, now));
  }

  public async markProposalReady(reference: string, actor: TriageActor): Promise<ProposalDetail> {
    return this.#change(reference, (proposal, ledger, now) => markProposalReady(proposal, ledger.findings, actor, now));
  }

  /** Returns a stale proposal to `draft`, bound to the finding as it is now. */
  public async refreshProposal(reference: string, actor: TriageActor): Promise<ProposalDetail> {
    return this.#change(reference, (proposal, ledger, now) => {
      const finding = ledger.findings[proposal.findings[0]?.fingerprint ?? ""];
      if (finding === undefined) throw new ProposalError("finding_missing", "The finding this proposal was written for is no longer in the ledger");
      const eligible = eligibility(finding);
      if (!eligible.eligible) throw new TriageError("not_eligible", `The proposal cannot be refreshed: ${eligible.reason ?? ""}`);
      return refreshProposal(proposal, finding, contextFor(ledger, finding), actor, now);
    });
  }
}
