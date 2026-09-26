#!/usr/bin/env node

import { smokeCommand } from "./execution/browser-smoke.js";
import { collectCommand } from "./execution/collect-evidence.js";
import { loadAttestedEvidence } from "./validation/attested-evidence.js";
import { loadAcceptanceContract, saveAcceptanceContract } from "./storage/acceptance-contract.js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { parseArguments, type ParsedArguments } from "./cli-arguments.js";
import { MultiLanguageCodeParser } from "./code-intelligence/multi-language-parser.js";
import { describeRuntimeConfig, loadRuntimeConfig } from "./config/runtime-config.js";
import { loadReasoningConfiguration } from "./config/reasoning-config.js";
import { loadConclaveEnvironment, writeConclaveEnvironment } from "./config/environment-file.js";
import {
  INTERFACE_LANGUAGES,
  languageFromEnvironment,
  loadUserPreferences,
  parseInterfaceLanguage,
  setInterfaceLanguage,
  userPreferencesPath,
  type InterfaceLanguage,
  type LoadedUserPreferences,
} from "./config/user-preferences.js";
import {
  isGuidedProviderId,
  providerProfiles,
  REASONING_STYLES,
  type GuidedProviderId,
} from "./config/provider-profiles.js";
import { createSetupConfiguration } from "./config/setup.js";
import {
  providerSetupGuide,
  renderProviderGuide,
  renderSetupBanner,
  renderSetupChoice,
  renderSetupStep,
  renderSetupSuccess,
  terminalColorEnabled,
} from "./cli-setup-presentation.js";
import { createEmbeddingProvider } from "./embeddings/embedding-factory.js";
import type { EmbeddingProvider } from "./domain/embedding.js";
import {
  loadEvaluationCases,
  runGraphAwareRetrievalEvaluation,
  runRetrievalEvaluation,
} from "./evaluation/retrieval-evaluation.js";
import {
  loadReasoningEvaluationCases,
  runReasoningEvaluation,
} from "./evaluation/reasoning-evaluation.js";
import { FileSystemCodeIndexStore } from "./indexing/file-system-index-store.js";
import { RepositoryIndexer } from "./indexing/repository-indexer.js";
import { createRoleProviders } from "./providers/provider-factory.js";
import { diagnoseProvider } from "./providers/provider-diagnostics.js";
import { ConclaveMcpService } from "./mcp/conclave-mcp-service.js";
import { runMcpStdio } from "./mcp/server.js";
import { ConclaveProductService } from "./web/product-service.js";
import { createConclaveWebServer } from "./web/server.js";
import { LocalFolderRepository } from "./repositories/local-folder-repository.js";
import { CodeRetrievalService } from "./retrieval/code-retrieval-service.js";
import { StructuredAgentRuntime } from "./reasoning/agent-runtime.js";
import { inferReasoningChangeContext } from "./reasoning/change-context.js";
import { ReasoningEngine } from "./reasoning/reasoning-engine.js";
import { DEFAULT_REASONING_LIMITS } from "./domain/reasoning.js";
import { EnvironmentCredentialSource } from "./storage/environment-credential-source.js";
import type { ChangeSource, EvidenceReceiptInput, ValidationContract, ValidationReport } from "./domain/validation.js";
import { createValidationContract, parseValidationContract } from "./validation/contract-parser.js";
import { GitChangeSetService } from "./validation/git-change-set.js";
import { createDeterministicValidationIndex } from "./validation/deterministic-index.js";
import { SuperValidator } from "./validation/super-validator.js";
import { parseEvidenceReceiptEnvelope } from "./validation/evidence-receipts.js";
import { createPullRequestSummary } from "./domain/pr-summary.js";
import { createReviewHandoff } from "./domain/review-handoff.js";
import { listReviewHistory, saveReviewHistory, type ReviewHistoryRecord } from "./storage/review-history.js";
import { inferredReviewObjective, inspectRepository } from "./workflow/repository-inspector.js";
import {
  cliHelp,
  guidedChoices,
  interfaceCopy,
  languageDisplayName,
} from "./i18n/cli-copy.js";

// User preferences are resolved before the repository .env is loaded so a project cannot
// redirect or silently override global CLI settings.
const userPreferenceEnvironment: NodeJS.ProcessEnv = { ...process.env };
const conclaveEnvironmentFile = loadConclaveEnvironment();

let cliLanguage: InterfaceLanguage = "en";
let loadedUserPreferences: LoadedUserPreferences | undefined;

async function loadCliLanguage(): Promise<void> {
  loadedUserPreferences = await loadUserPreferences(userPreferencesPath(userPreferenceEnvironment));
  cliLanguage = languageFromEnvironment(
    loadedUserPreferences.preferences.language,
    userPreferenceEnvironment,
    loadedUserPreferences.exists,
  ).language;
}

function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, undefined, 2));
    return;
  }
  console.log(value);
}

function progress(label: string, detail: string): void {
  if (process.stdout.isTTY) console.log(`\x1b[36m›\x1b[0m ${label} ${detail}`);
  else console.log(`${label}: ${detail}`);
}

function requireObjective(parsed: ParsedArguments, command: "review" | "pr"): void {
  const objective = parsed.objective?.trim() ?? "";
  if (objective === "") {
    throw new Error(`${command} requires a non-empty --objective describing what the change should deliver`);
  }
}

async function scan(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0] ?? ".";
  const snapshot = await new LocalFolderRepository().load({ path: resolve(requestedPath) });
  const languageCounts = Object.fromEntries(
    [...new Set(snapshot.files.map((file) => file.language))]
      .sort()
      .map((language) => [
        language,
        snapshot.files.filter((file) => file.language === language).length,
      ]),
  );
  const report = {
    repository: snapshot.repository,
    scannedAt: snapshot.scannedAt,
    stats: snapshot.stats,
    languages: languageCounts,
  };

  if (parsed.json) {
    print(report, true);
    return;
  }
  console.log(`Repository: ${snapshot.repository.name} (${snapshot.repository.rootPath})`);
  console.log(
    `Loaded: ${String(snapshot.stats.filesLoaded)} files / ${String(snapshot.stats.bytesLoaded)} bytes`,
  );
  console.log(`Languages: ${JSON.stringify(languageCounts)}`);
  console.log(`External-context blocked: ${String(snapshot.stats.safetyBlockedFiles)} files`);
  console.log(
    `Skipped: ${String(snapshot.stats.ignoredEntries)} ignored, ${String(snapshot.stats.skippedBinaryFiles)} binary, ${String(snapshot.stats.skippedOversizedFiles)} oversized, ${String(snapshot.stats.skippedSymlinks)} symlinks`,
  );
}

function createIndexer(): {
  readonly indexer: RepositoryIndexer;
  readonly embeddingProvider: EmbeddingProvider;
} {
  const embeddingProvider = createEmbeddingProvider(process.env, new EnvironmentCredentialSource());
  return {
    embeddingProvider,
    indexer: new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new MultiLanguageCodeParser(),
      embeddingProvider,
      indexStore: new FileSystemCodeIndexStore(),
    }),
  };
}

async function updateIndex(requestedPath: string) {
  const rootPath = resolve(requestedPath);
  const { indexer, embeddingProvider } = createIndexer();
  const result = await indexer.index(rootPath);
  return { ...result, embeddingProvider };
}

async function indexRepository(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const result = await updateIndex(parsed.positionals[0] ?? ".");
  const report = {
    repository: result.index.repository,
    stats: result.stats,
    files: Object.keys(result.index.files).length,
    symbols: Object.keys(result.index.units).length,
    graphEdges: result.index.graphEdges.length,
    embedding: result.index.embedding,
  };
  if (parsed.json) {
    print(report, true);
    return;
  }
  console.log(`Persistent repository index ready: ${report.repository.name}`);
  console.log(
    `${String(report.files)} files, ${String(report.symbols)} symbols, ${String(report.graphEdges)} graph edges`,
  );
  console.log(`Changes: ${JSON.stringify(result.stats)}`);
  console.log("Saved: .conclave/code-index-v2.json (used by search, graph, and Ask; PR review builds its own snapshot)");
}

