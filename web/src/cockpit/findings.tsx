import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { AuditReport, HypothesisReviewStatus, SemanticRegionState } from "../../../src/domain/audit.js";
import { FINDING_DISPOSITIONS, FINDING_LIFECYCLE_STATES, type FindingDisposition, type FindingLifecycleState } from "../../../src/domain/finding-ledger.js";
import type { ProjectView } from "../../../src/web/contracts.js";
import type { FindingView } from "../../../src/workflow/triage-service.js";
import { cockpitApi, type FindingDetailView } from "./api.js";
import { Badge, CloseDetail, DISPOSITION_LABEL, EmptyState, ErrorNote, Field, focusRow, LIFECYCLE_LABEL, locationOf, message, originOf, OriginBadge, PROPOSAL_LABEL, REVIEW_LABEL, REVIEW_MEANING, ReviewBadge, reviewOf, SeverityBadge, shortId, useRevealWhenStacked, when } from "./ui.js";

type OriginFilter = "all" | "deterministic-rule" | "ai-hypothesis";
type SortKey = "priority" | "severity" | "location" | "last-seen";

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;
// Supported hypotheses first, disputed ones last but always listed.
const REVIEW_RANK: Readonly<Record<HypothesisReviewStatus, number>> = { "model-supported": 0, inconclusive: 1, "not-reviewed": 2, "model-disputed": 3 };
const REGION_TEXT: Readonly<Record<SemanticRegionState, string>> = {
  examined: "read by the discovery model in the last audit",
  "examined-cached": "read in an earlier audit and unchanged since; that result was reused",
  "not-examined-budget": "not reached before the budget ended",
  "not-examined-failed": "not read: the model call failed",
  "not-examined-withheld": "withheld: it matched a secret detector",
};

function priority(finding: FindingView): number {
  const unresolved = finding.state === "resolved" ? 1 : 0;
  const triaged = finding.disposition.classification === "unreviewed" || finding.disposition.classification === "needs-investigation" ? 0 : 1;
  return unresolved * 1_000 + triaged * 100 + (originOf(finding) === "ai-hypothesis" ? REVIEW_RANK[reviewOf(finding)] * 10 : 0) + SEVERITY_RANK[finding.severity];
}

