import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { ValidationFindingSeverity, ValidationVerdict } from "../domain/validation.js";
import { listReviewHistory } from "../storage/review-history.js";
import { runGit } from "../validation/git-change-set.js";

export const REPOSITORY_STATUS_SCHEMA_VERSION = 1;
export const MAX_STATUS_REPOSITORIES = 50;
const FIELD_SEPARATOR = "\u001f";
const FULL_SHA = /^[a-f0-9]{40,64}$/u;
/**
 * A status poll must neither write to the repository nor run a program its configuration names:
 * no optional lock on the index, and no file-system monitor hook.
 */
const READ_ONLY_GIT = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "--no-optional-locks"] as const;
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export interface RepositoryStatusOptions {
  /** Repository folders. Defaults to the current directory. At most 50. */
  readonly repositories?: readonly string[];
}

export interface StatusLastReview {
  readonly reviewId: string;
  readonly createdAt: string;
  readonly verdict: ValidationVerdict;
  readonly objective: string;
  readonly headSha: string;
  /** False once HEAD has moved since the review. Edits made after a review at the same HEAD are not detected. */
  readonly headMatches: boolean;
  /** Absent for reviews saved without a full report. */
  readonly findings: Readonly<Record<ValidationFindingSeverity, number>> | null;
}

export interface AvailableRepositoryStatus {
  readonly path: string;
  readonly ok: true;
  readonly root: string;
  readonly name: string;
  /** Null on a detached HEAD. */
  readonly branch: string | null;
  /** Null in a repository with no commits yet. */
  readonly head: { readonly sha: string; readonly shortSha: string; readonly subject: string; readonly authoredAt: string } | null;
  /** Null when the branch tracks nothing. */
  readonly upstream: { readonly ref: string; readonly ahead: number; readonly behind: number } | null;
  readonly worktree: {
    readonly staged: number;
    readonly unstaged: number;
    readonly untracked: number;
    readonly conflicted: number;
  };
  readonly clean: boolean;
  readonly lastReview: StatusLastReview | null;
}

export interface UnavailableRepositoryStatus {
  readonly path: string;
  readonly ok: false;
  readonly error: string;
}

export type RepositoryStatusEntry = AvailableRepositoryStatus | UnavailableRepositoryStatus;

export interface RepositoryStatusSnapshot {
  readonly schemaVersion: typeof REPOSITORY_STATUS_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly summary: {
    readonly repositories: number;
    readonly unavailable: number;
    /** Repositories with uncommitted work. */
    readonly dirty: number;
    /** Repositories whose last review blocked and still matches HEAD. */
    readonly blocked: number;
    /** Repositories never reviewed, or whose HEAD moved since the last review. */
    readonly needsReview: number;
  };
  readonly repositories: readonly RepositoryStatusEntry[];
}

/** Git's output, or undefined when the command fails. `-z` output is returned untrimmed: its first entry may start with a space. */
async function gitText(root: string, args: readonly string[], trim = true): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(root, [...READ_ONLY_GIT, ...args]);
    return trim ? stdout.trim() : stdout;
  } catch {
    return undefined;
  }
}

export function countWorktree(porcelain: string): AvailableRepositoryStatus["worktree"] {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  const entries = porcelain.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    // A rename or copy is followed by its source path as a separate, unprefixed entry.
    if (code.includes("R") || code.includes("C")) index += 1;
    // Conclave's own cache is never part of the work.
    if (entry.slice(3).startsWith(".conclave/")) continue;
    if (code === "??") untracked += 1;
    else if (code === "!!") continue;
    else if (UNMERGED.has(code)) conflicted += 1;
    else {
      if (code[0] !== " ") staged += 1;
      if (code[1] !== " ") unstaged += 1;
    }
  }
  return { staged, unstaged, untracked, conflicted };
}

function parseHead(output: string | undefined): AvailableRepositoryStatus["head"] {
  if (output === undefined) return null;
  const [sha, authoredAt, ...subject] = output.split(FIELD_SEPARATOR);
  if (sha === undefined || !FULL_SHA.test(sha) || authoredAt === undefined) return null;
  return { sha, shortSha: sha.slice(0, 7), subject: subject.join(FIELD_SEPARATOR), authoredAt };
}