function printEvidenceResults(results: readonly {
  readonly evidence: {
    readonly path: string;
    readonly symbol?: string;
    readonly symbolKind?: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly excerpt: string;
  };
  readonly rank?: number;
  readonly score?: number;
  readonly signals?: unknown;
  readonly reasons?: unknown;
}[]): void {
  for (const [index, result] of results.entries()) {
    const rank = result.rank ?? index + 1;
    const symbol = result.evidence.symbol === undefined ? "<file>" : result.evidence.symbol;
    const kind = result.evidence.symbolKind === undefined ? "" : ` [${result.evidence.symbolKind}]`;
    console.log(
      `#${String(rank)} ${result.evidence.path} :: ${symbol}${kind} lines ${String(result.evidence.startLine)}-${String(result.evidence.endLine)}`,
    );
    if (result.score !== undefined) {
      console.log(`score: ${result.score.toFixed(6)} signals: ${JSON.stringify(result.signals)}`);
    }
    if (result.reasons !== undefined) {
      console.log(`reasons: ${JSON.stringify(result.reasons)}`);
    }
    console.log(result.evidence.excerpt);
    console.log("");
  }
}

async function searchRepository(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const query = parsed.positionals.slice(1).join(" ").trim();
  if (requestedPath === undefined || query === "") {
    throw new Error("search requires a repository path and query");
  }
  const indexed = await updateIndex(requestedPath);
  const service = new CodeRetrievalService(indexed.index, indexed.embeddingProvider);
  const results = await service.search(query, { strategy: parsed.strategy, limit: parsed.limit });
  if (parsed.json) {
    print({ query, strategy: parsed.strategy, indexStats: indexed.stats, results }, true);
    return;
  }
  printEvidenceResults(results);
}

async function retrievePlannedContext(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const query = parsed.positionals.slice(1).join(" ").trim();
  if (requestedPath === undefined || query === "") {
    throw new Error("retrieve requires a repository path and query");
  }
  const indexed = await updateIndex(requestedPath);
  const service = new CodeRetrievalService(indexed.index, indexed.embeddingProvider);
  const retrieval = await service.retrieve(query, {
    budget: {
      graphDepth: parsed.depth,
      finalEvidence: parsed.limit,
      sourceBytes: parsed.sourceBytes,
      approximateTokens: parsed.tokens,
    },
  });
  const context = service.packContext(retrieval);
  if (parsed.json) {
    print({ query, indexStats: indexed.stats, retrieval, context }, true);
    return;
  }
  console.log(`Plan: ${retrieval.plan.reasons.join("; ")}`);
  for (const item of retrieval.plan.operations) {
    console.log(`${item.status}: ${item.kind} (${String(item.resultCount)}) — ${item.reason}`);
  }
  console.log(`Context: ${JSON.stringify(context.stats)}`);
  printEvidenceResults(
    context.evidence.map((item) => ({
      evidence: {
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        excerpt: item.excerpt,
        ...(item.symbols[0]?.name === undefined ? {} : { symbol: item.symbols[0].name }),
      },
      rank: item.rank,
      reasons: item.reasons,
    })),
  );
}

async function queryGraph(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const entity = parsed.positionals[1];
  if (requestedPath === undefined || entity === undefined) {
    throw new Error("graph requires a repository path and symbol or indexed file");
  }
  const indexed = await updateIndex(requestedPath);
  const graph = new CodeRetrievalService(indexed.index, indexed.embeddingProvider).graph;
  const fileResolution = graph.getNodeByFile(entity);
  const resolution = fileResolution.status === "resolved" ? fileResolution : graph.getNodeBySymbol(entity);
  if (resolution.status !== "resolved") {
    print({ entity, resolution }, parsed.json);
    return;
  }
  const limits = { maxDepth: parsed.depth, maxNodes: parsed.limit };
  const reference = resolution.node.reference;
  const results = (() => {
    switch (parsed.graphOperation) {
      case "neighbors":
        return graph.neighbors(reference, limits);
      case "callers":
        return graph.callers(reference, limits);
      case "callees":
        return graph.callees(reference, limits);
      case "imports":
        return graph.imports(reference, limits);
      case "exports":
        return graph.exports(reference, limits);
      case "references":
        return graph.references(reference, limits);
      case "containing":
        return graph.containingSymbol(reference, limits);
      case "contained":
        return graph.containedSymbols(reference, limits);
      case "related":
        return graph.relatedFiles(reference, limits);
    }
  })();
  if (parsed.json) {
    print({ entity, operation: parsed.graphOperation, resolution, limits, results }, true);
    return;
  }
  console.log(`${resolution.node.path} :: ${resolution.node.symbol ?? "<file>"}`);
  for (const result of results) {
    console.log(
      `${result.direction} ${result.edge.relation} -> ${result.node.path} :: ${result.node.symbol ?? "<file>"}`,
    );
    console.log(
      `  ${result.edge.provenance.kind}/${result.edge.provenance.resolutionMethod} at ${result.edge.provenance.path}:${String(result.edge.provenance.line ?? 1)} — ${result.edge.provenance.reason}`,
    );
  }
}

async function queryPath(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const from = parsed.positionals[1];
  const to = parsed.positionals[2];
  if (requestedPath === undefined || from === undefined || to === undefined) {
    throw new Error("path requires a repository path, source symbol, and target symbol");
  }
  const indexed = await updateIndex(requestedPath);
  const graph = new CodeRetrievalService(indexed.index, indexed.embeddingProvider).graph;
  const result = graph.shortestPathBetweenSymbols(from, to, {
    maxDepth: parsed.depth,
    maxNodes: parsed.limit,
  });
  if (parsed.json) {
    print({ from, to, result }, true);
    return;
  }
  if (result.status !== "found") {
    print(result, false);
    return;
  }
  console.log(result.nodes.map((node) => node.symbol ?? node.path).join(" -> "));
  for (const edge of result.edges) {
    console.log(
      `${edge.relation} at ${edge.provenance.path}:${String(edge.provenance.line ?? 1)} (${edge.provenance.kind}/${edge.provenance.resolutionMethod})`,
    );
  }
}

async function findSymbol(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const symbol = parsed.positionals[1];
  if (requestedPath === undefined || symbol === undefined) {
    throw new Error("symbol requires a repository path and symbol name");
  }
  const indexed = await updateIndex(requestedPath);
  const evidence = new CodeRetrievalService(indexed.index, indexed.embeddingProvider).findSymbol(symbol);
  if (parsed.json) {
    print({ symbol, evidence }, true);
    return;
  }
  printEvidenceResults(evidence.map((item, index) => ({ evidence: item, rank: index + 1 })));
}

async function searchExactText(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const text = parsed.positionals.slice(1).join(" ");
  if (requestedPath === undefined || text === "") {
    throw new Error("text requires a repository path and exact text");
  }
  const indexed = await updateIndex(requestedPath);
  const evidence = new CodeRetrievalService(indexed.index, indexed.embeddingProvider).searchText(text, {
    limit: parsed.limit,
  });
  if (parsed.json) {
    print({ text, evidence }, true);
    return;
  }
  printEvidenceResults(evidence.map((item, index) => ({ evidence: item, rank: index + 1 })));
}

async function evaluateRetrieval(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const casesPath = parsed.positionals[1];
  if (requestedPath === undefined || casesPath === undefined) {
    throw new Error("eval requires a repository path and evaluation-cases JSON path");
  }
  const indexed = await updateIndex(requestedPath);
  const service = new CodeRetrievalService(indexed.index, indexed.embeddingProvider);
  const report = await runRetrievalEvaluation(service, await loadEvaluationCases(resolve(casesPath)));
  print(report, parsed.json);
}

async function evaluateGraphRetrieval(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const casePaths = parsed.positionals.slice(1);
  if (requestedPath === undefined || casePaths.length === 0) {
    throw new Error("eval-graph requires a repository path and one or more evaluation-case JSON paths");
  }
  const indexed = await updateIndex(requestedPath);
  const service = new CodeRetrievalService(indexed.index, indexed.embeddingProvider);
  const caseGroups = await Promise.all(casePaths.map((path) => loadEvaluationCases(resolve(path))));
  const report = await runGraphAwareRetrievalEvaluation(service, caseGroups.flat());
  print(report, parsed.json);
}

