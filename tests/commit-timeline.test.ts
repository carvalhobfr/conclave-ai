import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { commitTimeline, parseCommitLog, renderCommitTimeline } from "../src/workflow/commit-timeline.js";

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

async function commit(root: string, subject: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", subject]);
}

/** root, then two linear commits, then a side branch merged with a merge commit. */
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-timeline-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await commit(root, "feat: add refund", { "src/refund.ts": "export function refund(cents: number) {\n  return cents;\n}\n" });
  await commit(root, "fix: never refund a negative amount", {
    "src/refund.ts": "export function refund(cents: number) {\n  return Math.max(0, cents);\n}\n",
  });
  await git(root, ["checkout", "-b", "side"]);
  await commit(root, "feat: add receipts", { "src/receipt.ts": "export const receipt = 1;\nexport const total = 2;\n" });
  await git(root, ["checkout", "main"]);
  await commit(root, "docs: describe refunds", { "README.md": "# Refunds\n" });
  await git(root, ["merge", "--no-ff", "-m", "merge: receipts", "side"]);
  return root;
}

describe("parseCommitLog", () => {
  const sha = "a".repeat(40);
  const parent = "b".repeat(40);

  it("counts files and lines from numstat and treats binary files as lines-free", () => {
    const output = [
      `\u001e${sha}\u001f${parent}\u001fAda\u001f2026-10-22T10:00:00+00:00\u001ffeat: x`,
      "",
      "3\t1\tsrc/a.ts",
      "-\t-\tassets/logo.png",
      "",
    ].join("\n");
    expect(parseCommitLog(output)).toEqual([{
      sha,
      parents: [parent],
      author: "Ada",
      authoredAt: "2026-10-22T10:00:00+00:00",
      subject: "feat: x",
      stats: { filesChanged: 2, additions: 3, deletions: 1 },
    }]);
  });

  it("reads several parents, an empty parent list and a subject without numstat", () => {
    const output = `\u001e${sha}\u001f${parent} ${"c".repeat(40)}\u001fAda\u001f2026-10-22T10:00:00+00:00\u001fmerge\n\u001e${parent}\u001f\u001fAda\u001f2026-10-21T10:00:00+00:00\u001froot\n`;
    const [merge, root] = parseCommitLog(output);
    expect(merge?.parents).toHaveLength(2);
    expect(root?.parents).toEqual([]);
    expect(merge?.stats.filesChanged).toBe(0);
  });

  it("ignores records that are not commits", () => {
    expect(parseCommitLog("\u001enot-a-sha\u001f\u001fAda\u001f2026-10-22T10:00:00+00:00\u001fx\n")).toEqual([]);
    expect(parseCommitLog("")).toEqual([]);
  });
});

