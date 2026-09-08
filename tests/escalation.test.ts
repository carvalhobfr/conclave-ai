import { describe, expect, it } from "vitest";

import type { ValidationChallenge, ValidationClaimResult, ValidationFinding } from "../src/domain/validation.js";
import { assessEscalation as assess } from "../src/validation/escalation.js";

function assessEscalation(plan: readonly ValidationChallenge[], findings: readonly ValidationFinding[], claims: readonly ValidationClaimResult[]) {
  return assess(plan, findings, claims, { files: [{ path: "src/feature.ts", status: "added", hunks: [] }], indexedPaths: new Set(["src/feature.ts"]) });
}

function challenge(strategy: ValidationChallenge["strategy"]): ValidationChallenge {
  return { strategy, reason: "r", evidenceIds: [], suggestedProbes: [] };
}

function finding(kind: ValidationFinding["kind"]): ValidationFinding {
  return {
    id: `f_${kind}`,
    fingerprint: `fp_${kind}`,
    kind,
    severity: "warning",
    title: "t",
    detail: "d",
    evidence: [],
    remediation: "r",
  };
}

function claim(outcome: ValidationClaimResult["outcome"]): ValidationClaimResult {
  return {
    claim: { id: "c1", statement: "s", check: { kind: "symbol-exists", symbol: "x", expectation: "present" } },
    outcome,
    explanation: "e",
    evidence: [],
  };
}

describe("escalation assessment", () => {
  it("does not recommend a model pass when only baseline was selected", () => {
    const result = assessEscalation([challenge("baseline")], [], []);
    expect(result.recommended).toBe(false);
    expect(result.dimensions).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  it("keeps broader questions open when a narrow rule produces a finding", () => {
    const result = assessEscalation(
      [challenge("baseline"), challenge("data-integrity")],
      [finding("inconsistent-key")],
      [],
    );
    expect(result.recommended).toBe(true);
    expect(result.dimensions[0]?.coverage).toBe("partial");
    expect(result.dimensions[0]?.checks?.[0]?.status).toBe("finding");
    expect(result.dimensions[0]?.remainingQuestions?.[0]).toContain("transaction");
  });

  it("records no-finding only within a narrow rule and retains verification questions", () => {
    const result = assessEscalation([challenge("baseline"), challenge("lifecycle-state")], [], []);
    expect(result.recommended).toBe(true);
    expect(result.dimensions[0]?.coverage).toBe("partial");
    expect(result.dimensions[0]?.checks?.every((check) => check.status === "no-finding")).toBe(true);
  });

  it("recommends escalation for a dimension with no deterministic check at all", () => {
    const result = assessEscalation([challenge("baseline"), challenge("security")], [], []);
    expect(result.recommended).toBe(true);
    expect(result.dimensions[0]?.coverage).toBe("unchecked");
    expect(result.dimensions[0]?.checks).toEqual([]);
    expect(result.reasons).toHaveLength(1);
  });

  it("recommends escalation when source could not be mapped onto any symbol", () => {
    const result = assessEscalation([challenge("baseline")], [finding("claim-inconclusive")], []);
    expect(result.recommended).toBe(true);
    expect(result.reasons[0]).toContain("could not be mapped onto an indexed symbol");
  });

  it("counts unresolved completion claims instead of the generic reason once claims exist", () => {
    const result = assessEscalation(
      [challenge("baseline")],
      [finding("claim-inconclusive")],
      [claim("inconclusive"), claim("supported")],
    );
    expect(result.reasons[0]).toBe("1 completion claim(s) could not be settled deterministically.");
  });

  it("combines an unchecked dimension with an inconclusive-claim reason", () => {
    const result = assessEscalation(
      [challenge("baseline"), challenge("security")],
      [finding("claim-inconclusive")],
      [claim("inconclusive")],
    );
    expect(result.recommended).toBe(true);
    expect(result.reasons).toHaveLength(2);
  });
});

describe("rule applicability", () => {
  it.each(["src/flow.py", "src/Flow.java", "src/flow.rs"])("does not claim source rules checked %s", (path) => {
    const result = assess([challenge("lifecycle-state")], [], [], { files: [{ path, status: "added", hunks: [] }], indexedPaths: new Set([path]) });
    expect(result.dimensions[0]?.coverage).toBe("unchecked");
    expect(result.dimensions[0]?.checks?.every((check) => check.status === "not-applicable")).toBe(true);
    expect(result.recommended).toBe(true);
  });
  it("does not label unavailable source as checked", () => {
    const result = assess([challenge("data-integrity")], [], [], { files: [{ path: "src/flow.ts", status: "added", hunks: [] }], indexedPaths: new Set() });
    expect(result.dimensions[0]?.coverage).toBe("unchecked");
  });
  it("does not label deletion-only lines as a clean source check", () => {
    const result = assess([challenge("data-integrity")], [], [], { files: [{ path: "src/flow.ts", status: "modified", hunks: [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 0 }] }], indexedPaths: new Set(["src/flow.ts"]) });
    expect(result.dimensions[0]?.checks?.[0]?.status).toBe("not-applicable");
  });
});
