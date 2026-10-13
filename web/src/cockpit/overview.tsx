import type { AuditReport, HypothesisReviewStatus } from "../../../src/domain/audit.js";
import { FINDING_LIFECYCLE_STATES, type LedgerRun } from "../../../src/domain/finding-ledger.js";
import type { IssueProposal } from "../../../src/domain/issue-proposal.js";
import type { ProjectView } from "../../../src/web/contracts.js";
import type { FindingView } from "../../../src/workflow/triage-service.js";
import { Badge, Card, EmptyState, LIFECYCLE_LABEL, Meter, originOf, percent, REVIEW_LABEL, reviewOf, Stat, duration, when } from "./ui.js";

export interface CockpitData {
  readonly report: AuditReport | null;
  readonly findings: readonly FindingView[];
  readonly proposals: readonly IssueProposal[];
  readonly runs: readonly LedgerRun[];
}

export type CockpitSection = "overview" | "audits" | "findings" | "proposals" | "architecture";

const REVIEW_ORDER: readonly HypothesisReviewStatus[] = ["model-supported", "inconclusive", "model-disputed", "not-reviewed"];

/** What semantic discovery spent against what it was allowed, from the saved report only. */
export function BudgetUse({ report }: { readonly report: AuditReport }) {
  const semantic = report.semantic;
  if (semantic === undefined) return <p className="ck-muted">The last audit was static: no model was called.</p>;
  const { usage, budget } = semantic;
  const rows: readonly (readonly [string, number, number])[] = [
    ["Model calls", usage.modelCalls, budget.maxModelCalls],
    ["Input tokens (approx.)", usage.approximateInputTokens, budget.maxInputTokens],
    ["Output tokens (approx.)", usage.approximateOutputTokens, budget.maxOutputTokens],
  ];
  return <div className="ck-stack">
    {rows.map(([label, used, limit]) => <div key={label}><div className="ck-row" style={{ justifyContent: "space-between" }}><span className="ck-muted">{label}</span><span className="ck-mono">{used.toLocaleString()} / {limit.toLocaleString()}</span></div><Meter part={used} whole={limit} label={`${label} used`} /></div>)}
    <dl className="ck-kv">
      <dt>Duration</dt><dd>{duration(usage.durationMs)} of {duration(budget.maxDurationMs)}</dd>
      <dt>Failed calls</dt><dd>{usage.failedCalls}</dd>
      <dt>Cost</dt><dd>{usage.cost.status === "estimated" ? `About ${usage.cost.amount.toFixed(4)} USD, from the prices you supplied (${usage.cost.basis} tokens)` : usage.cost.status === "local-inference" ? "No per-token charge (local inference). Machine time is not measured." : "Not computed: no price was supplied, and Conclave assumes none."}</dd>
      {semantic.stoppedBy === undefined ? null : <><dt>Stopped by</dt><dd>The {semantic.stoppedBy} budget. Coverage is incomplete.</dd></>}
    </dl>
  </div>;
}

