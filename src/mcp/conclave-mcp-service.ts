import { resolve } from "node:path";
import { EXCLUDED_CONTEXT_MARKER, redactSecrets } from "../security/model-context.js";

import { MultiLanguageCodeParser } from "../code-intelligence/multi-language-parser.js";
import type { Evidence } from "../domain/evidence.js";
import type { EmbeddingProvider } from "../domain/embedding.js";
import type { ChangeSource, ValidationContract } from "../domain/validation.js";
import type { ReasoningEngine } from "../reasoning/reasoning-engine.js";
import { LocalHashEmbeddingProvider } from "../embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../indexing/repository-indexer.js";
import { LocalFolderRepository } from "../repositories/local-folder-repository.js";
import { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";
import { isPathInside, resolveRepositoryRoot } from "../security/path-policy.js";
import { createValidationContract, parseValidationContract } from "../validation/contract-parser.js";
import { createDeterministicValidationIndex } from "../validation/deterministic-index.js";
import { GitChangeSetService } from "../validation/git-change-set.js";
import { SuperValidator } from "../validation/super-validator.js";

export interface McpEvidenceView {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
  readonly excerpt: string;
  readonly provenance: string;
}

export interface McpObservation {
  readonly tool: string;
  readonly repositoryId: string;
  readonly evidenceCount: number;
  readonly resultBytes: number;
  readonly latencyMs: number;
  readonly operations: number;
}

export class McpInputError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpInputError";
  }
}

function string(value: unknown, name: string, maximum = 600): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) throw new McpInputError(`${name} must be a non-empty string up to ${String(maximum)} characters`);
  return value.trim();
}

function boundedInteger(value: unknown, name: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > maximum) throw new McpInputError(`${name} must be an integer between 1 and ${String(maximum)}`);
  return value;
}

/** MCP results are read by a model client, so excerpts cross the same boundary as provider requests. Redaction precedes truncation. */
function outgoingExcerpt(excerpt: string): string {
  const result = redactSecrets(excerpt);
  return result.residual ? EXCLUDED_CONTEXT_MARKER : result.text.slice(0, 6_000);
}

function evidenceView(evidence: Evidence): McpEvidenceView {
  return { id: evidence.id, path: evidence.path, startLine: evidence.startLine, endLine: evidence.endLine, ...(evidence.symbol === undefined ? {} : { symbol: evidence.symbol }), excerpt: outgoingExcerpt(evidence.excerpt), provenance: evidence.provenance.origin };
}

function validationSource(input: Readonly<Record<string, unknown>>): ChangeSource {
  const source = input["source"] ?? "working";
  switch (source) {
    case "working":
      return { kind: "working" };
    case "staged":
      return { kind: "staged" };
    case "branch":
      return {
        kind: "branch",
        base: string(input["ref"], "ref", 200),
        ...(input["head"] === undefined ? {} : { head: string(input["head"], "head", 200) }),
      };
    case "commit":
      return { kind: "commit", commit: string(input["ref"], "ref", 200) };
    default:
      throw new McpInputError("source must be working, staged, branch, or commit");
  }
}

function validationContract(
  input: Readonly<Record<string, unknown>>,
  objective: string,
): ValidationContract {
  if (input["contract"] === undefined) return createValidationContract(objective);
  try {
    return parseValidationContract(input["contract"], objective);
  } catch (error) {
    throw new McpInputError(
      error instanceof Error ? error.message : "contract is not a valid validation contract",
      { cause: error },
    );
  }
}

/** Thin read-only application facade. Every response treats repository text as untrusted evidence. */
export class ConclaveMcpService {
  readonly #retrieval: CodeRetrievalService;
  readonly #repositoryId: string;
  readonly #repositoryRoot: string;
  readonly #reasoning: Pick<ReasoningEngine, "ask"> | undefined;
  readonly #observations: McpObservation[] = [];

  private constructor(
    retrieval: CodeRetrievalService,
    repositoryId: string,
    repositoryRoot: string,
    reasoning?: Pick<ReasoningEngine, "ask">,
  ) {
    this.#retrieval = retrieval;
    this.#repositoryId = repositoryId;
    this.#repositoryRoot = repositoryRoot;
    this.#reasoning = reasoning;
  }

  public static async open(options: { readonly repositoryRoot: string; readonly allowedRoot?: string; readonly embeddingProvider?: EmbeddingProvider; readonly reasoning?: Pick<ReasoningEngine, "ask">; readonly createReasoning?: (retrieval: CodeRetrievalService, repositoryRoot: string) => Pick<ReasoningEngine, "ask"> | Promise<Pick<ReasoningEngine, "ask">> }): Promise<ConclaveMcpService> {
    const root = await resolveRepositoryRoot(options.repositoryRoot);
    const allowed = resolve(options.allowedRoot ?? root);
    if (!isPathInside(allowed, root)) throw new McpInputError("MCP repository root is outside the configured allowed root");
    const embedding = options.embeddingProvider ?? new LocalHashEmbeddingProvider();
    const indexed = await new RepositoryIndexer({ repositorySource: new LocalFolderRepository(), parser: new MultiLanguageCodeParser(), embeddingProvider: embedding, indexStore: new InMemoryCodeIndexStore() }).index(root);
    const retrieval = new CodeRetrievalService(indexed.index, embedding);
    return new ConclaveMcpService(
      retrieval,
      indexed.index.repository.id,
      root,
      options.reasoning ?? await options.createReasoning?.(retrieval, root),
    );
  }

