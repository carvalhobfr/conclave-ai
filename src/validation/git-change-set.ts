import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve, sep } from "node:path";

import type {
  ChangeSet,
  ChangeSource,
  ValidationChangedFile,
  ValidationChangedFileStatus,
  ChangedLineRange,
} from "../domain/validation.js";

const MAX_GIT_OUTPUT_BYTES = 5_000_000;
const GIT_TIMEOUT_MS = 15_000;
// `~` and `^` allow relative revisions such as HEAD~3; Git runs without a shell, so they are inert.
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@{}+~^-]*$/u;
/**
 * Conclave writes its index and review history here. Reviewing its own output would let one
 * run contaminate the next: the stored reports carry every risk term the router looks for.
 */
const ARTIFACT_DIRECTORY = ".conclave";
const EXCLUDE_ARTIFACTS = `:(exclude,glob)${ARTIFACT_DIRECTORY}/**`;

interface GitOutput {
  readonly stdout: string;
  readonly stderr: string;
}

function safeRef(value: string, label: string): string {
  if (!SAFE_REF.test(value) || value.startsWith("-") || value.includes("..")) {
    throw new Error(label + " contains an unsafe Git ref");
  }
  return value;
}

function runGit(
  repositoryRoot: string,
  args: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
  acceptedExitCodes: readonly number[] = [0],
): Promise<GitOutput> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...args], {
      cwd: resolve(repositoryRoot),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        ...extraEnvironment,
      },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (outputBytes + chunk.length > MAX_GIT_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        throw new Error("Git output exceeded the validation limit");
      }
      outputBytes += chunk.length;
      if (target === "stdout") stdoutChunks.push(chunk);
      else stderrChunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        append("stdout", chunk);
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error("Git output capture failed", { cause: error }));
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        append("stderr", chunk);
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error("Git output capture failed", { cause: error }));
        }
      }
    });
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Git change collection timed out"));
      }
    }, GIT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const output = {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      };
      if (!acceptedExitCodes.includes(code ?? -1)) {
        reject(new Error("Git command failed: " + output.stderr.trim()));
        return;
      }
      resolvePromise(output);
    });
  });
}

function normalizedPath(raw: string): string | undefined {
  if (raw === "/dev/null") return undefined;
  let value = raw.trim();
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") value = parsed;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/")) return undefined;
  return normalized;
}

function statusFromCode(code: string): ValidationChangedFileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "unknown";
  }
}

export function parseNameStatus(output: string): readonly ValidationChangedFile[] {
  const values = output.split("\0").filter((value) => value !== "");
  const files: ValidationChangedFile[] = [];
  for (let index = 0; index < values.length;) {
    const code = values[index];
    if (code === undefined) break;
    index += 1;
    const status = statusFromCode(code);
    if (status === "renamed" || status === "copied") {
      const previousPath = values[index];
      const path = values[index + 1];
      index += 2;
      if (previousPath === undefined || path === undefined) continue;
      files.push({ path, previousPath, status, hunks: [] });
      continue;
    }
    const path = values[index];
    index += 1;
    if (path !== undefined) files.push({ path, status, hunks: [] });
  }
  return files;
}

