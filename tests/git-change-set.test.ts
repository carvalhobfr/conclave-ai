import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  GitChangeSetService,
  parseNameStatus,
  parseUnifiedDiff,
} from "../src/validation/git-change-set.js";

const execFileAsync = promisify(execFile);

async function runGit(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Conclave Test",
      GIT_AUTHOR_EMAIL: "conclave@example.invalid",
      GIT_COMMITTER_NAME: "Conclave Test",
      GIT_COMMITTER_EMAIL: "conclave@example.invalid",
    },
  });
}

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-git-change-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "session.ts"), "export const session = \"old\";\n");
  await runGit(root, ["init", "-b", "master"]);
  await runGit(root, ["add", "--", "src/session.ts"]);
  await runGit(root, ["commit", "-m", "baseline"]);
  await writeFile(join(root, "src", "session.ts"), "export const session = \"restored\";\n");
  return root;
}

describe("GitChangeSetService parsers", () => {
  it("parses NUL-delimited statuses and zero-context hunk ranges", () => {
    const statuses = parseNameStatus(
      "M\0src/session.ts\0R100\0src/old.ts\0src/new.ts\0",
    );
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/session.ts b/src/session.ts",
        "--- a/src/session.ts",
        "+++ b/src/session.ts",
        "@@ -2,1 +2,2 @@",
        "-  return oldValue;",
        "+  const value = restore();",
        "+  return value;",
        "",
      ].join("\n"),
      statuses,
    );

    expect(files).toEqual([
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        hunks: [],
      },
      {
        path: "src/session.ts",
        status: "modified",
        hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 2 }],
      },
    ]);
  });
  it("collects tracked and untracked working-tree files without silently omitting either", async () => {
    const root = await gitFixture();
    const service = new GitChangeSetService();

    const collected = await service.collect(root, { kind: "working" });
    expect(collected.headSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(collected.files).toEqual([
      expect.objectContaining({
        path: "src/session.ts",
        status: "modified",
        hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }],
      }),
    ]);
    expect(collected.patch).toContain('session = "restored"');

    await writeFile(join(root, "src", "untracked.ts"), "export const unsafeToIgnore = true;\n");
    const withUntracked = await service.collect(root, { kind: "working" });
    expect(withUntracked.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/session.ts", status: "modified" }),
      expect.objectContaining({ path: "src/untracked.ts", status: "added" }),
    ]));
    expect(withUntracked.patch).toContain("unsafeToIgnore");
  });

  it("compares a PR base with committed and local workspace changes together", async () => {
    const root = await gitFixture();
    const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await runGit(root, ["add", "--", "src/session.ts"]);
    await runGit(root, ["commit", "-m", "feature"]);
    await writeFile(join(root, "src", "local.ts"), "export const local = true;\n");
    const collected = await new GitChangeSetService().collect(root, { kind: "workspace", base });
    expect(collected.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/session.ts", status: "modified" }),
      expect.objectContaining({ path: "src/local.ts", status: "added" }),
    ]));
  });

  it("compares an explicit base and head without reading the current worktree", async () => {
    const root = await gitFixture();
    await runGit(root, ["add", "--", "src/session.ts"]);
    await runGit(root, ["commit", "-m", "feature"]);
    const featureHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    await runGit(root, ["switch", "--detach", "HEAD~1"]);
    await writeFile(join(root, "untracked.ts"), "export const ignoredByBranchReview = true;\n");
    const service = new GitChangeSetService();
    const collected = await service.collect(root, { kind: "branch", base: "HEAD", head: featureHead });
    expect(collected.files).toEqual([
      expect.objectContaining({ path: "src/session.ts", status: "modified" }),
    ]);
    const materialized = await service.materializeValidationRoot(root, { kind: "branch", base: "HEAD", head: featureHead });
    await expect(readFile(join(materialized.rootPath, "src/session.ts"), "utf8")).resolves.toContain("restored");
    await expect(readFile(join(materialized.rootPath, "untracked.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await materialized.cleanup();
  });

  it("allows a branch comparison with unrelated untracked files", async () => {
    const root = await gitFixture();
    await writeFile(join(root, "notes.txt"), "local notes\n");
    const service = new GitChangeSetService();
    await expect(service.collect(root, { kind: "branch", base: "HEAD" })).resolves.toBeDefined();
  });

  it("never reviews its own index cache or history as part of the change", async () => {
    const root = await gitFixture();
    await mkdir(join(root, ".conclave"), { recursive: true });
    await writeFile(join(root, ".conclave", "code-index-v2.json"), "{\"performance\":true}\n");
    await writeFile(join(root, ".conclave", "review-history.json"), "{\"cache\":true}\n");

    const changeSet = await new GitChangeSetService().collect(root, { kind: "working" });

    expect(changeSet.files.map((file) => file.path)).toEqual(["src/session.ts"]);
    expect(changeSet.patch).not.toContain(".conclave");
  });

  it("excludes a staged .conclave artifact instead of failing the staged guard on it", async () => {
    const root = await gitFixture();
    await runGit(root, ["add", "--", "src/session.ts"]);
    await mkdir(join(root, ".conclave"), { recursive: true });
    await writeFile(join(root, ".conclave", "code-index-v2.json"), "{}\n");

    const changeSet = await new GitChangeSetService().collect(root, { kind: "staged" });

    expect(changeSet.files.map((file) => file.path)).toEqual(["src/session.ts"]);
  });

});

describe("friendly ref handling", () => {
  it("accepts relative revisions such as HEAD~1", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-relative-ref-"));
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    await runGit(root, ["init", "-b", "master"]);
    await runGit(root, ["add", "."]);
    await runGit(root, ["commit", "-m", "one"]);
    await writeFile(join(root, "a.ts"), "export const a = 2;\n");
    await runGit(root, ["commit", "-am", "two"]);
    const changeSet = await new GitChangeSetService().collect(root, { kind: "workspace", base: "HEAD~1" });
    expect(changeSet.files.map((file) => file.path)).toEqual(["a.ts"]);
  });

  it("explains a repository without commits instead of suggesting git fetch", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-no-commits-"));
    await runGit(root, ["init", "-b", "master"]);
    await expect(new GitChangeSetService().collect(root, { kind: "workspace", base: "HEAD" })).rejects.toThrow(/no commits yet/);
  });
});
