import { useEffect, useState } from "react";

import type { ProjectView } from "../../src/web/contracts.js";
import type { CommitAnalysis, CommitTimeline } from "../../src/workflow/commit-timeline.js";
import { api } from "./api.js";

const LIST_LIMIT = 25;

function analysisBadge(analysis: CommitAnalysis | undefined) {
  if (analysis === undefined) return null;
  if (analysis.status === "analyzed") return <span className={`decision-badge ${analysis.verdict}`}>{analysis.verdict}</span>;
  return <span className="decision-badge inconclusive">{analysis.status === "skipped" ? "root commit" : "not analyzed"}</span>;
}

function analysisDetail(analysis: CommitAnalysis | undefined) {
  if (analysis === undefined) return null;
  if (analysis.status === "failed") return <p>{analysis.reason}</p>;
  if (analysis.status === "skipped") return <p>A root commit has no parent to compare against.</p>;
  const { blocking, warning, info } = analysis.findings;
  return <>
    <p>{String(blocking)} blocking, {String(warning)} warning, {String(info)} info · {String(analysis.filesChanged)} files and {String(analysis.symbolsChanged)} code units changed, {String(analysis.impactedFiles)} files affected</p>
    {analysis.topFindings.length > 0 && <ul>{analysis.topFindings.map((finding, index) => <li key={`${finding.kind}-${String(index)}`}><strong>{finding.severity}</strong> {finding.title}</li>)}</ul>}
  </>;
}

/** Recent commits of the open repository. Reviewing them is opt-in because each commit is indexed in full. */
export function CommitTimelinePanel({ project }: { readonly project: ProjectView | undefined }) {
  const [timeline, setTimeline] = useState<CommitTimeline>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const projectId = project?.id;
  const local = project?.source === "local";

  const load = (analyze: boolean): void => {
    if (projectId === undefined) return;
    setBusy(true);
    setError("");
    // The analyzed list is capped lower than the plain one, because every commit is indexed.
    void api.commits(projectId, { limit: analyze ? 10 : LIST_LIMIT, analyze })
      .then(setTimeline)
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not list the commits."))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    setTimeline(undefined);
    setError("");
    if (projectId !== undefined && local) load(false);
    // `load` only closes over the project id, which is the dependency.
  }, [projectId, local]);

  if (project !== undefined && !local) {
    return <section className="empty"><h2>No commits to show</h2><p>The demo repository has no Git history. Open a local repository to see its commits.</p></section>;
  }
  return <section className="history-panel commit-timeline" aria-label="Commit timeline">
    <header>
      <h2>Commits</h2>
      <p>Newest first. Reviewing a commit compares it with its first parent, with its subject as the objective. Local and deterministic; no model is called.</p>
      <button type="button" onClick={() => load(true)} disabled={busy || projectId === undefined}>{busy ? "Working…" : "Review the latest 10 commits"}</button>
    </header>
    {error !== "" && <p role="alert">{error}</p>}
    {timeline?.commits.length === 0 && <p>No commits in this repository yet.</p>}
    {timeline?.commits.map((commit) => <article key={commit.sha}>
      {analysisBadge(commit.analysis) ?? <span className="decision-badge inconclusive">{commit.isMerge ? "merge" : "commit"}</span>}
      <div>
        <strong>{commit.subject}</strong>
        <p>{commit.shortSha} · {commit.author}{commit.stats === undefined ? "" : ` · ${String(commit.stats.filesChanged)} files +${String(commit.stats.additions)} −${String(commit.stats.deletions)}`}</p>
        {analysisDetail(commit.analysis)}
        <small>{new Date(commit.authoredAt).toLocaleString()}</small>
      </div>
    </article>)}
    {timeline?.truncated === true && <p>More commits exist; the list shows the latest {String(timeline.range.limit)}.</p>}
  </section>;
}
