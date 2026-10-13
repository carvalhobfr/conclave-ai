import type { CoverageGap, CoverageGapReason, IndexCoverage, RepositoryCodeIndex } from "../domain/code-index.js";
import type {
  ValidationChangedFile,
  ValidationCoverage,
  ValidationCoverageGap,
  ValidationCoverageReason,
  ValidationEvidence,
} from "../domain/validation.js";

const MAX_SAFETY_PATHS = 50;
const MAX_FINDING_EVIDENCE = 20;

// The file types Conclave analyzes structurally. A changed file of one of these types that is
// absent from the index was expected to be analyzed and was not.
export const STRUCTURAL_SOURCE = /\.(?:[cm]?[jt]sx?|pyw?|java)$/iu;

const SAFETY_REASONS: ReadonlySet<ValidationCoverageReason> = new Set(["safety-excluded-path", "safety-excluded-content"]);

export function isSafetyGap(gap: ValidationCoverageGap): boolean {
  return SAFETY_REASONS.has(gap.reason);
}

/** Why a file is absent from the analysis, in words. Describes the exclusion, never the content. */
export function explainCoverageGap(gap: ValidationCoverageGap): string {
  switch (gap.reason) {
    case "safety-excluded-path":
      return "File name matches a built-in credential pattern; the file was not read";
    case "safety-excluded-content":
      return `Content matched a built-in ${gap.detail === undefined || gap.detail === "" ? "credential" : gap.detail} detector; the file was left out of the index`;
    case "ignored":
      return "Excluded by an ignore rule (.gitignore, .conclaveignore or a built-in default)";
    case "unsupported-language":
      return "No structural parser exists for this file type";
    case "parser-failure":
      return "The parser failed on this file";
    case "binary":
      return "Classified as binary content";
    case "oversized":
      return "Larger than the per-file size limit";
    case "symlink":
      return "Symbolic links are not followed";
    case "unreadable":
      return "The file could not be read";
    case "not-indexed":
      return "Absent from the analysis index; the reason was not recorded";
  }
}

function changedFileGap(path: string, recorded: readonly CoverageGap[] | undefined): ValidationCoverageGap {
  const gap = recorded?.find((item) => item.path === path)
    // An ignored directory is recorded once; every file below it shares its reason.
    ?? recorded?.find((item) => item.path.endsWith("/") && path.startsWith(item.path));
  if (gap === undefined) return { path, reason: "not-indexed" };
  return { path, reason: gap.reason, ...(gap.detail === undefined ? {} : { detail: gap.detail }) };
}

/** Accounts for every changed file: analyzed, deleted, or not analyzed with a reason. */
export function assessCoverage(index: RepositoryCodeIndex, files: readonly ValidationChangedFile[]): ValidationCoverage {
  const recorded = index.coverage?.gaps;
  const deleted = files.filter((file) => file.status === "deleted").length;
  const gaps = files
    .filter((file) => file.status !== "deleted" && !Object.hasOwn(index.files, file.path))
    .map((file) => changedFileGap(file.path, recorded))
    .sort((left, right) => left.path.localeCompare(right.path));
  const coverage: ValidationCoverage = {
    changedFiles: {
      total: files.length,
      analyzed: files.length - deleted - gaps.length,
      deleted,
      notAnalyzed: gaps.length,
    },
    gaps,
  };
  if (index.coverage === undefined) return coverage;
  return {
    ...coverage,
    repository: { analyzedFiles: Object.keys(index.files).length, ...summarizeIndexCoverage(index.coverage) },
  };
}

/** Exclusion counts per reason, plus the safety exclusions by path (capped). */
export function summarizeIndexCoverage(coverage: IndexCoverage): Pick<NonNullable<ValidationCoverage["repository"]>, "excluded" | "safetyExcluded" | "safetyExcludedOmitted"> {
  const excluded: Partial<Record<CoverageGapReason, number>> = {};
  for (const gap of coverage.gaps) excluded[gap.reason] = (excluded[gap.reason] ?? 0) + 1;
  const withheld = coverage.gaps.filter(isSafetyGap);
  // Past the cap, source goes first: the cut must not drop the files hiddenSourceFiles counts.
  const safety = withheld.length <= MAX_SAFETY_PATHS ? withheld
    : [...withheld.filter((gap) => STRUCTURAL_SOURCE.test(gap.path)), ...withheld.filter((gap) => !STRUCTURAL_SOURCE.test(gap.path))];
  return {
    excluded,
    safetyExcluded: safety.slice(0, MAX_SAFETY_PATHS),
    safetyExcludedOmitted: Math.max(0, safety.length - MAX_SAFETY_PATHS),
  };
}