describe("commitTimeline", () => {
  it("lists commits newest first with size, author name and merge flag", async () => {
    const root = await repository();
    const timeline = await commitTimeline({ repository: root });

    expect(timeline.schemaVersion).toBe(1);
    expect(timeline.analyzed).toBe(false);
    expect(timeline.truncated).toBe(false);
    expect(timeline.repository.branch).toBe("main");
    expect(timeline.commits.map((item) => item.subject)).toEqual([
      "merge: receipts",
      "docs: describe refunds",
      "feat: add receipts",
      "fix: never refund a negative amount",
      "feat: add refund",
    ]);
    const [merge, docs, receipts] = timeline.commits;
    expect(merge?.isMerge).toBe(true);
    expect(merge?.parents).toHaveLength(2);
    expect(merge?.stats).toBeUndefined();
    expect(docs?.stats).toEqual({ filesChanged: 1, additions: 1, deletions: 0 });
    expect(receipts?.stats).toEqual({ filesChanged: 1, additions: 2, deletions: 0 });
    expect(timeline.commits.every((item) => item.author === "Conclave Test" && item.shortSha === item.sha.slice(0, 7))).toBe(true);
    expect(JSON.stringify(timeline)).not.toContain("example.invalid");
    expect(timeline.commits.every((item) => item.analysis === undefined)).toBe(true);
    expect(timeline.summary).toEqual({
      commits: 5,
      verdicts: { pass: 0, warn: 0, block: 0, inconclusive: 0 },
      unanalyzed: 5,
    });
  });

  it("truncates to the limit and says so", async () => {
    const root = await repository();
    const timeline = await commitTimeline({ repository: root, limit: 2 });
    expect(timeline.commits).toHaveLength(2);
    expect(timeline.truncated).toBe(true);
    expect(renderCommitTimeline(timeline)).toContain("raise --limit");
  });

  it("lists only what a base ref leaves out, and another head", async () => {
    const root = await repository();
    const fix = await git(root, ["rev-parse", "main~2"]);
    const sinceFix = await commitTimeline({ repository: root, base: fix });
    expect(sinceFix.commits.map((item) => item.subject)).toEqual(["merge: receipts", "docs: describe refunds", "feat: add receipts"]);
    expect(sinceFix.range.base).toBe(fix);

    const side = await commitTimeline({ repository: root, head: "side" });
    expect(side.commits[0]?.subject).toBe("feat: add receipts");
    expect(side.commits.some((item) => item.subject === "docs: describe refunds")).toBe(false);
  });

  it("reviews each commit against its parent without touching the working tree", async () => {
    const root = await repository();
    const registered = new Set<string>();
    const before = await git(root, ["status", "--porcelain"]);
    const timeline = await commitTimeline({ repository: root, analyze: true, limit: 5, interruptCleanup: registered });

    expect(timeline.analyzed).toBe(true);
    const rootCommit = timeline.commits.at(-1);
    expect(rootCommit?.analysis).toEqual({ status: "skipped", reason: "root-commit" });
    const reviewed = timeline.commits.filter((item) => item.analysis?.status === "analyzed");
    expect(reviewed).toHaveLength(4);
    for (const item of reviewed) {
      if (item.analysis?.status !== "analyzed") throw new Error("unreachable");
      expect(["pass", "warn", "block", "inconclusive"]).toContain(item.analysis.verdict);
      expect(item.analysis.topFindings.length).toBeLessThanOrEqual(5);
    }
    const fix = timeline.commits.find((item) => item.subject.startsWith("fix:"));
    expect(fix?.analysis).toEqual(expect.objectContaining({ status: "analyzed", filesChanged: 1 }));
    const tally = Object.values(timeline.summary.verdicts).reduce((sum, count) => sum + count, 0);
    expect(tally).toBe(4);
    expect(timeline.summary.unanalyzed).toBe(1);
    expect(registered.size).toBe(0);
    expect(await git(root, ["status", "--porcelain"])).toBe(before);
    expect(await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("rejects out-of-range limits, unsafe refs and unknown refs", async () => {
    const root = await repository();
    await expect(commitTimeline({ repository: root, limit: 0 })).rejects.toThrow("--limit must be an integer between 1 and 100");
    await expect(commitTimeline({ repository: root, limit: 101 })).rejects.toThrow("between 1 and 100");
    await expect(commitTimeline({ repository: root, analyze: true, limit: 26 })).rejects.toThrow("between 1 and 25 with --analyze");
    await expect(commitTimeline({ repository: root, base: "--output=/tmp/x" })).rejects.toThrow("unsafe Git ref");
    await expect(commitTimeline({ repository: root, base: "no-such-ref" })).rejects.toThrow("Base ref does not exist");
    await expect(commitTimeline({ repository: root, head: "no-such-ref" })).rejects.toThrow("Head ref does not exist");
  });

  it("explains an empty repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-timeline-empty-"));
    roots.push(root);
    await git(root, ["init", "-b", "main"]);
    await expect(commitTimeline({ repository: root })).rejects.toThrow("no commits yet");
  });

  it("emits only fields the published schema declares", async () => {
    const root = await repository();
    const timeline = await commitTimeline({ repository: root, analyze: true, limit: 5 });
    const schema = JSON.parse(await readFile(resolve("schemas/commit-timeline.v1.schema.json"), "utf8")) as {
      properties: Record<string, unknown>;
      $defs: { commit: { properties: Record<string, unknown> }; analysis: { oneOf: readonly { properties: Record<string, unknown> }[] } };
    };
    const undeclared = (value: object, declared: Record<string, unknown>): string[] => Object.keys(value).filter((key) => !(key in declared));
    expect(undeclared(timeline, schema.properties)).toEqual([]);
    for (const item of timeline.commits) {
      expect(undeclared(item, schema.$defs.commit.properties)).toEqual([]);
      const variant = schema.$defs.analysis.oneOf.find((candidate) => (candidate.properties["status"] as { const: string }).const === item.analysis?.status);
      expect(variant).toBeDefined();
      if (item.analysis !== undefined && variant !== undefined) expect(undeclared(item.analysis, variant.properties)).toEqual([]);
    }
  });
});