async function reasonAboutRepository(args: readonly string[], intent: "ask" | "investigate"): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const question = parsed.positionals.slice(1).join(" ").trim();
  if (requestedPath === undefined || question === "") {
    throw new Error(`${intent} requires a repository path and question`);
  }
  const runtimeConfig = loadRuntimeConfig();
  const reasoningConfig = loadReasoningConfiguration(runtimeConfig);
  const providers = createRoleProviders(runtimeConfig, reasoningConfig.assignments, new EnvironmentCredentialSource());
  const indexed = await updateIndex(requestedPath);
  const retrieval = new CodeRetrievalService(indexed.index, indexed.embeddingProvider);
  const runtime = new StructuredAgentRuntime(
    providers,
    reasoningConfig.assignments,
    DEFAULT_REASONING_LIMITS,
  );
  const result = await new ReasoningEngine({
    retrieval,
    runtime,
    preset: reasoningConfig.preset,
    ...await inferReasoningChangeContext(indexed.index.repository.rootPath, retrieval).then((changeContext) =>
      changeContext === undefined ? {} : { changeContext }),
  }).ask(question, intent === "ask" ? "investigator-judge" : "conclave");
  if (parsed.json) {
    print(parsed.debug ? result : { verdict: result.verdict, metrics: result.metrics, terminationReason: result.terminationReason }, true);
    return;
  }
  console.log(result.verdict.answer);
  console.log("");
  const copy = interfaceCopy(cliLanguage);
  const claimLabels = {
    en: ["Supported claims", "Rejected claims", "Uncertain claims"],
    "pt-BR": ["Claims sustentados", "Claims rejeitados", "Claims incertos"],
    "es-ES": ["Afirmaciones sustentadas", "Afirmaciones rechazadas", "Afirmaciones inciertas"],
  } as const;
  for (const [label, claims] of [
    [claimLabels[cliLanguage][0], result.verdict.claims.supported],
    [claimLabels[cliLanguage][1], result.verdict.claims.rejected],
    [claimLabels[cliLanguage][2], result.verdict.claims.uncertain],
  ] as const) {
    console.log(`${label}:`);
    for (const claim of claims) console.log(`- ${claim.statement}`);
  }
  console.log(`${copy.evidence}:`);
  for (const evidence of result.verdict.evidence) {
    console.log(
      `- ${evidence.path}:${String(evidence.startLine)}-${String(evidence.endLine)}${evidence.symbol === undefined ? "" : ` — ${evidence.symbol}`}`,
    );
  }
  console.log(`${copy.agentsExecuted}: ${result.verdict.traceSummary.agentsExecuted.join(", ")}`);
  for (const skipped of result.verdict.traceSummary.agentsSkipped) {
    console.log(`${copy.agentSkipped}: ${skipped.role} — ${skipped.reason}`);
  }
  console.log(
    `Follow-ups: ${String(result.metrics.followUpRequests)}; retrieval rounds: ${String(result.metrics.retrievalRounds)}; model calls: ${String(result.metrics.modelCalls)}`,
  );
  console.log(
    `Approximate model context: ${String(result.metrics.approximateInputTokens)} input / ${String(result.metrics.approximateOutputTokens)} output tokens`,
  );
  if (parsed.debug) {
    console.log(`${copy.trace}:`);
    for (const event of result.trace) {
      console.log(`${String(event.sequence)} ${event.type}: ${event.detail}`);
    }
  }
}

async function evaluateReasoning(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  const casesPath = parsed.positionals[1];
  if (requestedPath === undefined || casesPath === undefined) {
    throw new Error("eval-reasoning requires a repository path and reasoning-cases JSON path");
  }
  const runtimeConfig = loadRuntimeConfig();
  const reasoningConfig = loadReasoningConfiguration(runtimeConfig);
  const providers = createRoleProviders(runtimeConfig, reasoningConfig.assignments, new EnvironmentCredentialSource());
  const indexed = await updateIndex(requestedPath);
  const retrieval = new CodeRetrievalService(indexed.index, indexed.embeddingProvider);
  const report = await runReasoningEvaluation(
    await loadReasoningEvaluationCases(resolve(casesPath)),
    () =>
      Promise.resolve(new ReasoningEngine({
        retrieval,
        runtime: new StructuredAgentRuntime(
          providers,
          reasoningConfig.assignments,
          DEFAULT_REASONING_LIMITS,
        ),
        preset: reasoningConfig.preset,
      })),
  );
  print(report, parsed.json);
}

function selectedChangeSource(parsed: ParsedArguments): ChangeSource {
  const selected: ChangeSource[] = [];
  if (parsed.working) selected.push({ kind: "working" });
  if (parsed.staged) selected.push({ kind: "staged" });
  if (parsed.head !== undefined && parsed.branch === undefined) {
      throw new Error("--head requires --base <ref>; use --head to name the branch being inspected");
  }
  if (parsed.branch !== undefined) {
    selected.push(parsed.head === undefined
      ? { kind: "branch", base: parsed.branch }
      : { kind: "branch", base: parsed.branch, head: parsed.head });
  }
  if (parsed.commit !== undefined) selected.push({ kind: "commit", commit: parsed.commit });
  if (selected.length > 1) {
    throw new Error("review accepts exactly one of --working, --staged, --base, or --commit");
  }
  return selected[0] ?? { kind: "working" };
}