/** `2 ignored, 1 safety-excluded-content`; reason codes are stable and always in English. */
export function formatReasonCounts(counts: Readonly<Partial<Record<ValidationCoverageReason, number>>>): string {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${String(count)} ${reason}`)
    .join(", ");
}

function countByReason(gaps: readonly ValidationCoverageGap[]): Partial<Record<ValidationCoverageReason, number>> {
  const counts: Partial<Record<ValidationCoverageReason, number>> = {};
  for (const gap of gaps) counts[gap.reason] = (counts[gap.reason] ?? 0) + 1;
  return counts;
}

export interface CoverageWarning {
  /** Files behind this warning; `evidence` lists at most the first 20. */
  readonly count: number;
  readonly reasons: Readonly<Partial<Record<ValidationCoverageReason, number>>>;
  readonly title: string;
  readonly detail: string;
  readonly remediation: string;
  readonly evidence: readonly ValidationEvidence[];
}

function warning(
  gaps: readonly ValidationCoverageGap[],
  text: (count: number) => Pick<CoverageWarning, "title" | "detail" | "remediation">,
): readonly CoverageWarning[] {
  if (gaps.length === 0) return [];
  return [{
    count: gaps.length,
    reasons: countByReason(gaps),
    ...text(gaps.length),
    evidence: gaps.slice(0, MAX_FINDING_EVIDENCE).map((gap) => ({ path: gap.path, reason: explainCoverageGap(gap) })),
  }];
}

/**
 * The gaps a reviewer must not miss: a changed file that was withheld for safety, and changed
 * source that Conclave normally analyzes but could not. Changed documentation, configuration
 * and assets are recorded in the coverage section without a warning, because no rule applies
 * to them in the first place.
 */
export function coverageWarnings(coverage: ValidationCoverage): readonly CoverageWarning[] {
  const safety = coverage.gaps.filter(isSafetyGap);
  const unparsed = coverage.gaps.filter((gap) => gap.reason === "parser-failure");
  const unanalyzed = coverage.gaps.filter((gap) =>
    !isSafetyGap(gap) && gap.reason !== "parser-failure" && gap.reason !== "unsupported-language" && STRUCTURAL_SOURCE.test(gap.path));
  return [
    ...warning(safety, (count) => ({
      title: "Changed files were excluded from analysis for safety",
      detail: `${String(count)} changed file(s) matched a built-in credential safeguard and were not analyzed. No finding, and no absence of findings, applies to them. This is an analysis gap, not a detected vulnerability.`,
      remediation: "Review these files by other means. If a matched value is a real credential, move it out of source; the file is analyzed once it no longer matches a safeguard.",
    })),
    ...warning(unparsed, (count) => ({
      title: "Changed source could not be parsed",
      detail: `${String(count)} changed source file(s) made the parser fail, so their symbols, diagnostics and relationships were not analyzed.`,
      remediation: "Check these files for syntax the parser cannot handle and review them by other means until they parse.",
    })),
    ...warning(unanalyzed, (count) => ({
      title: "Changed source files were not analyzed",
      detail: `${String(count)} changed source file(s) are absent from the analysis index. No finding, and no absence of findings, applies to them.`,
      remediation: "Adjust the ignore rules or the file so it can be read, or review these files by other means.",
    })),
  ];
}

/** One line for terminal output; undefined when every changed file was analyzed. */
export function describeChangedCoverage(coverage: ValidationCoverage): string | undefined {
  if (coverage.gaps.length === 0) return undefined;
  const present = coverage.changedFiles.total - coverage.changedFiles.deleted;
  return `${String(coverage.changedFiles.analyzed)} of ${String(present)} changed file(s) analyzed; not analyzed: ${formatReasonCounts(countByReason(coverage.gaps))}`;
}

/**
 * Source files outside the change that were withheld for safety. The graph cannot see them, so
 * impact through their imports and calls is missing. The count is a lower bound when truncated.
 */
export function hiddenSourceFiles(coverage: ValidationCoverage): { readonly count: number; readonly truncated: boolean } {
  const changed = new Set(coverage.gaps.map((gap) => gap.path));
  const repository = coverage.repository;
  return {
    count: (repository?.safetyExcluded ?? []).filter((gap) => STRUCTURAL_SOURCE.test(gap.path) && !changed.has(gap.path)).length,
    truncated: (repository?.safetyExcludedOmitted ?? 0) > 0,
  };
}
