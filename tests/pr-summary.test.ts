import { describe, expect, it } from "vitest";

import { createReviewDecision } from "../src/domain/review-decision.js";
import { createReviewHandoff } from "../src/domain/review-handoff.js";
import { createPullRequestSummary } from "../src/domain/pr-summary.js";
import type { ValidationReport } from "../src/domain/validation.js";

function report(overrides: Partial<ValidationReport> = {}): ValidationReport {
  return {
    schemaVersion: 2,
    verdict: "pass",
    summary: "PASS",
    objective: "Restore the session",
    changeSet: {
      source: { kind: "branch", base: "origin/main" },
      headSha: "abc",
      files: [{ path: "src/session.ts", status: "modified", hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }] }],
      collectedAt: "2026-01-01T00:00:00.000Z",
      patchBytes: 20,
    },
    findings: [],
    claims: [],
    escalation: { recommended: false, dimensions: [], reasons: [] },
    impact: { changedSymbols: ["restoreSession"], impactedFiles: ["src/session.ts"], impactedSymbols: ["restoreSession"] },
    metrics: { filesChanged: 1, symbolsChanged: 1, impactedFiles: 1, impactedSymbols: 1, graphEdgesInspected: 1, deterministicChecks: 0, durationMs: 1 },
    trustBoundary: {
      deterministic: true,
      reasoningModelCalls: 0,
      repositoryScriptsExecuted: false,
      knowledge: { parser: "test", graph: "syntax-aware", embedding: { id: "test", kind: "deterministic-feature-hash", remoteCalls: 0 } },
    },
    lineage: {
      seriesId: "series_test",
      reviewId: "review_test",
      baselineTrust: "none",
      objectiveDigest: "objective_test",
      contractDigest: "contract_test",
      diffDigest: "diff_test",
      artifactDigest: "artifact_test",
      reportDigest: "report_test",
      contractStatus: "initial",
      rebaselineRequired: false,
      contractDelta: { objectiveChanged: false, addedClaimIds: [], removedClaimIds: [], changedClaimIds: [], allowedPathPrefixesAdded: [], allowedPathPrefixesRemoved: [] },
      contractSnapshot: { allowedPathPrefixes: [], claims: [] },
    },
    findingLifecycle: { progress: "initial", current: [], resolved: [], seen: [], stagnating: [] },
    receipts: { items: [], counts: { current: 0, stale: 0, invalid: 0, failed: 0, unbound: 0 } },
    challengePlan: [],
    ...overrides,
  };
}

describe("pull request summaries", () => {
  it("turns a validation report into a human-readable change summary", () => {
    const result = createPullRequestSummary(report());
    expect(result.title).toBe("Update src/session.ts");
    expect(result.comparison).toBe("HEAD compared with origin/main");
    expect(result.summary).toContain("updates 1 file");
    expect(result.nextSteps[0]).toContain("tests");
  });

  it("prioritizes blocking findings as next steps", () => {
    const result = createPullRequestSummary(report({
      verdict: "block",
      findings: [{
        id: "finding-1",
        fingerprint: "fingerprint-1",
        kind: "claim-contradicted",
        severity: "blocking",
        title: "Claim contradicted",
        detail: "The claim is not supported.",
        evidence: [],
        remediation: "Fix it.",
      }],
    }));
    expect(result.risks).toEqual(["BLOCKING: Claim contradicted"]);
    expect(result.nextSteps[0]).toContain("blocking findings");
  });
});

describe("delivery decisions", () => {
  it("keeps a structural PASS separate from unverified delivery and exposes the same gaps in each surface", () => {
    const current = report({ schemaVersion: 3, escalation: { recommended: true, dimensions: [], reasons: ["Verify persistence after reload."] } });
    const decision = createReviewDecision(current);
    expect(decision.headline).toBe("No deterministic blocker or warning found");
    expect(decision.verificationGaps).toContain("Verify persistence after reload.");
    expect(decision.verificationGaps.some((gap) => gap.includes("No explicit acceptance claims"))).toBe(true);
    expect(decision.verificationGaps.some((gap) => gap.includes("No current test or runtime receipt"))).toBe(true);
    expect(createPullRequestSummary(current).verificationGaps).toEqual(decision.verificationGaps);
    for (const gap of decision.verificationGaps) expect(createReviewHandoff(current).prompt).toContain(gap);
    expect(current.verdict).toBe("pass");
  });
  it("labels historical clean coverage as limited rather than proven", () => {
    const current = report({ escalation: { recommended: false, reasons: [], dimensions: [{ dimension: "data-integrity", coverage: "checked-clean", reason: "Historical clean." }] } });
    expect(createReviewDecision(current).verificationGaps[0]).toContain("Historical report");
  });
  it("does not manufacture work when no files changed", () => {
    const base = report();
    const decision = createReviewDecision({ ...base, changeSet: { ...base.changeSet, files: [] } });
    expect(decision.headline).toBe("Nothing to review");
    expect(decision.verificationGaps).toEqual([]);
  });
  it.each(["failed", "stale", "invalid", "unbound", "current"] as const)("retains %s receipt limitations", (status) => {
    const base = report();
    const decision = createReviewDecision({ ...base, receipts: { ...base.receipts, items: [{ id: "integration", receiptDigest: "receipt_x", type: "test", status, claimedTrustLevel: "ci-attested", effectiveTrustLevel: "self-reported", reasons: ["Fixture reason"] }] } });
    expect(decision.verificationGaps.some((gap) => gap.includes(status === "current" ? "provenance remains self-reported" : `${status} evidence cannot verify`))).toBe(true);
    expect(decision.headline).not.toContain("verified");
  });
  it("keeps rebaseline above correction progress and does not describe disappearance as proof of a fix", () => {
    const base = report();
    const current = { ...base, lineage: { ...base.lineage, previousReviewId: "older" }, findingLifecycle: { ...base.findingLifecycle, progress: "progress" as const, resolved: ["fingerprint-old"] } };
    expect(createReviewDecision(current).progress).toContain("1 finding(s) no longer detected");
    const changed = { ...current, lineage: { ...current.lineage, rebaselineRequired: true } };
    expect(createReviewDecision(changed).nextAction).toContain("Confirm the changed objective");
    expect(createReviewDecision(changed).progress).toContain("not comparable");
  });
});
