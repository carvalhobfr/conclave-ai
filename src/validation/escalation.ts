import type {
  ValidationChangedFile,
  ValidationChallenge,
  ValidationChallengeStrategy,
  ValidationClaimResult,
  ValidationEscalation,
  ValidationFinding,
  ValidationFindingKind,
  ValidationRuleCheck,
} from "../domain/validation.js";

interface RuleScope {
  readonly rule: ValidationFindingKind;
  readonly scope: string;
  readonly extensions: RegExp;
}

const JS = /\.(?:[cm]?[jt]sx?)$/iu;
const STRUCTURAL = /\.(?:[cm]?[jt]sx?|pyw?|java)$/iu;
const KEY: RuleScope = { rule: "inconsistent-key", scope: "Literal and named storage keys in changed JavaScript/TypeScript calls; not transactions, concurrency or persistence.", extensions: JS };
const RESOURCE: RuleScope = { rule: "unreleased-resource", scope: "Syntactic cleanup candidates for changed listeners, intervals and subscriptions in the same file; not proof that teardown executes.", extensions: JS };
const ERROR: RuleScope = { rule: "discarded-error", scope: "Empty catch blocks intersecting changed JavaScript/TypeScript lines; not correctness of error handling.", extensions: JS };
const TEST: RuleScope = { rule: "exported-change-without-tests", scope: "Changed exported units without a changed test file; not test execution, relevance or adequacy.", extensions: STRUCTURAL };
const IMPACT: RuleScope = { rule: "impact-outside-diff", scope: "Relationships reached by the bounded syntax graph; not all runtime callers or type compatibility.", extensions: STRUCTURAL };

const RULES: Partial<Readonly<Record<ValidationChallengeStrategy, readonly RuleScope[]>>> = {
  "data-integrity": [KEY],
  "lifecycle-state": [RESOURCE, ERROR],
  "test-gap": [TEST],
  "blast-radius": [IMPACT],
  "public-api-compatibility": [TEST, IMPACT],
};

const QUESTIONS: Readonly<Record<ValidationChallengeStrategy, readonly string[]>> = {
  baseline: [],
  security: ["Verify authorization and trust boundaries for the changed behavior; structural checks do not establish security."],
  "data-integrity": ["Verify persistence, transaction boundaries and concurrent updates for the changed data paths."],
  "lifecycle-state": ["Verify setup, teardown and error behavior on the actual execution paths, including repeated use."],
  "test-gap": ["Identify relevant tests, run them against this change and inspect whether they cover the required behavior."],
  "blast-radius": ["Review affected consumers and dynamic dependencies beyond the bounded syntax graph."],
  "public-api-compatibility": ["Check caller compatibility and the changed public contract with relevant type and runtime tests."],
  performance: ["Measure the changed path under a representative workload; structural review cannot establish performance."],
  "ux-accessibility": ["Exercise the changed interaction and accessibility behavior, including failure and reload states."],
};

export interface CoverageContext {
  readonly files: readonly ValidationChangedFile[];
  readonly indexedPaths: ReadonlySet<string>;
}

export type EscalationAssessment = ValidationEscalation;
export type DimensionStatus = ValidationEscalation["dimensions"][number];
export type DimensionCoverage = DimensionStatus["coverage"];

/** A rule describes its narrow scope. No current rule covers an entire risk dimension. */
export function assessEscalation(
  challengePlan: readonly ValidationChallenge[],
  findings: readonly ValidationFinding[],
  claims: readonly ValidationClaimResult[],
  context: CoverageContext,
): EscalationAssessment {
  const dimensions = challengePlan.filter((challenge) => challenge.strategy !== "baseline").map((challenge): DimensionStatus => {
    const checks = (RULES[challenge.strategy] ?? []).map((rule): ValidationRuleCheck => {
      const paths = context.files.filter((file) => file.status !== "deleted" &&
        (file.status === "added" || file.hunks.some((hunk) => hunk.newCount > 0 || rule.rule === "discarded-error")) &&
        rule.extensions.test(file.path) && context.indexedPaths.has(file.path)).map((file) => file.path);
      const matching = findings.filter((finding) => finding.kind === rule.rule);
      return {
        rule: rule.rule,
        status: matching.length > 0 ? "finding" : paths.length > 0 ? "no-finding" : "not-applicable",
        scope: rule.scope,
        paths,
        findingIds: matching.map((finding) => finding.id),
      };
    });
    const applicable = checks.some((check) => check.status !== "not-applicable");
    return {
      dimension: challenge.strategy,
      coverage: applicable ? "partial" : "unchecked",
      reason: applicable
        ? "Only the listed rule scopes were checked. Findings or their absence do not verify this entire risk dimension."
        : "No applicable deterministic rule examined this risk dimension in the available changed source.",
      checks,
      remainingQuestions: QUESTIONS[challenge.strategy],
    };
  });
  const reasons = dimensions.flatMap((dimension) => dimension.remainingQuestions ?? []);
  if (findings.some((finding) => finding.kind === "claim-inconclusive")) {
    const inconclusive = claims.filter((claim) => claim.outcome === "inconclusive").length;
    reasons.push(inconclusive > 0
      ? `${String(inconclusive)} completion claim(s) could not be settled deterministically.`
      : "Changed source could not be mapped onto an indexed symbol, so structural impact is incomplete.");
  }
  return { recommended: reasons.length > 0, dimensions, reasons: [...new Set(reasons)] };
}
