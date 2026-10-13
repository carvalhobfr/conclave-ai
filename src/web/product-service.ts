import { listFindingFeedback, recordFindingFeedback } from "../storage/finding-feedback.js";
import type { FindingDisposition, TriageActor } from "../domain/finding-ledger.js";
import { ProposalError, type ProposalEdit } from "../validation/issue-proposal.js";
import { TriageError, TriageService, type FindingFilter, type ProposalFilter } from "../workflow/triage-service.js";
import { loadAcceptanceContract, saveAcceptanceContract } from "../storage/acceptance-contract.js";
import { parseEvidenceReceiptEnvelope } from "../validation/evidence-receipts.js";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { AUDIT_DIRECTORY, AUDIT_LATEST_FILENAME, auditRepositoryWithLedger, SEMANTIC_CACHE_FILENAME } from "../analysis/repository-audit.js";
import { parseSemanticCache } from "../analysis/semantic-discovery.js";
import { resolveSemanticSetup } from "../analysis/semantic-setup.js";
import type { AuditReport } from "../domain/audit.js";
import { existingStateDirectory, readStateFile } from "../storage/state-file.js";

import { MultiLanguageCodeParser } from "../code-intelligence/multi-language-parser.js";
import type { RepositoryCodeIndex } from "../domain/code-index.js";
import { loadReasoningConfiguration } from "../config/reasoning-config.js";
import { activeEnvironmentPath, updateConclaveEnvironment } from "../config/environment-file.js";
import { describeRuntimeConfig, loadRuntimeConfig } from "../config/runtime-config.js";
import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { CredentialSource } from "../domain/storage.js";
import type { Evidence } from "../domain/evidence.js";
import { DEFAULT_REASONING_LIMITS, type ReasoningResult } from "../domain/reasoning.js";
import type { ChangeSet, ChangeSource, ValidationReport } from "../domain/validation.js";
import { LocalHashEmbeddingProvider } from "../embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../indexing/repository-indexer.js";
import { createRoleProviders } from "../providers/provider-factory.js";
import type { FetchLike } from "../providers/openai-compatible-provider.js";
import { diagnoseProvider, type ProviderDiagnostics } from "../providers/provider-diagnostics.js";
import { LocalFolderRepository } from "../repositories/local-folder-repository.js";
import { StructuredAgentRuntime } from "../reasoning/agent-runtime.js";
import { inferReasoningChangeContext } from "../reasoning/change-context.js";
import { ReasoningEngine, type ReasoningMode } from "../reasoning/reasoning-engine.js";
import { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";
import { isPathInside, resolveRepositoryRoot } from "../security/path-policy.js";
import { EnvironmentCredentialSource } from "../storage/environment-credential-source.js";
import { createValidationContract, parseValidationContract } from "../validation/contract-parser.js";
import { createDeterministicValidationIndex } from "../validation/deterministic-index.js";
import { GitChangeSetService } from "../validation/git-change-set.js";
import { SuperValidator } from "../validation/super-validator.js";
import { createReviewHandoff } from "../domain/review-handoff.js";
import { createPullRequestSummary } from "../domain/pr-summary.js";
import { listReviewHistory, saveReviewHistory } from "../storage/review-history.js";
import { inferredReviewObjective, inspectRepository } from "../workflow/repository-inspector.js";
import { createDemoReasoningEngine } from "./demo-runtime.js";
import type {
  ArchitectureView,
  AuditJobView,
  AuditMode,
  AuditPreflightView,
  AuditStartRequest,
  ClaimView,
  EvidenceView,
  GraphView,
  ProductIntent,
  ProductRunView,
  ProjectView,
  RuntimeModeView,
  RuntimeConfigurationRequest,
  RuntimeConfigurationResult,
  RuntimeModelDiscoveryRequest,
  RuntimeModelsView,
  TraceView,
  ValidationRunView,
  ReviewHistoryView,
} from "./contracts.js";
import { REASONING_ROLE_NAMES } from "./contracts.js";

interface ProjectSession {
  readonly id: string;
  readonly root: string;
  readonly source: "demo" | "local";
  readonly project: ProjectView;
  readonly index: RepositoryCodeIndex;
  readonly retrieval: CodeRetrievalService;
  readonly reasoning?: ReasoningEngine;
}

const COCKPIT_ACTOR: TriageActor = { kind: "api", name: "cockpit" };
const JOB_PROGRESS_LINES = 60;
const ARCHITECTURE_MODULES = 40;
const ARCHITECTURE_DEPENDENCIES = 80;
const ARCHITECTURE_HUBS = 15;

/** The directory a file belongs to for the architecture view: its first two path segments. */
function moduleOf(path: string): string {
  const segments = path.split("/");
  return segments.length <= 1 ? "(root)" : segments.slice(0, Math.min(2, segments.length - 1)).join("/");
}

export class ProductServiceError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly action: string,
  ) {
    super(message);
    this.name = "ProductServiceError";
  }
}

function maskCredential(value: string | undefined): string | undefined {
  const credential = value?.trim();
  if (credential === undefined || credential === "") return undefined;
  if (credential.length < 12) return "••••••";
  return `${credential.slice(0, 2)}••••••${credential.slice(-4)}`;
}

function viewEvidence(item: Evidence): EvidenceView {
  return {
    id: item.id,
    path: item.path,
    startLine: item.startLine,
    endLine: item.endLine,
    ...(item.symbol === undefined ? {} : { symbol: item.symbol }),
    excerpt: item.excerpt,
    origin: item.provenance.origin,
  };
}

