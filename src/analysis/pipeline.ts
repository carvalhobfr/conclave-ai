import type { AnalysisContext, AnalysisRule, RuleCategory, RuleMatch } from "./rule.js";

/** What happened to one rule in one run. A skipped rule examined nothing and proves nothing. */
export interface RuleExecution {
  readonly ruleId: string;
  readonly category: RuleCategory;
  readonly status: "executed" | "skipped";
  /** Present when skipped. */
  readonly reason?: string;
  readonly filesExamined: number;
  readonly matches: number;
  readonly durationMs: number;
  readonly limitation: string;
}

export interface RuleRun {
  readonly matches: readonly RuleMatch[];
  readonly executions: readonly RuleExecution[];
  /** Paths each executed rule examined. */
  readonly examined: ReadonlyMap<string, readonly string[]>;
}

/**
 * Runs every rule that applies to the context's scope. The one place rules are executed, for
 * change review and repository audit alike.
 */
export function runRules(rules: readonly AnalysisRule[], context: AnalysisContext): RuleRun {
  const matches: RuleMatch[] = [];
  const executions: RuleExecution[] = [];
  const examined = new Map<string, readonly string[]>();
  for (const rule of rules) {
    const base = { ruleId: rule.id, category: rule.category, limitation: rule.limitation };
    if (!rule.scopes.includes(context.scope)) {
      executions.push({ ...base, status: "skipped", reason: `Not applicable to ${context.scope} scope`, filesExamined: 0, matches: 0, durationMs: 0 });
      continue;
    }
    if (context.filesFor(rule.languages).length === 0) {
      executions.push({ ...base, status: "skipped", reason: `No ${rule.languages.join(", ")} file in scope`, filesExamined: 0, matches: 0, durationMs: 0 });
      continue;
    }
    const started = performance.now();
    const result = rule.run(context);
    matches.push(...result.matches);
    examined.set(rule.id, result.filesExamined);
    executions.push({
      ...base,
      status: "executed",
      filesExamined: result.filesExamined.length,
      matches: result.matches.length,
      durationMs: Math.max(0, performance.now() - started),
    });
  }
  return { matches, executions, examined };
}