  public get observations(): readonly McpObservation[] { return [...this.#observations]; }

  public async call(name: string, args: unknown): Promise<unknown> {
    const started = performance.now();
    const input = typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {};
    let value: unknown;
    let evidenceCount = 0;
    let operations = 0;
    switch (name) {
      case "conclave_search": {
        const results = await this.#retrieval.search(string(input["query"], "query"), { limit: boundedInteger(input["limit"], "limit", 6, 10), strategy: "hybrid" });
        const evidence = results.map((result) => evidenceView(result.evidence));
        evidenceCount = evidence.length; operations = 1;
        value = { repositoryEvidenceUntrusted: true, evidence, ranking: results.map((result) => ({ evidenceId: result.evidence.id, rank: result.rank, reasons: result.reasons.slice(0, 3) })) };
        break;
      }
      case "conclave_symbol": {
        const evidence = this.#retrieval.findSymbol(string(input["symbol"], "symbol"), typeof input["path"] === "string" ? input["path"] : undefined).slice(0, boundedInteger(input["limit"], "limit", 6, 10)).map(evidenceView);
        evidenceCount = evidence.length; operations = 1; value = { repositoryEvidenceUntrusted: true, evidence };
        break;
      }
      case "conclave_graph": {
        const symbol = string(input["symbol"], "symbol");
        const operation = input["operation"] === "callers" || input["operation"] === "callees" || input["operation"] === "references" ? input["operation"] : "neighbors";
        const resolved = this.#retrieval.graph.getNodeBySymbol(symbol);
        if (resolved.status !== "resolved") { value = { repositoryEvidenceUntrusted: true, resolution: resolved }; break; }
        const limit = boundedInteger(input["limit"], "limit", 8, 16);
        const relations = operation === "callers" ? this.#retrieval.graph.callers(resolved.node.reference, { maxDepth: 2, maxNodes: limit }) : operation === "callees" ? this.#retrieval.graph.callees(resolved.node.reference, { maxDepth: 2, maxNodes: limit }) : operation === "references" ? this.#retrieval.graph.references(resolved.node.reference, { maxDepth: 2, maxNodes: limit }) : this.#retrieval.graph.neighbors(resolved.node.reference, { maxDepth: 2, maxNodes: limit });
        operations = 1;
        value = { repositoryEvidenceUntrusted: true, symbol, operation, relations: relations.map((relation) => ({ direction: relation.direction, relation: relation.edge.relation, symbol: relation.node.symbol, path: relation.node.path, provenance: relation.edge.provenance })) };
        break;
      }
      case "conclave_graph_path": {
        const result = this.#retrieval.graph.shortestPathBetweenSymbols(string(input["from"], "from"), string(input["to"], "to"), { maxDepth: boundedInteger(input["depth"], "depth", 4, 6), maxNodes: 24 });
        operations = 1; value = { repositoryEvidenceUntrusted: true, path: result };
        break;
      }
      case "conclave_evidence": {
        const found = this.#retrieval.readEvidence(string(input["evidenceId"], "evidenceId", 200));
        if (found === undefined) throw new McpInputError("Evidence ID was not found in this repository session");
        const evidence = evidenceView(found);
        evidenceCount = 1; operations = 1; value = { repositoryEvidenceUntrusted: true, evidence };
        break;
      }
      case "conclave_validate": {
        const objective = string(input["objective"], "objective", 2_000);
        const source = validationSource(input);
        const contract = validationContract(input, objective);
        try {
          const changeService = new GitChangeSetService();
          const changeSet = await changeService.collect(this.#repositoryRoot, source);
          const materialized = await changeService.materializeValidationRoot(this.#repositoryRoot, source);
          let report;
          try {
            const indexed = await createDeterministicValidationIndex(materialized.rootPath);
            report = new SuperValidator().validate(indexed.index, changeSet, contract);
          } finally {
            await materialized.cleanup();
          }
          evidenceCount = report.findings.reduce(
            (count, item) => count + item.evidence.length,
            0,
          );
          operations = report.metrics.deterministicChecks;
          value = {
            repositoryEvidenceUntrusted: true,
            report,
            trustBoundary: {
              ...report.trustBoundary,
              verdictMustNotBeOverridden: true,
            },
          };
        } catch (error) {
          if (error instanceof McpInputError) throw error;
          throw new McpInputError(
            error instanceof Error ? error.message : "Conclave could not validate the selected change",
            { cause: error },
          );
        }
        break;
      }
      case "conclave_ask":
      case "conclave_investigate": {
        if (this.#reasoning === undefined) throw new McpInputError("Reasoning is unavailable until a server-side provider is configured");
        const result = await this.#reasoning.ask(string(input["question"], "question"), name === "conclave_ask" ? "investigator-judge" : "conclave");
        evidenceCount = result.verdict.evidence.length; operations = result.metrics.deterministicOperations;
        value = { repositoryEvidenceUntrusted: true, verdict: { answer: result.verdict.answer, supportedClaims: result.verdict.claims.supported.map((claim) => ({ id: claim.id, statement: claim.statement, evidenceIds: claim.evidenceIds })), rejectedClaims: result.verdict.claims.rejected.map((claim) => ({ id: claim.id, statement: claim.statement })), uncertainClaims: result.verdict.claims.uncertain.map((claim) => ({ id: claim.id, statement: claim.statement })), evidence: result.verdict.evidence.map(evidenceView) }, metrics: { retrievalRounds: result.metrics.retrievalRounds, modelCalls: result.metrics.modelCalls, approximateContextTokens: result.metrics.approximateInputTokens }, ...(result.contextProtection === undefined ? {} : { contextProtection: result.contextProtection }) };
        break;
      }
      default: throw new McpInputError(`Unknown read-only MCP tool: ${name}`);
    }
    const resultBytes = Buffer.byteLength(JSON.stringify(value));
    this.#observations.push({ tool: name, repositoryId: this.#repositoryId, evidenceCount, resultBytes, latencyMs: Math.round(performance.now() - started), operations });
    return value;
  }
}