function viewClaims(result: ReasoningResult): readonly ClaimView[] {
  return [
    ...result.verdict.claims.supported.map((claim) => ({ ...claim, status: "supported" as const })),
    ...result.verdict.claims.rejected.map((claim) => ({ ...claim, status: "rejected" as const })),
    ...result.verdict.claims.uncertain.map((claim) => ({ ...claim, status: "uncertain" as const })),
  ].map((claim) => ({
    id: claim.id,
    statement: claim.statement,
    status: claim.status,
    role: claim.origin.role,
    evidenceIds: claim.evidenceIds,
    challengeCount: claim.challengeIds.length,
    verificationCount: claim.verificationIds.length,
    verificationSteps: result.state.verifications.filter((item) => item.claimId === claim.id).map((item) => ({
      id: item.id,
      basis: item.deterministic ? "retrieval" as const : "model" as const,
      outcome: item.outcome,
      explanation: item.explanation,
    })),
  }));
}

function trace(result: ReasoningResult): readonly TraceView[] {
  const roles = ["investigator", "skeptic", "architect", "verifier", "judge"];
  return roles.map((role) => {
    const executed = result.verdict.traceSummary.agentsExecuted.includes(role as never);
    const skipped = result.verdict.traceSummary.agentsSkipped.find((item) => item.role === role);
    return {
      role,
      status: executed ? "ran" : "skipped",
      reason: executed ? "Ran within the bounded reasoning route." : (skipped?.reason ?? "Not selected for this route."),
    };
  });
}

function graph(retrieval: CodeRetrievalService, query: string): GraphView {
  const resolved = retrieval.graph.getNodeBySymbol(query);
  if (resolved.status === "not-found") return { query, status: "not-found", nodes: [], edges: [], message: `No unique symbol named ${query} was found.` };
  if (resolved.status === "ambiguous") {
    return {
      query,
      status: "ambiguous",
      nodes: resolved.candidates.map((node) => ({ id: node.reference.id, label: node.symbol ?? node.path, path: node.path })),
      edges: [],
      message: "Choose a path-qualified symbol to inspect graph relations.",
    };
  }
  const relations = retrieval.graph.neighbors(resolved.node.reference, { maxDepth: 1, maxNodes: 16, maxEdges: 24 });
  const nodes = new Map<string, { readonly id: string; readonly label: string; readonly path: string }>();
  nodes.set(resolved.node.reference.id, { id: resolved.node.reference.id, label: resolved.node.symbol ?? resolved.node.path, path: resolved.node.path });
  for (const relation of relations) nodes.set(relation.node.reference.id, { id: relation.node.reference.id, label: relation.node.symbol ?? relation.node.path, path: relation.node.path });
  return {
    query,
    status: "resolved",
    nodes: [...nodes.values()],
    edges: relations.map((relation) => ({
      id: relation.edge.id,
      from: relation.direction === "incoming" ? relation.node.reference.id : resolved.node.reference.id,
      to: relation.direction === "incoming" ? resolved.node.reference.id : relation.node.reference.id,
      relation: relation.edge.relation,
      provenance: relation.edge.provenance.kind,
    })),
  };
}

function reasoningView(intent: "ask" | "investigate", result: ReasoningResult, retrieval: CodeRetrievalService): ProductRunView {
  const sourceBytes = result.state.initialContext.stats.sourceBytes;
  return {
    intent,
    status: "completed",
    title: intent === "ask" ? "Evidence-backed answer" : "Investigated verdict",
    answer: result.verdict.answer,
    claims: viewClaims(result),
    evidence: result.verdict.evidence.map(viewEvidence),
    trace: trace(result),
    retrieval: {
      operations: [
        ...(result.state.changeContext === undefined
          ? []
          : [{ label: `change-context:${result.state.changeContext.source}`, status: "executed" as const }]),
        ...result.state.initialRetrieval.plan.operations.map((operation) => ({ label: operation.kind, status: operation.status === "executed" ? "executed" as const : "skipped" as const })),
      ],
      evidenceCount: result.metrics.evidenceCount,
      sourceBytes,
      approximateTokens: result.state.initialContext.stats.approximateTokens,
    },
    metrics: [
      { label: "Model calls", value: String(result.metrics.modelCalls) },
      { label: "Retrieval rounds", value: String(result.metrics.retrievalRounds) },
      { label: "Deterministic operations", value: String(result.metrics.deterministicOperations) },
      { label: "Latency", value: `${String(Math.round(result.metrics.latencyMs))} ms` },
    ],
    graph: graph(retrieval, "bootstrapSession"),
  };
}

function demoChangeSet(index: RepositoryCodeIndex, requestedSource: ChangeSource): ChangeSet {
  const file = Object.values(index.files).find((item) => item.path.endsWith("AuthProvider.ts"))
    ?? Object.values(index.files)[0];
  if (file === undefined) {
    return {
      source: requestedSource,
      headSha: "demo-fixture",
      files: [],
      patch: "",
      collectedAt: new Date().toISOString(),
    };
  }
  const unit = file.symbolIds
    .map((id) => index.units[id])
    .find((item) => item !== undefined);
  const line = unit?.startLine ?? 1;
  return {
    source: requestedSource,
    headSha: "demo-fixture",
    files: [{
      path: file.path,
      status: "modified",
      hunks: [{ oldStart: line, oldCount: 1, newStart: line, newCount: 1 }],
    }],
    patch: "Deterministic demo change fixture",
    collectedAt: new Date().toISOString(),
  };
}

