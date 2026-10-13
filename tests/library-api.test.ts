import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { ask, check, handoff } from "../src/lib.js";

const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, ...args: string[]): Promise<void> {
  await run("git", args, {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-lib-"));
  roots.push(root);
  await git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "feat: add a");
  await writeFile(join(root, "a.ts"), "export const a = 2;\nexport function b() { return a; }\n");
  return root;
}

describe("library API", () => {
  it("reviews local changes and reports whether the objective was inferred", async () => {
    const root = await repository();

    const inferred = await check({ repository: root });
    expect(inferred.objectiveInferred).toBe(true);
    expect(inferred.report.objective).toContain("feat: add a");
    expect(["pass", "warn", "block", "inconclusive"]).toContain(inferred.verdict);

    const supplied = await check({ repository: root, objective: "Expose b()" });
    expect(supplied.objectiveInferred).toBe(false);
    expect(supplied.report.objective).toBe("Expose b()");
    expect(handoff(supplied.report).prompt).toEqual(supplied.handoff.prompt);
  });

  it("refuses an empty question before touching any provider", async () => {
    await expect(ask("  ")).rejects.toThrow("requires a question");
  });

  it("is the package entry point", async () => {
    const manifest = JSON.parse(await (await import("node:fs/promises")).readFile("package.json", "utf8")) as { main: string; exports: Record<string, unknown> };
    expect(manifest.main).toBe("dist/lib.js");
    expect(manifest.exports["."]).toBeDefined();
    // The bundle exists only after a build, and typecheck runs before one, so its path is not a literal the compiler resolves.
    const bundle = "../dist/lib.js";
    if (existsSync("dist/lib.js")) expect(Object.keys(await import(/* @vite-ignore */ bundle) as Record<string, unknown>)).toEqual(expect.arrayContaining(["check", "ask", "handoff"]));
  });
});
