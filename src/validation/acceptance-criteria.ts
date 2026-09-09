import type { AcceptanceCriterion, CriterionResult, ValidationClaimResult, ValidationReceiptSummary, ValidationReport } from "../domain/validation.js";
import { validationDigest } from "./review-lineage.js";

export function evaluateCriteria(criteria: readonly AcceptanceCriterion[], claims: readonly ValidationClaimResult[], receipts: ValidationReceiptSummary, previous?: ValidationReport): readonly CriterionResult[] {
  return criteria.map((criterion): CriterionResult => {
    const digest = validationDigest("criterion", criterion);
    const linked = receipts.items.filter((item) => Object.hasOwn(item.criterionDigests ?? {}, criterion.id) && item.criterionDigests?.[criterion.id] === digest);
    const prior = previous?.criteria?.find((item) => item.criterion.id === criterion.id && item.digest === digest);
    const base = { criterion, digest, receiptIds: linked.map((item) => item.id), ...(prior === undefined ? {} : { previousStatus: prior.status }) };
    if (!criterion.confirmed) return { ...base, status: "not-verified", reasons: ["Proposed criterion; confirm the statement and verification plan first."] };
    if (criterion.kind === "human") return { ...base, status: "human-decision", reasons: ["This criterion requires a human decision; structural review cannot settle it."] };
    if (criterion.kind === "structural") {
      const selected = criterion.claimIds.map((id) => claims.find((item) => item.claim.id === id));
      const status = selected.some((item) => item?.outcome === "rejected") ? "contradicted" : selected.length > 0 && selected.every((item) => item?.outcome === "supported") ? "supported" : "not-verified";
      return { ...base, status, reasons: ["Only explicitly linked structural claims are considered. This does not establish runtime behavior."] };
    }
    const relevant = linked.filter((item) => item.type === criterion.kind);
    const status = relevant.some((item) => item.status === "failed") ? "contradicted" : relevant.some((item) => item.status === "current") ? "supported" : "not-verified";
    return { ...base, status, reasons: [status === "supported" ? "Linked execution reports success for this criterion and artifact. Provenance: " + (relevant.filter((item) => item.status === "current").every((item) => item.effectiveTrustLevel === "ci-verified") ? "CI signature verified" : "self-reported") + "; test adequacy requires review." : status === "contradicted" ? "Linked execution reports failure for this criterion and artifact." : "No current, explicitly linked execution evidence matches this criterion and artifact.", ...relevant.flatMap((item) => item.reasons)] };
  });
}
