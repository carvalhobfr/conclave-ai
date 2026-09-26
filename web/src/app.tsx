import { FeedbackPanel } from "./finding-feedback.js";
import { AcceptanceEditor } from "./acceptance-editor.js";
import { useEffect, useMemo, useState } from "react";

import type {
  EvidenceView,
  GraphView,
  ProductIntent,
  ProductRunView,
  ProjectView,
  ReviewHistoryView,
  RuntimeConfigurationRequest,
  RuntimeConfigurationResult,
  RuntimeModeView,
  ValidationRequestView,
  ValidationRunView,
} from "../../src/web/contracts.js";
import { createReviewDecision } from "../../src/domain/review-decision.js";
import { api } from "./api.js";

const DEFAULT_VALIDATE = "Verify that this change resolves its stated objective without unrelated regressions.";
const DEFAULT_ASK = "Where is bootstrapSession called?";
const DEFAULT_INVESTIGATE = "Why might authentication disappear after refresh?";
type WorkspaceTab = "verdict" | "findings" | "claims" | "impact" | "diff" | "handoff" | "raw" | "evidence" | "graph" | "retrieval" | "history" | "settings";

function statusLabel(status: string): string { return status.replaceAll("-", " ").toUpperCase(); }

function Empty({ title, detail }: { readonly title: string; readonly detail: string }) {
  return <section className="empty"><h2>{title}</h2><p>{detail}</p></section>;
}

function EvidencePanel({ evidence, selected, onSelect }: { readonly evidence: readonly EvidenceView[]; readonly selected: string | undefined; readonly onSelect: (id: string) => void }) {
  const current = evidence.find((item) => item.id === selected) ?? evidence[0];
  if (current === undefined) return <Empty title="No evidence yet" detail="Run Ask or Investigate to inspect bounded repository evidence." />;
  return <section className="evidence-layout" aria-label="Evidence viewer"><div className="evidence-list">{evidence.map((item) => <button type="button" className={`evidence-link ${current.id === item.id ? "selected" : ""}`} onClick={() => onSelect(item.id)} key={item.id}><span>{item.path}</span><small>{item.startLine}–{item.endLine}{item.symbol === undefined ? "" : ` · ${item.symbol}`}</small></button>)}</div><article className="code-card"><header><span>{current.path}</span><span>lines {current.startLine}–{current.endLine}</span></header><pre><code>{current.excerpt}</code></pre><footer>Provenance: {current.origin}</footer></article></section>;
}

function Claims({ run, onEvidence }: { readonly run: ProductRunView; readonly onEvidence: (id: string) => void }) {
  if (run.claims.length === 0) return <Empty title="No verified claims" detail="Conclave did not accept a claim for this run." />;
  return <div className="claims">{run.claims.map((claim) => <article className={`claim ${claim.status}`} key={claim.id}><header><span className="claim-status" aria-label={claim.status}>{claim.status === "supported" ? "✓ supported" : claim.status === "rejected" ? "× rejected" : "? uncertain"}</span><span>{claim.role}</span></header><p>{claim.statement}</p><footer>{claim.evidenceIds.map((id) => <button type="button" onClick={() => onEvidence(id)} key={id}>Evidence</button>)}<span>{claim.challengeCount} challenges · {claim.verificationCount} verifications</span></footer></article>)}</div>;
}

function GraphPanel({ graph, onSearch }: { readonly graph: GraphView; readonly onSearch: (value: string) => void }) {
  const [symbol, setSymbol] = useState(graph.query);
  useEffect(() => setSymbol(graph.query), [graph.query]);
  return <section className="graph-panel" aria-label="Graph explorer"><form onSubmit={(event) => { event.preventDefault(); onSearch(symbol); }}><label htmlFor="graph-symbol">Scoped symbol</label><div><input id="graph-symbol" value={symbol} onChange={(event) => setSymbol(event.target.value)} /><button type="submit">Explore</button></div></form><p className="muted">{graph.message ?? `${String(graph.nodes.length)} bounded nodes · ${String(graph.edges.length)} relations`}</p><div className="graph-canvas">{graph.nodes.map((node) => <div className="graph-node" key={node.id}><strong>{node.label}</strong><small>{node.path}</small></div>)}</div><div className="graph-edges">{graph.edges.map((edge) => <div key={edge.id}><span>{edge.relation}</span><small>{edge.provenance} · {edge.from.slice(0, 8)} → {edge.to.slice(0, 8)}</small></div>)}</div></section>;
}

function RetrievalPanel({ run }: { readonly run: ProductRunView }) {
  return <section className="retrieval-panel"><h2>Retrieval inspector</h2><p className="muted">Why these evidence units, not a larger context dump.</p><ul>{run.retrieval.operations.map((item, index) => <li key={`${item.label}-${String(index)}`}><span>{item.status === "executed" ? "✓" : "○"}</span>{item.label} <small>{item.status}</small></li>)}</ul><dl><div><dt>Evidence</dt><dd>{run.retrieval.evidenceCount}</dd></div><div><dt>Source bytes</dt><dd>{run.retrieval.sourceBytes}</dd></div><div><dt>Approx. tokens</dt><dd>{run.retrieval.approximateTokens}</dd></div></dl></section>;
}

function ValidationTabs({ tab, onSelect }: { readonly tab: WorkspaceTab; readonly onSelect: (tab: WorkspaceTab) => void }) {
  const tabs: readonly { readonly id: WorkspaceTab; readonly label: string }[] = [
    { id: "verdict", label: "Summary" },
    { id: "findings", label: "Findings" },
    { id: "claims", label: "Claims" },
    { id: "impact", label: "Impact" },
    { id: "diff", label: "Diff" },
    { id: "handoff", label: "Agent handoff" },
    { id: "raw", label: "Raw report" },
  ];
  return <div className="result-tabs validation-tabs" role="tablist" aria-label="Validation result views">{tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => onSelect(item.id)}>{item.label}</button>)}</div>;
}

