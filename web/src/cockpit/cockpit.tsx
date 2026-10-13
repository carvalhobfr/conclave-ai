import { useCallback, useEffect, useState } from "react";

import type { ProjectView } from "../../../src/web/contracts.js";
import { cockpitApi } from "./api.js";
import { Architecture } from "./architecture.js";
import { AuditControls } from "./audits.js";
import "./cockpit.css";
import { FindingsInbox } from "./findings.js";
import { Overview, type CockpitData, type CockpitSection } from "./overview.js";
import { ProposalsReview } from "./proposals.js";
import { EmptyState, ErrorNote, message } from "./ui.js";

const EMPTY: CockpitData = { report: null, findings: [], proposals: [], runs: [] };

/** Counts for the navigation, from the same data the screens show. */
export interface CockpitCounts {
  readonly findings: number;
  readonly proposals: number;
}

export function Cockpit({ project, section, onNavigate, onCounts }: { readonly project: ProjectView | undefined; readonly section: CockpitSection; readonly onNavigate: (section: CockpitSection) => void; readonly onCounts?: (counts: CockpitCounts) => void }) {
  const [data, setData] = useState<CockpitData>(EMPTY);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [finding, setFinding] = useState<string>();
  const [proposal, setProposal] = useState<string>();
  const local = project?.source === "local";
  const projectId = project?.id;

  const reload = useCallback(async (): Promise<void> => {
    if (projectId === undefined || !local) return;
    try {
      const [report, findings, proposals, runs] = await Promise.all([cockpitApi.latestAudit(projectId), cockpitApi.findings(projectId), cockpitApi.proposals(projectId), cockpitApi.auditRuns(projectId)]);
      setData({ report, findings, proposals, runs });
      setError("");
    } catch (failure) {
      setError(message(failure, "Could not load repository data."));
    } finally {
      setLoaded(true);
    }
  }, [projectId, local]);
  useEffect(() => { setData(EMPTY); setLoaded(false); setFinding(undefined); setProposal(undefined); void reload(); }, [reload]);
  useEffect(() => {
    onCounts?.({
      findings: data.findings.filter((item) => item.state !== "resolved" && item.disposition.classification === "unreviewed").length,
      proposals: data.proposals.filter((item) => item.status === "draft" || item.status === "pending-review" || item.status === "stale").length,
    });
  }, [data, onCounts]);

  if (project === undefined) return <div className="ck"><p className="ck-muted">Opening repository…</p></div>;
  if (section === "architecture") return <Architecture project={project} />;
  if (!local) return <div className="ck"><EmptyState title="Open a local repository"><p>Audits, findings and issue proposals are kept in a repository&apos;s own <code>.conclave</code> directory. The demo fixture has none. Open a local folder from the sidebar.</p></EmptyState></div>;
  if (!loaded) return <div className="ck"><p className="ck-muted">Loading repository data…</p></div>;
  const openFinding = (id: string): void => { setFinding(id); onNavigate("findings"); };
  const openProposal = (id: string): void => { setProposal(id); void reload(); onNavigate("proposals"); };
  return <>
    {error === "" ? null : <div className="ck" style={{ paddingBottom: 0 }}><ErrorNote message={error} /></div>}
    {section === "overview" ? <Overview project={project} data={data} onNavigate={onNavigate} />
      : section === "audits" ? <AuditControls project={project} report={data.report} runs={data.runs} onFinished={() => void reload()} />
      : section === "findings" ? <FindingsInbox project={project} findings={data.findings} report={data.report} selectedId={finding} onSelect={setFinding} onChanged={() => void reload()} onProposal={openProposal} />
      : <ProposalsReview project={project} proposals={data.proposals} selectedId={proposal} onSelect={setProposal} onChanged={() => void reload()} onFinding={openFinding} />}
  </>;
}
