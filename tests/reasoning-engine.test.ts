import { describe, expect, it } from "vitest";

import {
  causalQuestion,
  createReasoningFixtureEngine,
  reasoningFixtureProvider,
} from "./helpers/reasoning-fixture.js";

describe("ReasoningEngine", () => {
  it("routes retrieval-only checks through semantic verification before deciding claims", async () => {
    const result = await (await createReasoningFixtureEngine()).ask(causalQuestion);

    expect(result.verdict.claims.rejected.map((claim) => claim.statement)).toContain(
      "The token is never persisted.",
    );
    expect(result.verdict.claims.supported.map((claim) => claim.statement)).toContain(
      "The persisted token is not restored during bootstrapSession.",
    );
    expect(result.verdict.answer).toContain("The persisted token is not restored");
    expect(result.verdict.answer).not.toContain("The token is never persisted");
    expect(result.verdict.answer).toMatch(/src\/auth\/[^:]+:\d+-\d+/);
    expect(result.state.retrievalRequests.filter((request) => request.request.kind === "callers")).toHaveLength(1);
    expect(result.state.verifications.some((verification) => verification.deterministic)).toBe(true);
    expect(result.state.verifications.filter((verification) => verification.deterministic).every((verification) => verification.outcome === "uncertain")).toBe(true);
    expect(result.state.verifications.some((verification) => !verification.deterministic && verification.outcome === "rejected")).toBe(true);
    expect(result.verdict.traceSummary.agentsExecuted).toEqual(
      expect.arrayContaining(["investigator", "skeptic", "architect", "verifier", "judge"]),
    );
  });

  it("skips unnecessary review agents for a simple lookup", async () => {
    const result = await (await createReasoningFixtureEngine()).ask("Where is bootstrapSession called?");

    expect(result.state.selections.find((selection) => selection.role === "skeptic")?.selected).toBe(false);
    expect(result.state.selections.find((selection) => selection.role === "architect")?.selected).toBe(false);
  });

  it("reports only the Investigator as selected in the single-pass baseline", async () => {
    const result = await (
      await createReasoningFixtureEngine()
    ).ask("Where is bootstrapSession called?", "single-pass");

    expect(
      result.state.selections.filter((selection) => selection.selected).map((selection) => selection.role),
    ).toEqual(["investigator"]);
    expect(result.verdict.traceSummary.agentsExecuted).toEqual(["investigator"]);
  });

  it("uses deterministic Git change hints for initial retrieval without changing the user question", async () => {
    const result = await (
      await createReasoningFixtureEngine(reasoningFixtureProvider(), 10, undefined, {
        source: "latest-commit",
        paths: ["src/auth/AuthProvider.ts"],
        hunks: [],
        reviewDimensions: [],
        symbols: ["bootstrapSession"],
        relatedSymbols: ["getStoredToken"],
      })
    ).ask("Review the current implementation.", "single-pass");

    expect(result.state.question).toBe("Review the current implementation.");
    expect(result.state.initialRetrieval.query).toContain("src/auth/AuthProvider.ts");
    expect(result.state.initialContext.evidence[0]?.path).toBe("src/auth/AuthProvider.ts");
    expect(result.state.changeContext?.source).toBe("latest-commit");
    expect(result.trace[0]).toMatchObject({
      type: "reasoning_started",
      data: { changeContext: "latest-commit", changedPaths: 1 },
    });
  });

  it("terminates gracefully when the model-call budget is exhausted", async () => {
    const result = await (
      await createReasoningFixtureEngine(reasoningFixtureProvider(), 1)
    ).ask(causalQuestion);

    expect(result.terminationReason).toBe("budget-exhausted");
    expect(result.metrics.modelCalls).toBe(1);
    expect(result.trace.some((event) => event.type === "reasoning_budget_exhausted")).toBe(true);
  });
});