function ValidationSummary({ result, onSelect }: { readonly result: ValidationRunView; readonly onSelect: (tab: WorkspaceTab) => void }) {
  const [copied, setCopied] = useState(false);
  const report = result.report;
  const decision = createReviewDecision(report);
  const escalation = (report as Partial<ValidationRunView["report"]>).escalation;
  const trust = report.trustBoundary;
  return <section className={`validation-summary validation-${result.verdict}`} aria-label="Validation summary">
    <header className="decision-header"><span className="decision-kicker">Delivery review</span><div><span className={`decision-badge ${result.verdict}`}>{result.verdict.toUpperCase()}</span>{result.demo && <span className="demo-badge">DEMO FIXTURE</span>}</div><h2>{decision.headline}</h2><p>{report.objective}</p></header>
    <div className="recommendation"><strong>Next action</strong><p>{decision.nextAction}</p><div className="decision-actions"><button type="button" className="primary-action" onClick={() => { void navigator.clipboard.writeText(result.handoff).then(() => setCopied(true)).catch(() => onSelect("handoff")); }}>{copied ? "Copied ✓" : "Copy handoff prompt"}</button><button type="button" onClick={() => onSelect("handoff")}>Prepare agent handoff</button><button type="button" onClick={() => onSelect("diff")}>Inspect reviewed diff</button></div></div>
    <div className="decision-columns">
      <section className="decision-card" aria-label="Needs attention"><h3>Needs attention <span>{decision.attention.length}</span></h3>{decision.attention.length === 0 ? <p>No deterministic blocker or warning found. This does not establish that the requested behavior works.</p> : <><ul>{decision.attention.slice(0, 3).map((finding) => <li key={finding.id}><strong>{finding.title}</strong><p>{finding.remediation}</p></li>)}</ul><button type="button" onClick={() => onSelect("findings")}>Inspect all findings and evidence</button></>}</section>
      <section className="decision-card" aria-label="Still needs verification"><h3>Still needs verification <span>{decision.verificationGaps.length}</span></h3>{decision.verificationGaps.length === 0 ? <p>No verification tasks for this comparison.</p> : <ul>{decision.verificationGaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>}</section>
    </div>
    {(report.criteria?.length ?? 0) > 0 && <section aria-label="Criteria results"><h3>Delivery criteria</h3>{report.criteria?.map((item) => <article className="decision-card" key={item.criterion.id}><h4>{item.criterion.statement}</h4><strong>{statusLabel(item.status)}</strong><p>{item.criterion.verificationPlan}</p><p>{item.reasons.join(" ")}</p><small>Previous: {item.previousStatus ?? "initial"} · Evidence: {item.receiptIds.join(", ") || "none"}</small></article>)}</section>}
    <section className="decision-card" aria-label="Correction progress"><h3>Since the previous review</h3><p>{decision.progress}</p></section>
    <details className="coverage-details"><summary>What the rules examined</summary><p>Rule results describe a limited syntax check. Further verification may require tests, human review or an optional model; Conclave does not run those automatically.</p>{report.schemaVersion === 2 && <p>Historical report: detailed rule coverage is unavailable. Legacy clean and evidenced labels do not establish complete coverage.</p>}{(escalation?.dimensions ?? []).map((dimension) => <article key={dimension.dimension}><h4>{statusLabel(dimension.dimension)} · {dimension.coverage === "partial" ? "Partial coverage" : dimension.coverage === "unchecked" ? "Not checked" : "Legacy coverage"}</h4><p>{dimension.reason}</p>{dimension.checks?.map((check) => <div className="rule-check" key={check.rule}><strong>{check.rule} · {check.status === "no-finding" ? "No finding within this rule" : check.status === "not-applicable" ? "No applicable source" : "Finding reported"}</strong><p>{check.scope}</p><small>{check.paths.join(", ")}</small></div>)}</article>)}{(escalation?.dimensions.length ?? 0) === 0 && <p>No focused risk dimension selected. This does not establish complete behavioral coverage.</p>}</details>
    <footer className="validation-footnote"><p>{report.metrics.filesChanged} files changed · {report.metrics.impactedFiles} files impacted · {result.counts.supportedClaims}/{result.counts.totalClaims} structural claims supported</p><p>Knowledge: {trust.knowledge.parser} parser, {trust.knowledge.graph} graph. Reasoning model calls: {trust.reasoningModelCalls}; remote embedding calls: {trust.knowledge.embedding.remoteCalls}; repository scripts: not executed.</p><p>PASS means no deterministic blocker or warning was found. Human approval and behavioral verification remain separate.</p></footer>
  </section>;
}

function ValidationFindings({ result }: { readonly result: ValidationRunView }) {
  if (result.report.findings.length === 0) return <Empty title="No findings" detail="Conclave found no deterministic contradiction or graph risk in this change." />;
  return <section className="validation-list" aria-label="Validation findings">{result.report.findings.map((finding) => <article className={`finding-card ${finding.severity}`} key={finding.id}><header><span>{finding.severity}</span><small>{finding.kind}</small></header><h2>{finding.title}</h2><p>{finding.detail}</p><div className="remediation"><strong>Next action</strong><p>{finding.remediation}</p></div>{finding.evidence.length > 0 && <ul>{finding.evidence.map((item, index) => <li key={`${item.path}-${String(index)}`}><code>{item.path}</code>{item.startLine === undefined ? "" : `:${String(item.startLine)}`}{item.symbol === undefined ? "" : ` · ${item.symbol}`}<small>{item.reason}</small></li>)}</ul>}</article>)}</section>;
}

function ValidationClaims({ result }: { readonly result: ValidationRunView }) {
  if (result.report.claims.length === 0) return <Empty title="No explicit completion claims" detail="The structural review still ran. Add a validation contract to challenge concrete agent claims." />;
  return <section className="validation-list" aria-label="Validation claims">{result.report.claims.map((item) => <article className={`claim-card ${item.outcome}`} key={item.claim.id}><header><span>{item.outcome}</span><small>{item.claim.check.kind}</small></header><h2>{item.claim.statement}</h2><p>{item.explanation}</p>{item.evidence.length > 0 && <ul>{item.evidence.map((evidence, index) => <li key={`${evidence.path}-${String(index)}`}><code>{evidence.path}</code>{evidence.startLine === undefined ? "" : `:${String(evidence.startLine)}`}<small>{evidence.reason}</small></li>)}</ul>}</article>)}</section>;
}

function ValidationImpact({ result }: { readonly result: ValidationRunView }) {
  const report = result.report;
  return <section className="impact-view" aria-label="Change impact">
    <div className="impact-metrics"><article><strong>{report.metrics.symbolsChanged}</strong><span>symbols changed</span></article><article><strong>{report.metrics.impactedSymbols}</strong><span>symbols impacted</span></article><article><strong>{report.metrics.graphEdgesInspected}</strong><span>graph relations inspected</span></article><article><strong>{report.metrics.deterministicChecks}</strong><span>deterministic checks</span></article></div>
    <div className="impact-columns"><article><h2>Changed files</h2><ul>{report.changeSet.files.map((file) => <li key={file.path}><code>{file.path}</code><span>{file.status}</span></li>)}</ul></article><article><h2>Impacted files</h2><ul>{report.impact.impactedFiles.map((path) => <li key={path}><code>{path}</code></li>)}</ul></article></div>
    <details><summary>Impacted symbols ({report.impact.impactedSymbols.length})</summary><div className="symbol-cloud">{report.impact.impactedSymbols.map((symbol) => <code key={symbol}>{symbol}</code>)}</div></details>
  </section>;
}

function ValidationWorkspace({ result, tab, onSelect }: { readonly result: ValidationRunView; readonly tab: WorkspaceTab; readonly onSelect: (tab: WorkspaceTab) => void }) {
  return <><ValidationTabs tab={tab} onSelect={onSelect} />{tab === "findings" ? <ValidationFindings result={result} /> : tab === "claims" ? <ValidationClaims result={result} /> : tab === "impact" ? <ValidationImpact result={result} /> : tab === "diff" ? <section className="raw-report" aria-label="Git diff"><header><h2>Exact Git diff reviewed</h2><p>This is the patch that produced the report.</p></header><pre><code>{result.patch || "No patch was collected."}</code></pre></section> : tab === "handoff" ? <section className="handoff-panel" aria-label="Agent handoff"><header><div><span>Next step</span><h2>Send this to your coding agent</h2></div><button type="button" onClick={() => void navigator.clipboard.writeText(result.handoff)}>Copy prompt</button></header><p>Conclave points to evidence; Codex, Claude Code, or your agent makes the correction.</p><pre><code>{result.handoff}</code></pre></section> : tab === "raw" ? <section className="raw-report" aria-label="Raw validation report"><header><h2>Machine-readable report</h2><p>The UI above is derived from this exact object.</p></header><pre><code>{JSON.stringify(result.report, null, 2)}</code></pre></section> : <ValidationSummary result={result} onSelect={onSelect} />}</>;
}

function HistoryPanel({ records, onContinue }: { readonly records: readonly ReviewHistoryView[]; readonly onContinue: (record: ReviewHistoryView) => void }) {
  if (records.length === 0) return <Empty title="No reviews yet" detail="Run a review here or use `conclave check .`; both appear in this local history." />;
  return <section className="history-panel" aria-label="Review history"><header><h2>Review history</h2><p>Local to this repository. Nothing is uploaded.</p></header>{records.map((record) => <article key={record.id}><span className={`decision-badge ${record.verdict}`}>{record.verdict}</span><div><strong>{record.title}</strong><p>{record.objective}</p><small>{new Date(record.createdAt).toLocaleString()}</small></div>{record.report !== undefined && <button type="button" className="text-action" onClick={() => onContinue(record)} aria-label={`Continue review: ${record.objective}`}>Continue this review</button>}</article>)}</section>;
}

type ConfigurationProfileId = "ollama" | "lm-studio" | "opencode-go" | "opencode-zen" | "openrouter" | "custom";

interface ConfigurationProfile extends RuntimeConfigurationRequest {
  readonly id: ConfigurationProfileId;
  readonly label: string;
  readonly models: readonly string[];
}

const DEFAULT_CONFIGURATION_PROFILE: ConfigurationProfile = { id: "ollama", label: "Ollama · local", mode: "local", provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:3b", reasoningPreset: "local", models: ["qwen2.5-coder:3b"] };

const CONFIGURATION_PROFILES: readonly ConfigurationProfile[] = [
  DEFAULT_CONFIGURATION_PROFILE,
  { id: "lm-studio", label: "LM Studio · local", mode: "local", provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", reasoningPreset: "local", models: [] },
  { id: "opencode-go", label: "OpenCode Go", mode: "api", provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", model: "deepseek-v4.1-flash", reasoningPreset: "full", models: ["deepseek-v4.1-flash", "deepseek-v4-pro", "qwen3.8-max", "space-bunny-free", "qwen3.8-flash", "mimo-v2.6-flash", "kimi-k2.7-code", "glm-5.3"] },
  { id: "opencode-zen", label: "OpenCode Zen", mode: "api", provider: "opencode-zen", baseUrl: "https://opencode.ai/zen/v1", model: "", reasoningPreset: "free-like", models: ["kimi-k2.7-code", "deepseek-v4-flash", "glm-5.2"] },
  { id: "openrouter", label: "OpenRouter", mode: "api", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "", reasoningPreset: "free-like", models: [] },
  { id: "custom", label: "Custom OpenAI-compatible", mode: "api", provider: "openai-compatible", baseUrl: "https://provider.example/v1", model: "", reasoningPreset: "free-like", models: [] },
];

type ConclaveCost = "Free" | "Low" | "Moderate" | "Premium";

interface SavedConclave {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly cost: ConclaveCost;
  readonly profileId: ConfigurationProfileId;
  readonly model: string;
  readonly baseUrl: string;
  readonly reasoningPreset: RuntimeConfigurationRequest["reasoningPreset"];
  readonly roles?: RuntimeConfigurationRequest["roles"];
  readonly fallbackModel?: string;
  /** Measured average in the product lab, shown next to the cost tier. */
  readonly usdPerReview?: number;
  readonly builtIn?: boolean;
}

interface ConclaveLibrary {
  readonly activeId: string;
  readonly defaultId: string;
  readonly favoriteIds: readonly string[];
  readonly custom: readonly SavedConclave[];
}

const CONCLAVE_LIBRARY_KEY = "conclave.councils.v1";
const CONCLAVE_PRESETS: readonly SavedConclave[] = [
  { id: "essential", name: "Essential", description: "Recommended. The best measured cost-benefit for everyday reviews.", cost: "Low", profileId: "opencode-go", model: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1", reasoningPreset: "full", usdPerReview: 0.0015, builtIn: true },
  { id: "free-trial", name: "Free trial", description: "No cost while OpenCode offers this preview model; it may be withdrawn.", cost: "Free", profileId: "opencode-go", model: "space-bunny-free", baseUrl: "https://opencode.ai/zen/go/v1", reasoningPreset: "full", builtIn: true },
];

function allConclaves(library: ConclaveLibrary): readonly SavedConclave[] {
  return [...CONCLAVE_PRESETS, ...library.custom];
}

function isSavedConclave(value: unknown): value is SavedConclave {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item["id"] === "string" && typeof item["name"] === "string" && typeof item["description"] === "string"
    && (item["cost"] === "Free" || item["cost"] === "Low" || item["cost"] === "Moderate" || item["cost"] === "Premium")
    && typeof item["profileId"] === "string" && typeof item["model"] === "string" && typeof item["baseUrl"] === "string"
    && (item["reasoningPreset"] === "free-like" || item["reasoningPreset"] === "full" || item["reasoningPreset"] === "local")
    && (item["fallbackModel"] === undefined || typeof item["fallbackModel"] === "string")
    && (item["roles"] === undefined || (typeof item["roles"] === "object" && item["roles"] !== null && !Array.isArray(item["roles"])));
}

function loadConclaveLibrary(): ConclaveLibrary {
  const fallback: ConclaveLibrary = { activeId: "essential", defaultId: "essential", favoriteIds: ["essential"], custom: [] };
  try {
    const saved = window.localStorage.getItem(CONCLAVE_LIBRARY_KEY);
    if (saved === null) return fallback;
    const value: unknown = JSON.parse(saved);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
    const record = value as Record<string, unknown>;
    if (typeof record["activeId"] !== "string" || typeof record["defaultId"] !== "string" || !Array.isArray(record["favoriteIds"]) || !Array.isArray(record["custom"])) return fallback;
    const custom = record["custom"].filter(isSavedConclave);
    // Saved ids can point at presets that were retired; fall back to the recommended one.
    const known = new Set([...CONCLAVE_PRESETS, ...custom].map((item) => item.id));
    const valid = (id: string) => (known.has(id) ? id : fallback.activeId);
    return { activeId: valid(record["activeId"]), defaultId: valid(record["defaultId"]), favoriteIds: record["favoriteIds"].filter((id): id is string => typeof id === "string" && known.has(id)), custom };
  } catch { return fallback; }
}

function ConclaveCards({ library, onSelect, onDefault, onFavorite, onCreate }: {
  readonly library: ConclaveLibrary;
  readonly onSelect: (id: string) => void;
  readonly onDefault: (id: string) => void;
  readonly onFavorite: (id: string) => void;
  readonly onCreate: (name: string, source: Omit<SavedConclave, "id" | "name" | "description" | "cost">) => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const selected = allConclaves(library).find((item) => item.id === library.activeId);
  return <section className="conclave-library" aria-label="Conclaves">
    <header><div><span className="decision-kicker">Your Conclaves</span><h2>Choose how you review</h2><p>Start with a preset, or keep one you made for later.</p></div></header>
    <div className="conclave-cards">{allConclaves(library).map((conclave) => {
      const active = conclave.id === library.activeId;
      const favorite = library.favoriteIds.includes(conclave.id);
      return <article className={`conclave-card ${active ? "active" : ""}`} key={conclave.id}>
        <button type="button" className="conclave-card-main" onClick={() => onSelect(conclave.id)} aria-label={`Use ${conclave.name}`} aria-pressed={active}><div><strong>{conclave.name}</strong>{conclave.id === library.defaultId && <span className="default-tag">Default</span>}</div><p>{conclave.description}</p><small>{conclave.cost === "Free" ? "No cost" : `${conclave.cost} estimated cost`}{conclave.usdPerReview === undefined || conclave.cost === "Free" ? "" : ` · ≈ $${conclave.usdPerReview.toFixed(4)} per review`}</small></button>
        <footer><button type="button" className={favorite ? "star active" : "star"} aria-label={`${favorite ? "Remove" : "Add"} ${conclave.name} favorite`} onClick={() => onFavorite(conclave.id)}>{favorite ? "★" : "☆"}</button><button type="button" className="text-action" aria-label={`Make ${conclave.name} default`} onClick={() => onDefault(conclave.id)} disabled={conclave.id === library.defaultId}>Make default</button></footer>
      </article>;
    })}</div>
    <div className="conclave-create">
      {!creating ? <button type="button" className="text-action" onClick={() => setCreating(true)}>Create your own</button> : <form onSubmit={(event) => { event.preventDefault(); if (name.trim() === "" || selected === undefined) return; onCreate(name.trim(), selected); setName(""); setCreating(false); }}><input aria-label="Conclave name" placeholder="Name this Conclave" value={name} onChange={(event) => setName(event.target.value)} autoFocus /><button type="submit" className="text-action">Save</button><button type="button" className="text-action" onClick={() => setCreating(false)}>Cancel</button></form>}
    </div>
  </section>;
}

function profileFor(runtime: RuntimeModeView): ConfigurationProfile {
  return CONFIGURATION_PROFILES.find((profile) => profile.provider === runtime.provider && profile.mode === runtime.active)
    ?? DEFAULT_CONFIGURATION_PROFILE;
}

function ConfigurationPanel({ runtime, onRuntime, library, onSelectConclave, onDefaultConclave, onFavoriteConclave, onCreateConclave }: { readonly runtime: RuntimeModeView | undefined; readonly onRuntime: (runtime: RuntimeModeView) => void; readonly library: ConclaveLibrary; readonly onSelectConclave: (id: string) => void; readonly onDefaultConclave: (id: string) => void; readonly onFavoriteConclave: (id: string) => void; readonly onCreateConclave: (name: string, source: Omit<SavedConclave, "id" | "name" | "description" | "cost">) => void }) {
  const initial = runtime === undefined ? DEFAULT_CONFIGURATION_PROFILE : profileFor(runtime);
  const [profileId, setProfileId] = useState<ConfigurationProfileId>(initial.id);
  const [model, setModel] = useState(runtime?.model ?? initial.model);
  const [baseUrl, setBaseUrl] = useState(runtime?.baseUrl ?? initial.baseUrl);
  const [reasoningPreset, setReasoningPreset] = useState<RuntimeConfigurationRequest["reasoningPreset"]>(runtime?.reasoningPreset ?? initial.reasoningPreset);
  // Role mix and fallback come only from a selected Conclave; editing the model by hand clears them.
  const [mix, setMix] = useState<Pick<RuntimeConfigurationRequest, "roles" | "fallbackModel">>({});
  const chooseModel = (value: string) => { setModel(value); setMix({}); };
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<readonly string[]>([]);
  const [result, setResult] = useState<RuntimeConfigurationResult>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (runtime === undefined) return;
    const next = profileFor(runtime);
    setProfileId(next.id);
    setModel(runtime.model ?? next.model);
    setBaseUrl(runtime.baseUrl ?? next.baseUrl);
    setReasoningPreset(runtime.reasoningPreset ?? next.reasoningPreset);
  }, [runtime]);
  useEffect(() => {
    const next = allConclaves(library).find((item) => item.id === library.activeId);
    if (next === undefined) return;
    setProfileId(next.profileId);
    setModel(next.model);
    setBaseUrl(next.baseUrl);
    setReasoningPreset(next.reasoningPreset);
    setMix({ ...(next.roles === undefined ? {} : { roles: next.roles }), ...(next.fallbackModel === undefined ? {} : { fallbackModel: next.fallbackModel }) });
    setApiKey("");
    setAvailableModels([]);
    setResult(undefined);
    setError("");
  }, [library]);
  if (runtime === undefined) return <Empty title="Configuration unavailable" detail="The server runtime has not responded yet." />;
  const profile = CONFIGURATION_PROFILES.find((item) => item.id === profileId) ?? initial;
  const chooseProfile = (id: ConfigurationProfileId) => {
    const next = CONFIGURATION_PROFILES.find((item) => item.id === id) ?? DEFAULT_CONFIGURATION_PROFILE;
    setProfileId(next.id);
    chooseModel(next.model);
    setBaseUrl(next.baseUrl);
    setReasoningPreset(next.reasoningPreset);
    setApiKey("");
    setAvailableModels([]);
    setResult(undefined);
    setError("");
  };
  const discoverModels = async () => {
    setLoadingModels(true);
    setError("");
    setResult(undefined);
    try {
      const discovered = await api.discoverModels({
        mode: profile.mode,
        provider: profile.provider,
        baseUrl,
        ...(profile.mode === "api" && apiKey !== "" ? { apiKey } : {}),
      });
      setAvailableModels(discovered.models);
      if (!discovered.models.includes(model)) chooseModel("");
    } catch (discoveryError) {
      setError(discoveryError instanceof Error ? discoveryError.message : "Could not load provider models.");
    } finally {
      setLoadingModels(false);
    }
  };
  const save = async () => {
    setSaving(true);
    setError("");
    setResult(undefined);
    try {
      const next = await api.configureRuntime({
        mode: profile.mode,
        provider: profile.provider,
        model,
        baseUrl,
        reasoningPreset,
        ...(profile.mode === "api" && apiKey !== "" ? { apiKey } : {}),
        ...mix,
      });
      setApiKey("");
      setResult(next);
      onRuntime(next.runtime);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save provider settings.");
    } finally {
      setSaving(false);
    }
  };
  return <section className="retrieval-panel configuration-panel" aria-label="Provider and role configuration">
    <ConclaveCards library={library} onSelect={onSelectConclave} onDefault={onDefaultConclave} onFavorite={onFavoriteConclave} onCreate={onCreateConclave} />
    <header><div><span className="decision-kicker">Local server settings</span><h2>Provider and model</h2></div><span className={`runtime-state ${runtime.available ? "ready" : "unavailable"}`}>{runtime.available ? "CONFIGURED" : "NEEDS SETUP"}</span></header>
    <p className="muted">Picking a Conclave above applies it at once when a key for that provider is saved. Otherwise, paste the key below and press Save and test. The CLI reads the same settings: <code>conclave config</code>.</p>
    <form className="configuration-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label htmlFor="provider-profile">Provider</label>
      <select id="provider-profile" value={profileId} onChange={(event) => chooseProfile(event.target.value as ConfigurationProfileId)}>{CONFIGURATION_PROFILES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      <label htmlFor="provider-model">Model</label>
      <div className="model-field">{availableModels.length > 0
        ? <select id="provider-model" value={model} onChange={(event) => chooseModel(event.target.value)}><option value="">Choose an available model</option>{availableModels.map((item) => <option value={item} key={item}>{item}</option>)}</select>
        : <input id="provider-model" list="provider-models" value={model} onChange={(event) => chooseModel(event.target.value)} placeholder="Load models or enter an ID" autoComplete="off" />}
        <button type="button" onClick={() => void discoverModels()} disabled={loadingModels}>{loadingModels ? "Loading…" : "Load available models"}</button></div>
      <datalist id="provider-models">{profile.models.map((item) => <option value={item} key={item} />)}</datalist>
      <label htmlFor="provider-endpoint">Endpoint</label>
      <input id="provider-endpoint" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} autoComplete="off" />
      <label htmlFor="reasoning-preset">Reasoning</label>
      <select id="reasoning-preset" value={reasoningPreset} onChange={(event) => setReasoningPreset(event.target.value as RuntimeConfigurationRequest["reasoningPreset"])} disabled={profile.mode === "local"}>
        {profile.mode === "local" ? <option value="local">Local bounded route</option> : <><option value="free-like">Fast · investigator + judge</option><option value="full">Full · all five roles</option></>}
      </select>
      {profile.mode === "api" && <><label htmlFor="provider-api-key">API key</label><div className="secret-field"><input id="provider-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={runtime.credentialConfigured ? "Leave blank to keep current key" : "Paste provider key"} autoComplete="off" spellCheck={false} /><small>{runtime.credentialHint === undefined ? "The server never returns the complete value." : <>Current key: <code>{runtime.credentialHint}</code>. Only this masked hint is returned.</>}</small></div></>}
      <button type="submit" className="run-button" disabled={saving}>{saving ? "Saving and testing…" : "Save and test"}</button>
    </form>
    <p className="configuration-security">The key is sent over this loopback connection and stored in your Conclave settings file with owner-only permissions. Runtime responses include only its masked first 2 and last 4 characters.</p>
    {error !== "" && <div className="configuration-result failed" role="alert"><strong>Not saved</strong><span>{error}</span></div>}
    {result !== undefined && <div className={`configuration-result ${result.diagnostic.inferenceAvailable ? "passed" : "failed"}`} role="status"><strong>{result.diagnostic.inferenceAvailable ? "Saved · inference test passed" : "Saved · inference test failed"}</strong><span>{result.diagnostic.message}</span><small>{result.diagnostic.provider} · {result.runtime.model} · {result.diagnostic.endpoint}</small></div>}
    <dl><div><dt>Active mode</dt><dd>{runtime.active}</dd></div><div><dt>Provider</dt><dd>{runtime.provider ?? "not configured"}</dd></div><div><dt>Model</dt><dd>{runtime.model ?? "not configured"}</dd></div><div><dt>Credential</dt><dd>{runtime.active === "local" ? "not required" : runtime.credentialConfigured ? runtime.credentialHint ?? "configured" : "missing"}</dd></div></dl>
  </section>;
}

export function App() {
  const [conclaveLibrary, setConclaveLibrary] = useState<ConclaveLibrary>(loadConclaveLibrary);
  const [project, setProject] = useState<ProjectView>();
  const [runtime, setRuntime] = useState<RuntimeModeView>();
  const [intent, setIntent] = useState<ProductIntent>("validate");
  const [input, setInput] = useState(DEFAULT_VALIDATE);
  const [run, setRun] = useState<ProductRunView>();
  const [validationRun, setValidationRun] = useState<ValidationRunView>();
  const [sourceKind, setSourceKind] = useState<ValidationRequestView["source"]["kind"]>("workspace");
  const [sourceRef, setSourceRef] = useState("master");
  const [contractText, setContractText] = useState("");
  const [previousReviewId, setPreviousReviewId] = useState("");
  const [receiptEnvelope, setReceiptEnvelope] = useState<unknown>();
  useEffect(() => { setValidationRun(undefined); setPreviousReviewId(""); setReceiptEnvelope(undefined); setContractText(""); }, [project?.id]);
  const [tab, setTab] = useState<WorkspaceTab>("verdict");
  const [selectedEvidence, setSelectedEvidence] = useState<string>();
  const [localPath, setLocalPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<readonly ReviewHistoryView[]>([]);
  useEffect(() => { window.localStorage.setItem(CONCLAVE_LIBRARY_KEY, JSON.stringify(conclaveLibrary)); }, [conclaveLibrary]);
  const selectConclave = (id: string) => setConclaveLibrary((current) => ({ ...current, activeId: id }));
  // One click switches the reviewing setup when the saved key already belongs to its provider;
  // otherwise Settings opens with the form filled so only the key is missing.
  const applyConclave = async (id: string): Promise<boolean> => {
    const conclave = allConclaves(conclaveLibrary).find((item) => item.id === id);
    const profile = CONFIGURATION_PROFILES.find((item) => item.id === conclave?.profileId);
    if (conclave === undefined || profile === undefined || runtime === undefined) return false;
    if (profile.mode !== "local" && !(runtime.credentialConfigured && runtime.provider === profile.provider)) return false;
    try {
      const next = await api.configureRuntime({
        mode: profile.mode,
        provider: profile.provider,
        model: conclave.model,
        baseUrl: conclave.baseUrl,
        reasoningPreset: conclave.reasoningPreset,
        ...(conclave.roles === undefined ? {} : { roles: conclave.roles }),
        ...(conclave.fallbackModel === undefined ? {} : { fallbackModel: conclave.fallbackModel }),
      });
      setRuntime(next.runtime);
      setNotice(next.diagnostic.inferenceAvailable ? `Now reviewing with ${conclave.name}.` : `Switched to ${conclave.name}, but the provider test failed: ${next.diagnostic.message}`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Could not switch to ${conclave.name}.`);
      return false;
    }
  };
  const chooseConclave = (id: string, openSettingsWhenBlocked: boolean) => {
    selectConclave(id);
    void applyConclave(id).then((applied) => { if (!applied && openSettingsWhenBlocked) setTab("settings"); });
  };
  const continueReview = (record: ReviewHistoryView) => {
    setPreviousReviewId(record.report?.lineage.reviewId ?? "");
    setIntent("validate");
    setInput(record.objective);
    setTab("verdict");
    setNotice("The next review continues this series and shows what changed since then.");
  };
  const defaultConclave = (id: string) => setConclaveLibrary((current) => ({ ...current, activeId: id, defaultId: id }));
  const favoriteConclave = (id: string) => setConclaveLibrary((current) => ({ ...current, favoriteIds: current.favoriteIds.includes(id) ? current.favoriteIds.filter((item) => item !== id) : [...current.favoriteIds, id] }));
  const createConclave = (name: string, source: Omit<SavedConclave, "id" | "name" | "description" | "cost">) => {
    const id = `custom-${Date.now().toString(36)}`;
    const created: SavedConclave = { ...source, id, name, description: "A saved review setup you can return to anytime.", cost: "Moderate" };
    setConclaveLibrary((current) => ({ ...current, activeId: id, favoriteIds: [...current.favoriteIds, id], custom: [...current.custom, created] }));
  };
  const openDemo = async () => { setBusy(true); try { const opened = await api.demo(); setProject(opened); setNotice("Demo Mode uses deterministic repository and change fixtures. Validation makes no model call."); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not open Demo Mode."); } finally { setBusy(false); } };
  useEffect(() => {
    void api.runtime().then(setRuntime).catch(() => undefined);
    const repository = new URLSearchParams(window.location.search).get("repository");
    if (repository === null) { void openDemo(); return; }
    setLocalPath(repository);
    setBusy(true);
    void api.open(repository).then((opened) => {
      setProject(opened);
      setSourceKind("workspace");
      setSourceRef(opened.git?.defaultBase ?? "master");
      return api.history(opened.id).then(setHistory);
    }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Could not open repository."))
      .finally(() => setBusy(false));
  }, []);
  const modeCopy = useMemo(() => intent === "validate" ? "Review this change" : intent === "ask" ? "Evidence-backed answer" : "Structured causal analysis", [intent]);
  const setActiveIntent = (next: ProductIntent) => { setIntent(next); setInput(next === "validate" ? DEFAULT_VALIDATE : next === "ask" ? DEFAULT_ASK : DEFAULT_INVESTIGATE); setTab("verdict"); };
  const openLocal = async () => { if (localPath.trim() === "") return; setBusy(true); try { const opened = await api.open(localPath); setProject(opened); setSourceKind("workspace"); setSourceRef(opened.git?.defaultBase ?? "master"); setHistory(await api.history(opened.id)); setNotice("Repository ready. Branch commits and every local change can be reviewed together."); } catch (error) { setNotice(error instanceof Error ? error.message : "Could not open local folder."); } finally { setBusy(false); } };
  const submit = async () => {
    if (project === undefined) return;
    setBusy(true);
    setNotice("");
    try {
      if (intent === "validate") {
        let source: ValidationRequestView["source"];
        if (sourceKind === "branch") source = { kind: "branch", base: sourceRef.trim() };
        else if (sourceKind === "workspace") source = { kind: "workspace", base: sourceRef.trim() };
        else if (sourceKind === "commit") source = { kind: "commit", commit: sourceRef.trim() };
        else source = { kind: sourceKind };
        const next = await api.validate(project.id, source, input, contractText, previousReviewId || undefined, receiptEnvelope);
        setValidationRun(next);
        if (!next.demo) setPreviousReviewId(next.report.lineage.reviewId);
        setHistory(await api.history(project.id));
        setTab("verdict");
      } else {
        const next = await api.run(project.id, intent, input);
        setRun(next);
        setSelectedEvidence(next.evidence[0]?.id);
        setTab("verdict");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not start Conclave.");
    } finally {
      setBusy(false);
    }
  };
  const explore = async (symbol: string) => { if (project === undefined) return; try { const next = await api.graph(project.id, symbol); setRun((current) => current === undefined ? current : { ...current, graph: next }); setTab("graph"); } catch (error) { setNotice(error instanceof Error ? error.message : "Graph lookup failed."); } };
  const showResults = tab !== "settings" && run !== undefined;
  const workspaceNavigationActive = tab !== "settings" && tab !== "history";

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="mark">C</span><div><strong>Conclave</strong><small>Your PR review companion</small></div></div>
      <nav aria-label="Workspace navigation">
        <button className={workspaceNavigationActive && intent === "validate" ? "nav-active" : ""} aria-current={workspaceNavigationActive && intent === "validate" ? "page" : undefined} onClick={() => setActiveIntent("validate")}>Review</button>
        <button className={workspaceNavigationActive && intent === "ask" ? "nav-active" : ""} aria-current={workspaceNavigationActive && intent === "ask" ? "page" : undefined} onClick={() => setActiveIntent("ask")}>Ask</button>
        <button className={workspaceNavigationActive && intent === "investigate" ? "nav-active" : ""} aria-current={workspaceNavigationActive && intent === "investigate" ? "page" : undefined} onClick={() => setActiveIntent("investigate")}>Investigate</button>
        <button className={tab === "history" ? "nav-active" : ""} aria-current={tab === "history" ? "page" : undefined} onClick={() => setTab("history")}>History</button>
        <button className={tab === "settings" ? "nav-active" : ""} aria-current={tab === "settings" ? "page" : undefined} onClick={() => setTab("settings")}>Settings <small>local</small></button>
      </nav>
      <section className="repo-picker">
        <h2>Repository</h2>
        <label htmlFor="local-folder">Local folder</label>
        <div><input id="local-folder" placeholder="/path/to/repository" value={localPath} onChange={(event) => setLocalPath(event.target.value)} /><button type="button" onClick={() => void openLocal()} disabled={busy}>Open</button></div>
        <button type="button" onClick={() => void openDemo()} disabled={busy}>Open deterministic demo</button>
        <p>Conclave reads the repository and reports evidence. It never edits, commits, pushes, or merges.</p>
      </section>
    </aside>
    <section className="workspace">
      <header className="topbar"><div>{project === undefined ? <span>Opening project…</span> : <><strong>{project.name}</strong><span>{project.path}</span></>}</div><div className="topbar-actions"><label className="conclave-switcher"><span className="sr-only">Active Conclave</span><select value={conclaveLibrary.activeId} onChange={(event) => chooseConclave(event.target.value, true)}><optgroup label="Favorites">{allConclaves(conclaveLibrary).filter((item) => conclaveLibrary.favoriteIds.includes(item.id)).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup><optgroup label="All Conclaves">{allConclaves(conclaveLibrary).filter((item) => !conclaveLibrary.favoriteIds.includes(item.id)).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup></select></label><div className="mode-badge">{runtime?.active === "local" ? "LOCAL MODEL" : runtime?.available ? "REASONING READY" : "REVIEW READY"}</div></div></header>
      {notice !== "" && <div className="notice" role="status">{notice}</div>}
      {busy && <div className="review-progress" role="progressbar" aria-label="Conclave is analyzing the repository"><span /></div>}
      {tab !== "settings" && tab !== "history" && <>
      <section className="composer" aria-label="Conclave composer">
        <div className="composer-title"><h1>{modeCopy}</h1><p>{intent === "validate" ? "Compare the real Git change, follow affected code, and prepare it for human review." : "Explore the repository with bounded evidence. These optional modes may use your configured provider."}</p></div>
        <label className="sr-only" htmlFor="query">{intent === "validate" ? "Change objective" : "Repository question"}</label>
        <textarea id="query" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }} rows={3} />
        {intent === "validate" && <details className="advanced-options"><summary>Options <small>{sourceKind === "workspace" ? `Current workspace vs ${sourceRef}` : sourceKind === "branch" ? `Committed branch vs ${sourceRef}` : sourceKind === "working" ? "Working tree vs HEAD" : sourceKind === "staged" ? "Staged changes" : `Commit ${sourceRef}`}{previousReviewId === "" ? "" : " · continuing a series"}{contractText.trim() === "" ? "" : " · with criteria"}</small></summary><div className="validation-controls"><label htmlFor="change-source">Compare</label><select id="change-source" value={sourceKind} onChange={(event) => { const next = event.target.value as ValidationRequestView["source"]["kind"]; setSourceKind(next); if (next === "branch" || next === "workspace") setSourceRef("master"); else if (next === "commit") setSourceRef("HEAD"); }}><option value="workspace">Current workspace against base</option><option value="branch">Committed branch against base</option><option value="working">Working tree against HEAD</option><option value="staged">Staged changes</option><option value="commit">Checked-out commit</option></select>{(sourceKind === "branch" || sourceKind === "workspace" || sourceKind === "commit") && <><label htmlFor="source-ref">{sourceKind === "commit" ? "Commit" : "Base branch"}</label><input id="source-ref" value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} /></>}</div>{project !== undefined && project.source === "local" && <AcceptanceEditor key={project.id} projectId={project.id} objective={input} onLoad={setInput} onChange={setContractText} />}
        <label>Compare with saved review<select aria-label="Previous review" value={previousReviewId} onChange={(event) => setPreviousReviewId(event.target.value)}><option value="">Start a new review series</option>{history.filter((item) => item.report !== undefined).map((item) => <option key={item.id} value={item.report?.lineage.reviewId}>{item.createdAt} — {item.objective}</option>)}</select></label>
        <label>Attach execution receipts<input type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file === undefined) { setReceiptEnvelope(undefined); return; } if (file.size > 1_000_000) { setReceiptEnvelope(undefined); setNotice("Receipt file is too large"); return; } void file.text().then((text) => { setReceiptEnvelope(JSON.parse(text)); setNotice("Execution receipts attached to the next review."); }).catch(() => { setReceiptEnvelope(undefined); setNotice("Invalid receipt JSON"); }); }} /></label>
        <details className="contract-editor"><summary>Optional contract: scope and completion claims</summary><p>Paste the same JSON accepted by the CLI. The objective above takes precedence.</p><textarea aria-label="Optional validation contract" value={contractText} onChange={(event) => setContractText(event.target.value)} rows={7} placeholder={'{"allowedPathPrefixes":[],"claims":[]}'}/></details></details>}
        <button type="button" className="run-button" onClick={() => void submit()} disabled={busy || project === undefined}>{busy ? "Reviewing…" : intent === "validate" ? "Review change" : `Run ${intent}`}</button>
      </section>
      <section className="project-stats">{project !== undefined && <><span>{project.indexedFiles} files indexed</span><span>{project.symbols} functions, classes, and code units</span><span>{project.graphEdges} code relationships</span></>}</section>
      </>}
      {tab === "settings" ? <ConfigurationPanel runtime={runtime} onRuntime={setRuntime} library={conclaveLibrary} onSelectConclave={(id) => chooseConclave(id, false)} onDefaultConclave={defaultConclave} onFavoriteConclave={favoriteConclave} onCreateConclave={createConclave} /> : tab === "history" ? <HistoryPanel records={history} onContinue={continueReview} /> : intent === "validate" ? (validationRun === undefined ? <Empty title="From code change to a safer PR" detail="Choose the change, confirm its objective, and let Conclave collect the context a reviewer or coding agent needs next." /> : <><ValidationWorkspace result={validationRun} tab={tab} onSelect={setTab} />{tab === "findings" && project?.source === "local" && <FeedbackPanel key={validationRun.report.lineage.reviewId} projectId={project.id} report={validationRun.report} />}</>) : !showResults ? <section className="empty"><h2>Ask the repository</h2><p>Type a focused question or a suspected behavior above, then press Run (or ⌘/Ctrl + Enter).</p>{runtime !== undefined && !runtime.available && <button type="button" onClick={() => setTab("settings")}>Set up a provider first</button>}</section> : <><div className="result-tabs" role="tablist" aria-label="Result views"><button role="tab" aria-selected={tab === "verdict"} onClick={() => setTab("verdict")}>Verdict</button><button role="tab" aria-selected={tab === "evidence"} onClick={() => setTab("evidence")}>Evidence</button><button role="tab" aria-selected={tab === "graph"} onClick={() => setTab("graph")}>Graph</button><button role="tab" aria-selected={tab === "retrieval"} onClick={() => setTab("retrieval")}>Retrieval</button></div>{run.error !== undefined ? <section className="error-card"><span>Error · {run.error.code}</span><h2>{run.title}</h2><p>{run.error.message}</p><p>{run.error.action}</p><button type="button" onClick={() => setTab("settings")}>Configure provider</button></section> : tab === "verdict" ? <section className="verdict"><header><span className={`verdict-status ${run.status}`}>{statusLabel(run.status)}</span><h2>{run.title}</h2></header><p className="answer">{run.answer}</p><Claims run={run} onEvidence={(id) => { setSelectedEvidence(id); setTab("evidence"); }} /><section className="trace"><h3>Bounded role route</h3>{run.trace.map((item) => <div key={item.role}><strong>{item.role}</strong><span>{item.status === "ran" ? "✓ ran" : "○ skipped"}</span><small>{item.reason}</small></div>)}</section><section className="metrics">{run.metrics.map((metric) => <div key={metric.label}><strong>{metric.value}</strong><span>{metric.label}</span></div>)}</section></section> : tab === "evidence" ? <EvidencePanel evidence={run.evidence} selected={selectedEvidence} onSelect={setSelectedEvidence} /> : tab === "graph" ? <GraphPanel graph={run.graph} onSearch={(value) => void explore(value)} /> : <RetrievalPanel run={run} />}</>}
    </section>
  </main>;
}
