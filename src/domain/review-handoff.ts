import type { ValidationReport } from "./validation.js";
import { createReviewDecision } from "./review-decision.js";

export interface ReviewHandoff {
  readonly needsWork: boolean;
  readonly title: string;
  readonly prompt: string;
}

function evidenceLines(report: ValidationReport): readonly string[] {
  return report.findings.flatMap((finding) => finding.evidence.slice(0, 5).map((evidence) => {
    const location = evidence.startLine === undefined ? evidence.path : `${evidence.path}:${String(evidence.startLine)}`;
    return `  - ${location}: ${evidence.reason}`;
  }));
}

/** Builds a portable correction request for Codex, Claude Code, or another coding agent. */
export function createReviewHandoff(report: ValidationReport): ReviewHandoff {
  const decision = createReviewDecision(report);
  const needsWork = report.verdict === "block" || report.verdict === "inconclusive" || report.findings.some((finding) => finding.severity === "warning");
  const findings = report.findings.filter((finding) => finding.severity !== "info").slice(0, 8);
  const lines = [
    needsWork ? "Address the Conclave review findings below." : "Review the Conclave evidence below before merging.",
    "",
    `Objective: ${report.objective}`,
    `Verdict: ${report.verdict.toUpperCase()}`,
    `Comparison: ${report.changeSet.source.kind}`,
    `Review series: ${report.lineage.seriesId}`,
    `Contract status: ${report.lineage.contractStatus}`,
    `Finding progress: ${report.findingLifecycle.progress}`,
    ...((report.criteria ?? []).flatMap((item) => [`Criterion ${item.criterion.id}: ${item.criterion.statement}`, `Status: ${item.status}; previous: ${item.previousStatus ?? "initial"}`, `Verification plan: ${item.criterion.verificationPlan}`, `Criterion digest: ${item.digest}`])),
    `Next action: ${decision.nextAction}`,
    `Correction comparison: ${decision.progress}`,
    "",
    ...(report.lineage.rebaselineRequired ? [
      "REBASELINE REQUIRED: the objective, claims, allowed scope, or previous report integrity changed.",
      "Do not treat this as a completed correction until a human or trusted CI boundary confirms the new baseline.",
      "",
    ] : []),
    ...(findings.length === 0 ? ["No deterministic blocker or warning was found."] : findings.flatMap((finding) => [
      `${finding.severity.toUpperCase()}: ${finding.title}`,
      finding.detail,
      `Requested correction: ${finding.remediation}`,
    ])),
    ...evidenceLines({ ...report, findings }),
    ...(decision.verificationGaps.length === 0 ? [] : [
      "",
      "Still needs verification:",
      ...decision.verificationGaps.map((gap) => `- ${gap}`),
      "These are verification tasks, not demonstrated defects. Do not make speculative code changes to close them.",
    ]),
    ...(report.findingLifecycle.stagnating.length === 0 ? [] : [
      "",
      `Stagnation: ${String(report.findingLifecycle.stagnating.length)} finding(s) survived repeated changed artifacts. Revisit the cause or architecture instead of repeating the same patch strategy.`,
    ]),
    ...(report.receipts.items.length === 0 ? [] : [
      "",
      "External evidence: " + report.receipts.items.map((receipt) => `${receipt.id}=${receipt.status}`).join(", "),
    ]),
    ...(report.challengePlan.length === 0 ? [] : [
      "",
      "Suggested independent challenges:",
      ...report.challengePlan.filter((challenge) => challenge.strategy !== "baseline").flatMap((challenge) => [
        `- ${challenge.strategy}: ${challenge.reason}`,
        ...challenge.suggestedProbes.map((probe) => `  - ${probe}`),
      ]),
    ]),
    ...(report.findings.filter((finding) => finding.severity !== "info").length > findings.length
      ? [`\n${String(report.findings.filter((finding) => finding.severity !== "info").length - findings.length)} additional findings remain in the full report.`]
      : []),
    "",
    "Make only changes justified by this evidence. Run the repository's relevant tests, then run `conclave check .` again. Do not commit, push, or merge unless the user explicitly asks.",
  ];
  return {
    needsWork,
    title: needsWork ? "Correction handoff" : "Human review handoff",
    prompt: lines.join("\n"),
  };
}