const SORTS: Readonly<Record<SortKey, (left: FindingView, right: FindingView) => number>> = {
  priority: (left, right) => priority(left) - priority(right) || locationOf(left).localeCompare(locationOf(right)),
  severity: (left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || locationOf(left).localeCompare(locationOf(right)),
  location: (left, right) => left.location.path.localeCompare(right.location.path) || (left.location.startLine ?? 0) - (right.location.startLine ?? 0),
  "last-seen": (left, right) => right.lastSeen.at.localeCompare(left.lastSeen.at),
};

function Excerpts({ detail }: { readonly detail: FindingDetailView }) {
  return <>{detail.source.map((excerpt, index) => <div key={`${excerpt.path}-${String(index)}`} className="ck-stack" style={{ gap: 4 }}>
    <div className="ck-mono">{excerpt.path}{excerpt.startLine === undefined ? "" : `:${String(excerpt.startLine)}`} <span className="ck-faint">— {excerpt.reason}</span></div>
    {excerpt.lines === undefined
      ? <p className="ck-muted">Source not shown: {excerpt.withheld ?? "unavailable"}.</p>
      // Repository text is rendered as text nodes only; it is never interpreted as markup.
      : <pre className="ck-code" aria-label={`Source of ${excerpt.path}`}>{excerpt.lines.map((line) => <div key={line.number} className={line.number >= (excerpt.startLine ?? 0) && line.number <= (excerpt.endLine ?? excerpt.startLine ?? 0) ? "hit" : ""}><span>{line.number}</span><span>{line.text}</span></div>)}</pre>}
  </div>)}</>;
}

function FindingDetailPanel({ project, finding, report, related, onChanged, onOpen, onProposal, onClose, panelRef }: {
  readonly project: ProjectView;
  readonly finding: FindingView;
  readonly report: AuditReport | null;
  readonly related: readonly FindingView[];
  readonly onChanged: () => void;
  readonly onOpen: (id: string) => void;
  readonly onProposal: (id: string) => void;
  readonly onClose: () => void;
  readonly panelRef: RefObject<HTMLElement | null>;
}) {
  const [detail, setDetail] = useState<FindingDetailView>();
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setDetail(undefined); setError(""); setNote(""); setReason("");
    cockpitApi.finding(project.id, finding.id).then((value) => { if (current) setDetail(value); }).catch((failure: unknown) => { if (current) setError(message(failure, "Could not load this finding.")); });
    return () => { current = false; };
  }, [project.id, finding.id, finding.disposition.classifiedAt, finding.proposals.length]);

  const ai = originOf(finding) === "ai-hypothesis";
  const hypothesis = finding.hypothesis;
  const review = reviewOf(finding);
  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError("");
    try { await action(); onChanged(); } catch (failure) { setError(message(failure, "The action failed.")); } finally { setBusy(false); }
  };
  const classify = (classification: FindingDisposition) => act(() => cockpitApi.classify(project.id, finding.id, classification, note).then(() => setNote("")));
  const regions = (report?.semantic?.coverage.regions ?? []).filter((region) => region.path === finding.location.path);
  const approved = (detail?.proposals ?? []).find((proposal) => proposal.status === "approved" || proposal.status === "ready-for-publication");
  const liveProposal = finding.proposals.find((proposal) => proposal.status !== "rejected");

  return <aside className="ck-detail" aria-label="Finding detail" ref={panelRef}>
    <section>
      <div className="ck-row"><OriginBadge origin={originOf(finding)} /><SeverityBadge severity={finding.severity} modelAssigned={ai} />{ai ? <ReviewBadge status={review} /> : null}<Badge className="plain">{LIFECYCLE_LABEL[finding.state]}</Badge><CloseDetail onClose={onClose} /></div>
      <h2>{finding.title}</h2>
      <div className="ck-mono">{locationOf(finding)}{finding.location.symbol === undefined ? "" : ` · ${finding.location.symbol}`} <span className="ck-faint">· {finding.ruleId} · {shortId(finding.id)}</span></div>
    </section>

    <section aria-label="What is established">
      <h3>What is established</h3>
      <ul className="ck-ladder">
        <li><span>Static rule match</span><span>{ai ? "No. No rule matched this code." : `Yes, rule ${finding.ruleId}.`}</span></li>
        <li><span>AI hypothesis</span><span>{ai ? `Yes, proposed by ${hypothesis?.modelId ?? "a model"} via ${hypothesis?.providerId ?? "its provider"}.` : "No."}</span></li>
        <li><span>Model support</span><span>{!ai ? "Not applicable." : review === "model-supported" ? "Yes. A model reading agreed; this is not confirmation." : "No."}</span></li>
        <li><span>Model contradiction</span><span>{!ai ? "Not applicable." : review === "model-disputed" ? "Yes. A model reading rejected it; see contradictory evidence." : "None recorded."}</span></li>
        <li><span>Reproduced defect</span><span>No. Nothing was executed, so the behavior was never observed.</span></li>
        <li><span>Human confirmation</span><span>{DISPOSITION_LABEL[finding.disposition.classification]}{finding.disposition.classifiedAt === undefined ? "" : ` · ${when(finding.disposition.classifiedAt)}`}</span></li>
        <li><span>Human issue approval</span><span>{approved === undefined ? "None. Confirming a finding does not approve an issue." : `Proposal ${shortId(approved.id)} approved at revision ${approved.approval?.revision.slice(0, 12) ?? ""}.`}</span></li>
      </ul>
    </section>

    <section aria-label={ai ? "Hypothesis" : "Rule finding"}>
      <h3>{ai ? "Hypothesis" : "What the rule reports"}</h3>
      {ai && hypothesis !== undefined
        ? <dl className="ck-kv"><dt>Trigger</dt><dd>{hypothesis.trigger}</dd><dt>Consequence</dt><dd>{hypothesis.consequence}</dd><dt>Model&apos;s suggestion</dt><dd>{finding.remediation}</dd><dt>Model&apos;s confidence</dt><dd>{hypothesis.confidence} — the model&apos;s own word, not a probability</dd></dl>
        : <><p>{finding.explanation}</p><p className="ck-muted">{finding.remediation}</p></>}
    </section>

    {ai && hypothesis !== undefined ? <>
      <section aria-label="Verification">
        <h3>Verification</h3>
        <div className="ck-row"><ReviewBadge status={review} /><span className="ck-muted">{REVIEW_MEANING[review]}</span></div>
        <dl className="ck-kv">
          <dt>Discovery model</dt><dd className="ck-mono">{hypothesis.providerId} / {hypothesis.modelId}</dd>
          <dt>Verifier</dt><dd>{hypothesis.review.verifier === undefined ? (review === "not-reviewed" ? "None was run." : "The reasoning roles (deep pipeline).") : <><span className="ck-mono">{hypothesis.review.verifier.providerId} / {hypothesis.review.verifier.modelId}</span> — {!hypothesis.review.verifier.independent ? "the same model as discovery: a second reading, not an independent check" : hypothesis.review.verifier.sameModelFamily ? "a different model of the same family as discovery (judged from the model names)" : "a different model family from discovery (judged from the model names)"}</>}</dd>
          <dt>Verification calls</dt><dd>{hypothesis.review.modelCalls === 0 && review !== "not-reviewed" ? "0 in the last audit (result reused from cache)" : hypothesis.review.modelCalls}</dd>
          {hypothesis.review.detail === undefined ? null : <><dt>Outcome</dt><dd>{hypothesis.review.detail}</dd></>}
        </dl>
      </section>
      <section aria-label="Supporting evidence">
        <h3>Supporting evidence</h3>
        <ul className="ck-list">
          <li>The quoted line exists at <span className="ck-mono">{locationOf(finding)}</span>. This is the only deterministic check; it shows the hypothesis points at real code, not that it is right.</li>
          {hypothesis.reachability === "call-site-cited" && hypothesis.reachedBy !== undefined ? <li>A call site exists at <span className="ck-mono">{hypothesis.reachedBy.path}:{hypothesis.reachedBy.line}</span>. That it passes the triggering value was not established.</li> : null}
          {review === "model-supported" && hypothesis.review.explanation !== undefined ? <li>Verifier&apos;s reasoning (model text): {hypothesis.review.explanation}</li> : null}
        </ul>
      </section>
      <section aria-label="Contradictory evidence">
        <h3>Contradictory evidence</h3>
        {review === "model-disputed"
          ? <div className="ck-note warn"><strong>The verifier rejected this hypothesis.</strong> {hypothesis.review.explanation ?? "It recorded no reasoning."}<p className="ck-faint" style={{ marginTop: 6 }}>Model text. A rejection is a judgement that can differ between runs; it does not show the code is correct.</p></div>
          : review === "inconclusive" && hypothesis.review.explanation !== undefined ? <p className="ck-muted">The verifier could not decide (model text): {hypothesis.review.explanation}</p>
          : <p className="ck-muted">None recorded. That is an absence of recorded contradiction, not evidence of correctness.</p>}
      </section>
      <section aria-label="Unverified assumptions">
        <h3>Unverified assumptions</h3>
        <ul className="ck-list">
          {hypothesis.reachability === "unproven" ? <li>The trigger needs input outside the function&apos;s evident domain and no caller passing it was found in the code the model was shown. Reachability is unproven. It was not shown to be unreachable.</li> : null}
          {finding.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
        </ul>
      </section>
      <section aria-label="Investigation coverage">
        <h3>Investigation coverage</h3>
        {regions.length === 0 ? <p className="ck-muted">The last saved audit has no semantic coverage record for this file.</p> : <ul className="ck-list">{regions.map((region) => <li key={`${String(region.startLine)}-${String(region.endLine)}`}><span className="ck-mono">lines {region.startLine}–{region.endLine}</span>: {REGION_TEXT[region.state]}</li>)}</ul>}
        <p className="ck-muted">The model saw this region and the code the index links to it, not the whole repository.</p>
      </section>
    </> : <section aria-label="Known limitations"><h3>Known limitations</h3><ul className="ck-list">{finding.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></section>}

    <section aria-label="Source references">
      <h3>Source references</h3>
      {detail === undefined ? <p className="ck-muted">{error === "" ? "Loading source…" : "Source unavailable."}</p> : <Excerpts detail={detail} />}
    </section>

    <section aria-label="Provenance">
      <h3>Provenance</h3>
      <dl className="ck-kv">
        <dt>First seen</dt><dd>{when(finding.firstSeen.at)} · <span className="ck-mono">{finding.firstSeen.snapshot.replace("snapshot_", "").slice(0, 12)}</span></dd>
        <dt>Last seen</dt><dd>{when(finding.lastSeen.at)} · <span className="ck-mono">{finding.lastSeen.snapshot.replace("snapshot_", "").slice(0, 12)}</span> · observed in {finding.timesSeen} audit(s)</dd>
        <dt>Lifecycle</dt><dd>{LIFECYCLE_LABEL[finding.state]}{finding.notEvaluatedReason === undefined ? "" : ` — ${finding.notEvaluatedReason}`}</dd>
        {finding.baselined ? <><dt>Baseline</dt><dd>Listed in the repository baseline.</dd></> : null}
        {finding.applicability === undefined ? null : <><dt>Declared</dt><dd>{finding.applicability.role}: {finding.applicability.reason}</dd></>}
      </dl>
    </section>

    {related.length === 0 ? null : <section aria-label="Related findings"><h3>Related findings</h3><p className="ck-muted">In the same file. Shared location is the only relation asserted.</p><ul className="ck-list">{related.map((item) => <li key={item.id}><button type="button" className="ck-btn ghost" onClick={() => onOpen(item.id)}>{item.title}</button> <span className="ck-mono ck-faint">{locationOf(item)}</span></li>)}</ul></section>}

    <section aria-label="Classification history">
      <h3>Human classification history</h3>
      {detail === undefined || detail.feedback.length === 0 ? <p className="ck-muted">No person has classified this finding.</p> : <ul className="ck-list">{detail.feedback.map((record) => <li key={record.id}><strong>{DISPOSITION_LABEL[record.classification]}</strong> · {when(record.createdAt)}{record.actor?.name === undefined ? "" : ` · ${record.actor.name}`}{record.note === "" ? "" : ` — ${record.note}`}</li>)}</ul>}
    </section>

    <section aria-label="Classify finding">
      <h3>Your classification</h3>
      <Field label="Note (required for false positive and accepted risk)"><textarea className="ck-textarea" rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
      <div className="ck-row">
        <button type="button" className="ck-btn" disabled={busy} onClick={() => void classify("confirmed")}>Confirm</button>
        <button type="button" className="ck-btn" disabled={busy || note.trim() === ""} onClick={() => void classify("false-positive")}>Mark false positive</button>
        <button type="button" className="ck-btn" disabled={busy || note.trim() === ""} onClick={() => void classify("accepted-risk")}>Accept risk</button>
        <button type="button" className="ck-btn" disabled={busy} onClick={() => void classify("needs-investigation")}>Needs investigation</button>
        {finding.disposition.classification === "unreviewed" ? null : <button type="button" className="ck-btn ghost" disabled={busy} onClick={() => void classify("unreviewed")}>Clear classification</button>}
      </div>
      <p className="ck-faint">A classification records your judgement. It runs nothing, changes no evidence and approves no issue. &ldquo;Needs investigation&rdquo; is a label for people; it does not start an investigation.</p>
    </section>

    <section aria-label="Issue proposal">
      <h3>Issue proposal</h3>
      {liveProposal !== undefined
        ? <div className="ck-row"><Badge className="plain">{PROPOSAL_LABEL[liveProposal.status]}</Badge><button type="button" className="ck-btn" onClick={() => onProposal(liveProposal.id)}>Open proposal {shortId(liveProposal.id)}</button></div>
        : !finding.issueEligibility.eligible ? <p className="ck-muted">No proposal can be drafted: {finding.issueEligibility.reason}.</p>
        : <>
            {finding.proposals.some((proposal) => proposal.status === "rejected") ? <Field label="Reason for proposing again (an earlier proposal was rejected)"><input className="ck-input" value={reason} onChange={(event) => setReason(event.target.value)} /></Field> : null}
            <div className="ck-row"><button type="button" className="ck-btn primary" disabled={busy} onClick={() => void act(() => cockpitApi.propose(project.id, finding.id, reason).then((created) => onProposal(created.proposal.id)))}>Create issue proposal</button><span className="ck-faint">Drafts locally. Nothing is published.</span></div>
          </>}
    </section>
    <ErrorNote message={error} />
  </aside>;
}

export function FindingsInbox({ project, findings, report, selectedId, onSelect, onChanged, onProposal }: {
  readonly project: ProjectView;
  readonly findings: readonly FindingView[];
  readonly report: AuditReport | null;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
  readonly onChanged: () => void;
  readonly onProposal: (id: string) => void;
}) {
  const [origin, setOrigin] = useState<OriginFilter>("all");
  const [review, setReview] = useState<HypothesisReviewStatus | "all">("all");
  const [state, setState] = useState<FindingLifecycleState | "open" | "all">("open");
  const [disposition, setDisposition] = useState<FindingDisposition | "all">("all");
  const [severity, setSeverity] = useState<"high" | "medium" | "low" | "all">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("priority");

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return findings.filter((finding) =>
      (origin === "all" || originOf(finding) === origin) &&
      (review === "all" || (originOf(finding) === "ai-hypothesis" && reviewOf(finding) === review)) &&
      (state === "all" || (state === "open" ? finding.state !== "resolved" : finding.state === state)) &&
      (disposition === "all" || finding.disposition.classification === disposition) &&
      (severity === "all" || finding.severity === severity) &&
      (needle === "" || `${finding.title} ${finding.location.path} ${finding.location.symbol ?? ""} ${finding.ruleId} ${finding.explanation}`.toLowerCase().includes(needle)))
      .sort(SORTS[sort]);
  }, [findings, origin, review, state, disposition, severity, search, sort]);
  const selected = findings.find((finding) => finding.id === selectedId);
  const table = useRef<HTMLTableElement>(null);
  const panel = useRevealWhenStacked(selected?.id);
  const close = (): void => { const id = selected?.id; onSelect(undefined); if (id !== undefined) requestAnimationFrame(() => focusRow(table.current, id)); };
  const counts = { rules: findings.filter((finding) => originOf(finding) === "deterministic-rule").length, ai: findings.filter((finding) => originOf(finding) === "ai-hypothesis").length };

  if (findings.length === 0) return <div className="ck"><header className="ck-head"><div><h1>Findings inbox</h1><p>Rule findings and model hypotheses recorded by audits of this repository.</p></div></header><EmptyState title="No findings recorded"><p>Either no audit has run, or the audits that ran matched nothing. An empty inbox is not evidence that the code is correct.</p></EmptyState></div>;

  return <div className="ck">
    <header className="ck-head"><div><h1>Findings inbox</h1><p>{counts.rules} static finding(s) from deterministic rules and {counts.ai} AI hypothesis(es) proposed by a model. A hypothesis is a lead to check, never a verified defect.</p></div><span className="ck-mono ck-faint" role="status">{visible.length} of {findings.length} shown</span></header>
    <div className="ck-filters" role="search" aria-label="Filter findings">
      <Field label="Search"><input className="ck-input" type="search" placeholder="Title, path, symbol, rule" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
      <Field label="Origin"><select className="ck-select" value={origin} onChange={(event) => setOrigin(event.target.value as OriginFilter)}><option value="all">All origins</option><option value="deterministic-rule">Static finding</option><option value="ai-hypothesis">AI hypothesis</option></select></Field>
      <Field label="Verification"><select className="ck-select" value={review} onChange={(event) => setReview(event.target.value as HypothesisReviewStatus | "all")}><option value="all">Any</option>{(Object.keys(REVIEW_LABEL) as HypothesisReviewStatus[]).map((status) => <option key={status} value={status}>{REVIEW_LABEL[status]}</option>)}</select></Field>
      <Field label="Lifecycle"><select className="ck-select" value={state} onChange={(event) => setState(event.target.value as FindingLifecycleState | "open" | "all")}><option value="open">Open (not resolved)</option><option value="all">All</option>{FINDING_LIFECYCLE_STATES.map((item) => <option key={item} value={item}>{LIFECYCLE_LABEL[item]}</option>)}</select></Field>
      <Field label="Classification"><select className="ck-select" value={disposition} onChange={(event) => setDisposition(event.target.value as FindingDisposition | "all")}><option value="all">Any</option>{FINDING_DISPOSITIONS.map((item) => <option key={item} value={item}>{DISPOSITION_LABEL[item]}</option>)}</select></Field>
      <Field label="Sort"><select className="ck-select" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}><option value="priority">Needs attention first</option><option value="severity">Severity</option><option value="location">Location</option><option value="last-seen">Last seen</option></select></Field>
    </div>
    <div className="ck-row" style={{ marginBottom: 12 }} role="group" aria-label="Severity">{(["all", "high", "medium", "low"] as const).map((item) => <button type="button" key={item} className={`ck-btn ${severity === item ? "" : "ghost"}`} aria-pressed={severity === item} onClick={() => setSeverity(item)}>{item === "all" ? "Any severity" : item}</button>)}</div>
    <div className={selected === undefined ? "" : "ck-split"}>
      <div className="ck-table-wrap">
        <table className={`ck-table ${selected === undefined ? "" : "compact"}`} aria-label="Findings" ref={table}>
          <thead><tr><th scope="col">Origin</th><th scope="col">Finding</th><th scope="col">Location</th><th scope="col" className="extra">Severity</th><th scope="col">Verification</th><th scope="col" className="extra">Lifecycle</th><th scope="col" className="extra">Classification</th></tr></thead>
          <tbody>{visible.map((finding) => {
            const ai = originOf(finding) === "ai-hypothesis";
            return <tr key={finding.id} className="selectable" aria-current={finding.id === selectedId ? "true" : undefined} onClick={() => onSelect(finding.id)}>
              <td><OriginBadge origin={originOf(finding)} /></td>
              <td className="title"><button type="button" className="row-link" data-row={finding.id} onClick={(event) => { event.stopPropagation(); onSelect(finding.id); }}>{finding.title}</button></td>
              <td className="ck-mono">{locationOf(finding)}</td>
              <td className="extra"><SeverityBadge severity={finding.severity} modelAssigned={ai} /></td>
              <td>{ai ? <ReviewBadge status={reviewOf(finding)} /> : <span className="ck-faint">rule match</span>}</td>
              <td className="extra">{LIFECYCLE_LABEL[finding.state]}</td>
              <td className="extra">{DISPOSITION_LABEL[finding.disposition.classification]}</td>
            </tr>;
          })}{visible.length === 0 ? <tr><td colSpan={7} className="ck-muted">No finding matches these filters.</td></tr> : null}</tbody>
        </table>
      </div>
      {selected === undefined ? null : <FindingDetailPanel project={project} finding={selected} report={report} related={findings.filter((item) => item.id !== selected.id && item.location.path === selected.location.path).slice(0, 6)} onChanged={onChanged} onOpen={onSelect} onProposal={onProposal} onClose={close} panelRef={panel} />}
    </div>
  </div>;
}
