import { resolve } from "node:path";

import type { ValidationFindingKind, ValidationFindingSeverity, ValidationVerdict } from "../domain/validation.js";
import { createValidationContract } from "../validation/contract-parser.js";
import { createDeterministicValidationIndex } from "../validation/deterministic-index.js";
import { GitChangeSetService, runGit, safeRef } from "../validation/git-change-set.js";
import { SuperValidator } from "../validation/super-validator.js";
import { inspectRepository } from "./repository-inspector.js";

export const COMMIT_TIMELINE_SCHEMA_VERSION = 1;
export const DEFAULT_TIMELINE_COMMITS = 10;
export const MAX_TIMELINE_COMMITS = 100;
/** Each analyzed commit indexes a full tree, so analysis is capped well below the listing cap. */
export const MAX_ANALYZED_COMMITS = 25;
const MAX_TOP_FINDINGS = 5;
const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const FULL_SHA = /^[a-f0-9]{40,64}$/u;
const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t/u;
const SEVERITY_ORDER: Readonly<Record<ValidationFindingSeverity, number>> = { blocking: 0, warning: 1, info: 2 };

export interface CommitTimelineOptions {
  /** Repository folder. Defaults to the current directory. */
  readonly repository?: string;
  /** Lists the commits reachable from `head` and not from `base` (`base..head`). Without it, the latest commits of `head`. */
  readonly base?: string;
  /** Tip of the listing. Defaults to HEAD. */
  readonly head?: string;
  /** Number of commits to list, newest first. */
  readonly limit?: number;
  /** Run the deterministic review on every listed commit. Makes no model call and runs no repository code. */
  readonly analyze?: boolean;
  /** Temporary trees are registered here so an interrupted run can remove them. */
  readonly interruptCleanup?: Set<string>;
}

export interface TimelineFindingSummary {
  readonly kind: ValidationFindingKind;
  readonly severity: ValidationFindingSeverity;
  readonly title: string;
}

export type CommitAnalysis =
  | {
    readonly status: "analyzed";
    readonly verdict: ValidationVerdict;
    readonly findings: Readonly<Record<ValidationFindingSeverity, number>>;
    readonly topFindings: readonly TimelineFindingSummary[];
    readonly filesChanged: number;
    readonly symbolsChanged: number;
    readonly impactedFiles: number;
    readonly impactedSymbols: number;
  }
  | { readonly status: "skipped"; readonly reason: "root-commit" }
  | { readonly status: "failed"; readonly reason: string };

export interface TimelineCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  /** Name only: the author's address is never read into the timeline. */
  readonly author: string;
  readonly authoredAt: string;
  readonly parents: readonly string[];
  readonly isMerge: boolean;
  /** Absent for merge commits, whose combined diff Git does not list by default. */
  readonly stats?: { readonly filesChanged: number; readonly additions: number; readonly deletions: number };
  readonly analysis?: CommitAnalysis;
}

export interface CommitTimeline {
  readonly schemaVersion: typeof COMMIT_TIMELINE_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly repository: { readonly root: string; readonly name: string; readonly branch: string };
  readonly range: { readonly base: string | null; readonly head: string; readonly limit: number };
  readonly analyzed: boolean;
  /** True when more commits exist in the range than were listed. */
  readonly truncated: boolean;
  readonly summary: {
    readonly commits: number;
    /** Verdict counts over the commits that were analyzed. */
    readonly verdicts: Readonly<Record<ValidationVerdict, number>>;
    /** Commits listed without a verdict: not analyzed, skipped or failed. */
    readonly unanalyzed: number;
  };
  readonly commits: readonly TimelineCommit[];
}

interface ListedCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly authoredAt: string;
  readonly subject: string;
  readonly stats: { readonly filesChanged: number; readonly additions: number; readonly deletions: number };
}

