import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import type { Challenge, Claim, ReasoningRetrievalRequest } from "../src/domain/reasoning.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { CodeRetrievalService } from "../src/retrieval/code-retrieval-service.js";
import { DeterministicClaimVerifier } from "../src/reasoning/deterministic-verifier.js";
import {
  FollowUpRetrievalExecutor,
  retrievalRequestKey,
} from "../src/reasoning/retrieval-executor.js";
import { routeReasoningAgents } from "../src/reasoning/reasoning-router.js";

async function reasoningFixture() {
  const embeddingProvider = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(resolve("tests/fixtures/code-rag"));
  return new CodeRetrievalService(indexed.index, embeddingProvider);
}

function request(
  id: string,
  value: ReasoningRetrievalRequest["request"],
): ReasoningRetrievalRequest {
  return { id, request: value, requestedBy: "verifier", iteration: 1 };
}

function claim(check: Claim["check"], evidenceIds: readonly string[] = []): Claim {
  return {
    id: "claim_1",
    statement: "bootstrapSession has no callers.",
    evidenceIds,
    challengeIds: [],
    verificationIds: [],
    status: "proposed",
    uncertainty: "none",
    ...(check === undefined ? {} : { check }),
    origin: { role: "investigator", iteration: 1 },
  };
}

describe("bounded reasoning retrieval", () => {
  it("preserves change-path priority and includes evidence from each named path", async () => {
    const service = await reasoningFixture();
    const retrieval = await service.retrieve(
      "Review src/auth/storage.ts and src/auth/AuthProvider.tsx",
    );

    expect(retrieval.results.map((result) => result.evidence.path)).toEqual(
      expect.arrayContaining(["src/auth/storage.ts", "src/auth/AuthProvider.tsx"]),
    );
    expect(retrieval.results[0]?.evidence.path).toBe("src/auth/storage.ts");
  });

  it("executes graph callers and bounded paths through existing retrieval services", async () => {
    const service = await reasoningFixture();
    const executor = new FollowUpRetrievalExecutor(service, 10, 3);
    const callers = await executor.execute(
      request("request_1", { kind: "callers", symbol: "bootstrapSession" }),
    );
    const path = await executor.execute(
      request("request_2", {
        kind: "path",
        from: "AuthProvider",
        to: "getStoredToken",
        maxDepth: 8,
      }),
    );

    expect(callers.evidence.map((item) => item.symbol)).toContain("AuthProvider");
    expect(callers.graphEdges.map((edge) => edge.relation)).toContain("calls-symbol");
    expect(path.evidence.map((item) => item.symbol)).toEqual([
      "AuthProvider",
      "bootstrapSession",
      "getStoredToken",
    ]);
    expect(path.graphEdges).toHaveLength(2);
    expect(path.approximateTokens).toBeGreaterThan(0);
  });

  it("canonicalizes equivalent requests for loop deduplication", () => {
    expect(retrievalRequestKey({ kind: "callers", symbol: "persistToken" })).toBe(
      retrievalRequestKey({ kind: "callers", symbol: "persistToken" }),
    );
    expect(retrievalRequestKey({ kind: "references", symbol: "persistToken" })).not.toBe(
      retrievalRequestKey({ kind: "callers", symbol: "persistToken" }),
    );
  });

  it("deterministically rejects a typed absence claim when graph evidence is found", async () => {
    const service = await reasoningFixture();
    const executor = new FollowUpRetrievalExecutor(service, 10, 3);
    const result = await executor.execute(
      request("request_1", { kind: "callers", symbol: "bootstrapSession" }),
    );
    const verification = new DeterministicClaimVerifier().verifyCheck(
      claim({ kind: "callers", symbol: "bootstrapSession", expectation: "absent" }),
      result,
      1,
    );

    expect(verification).toEqual(
      expect.objectContaining({ outcome: "rejected", method: "graph", deterministic: true }),
    );
  });

  it("lets a contradictory-evidence challenge reject a claim only with evidence the claim does not cite", async () => {
    const service = await reasoningFixture();
    const result = await new FollowUpRetrievalExecutor(service, 10, 3).execute(
      request("request_challenge", { kind: "text", text: "bootstrapSession" }),
    );
    const challenge: Challenge = {
      id: "challenge_1",
      claimId: "claim_1",
      type: "contradictory-evidence",
      explanation: "Check the cited source again.",
      retrievalRequestIds: ["request_challenge"],
      origin: { role: "skeptic", iteration: 1 },
    };
    const verifier = new DeterministicClaimVerifier();
    const citedIds = result.evidence.map((evidence) => evidence.id);

    expect(result.evidence.length).toBeGreaterThan(0);
    expect(verifier.verifyChallenge(claim(undefined, citedIds), challenge, result, 1)).toBeUndefined();
    expect(verifier.verifyChallenge(claim(undefined, citedIds.slice(1)), challenge, result, 1)).toEqual(
      expect.objectContaining({ outcome: "rejected", evidenceIds: citedIds.slice(0, 1) }),
    );
  });

  it("preserves uncertainty when a graph symbol is ambiguous", async () => {
    const service = await reasoningFixture();
    const result = await new FollowUpRetrievalExecutor(service, 10, 3).execute(
      request("request_ambiguous", { kind: "callers", symbol: "restoreState" }),
    );
    const verification = new DeterministicClaimVerifier().verifyCheck(
      claim({ kind: "callers", symbol: "restoreState", expectation: "absent" }),
      result,
      1,
    );

    expect(result.deterministicOperations).toContain("ambiguous-symbol");
    expect(verification?.outcome).toBe("uncertain");
  });

  it("routes simple lookup and cross-module causal questions selectively", async () => {
    const service = await reasoningFixture();
    const simpleRetrieval = await service.retrieve("Where is bootstrapSession called?");
    const simpleContext = service.packContext(simpleRetrieval);
    const groundedClaim = claim(undefined, [simpleRetrieval.results[0]!.evidence.id]);
    const simple = routeReasoningAgents(
      "full",
      "Where is bootstrapSession called?",
      simpleContext,
      [groundedClaim],
    );
    expect(simple.find((selection) => selection.role === "skeptic")?.selected).toBe(false);
    expect(simple.find((selection) => selection.role === "architect")?.selected).toBe(false);

    const complexRetrieval = await service.retrieve(
      "Why might authentication disappear after refreshing the application?",
    );
    const complex = routeReasoningAgents(
      "full",
      "Why might authentication disappear after refreshing the application?",
      service.packContext(complexRetrieval),
      [{ ...groundedClaim, uncertainty: "possible" }],
    );
    expect(complex.find((selection) => selection.role === "skeptic")?.selected).toBe(true);
    expect(complex.find((selection) => selection.role === "architect")?.selected).toBe(true);
  });
});
