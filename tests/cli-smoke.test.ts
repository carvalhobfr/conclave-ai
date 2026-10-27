import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { buildArgv, readPath } from "./helpers/plugin-host.js";
import type { PluginManifest } from "../src/workflow/plugin-manifest.js";

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
      { cwd, env: { ...process.env, HOME: cwd, USERPROFILE: cwd, CONCLAVE_LANGUAGE: "en", CONCLAVE_CONFIG_HOME: join(cwd, ".conclave-user") } },
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

  it("lists commits as JSON and reviews each one with --analyze", async () => {
    const root = await repository();
    await writeFile(join(root, "src", "refund.ts"), "export function refund(cents: number) {\n  return Math.max(0, cents);\n}\n");
    await git(root, ["commit", "-am", "fix: clamp refunds"]);

    const listed = await runCli(["commits", ".", "--json"], root);
    expect(listed.stderr).toBe("");
    expect(listed.code).toBe(0);
    const timeline = JSON.parse(listed.stdout) as {
      readonly schemaVersion: number;
      readonly analyzed: boolean;
      readonly commits: readonly { readonly subject: string; readonly analysis?: unknown }[];
    };
    expect(timeline.schemaVersion).toBe(1);
    expect(timeline.analyzed).toBe(false);
    expect(timeline.commits.map((item) => item.subject)).toEqual(["fix: clamp refunds", "baseline"]);
    expect(timeline.commits.every((item) => item.analysis === undefined)).toBe(true);

    const reviewed = await runCli(["commits", ".", "--analyze", "--json"], root);
    expect(reviewed.code).toBe(0);
    const analysed = JSON.parse(reviewed.stdout) as {
      readonly commits: readonly { readonly analysis?: { readonly status: string } }[];
    };
    expect(analysed.commits.map((item) => item.analysis?.status)).toEqual(["analyzed", "skipped"]);

    const text = await runCli(["commits", "."], root);
    expect(text.stdout).toContain("fix: clamp refunds");
    expect(text.stdout).toContain("Add --analyze");
  });

  it("reports repository status as JSON and tolerates a folder that is not a repository", async () => {
    const root = await repository();
    await writeFile(join(root, "src", "refund.ts"), "export const refund = 1;\n");

    const result = await runCli(["status", ".", "missing-folder", "--json"], root);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const snapshot = JSON.parse(result.stdout) as {
      readonly schemaVersion: number;
      readonly summary: { readonly repositories: number; readonly unavailable: number; readonly dirty: number };
      readonly repositories: readonly { readonly ok: boolean; readonly branch?: string | null }[];
    };
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.summary).toEqual(expect.objectContaining({ repositories: 2, unavailable: 1, dirty: 1 }));
    expect(snapshot.repositories.map((entry) => entry.ok)).toEqual([true, false]);
    expect(snapshot.repositories[0]?.branch).toBe("main");
  });

  it("serves a manifest a host can drive: every widget field exists in the command output", async () => {
    const root = await repository();
    await writeFile(join(root, "src", "refund.ts"), "export const refund = 1;\n");
    await git(root, ["commit", "-am", "fix: simplify refunds"]);

    const served = await runCli(["plugin", "manifest", "--json"], root);
    expect(served.stderr).toBe("");
    expect(served.code).toBe(0);
    const manifest = JSON.parse(served.stdout) as PluginManifest;
    const installed = JSON.parse(await (await import("node:fs/promises")).readFile("package.json", "utf8")) as { version: string };
    expect(manifest.version).toBe(installed.version);

    for (const widget of manifest.widgets) {
      const target = manifest.commands.find((item) => item.id === widget.command);
      if (target === undefined) throw new Error(`No command for ${widget.id}`);
      const values: Record<string, string | number | boolean | readonly string[]> = { ...widget.arguments };
      for (const parameter of target.parameters) {
        if (parameter.type === "repository") values[parameter.name] = ".";
        if (parameter.type === "repositories") values[parameter.name] = ["."];
      }
      const run = await runCli(buildArgv(target, values), root);
      expect(run.code, `${widget.id}: ${run.stderr}`).toBe(0);
      const payload: unknown = JSON.parse(run.stdout);
      for (const field of widget.fields) {
        expect(readPath(payload, field.path).length, `${widget.id} -> ${field.path}`).toBeGreaterThan(0);
      }
    }

    const schema = await runCli(["plugin", "schema", "status.v1"], root);
    expect(schema.code).toBe(0);
    expect((JSON.parse(schema.stdout) as { $id: string }).$id).toContain("status.v1");
    const unknown = await runCli(["plugin", "schema", "nope"], root);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown schema");
    expect((await runCli(["plugin"], root)).code).toBe(1);
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

  it("keeps the main help short and groups secondary commands under tools", async () => {
    const root = await repository();

    const main = await runCli(["help"], root);
    expect(main.stdout).toContain("tools");
    expect(main.stdout).not.toContain("eval-graph");

    const tools = await runCli(["tools"], root);
    expect(tools.code).toBe(0);
    for (const name of ["compare", "review", "graph", "mcp", "eval-graph"]) expect(tools.stdout).toContain(name);

    const forwarded = await runCli(["tools", "history", root], root);
    expect(forwarded.code).toBe(0);
    expect(forwarded.stdout).toContain("No Conclave PR reviews");
  });
});

it.skipIf(!built)("check does not silently drop requested attestation verification", async () => {
  const root = await repository();
  const result = await runCli(["check", root, "--attested-receipt", "missing.json", "--json"], root);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Attested receipts require");
});

describe.skipIf(!built)("CLI guidance", () => {
  it("suggests the closest command for a typo", async () => {
    const root = await repository();
    const result = await runCli(["chek", "."], root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("did you mean `conclave check`?");
  });

  it("resets provider-specific settings only when the provider actually changes", async () => {
    const root = await repository();
    await runCli(["config", "set", "base-url", "https://opencode.ai/zen/go/v1"], root);
    await runCli(["config", "set", "provider", "opencode-go"], root);
    const kept = await runCli(["config", "get", "base-url"], root);
    expect(kept.stdout.trim()).toBe("https://opencode.ai/zen/go/v1");
    const switched = await runCli(["config", "set", "provider", "ollama"], root);
    expect(switched.stdout).toContain("Endpoint and per-role models were reset");
    expect((await runCli(["config", "get", "base-url"], root)).stdout).toContain("is not set");
    expect((await runCli(["config", "get", "mode"], root)).stdout.trim()).toBe("local");
  });

  it("does not claim to remove a setting that was never saved", async () => {
    const root = await repository();
    const result = await runCli(["config", "unset", "model"], root);
    expect(result.stdout).toContain("is not set");
  });

  it("explains a repository without commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-cli-empty-"));
    roots.push(root);
    await git(root, ["init", "-b", "main"]);
    const result = await runCli(["check", "."], root);
    expect(result.stderr).toContain("has no commits yet");
  });
});
