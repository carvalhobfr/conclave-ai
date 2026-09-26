import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

export interface RepositoryInspection {
  readonly root: string;
  readonly name: string;
  readonly currentBranch: string;
  readonly defaultBase: string;
  readonly branches: readonly string[];
  readonly status: {
    readonly staged: number;
    readonly unstaged: number;
    readonly untracked: number;
  };
  readonly latestCommit: string;
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function git(cwd: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function successful(cwd: string, args: readonly string[]): Promise<string | undefined> {
  const result = await git(cwd, args);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function refExists(root: string, ref: string): Promise<boolean> {
  return (await git(root, ["show-ref", "--verify", "--quiet", ref])).code === 0;
}

async function defaultBase(root: string, current: string): Promise<string> {
  const symbolic = await successful(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolic !== undefined && symbolic !== current) return symbolic;
  const candidates = [
    ["origin/main", "refs/remotes/origin/main"],
    ["main", "refs/heads/main"],
    ["origin/master", "refs/remotes/origin/master"],
    ["master", "refs/heads/master"],
  ] as const;
  for (const [short, full] of candidates) {
    if (short !== current && await refExists(root, full)) return short;
  }
  if (symbolic !== undefined) return symbolic;
  return "HEAD";
}

export async function inspectRepository(path: string): Promise<RepositoryInspection> {
  const requested = resolve(path);
  const rootValue = await successful(requested, ["rev-parse", "--show-toplevel"]);
  if (rootValue === undefined) throw new Error(`${requested} is not inside a Git repository`);
  const root = await realpath(rootValue).catch(() => resolve(rootValue));
  const [branchValue, refsValue, statusResult, latestCommit] = await Promise.all([
    successful(root, ["branch", "--show-current"]),
    successful(root, ["for-each-ref", "--format=%(refname:short)", "--sort=refname", "refs/heads", "refs/remotes"]),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    successful(root, ["log", "-1", "--pretty=%s"]),
  ]);
  const currentBranch = branchValue === undefined || branchValue === "" ? "HEAD" : branchValue;
  // Conclave's own cache is never part of the change, even before its self-ignore file exists.
  const entries = (statusResult.code === 0 ? statusResult.stdout : "").split("\0").filter((entry) => entry !== "" && !entry.startsWith("?? .conclave/"));
  return {
    root,
    name: basename(root),
    currentBranch,
    defaultBase: await defaultBase(root, currentBranch),
    branches: [...new Set((refsValue ?? "").split(/\r?\n/u).map((item) => item.trim()).filter((item) => item !== "" && !item.endsWith("/HEAD")))],
    status: {
      staged: entries.filter((entry) => !entry.startsWith("?? ") && (entry[0] ?? " ") !== " ").length,
      unstaged: entries.filter((entry) => !entry.startsWith("?? ") && (entry[1] ?? " ") !== " ").length,
      untracked: entries.filter((entry) => entry.startsWith("?? ")).length,
    },
    latestCommit: latestCommit ?? "",
  };
}

export function inferredReviewObjective(inspection: RepositoryInspection): string {
  return inspection.latestCommit === ""
    ? "Review the current change for regressions, unexpected impact, and merge risk."
    : `Review “${inspection.latestCommit}” for regressions, unexpected impact, and merge risk.`;
}
