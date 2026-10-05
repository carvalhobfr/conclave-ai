import { resolve } from "node:path";

import { TypeScriptCodeParser } from "../../src/code-intelligence/typescript-parser.js";
import type { GenerateRequest, GenerateResponse } from "../../src/domain/provider.js";
import type { AgentRole, ReasoningChangeContext } from "../../src/domain/reasoning.js";
import { DEFAULT_REASONING_LIMITS } from "../../src/domain/reasoning.js";
import { LocalHashEmbeddingProvider } from "../../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../../src/indexing/repository-indexer.js";
import { FakeProvider } from "../../src/providers/fake-provider.js";
import { LocalFolderRepository } from "../../src/repositories/local-folder-repository.js";
import { StructuredAgentRuntime } from "../../src/reasoning/agent-runtime.js";
import { ReasoningEngine } from "../../src/reasoning/reasoning-engine.js";
import { CodeRetrievalService } from "../../src/retrieval/code-retrieval-service.js";

export const reasoningFixturePath = resolve("tests/fixtures/reasoning-auth");
export const causalQuestion = "Why might authentication disappear after refreshing across the auth modules?";

function message(request: GenerateRequest, role: "system" | "user"): string {
  return request.messages.find((item) => item.role === role)?.content ?? "";
}

function jsonBetween(prompt: string, start: string, end: string): Record<string, unknown> {
  const startIndex = prompt.indexOf(start) + start.length;
  const endIndex = prompt.indexOf(end, startIndex);
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

export function reasoningFixtureProvider(): FakeProvider {
  return new FakeProvider((request) => {
    const system = message(request, "system");
    const prompt = message(request, "user");
    if (system.includes("You are the Investigator")) {
      const task = jsonBetween(prompt, "BEGIN TRUSTED TASK", "END TRUSTED TASK");
      const repository = jsonBetween(
        prompt,
        "BEGIN UNTRUSTED REPOSITORY EVIDENCE",
        "END UNTRUSTED REPOSITORY EVIDENCE",
      );
      const packed = repository["evidence"] as { evidenceIds: string[] }[];
      const evidenceId = packed[0]?.evidenceIds[0];
      if (evidenceId === undefined) throw new Error("fixture retrieval returned no evidence");
      if (String(task["question"]).startsWith("Where")) {
        return response(request, {
          summary: "A direct caller lookup is sufficient.",
          claims: [
            {
              statement: "bootstrapSession has at least one caller.",
              evidenceIds: [evidenceId],
              uncertainty: "none",
              check: { kind: "callers", symbol: "bootstrapSession", expectation: "present" },
            },
          ],
          retrievalRequests: [],
        });
      }
      return response(request, {
        summary: "Two persistence lifecycle explanations need deterministic checks.",
        claims: [
          {
            statement: "The token is never persisted.",
            evidenceIds: [evidenceId],
            uncertainty: "possible",
            check: { kind: "callers", symbol: "persistToken", expectation: "absent" },
          },
          {
            statement: "The persisted token is not restored during bootstrapSession.",
            evidenceIds: [evidenceId],
            uncertainty: "possible",
            check: {
              kind: "path",
              from: "bootstrapSession",
              to: "getStoredToken",
              maxDepth: 3,
              expectation: "absent",
            },
          },
        ],
        retrievalRequests: [],
      });
    }
    if (system.includes("You are the Judge")) {
      const adjudication = jsonBetween(
        prompt,
        "BEGIN TRUSTED ADJUDICATION RECORD",
        "END TRUSTED ADJUDICATION RECORD",
      );
      const claims = adjudication["claims"] as { id: string }[];
      return response(request, {
        decisions: claims.map((claim) => ({
          claimId: claim.id,
          status: "supported",
          explanation: "The fake judge agrees; deterministic verification must still win.",
        })),
      });
    }
    const trusted = jsonBetween(prompt, "BEGIN TRUSTED TASK", "END TRUSTED TASK");
    const claims = trusted["claims"] as { id: string; statement: string; evidenceIds: string[] }[];
    if (system.includes("You are the Verifier")) {
      return response(request, {
        decisions: claims.map((claim) => ({
          claimId: claim.id,
          outcome: claim.statement === "The token is never persisted." ? "rejected" : "supported",
          method: "model",
          explanation: "Fixture semantic assessment against the retrieved authentication source.",
          evidenceIds: claim.evidenceIds,
          graphEdgeIds: [],
        })),
      });
    }
    if (system.includes("You are the Skeptic")) {
      return response(request, {
        challenges: [
          {
            claimId: claims[0]?.id,
            type: "contradictory-evidence",
            explanation: "Check persistToken callers before accepting the absence claim.",
            retrievalRequests: [{ kind: "callers", symbol: "persistToken" }],
          },
        ],
      });
    }
    if (system.includes("You are the Architect")) {
      return response(request, {
        summary: "Authentication initialization and storage cross module boundaries.",
        challenges: [],
        retrievalRequests: [
          {
            claimId: claims[1]?.id,
            request: { kind: "path", from: "bootstrapSession", to: "getStoredToken", maxDepth: 3 },
          },
        ],
      });
    }
    throw new Error("Unexpected model role");
  });
}

export async function createReasoningFixtureEngine(
  provider = reasoningFixtureProvider(),
  maxAgentCalls = 10,
  fixtureRoot = reasoningFixturePath,
  changeContext?: ReasoningChangeContext,
): Promise<ReasoningEngine> {
  const embedding = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider: embedding,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(fixtureRoot);
  const roles: readonly AgentRole[] = ["investigator", "skeptic", "architect", "verifier", "judge"];
  const limits = { ...DEFAULT_REASONING_LIMITS, maxAgentCalls };
  return new ReasoningEngine({
    retrieval: new CodeRetrievalService(indexed.index, embedding),
    runtime: new StructuredAgentRuntime(
      new Map([["fake", provider]]),
      roles.map((role) => ({ role, providerId: "fake", modelId: `fake-${role}` })),
      limits,
    ),
    preset: "full",
    limits,
    ...(changeContext === undefined ? {} : { changeContext }),
  });
}
