import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { AuditReport } from "../../../src/domain/audit.js";
import type { LedgerRun } from "../../../src/domain/finding-ledger.js";
import type { AuditJobView, AuditMode, AuditPreflightView, ProjectView } from "../../../src/web/contracts.js";
import { cockpitApi, type AuditOptions } from "./api.js";
import { BudgetUse } from "./overview.js";
import { Badge, Card, duration, ErrorNote, Field, message, when } from "./ui.js";

const MODES: readonly { readonly id: AuditMode; readonly name: string; readonly summary: string }[] = [
  { id: "static", name: "Static", summary: "Deterministic rules only. No model is called and nothing leaves this machine." },
  { id: "smart", name: "Smart", summary: "Rules, then a model reads bounded regions and one verifier checks each hypothesis." },
  { id: "deep", name: "Deep", summary: "Rules, then discovery and the five reasoning roles on each hypothesis. Several times the calls of Smart." },
];
const POLL_MS = 1_500;

function Disclosure({ preflight }: { readonly preflight: AuditPreflightView }) {
  const disclosure = preflight.disclosure;
  if (disclosure === undefined) return null;
  const external = disclosure.privacyBoundary === "external";
  return <div className={`ck-note ${external ? "warn" : ""}`} role="region" aria-label="What this audit will send and call">
    <strong>{external ? `A remote provider${disclosure.providerHost === undefined ? "" : ` (${disclosure.providerHost})`} will receive sanitized repository code.` : "A local model will be called. Source stays on this machine."}</strong>
    <ul className="ck-list" style={{ marginTop: 8 }}>
      <li>Discovery: <span className="ck-mono">{disclosure.discovery.providerId} / {disclosure.discovery.modelId}</span></li>
      {disclosure.verifier === undefined
        ? <li>Challenge roles: <span className="ck-mono">{disclosure.challengeRoles.join(", ")}</span></li>
        : <li>Verifier: <span className="ck-mono">{disclosure.verifier.providerId} / {disclosure.verifier.modelId}</span> — {!disclosure.verifier.independent ? "the same model as discovery, so verification is a second reading and not an independent check" : disclosure.verifier.sameModelFamily ? "a different model of the same family as discovery" : "a different model family from discovery"}</li>}
      <li>Budget: up to {disclosure.budget.maxModelCalls} calls, {disclosure.budget.maxRegions} regions, {disclosure.budget.maxInvestigations} verified hypotheses, {duration(disclosure.budget.maxDurationMs)}.</li>
      {external ? <li>Recognized credential formats are redacted before sending. Sanitization is pattern-based and is not guaranteed to catch every secret.</li> : null}
      {external ? <li>The provider may charge for these calls. Conclave holds no price list and cannot tell you the cost in advance.</li> : null}
      <li>{preflight.cachedRegions === 0 ? "No region is cached yet: every region read costs a call." : `${String(preflight.cachedRegions)} region result(s) are cached. Unchanged regions read with the same model cost no call.`}</li>
    </ul>
  </div>;
}

function Coverage({ report }: { readonly report: AuditReport }) {
  const semantic = report.semantic;
  const accounting = report.coverage.accounting;
  return <div className="ck-two">
    <Card title="Deterministic coverage" aside={report.coverage.status === "partial" ? "partial" : "supported source analyzed"}>
      <dl className="ck-kv"><dt>Files analyzed</dt><dd>{accounting.filesAnalyzed} of {accounting.eligibleSourceFiles} eligible source files ({accounting.filesDiscovered} discovered)</dd><dt>Not analyzed</dt><dd>{accounting.filesNotAnalyzed.ignored} ignored · {accounting.filesNotAnalyzed.safetyExcluded} withheld for safety · {accounting.filesNotAnalyzed.unsupported} unsupported type · {accounting.filesNotAnalyzed.parserFailure} parser failure · {accounting.filesNotAnalyzed.unexamined} unreadable</dd><dt>Rules</dt><dd>{report.metrics.rulesExecuted} executed, {report.metrics.rulesSkipped} skipped</dd></dl>
    </Card>
    <Card title="AI coverage" aside={semantic === undefined ? "not run" : semantic.coverage.complete ? "all eligible regions read" : "incomplete"}>
      {semantic === undefined ? <p className="ck-muted">The last audit was static. No region was read by a model.</p> : <dl className="ck-kv">
        <dt>Pipeline</dt><dd>{semantic.pipeline} · discovery <span className="ck-mono">{semantic.discovery.modelId}</span>{semantic.verifier === undefined ? "" : <> · verifier <span className="ck-mono">{semantic.verifier.modelId}</span></>}</dd>
        <dt>Lines read</dt><dd>{semantic.coverage.linesExamined.toLocaleString()} of {semantic.coverage.eligibleLines.toLocaleString()} eligible</dd>
        <dt>Regions</dt><dd>{semantic.coverage.regionsByState.examined} read now · {semantic.coverage.regionsByState["examined-cached"]} reused from cache · {semantic.coverage.regionsByState["not-examined-budget"]} not reached · {semantic.coverage.regionsByState["not-examined-failed"]} failed · {semantic.coverage.regionsByState["not-examined-withheld"]} withheld</dd>
        <dt>Hypotheses</dt><dd>{semantic.hypotheses.proposed} proposed · {semantic.hypotheses.recorded} recorded · {semantic.hypotheses.ungrounded} dropped (quoted line not in file) · {semantic.hypotheses.verificationFailed} verification failure(s), kept as inconclusive</dd>
        {semantic.stoppedBy === undefined ? null : <><dt>Stopped by</dt><dd>The {semantic.stoppedBy} budget. Run the same audit again to continue with the regions it did not reach.</dd></>}
      </dl>}
    </Card>
  </div>;
}