export function parseUnifiedDiff(
  patch: string,
  nameStatus: readonly ValidationChangedFile[],
): readonly ValidationChangedFile[] {
  const files = new Map(nameStatus.map((file) => [file.path, { ...file, hunks: [...file.hunks] }]));
  let oldPath: string | undefined;
  let currentPath: string | undefined;
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- ")) {
      oldPath = normalizedPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentPath = normalizedPath(line.slice(4)) ?? oldPath;
      if (currentPath !== undefined && !files.has(currentPath)) {
        files.set(currentPath, { path: currentPath, status: "unknown", hunks: [] });
      }
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (match === null || currentPath === undefined) continue;
    const range: ChangedLineRange = {
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? "1"),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? "1"),
    };
    const file = files.get(currentPath);
    if (file !== undefined) file.hunks.push(range);
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function sourceArguments(source: ChangeSource): {
  readonly patch: readonly string[];
  readonly names: readonly string[];
} {
  const commonPatch = ["--no-ext-diff", "--no-color", "--unified=0"];
  const commonNames = ["--no-ext-diff", "--name-status", "-z"];
  switch (source.kind) {
    case "working":
      return {
        patch: ["diff", ...commonPatch, "HEAD", "--", EXCLUDE_ARTIFACTS],
        names: ["diff", ...commonNames, "HEAD", "--", EXCLUDE_ARTIFACTS],
      };
    case "workspace":
      throw new Error("Workspace comparisons require a resolved merge base");
    case "staged":
      return {
        patch: ["diff", "--cached", ...commonPatch, "--", EXCLUDE_ARTIFACTS],
        names: ["diff", "--cached", ...commonNames, "--", EXCLUDE_ARTIFACTS],
      };
    case "branch": {
      const base = safeRef(source.base, "Branch");
      const head = source.head === undefined ? "HEAD" : safeRef(source.head, "Head branch");
      return {
        patch: ["diff", ...commonPatch, base + "..." + head, "--", EXCLUDE_ARTIFACTS],
        names: ["diff", ...commonNames, base + "..." + head, "--", EXCLUDE_ARTIFACTS],
      };
    }
    case "commit": {
      const commit = safeRef(source.commit, "Commit");
      return {
        patch: ["show", "--format=", ...commonPatch, commit, "--", EXCLUDE_ARTIFACTS],
        names: ["show", "--format=", ...commonNames, commit, "--", EXCLUDE_ARTIFACTS],
      };
    }
  }
}

function archiveHead(source: ChangeSource): string | undefined {
  if (source.kind !== "branch") return undefined;
  return source.head ?? "HEAD";
}

async function untrackedDiff(repositoryRoot: string, entries: readonly string[]): Promise<{
  readonly patch: string;
  readonly files: readonly ValidationChangedFile[];
}> {
  const patches: string[] = [];
  const files: ValidationChangedFile[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const path = normalizedPath(entry.slice(3));
    if (path === undefined) continue;
    const result = await runGit(
      repositoryRoot,
      ["diff", "--no-index", "--no-color", "--unified=0", "--", "/dev/null", path],
      {},
      [0, 1],
    );
    bytes += Buffer.byteLength(result.stdout, "utf8");
    if (bytes > MAX_GIT_OUTPUT_BYTES) throw new Error("Git output exceeded the validation limit");
    patches.push(result.stdout);
    files.push({ path, status: "added", hunks: [] });
  }
  return { patch: patches.join(""), files };
}

async function refExists(repositoryRoot: string, ref: string, label: string): Promise<void> {
  const checked = safeRef(ref, label);
  try {
    await runGit(repositoryRoot, ["rev-parse", "--verify", `${checked}^{commit}`]);
  } catch (error) {
    const hasCommits = await runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).then(() => true, () => false);
    if (!hasCommits) {
      throw new Error("This repository has no commits yet. Make a first commit, then run the review again.", { cause: error });
    }
    throw new Error(`${label} ref does not exist or is not available locally: ${ref}. Check the name, or run git fetch if it is a remote branch.`, { cause: error });
  }
}

async function materializeArchive(repositoryRoot: string, ref: string): Promise<{ readonly rootPath: string; readonly cleanupPath: string }> {
  const cleanupPath = await mkdtemp(join(tmpdir(), "conclave-git-snapshot-"));
  const destination = join(cleanupPath, "tree");
  await mkdir(destination);
  const indexPath = join(cleanupPath, "index");
  const environment = { GIT_INDEX_FILE: indexPath };
  try {
    await runGit(repositoryRoot, ["read-tree", safeRef(ref, "Head branch")], environment);
    await runGit(repositoryRoot, ["checkout-index", "--all", `--prefix=${destination}${sep}`], environment);
  } catch (error) {
    await rm(cleanupPath, { recursive: true, force: true });
    throw new Error("Git could not materialize the head ref: " + (error instanceof Error ? error.message : "unknown error"), { cause: error });
  }
  return { rootPath: destination, cleanupPath };
}

