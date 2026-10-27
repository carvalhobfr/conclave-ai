import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { check } from "../src/lib.js";
import { saveReviewHistory } from "../src/storage/review-history.js";
import {
  countWorktree,
  MAX_STATUS_REPOSITORIES,
  renderRepositoryStatus,
  repositoryStatus,
  type AvailableRepositoryStatus,
} from "../src/workflow/repository-status.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Conclave Test",
      GIT_AUTHOR_EMAIL: "conclave@example.invalid",
      GIT_COMMITTER_NAME: "Conclave Test",
      GIT_COMMITTER_EMAIL: "conclave@example.invalid",
    },
  });
  return stdout.trim();
}

async function repository(prefix = "conclave-status-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "refund.ts"), "export function refund(cents: number) {\n  return cents;\n}\n");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "baseline"]);
  return root;
}

function available(entry: Awaited<ReturnType<typeof repositoryStatus>>["repositories"][number] | undefined): AvailableRepositoryStatus {
  if (entry === undefined || !entry.ok) throw new Error("expected an available repository");
  return entry;
}

describe("countWorktree", () => {
  it("counts staged, changed, new and conflicted entries, and follows a rename's second path", () => {
    const porcelain = [
      "M  staged.ts",
      " M changed.ts",
      "MM both.ts",
      "R  new-name.ts",
      "old-name.ts",
      "?? fresh.ts",
      "?? .conclave/state.json",
      "UU conflict.ts",
      "!! ignored.log",
      "",
    ].join("\0");
    expect(countWorktree(porcelain)).toEqual({ staged: 3, unstaged: 2, untracked: 1, conflicted: 1 });
  });

  it("keeps a leading-space entry intact", () => {
    expect(countWorktree(" M only-changed.ts\0")).toEqual({ staged: 0, unstaged: 1, untracked: 0, conflicted: 0 });
  });
});