function validationView(report: ValidationReport, patch: string, demo: boolean): ValidationRunView {
  const blocking = report.findings.filter((item) => item.severity === "blocking").length;
  const warning = report.findings.filter((item) => item.severity === "warning").length;
  const supportedClaims = report.claims.filter((item) => item.outcome === "supported").length;
  const largestRisk = report.findings.find((item) => item.severity === "blocking")
    ?? report.findings.find((item) => item.severity === "warning");
  const copy = {
    pass: {
      headline: "No deterministic blocker or warning found",
      explanation: "The configured structural checks found no findings requiring attention. Delivery behavior remains unverified by this result.",
      recommendation: "Inspect the verification gaps and relevant execution evidence before requesting human approval.",
    },
    warn: {
      headline: "Change needs review before approval",
      explanation: "No blocking contradiction was found, but Conclave identified risk that deserves attention.",
      recommendation: "Review the highest-risk finding and its affected code before approving.",
    },
    block: {
      headline: "Do not approve this change",
      explanation: "Deterministic evidence contradicts the resolution, its claims, or its allowed scope.",
      recommendation: "Correct the blocking findings, then run validation again.",
    },
    inconclusive: {
      headline: "Conclave needs more evidence",
      explanation: "The available index cannot honestly prove whether this resolution is safe and complete.",
      recommendation: "Provide the missing baseline or more precise evidence, then revalidate.",
    },
  }[report.verdict];
  return {
    intent: "validate",
    verdict: report.verdict,
    ...copy,
    ...(largestRisk === undefined ? {} : {
      largestRisk: {
        title: largestRisk.title,
        detail: largestRisk.detail,
        severity: largestRisk.severity,
      },
    }),
    counts: {
      blocking,
      warning,
      supportedClaims,
      totalClaims: report.claims.length,
    },
    report,
    patch,
    handoff: createReviewHandoff(report).prompt,
    demo,
  };
}

export class ConclaveProductService {
  readonly #sessions = new Map<string, ProjectSession>();
  readonly #auditJobs = new Map<string, AuditJobView>();
  readonly #demoRoot: string;
  readonly #allowedRoot: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #environmentPath: string;
  readonly #diagnose: (config: RuntimeConfig, credentials: CredentialSource) => Promise<ProviderDiagnostics>;
  readonly #fetch: FetchLike;

  public constructor(options: {
    readonly demoRoot?: string;
    readonly allowedRoot?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly environmentPath?: string;
    readonly diagnose?: (config: RuntimeConfig, credentials: CredentialSource) => Promise<ProviderDiagnostics>;
    readonly fetchImplementation?: FetchLike;
  } = {}) {
    this.#demoRoot = resolve(options.demoRoot ?? "demo/auth-repository");
    this.#allowedRoot = resolve(options.allowedRoot ?? process.env["CONCLAVE_WEB_ALLOWED_ROOT"] ?? process.cwd());
    this.#environment = options.environment ?? process.env;
    this.#environmentPath = resolve(options.environmentPath ?? activeEnvironmentPath());
    this.#diagnose = options.diagnose ?? diagnoseProvider;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  public async openDemo(): Promise<ProjectView> {
    return this.#open(this.#demoRoot, "demo");
  }