export function parseCommitLog(output: string): readonly ListedCommit[] {
  const commits: ListedCommit[] = [];
  for (const record of output.split(RECORD_SEPARATOR)) {
    if (record.trim() === "") continue;
    const newline = record.indexOf("\n");
    const header = newline === -1 ? record : record.slice(0, newline);
    const body = newline === -1 ? "" : record.slice(newline + 1);
    const [sha, parents, author, authoredAt, ...subject] = header.split(FIELD_SEPARATOR);
    if (sha === undefined || !FULL_SHA.test(sha) || author === undefined || authoredAt === undefined) continue;
    let filesChanged = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of body.split("\n")) {
      const match = NUMSTAT_LINE.exec(line);
      if (match === null) continue;
      filesChanged += 1;
      // Binary files list "-" for both counts; they add a file and no lines.
      additions += match[1] === "-" ? 0 : Number(match[1]);
      deletions += match[2] === "-" ? 0 : Number(match[2]);
    }
    commits.push({
      sha,
      parents: (parents ?? "").split(" ").filter((value) => FULL_SHA.test(value)),
      author,
      authoredAt,
      subject: subject.join(FIELD_SEPARATOR),
      stats: { filesChanged, additions, deletions },
    });
  }
  return commits;
}

function resolvedLimit(requested: number | undefined, analyze: boolean): number {
  const limit = requested ?? DEFAULT_TIMELINE_COMMITS;
  const ceiling = analyze ? MAX_ANALYZED_COMMITS : MAX_TIMELINE_COMMITS;
  if (!Number.isInteger(limit) || limit < 1 || limit > ceiling) {
    throw new Error(analyze
      ? `--limit must be an integer between 1 and ${String(MAX_ANALYZED_COMMITS)} with --analyze; each commit is indexed in full`
      : `--limit must be an integer between 1 and ${String(MAX_TIMELINE_COMMITS)}`);
  }
  return limit;
}

async function requireCommit(root: string, ref: string, label: string): Promise<void> {
  try {
    await runGit(root, ["rev-parse", "--verify", `${safeRef(ref, label)}^{commit}`]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("unsafe Git ref")) throw error;
    const hasCommits = await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]).then(() => true, () => false);
    throw new Error(hasCommits
      ? `${label} ref does not exist or is not available locally: ${ref}. Check the name, or run git fetch if it is a remote branch.`
      : "This repository has no commits yet. Make a first commit, then list its commits.", { cause: error });
  }
}

async function analyzeCommit(
  root: string,
  commit: ListedCommit,
  service: GitChangeSetService,
  interruptCleanup: Set<string> | undefined,
): Promise<CommitAnalysis> {
  if (commit.parents.length === 0) return { status: "skipped", reason: "root-commit" };
  // `<sha>^` is the first parent: for a merge this is what the merge brought into the branch.
  const source = { kind: "branch", base: `${commit.sha}^`, head: commit.sha } as const;
  let temporaryPath: string | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const changeSet = await service.collect(root, source);
    const materialized = await service.materializeValidationRoot(root, source);
    temporaryPath = materialized.temporaryPath;
    cleanup = materialized.cleanup;
    if (temporaryPath !== undefined) interruptCleanup?.add(temporaryPath);
    const indexed = await createDeterministicValidationIndex(materialized.rootPath);
    // The commit subject is the stated objective: a commit carries no other declared intent.
    const report = new SuperValidator().validate(
      indexed.index,
      changeSet,
      createValidationContract(commit.subject),
      { receipts: [], newSeries: false },
    );
    const findings = { blocking: 0, warning: 0, info: 0 };
    for (const finding of report.findings) findings[finding.severity] += 1;
    return {
      status: "analyzed",
      verdict: report.verdict,
      findings,
      topFindings: [...report.findings]
        .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
        .slice(0, MAX_TOP_FINDINGS)
        .map(({ kind, severity, title }) => ({ kind, severity, title })),
      filesChanged: report.metrics.filesChanged,
      symbolsChanged: report.metrics.symbolsChanged,
      impactedFiles: report.metrics.impactedFiles,
      impactedSymbols: report.metrics.impactedSymbols,
    };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "The commit could not be analyzed" };
  } finally {
    await cleanup?.();
    if (temporaryPath !== undefined) interruptCleanup?.delete(temporaryPath);
  }
}

