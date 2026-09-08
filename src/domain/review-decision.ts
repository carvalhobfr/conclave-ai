import type { ValidationFinding, ValidationReport } from "./validation.js";

export interface ReviewDecision {
  readonly headline: string;
  readonly nextAction: string;
  readonly attention: readonly ValidationFinding[];
  readonly verificationGaps: readonly string[];
  readonly progress: string;
}

/** Shared presentation for CLI, cockpit and handoff; never changes the machine verdict. */
export function createReviewDecision(report: ValidationReport): ReviewDecision {
  // Early v2 history predates escalation; preserve its uncertainty without rewriting the report.
  const escalation = (report as Partial<ValidationReport>).escalation;
  const attention = report.findings.filter((finding) => finding.severity !== "info")
    .sort((left, right) => Number(right.severity === "blocking") - Number(left.severity === "blocking"));
  const noChange = report.changeSet.files.length === 0;
  const verificationGaps: string[] = [];
  if (!noChange) {
    if (report.schemaVersion === 2) {
      verificationGaps.push("Historical report: rule-level coverage was not recorded. A legacy clean or evidenced dimension does not establish complete coverage.");
    }
    verificationGaps.push(...(escalation?.reasons ?? []));
    for (const item of report.criteria ?? []) verificationGaps.push(`${item.criterion.id}: ${item.status}. ${item.reasons.join(" ")}`);
    if (report.claims.length === 0) {
      verificationGaps.push("No explicit acceptance claims were supplied. The objective has not been verified as a delivery requirement.");
    } else {
      verificationGaps.push("Claim outcomes establish only their declared structural checks. Required runtime behavior still needs relevant evidence.");
    }
    const executions = report.receipts.items.filter((receipt) => receipt.type === "test" || receipt.type === "runtime");
    if (!executions.some((receipt) => receipt.status === "current")) {
      verificationGaps.push("No current test or runtime receipt is attached to this change. Run the relevant checks and attach their results.");
    }
    for (const receipt of report.receipts.items) {
      verificationGaps.push(receipt.status === "current"
        ? `${receipt.id}: reported ${receipt.type} result is bound to this change; execution provenance remains self-reported.`
        : `${receipt.id}: ${receipt.status} evidence cannot verify this delivery. ${receipt.reasons.join("; ")}`);
    }
  }
  const headline = noChange && attention.length === 0 ? "Nothing to review"
    : report.verdict === "block" ? "Blocking findings need correction"
    : report.verdict === "inconclusive" ? "More evidence is needed"
    : report.verdict === "warn" ? "Findings need review"
    : "No deterministic blocker or warning found";
  const nextAction = report.lineage.rebaselineRequired
    ? "Confirm the changed objective or contract before starting a new review series."
    : noChange && attention.length === 0 ? "Choose another comparison only if you expected code changes."
    : report.verdict === "block" ? "Resolve the blocking findings, then recheck against the saved report."
    : report.verdict === "inconclusive" ? "Provide the missing objective, baseline or claim evidence, then recheck."
    : attention.length > 0 ? "Review the findings, correct confirmed problems and collect the missing verification evidence."
    : "Run relevant tests and review the open verification questions before requesting human approval.";
  const lifecycle = report.findingLifecycle;
  const progress = report.lineage.rebaselineRequired ? "Previous findings are not comparable until the baseline is confirmed."
    : report.lineage.previousReviewId === undefined ? "First review in this series."
    : `${lifecycle.progress}: ${String(lifecycle.resolved.length)} finding(s) no longer detected; ${String(lifecycle.current.filter((item) => item.status === "persistent").length)} persistent; ${String(lifecycle.current.filter((item) => item.status === "new").length)} new; ${String(lifecycle.current.filter((item) => item.status === "regressed").length)} reappeared. Finding changes do not prove behavioral completion.`;
  return { headline, nextAction, attention, verificationGaps: [...new Set(verificationGaps)], progress };
}