describe("repositoryStatus", () => {
  it("describes a clean repository that was never reviewed", async () => {
    const root = await repository();
    const snapshot = await repositoryStatus({ repositories: [root] });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.summary).toEqual({ repositories: 1, unavailable: 0, dirty: 0, blocked: 0, needsReview: 1 });
    const entry = available(snapshot.repositories[0]);
    expect(entry.branch).toBe("main");
    expect(entry.head?.subject).toBe("baseline");
    expect(entry.head?.shortSha).toBe(entry.head?.sha.slice(0, 7));
    expect(entry.upstream).toBeNull();
    expect(entry.worktree).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    expect(entry.clean).toBe(true);
    expect(entry.lastReview).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain("example.invalid");
  });

  it("counts uncommitted work and reports ahead/behind of the upstream", async () => {
    const origin = await repository("conclave-status-origin-");
    const cloneRoot = await mkdtemp(join(tmpdir(), "conclave-status-clone-"));
    roots.push(cloneRoot);
    const clone = join(cloneRoot, "work");
    await git(origin, ["config", "receive.denyCurrentBranch", "ignore"]);
    await execFileAsync("git", ["clone", "-q", origin, clone]);
    // Behind: the origin gains a commit. Ahead: the clone gains two.
    await writeFile(join(origin, "origin.txt"), "x\n");
    await git(origin, ["add", "."]);
    await git(origin, ["commit", "-m", "origin moves"]);
    await git(clone, ["fetch", "-q"]);
    for (const name of ["a.txt", "b.txt"]) {
      await writeFile(join(clone, name), "x\n");
      await git(clone, ["add", "."]);
      await git(clone, ["commit", "-m", `add ${name}`]);
    }
    await writeFile(join(clone, "src", "refund.ts"), "export const refund = 1;\n");
    await writeFile(join(clone, "staged.ts"), "export const staged = 1;\n");
    await git(clone, ["add", "staged.ts"]);
    await writeFile(join(clone, "untracked.ts"), "export const fresh = 1;\n");

    const entry = available((await repositoryStatus({ repositories: [clone] })).repositories[0]);
    expect(entry.upstream).toEqual({ ref: "origin/main", ahead: 2, behind: 1 });
    expect(entry.worktree).toEqual({ staged: 1, unstaged: 1, untracked: 1, conflicted: 0 });
    expect(entry.clean).toBe(false);
    expect(renderRepositoryStatus(await repositoryStatus({ repositories: [clone] }))).toContain("origin/main +2 -1");
  });

  it("reports a conflict and a detached HEAD", async () => {
    const root = await repository();
    await git(root, ["checkout", "-q", "-b", "side"]);
    await writeFile(join(root, "src", "refund.ts"), "export const side = 1;\n");
    await git(root, ["commit", "-qam", "side change"]);
    await git(root, ["checkout", "-q", "main"]);
    await writeFile(join(root, "src", "refund.ts"), "export const main = 1;\n");
    await git(root, ["commit", "-qam", "main change"]);
    await execFileAsync("git", ["merge", "side"], { cwd: root }).catch(() => undefined);

    const merging = available((await repositoryStatus({ repositories: [root] })).repositories[0]);
    expect(merging.worktree.conflicted).toBe(1);

    await git(root, ["merge", "--abort"]);
    await git(root, ["checkout", "-q", "--detach", "HEAD"]);
    expect(available((await repositoryStatus({ repositories: [root] })).repositories[0]).branch).toBeNull();
  });

  it("reads the last saved review and notices when HEAD moves", async () => {
    const root = await repository();
    await writeFile(join(root, "src", "refund.ts"), "export function refund(cents: number) {\n  return Math.max(0, cents);\n}\n");
    const result = await check({ repository: root, objective: "Clamp refunds" });
    await saveReviewHistory(root, {
      id: result.report.lineage.reviewId,
      createdAt: new Date().toISOString(),
      repository: root,
      objective: result.report.objective,
      headSha: result.report.changeSet.headSha,
      summary: result.summary,
      report: result.report,
      handoff: result.handoff,
    });

    const reviewed = available((await repositoryStatus({ repositories: [root] })).repositories[0]);
    expect(reviewed.lastReview?.verdict).toBe(result.verdict);
    expect(reviewed.lastReview?.headMatches).toBe(true);
    expect(reviewed.lastReview?.objective).toBe("Clamp refunds");
    const counts = reviewed.lastReview?.findings;
    expect(counts).not.toBeNull();
    expect((counts?.blocking ?? 0) + (counts?.warning ?? 0) + (counts?.info ?? 0)).toBe(result.report.findings.length);
    expect(reviewed.worktree.conflicted).toBe(0);
    expect((await repositoryStatus({ repositories: [root] })).summary.needsReview).toBe(0);
    // Saving the review created .conclave; it must not count as untracked work.
    expect(reviewed.worktree.untracked).toBe(0);

    await git(root, ["commit", "-qam", "clamp"]);
    const moved = await repositoryStatus({ repositories: [root] });
    expect(available(moved.repositories[0]).lastReview?.headMatches).toBe(false);
    expect(moved.summary.needsReview).toBe(1);
  });

  it("reports a folder that is not a repository without failing the others", async () => {
    const root = await repository();
    const plain = await mkdtemp(join(tmpdir(), "conclave-status-plain-"));
    roots.push(plain);
    const snapshot = await repositoryStatus({ repositories: [plain, root, join(plain, "missing")] });

    expect(snapshot.repositories.map((entry) => entry.ok)).toEqual([false, true, false]);
    expect(snapshot.summary).toEqual(expect.objectContaining({ repositories: 3, unavailable: 2 }));
    expect(renderRepositoryStatus(snapshot)).toContain("is not inside a Git repository");
  });

  it("writes nothing to the repository", async () => {
    const root = await repository();
    const before = await git(root, ["status", "--porcelain"]);
    await repositoryStatus({ repositories: [root] });
    expect(await git(root, ["status", "--porcelain"])).toBe(before);
  });

  it("limits how many repositories one call accepts", async () => {
    const many = Array.from({ length: MAX_STATUS_REPOSITORIES + 1 }, () => ".");
    await expect(repositoryStatus({ repositories: many })).rejects.toThrow("at most 50 repositories");
  });

  it("emits only fields the published schema declares", async () => {
    const root = await repository();
    const plain = await mkdtemp(join(tmpdir(), "conclave-status-schema-"));
    roots.push(plain);
    const snapshot = await repositoryStatus({ repositories: [root, plain] });
    const schema = JSON.parse(await readFile(resolve("schemas/status.v1.schema.json"), "utf8")) as {
      properties: Record<string, unknown> & { summary: { properties: Record<string, unknown> } };
      $defs: Record<"available" | "unavailable", { properties: Record<string, unknown> }>;
    };
    const undeclared = (value: object, declared: Record<string, unknown>): string[] => Object.keys(value).filter((key) => !(key in declared));
    expect(undeclared(snapshot, schema.properties)).toEqual([]);
    expect(undeclared(snapshot.summary, schema.properties.summary.properties)).toEqual([]);
    for (const entry of snapshot.repositories) {
      expect(undeclared(entry, schema.$defs[entry.ok ? "available" : "unavailable"].properties)).toEqual([]);
    }
  });
});