/**
 * Newest-first commit list with the facts a timeline needs, and optionally the deterministic
 * review of each commit. Read-only: Git runs without a shell, nothing is checked out in the
 * working tree and no model is called.
 */
export async function commitTimeline(options: CommitTimelineOptions = {}): Promise<CommitTimeline> {
  const analyze = options.analyze === true;
  const limit = resolvedLimit(options.limit, analyze);
  const inspection = await inspectRepository(resolve(options.repository ?? "."));
  const root = inspection.root;
  const head = options.head ?? "HEAD";
  const base = options.base ?? null;
  await requireCommit(root, head, "Head");
  if (base !== null) await requireCommit(root, base, "Base");
  const range = base === null ? safeRef(head, "Head") : `${safeRef(base, "Base")}..${safeRef(head, "Head")}`;
  const log = await runGit(root, [
    "log",
    "--no-color",
    "--no-ext-diff",
    "--no-show-signature",
    "--numstat",
    `--max-count=${String(limit + 1)}`,
    `--format=%x1e%H%x1f%P%x1f%an%x1f%aI%x1f%s`,
    range,
    "--",
  ]);
  const listed = parseCommitLog(log.stdout);
  const truncated = listed.length > limit;
  const visible = listed.slice(0, limit);
  const service = new GitChangeSetService();
  const commits: TimelineCommit[] = [];
  for (const commit of visible) {
    const isMerge = commit.parents.length > 1;
    const analysis = analyze ? await analyzeCommit(root, commit, service, options.interruptCleanup) : undefined;
    commits.push({
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      subject: commit.subject,
      author: commit.author,
      authoredAt: commit.authoredAt,
      parents: commit.parents,
      isMerge,
      ...(isMerge ? {} : { stats: commit.stats }),
      ...(analysis === undefined ? {} : { analysis }),
    });
  }
  const verdicts: Record<ValidationVerdict, number> = { pass: 0, warn: 0, block: 0, inconclusive: 0 };
  let unanalyzed = 0;
  for (const commit of commits) {
    if (commit.analysis?.status === "analyzed") verdicts[commit.analysis.verdict] += 1;
    else unanalyzed += 1;
  }
  return {
    schemaVersion: COMMIT_TIMELINE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    repository: { root, name: inspection.name, branch: inspection.currentBranch },
    range: { base, head, limit },
    analyzed: analyze,
    truncated,
    summary: { commits: commits.length, verdicts, unanalyzed },
    commits,
  };
}

function describeAnalysis(analysis: CommitAnalysis | undefined): string {
  if (analysis === undefined) return "";
  if (analysis.status === "skipped") return "  SKIP (root commit)";
  if (analysis.status === "failed") return `  FAILED (${analysis.reason})`;
  const { blocking, warning, info } = analysis.findings;
  return `  ${analysis.verdict.toUpperCase()} (${String(blocking)} blocking, ${String(warning)} warning, ${String(info)} info)`;
}

export function renderCommitTimeline(timeline: CommitTimeline): string {
  const lines = [`Commits: ${timeline.repository.name} (${timeline.repository.branch})`];
  for (const commit of timeline.commits) {
    const date = commit.authoredAt.slice(0, 10);
    const stats = commit.stats === undefined
      ? "merge"
      : `${String(commit.stats.filesChanged)} files +${String(commit.stats.additions)} -${String(commit.stats.deletions)}`;
    lines.push(`- ${commit.shortSha} ${date} ${commit.subject} [${stats}] — ${commit.author}${describeAnalysis(commit.analysis)}`);
    if (commit.analysis?.status === "analyzed") {
      for (const finding of commit.analysis.topFindings) lines.push(`    ${finding.severity.toUpperCase()} ${finding.kind}: ${finding.title}`);
    }
  }
  if (timeline.commits.length === 0) lines.push("No commits in this range.");
  if (timeline.truncated) lines.push(`More commits exist in this range; raise --limit (now ${String(timeline.range.limit)}) to see them.`);
  if (!timeline.analyzed) lines.push("Add --analyze to run the deterministic review on each commit.");
  return lines.join("\n");
}