async function lastReviewOf(root: string, currentSha: string | undefined): Promise<StatusLastReview | null> {
  const record = (await listReviewHistory(root))[0];
  if (record === undefined) return null;
  const counts = record.report === undefined ? null : { blocking: 0, warning: 0, info: 0 };
  if (counts !== null && record.report !== undefined) {
    for (const finding of record.report.findings) counts[finding.severity] += 1;
  }
  return {
    reviewId: record.id,
    createdAt: record.createdAt,
    verdict: record.summary.verdict,
    objective: record.objective,
    headSha: record.headSha,
    headMatches: currentSha !== undefined && record.headSha === currentSha,
    findings: counts,
  };
}

async function statusOf(path: string): Promise<RepositoryStatusEntry> {
  const requested = resolve(path);
  const top = await gitText(requested, ["rev-parse", "--show-toplevel"]);
  if (top === undefined || top === "") return { path, ok: false, error: `${requested} is not inside a Git repository` };
  const root = await realpath(top).catch(() => resolve(top));
  const [branch, head, porcelain, upstream] = await Promise.all([
    gitText(root, ["branch", "--show-current"]),
    gitText(root, ["log", "-1", "--no-show-signature", `--format=%H${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s`]),
    gitText(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], false),
    gitText(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
  ]);
  const parsedHead = parseHead(head);
  let tracking: AvailableRepositoryStatus["upstream"] = null;
  if (upstream !== undefined && upstream !== "" && parsedHead !== null) {
    const counts = await gitText(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    const [behind, ahead] = (counts ?? "").split(/\s+/u).map(Number);
    if (behind !== undefined && ahead !== undefined && Number.isInteger(behind) && Number.isInteger(ahead)) {
      tracking = { ref: upstream, ahead, behind };
    }
  }
  const worktree = countWorktree(porcelain ?? "");
  return {
    path,
    ok: true,
    root,
    name: basename(root),
    branch: branch === undefined || branch === "" ? null : branch,
    head: parsedHead,
    upstream: tracking,
    worktree,
    clean: worktree.staged + worktree.unstaged + worktree.untracked + worktree.conflicted === 0,
    lastReview: await lastReviewOf(root, parsedHead?.sha),
  };
}

/**
 * A compact, poll-friendly picture of one or more repositories: branch, tracking, uncommitted
 * work and the last saved Conclave review. Read-only: it writes nothing, makes no model call and
 * a folder that is not a repository is reported, not fatal.
 */
export async function repositoryStatus(options: RepositoryStatusOptions = {}): Promise<RepositoryStatusSnapshot> {
  const paths = options.repositories === undefined || options.repositories.length === 0 ? ["."] : options.repositories;
  if (paths.length > MAX_STATUS_REPOSITORIES) {
    throw new Error(`status accepts at most ${String(MAX_STATUS_REPOSITORIES)} repositories at a time`);
  }
  const repositories = await Promise.all(paths.map(statusOf));
  const available = repositories.filter((entry): entry is AvailableRepositoryStatus => entry.ok);
  return {
    schemaVersion: REPOSITORY_STATUS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      repositories: repositories.length,
      unavailable: repositories.length - available.length,
      dirty: available.filter((entry) => !entry.clean).length,
      blocked: available.filter((entry) => entry.lastReview?.verdict === "block" && entry.lastReview.headMatches).length,
      needsReview: available.filter((entry) => entry.lastReview === null || !entry.lastReview.headMatches).length,
    },
    repositories,
  };
}

export function renderRepositoryStatus(snapshot: RepositoryStatusSnapshot): string {
  const lines: string[] = [];
  for (const entry of snapshot.repositories) {
    if (!entry.ok) {
      lines.push(`- ${entry.path}: unavailable — ${entry.error}`);
      continue;
    }
    const tracking = entry.upstream === null ? "no upstream" : `${entry.upstream.ref} +${String(entry.upstream.ahead)} -${String(entry.upstream.behind)}`;
    const work = entry.clean
      ? "clean"
      : `${String(entry.worktree.staged)} staged, ${String(entry.worktree.unstaged)} changed, ${String(entry.worktree.untracked)} new${entry.worktree.conflicted > 0 ? `, ${String(entry.worktree.conflicted)} conflicted` : ""}`;
    const review = entry.lastReview === null
      ? "never reviewed"
      : `${entry.lastReview.verdict.toUpperCase()}${entry.lastReview.headMatches ? "" : " (HEAD moved since)"}`;
    lines.push(`- ${entry.name} ${entry.branch ?? "(detached)"} · ${tracking} · ${work} · ${review}`);
  }
  return lines.join("\n");
}