export function AuditControls({ project, report, runs, onFinished }: { readonly project: ProjectView; readonly report: AuditReport | null; readonly runs: readonly LedgerRun[]; readonly onFinished: () => void }) {
  const [mode, setMode] = useState<AuditMode>("static");
  const [calls, setCalls] = useState("");
  const [regions, setRegions] = useState("");
  const [investigations, setInvestigations] = useState("");
  const [minutes, setMinutes] = useState("");
  const [discoveryModel, setDiscoveryModel] = useState("");
  const [verifierModel, setVerifierModel] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [preflight, setPreflight] = useState<AuditPreflightView>();
  const [job, setJob] = useState<AuditJobView | null>(null);
  const [error, setError] = useState("");
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const budget: { maxModelCalls?: number; maxRegions?: number; maxInvestigations?: number; maxDurationMs?: number } = {};
  const whole = (value: string, assign: (parsed: number) => void): void => { if (/^\d+$/u.test(value.trim())) assign(Number(value)); };
  whole(calls, (value) => { budget.maxModelCalls = value; });
  whole(regions, (value) => { budget.maxRegions = value; });
  whole(investigations, (value) => { budget.maxInvestigations = value; });
  whole(minutes, (value) => { budget.maxDurationMs = value * 60_000; });
  const options: AuditOptions = {
    budget,
    ...(discoveryModel.trim() === "" ? {} : { discoveryModel: discoveryModel.trim() }),
    ...(verifierModel.trim() === "" || mode !== "smart" ? {} : { verifierModel: verifierModel.trim() }),
  };
  const optionsKey = JSON.stringify(options);

  // What the audit would call is re-read whenever the choice changes, and consent is withdrawn with it.
  useEffect(() => {
    let current = true;
    setAcknowledged(false); setPreflight(undefined);
    cockpitApi.auditPreflight(project.id, mode, options).then((value) => { if (current) { setPreflight(value); setError(""); } }).catch((failure: unknown) => { if (current) setError(message(failure, "Could not read the audit configuration.")); });
    return () => { current = false; };
    // `optionsKey` stands for `options`, which is rebuilt on every render.
  }, [project.id, mode, optionsKey]);

  useEffect(() => { void cockpitApi.auditStatus(project.id).then(setJob).catch(() => undefined); }, [project.id]);
  const running = job?.state === "running";
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => {
      void cockpitApi.auditStatus(project.id).then((next) => { setJob(next); if (next !== null && next.state !== "running") finished.current(); }).catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [project.id, running]);

  const semantic = mode !== "static";
  const start = async (): Promise<void> => {
    setError("");
    try { setJob(await cockpitApi.startAudit(project.id, mode, options, semantic && acknowledged)); setAcknowledged(false); } catch (failure) { setError(message(failure, "Could not start the audit.")); }
  };

  // A radio group is one tab stop; the arrow keys move the choice, as they do for native radios.
  const chooseWithArrows = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = MODES[(MODES.findIndex((item) => item.id === mode) + step + MODES.length) % MODES.length];
    if (next === undefined) return;
    setMode(next.id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next.id}"]`)?.focus();
  };

  return <div className="ck">
    <header className="ck-head"><div><h1>Repository audits</h1><p>An audit examines the repository as it is on disk and records what it finds in the local ledger. It executes no repository code and publishes nothing.</p></div></header>
    <div className="ck-stack">
      <Card title="Run an audit">
        <div className="ck-stack">
          <div className="ck-modes" role="radiogroup" aria-label="Audit mode" onKeyDown={chooseWithArrows}>{MODES.map((item) => <button type="button" key={item.id} role="radio" aria-checked={mode === item.id} tabIndex={mode === item.id ? 0 : -1} data-mode={item.id} className="ck-mode" onClick={() => setMode(item.id)}><strong>{item.name}</strong><span>{item.summary}</span></button>)}</div>
          {semantic ? <>
            <div className="ck-grid">
              <Field label="Max model calls (default 40)"><input className="ck-input" inputMode="numeric" value={calls} onChange={(event) => setCalls(event.target.value)} /></Field>
              <Field label="Max regions read (default 30)"><input className="ck-input" inputMode="numeric" value={regions} onChange={(event) => setRegions(event.target.value)} /></Field>
              <Field label="Hypotheses verified (default 10)"><input className="ck-input" inputMode="numeric" value={investigations} onChange={(event) => setInvestigations(event.target.value)} /></Field>
              <Field label="Max minutes (default 15)"><input className="ck-input" inputMode="numeric" value={minutes} onChange={(event) => setMinutes(event.target.value)} /></Field>
              <Field label="Discovery model (default: configured)"><input className="ck-input" value={discoveryModel} onChange={(event) => setDiscoveryModel(event.target.value)} autoComplete="off" /></Field>
              {mode === "smart" ? <Field label="Verifier model (default: configured)"><input className="ck-input" value={verifierModel} onChange={(event) => setVerifierModel(event.target.value)} autoComplete="off" /></Field> : null}
            </div>
            {preflight === undefined ? <p className="ck-muted">Reading the provider configuration…</p>
              : !preflight.available ? <div className="ck-note danger" role="alert"><strong>{mode === "smart" ? "Smart" : "Deep"} cannot run as configured.</strong> {preflight.reason} Configure a provider in Settings.</div>
              : <><Disclosure preflight={preflight} /><label className="ck-check"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>I understand that this audit calls a model{preflight.disclosure?.privacyBoundary === "external" ? ", sends it sanitized code from this repository and may be charged by the provider" : " on this machine"}.</span></label></>}
          </> : <p className="ck-muted">Static needs no provider and makes no network request.</p>}
          <div className="ck-row">
            <button type="button" className="ck-btn primary" disabled={running || (semantic && (!acknowledged || preflight?.available !== true))} onClick={() => void start()}>{running ? "Audit running…" : `Start ${MODES.find((item) => item.id === mode)?.name ?? ""} audit`}</button>
            {semantic && !acknowledged && preflight?.available === true ? <span className="ck-faint">Confirm the statement above to enable this.</span> : null}
          </div>
          <ErrorNote message={error} />
        </div>
      </Card>

      {job === null ? null : <Card title="Current run" aside={<Badge tone={job.state === "failed" ? "danger" : job.state === "completed" ? "ok" : "strong"}>{job.state}</Badge>} label="Audit run status">
        <dl className="ck-kv"><dt>Mode</dt><dd>{job.mode}</dd><dt>Started</dt><dd>{when(job.startedAt)}</dd>{job.finishedAt === undefined ? null : <><dt>Finished</dt><dd>{when(job.finishedAt)}</dd></>}</dl>
        {job.error === undefined ? null : <div className="ck-note danger" role="alert" style={{ marginTop: 8 }}><strong>The audit failed.</strong> {job.error}</div>}
        <pre className="ck-log" aria-label="Audit progress" aria-live="polite">{job.progress.join("\n")}</pre>
        <p className="ck-faint" style={{ marginTop: 8 }}>Runs are held in this server&apos;s memory. If the server stops mid-run, nothing from that run is saved and the next audit starts over; region results are cached only when a run finishes, including one that stopped at its budget.</p>
      </Card>}

      {report === null ? null : <><Coverage report={report} />
        <Card title="Model usage and budget of the last audit"><BudgetUse report={report} /></Card>
        <Card title="What the last audit does not establish"><ul className="ck-list">{[...report.coverage.limits, ...(report.semantic?.limits ?? [])].map((limit) => <li key={limit}>{limit}</li>)}</ul></Card>
        {report.semantic === undefined || report.semantic.dismissed.length === 0 ? null : <Card title="Hypotheses proposed and not recorded" aside={`${String(report.semantic.dismissed.length + report.semantic.dismissedOmitted)} total`}><ul className="ck-list">{report.semantic.dismissed.map((item, index) => <li key={`${item.path}-${String(index)}`}><span className="ck-mono">{item.path}{item.line === undefined ? "" : `:${String(item.line)}`}</span> {item.title} — {item.reason}</li>)}</ul></Card>}
      </>}

      <Card title="Audit history" aside={`${String(runs.length)} recorded`}>
        {runs.length === 0 ? <p className="ck-muted">No audit has been recorded for this repository.</p> : <div className="ck-table-wrap"><table className="ck-table" aria-label="Audit history">
          <thead><tr><th scope="col">When</th><th scope="col">Snapshot</th><th scope="col">Rule coverage</th><th scope="col" className="num">Files</th><th scope="col" className="num">Observed</th><th scope="col" className="num">New</th><th scope="col" className="num">Resolved</th><th scope="col" className="num">Not evaluated</th></tr></thead>
          <tbody>{runs.map((run) => <tr key={run.id}><td>{when(run.at)}</td><td className="ck-mono">{run.snapshot.replace("snapshot_", "").slice(0, 12)}</td><td>{run.coverageStatus === "partial" ? "partial" : "supported source"}</td><td className="num">{run.filesAnalyzed}/{run.filesDiscovered}</td><td className="num">{run.findingsObserved}</td><td className="num">{run.byState.new}</td><td className="num">{run.byState.resolved}</td><td className="num">{run.byState["not-evaluated"]}</td></tr>)}</tbody>
        </table></div>}
      </Card>
    </div>
  </div>;
}
