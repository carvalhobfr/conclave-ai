import { useEffect, useRef, useState, type RefObject } from "react";

import type { IssueProposal } from "../../../src/domain/issue-proposal.js";
import type { ProjectView } from "../../../src/web/contracts.js";
import type { ProposalDetail } from "../../../src/workflow/triage-service.js";
import { cockpitApi } from "./api.js";
import { Badge, CloseDetail, EmptyState, ErrorNote, Field, focusRow, message, PROPOSAL_LABEL, sentence, shortId, useRevealWhenStacked, when } from "./ui.js";

const TONE = { draft: "neutral", "pending-review": "strong", approved: "ok", "ready-for-publication": "ok", stale: "warn", rejected: "neutral" } as const;
const EDITABLE: readonly IssueProposal["status"][] = ["draft", "pending-review", "approved", "ready-for-publication"];

function ProposalPanel({ project, id, onChanged, onFinding, onClose, panelRef }: { readonly project: ProjectView; readonly id: string; readonly onChanged: () => void; readonly onFinding: (id: string) => void; readonly onClose: () => void; readonly panelRef: RefObject<HTMLElement | null> }) {
  const [detail, setDetail] = useState<ProposalDetail>();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const show = (next: ProposalDetail): void => {
    setDetail(next); setTitle(next.proposal.title); setBody(next.proposal.body); setLabels(next.proposal.labels.join(", ")); setReviewed(false);
  };
  useEffect(() => {
    let current = true;
    setDetail(undefined); setError(""); setReason("");
    cockpitApi.proposal(project.id, id).then((value) => { if (current) show(value); }).catch((failure: unknown) => { if (current) setError(message(failure, "Could not load this proposal.")); });
    return () => { current = false; };
  }, [project.id, id]);

  if (detail === undefined) return <aside className="ck-detail" aria-label="Proposal detail" ref={panelRef}><div className="ck-row"><CloseDetail onClose={onClose} /></div><p className="ck-muted">{error === "" ? "Loading proposal…" : ""}</p><ErrorNote message={error} /></aside>;
  const { proposal, gate } = detail;
  const act = async (action: () => Promise<ProposalDetail>): Promise<void> => {
    setBusy(true); setError("");
    // A failed action can still have changed the proposal (a stale mark, for one), so it is re-read.
    try { show(await action()); } catch (failure) { setError(message(failure, "The action failed.")); await cockpitApi.proposal(project.id, id).then(show).catch(() => undefined); } finally { setBusy(false); onChanged(); }
  };
  const parsedLabels = labels.split(",").map((label) => label.trim()).filter((label) => label !== "");
  const dirty = title !== proposal.title || body !== proposal.body || parsedLabels.join("\n") !== proposal.labels.join("\n");
  const editable = EDITABLE.includes(proposal.status);

  return <aside className="ck-detail" aria-label="Proposal detail" ref={panelRef}>
    <section>
      <div className="ck-row"><Badge tone={TONE[proposal.status]}>{PROPOSAL_LABEL[proposal.status]}</Badge>{proposal.hypothesis ? <Badge className="plain">unconfirmed hypothesis</Badge> : <Badge className="plain">finding confirmed by a person</Badge>}<Badge className="plain">attempt {proposal.attempt}</Badge><CloseDetail onClose={onClose} /></div>
      <h2>{proposal.title}</h2>
      <dl className="ck-kv">
        <dt>Revision</dt><dd className="ck-mono" aria-label="Current revision">{proposal.revision}</dd>
        <dt>Finding</dt><dd>{proposal.findings.map((link) => <button type="button" key={link.id} className="ck-btn ghost" onClick={() => onFinding(link.id)}>{shortId(link.id)}</button>)} <span className="ck-mono ck-faint">{proposal.ruleId}</span></dd>
        <dt>Written against</dt><dd className="ck-mono">{proposal.source.snapshot.replace("snapshot_", "").slice(0, 12)}{proposal.source.headCommit === undefined ? "" : ` @ ${proposal.source.headCommit.slice(0, 12)}`}</dd>
        <dt>Reproduction</dt><dd>{proposal.reproduction === "not-attempted" ? "Not attempted. Nothing was executed." : proposal.reproduction}</dd>
      </dl>
    </section>

    {proposal.stale === undefined ? null : <div className="ck-note warn" role="status"><strong>Stale.</strong> {sentence(proposal.stale.reason)} Any earlier approval is void. Refresh it to continue.</div>}
    {proposal.rejection === undefined ? null : <div className="ck-note" role="status"><strong>Rejected</strong> {when(proposal.rejection.at)}: {proposal.rejection.reason}</div>}

    <section aria-label="Proposal text">
      <h3>Text</h3>
      <Field label="Title"><input className="ck-input" value={title} disabled={!editable || busy} onChange={(event) => setTitle(event.target.value)} /></Field>
      <Field label="Body (Markdown source, shown as plain text and never rendered)"><textarea className="ck-textarea" rows={14} value={body} disabled={!editable || busy} onChange={(event) => setBody(event.target.value)} /></Field>
      <Field label="Labels, comma-separated"><input className="ck-input" value={labels} disabled={!editable || busy} onChange={(event) => setLabels(event.target.value)} /></Field>
      {editable ? <div className="ck-row"><button type="button" className="ck-btn" disabled={busy || !dirty} onClick={() => void act(() => cockpitApi.editProposal(project.id, proposal.id, { title, body, labels: parsedLabels }))}>Save edits</button>{proposal.approval === undefined ? <span className="ck-faint">Saving changes the revision.</span> : <span className="ck-faint">Saving voids the current approval: the edited text has to be reviewed again.</span>}</div> : null}
    </section>

    <section aria-label="Review actions">
      <h3>Review</h3>
      {proposal.status === "draft" ? <div className="ck-row"><button type="button" className="ck-btn primary" disabled={busy || dirty} onClick={() => void act(() => cockpitApi.submitProposal(project.id, proposal.id))}>Submit for review</button><span className="ck-faint">{dirty ? "Save your edits first." : "Marks it ready for a person to approve or reject."}</span></div> : null}
      {proposal.status === "stale" ? <div className="ck-row"><button type="button" className="ck-btn primary" disabled={busy} onClick={() => void act(() => cockpitApi.refreshProposal(project.id, proposal.id))}>Refresh from the current finding</button><span className="ck-faint">Regenerates the text and returns it to draft.</span></div> : null}
      {proposal.status === "pending-review" ? <>
        <label className="ck-check"><input type="checkbox" checked={reviewed} disabled={dirty} onChange={(event) => setReviewed(event.target.checked)} /><span>I read the title, body and labels above at revision <span className="ck-mono">{proposal.revision.slice(0, 16)}</span> and approve exactly that text.</span></label>
        <div className="ck-row"><button type="button" className="ck-btn primary" disabled={busy || !reviewed || dirty} onClick={() => void act(() => cockpitApi.approveProposal(project.id, proposal.id, proposal.revision))}>Approve this revision</button><span className="ck-faint">{dirty ? "Save or discard your edits before approving." : "Approval is recorded locally. Nothing is published."}</span></div>
      </> : null}
      {proposal.approval === undefined ? null : <div className="ck-note"><strong>Approved</strong> {when(proposal.approval.approvedAt)} by {proposal.approval.approvedBy.name ?? proposal.approval.approvedBy.kind}, at revision <span className="ck-mono">{proposal.approval.revision.slice(0, 16)}</span>.</div>}
      {proposal.status === "rejected" ? null : <><Field label="Reason for rejecting"><input className="ck-input" value={reason} onChange={(event) => setReason(event.target.value)} /></Field><div className="ck-row"><button type="button" className="ck-btn destructive" disabled={busy || reason.trim() === ""} onClick={() => void act(() => cockpitApi.rejectProposal(project.id, proposal.id, reason).then((next) => { setReason(""); return next; }))}>Reject proposal</button></div></>}
    </section>

    <section aria-label="Publication requirements">
      <h3>Publication</h3>
      <p className="ck-muted">This release publishes nothing. {gate.publishable ? "Every local requirement for publication is met." : "A publisher would still require:"}</p>
      {gate.blockers.length === 0 ? null : <ul className="ck-list">{gate.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
    </section>

    {proposal.invalidatedApprovals.length === 0 ? null : <section aria-label="Invalidated approvals"><h3>Invalidated approvals</h3><ul className="ck-list">{proposal.invalidatedApprovals.map((approval) => <li key={`${approval.revision}-${approval.invalidatedAt}`}>Revision <span className="ck-mono">{approval.revision.slice(0, 16)}</span>, approved {when(approval.approvedAt)}, voided {when(approval.invalidatedAt)}: {approval.reason}</li>)}</ul></section>}

    <section aria-label="Proposal history">
      <h3>History</h3>
      <ul className="ck-list">{proposal.history.map((entry, index) => <li key={`${entry.at}-${String(index)}`}><span className="ck-mono">{when(entry.at)}</span> · {entry.action}{entry.from === undefined ? "" : ` · ${PROPOSAL_LABEL[entry.from]} → ${PROPOSAL_LABEL[entry.to]}`}{entry.by?.name === undefined ? "" : ` · ${entry.by.name}`}{entry.detail === undefined ? "" : ` — ${entry.detail}`}</li>)}</ul>
    </section>

    {proposal.coverageLimitations.length === 0 ? null : <section aria-label="Limitations"><h3>Limitations stated in the proposal</h3><ul className="ck-list">{proposal.coverageLimitations.map((item) => <li key={item}>{item}</li>)}</ul></section>}
    <ErrorNote message={error} />
  </aside>;
}

export function ProposalsReview({ project, proposals, selectedId, onSelect, onChanged, onFinding }: {
  readonly project: ProjectView;
  readonly proposals: readonly IssueProposal[];
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
  readonly onChanged: () => void;
  readonly onFinding: (id: string) => void;
}) {
  const table = useRef<HTMLTableElement>(null);
  const panel = useRevealWhenStacked(selectedId);
  const close = (): void => { const id = selectedId; onSelect(undefined); if (id !== undefined) requestAnimationFrame(() => focusRow(table.current, id)); };
  if (proposals.length === 0) return <div className="ck"><header className="ck-head"><div><h1>Issue proposals</h1><p>Drafts written from findings, reviewed and approved by a person.</p></div></header><EmptyState title="No proposals yet"><p>Open a finding in the inbox and choose &ldquo;Create issue proposal&rdquo;. Nothing is drafted or published automatically.</p></EmptyState></div>;
  return <div className="ck">
    <header className="ck-head"><div><h1>Issue proposals</h1><p>Each proposal is a local draft. Approval is an explicit step on one exact revision, and nothing here publishes to GitHub.</p></div></header>
    <div className={selectedId === undefined ? "" : "ck-split"}>
      <div className="ck-table-wrap"><table className="ck-table" aria-label="Issue proposals" ref={table}>
        <thead><tr><th scope="col">Status</th><th scope="col">Title</th><th scope="col">Revision</th><th scope="col">Updated</th></tr></thead>
        <tbody>{proposals.map((proposal) => <tr key={proposal.id} className="selectable" aria-current={proposal.id === selectedId ? "true" : undefined} onClick={() => onSelect(proposal.id)}>
          <td><Badge tone={TONE[proposal.status]}>{PROPOSAL_LABEL[proposal.status]}</Badge></td>
          <td className="title"><button type="button" className="row-link" data-row={proposal.id} onClick={(event) => { event.stopPropagation(); onSelect(proposal.id); }}>{proposal.title}</button></td>
          <td className="ck-mono">{proposal.revision.slice(0, 12)}</td>
          <td>{when(proposal.updatedAt)}</td>
        </tr>)}</tbody>
      </table></div>
      {selectedId === undefined ? null : <ProposalPanel key={selectedId} project={project} id={selectedId} onChanged={onChanged} onFinding={onFinding} onClose={close} panelRef={panel} />}
    </div>
  </div>;
}
