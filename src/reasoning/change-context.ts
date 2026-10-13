import type { ReasoningChangeContext, ReasoningChangeHunk } from "../domain/reasoning.js";
import type { ChangeSet, ValidationChangedFile } from "../domain/validation.js";
import type { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";
import { createChallengePlan } from "../validation/challenge-router.js";
import { GitChangeSetService } from "../validation/git-change-set.js";
import { ModelContextLedger, type ModelContextProtection } from "../security/model-context.js";
import { inspectRepository } from "../workflow/repository-inspector.js";

const MAX_CHANGED_PATHS = 12;
const MAX_CHANGED_SYMBOLS = 24;
const MAX_RELATED_SYMBOLS = 16;
const MAX_HUNK_BYTES = 6_000;

/**
 * Splits a unified diff into per-file patches. Agents receive the changed lines themselves,
 * because a path and a symbol name cannot show that a literal, a condition, or a cleanup call
 * is wrong; only the changed text can.
 */
function hunksByPath(patch: string, paths: readonly string[]): { readonly hunks: readonly ReasoningChangeHunk[]; readonly protection: ModelContextProtection } {
  // Added, context and removed lines are all scanned: a credential deleted by this change is
  // still in the diff. Scanning precedes truncation, which could otherwise cut a secret into
  // a shape no detector recognizes.
  const ledger = new ModelContextLedger();
  const wanted = new Set(paths);
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of patch.split("\n")) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/u.exec(line);
    if (header !== null) {
      const path = header[1]?.trim();
      current = path !== undefined && wanted.has(path) ? path : undefined;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git ") || line.startsWith("index ")) continue;
    if (current === undefined) continue;
    const existing = sections.get(current) ?? [];
    existing.push(line);
    sections.set(current, existing);
  }
  const result: ReasoningChangeHunk[] = [];
  let budget = MAX_HUNK_BYTES;
  for (const path of paths) {
    const lines = sections.get(path);
    if (lines === undefined || lines.length === 0) continue;
    const text = ledger.protect(path, lines.join("\n"));
    if (budget <= 0) break;
    const bounded = Buffer.byteLength(text, "utf8") > budget ? text.slice(0, budget) : text;
    budget -= Buffer.byteLength(bounded, "utf8");
    result.push({ path, patch: bounded });
  }
  return { hunks: result, protection: ledger.summary() };
}

function changedLines(file: ValidationChangedFile): number {
  return file.hunks.reduce((total, hunk) => total + Math.max(1, hunk.newCount), 0);
}

function overlapsChangedLine(
  evidence: ReturnType<CodeRetrievalService["findSymbolsInFile"]>[number],
  file: ValidationChangedFile,
): boolean {
  if (file.hunks.length === 0) return true;
  return file.hunks.some((hunk) => {
    const start = hunk.newStart;
    const end = hunk.newStart + Math.max(1, hunk.newCount) - 1;
    return evidence.startLine <= end && evidence.endLine >= start;
  });
}

function buildContext(
  source: ReasoningChangeContext["source"],
  files: readonly ValidationChangedFile[],
  retrieval: CodeRetrievalService,
  changeSet: ChangeSet,
): ReasoningChangeContext | undefined {
  const rankedFiles = files
    .filter((file) => file.status !== "deleted")
    .map((file) => {
      const symbols = retrieval.findSymbolsInFile(file.path);
      const changedSymbols = symbols.filter((evidence) => overlapsChangedLine(evidence, file));
      return {
        file,
        symbols: changedSymbols.length > 0 ? changedSymbols : symbols,
        changedLines: changedLines(file),
      };
    })
    .filter((entry) => entry.symbols.length > 0)
    .sort((left, right) => right.changedLines - left.changedLines || left.file.path.localeCompare(right.file.path));
  const paths = rankedFiles.slice(0, MAX_CHANGED_PATHS).map((entry) => entry.file.path);
  if (paths.length === 0) return undefined;
  const symbols = [...new Set(
    rankedFiles.flatMap((entry) => entry.symbols.map((evidence) => evidence.symbol).filter((symbol): symbol is string => symbol !== undefined)),
  )].slice(0, MAX_CHANGED_SYMBOLS);
  const memberCalls = [...new Set(rankedFiles.flatMap((entry) => entry.symbols.flatMap((evidence) =>
    [...evidence.excerpt.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/gu)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  )))];
  const graphSymbols = symbols.flatMap((symbol) =>
    retrieval.findRelated(symbol, 2, 30)
      .map((related) => related.evidence.symbol)
      .filter((name): name is string => name !== undefined),
  );
  const relatedSymbols = [...new Set([...memberCalls, ...graphSymbols])]
    .filter((symbol) => !symbols.includes(symbol) && retrieval.findSymbol(symbol).length > 0)
    .slice(0, MAX_RELATED_SYMBOLS);
  const { hunks, protection } = hunksByPath(changeSet.patch, paths);
  return { source, paths, symbols, relatedSymbols, hunks, protection,
    reviewDimensions: createChallengePlan(
      changeSet,
      { objective: "", claims: [], allowedPathPrefixes: [] },
      [],
      new Set(paths),
      [],
    )
      .filter((challenge) => challenge.strategy !== "baseline")
      .map((challenge) => challenge.strategy),
  };
}

/**
 * Finds the current review target without trusting a user-supplied objective:
 * branch/worktree changes first, then the checked-out latest commit.
 */
export async function inferReasoningChangeContext(
  repositoryRoot: string,
  retrieval: CodeRetrievalService,
): Promise<ReasoningChangeContext | undefined> {
  try {
    const inspection = await inspectRepository(repositoryRoot);
    const changes = new GitChangeSetService();
    const source = inspection.defaultBase === "HEAD"
      ? { kind: "working" as const }
      : { kind: "workspace" as const, base: inspection.defaultBase };
    const current = await changes.collect(inspection.root, source);
    const currentContext = buildContext(source.kind, current.files, retrieval, current);
    if (currentContext !== undefined) return currentContext;
    const latest = await changes.collect(inspection.root, { kind: "commit", commit: "HEAD" });
    return buildContext("latest-commit", latest.files, retrieval, latest);
  } catch {
    // Ask/Investigate still works for non-Git repositories and shallow/unavailable refs.
    return undefined;
  }
}