function runExternalCommand(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} was terminated by ${signal}`));
      } else {
        resolvePromise(code ?? 1);
      }
    });
  });
}

function captureExternalCommand(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: cwd === undefined ? undefined : resolve(cwd),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`${command} was terminated by ${signal}`));
      else resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): readonly number[] => value.replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

async function updateConclave(args: readonly string[]): Promise<void> {
  const modes = args.filter((argument): argument is "--local" | "--global" | "--check" =>
    argument === "--local" || argument === "--global" || argument === "--check");
  const unknown = args.filter((argument) => argument !== "--local" && argument !== "--global" && argument !== "--check");
  if (unknown.length > 0 || modes.length > 1) {
    throw new Error("update accepts one of --local, --global, or --check");
  }
  const mode = modes[0] ?? "--local";
  if (mode === "--check") {
    const result = await captureExternalCommand("npm", ["view", "conclave-ai", "version"]);
    if (result.code !== 0) {
      process.stderr.write(result.stderr);
      process.exitCode = result.code;
    } else console.log(result.stdout.trim());
    return;
  }
  const latest = await captureExternalCommand("npm", ["view", "conclave-ai", "version"]);
  if (latest.code !== 0) {
    process.stderr.write(latest.stderr);
    process.exitCode = latest.code;
    return;
  }
  const current = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version?: string };
  const currentVersion = current.version ?? "0.0.0";
  const latestVersion = latest.stdout.trim();
  if (compareVersions(currentVersion, latestVersion) >= 0) {
    const message = {
      en: `Conclave is already on the latest version (${currentVersion}). No update was needed.`,
      "pt-BR": `O Conclave já está na versão mais recente (${currentVersion}). Nenhuma atualização foi necessária.`,
      "es-ES": `Conclave ya está en la versión más reciente (${currentVersion}). No ha sido necesario actualizar.`,
    } as const;
    throw new Error(message[cliLanguage]);
  }
  const commandArgs = mode === "--global"
    ? ["install", "--global", "conclave-ai@latest"]
    : ["install", "--save-dev", "conclave-ai@latest"];
  const copy = interfaceCopy(cliLanguage);
  console.log(mode === "--global" ? copy.updatingGlobal : copy.updatingProject);
  const code = await runExternalCommand("npm", commandArgs);
  if (code !== 0) process.exitCode = code;
  else console.log(copy.updateComplete);
}

async function showVersion(): Promise<void> {
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { version?: string };
  console.log(packageJson.version ?? "unknown");
}

type GuidedChoice = { readonly id: string; readonly label: string; readonly description: string };

async function gitBranchChoices(root: string): Promise<readonly GuidedChoice[]> {
  const result = await captureExternalCommand(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "--sort=refname", "refs/heads", "refs/remotes"],
    root,
  );
  if (result.code !== 0) {
    throw new Error(`Could not list Git branches: ${result.stderr.trim() || "this folder is not a Git repository"}`);
  }
  const currentResult = await captureExternalCommand("git", ["branch", "--show-current"], root);
  const current = currentResult.code === 0 ? currentResult.stdout.trim() : "";
  const refs = [...new Set(result.stdout
    .split(/\r?\n/u)
    .map((ref) => ref.trim())
    .filter((ref) => ref !== "" && !ref.endsWith("/HEAD")))];
  if (current !== "" && refs.includes(current)) {
    refs.splice(refs.indexOf(current), 1);
    refs.unshift(current);
  }
  return refs.map((ref) => ({
    id: ref,
    label: ref === current ? `${ref} (checked out)` : ref,
    description: ref.startsWith("remotes/") ? "Remote-tracking branch" : "Local branch",
  }));
}

async function promptBranch(root: string, label: string, exclude?: string): Promise<string> {
  const choices = (await gitBranchChoices(root)).filter((choice) => choice.id !== exclude);
  if (choices.length === 0) {
    return promptLine(`${label} (Git ref)`, exclude === undefined ? "" : "HEAD");
  }
  const manual: GuidedChoice = {
    id: "__manual__",
    label: "Enter another Git ref",
    description: "Type a branch, tag, commit, or remote ref manually",
  };
  const selected = await promptChoice(label, [...choices, manual], terminalColorEnabled());
  return selected.id === manual.id ? promptLine("Git ref") : selected.id;
}

async function compareBranches(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const root = resolve(parsed.positionals[0] ?? ".");
  let base = parsed.branch;
  let head = parsed.head;
  if ((base === undefined) !== (head === undefined)) {
    throw new Error("compare needs both --base and --head, or no flags for the interactive selector");
  }
  const prompts = {
    en: { base: "Choose the comparison base branch", head: "Choose the branch to inspect", objective: "What should this change deliver?" },
    "pt-BR": { base: "Escolha a branch base da comparação", head: "Escolha a branch que será analisada", objective: "O que esta mudança deve entregar?" },
    "es-ES": { base: "Elige la rama base de la comparación", head: "Elige la rama que se va a analizar", objective: "¿Qué debe conseguir este cambio?" },
  } as const;
  if (base === undefined || head === undefined) {
    base = await promptBranch(root, prompts[cliLanguage].base);
    head = await promptBranch(root, prompts[cliLanguage].head, base);
  }
  if (base === head) throw new Error("Base and target must be different branches");
  const objective = parsed.objective?.trim() === "" || parsed.objective === undefined
    ? await promptLine(prompts[cliLanguage].objective)
    : parsed.objective;
  const forwarded = [root, "--base", base, "--head", head, "--objective", objective];
  if (parsed.json) forwarded.push("--json");
  await pullRequestSummary(forwarded);
}

async function guidedChangeSource(root: string, color: boolean): Promise<readonly string[]> {
  const copy = {
    en: {
      question: "Which change should Conclave check?",
      branch: ["Compare two branches", "Choose a base and target branch without changing checkout (recommended for PRs)"],
      working: ["Working tree", "Check tracked unstaged changes; stage or ignore untracked files first"],
      staged: ["Staged files", "Check only what is in the Git index"],
      commit: ["One commit", "Check a commit that already exists in Git"],
      base: "Choose the comparison base branch", head: "Choose the branch to inspect", commitPrompt: "Commit",
    },
    "pt-BR": {
      question: "Qual mudança o Conclave deve revisar?",
      branch: ["Comparar duas branches", "Escolha base e destino sem trocar o checkout (recomendado para PRs)"],
      working: ["Working tree", "Revisa mudanças rastreadas e unstaged; faça stage ou ignore arquivos untracked primeiro"],
      staged: ["Arquivos staged", "Revisa somente o que está no índice do Git"],
      commit: ["Um commit", "Revisa um commit que já existe no Git"],
      base: "Escolha a branch base da comparação", head: "Escolha a branch que será analisada", commitPrompt: "Commit",
    },
    "es-ES": {
      question: "¿Qué cambio debe revisar Conclave?",
      branch: ["Comparar dos ramas", "Elige base y destino sin cambiar el checkout (recomendado para PRs)"],
      working: ["Working tree", "Revisa cambios tracked y unstaged; añade o ignora antes los archivos untracked"],
      staged: ["Archivos staged", "Revisa solo lo que está en el índice de Git"],
      commit: ["Un commit", "Revisa un commit que ya existe en Git"],
      base: "Elige la rama base de la comparación", head: "Elige la rama que se va a analizar", commitPrompt: "Commit",
    },
  } as const;
  const text = copy[cliLanguage];
  const source = await promptChoice(
    text.question,
    [
      { id: "branch", label: text.branch[0], description: text.branch[1] },
      { id: "working", label: text.working[0], description: text.working[1] },
      { id: "staged", label: text.staged[0], description: text.staged[1] },
      { id: "commit", label: text.commit[0], description: text.commit[1] },
    ],
    color,
  );
  if (source.id === "branch") {
    const base = await promptBranch(root, text.base);
    const head = await promptBranch(root, text.head, base);
    return [
      root,
      "--base",
      base,
      "--head",
      head,
    ];
  }
  if (source.id === "commit") {
    return [root, "--commit", await promptLine(text.commitPrompt, "HEAD")];
  }
  return [root, `--${source.id}`];
}

async function startGuided(path = "."): Promise<void> {
  const root = resolve(path);
  const copy = interfaceCopy(cliLanguage);
  const choices: readonly GuidedChoice[] = guidedChoices(cliLanguage);
  console.log(`\n${copy.guidedTitle}\n`);
  console.log(`${copy.repository}: ${root}`);
  const choice = await promptChoice(copy.guidedQuestion, choices, terminalColorEnabled());
  const color = terminalColorEnabled();
  switch (choice.id) {
    case "criteria":
      await editAcceptance([root]);
      return;
    case "check":
      await checkRepository([root]);
      return;
    case "compare":
      await compareBranches([root]);
      return;
    case "open":
      await openCockpit([root]);
      return;
    case "review": {
      const source = await guidedChangeSource(root, color);
      const objective = await promptLine({
        en: "What should this change deliver?",
        "pt-BR": "O que esta mudança deve entregar?",
        "es-ES": "¿Qué debe conseguir este cambio?",
      }[cliLanguage]);
      await reviewChanges([...source, "--objective", objective]);
      return;
    }
    case "understand":
      await indexRepository([root]);
      console.log("\nNext: use `conclave search`, `conclave graph`, or choose Ask from this menu.");
      return;
    case "ask": {
      const question = await promptLine({ en: "Question", "pt-BR": "Pergunta", "es-ES": "Pregunta" }[cliLanguage]);
      await reasonAboutRepository([root, question], "ask");
      return;
    }
    case "investigate": {
      const question = await promptLine({
        en: "What behavior should Conclave investigate?",
        "pt-BR": "Qual comportamento o Conclave deve investigar?",
        "es-ES": "¿Qué comportamiento debe investigar Conclave?",
      }[cliLanguage]);
      await reasonAboutRepository([root, question], "investigate");
      return;
    }
    case "setup":
      await setupRepository([root]);
      return;
    case "provider":
      await initializeConclave([]);
      return;
    case "language":
      await chooseInterfaceLanguage();
      return;
    case "doctor":
      await doctorRepository([root]);
      return;
    case "update":
      await updateConclave([]);
      return;
    case "history":
      await showReviewHistory([root]);
      return;
    default:
      console.log(cliHelp(cliLanguage));
  }
}

async function editAcceptance(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const root = resolve(parsed.positionals[0] ?? ".");
  const saved = await loadAcceptanceContract(root);
  if (parsed.json) { console.log(JSON.stringify(saved, null, 2)); return; }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const objective = await prompt.question("Delivery objective (blank keeps saved): ");
    const contract = saved?.contract ?? createValidationContract(objective);
    const criteria = [...(contract.criteria ?? [])];
    const statement = await prompt.question("New acceptance criterion (blank keeps existing): ");
    if (statement.trim()) {
      const verificationPlan = await prompt.question("How will this criterion be tested or reviewed? ");
      const kind = await prompt.question("Evidence kind (test/runtime/human): ");
      const confirmed = (await prompt.question("Confirm this criterion and plan? (yes/no): ")).trim().toLowerCase() === "yes";
      criteria.push({ id: randomUUID(), statement, verificationPlan, kind: kind as "test", confirmed, claimIds: [], implementationPaths: [] });
    }
    const next = await saveAcceptanceContract(root, { ...contract, objective: objective.trim() || contract.objective, criteria }, saved?.revision ?? null);
    console.log("Saved acceptance contract " + next.revision + ". Run conclave check to review it.");
  } finally { prompt.close(); }
}

async function loadValidationContract(parsed: ParsedArguments): Promise<ValidationContract> {
  if (parsed.contractPath === undefined) {
    const saved = await loadAcceptanceContract(resolve(parsed.positionals[0] ?? "."));
    return saved === null ? createValidationContract(parsed.objective ?? "") : parseValidationContract(saved.contract, parsed.objective);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(parsed.contractPath), "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown contract error";
    throw new Error("Could not load validation contract: " + message, { cause: error });
  }
  return parseValidationContract(value, parsed.objective);
}

async function loadPreviousValidationReport(parsed: ParsedArguments): Promise<ValidationReport | undefined> {
  if (parsed.previousReportPath === undefined) return undefined;
  if (parsed.newSeries) throw new Error("--new-series cannot be combined with --previous-report");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(parsed.previousReportPath), "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown previous report error";
    throw new Error("Could not load previous validation report: " + message, { cause: error });
  }
  const candidate = typeof value === "object" && value !== null && !Array.isArray(value) &&
    "report" in value
    ? (value as { report?: unknown }).report
    : value;
  if (
    typeof candidate !== "object" || candidate === null || Array.isArray(candidate) ||
    !([2, 3, 4, 5] as readonly unknown[]).includes((candidate as { schemaVersion?: unknown }).schemaVersion) ||
    typeof (candidate as { lineage?: unknown }).lineage !== "object"
  ) {
    throw new Error("Previous report must be a Conclave schema v2/v3/v4/v5 report or a check JSON object containing one");
  }
  return candidate as ValidationReport;
}

async function loadEvidenceReceipts(parsed: ParsedArguments): Promise<readonly EvidenceReceiptInput[]> {
  const receipts: EvidenceReceiptInput[] = [];
  for (const path of parsed.receiptPaths) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(resolve(path), "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown receipt error";
      throw new Error("Could not load evidence receipt " + path + ": " + message, { cause: error });
    }
    receipts.push(...parseEvidenceReceiptEnvelope(value, resolve(path)));
  }
  for (const path of parsed.attestedReceiptPaths) {
    if (parsed.attestationRepository === undefined || parsed.attestationWorkflow === undefined) throw new Error("Attested receipts require --attestation-repository and --attestation-workflow");
    receipts.push(...await loadAttestedEvidence(path, parsed.attestationRepository, parsed.attestationWorkflow));
  }
  return receipts;
}

function validationProtocolArguments(parsed: ParsedArguments): readonly string[] {
  return [
    ...(parsed.contractPath === undefined ? [] : ["--contract", parsed.contractPath]),
    ...(parsed.previousReportPath === undefined ? [] : ["--previous-report", parsed.previousReportPath]),
    ...parsed.receiptPaths.flatMap((path) => ["--receipt", path]),
    ...parsed.attestedReceiptPaths.flatMap((path) => ["--attested-receipt", path]),
    ...(parsed.attestationRepository === undefined ? [] : ["--attestation-repository", parsed.attestationRepository]),
    ...(parsed.attestationWorkflow === undefined ? [] : ["--attestation-workflow", parsed.attestationWorkflow]),
    ...(parsed.seriesId === undefined ? [] : ["--series", parsed.seriesId]),
    ...(parsed.newSeries ? ["--new-series"] : []),
  ];
}

async function reviewChanges(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  if (requestedPath === undefined || parsed.positionals.length !== 1) {
    throw new Error("review requires exactly one repository path; use --objective for the goal");
  }
  requireObjective(parsed, "review");
  const repositoryRoot = resolve(requestedPath);
  const contract = await loadValidationContract(parsed);
  const previousReport = await loadPreviousValidationReport(parsed);
  const receipts = await loadEvidenceReceipts(parsed);
  const changeService = new GitChangeSetService();
  const source = selectedChangeSource(parsed);
  const changeSet = await changeService.collect(repositoryRoot, source);
  const materialized = await changeService.materializeValidationRoot(repositoryRoot, source);
  try {
    const indexed = await createDeterministicValidationIndex(materialized.rootPath);
    const report = new SuperValidator().validate(indexed.index, changeSet, contract, {
      ...(previousReport === undefined ? {} : { previousReport }),
      receipts,
      ...(parsed.seriesId === undefined ? {} : { seriesId: parsed.seriesId }),
      newSeries: parsed.newSeries,
    });

    if (parsed.json) {
      print(report, true);
    } else {
      printValidationReport(report);
    }

    if (report.verdict === "block") process.exitCode = 1;
    else if (report.verdict === "inconclusive") process.exitCode = 2;
  } finally {
    await materialized.cleanup();
  }
}

function printValidationReport(report: ValidationReport): void {
  for (const item of report.criteria ?? []) console.log(`Criterion ${item.criterion.id}: ${item.status} — ${item.criterion.statement} (previous: ${item.previousStatus ?? "initial"})\nPlan: ${item.criterion.verificationPlan}\nDigest: ${item.digest}\n${item.reasons.join(" ")}`);
    const copy = interfaceCopy(cliLanguage);
    console.log(copy.validationVerdict + ": " + report.verdict.toUpperCase());
    console.log(report.summary);
    console.log(copy.objective + ": " + (report.objective === "" ? "<missing>" : report.objective));
    if (report.changeSet.source.kind === "branch") {
      const head = report.changeSet.source.head ?? "HEAD (checked-out branch)";
      console.log(copy.comparison + ": " + head + " against " + report.changeSet.source.base + ` (${copy.baseBranch})`);
    }
    console.log(
      copy.changed + ": " + String(report.metrics.filesChanged) + ` ${copy.files} / ` +
      String(report.metrics.symbolsChanged) + ` ${copy.codeUnits}`,
    );
    console.log(
      copy.impact + ": " + String(report.metrics.impactedFiles) + ` ${copy.files} / ` +
      String(report.metrics.impactedSymbols) + ` ${copy.codeUnits}`,
    );
    console.log("Series: " + report.lineage.seriesId + " / review " + report.lineage.reviewId);
    console.log("Contract: " + report.lineage.contractStatus + (report.lineage.rebaselineRequired ? " (human rebaseline required)" : ""));
    console.log(
      "Finding lifecycle: " + report.findingLifecycle.progress +
      ` (${String(report.findingLifecycle.resolved.length)} resolved, ${String(report.findingLifecycle.stagnating.length)} stagnating)`,
    );
    if (report.changeSet.files.length > 0) {
      console.log(copy.changedFiles + ":");
      for (const file of report.changeSet.files) {
        const hunks = file.hunks.length === 0
          ? copy.noHunks
          : String(file.hunks.length) + ` ${copy.hunk}` + (file.hunks.length === 1 ? "" : "s");
        const previous = file.previousPath === undefined ? "" : ` (${copy.from} ${file.previousPath})`;
        console.log(`- ${file.status}: ${file.path}${previous} — ${hunks}`);
      }
    }
    for (const item of report.findings) {
      console.log("");
      console.log(item.severity.toUpperCase() + " " + item.kind + ": " + item.title);
      console.log(item.detail);
      for (const evidence of item.evidence) {
        const range = evidence.startLine === undefined
          ? ""
          : ":" + String(evidence.startLine) +
            (evidence.endLine === undefined ? "" : "-" + String(evidence.endLine));
        console.log("- " + evidence.path + range + " — " + evidence.reason);
      }
      console.log(copy.next + ": " + item.remediation);
    }
    for (const result of report.claims) {
      console.log("");
      console.log(copy.claim + " " + result.outcome.toUpperCase() + ": " + result.claim.statement);
      console.log(result.explanation);
    }
    if (report.receipts.items.length > 0) {
      console.log("\nEvidence receipts:");
      for (const receipt of report.receipts.items) {
        console.log(`- ${receipt.status.toUpperCase()} ${receipt.id} (${receipt.effectiveTrustLevel}) — ${receipt.reasons.join("; ")}`);
      }
    }
    if (report.challengePlan.length > 0) {
      console.log("\nChallenge plan:");
      for (const challenge of report.challengePlan) {
        console.log(`- ${challenge.strategy}: ${challenge.reason}`);
        for (const probe of challenge.suggestedProbes) console.log("  - " + probe);
      }
    }
}

async function pullRequestSummary(
  args: readonly string[],
  override?: { readonly source: ChangeSource; readonly objective: string },
): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  if (requestedPath === undefined || parsed.positionals.length !== 1) {
    throw new Error("pr requires exactly one repository path and an objective");
  }
  const effectiveParsed = override === undefined ? parsed : { ...parsed, objective: override.objective };
  requireObjective(effectiveParsed, "pr");
  const repositoryRoot = resolve(requestedPath);
  const contract = await loadValidationContract(effectiveParsed);
  const previousReport = await loadPreviousValidationReport(effectiveParsed);
  const receipts = await loadEvidenceReceipts(effectiveParsed);
  const copy = interfaceCopy(cliLanguage);
  if (!effectiveParsed.json) progress(copy.collecting, copy.gitChange);
  const changeService = new GitChangeSetService();
  const source = override?.source ?? selectedChangeSource(effectiveParsed);
  const changeSet = await changeService.collect(repositoryRoot, source);
  if (!effectiveParsed.json) progress(copy.indexing, copy.localContext);
  const materialized = await changeService.materializeValidationRoot(repositoryRoot, source);
  try {
    const indexed = await createDeterministicValidationIndex(materialized.rootPath);
    if (!effectiveParsed.json) progress(copy.validating, copy.objectiveImpactClaims);
    const report = new SuperValidator().validate(indexed.index, changeSet, contract, {
      ...(previousReport === undefined ? {} : { previousReport }),
      receipts,
      ...(effectiveParsed.seriesId === undefined ? {} : { seriesId: effectiveParsed.seriesId }),
      newSeries: effectiveParsed.newSeries,
    });
    const summary = createPullRequestSummary(report);
    const handoff = createReviewHandoff(report);
    const record: ReviewHistoryRecord = {
      id: report.lineage.reviewId,
      createdAt: new Date().toISOString(),
      repository: repositoryRoot,
      objective: report.objective,
      headSha: report.changeSet.headSha,
      summary,
      report,
      handoff,
    };
    await saveReviewHistory(repositoryRoot, record);
    if (effectiveParsed.json) {
      print({ summary, report, handoff }, true);
    } else {
    console.log(`\n${copy.prSummary}: ${summary.title}`);
    console.log(`${copy.comparison}: ${summary.comparison}`);
    console.log(summary.summary);
    console.log(`${copy.verdict}: ${summary.verdict.toUpperCase()}`);
    if (summary.changedFiles.length > 0) {
      console.log(`\n${copy.changedFiles}:`);
      for (const file of summary.changedFiles) console.log(`- ${file.status}: ${file.path} (${String(file.hunks)} ${copy.hunk}${file.hunks === 1 ? "" : "s"})`);
    }
    if (summary.risks.length > 0) {
      console.log(`\n${copy.risks}:`);
      for (const risk of summary.risks) console.log(`- ${risk}`);
    }
    if ((summary.verificationGaps?.length ?? 0) > 0) {
      console.log(`\n${copy.verificationGaps}:`);
      for (const gap of summary.verificationGaps ?? []) console.log(`- ${gap}`);
    }
    console.log(`\n${copy.reviewProgress}: ${summary.reviewProgress ?? ""}`);
    console.log(`\n${copy.nextSteps}:`);
    for (const step of summary.nextSteps) console.log(`- ${step}`);
      console.log(`\n${copy.nextForAgent}:`);
      console.log(handoff.prompt);
      console.log(`\n${copy.fullEvidence}`);
    }
    if (report.verdict === "block") process.exitCode = 1;
    else if (report.verdict === "inconclusive") process.exitCode = 2;
  } finally {
    await materialized.cleanup();
  }
}

async function checkRepository(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const root = resolve(parsed.positionals[0] ?? ".");
  if (parsed.positionals.length > 1) throw new Error("check accepts at most one repository path");
  const inspection = await inspectRepository(root);
  const hasExplicitSource = parsed.working || parsed.staged || parsed.commit !== undefined || parsed.head !== undefined;
  const source: ChangeSource = hasExplicitSource
    ? selectedChangeSource(parsed)
    : { kind: "workspace", base: parsed.branch ?? inspection.defaultBase };
  const objective = parsed.objective?.trim() || (await loadValidationContract(parsed)).objective || inferredReviewObjective(inspection);
  if (!parsed.json) {
    const copy = interfaceCopy(cliLanguage);
    progress(copy.repository, `${inspection.currentBranch} → base ${source.kind === "workspace" ? source.base : copy.selectedSource}`);
    if (inspection.status.untracked > 0) progress(copy.included, `${String(inspection.status.untracked)} ${copy.untrackedFiles}`);
  }
  await pullRequestSummary([
    inspection.root,
    ...(parsed.json ? ["--json"] : []),
    ...validationProtocolArguments(parsed),
  ], { source, objective });
}

async function showReviewHistory(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const repositoryRoot = resolve(parsed.positionals[0] ?? ".");
  const records = await listReviewHistory(repositoryRoot);
  if (parsed.json) {
    print(records, true);
    return;
  }
  if (records.length === 0) {
    console.log(interfaceCopy(cliLanguage).noHistory);
    return;
  }
  console.log(`${interfaceCopy(cliLanguage).reviewHistory}: ${repositoryRoot}`);
  for (const record of records) {
    const lifecycle = record.report?.findingLifecycle.progress;
    console.log(`- ${record.createdAt} ${record.summary.verdict.toUpperCase()} ${record.summary.title} — ${record.objective}${lifecycle === undefined ? "" : ` [${lifecycle}]`}`);
  }
}

async function showLatestHandoff(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const repositoryRoot = resolve(parsed.positionals[0] ?? ".");
  const latest = (await listReviewHistory(repositoryRoot))[0];
  if (latest === undefined) throw new Error("No review history exists yet. Run `conclave check .` first.");
  const handoff = latest.handoff ?? (latest.report === undefined ? undefined : createReviewHandoff(latest.report));
  if (handoff === undefined) throw new Error("The latest legacy review has no complete report. Run `conclave check .` again.");
  print(parsed.json ? { reviewId: latest.id, handoff } : handoff.prompt, parsed.json);
}

async function chooseInterfaceLanguage(): Promise<void> {
  const choices = INTERFACE_LANGUAGES.map((language) => ({
    id: language,
    label: languageDisplayName(language, cliLanguage),
    description: language === cliLanguage
      ? { en: "Current language", "pt-BR": "Idioma atual", "es-ES": "Idioma actual" }[cliLanguage]
      : language,
  }));
  const selected = await promptChoice(
    interfaceCopy(cliLanguage).interfaceLanguage,
    choices,
    terminalColorEnabled(),
  );
  await applyInterfaceLanguage(parseInterfaceLanguage(selected.id), false);
}

async function applyInterfaceLanguage(language: InterfaceLanguage, json: boolean): Promise<void> {
  const saved = await setInterfaceLanguage(language, loadedUserPreferences?.path);
  loadedUserPreferences = saved;
  cliLanguage = language;
  const report = {
    language,
    languageName: languageDisplayName(language, language),
    preferencesFile: saved.path,
    jsonFieldsLanguage: "en",
  };
  if (json) {
    print(report, true);
    return;
  }
  const copy = interfaceCopy(language);
  console.log(`${copy.languageSaved}: ${report.languageName} (${language})`);
  console.log(`${copy.preferencesFile}: ${saved.path}`);
  console.log(copy.jsonStable);
}

async function showConfig(args: readonly string[]): Promise<void> {
  let requestedLanguage: InterfaceLanguage | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--language") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--language requires en, pt-BR, or es-ES");
      }
      requestedLanguage = parseInterfaceLanguage(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown config option: ${argument ?? ""}`);
  }
  if (requestedLanguage !== undefined) {
    await applyInterfaceLanguage(requestedLanguage, json);
    return;
  }
  const credentials = new EnvironmentCredentialSource();
  const provider = describeRuntimeConfig(loadRuntimeConfig(), credentials);
  const preferences = loadedUserPreferences ?? await loadUserPreferences();
  const effective = languageFromEnvironment(
    preferences.preferences.language,
    userPreferenceEnvironment,
    preferences.exists,
  );
  const report = {
    interface: {
      language: effective.language,
      languageName: languageDisplayName(effective.language, effective.language),
      source: effective.source,
      preferencesFile: preferences.path,
      supportedLanguages: INTERFACE_LANGUAGES,
      jsonFieldsLanguage: "en",
    },
    provider,
    environmentFile: {
      path: conclaveEnvironmentFile.path,
      duplicateKeys: conclaveEnvironmentFile.duplicateKeys,
    },
  };
  if (json) {
    print(report, true);
    return;
  }
  const copy = interfaceCopy(cliLanguage);
  console.log(copy.configTitle);
  console.log(`${copy.interfaceLanguage}: ${report.interface.languageName} (${report.interface.language})`);
  console.log(`${copy.preferencesFile}: ${report.interface.preferencesFile}`);
  console.log(`${copy.providerConfig}: ${provider.mode} · ${provider.provider}`);
  if (conclaveEnvironmentFile.duplicateKeys.length > 0) {
    // The last definition wins silently, so an earlier block that still reads as active is
    // the usual reason a provider or model refuses to change.
    console.log(
      `\nWarning: ${conclaveEnvironmentFile.path} defines ${String(conclaveEnvironmentFile.duplicateKeys.length)} key(s) more than once; the last definition wins: ` +
      conclaveEnvironmentFile.duplicateKeys.join(", "),
    );
  }
  console.log(copy.jsonStable);
}

