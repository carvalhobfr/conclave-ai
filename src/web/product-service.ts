import { loadAcceptanceContract, saveAcceptanceContract } from "../storage/acceptance-contract.js";
import { parseEvidenceReceiptEnvelope } from "../validation/evidence-receipts.js";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { MultiLanguageCodeParser } from "../code-intelligence/multi-language-parser.js";
import type { RepositoryCodeIndex } from "../domain/code-index.js";
import { loadReasoningConfiguration } from "../config/reasoning-config.js";
import { writeConclaveEnvironment } from "../config/environment-file.js";
import { describeRuntimeConfig, loadRuntimeConfig } from "../config/runtime-config.js";
import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { CredentialSource } from "../domain/storage.js";
import type { Evidence } from "../domain/evidence.js";
import { DEFAULT_REASONING_LIMITS, type ReasoningResult } from "../domain/reasoning.js";
import type { ChangeSet, ChangeSource, ValidationReport } from "../domain/validation.js";
import { LocalHashEmbeddingProvider } from "../embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../indexing/repository-indexer.js";
import { createProvider } from "../providers/provider-factory.js";
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
import { inspectRepository } from "../workflow/repository-inspector.js";
import { createDemoReasoningEngine } from "./demo-runtime.js";
import type {
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

interface ProjectSession {
  readonly id: string;
  readonly root: string;
  readonly source: "demo" | "local";
  readonly project: ProjectView;
  readonly index: RepositoryCodeIndex;
  readonly retrieval: CodeRetrievalService;
  readonly reasoning?: ReasoningEngine;
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
    this.#environmentPath = resolve(options.environmentPath ?? ".env");
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
    for (const role of ["INVESTIGATOR", "SKEPTIC", "ARCHITECT", "VERIFIER", "JUDGE"] as const) {
      values[`CONCLAVE_${role}_PROVIDER`] = input.provider;
      values[`CONCLAVE_${role}_MODEL`] = model;
    }
    if (input.mode === "api" && effectiveApiKey !== undefined) values["CONCLAVE_API_KEY"] = effectiveApiKey;

    const candidate = { ...this.#environment, ...values };
    let config: RuntimeConfig;
    try {
      config = loadRuntimeConfig(candidate);
      loadReasoningConfiguration(config, candidate);
      createProvider(config, new EnvironmentCredentialSource(candidate));
    } catch (error) {
      throw new ProductServiceError(
        "invalid_runtime_configuration",
        error instanceof Error ? error.message : "Provider configuration is invalid.",
        "Check the provider, endpoint, model, and reasoning preset.",
      );
    }

    await writeConclaveEnvironment(this.#environmentPath, values);
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
    const provider = createProvider(runtime, new EnvironmentCredentialSource(this.#environment));
    const changeContext = await inferReasoningChangeContext(session.root, session.retrieval);
    return new ReasoningEngine({
      retrieval: session.retrieval,
      runtime: new StructuredAgentRuntime(new Map([[provider.id, provider]]), reasoning.assignments, DEFAULT_REASONING_LIMITS),
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