export function Overview({ project, data, onNavigate }: { readonly project: ProjectView; readonly data: CockpitData; readonly onNavigate: (section: CockpitSection) => void }) {
  const { report, findings, proposals } = data;
  if (report === null) {
    return <div className="ck"><header className="ck-head"><div><h1>{project.name}</h1><p>No audit has been recorded for this repository yet.</p></div></header>
      <EmptyState title="Nothing audited yet"><p>The repository is indexed ({project.indexedFiles} files, {project.symbols} symbols) but no rule and no model has examined it.</p><p style={{ marginTop: 12 }}><button type="button" className="ck-btn primary" onClick={() => onNavigate("audits")}>Run the first audit</button></p></EmptyState></div>;
  }
  const active = findings.filter((finding) => finding.state !== "resolved");
  const rules = active.filter((finding) => originOf(finding) === "deterministic-rule");
  const hypotheses = active.filter((finding) => originOf(finding) === "ai-hypothesis");
  const pending = proposals.filter((proposal) => proposal.status === "draft" || proposal.status === "pending-review" || proposal.status === "stale");
  const coverage = report.coverage.accounting;
  const semantic = report.semantic;
  return <div className="ck">
    <header className="ck-head">
      <div><h1>{report.repository.name}</h1><p>Snapshot <span className="ck-mono">{report.snapshot.id.replace("snapshot_", "").slice(0, 12)}</span>{report.snapshot.headCommit === undefined ? " · directory without a Git commit" : <> · working tree at <span className="ck-mono">{report.snapshot.headCommit.slice(0, 12)}</span></>} · last audited {when(report.generatedAt)} <span className="ck-nowrap">in {duration(report.metrics.totalMs + (semantic?.usage.durationMs ?? 0))}</span></p></div>
      <button type="button" className="ck-btn" onClick={() => onNavigate("audits")}>Audit controls</button>
    </header>
    <div className="ck-stack">
      <div className="ck-note">An audit reports what its rules matched and what a model proposed. It never shows that a repository is free of defects, and a region with no finding was not shown to be correct.</div>
      <div className="ck-two">
        <Card title="Deterministic coverage" aside={report.coverage.status === "partial" ? "partial" : "supported source analyzed"}>
          <Stat value={`${String(coverage.filesAnalyzed)} / ${String(coverage.eligibleSourceFiles)}`} label="eligible source files parsed and given to the rules" />
          <Meter part={coverage.filesAnalyzed} whole={coverage.eligibleSourceFiles} label="Source files analyzed by rules" />
          <p className="ck-muted" style={{ marginTop: 8 }}>{report.metrics.rulesExecuted} rules ran on {report.metrics.symbols.toLocaleString()} symbols and {report.metrics.graphEdges.toLocaleString()} relations. {coverage.filesDiscovered - coverage.filesAnalyzed} discovered file(s) were not analyzed.</p>
        </Card>
        <Card title="AI coverage" aside={semantic === undefined ? "not run" : semantic.coverage.complete ? "all eligible regions read" : "partial"}>
          {semantic === undefined
            ? <><Stat value="0" label="lines read by a model" /><p className="ck-muted" style={{ marginTop: 8 }}>The last audit was static. Indexed code has not been inspected by a model.</p></>
            : <><Stat value={`${semantic.coverage.linesExamined.toLocaleString()} / ${semantic.coverage.eligibleLines.toLocaleString()}`} label={`eligible lines read by ${semantic.discovery.modelId} (${percent(semantic.coverage.linesExamined, semantic.coverage.eligibleLines)})`} />
              <Meter part={semantic.coverage.linesExamined} whole={semantic.coverage.eligibleLines} label="Eligible lines read by a model" />
              <p className="ck-muted" style={{ marginTop: 8 }}>{semantic.coverage.filesExamined} of {semantic.coverage.eligibleFiles} files fully read, {semantic.coverage.filesPartiallyExamined} partly, {semantic.coverage.filesNotExamined} not read. A file that was read and produced no hypothesis was not shown to be correct.</p></>}
        </Card>
      </div>
      <div className="ck-two">
        <Card title="Findings by lifecycle" aside={<button type="button" className="ck-btn ghost" onClick={() => onNavigate("findings")}>Open inbox</button>}>
          <div className="ck-grid">{FINDING_LIFECYCLE_STATES.map((state) => <Stat key={state} value={findings.filter((finding) => finding.state === state).length} label={LIFECYCLE_LABEL[state]} />)}</div>
        </Card>
        <Card title="Static findings by severity" aside={`${String(rules.length)} open`}>
          <div className="ck-grid">{(["high", "medium", "low"] as const).map((severity) => <Stat key={severity} value={rules.filter((finding) => finding.severity === severity).length} label={severity} />)}</div>
        </Card>
      </div>
      <div className="ck-two">
        <Card title="AI hypotheses by verification" aside={`${String(hypotheses.length)} open · none reproduced`}>
          <div className="ck-grid">{REVIEW_ORDER.map((status) => <Stat key={status} value={hypotheses.filter((finding) => reviewOf(finding) === status).length} label={REVIEW_LABEL[status]} />)}</div>
          <p className="ck-muted" style={{ marginTop: 12 }}>Model-supported is not confirmed. The accuracy of these hypotheses is experimental and has not been measured on this repository; treat each as a lead to check.</p>
        </Card>
        <Card title="Issue proposals" aside={<button type="button" className="ck-btn ghost" onClick={() => onNavigate("proposals")}>Review</button>}>
          <div className="ck-grid"><Stat value={pending.length} label="waiting on a person" /><Stat value={proposals.filter((proposal) => proposal.status === "approved" || proposal.status === "ready-for-publication").length} label="approved" /></div>
          <p className="ck-muted" style={{ marginTop: 12 }}>Nothing is published from here. Approval is an explicit step on one exact revision.</p>
        </Card>
      </div>
      <Card title="Model usage and budget" aside={semantic === undefined ? undefined : <Badge className="plain">{semantic.pipeline} pipeline · {semantic.privacyBoundary === "external" ? "external provider" : "local provider"}</Badge>}><BudgetUse report={report} /></Card>
    </div>
  </div>;
}
