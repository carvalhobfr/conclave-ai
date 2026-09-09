import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = resolve("dist/cli.js");

/**
 * Exercises the built entry point end to end. `verify` and the CI matrix build before testing;
 * a plain `npm test` against a clean checkout has no bundle to run, so the suite reports the
 * reason instead of failing on a missing artifact.
 */
const built = existsSync(CLI);
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, args: readonly string[]): Promise<void> {
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

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-cli-smoke-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "refund.ts"), "export function refund(cents: number) {\n  return cents;\n}\n");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "baseline"]);
  return root;
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], cwd: string): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      // A fresh HOME keeps the developer's own CLI language preference out of the assertions.
      { cwd, env: { ...process.env, HOME: cwd, USERPROFILE: cwd, CONCLAVE_LANGUAGE: "en" } },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error instanceof Error ? error : new Error("The CLI could not be started"));
          return;
        }
        resolvePromise({ code: error === null ? 0 : (error.code as number), stdout, stderr });
      },
    );
  });
}

describe.skipIf(!built)("conclave CLI end to end", () => {
  it("reviews an uncommitted change and emits a complete JSON payload", async () => {
    const root = await repository();
    await writeFile(
      join(root, "src", "refund.ts"),
      "export function refund(cents: number) {\n  const settled = Math.max(0, cents);\n  return settled;\n}\n",
    );

    const result = await runCli(["check", ".", "--json"], root);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      readonly summary: { readonly verdict: string; readonly changedFiles: readonly { readonly path: string }[] };
      readonly report: {
        readonly schemaVersion: number;
        readonly verdict: string;
        readonly objective: string;
        readonly trustBoundary: { readonly deterministic: boolean; readonly reasoningModelCalls: number };
        readonly lineage: { readonly reviewId: string };
      };
      readonly handoff: { readonly prompt: string };
    };

    expect(payload.report.schemaVersion).toBe(5);
    expect(payload.summary.changedFiles.map((file) => file.path)).toEqual(["src/refund.ts"]);
    expect(payload.summary.verdict).toBe(payload.report.verdict);
    // The product's central promise: `check` never calls a reasoning model.
    expect(payload.report.trustBoundary.deterministic).toBe(true);
    expect(payload.report.trustBoundary.reasoningModelCalls).toBe(0);
    expect(payload.report.objective).not.toBe("");
    expect(payload.report.lineage.reviewId).toMatch(/^\w/u);
    expect(payload.handoff.prompt).toContain("Objective:");
  });

  it("reports a clean tree as nothing to review rather than as a failure", async () => {
    const root = await repository();

    const result = await runCli(["check", ".", "--json"], root);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      readonly report: { readonly findings: readonly { readonly kind: string }[] };
    };
    expect(payload.report.findings.map((finding) => finding.kind)).toContain("no-change");
  });

  it("exits 1 with a readable message on an unknown option", async () => {
    const root = await repository();

    const result = await runCli(["check", ".", "--deep"], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option: --deep");
    expect(result.stdout).toBe("");
  });

  it("exits 1 with a readable message on an unknown command", async () => {
    const root = await repository();

    const result = await runCli(["teleport", "."], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("teleport");
  });

  it("prints the command catalog without touching the repository", async () => {
    const root = await repository();

    const result = await runCli(["help"], root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check");
    expect(existsSync(join(root, ".conclave"))).toBe(false);
  });
});

it.skipIf(!built)("check does not silently drop requested attestation verification", async () => {
  const root = await repository();
  const result = await runCli(["check", root, "--attested-receipt", "missing.json", "--json"], root);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Attested receipts require");
});