interface InitArguments {
  readonly provider: GuidedProviderId | undefined;
  readonly profile: string | undefined;
  readonly model: string | undefined;
  readonly reasoning: "full" | "fast" | undefined;
  readonly apiKeyStdin: boolean;
  readonly noKey: boolean;
  readonly envFile: string;
  readonly json: boolean;
}

function parseInitArguments(args: readonly string[]): InitArguments {
  let provider: GuidedProviderId | undefined;
  let profile: string | undefined;
  let model: string | undefined;
  let reasoning: "full" | "fast" | undefined;
  let apiKeyStdin = false;
  let noKey = false;
  let envFile = resolve(".env");
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--api-key-stdin") {
      apiKeyStdin = true;
      continue;
    }
    if (argument === "--no-key") {
      noKey = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument !== "--provider" && argument !== "--profile" && argument !== "--model" && argument !== "--reasoning" && argument !== "--config-file") {
      throw new Error(`Unknown init option: ${argument ?? ""}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--provider") {
      if (!isGuidedProviderId(value)) throw new Error("--provider must be openai, openrouter, anthropic, or opencode-go");
      provider = value;
    } else if (argument === "--profile") {
      profile = value;
    } else if (argument === "--model") {
      model = value;
    } else if (argument === "--reasoning") {
      if (value !== "full" && value !== "fast") throw new Error("--reasoning must be full or fast");
      reasoning = value;
    } else {
      envFile = resolve(value);
    }
    index += 1;
  }
  if (apiKeyStdin && noKey) throw new Error("--api-key-stdin and --no-key cannot be used together");
  return { provider, profile, model, reasoning, apiKeyStdin, noKey, envFile, json };
}

async function promptLine(label: string, fallback?: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("init needs --provider and --api-key-stdin/--no-key when stdin is not a TTY");
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(fallback === undefined ? `${label}: ` : `${label} [${fallback}]: `);
    const value = answer.trim();
    return value === "" && fallback !== undefined ? fallback : value;
  } finally {
    readline.close();
  }
}

async function promptChoice<T extends { readonly id: string; readonly label: string; readonly description: string }>(
  label: string,
  choices: readonly T[],
  color = false,
): Promise<T> {
  console.log(label);
  for (const [index, choice] of choices.entries()) {
    console.log(renderSetupChoice(index + 1, choice, color));
  }
  const answer = await promptLine(interfaceCopy(cliLanguage).choose, "1");
  const numeric = Number(answer);
  const selected = Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length
    ? choices[numeric - 1]
    : choices.find((choice) => choice.id === answer);
  if (selected === undefined) throw new Error(`Unknown selection: ${answer}`);
  return selected;
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Use --api-key-stdin to provide a key in a non-interactive environment");
  }
  process.stdout.write(`${label}: `);
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const input = process.stdin;
    const finish = (): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Setup cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolvePromise(value);
          return;
        }
        if (character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function readApiKeyFromStandardInput(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) {
    if (typeof chunk === "string") {
      value += chunk;
    } else if (chunk instanceof Uint8Array) {
      value += new TextDecoder().decode(chunk);
    } else {
      throw new Error("API key input must be text");
    }
  }
  return value.trim();
}

async function initializeConclave(args: readonly string[]): Promise<void> {
  const parsed = parseInitArguments(args);
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const color = terminalColorEnabled();
  const providerChoices = (["openai", "openrouter", "anthropic"] as const).map((id) => {
    const guide = providerSetupGuide(id, cliLanguage);
    return { id, label: guide.label, description: guide.summary };
  });
  if (interactive && !parsed.json) console.log(renderSetupBanner(color, cliLanguage));
  const provider = parsed.provider ?? (await promptChoice(
    renderSetupStep(1, 4, "Provider", "Choose who should power optional Ask and Investigate reasoning. Review never uses this key.", color),
    providerChoices,
    color,
  )).id;
  if (interactive && parsed.provider !== undefined && !parsed.json) {
    console.log(renderSetupStep(1, 4, "Provider", `${providerSetupGuide(provider, cliLanguage).label} selected from --provider.`, color));
  }
  const selectedProfile = interactive && parsed.profile === undefined && parsed.model === undefined
    ? await promptChoice(
      renderSetupStep(2, 4, "Model profile", "Start from a maintained profile or pass --model for an exact provider model ID.", color),
      providerProfiles(provider),
      color,
    )
    : undefined;
  const selectedStyle = interactive && parsed.reasoning === undefined
    ? await promptChoice(
      renderSetupStep(3, 4, "Reasoning", "Choose the depth used by optional API-backed repository reasoning.", color),
      REASONING_STYLES,
      color,
    )
    : undefined;
  let apiKey: string | undefined;
  if (interactive && !parsed.json) {
    console.log(renderSetupStep(4, 4, "Credentials", "The value is hidden and saved only in the local configuration file.", color));
    console.log(renderProviderGuide(provider, color, cliLanguage));
  }
  if (!parsed.noKey) {
    apiKey = parsed.apiKeyStdin
      ? await readApiKeyFromStandardInput()
      : await promptSecret("Paste API key (hidden)");
  }
  const profileId = parsed.profile ?? selectedProfile?.id;
  const reasoningStyleId = parsed.reasoning ?? selectedStyle?.id;
  const setup = createSetupConfiguration({
    provider,
    ...(profileId === undefined ? {} : { profileId }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(reasoningStyleId === undefined ? {} : { reasoningStyleId }),
    ...(apiKey === undefined ? {} : { apiKey }),
  });
  const write = await writeConclaveEnvironment(parsed.envFile, setup.environment);
  const report = {
    configFile: write.path,
    updated: write.updated,
    provider: setup.provider,
    model: setup.model,
    reasoningPreset: setup.reasoningPreset,
    credentialSaved: setup.credentialSaved,
    validation: "conclave review is deterministic and never sends repository data or API keys to a model",
    next: setup.credentialSaved ? "Run `conclave provider-check` to test the selected provider." : "Set CONCLAVE_API_KEY later, then run `conclave provider-check`.",
  };
  if (parsed.json) {
    print(report, true);
    return;
  }
  console.log(renderSetupSuccess(report, color, cliLanguage));
}

function showModels(args: readonly string[]): void {
  const providerFlagIndex = args.indexOf("--provider");
  const requested = providerFlagIndex === -1 ? undefined : args[providerFlagIndex + 1];
  if (providerFlagIndex !== -1 && (requested === undefined || !isGuidedProviderId(requested))) {
    throw new Error("models --provider must be openai, openrouter, anthropic, or opencode-go");
  }
  if (args.some((argument, index) => argument.startsWith("--") && argument !== "--json" && !(argument === "--provider" && index === providerFlagIndex))) {
    throw new Error("models accepts only --provider and --json");
  }
  const providers: readonly GuidedProviderId[] = requested === undefined
    ? ["openai", "openrouter", "anthropic"]
    : [requested as GuidedProviderId];
  const report = providers.map((provider) => ({ provider, profiles: providerProfiles(provider) }));
  if (args.includes("--json")) {
    print({ providers: report, reasoningStyles: REASONING_STYLES }, true);
    return;
  }
  for (const item of report) {
    console.log(item.provider);
    for (const profile of item.profiles) console.log(`  ${profile.id}: ${profile.model} — ${profile.description}`);
  }
  console.log("Reasoning: full includes architecture review for complex cross-module questions; fast skips that role.");
}

async function installSkill(args: readonly string[]): Promise<void> {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/install-agent-skill.mjs");
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`Skill installation failed with exit code ${String(exitCode)}`);
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function setupRepository(args: readonly string[]): Promise<void> {
  let project = ".";
  let agents: "codex" | "claude" | "both" | "none" | undefined;
  let githubActions = false;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--github-actions") { githubActions = true; continue; }
    if (argument === "--force") { force = true; continue; }
    if (argument === "--agents") {
      const value = args[index + 1];
      if (value !== "codex" && value !== "claude" && value !== "both" && value !== "none") {
        throw new Error("--agents must be codex, claude, both, or none");
      }
      agents = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--") === true) throw new Error(`Unknown setup option: ${argument}`);
    if (project !== ".") throw new Error("setup accepts at most one repository path");
    project = argument ?? ".";
  }
  const inspection = await inspectRepository(project);
  if (agents === undefined && process.stdin.isTTY && process.stdout.isTTY) {
    agents = (await promptChoice(
      "Which coding agents should receive the Conclave skill?",
      [
        { id: "both", label: "Codex + Claude", description: "Install project skills for both agents" },
        { id: "codex", label: "Codex", description: "Install only .agents/skills" },
        { id: "claude", label: "Claude Code", description: "Install only .claude/skills" },
        { id: "none", label: "No agent skill", description: "Keep only the CLI" },
      ] as const,
      terminalColorEnabled(),
    )).id;
    const ci = await promptChoice(
      "Add the GitHub Actions reviewer?",
      [
        { id: "yes", label: "Yes", description: "Review pull requests and publish a readable summary" },
        { id: "no", label: "Not now", description: "You can add it later with conclave setup" },
      ] as const,
      terminalColorEnabled(),
    );
    githubActions = ci.id === "yes";
  }
  agents ??= "both";
  const copy = interfaceCopy(cliLanguage);
  console.log(`\n${copy.configTitle} — ${inspection.root}`);
  if (agents !== "none") {
    await installSkill(["--target", agents, "--scope", "project", "--project", inspection.root, ...(force ? ["--force"] : [])]);
  }
  if (githubActions) {
    await installSkill(["--target", "github-actions", "--scope", "project", "--project", inspection.root, ...(force ? ["--force"] : [])]);
  }
  console.log(`\n${copy.ready}. ${copy.setupCompleteHint}`);
  console.log(copy.providerOptional);
}

async function doctorRepository(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed.positionals.length > 1) throw new Error("doctor accepts at most one repository path");
  const inspection = await inspectRepository(parsed.positionals[0] ?? ".");
  const snapshot = await new LocalFolderRepository().load({ path: inspection.root });
  const supported = new Set(["typescript", "javascript", "tsx", "jsx", "python", "java"]);
  const languages = [...new Set(snapshot.files.map((file) => file.language))].sort();
  const checks = [
    { id: "git", status: "ok", detail: `${inspection.currentBranch}; base ${inspection.defaultBase}` },
    { id: "node", status: Number(process.versions.node.split(".")[0]) >= 20 ? "ok" : "error", detail: process.version },
    { id: "languages", status: languages.some((language) => supported.has(language)) ? "ok" : "warning", detail: languages.join(", ") || "no source language detected" },
    { id: "codex-skill", status: await exists(resolve(inspection.root, ".agents/skills/conclave-validate/SKILL.md")) ? "ok" : "optional", detail: ".agents/skills/conclave-validate" },
    { id: "claude-skill", status: await exists(resolve(inspection.root, ".claude/skills/conclave-validate/SKILL.md")) ? "ok" : "optional", detail: ".claude/skills/conclave-validate" },
    { id: "github-actions", status: await exists(resolve(inspection.root, ".github/workflows/conclave-review.yml")) ? "ok" : "optional", detail: ".github/workflows/conclave-review.yml" },
  ] as const;
  const report = { repository: inspection, languages, checks, ready: !checks.some((check) => check.status === "error") };
  if (parsed.json) { print(report, true); return; }
  console.log(`Conclave doctor — ${inspection.name}`);
  for (const check of checks) {
    const mark = check.status === "ok" ? "✓" : check.status === "error" ? "×" : "○";
    console.log(`${mark} ${check.id}: ${check.detail} (${check.status})`);
  }
  console.log(report.ready ? "\nReady for `conclave check .`." : "\nFix the errors above before reviewing.");
  if (checks.some((check) => check.status === "optional")) console.log("Run `conclave setup .` to add agent and GitHub integrations.");
}

function launchBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true, shell: false });
  child.unref();
}

async function openCockpit(args: readonly string[]): Promise<void> {
  let project = ".";
  let port = 4317;
  let browser = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-browser") { browser = false; continue; }
    if (argument === "--port") {
      port = Number(args[index + 1]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be between 1 and 65535");
      index += 1;
      continue;
    }
    if (argument?.startsWith("--") === true) throw new Error(`Unknown open option: ${argument}`);
    if (project !== ".") throw new Error("open accepts at most one repository path");
    project = argument ?? ".";
  }
  const inspection = await inspectRepository(project);
  const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "web-client");
  const product = new ConclaveProductService({ allowedRoot: inspection.root });
  const server = createConclaveWebServer({ product, staticRoot });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  const url = `http://127.0.0.1:${String(port)}/?repository=${encodeURIComponent(inspection.root)}`;
  console.log(`Conclave cockpit: ${url}`);
  console.log(interfaceCopy(cliLanguage).readOnlyServer);
  if (browser) launchBrowser(url);
}

async function providerCheck(): Promise<void> {
  const credentials = new EnvironmentCredentialSource();
  const config = loadRuntimeConfig();
  print(await diagnoseProvider(config, credentials), true);
}

async function startMcp(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const requestedPath = parsed.positionals[0];
  if (requestedPath === undefined) throw new Error("mcp requires one repository path; clients cannot select arbitrary host paths");
  const createReasoning = (() => {
    try {
      const runtimeConfig = loadRuntimeConfig();
      const reasoningConfig = loadReasoningConfiguration(runtimeConfig);
      const providers = createRoleProviders(runtimeConfig, reasoningConfig.assignments, new EnvironmentCredentialSource());
      return async (retrieval: CodeRetrievalService, repositoryRoot: string) => {
        const changeContext = await inferReasoningChangeContext(repositoryRoot, retrieval);
        return new ReasoningEngine({
          retrieval,
          runtime: new StructuredAgentRuntime(providers, reasoningConfig.assignments, DEFAULT_REASONING_LIMITS),
          preset: reasoningConfig.preset,
          ...(changeContext === undefined ? {} : { changeContext }),
        });
      };
    } catch {
      return undefined;
    }
  })();
  const service = await ConclaveMcpService.open({
    repositoryRoot: requestedPath,
    allowedRoot: process.env["CONCLAVE_MCP_ALLOWED_ROOT"] ?? requestedPath,
    ...(createReasoning === undefined ? {} : { createReasoning }),
  });
  await runMcpStdio(service);
}

async function runDemo(): Promise<void> {
  const product = new ConclaveProductService();
  const project = await product.openDemo();
  const ask = await product.run(project.id, "ask", "Where is bootstrapSession called?");
  const investigate = await product.run(project.id, "investigate", "Why might authentication disappear after refresh?");
  print({ deterministicDemo: true, project, ask, investigate }, true);
}

async function main(): Promise<void> {
  await loadCliLanguage();
  const [command = "help", ...args] = process.argv.slice(2);
  if (process.argv.length === 2 && process.stdin.isTTY && process.stdout.isTTY) {
    await startGuided();
    return;
  }
  switch (command) {
    case "--version":
    case "-v":
      await showVersion();
      return;
    case "scan":
      await scan(args);
      return;
    case "index":
      await indexRepository(args);
      return;
    case "search":
      await searchRepository(args);
      return;
    case "retrieve":
      await retrievePlannedContext(args);
      return;
    case "symbol":
      await findSymbol(args);
      return;
    case "text":
      await searchExactText(args);
      return;
    case "graph":
      await queryGraph(args);
      return;
    case "path":
      await queryPath(args);
      return;
    case "ask":
      await reasonAboutRepository(args, "ask");
      return;
    case "investigate":
      await reasonAboutRepository(args, "investigate");
      return;
    case "smoke":
      await smokeCommand(args);
      return;
    case "collect":
      await collectCommand(args);
      return;
    case "criteria":
      await editAcceptance(args);
      return;
    case "check":
      await checkRepository(args);
      return;
    case "review":
      await reviewChanges(args);
      return;
    case "validate":
      await reviewChanges(args);
      return;
    case "pr":
      await pullRequestSummary(args);
      return;
    case "compare":
      await compareBranches(args);
      return;
    case "history":
      await showReviewHistory(args);
      return;
    case "handoff":
      await showLatestHandoff(args);
      return;
    case "doctor":
      await doctorRepository(args);
      return;
    case "setup":
      await setupRepository(args);
      return;
    case "open":
      await openCockpit(args);
      return;
    case "update":
      await updateConclave(args);
      return;
    case "start":
      await startGuided(args[0] ?? ".");
      return;
    case "eval":
      await evaluateRetrieval(args);
      return;
    case "eval-graph":
      await evaluateGraphRetrieval(args);
      return;
    case "eval-reasoning":
      await evaluateReasoning(args);
      return;
    case "config":
      await showConfig(args);
      return;
    case "models":
      showModels(args);
      return;
    case "init":
      await initializeConclave(args);
      return;
    case "skill":
      if (args[0] !== "install") throw new Error("skill requires the install subcommand");
      await installSkill(args.slice(1));
      return;
    case "provider-check":
      await providerCheck();
      return;
    case "mcp":
      await startMcp(args);
      return;
    case "demo":
      await runDemo();
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(cliHelp(cliLanguage, args.join(" ").trim() || undefined));
      return;
    default:
      throw new Error(`${interfaceCopy(cliLanguage).unknownCommand}: ${command}\n\n${cliHelp(cliLanguage)}`);
  }
}

await main().catch((error: unknown) => {
  const copy = interfaceCopy(cliLanguage);
  const message = error instanceof Error ? error.message : copy.unknownError;
  console.error(`${copy.errorPrefix}: ${message}`);
  process.exitCode = 1;
});
