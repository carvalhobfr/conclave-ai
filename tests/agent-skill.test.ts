import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function runRunner(objective: string, schemaVersion = 2): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      "skills/conclave-validate/scripts/run-validation.mjs",
      "--repository", ".",
      "--source", "working",
      "--objective", objective,
    ], {
      cwd: resolve("."),
      shell: false,
      env: { ...process.env, CONCLAVE_CLI_PATH: resolve("tests/fixtures/agent-skill/fake-conclave.mjs"), CONCLAVE_FIXTURE_SCHEMA: String(schemaVersion) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? 3, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

describe("portable Conclave agent skill", () => {
  it("keeps Codex and Claude adapters byte-identical to the portable skill", async () => {
    const files = [
      "SKILL.md",
      "agents/openai.yaml",
      "scripts/run-validation.mjs",
      "references/report-schema.md",
    ];
    for (const file of files) {
      const canonical = await readFile(resolve("skills/conclave-validate", file), "utf8");
      await expect(readFile(resolve(".agents/skills/conclave-validate", file), "utf8")).resolves.toBe(canonical);
      await expect(readFile(resolve(".claude/skills/conclave-validate", file), "utf8")).resolves.toBe(canonical);
    }
    const schema = JSON.parse(await readFile(resolve("schemas/validation-report.v2.schema.json"), "utf8")) as Record<string, unknown>;
    expect(schema["$id"]).toBe("https://conclave.dev/schemas/validation-report.v2.schema.json");
  });

  it("ships a GitHub Actions template that compares the actual PR refs", async () => {
    const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      readonly version: string;
      readonly files: readonly string[];
    };
    const workflow = await readFile(resolve("examples/github-actions/conclave-review.yml"), "utf8");
    expect(packageJson.files).toContain("docs/review-lineage.md");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("--base \"${BASE_REF}\"");
    expect(workflow).toContain("--head \"${HEAD_REF}\"");
    expect(workflow).toContain("GITHUB_STEP_SUMMARY");
    expect(workflow).toContain("actions/upload-artifact@v4");
    // The template pins the published version, so a release that forgets to move the pin
    // would hand users a workflow installing the previous package.
    expect(workflow).toContain(`--package=conclave-ai@${packageJson.version}`);
    expect(workflow).not.toContain("npm ci");
    expect(workflow).toContain("actions/github-script@v7");
  });

  it.each([
    ["valid small change", "pass", 0],
    ["hallucinated completion BLOCK", "block", 1],
    ["insufficient evidence INCONCLUSIVE", "inconclusive", 2],
  ] as const)("preserves the engine decision for %s", async (_label, verdict, exitCode) => {
    const result = await runRunner(_label);
    expect(result.code, result.stderr).toBe(exitCode);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ schemaVersion: 2, verdict }));
  });
});

describe("v3 portable protocol", () => {
  it.each(["valid small change", "BLOCK", "INCONCLUSIVE"])("preserves v3 verdict and exit for %s", async (objective) => {
    const result = await runRunner(objective, 3);
    expect(result.code, result.stderr).toBe(objective === "BLOCK" ? 1 : objective === "INCONCLUSIVE" ? 2 : 0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ schemaVersion: 3 }));
  });
});