export class GitChangeSetService {
  public async collect(repositoryRoot: string, source: ChangeSource): Promise<ChangeSet> {
    const root = resolve(repositoryRoot);
    const statusEntries = (await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      .stdout.split("\0")
      .filter((entry) => entry !== "")
      .filter((entry) => !entry.slice(3).startsWith(`${ARTIFACT_DIRECTORY}/`));
    const untracked = statusEntries
      .filter((entry) => entry.startsWith("?? "))
      .filter((entry) => !entry.slice(3).startsWith(`${ARTIFACT_DIRECTORY}/`));
    if (source.kind === "staged" && untracked.length > 0) {
      throw new Error(
        "Untracked files are not silently excluded from this validation; stage them, add them to ignore rules, or choose a branch/commit comparison",
      );
    }
    if (
      source.kind === "staged" &&
      statusEntries.some((entry) => !entry.startsWith("?? ") && (entry[1] ?? " ") !== " ")
    ) {
      throw new Error("--staged requires no unstaged changes so the index matches the staged snapshot");
    }
    if (source.kind === "commit" && statusEntries.length > 0) {
      throw new Error("--commit requires a clean working tree so graph evidence matches HEAD");
    }
    const requestedHead = archiveHead(source);
    if (source.kind === "branch") {
      await refExists(root, source.base, "Base");
      await refExists(root, requestedHead ?? "HEAD", "Head");
    }
    if (source.kind === "workspace") await refExists(root, source.base, "Base");
    const headSha = (await runGit(root, ["rev-parse", requestedHead ?? "HEAD"])).stdout.trim();
    if (source.kind === "commit") {
      const targetSha = (await runGit(root, ["rev-parse", safeRef(source.commit, "Commit")])).stdout.trim();
      if (targetSha !== headSha) {
        throw new Error("--commit must identify the checked-out HEAD so graph evidence matches the change");
      }
    }
    const resolvedArgs = source.kind === "workspace"
      ? await (async () => {
        const mergeBase = (await runGit(root, ["merge-base", safeRef(source.base, "Base"), "HEAD"])).stdout.trim();
        return {
          patch: ["diff", "--no-ext-diff", "--no-color", "--unified=0", mergeBase, "--", EXCLUDE_ARTIFACTS],
          names: ["diff", "--no-ext-diff", "--name-status", "-z", mergeBase, "--", EXCLUDE_ARTIFACTS],
        };
      })()
      : sourceArguments(source);
    const [patch, names, extra] = await Promise.all([
      runGit(root, resolvedArgs.patch),
      runGit(root, resolvedArgs.names),
      source.kind === "working" || source.kind === "workspace"
        ? untrackedDiff(root, untracked)
        : Promise.resolve({ patch: "", files: [] }),
    ]);
    const patchText = patch.stdout + extra.patch;
    if (Buffer.byteLength(patchText, "utf8") > MAX_GIT_OUTPUT_BYTES) {
      throw new Error("Git output exceeded the validation limit");
    }
    const namedFiles = [...parseNameStatus(names.stdout), ...extra.files]
      .filter((file, index, all) => all.findIndex((candidate) => candidate.path === file.path) === index);
    return {
      source,
      headSha,
      files: parseUnifiedDiff(patchText, namedFiles),
      patch: patchText,
      collectedAt: new Date().toISOString(),
    };
  }

  /** Materializes an immutable Git tree for branch validation, excluding working-tree and untracked files. */
  public async materializeValidationRoot(repositoryRoot: string, source: ChangeSource): Promise<{
    readonly rootPath: string;
    readonly cleanup: () => Promise<void>;
  }> {
    const ref = archiveHead(source);
    if (ref === undefined) return { rootPath: resolve(repositoryRoot), cleanup: () => Promise.resolve() };
    const materialized = await materializeArchive(repositoryRoot, ref);
    return { rootPath: materialized.rootPath, cleanup: () => rm(materialized.cleanupPath, { recursive: true, force: true }) };
  }
}
