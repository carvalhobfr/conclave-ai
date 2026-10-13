import { useEffect, useState } from "react";

import type { ArchitectureView, GraphView, ProjectView } from "../../../src/web/contracts.js";
import { cockpitApi } from "./api.js";
import { Card, ErrorNote, Field, message, Stat } from "./ui.js";

async function graph(projectId: string, symbol: string): Promise<GraphView> {
  const response = await fetch(`/api/graph?projectId=${encodeURIComponent(projectId)}&symbol=${encodeURIComponent(symbol)}`);
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error((payload as { error?: { message?: string } }).error?.message ?? "Graph lookup failed.");
  return payload as GraphView;
}

export function Architecture({ project }: { readonly project: ProjectView }) {
  const [view, setView] = useState<ArchitectureView>();
  const [symbol, setSymbol] = useState("");
  const [result, setResult] = useState<GraphView>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setView(undefined); setResult(undefined);
    cockpitApi.architecture(project.id).then((value) => { if (current) setView(value); }).catch((failure: unknown) => { if (current) setError(message(failure, "Could not read the repository structure.")); });
    return () => { current = false; };
  }, [project.id]);
  const explore = (): void => { if (symbol.trim() === "") return; setError(""); void graph(project.id, symbol.trim()).then(setResult).catch((failure: unknown) => setError(message(failure, "Graph lookup failed."))); };

  return <div className="ck">
    <header className="ck-head"><div><h1>Architecture</h1><p>Structure read from the index built when the repository was opened: files, symbols and the relations a parser could resolve. No model is involved, and relations the parser could not resolve are absent.</p></div></header>
    <ErrorNote message={error} />
    {view === undefined ? <p className="ck-muted">Reading structure…</p> : <div className="ck-stack">
      <div className="ck-card"><div className="ck-grid"><Stat value={view.files.toLocaleString()} label="indexed files" /><Stat value={view.symbols.toLocaleString()} label="symbols" /><Stat value={view.relations.toLocaleString()} label="resolved relations" /><Stat value={view.modules.length + view.omitted.modules} label="modules (directories)" /></div></div>
      <div className="ck-two">
        <Card title="Languages"><div className="ck-table-wrap"><table className="ck-table" aria-label="Languages"><thead><tr><th scope="col">Language</th><th scope="col" className="num">Files</th></tr></thead><tbody>{view.languages.map((item) => <tr key={item.language}><td>{item.language}</td><td className="num">{item.files}</td></tr>)}</tbody></table></div></Card>
        <Card title="Not in the index" aside="by reason">{view.notIndexed.length === 0 ? <p className="ck-muted">The index recorded no excluded entry.</p> : <div className="ck-table-wrap"><table className="ck-table" aria-label="Entries not indexed"><thead><tr><th scope="col">Reason</th><th scope="col" className="num">Entries</th></tr></thead><tbody>{view.notIndexed.map((item) => <tr key={item.reason}><td>{item.reason}</td><td className="num">{item.entries}</td></tr>)}</tbody></table></div>}</Card>
      </div>
      <Card title="Modules" aside={view.omitted.modules === 0 ? "most connected first" : `${String(view.omitted.modules)} more not shown`}><div className="ck-table-wrap"><table className="ck-table" aria-label="Modules"><thead><tr><th scope="col">Module</th><th scope="col" className="num">Files</th><th scope="col" className="num">Symbols</th><th scope="col" className="num">Depends on</th><th scope="col" className="num">Used by</th></tr></thead><tbody>{view.modules.map((item) => <tr key={item.name}><td className="ck-mono">{item.name}</td><td className="num">{item.files}</td><td className="num">{item.symbols}</td><td className="num">{item.dependsOn}</td><td className="num">{item.usedBy}</td></tr>)}</tbody></table></div></Card>
      <div className="ck-two">
        <Card title="Dependencies between modules" aside={view.omitted.dependencies === 0 ? undefined : `${String(view.omitted.dependencies)} more not shown`}>{view.dependencies.length === 0 ? <p className="ck-muted">No relation between modules was resolved.</p> : <div className="ck-table-wrap"><table className="ck-table" aria-label="Module dependencies"><thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col" className="num">Relations</th></tr></thead><tbody>{view.dependencies.map((item) => <tr key={`${item.from}>${item.to}`}><td className="ck-mono">{item.from}</td><td className="ck-mono">{item.to}</td><td className="num">{item.relations}</td></tr>)}</tbody></table></div>}</Card>
        <Card title="Most connected files">{view.hubs.length === 0 ? <p className="ck-muted">No relation between files was resolved.</p> : <div className="ck-table-wrap"><table className="ck-table" aria-label="Most connected files"><thead><tr><th scope="col">File</th><th scope="col" className="num">Incoming</th><th scope="col" className="num">Outgoing</th></tr></thead><tbody>{view.hubs.map((item) => <tr key={item.path}><td className="ck-mono">{item.path}</td><td className="num">{item.incoming}</td><td className="num">{item.outgoing}</td></tr>)}</tbody></table></div>}</Card>
      </div>
      <Card title="Symbol explorer">
        <form className="ck-row" onSubmit={(event) => { event.preventDefault(); explore(); }}><div style={{ flex: 1, minWidth: 220 }}><Field label="Symbol name"><input className="ck-input" value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="functionOrClassName" /></Field></div><button type="submit" className="ck-btn" style={{ alignSelf: "flex-end" }}>Explore</button></form>
        {result === undefined ? null : <div className="ck-stack" style={{ marginTop: 12 }}><p className="ck-muted">{result.message ?? `${String(result.nodes.length)} node(s), ${String(result.edges.length)} relation(s), bounded.`}</p>{result.nodes.length === 0 ? null : <div className="ck-table-wrap"><table className="ck-table" aria-label="Symbol graph"><thead><tr><th scope="col">Symbol</th><th scope="col">File</th></tr></thead><tbody>{result.nodes.map((node) => <tr key={node.id}><td>{node.label}</td><td className="ck-mono">{node.path}</td></tr>)}</tbody></table></div>}{result.edges.length === 0 ? null : <ul className="ck-list">{result.edges.slice(0, 40).map((edge) => <li key={edge.id}><span className="ck-mono">{result.nodes.find((node) => node.id === edge.from)?.label ?? edge.from.slice(0, 8)} → {result.nodes.find((node) => node.id === edge.to)?.label ?? edge.to.slice(0, 8)}</span> {edge.relation} <span className="ck-faint">({edge.provenance})</span></li>)}</ul>}</div>}
      </Card>
    </div>}
  </div>;
}