  public async openLocal(path: string): Promise<ProjectView> {
    const root = await resolveRepositoryRoot(path).catch(() => undefined);
    const canonicalRoot = root === undefined ? undefined : await realpath(root).catch(() => root);
    const canonicalAllowedRoot = await realpath(this.#allowedRoot).catch(() => this.#allowedRoot);
    if (canonicalRoot === undefined || !isPathInside(canonicalAllowedRoot, canonicalRoot)) {
      throw new ProductServiceError("repository_denied", "This local server only opens folders beneath its configured allowed root.", "Set CONCLAVE_WEB_ALLOWED_ROOT, then choose a repository inside it.");
    }
    return this.#open(canonicalRoot, "local");
  }

  public project(id: string): ProjectView {
    return this.#session(id).project;
  }

  public async feedback(id: string) { return listFindingFeedback(this.#session(id).root); }
  public async saveFeedback(id: string, reviewId: string, value: unknown) {
    const session = this.#session(id);
    if (session.source === "demo") throw new Error("Feedback is available for local reviews");
    const report = (await listReviewHistory(session.root)).find((item) => item.report?.lineage.reviewId === reviewId)?.report;
    if (report === undefined) throw new Error("Select a saved review before recording feedback");
    return recordFindingFeedback(session.root, report, value);
  }

  /**
   * The audit triage workflow for an opened local repository. Every failure the workflow itself
   * raises is a request problem with a message meant for the person, so it is surfaced as such.
   */
  async #triage<T>(id: string, action: (service: TriageService) => Promise<T>): Promise<T> {
    const session = this.#session(id);
    if (session.source === "demo") throw new ProductServiceError("triage_unavailable", "Findings and issue proposals are available for local repositories.", "Open a local repository.");
    try {
      return await action(await TriageService.open(session.root));
    } catch (error) {
      if (error instanceof TriageError || error instanceof ProposalError) throw new ProductServiceError(error.code, error.message, "Check the finding or proposal and try again.");
      throw error;
    }
  }

  #localSession(id: string): ProjectSession {
    const session = this.#session(id);
    if (session.source === "demo") throw new ProductServiceError("audit_unavailable", "Repository audits are available for local repositories.", "Open a local repository.");
    return session;
  }

  /** The report of the last audit that was allowed to write, or `null` when there is none. */
  public async latestAudit(id: string): Promise<AuditReport | null> {
    const directory = await existingStateDirectory(this.#localSession(id).root, AUDIT_DIRECTORY);
    if (directory === undefined) return null;
    const saved = await readStateFile(join(directory, AUDIT_LATEST_FILENAME)).catch(() => undefined);
    const value = saved?.value as Partial<AuditReport> | undefined;
    return value?.kind === "repository-audit" && value.schemaVersion === 1 ? value as AuditReport : null;
  }

  /** What an audit in this mode would call and send. Reads configuration only; calls no model. */
  public async auditPreflight(id: string, mode: AuditMode, request: Pick<AuditStartRequest, "budget" | "discoveryModel" | "verifierModel"> = {}): Promise<AuditPreflightView> {
    const session = this.#localSession(id);
    const directory = await existingStateDirectory(session.root, AUDIT_DIRECTORY);
    const cache = directory === undefined ? undefined : parseSemanticCache((await readStateFile(join(directory, SEMANTIC_CACHE_FILENAME)).catch(() => undefined))?.value);
    const cachedRegions = Object.keys(cache?.discoveries ?? {}).length;
    if (mode === "static") return { mode, available: true, cachedRegions };
    try {
      const { disclosure } = resolveSemanticSetup({ budget: request.budget ?? {}, deep: mode === "deep", ...(request.discoveryModel === undefined ? {} : { discoveryModel: request.discoveryModel }), ...(request.verifierModel === undefined ? {} : { verifierModel: request.verifierModel }) }, this.#environment);
      return { mode, available: true, disclosure, cachedRegions };
    } catch (error) {
      // Configuration errors name variables and providers, never credential values.
      return { mode, available: false, reason: error instanceof Error ? error.message : "No model provider is configured.", cachedRegions };
    }
  }

  public auditStatus(id: string): AuditJobView | null {
    this.#localSession(id);
    return this.#auditJobs.get(id) ?? null;
  }

  /**
   * Starts one audit and returns at once; `auditStatus` reports on it. A semantic mode is
   * refused without the explicit acknowledgement, so no request shape can start model calls by
   * omission. The audit itself is the same one the CLI runs and writes the same local state.
   */
  public startAudit(id: string, request: Omit<AuditStartRequest, "projectId">): AuditJobView {
    const session = this.#localSession(id);
    if (this.#auditJobs.get(id)?.state === "running") throw new ProductServiceError("audit_running", "An audit of this repository is already running.", "Wait for it to finish.");
    const semantic = request.mode === "static" ? undefined : (() => {
      if (request.acknowledgedModelCalls !== true) throw new ProductServiceError("acknowledgement_required", "A semantic audit calls a model and sends it sanitized source.", "Read the disclosure and confirm before starting.");
      try {
        return resolveSemanticSetup({ budget: request.budget ?? {}, deep: request.mode === "deep", ...(request.discoveryModel === undefined ? {} : { discoveryModel: request.discoveryModel }), ...(request.verifierModel === undefined ? {} : { verifierModel: request.verifierModel }) }, this.#environment).options;
      } catch (error) {
        throw new ProductServiceError("provider_unavailable", error instanceof Error ? error.message : "No model provider is configured.", "Configure a provider in Settings.");
      }
    })();
    const started: AuditJobView = { id: randomUUID(), mode: request.mode, state: "running", startedAt: new Date().toISOString(), progress: [] };
    this.#auditJobs.set(id, started);
    const update = (change: Partial<AuditJobView>): void => {
      const current = this.#auditJobs.get(id);
      if (current?.id === started.id) this.#auditJobs.set(id, { ...current, ...change });
    };
    const progress = (line: string): void => update({ progress: [...(this.#auditJobs.get(id)?.progress ?? []), line].slice(-JOB_PROGRESS_LINES) });
    progress(request.mode === "static" ? "Indexing and running rules" : "Indexing, running rules, then calling the model");
    void auditRepositoryWithLedger(session.root, { write: true, ...(semantic === undefined ? {} : { semantic: { ...semantic, onProgress: progress } }) })
      .then(() => update({ state: "completed", finishedAt: new Date().toISOString() }))
      .catch((error: unknown) => update({ state: "failed", finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message.slice(0, 500) : "The audit could not run." }));
    return started;
  }

  /** Structure of the opened repository, from the index built when it was opened. Deterministic. */
  public architecture(id: string): ArchitectureView {
    const { index } = this.#session(id);
    const pathOf = (node: { readonly kind: string; readonly id: string }): string | undefined => node.kind === "file" ? node.id : index.units[node.id]?.path;
    const languages = new Map<string, number>();
    const modules = new Map<string, { files: number; symbols: number; dependsOn: Set<string>; usedBy: Set<string> }>();
    const moduleEntry = (name: string) => {
      const existing = modules.get(name);
      if (existing !== undefined) return existing;
      const created = { files: 0, symbols: 0, dependsOn: new Set<string>(), usedBy: new Set<string>() };
      modules.set(name, created);
      return created;
    };
    for (const file of Object.values(index.files)) {
      languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
      const entry = moduleEntry(moduleOf(file.path));
      entry.files += 1;
      entry.symbols += file.symbolIds.length;
    }
    const dependencies = new Map<string, number>();
    const hubs = new Map<string, { incoming: number; outgoing: number }>();
    for (const edge of index.graphEdges) {
      const [from, to] = [pathOf(edge.from), pathOf(edge.to)];
      if (from === undefined || to === undefined || from === to) continue;
      const [source, target] = [hubs.get(from) ?? { incoming: 0, outgoing: 0 }, hubs.get(to) ?? { incoming: 0, outgoing: 0 }];
      hubs.set(from, { ...source, outgoing: source.outgoing + 1 });
      hubs.set(to, { ...target, incoming: target.incoming + 1 });
      const [fromModule, toModule] = [moduleOf(from), moduleOf(to)];
      if (fromModule === toModule) continue;
      dependencies.set(`${fromModule}\0${toModule}`, (dependencies.get(`${fromModule}\0${toModule}`) ?? 0) + 1);
      moduleEntry(fromModule).dependsOn.add(toModule);
      moduleEntry(toModule).usedBy.add(fromModule);
    }
    const notIndexed = new Map<string, number>();
    for (const gap of index.coverage?.gaps ?? []) notIndexed.set(gap.reason, (notIndexed.get(gap.reason) ?? 0) + 1);
    const moduleList = [...modules].map(([name, entry]) => ({ name, files: entry.files, symbols: entry.symbols, dependsOn: entry.dependsOn.size, usedBy: entry.usedBy.size }))
      .sort((left, right) => right.usedBy + right.dependsOn - (left.usedBy + left.dependsOn) || right.files - left.files || left.name.localeCompare(right.name));
    const dependencyList = [...dependencies].map(([key, relations]) => { const [from = "", to = ""] = key.split("\0"); return { from, to, relations }; })
      .sort((left, right) => right.relations - left.relations || left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
    return {
      files: Object.keys(index.files).length,
      symbols: Object.keys(index.units).length,
      relations: index.graphEdges.length,
      languages: [...languages].map(([language, files]) => ({ language, files })).sort((left, right) => right.files - left.files || left.language.localeCompare(right.language)),
      modules: moduleList.slice(0, ARCHITECTURE_MODULES),
      dependencies: dependencyList.slice(0, ARCHITECTURE_DEPENDENCIES),
      hubs: [...hubs].map(([path, degree]) => ({ path, ...degree })).sort((left, right) => right.incoming + right.outgoing - (left.incoming + left.outgoing) || left.path.localeCompare(right.path)).slice(0, ARCHITECTURE_HUBS),
      notIndexed: [...notIndexed].map(([reason, entries]) => ({ reason, entries })).sort((left, right) => right.entries - left.entries),
      omitted: { modules: Math.max(0, moduleList.length - ARCHITECTURE_MODULES), dependencies: Math.max(0, dependencyList.length - ARCHITECTURE_DEPENDENCIES) },
    };
  }

  public async auditRuns(id: string) { return this.#triage(id, (service) => service.listAuditRuns()); }
  public async findings(id: string, filter: FindingFilter) { return this.#triage(id, (service) => service.listFindings(filter)); }
  public async finding(id: string, reference: string) {
    return this.#triage(id, async (service) => ({ ...(await service.getFinding(reference)), source: await service.readFindingEvidence(reference) }));
  }
  public async classifyFinding(id: string, reference: string, classification: FindingDisposition, note: string | undefined) {
    return this.#triage(id, (service) => service.classifyFinding(reference, { classification, ...(note === undefined ? {} : { note }), actor: COCKPIT_ACTOR }));
  }
  public async issueProposals(id: string, filter: ProposalFilter) { return this.#triage(id, (service) => service.listProposals(filter)); }
  public async issueProposal(id: string, reference: string) { return this.#triage(id, (service) => service.getProposal(reference)); }
  public async proposeIssue(id: string, findingReference: string, reason: string | undefined) {
    return this.#triage(id, (service) => service.createProposal(findingReference, { actor: COCKPIT_ACTOR, ...(reason === undefined ? {} : { reason }) }));
  }
  public async editIssueProposal(id: string, reference: string, edit: ProposalEdit) { return this.#triage(id, (service) => service.editProposal(reference, edit, COCKPIT_ACTOR)); }
  public async submitIssueProposal(id: string, reference: string) { return this.#triage(id, (service) => service.submitProposal(reference, COCKPIT_ACTOR)); }
  /** `revision` is the one the person was shown; a proposal edited since then is not approved by this call. */
  public async approveIssueProposal(id: string, reference: string, revision: string) {
    return this.#triage(id, (service) => service.approveProposal(reference, { revision, actor: COCKPIT_ACTOR, method: "api-revision" }));
  }
  public async rejectIssueProposal(id: string, reference: string, reason: string) { return this.#triage(id, (service) => service.rejectProposal(reference, { reason, actor: COCKPIT_ACTOR })); }
  public async markIssueProposalReady(id: string, reference: string) { return this.#triage(id, (service) => service.markProposalReady(reference, COCKPIT_ACTOR)); }
  public async refreshIssueProposal(id: string, reference: string) { return this.#triage(id, (service) => service.refreshProposal(reference, COCKPIT_ACTOR)); }

  public async acceptance(id: string) {
    const session = this.#session(id);
    return session.source === "demo" ? null : loadAcceptanceContract(session.root);
  }

  public async saveAcceptance(id: string, value: unknown, revision: string | null) {
    const session = this.#session(id);
    if (session.source === "demo") throw new Error("Open a local repository to save acceptance criteria");
    return saveAcceptanceContract(session.root, value, revision);
  }

  public async validate(
    id: string,
    source: ChangeSource,
    objective: string,
    contractValue?: unknown,
    options: { readonly previousReviewId?: string; readonly receipts?: unknown; readonly newSeries?: boolean } = {},
  ): Promise<ValidationRunView> {
    if (objective.trim() === "") {
      throw new ProductServiceError(
        "empty_objective",
        "Describe what this change is supposed to resolve.",
        "Provide a concrete validation objective.",
      );
    }
    const session = this.#session(id);
    let contract;
    try {
      const saved = contractValue === undefined ? await this.acceptance(id) : null;
      contract = contractValue === undefined
        ? saved === null ? createValidationContract(objective) : parseValidationContract(saved.contract, objective)
        : parseValidationContract(contractValue, objective);
    } catch (error) {
      throw new ProductServiceError(
        "invalid_contract",
        error instanceof Error ? error.message : "Validation contract is invalid.",
        "Correct the optional contract JSON and retry.",
      );
    }
    try {
      if (options.newSeries && options.previousReviewId) throw new Error("Choose either a new series or a previous review");
      const previousReport = options.previousReviewId === undefined ? undefined : (await listReviewHistory(session.root)).find((item) => item.report?.lineage.reviewId === options.previousReviewId)?.report;
      if (options.previousReviewId !== undefined && previousReport === undefined) throw new Error("Previous review is unavailable; select a saved report or explicitly start a new series");
      const context = { ...(previousReport === undefined ? {} : { previousReport }), receipts: options.receipts === undefined ? [] : parseEvidenceReceiptEnvelope(options.receipts), newSeries: options.newSeries === true };
      const changeSet = session.source === "demo"
        ? demoChangeSet(session.index, source)
        : await new GitChangeSetService().collect(session.root, source);
      if (session.source === "demo") {
      return validationView(new SuperValidator().validate(session.index, changeSet, contract, context), changeSet.patch, true);
      }
      const changeService = new GitChangeSetService();
      const materialized = await changeService.materializeValidationRoot(session.root, source);
      try {
        const indexed = await createDeterministicValidationIndex(materialized.rootPath);
      const report = new SuperValidator().validate(indexed.index, changeSet, contract, context);
      const summary = createPullRequestSummary(report);
      const handoff = createReviewHandoff(report);
      await saveReviewHistory(session.root, {
        id: report.lineage.reviewId,
        createdAt: new Date().toISOString(),
        repository: session.root,
        objective: report.objective,
        headSha: report.changeSet.headSha,
        summary,
        report,
        handoff,
      });
      return validationView(report, changeSet.patch, false);
      } finally {
        await materialized.cleanup();
      }
    } catch (error) {
      throw new ProductServiceError(
        "validation_unavailable",
        error instanceof Error ? error.message : "The change could not be validated.",
        "Check the selected Git source and repository state, then retry.",
      );
    }
  }

  public async run(id: string, intent: "ask" | "investigate", question: string): Promise<ProductRunView> {
    if (question.trim() === "") throw new ProductServiceError("empty_query", "Enter a repository question before running Conclave.", "Write a specific code question.");
    const session = this.#session(id);
    try {
      const engine = session.source === "demo" ? await createDemoReasoningEngine(session.root) : await this.#liveReasoning(session);
      const mode: ReasoningMode = intent === "ask" ? "investigator-judge" : "conclave";
      return reasoningView(intent, await engine.ask(question, mode), session.retrieval);
    } catch (error) {
      return this.#error(intent, error, "Configure a supported provider in the local server environment, or switch to Demo Mode.", session.retrieval);
    }
  }

  public graph(id: string, symbol: string): GraphView {
    return graph(this.#session(id).retrieval, symbol);
  }

  public runtime(): RuntimeModeView {
    try {
      const config = loadRuntimeConfig(this.#environment);
      const credentials = new EnvironmentCredentialSource(this.#environment);
      const publicConfig = describeRuntimeConfig(config, credentials);
      const reasoning = loadReasoningConfiguration(config, this.#environment);
      const credential = config.mode === "local" ? undefined : credentials.get(config.credentialEnvironmentVariable);
      const credentialHint = maskCredential(credential);
      return {
        active: config.mode,
        available: true,
        provider: config.providerSelection.provider,
        ...(config.providerSelection.model === undefined ? {} : { model: config.providerSelection.model }),
        ...(config.providerSelection.baseUrl === undefined ? {} : { baseUrl: config.providerSelection.baseUrl }),
        credentialConfigured: publicConfig.credentialConfigured,
        ...(credentialHint === undefined ? {} : { credentialHint }),
        reasoningPreset: reasoning.preset,
        message: config.mode === "local" ? "Configured loopback model endpoint; repository excerpts stay on this machine when every selected component is local." : "Provider configuration is held by the local server process.",
        roles: reasoning.assignments.map((assignment) => ({ role: assignment.role, provider: assignment.providerId, model: assignment.modelId })),
      };
    } catch (error) {
      return { active: "demo", available: false, message: error instanceof Error ? error.message : "Provider configuration is unavailable.", roles: [] };
    }
  }

  public async configureRuntime(input: RuntimeConfigurationRequest): Promise<RuntimeConfigurationResult> {
    const model = input.model.trim();
    const baseUrl = input.baseUrl.trim();
    const apiKey = input.apiKey?.trim();
    if (model === "") throw new ProductServiceError("invalid_runtime_configuration", "A model is required.", "Choose a model and try again.");
    if (baseUrl === "") throw new ProductServiceError("invalid_runtime_configuration", "A provider endpoint is required.", "Choose a provider endpoint and try again.");
    if (input.mode === "local" && input.reasoningPreset !== "local") {
      throw new ProductServiceError("invalid_runtime_configuration", "Local Mode requires the local reasoning preset.", "Select Local Mode again.");
    }
    if (input.mode === "api" && input.reasoningPreset === "local") {
      throw new ProductServiceError("invalid_runtime_configuration", "External providers cannot use the local reasoning preset.", "Select fast or full reasoning.");
    }

    const existingApiKey = this.#environment["CONCLAVE_API_KEY"]?.trim();
    const effectiveApiKey = apiKey === undefined || apiKey === "" ? existingApiKey : apiKey;
    if (input.mode === "api" && effectiveApiKey === undefined) {
      throw new ProductServiceError("credential_required", "An API key is required for this provider.", "Paste the provider key; it will not be returned to the browser.");
    }

    const values: Record<string, string> = {
      CONCLAVE_MODE: input.mode,
      CONCLAVE_PROVIDER: input.provider,
      CONCLAVE_MODEL: model,
      CONCLAVE_BASE_URL: baseUrl,
      CONCLAVE_REASONING_PRESET: input.reasoningPreset,
    };
    for (const role of REASONING_ROLE_NAMES) {
      values[`CONCLAVE_${role.toUpperCase()}_PROVIDER`] = input.roles?.[role]?.provider ?? input.provider;
      values[`CONCLAVE_${role.toUpperCase()}_MODEL`] = input.roles?.[role]?.model.trim() || model;
    }
    // Always written so switching to a preset without a fallback clears the previous one.
    values["CONCLAVE_FALLBACK_MODEL"] = input.fallbackModel?.trim() ?? "";
    if (input.mode === "api" && effectiveApiKey !== undefined) values["CONCLAVE_API_KEY"] = effectiveApiKey;

    const candidate = { ...this.#environment, ...values };
    let config: RuntimeConfig;
    try {
      config = loadRuntimeConfig(candidate);
      const reasoning = loadReasoningConfiguration(config, candidate);
      createRoleProviders(config, reasoning.assignments, new EnvironmentCredentialSource(candidate));
    } catch (error) {
      throw new ProductServiceError(
        "invalid_runtime_configuration",
        error instanceof Error ? error.message : "Provider configuration is invalid.",
        "Check the provider, endpoint, model, and reasoning preset.",
      );
    }

    await updateConclaveEnvironment(this.#environmentPath, values);
    Object.assign(this.#environment, values);
    const diagnostic = await this.#diagnose(config, new EnvironmentCredentialSource(this.#environment)).catch(() => ({
      mode: config.mode,
      provider: config.providerSelection.provider,
      endpoint: config.providerSelection.baseUrl,
      modelConfigured: config.providerSelection.model !== undefined,
      endpointReachable: false,
      inferenceAvailable: false,
      retrievalLocal: true as const,
      externalCallsDisabled: config.mode === "local",
      message: "Conclave could not complete the bounded provider inference check. Check endpoint, model, and server-side credentials.",
    }));
    return {
      saved: true,
      credentialUpdated: apiKey !== undefined && apiKey !== "",
      runtime: this.runtime(),
      diagnostic,
    };
  }

  public async discoverModels(input: RuntimeModelDiscoveryRequest): Promise<RuntimeModelsView> {
    const baseUrl = input.baseUrl.trim();
    if (baseUrl === "") throw new ProductServiceError("invalid_runtime_configuration", "A provider endpoint is required.", "Choose a provider endpoint and try again.");
    const apiKey = input.apiKey?.trim();
    const effectiveApiKey = apiKey === undefined || apiKey === "" ? this.#environment["CONCLAVE_API_KEY"]?.trim() : apiKey;
    if (input.mode === "api" && effectiveApiKey === undefined) {
      throw new ProductServiceError("credential_required", "An API key is required to list models for this provider.", "Paste the provider key, then load the available models.");
    }
    const candidate: NodeJS.ProcessEnv = {
      ...this.#environment,
      CONCLAVE_MODE: input.mode,
      CONCLAVE_PROVIDER: input.provider,
      CONCLAVE_MODEL: "model-discovery",
      CONCLAVE_BASE_URL: baseUrl,
      ...(effectiveApiKey === undefined ? {} : { CONCLAVE_API_KEY: effectiveApiKey }),
    };
    let config: RuntimeConfig;
    try {
      config = loadRuntimeConfig(candidate);
    } catch (error) {
      throw new ProductServiceError(
        "invalid_runtime_configuration",
        error instanceof Error ? error.message : "Provider configuration is invalid.",
        "Check the provider and endpoint.",
      );
    }
    const configuredBaseUrl = config.providerSelection.baseUrl;
    if (configuredBaseUrl === undefined) {
      throw new ProductServiceError("provider_models_unavailable", "This provider does not expose a configured models endpoint.", "Enter an explicit provider endpoint.");
    }
    const endpoint = new URL("models", configuredBaseUrl.endsWith("/") ? configuredBaseUrl : `${configuredBaseUrl}/`).toString();
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        headers: effectiveApiKey === undefined ? {} : { authorization: `Bearer ${effectiveApiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ProductServiceError("provider_models_unreachable", "Conclave could not reach the provider models endpoint.", "Check the endpoint and network connection.");
    }
    if (!response.ok) {
      const message = response.status === 401
        ? "The provider rejected the API key while listing models (HTTP 401)."
        : response.status === 403
          ? "The provider denied access to its model list (HTTP 403)."
          : `The provider models endpoint returned HTTP ${String(response.status)}.`;
      throw new ProductServiceError("provider_models_rejected", message, "Check the provider key, subscription, and endpoint.");
    }
    const text = await response.text();
    if (text.length > 2_000_000) {
      throw new ProductServiceError("provider_models_invalid", "The provider model list exceeds the local response limit.", "Use a provider with a bounded OpenAI-compatible models response.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProductServiceError("provider_models_invalid", "The provider returned an invalid model list.", "Check that the endpoint implements the OpenAI-compatible /models contract.");
    }
    const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    const entries = Array.isArray(record?.["data"])
      ? record["data"]
      : Array.isArray(record?.["models"])
        ? record["models"]
        : Array.isArray(payload) ? payload : [];
    const models = [...new Set(entries.flatMap((entry) => {
      if (typeof entry === "string") return [entry.trim()];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const model = entry as Record<string, unknown>;
      const id = typeof model["id"] === "string" ? model["id"] : typeof model["name"] === "string" ? model["name"] : undefined;
      return id === undefined ? [] : [id.trim()];
    }).filter((id) => id !== "" && id.length <= 256))].slice(0, 250);
    if (models.length === 0) {
      throw new ProductServiceError("provider_models_empty", "The provider returned no selectable model IDs.", "Check the provider account and models endpoint.");
    }
    return { provider: input.provider, endpoint, models };
  }

  public async history(id: string): Promise<readonly ReviewHistoryView[]> {
    const session = this.#session(id);
    if (session.source === "demo") return [];
    return (await listReviewHistory(session.root)).map((record) => ({
      id: record.id,
      createdAt: record.createdAt,
      objective: record.objective,
      verdict: record.summary.verdict,
      title: record.summary.title,
      ...(record.report === undefined ? {} : { report: record.report }),
      ...(record.handoff === undefined ? {} : { handoff: record.handoff.prompt }),
    }));
  }

  async #open(root: string, source: "demo" | "local"): Promise<ProjectView> {
    // Opening and reviewing a repository is always local and deterministic.
    // Provider calls are reserved for explicit Ask/Investigate runs.
    const embedding = new LocalHashEmbeddingProvider();
    const indexed = await new RepositoryIndexer({ repositorySource: new LocalFolderRepository(), parser: new MultiLanguageCodeParser(), embeddingProvider: embedding, indexStore: new InMemoryCodeIndexStore() }).index(root);
    const id = `${source}:${indexed.index.repository.id}`;
    const languages = [...new Set(Object.values(indexed.index.files).map((file) => file.language))].sort();
    const project: ProjectView = {
      id,
      name: basename(root),
      path: source === "demo" ? "Demo repository · auth lifecycle" : root,
      source,
      gitStatus: source === "demo" ? "demo" : "unknown",
      languages,
      indexedFiles: Object.keys(indexed.index.files).length,
      symbols: Object.keys(indexed.index.units).length,
      graphNodes: Object.keys(indexed.index.files).length + Object.keys(indexed.index.units).length,
      graphEdges: indexed.index.graphEdges.length,
      updatedAt: indexed.index.updatedAt,
      ...(source === "demo" ? {} : await inspectRepository(root).then((inspection) => ({
        git: {
          currentBranch: inspection.currentBranch,
          defaultBase: inspection.defaultBase,
          branches: inspection.branches,
          staged: inspection.status.staged,
          unstaged: inspection.status.unstaged,
          untracked: inspection.status.untracked,
          suggestedObjective: inferredReviewObjective(inspection),
        },
      })).catch(() => ({}))),
    };
    this.#sessions.set(id, { id, root, source, project, index: indexed.index, retrieval: new CodeRetrievalService(indexed.index, embedding) });
    return project;
  }

  #session(id: string): ProjectSession {
    const session = this.#sessions.get(id);
    if (session === undefined) throw new ProductServiceError("project_missing", "This project session is no longer available.", "Open the repository again.");
    return session;
  }

  async #liveReasoning(session: ProjectSession): Promise<ReasoningEngine> {
    const runtime = loadRuntimeConfig(this.#environment);
    const reasoning = loadReasoningConfiguration(runtime, this.#environment);
    const providers = createRoleProviders(runtime, reasoning.assignments, new EnvironmentCredentialSource(this.#environment));
    const changeContext = await inferReasoningChangeContext(session.root, session.retrieval);
    return new ReasoningEngine({
      retrieval: session.retrieval,
      runtime: new StructuredAgentRuntime(providers, reasoning.assignments, DEFAULT_REASONING_LIMITS),
      preset: reasoning.preset,
      ...(changeContext === undefined ? {} : { changeContext }),
    });
  }

  #error(intent: Exclude<ProductIntent, "validate">, error: unknown, action: string, retrieval: CodeRetrievalService): ProductRunView {
    const message = error instanceof ProductServiceError ? error.message : error instanceof Error ? "Conclave could not complete this bounded run." : "Conclave could not complete this bounded run.";
    return {
      intent,
      status: "error",
      title: "Run unavailable",
      answer: "No provider response or repository mutation was accepted.",
      claims: [], evidence: [], trace: [],
      retrieval: { operations: [], evidenceCount: 0, sourceBytes: 0, approximateTokens: 0 },
      metrics: [], graph: graph(retrieval, "bootstrapSession"),
      error: { code: error instanceof ProductServiceError ? error.code : "provider_or_runtime_failure", message, action: error instanceof ProductServiceError ? error.action : action },
    };
  }
}
