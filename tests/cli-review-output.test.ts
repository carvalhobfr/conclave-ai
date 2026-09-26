import { describe, expect, it } from "vitest";

import { renderCompactReview } from "../src/cli-review-output.js";
import type { PullRequestSummary } from "../src/domain/pr-summary.js";
import type { ValidationFinding, ValidationReport } from "../src/domain/validation.js";

function finding(severity: ValidationFinding["severity"], title: string, line: number): ValidationFinding {
  return { id: title, fingerprint: title, kind: "discarded-error", severity, title, detail: "", remediation: `fix ${title}`, evidence: [{ path: "src/a.ts", startLine: line, endLine: line, reason: "" }] };
}

function report(findings: readonly ValidationFinding[], files = 1): ValidationReport {
  return {
    verdict: findings.some((item) => item.severity === "blocking") ? "block" : findings.length > 0 ? "warn" : "pass",
    findings,
    changeSet: { files: Array.from({ length: files }, (_, index) => ({ path: `f${String(index)}`, status: "modified", hunks: [] })) },
    metrics: { filesChanged: files, impactedFiles: 2 },
  } as unknown as ValidationReport;
}

const summary = { comparison: "Current workspace compared with main", nextSteps: ["Fix it."], verificationGaps: ["a", "b"] } as unknown as PullRequestSummary;

describe("compact check output", () => {
  it("leads with the verdict, puts blockers first, and caps the list", () => {
    const text = renderCompactReview(report([
      finding("warning", "w1", 1), finding("warning", "w2", 2), finding("blocking", "b1", 9), finding("warning", "w3", 3), finding("info", "note", 4),
    ]), summary, "en", false);
    const lines = text.split("\n");
    expect(lines[2]).toBe("BLOCK  4 risks");
    expect(text.indexOf("b1")).toBeLessThan(text.indexOf("w1"));
    expect(text).toContain("src/a.ts:9");
    expect(text).toContain("→ fix b1");
    expect(text).toContain("+1 more");
    expect(text).not.toContain("note");
    expect(text).toContain("Next: Fix it.");
    expect(text).toContain("2 items still need verification");
    expect(text).toContain("conclave handoff .");
    expect(lines.length).toBeLessThan(20);
  });

  it("says so plainly when nothing changed or nothing was found", () => {
    expect(renderCompactReview(report([], 0), summary, "en", false)).toContain("Nothing to review");
    expect(renderCompactReview(report([]), summary, "pt-BR", false)).toContain("PASS  nenhum risco determinístico encontrado");
  });
});
