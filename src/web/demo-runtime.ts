import { MultiLanguageCodeParser } from "../code-intelligence/multi-language-parser.js";
import type { GenerateRequest, GenerateResponse } from "../domain/provider.js";
import type { AgentRole } from "../domain/reasoning.js";
import { DEFAULT_REASONING_LIMITS } from "../domain/reasoning.js";
import { LocalHashEmbeddingProvider } from "../embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../indexing/repository-indexer.js";
import { FakeProvider } from "../providers/fake-provider.js";
import { LocalFolderRepository } from "../repositories/local-folder-repository.js";
import { StructuredAgentRuntime } from "../reasoning/agent-runtime.js";
import { ReasoningEngine } from "../reasoning/reasoning-engine.js";
import { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";

function message(request: GenerateRequest, role: "system" | "user"): string {
  return request.messages.find((item) => item.role === role)?.content ?? "";
}

function jsonBetween(prompt: string, start: string, end: string): Record<string, unknown> {
  const startIndex = prompt.indexOf(start) + start.length;
  const endIndex = prompt.indexOf(end, startIndex);
  if (startIndex < start.length || endIndex < 0) throw new Error(`Demo prompt is missing ${start}`);
  return JSON.parse(prompt.slice(startIndex, endIndex).trim()) as Record<string, unknown>;
}

function response(request: GenerateRequest, value: object): GenerateResponse {
  return {
    provider: "fake",
    model: request.model,
    text: JSON.stringify(value),
    usage: { inputTokens: 20, outputTokens: 10 },
  };
}

export function createDemoReasoningEngine(root: string): Promise<ReasoningEngine> {
  const provider = new FakeProvider((request) => {
    const system = message(request, "system");
    const prompt = message(request, "user");
    if (system.includes("You are the Investigator")) {
      const task = jsonBetween(prompt, "BEGIN TRUSTED TASK", "END TRUSTED TASK");
      const repository = jsonBetween(prompt, "BEGIN UNTRUSTED REPOSITORY EVIDENCE", "END UNTRUSTED REPOSITORY EVIDENCE");
      const packed = repository["evidence"] as { evidenceIds: string[] }[];
      const evidenceId = packed[0]?.evidenceIds[0];
      if (evidenceId === undefined) throw new Error("Demo retrieval returned no evidence");
      if (String(task["question"]).startsWith("Where")) {
        return response(request, {
          summary: "A direct caller lookup is sufficient.",
          claims: [{ statement: "bootstrapSession has at least one caller.", evidenceIds: [evidenceId], uncertainty: "none", check: { kind: "callers", symbol: "bootstrapSession", expectation: "present" } }],
          retrievalRequests: [],
        });
      }
      return response(request, {
        summary: "Two persistence lifecycle explanations need deterministic checks.",
        claims: [
          { statement: "The token is never persisted.", evidenceIds: [evidenceId], uncertainty: "possible", check: { kind: "callers", symbol: "persistToken", expectation: "absent" } },
          { statement: "The persisted token is not restored during bootstrapSession.", evidenceIds: [evidenceId], uncertainty: "possible", check: { kind: "path", from: "bootstrapSession", to: "getStoredToken", maxDepth: 3, expectation: "absent" } },
        ],
        retrievalRequests: [],
      });
    }
    if (system.includes("You are the Judge")) {
      const record = jsonBetween(prompt, "BEGIN TRUSTED ADJUDICATION RECORD", "END TRUSTED ADJUDICATION RECORD");
      const claims = record["claims"] as { id: string }[];
      return response(request, { decisions: claims.map((claim) => ({ claimId: claim.id, status: "supported", explanation: "Demo judge response; deterministic verification remains authoritative." })) });
    }
    const trusted = jsonBetween(prompt, "BEGIN TRUSTED TASK", "END TRUSTED TASK");
    const claims = trusted["claims"] as { id: string; statement: string; evidenceIds: string[] }[];
    if (system.includes("You are the Verifier")) {
      return response(request, { decisions: claims.map((claim) => ({
        claimId: claim.id,
        outcome: claim.statement === "The token is never persisted." ? "rejected" : "supported",
        method: "model",
        explanation: "Scripted demo assessment of the fixed authentication fixture; not a live model verification.",
        evidenceIds: claim.evidenceIds,
        graphEdgeIds: [],
      })) });
    }
    if (system.includes("You are the Skeptic")) {
      return response(request, { challenges: [{ claimId: claims[0]?.id, type: "contradictory-evidence", explanation: "Check persistToken callers before accepting the absence claim.", retrievalRequests: [{ kind: "callers", symbol: "persistToken" }] }] });
    }
    if (system.includes("You are the Architect")) {
      return response(request, { summary: "Authentication initialization and storage cross module boundaries.", challenges: [], retrievalRequests: [{ claimId: claims[1]?.id, request: { kind: "path", from: "bootstrapSession", to: "getStoredToken", maxDepth: 3 } }] });
    }
    throw new Error("Unexpected Demo reasoning role");
  });
  return createReasoning(root, provider);
}

async function createReasoning(root: string, provider: FakeProvider): Promise<ReasoningEngine> {
  const embedding = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({ repositorySource: new LocalFolderRepository(), parser: new MultiLanguageCodeParser(), embeddingProvider: embedding, indexStore: new InMemoryCodeIndexStore() }).index(root);
  const roles: readonly AgentRole[] = ["investigator", "skeptic", "architect", "verifier", "judge"];
  return new ReasoningEngine({
    retrieval: new CodeRetrievalService(indexed.index, embedding),
    runtime: new StructuredAgentRuntime(new Map([["fake", provider]]), roles.map((role) => ({ role, providerId: "fake", modelId: `demo-${role}` })), DEFAULT_REASONING_LIMITS),
    preset: "full",
    limits: DEFAULT_REASONING_LIMITS,
  });
}
