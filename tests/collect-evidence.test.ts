import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHILD_ENVIRONMENT_ALLOWLIST, createChildEnvironment, parseForwardedVariables } from "../src/execution/child-environment.js";
import { collectExecutionEvidence, executeCheck, parseCollectArguments, parseExecutionPlan } from "../src/execution/collect-evidence.js";
import { loadConclaveEnvironment } from "../src/config/environment-file.js";
import { GitChangeSetService } from "../src/validation/git-change-set.js";
import { createDeterministicValidationIndex } from "../src/validation/deterministic-index.js";
import { SuperValidator } from "../src/validation/super-validator.js";

const execute = promisify(execFile);
const check = { id: "test", type: "test" as const, argv: [process.execPath, "-e", "process.stdout.write('ok')"], timeoutMs: 10000, criterionIds: [] };
describe("opt-in execution", () => {
  it("rejects missing bounds and duplicate commands", () => {
    expect(() => parseExecutionPlan({ version: 1, checks: [{ ...check, timeoutMs: 0 }] })).toThrow();
    expect(() => parseExecutionPlan({ version: 1, checks: [check, check] })).toThrow();
  });
  it("hashes output and preserves nonzero exits", async () => {
    const result = await executeCheck(check, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.outputDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect((await executeCheck({ ...check, argv: [process.execPath, "-e", "process.exit(7)"] }, process.cwd())).exitCode).toBe(7);
  });
  it("terminates a hung check and an output flood", async () => {
    expect(await executeCheck({ ...check, timeoutMs: 100, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }, process.cwd())).toMatchObject({ exitCode: 1, summary: "Execution timed out" });
    expect((await executeCheck({ ...check, argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(1100000))"] }, process.cwd())).exitCode).toBe(1);
  });
  it("binds real executions and rejects source mutation during a check", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-collect-"));
    try {
      await writeFile(join(root, "feature.ts"), "export const value = 1;\n");
      for (const args of [["init"], ["add", "feature.ts"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]]) await execute("git", args, { cwd: root });
      await writeFile(join(root, "feature.ts"), "export const value = 2;\n");
      const change = await new GitChangeSetService().collect(root, { kind: "working" });
      const { index } = await createDeterministicValidationIndex(root);
      const report = new SuperValidator().validate(index, change, { objective: "Change value", claims: [], allowedPathPrefixes: [] });
      expect((await collectExecutionEvidence(root, report, { version: 1, checks: [check] }))[0]?.diffDigest).toBe(report.lineage.diffDigest);
      await expect(collectExecutionEvidence(root, report, { version: 1, checks: [{ ...check, argv: [process.execPath, "-e", "require('fs').writeFileSync('feature.ts','export const value = 3;')"] }] })).rejects.toThrow("artifact changed");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);
});

// Synthetic values, generated so this file does not itself match a credential detector.
const SECRET_NAMES = [
  "CONCLAVE_API_KEY",
  "CONCLAVE_OPENAI_API_KEY",
  "CONCLAVE_EMBEDDING_API_KEY",
  "CONCLAVE_COMMENT_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "DATABASE_URL",
] as const;
const SECRETS = Object.fromEntries(SECRET_NAMES.map((name) => [name, `synthetic-value-of-${name.toLowerCase()}`])) as Record<(typeof SECRET_NAMES)[number], string>;

/** Runs a real child that prints its whole environment and returns what it saw. */
async function childEnvironment(parent: NodeJS.ProcessEnv, forwardEnvironment: readonly string[] = []): Promise<Record<string, string>> {
  const directory = await mkdtemp(join(tmpdir(), "conclave-child-env-"));
  const output = join(directory, "environment.json");
  try {
    const dump = { ...check, argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env))`] };
    const result = await executeCheck(dump, directory, { environment: parent, forwardEnvironment });
    expect(result.exitCode).toBe(0);
    return JSON.parse(await readFile(output, "utf8")) as Record<string, string>;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe("child process environment", () => {
  it("gives an executed check no provider key, Conclave credential or unrelated shell secret", async () => {
    const seen = await childEnvironment({ ...process.env, ...SECRETS });

    for (const [name, value] of Object.entries(SECRETS)) {
      expect(seen[name], `${name} must not reach the child`).toBeUndefined();
      expect(JSON.stringify(seen)).not.toContain(value);
    }
    expect(Object.keys(seen).filter((name) => name.startsWith("CONCLAVE_"))).toEqual([]);
    // What a local command needs to start is still there.
    expect(seen["PATH"]).toBe(process.env["PATH"]);
    if (process.env["HOME"] !== undefined) expect(seen["HOME"]).toBe(process.env["HOME"]);
  });

  it("withholds credentials the CLI loads from a project .env at startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conclave-env-file-"));
    try {
      await writeFile(join(directory, ".env"), ["CONCLAVE_API_KEY", "synthetic-file-key\nCONCLAVE_PROVIDER=openai\n"].join("="));
      const parent: NodeJS.ProcessEnv = { PATH: process.env["PATH"] };
      // The same loader the CLI runs before any command: it writes the keys into the environment.
      expect(loadConclaveEnvironment(parent, join(directory, ".env")).loadedKeys).toEqual(["CONCLAVE_API_KEY", "CONCLAVE_PROVIDER"]);
      expect(parent["CONCLAVE_API_KEY"]).toBe("synthetic-file-key");

      const seen = await childEnvironment(parent);
      expect(JSON.stringify(seen)).not.toContain("synthetic-file-key");
      expect(seen["CONCLAVE_PROVIDER"]).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("passes only what the allowlist names, and nothing by pattern", () => {
    const parent = { PATH: "/usr/bin", HOME: "/home/dev", LANG: "C.UTF-8", JAVA_HOME: "/jdk", path: "/shadow", MY_PATH: "/x", PATH_TOKEN: "t", NODE_OPTIONS: "--require ./hook.js", npm_config__authToken: "t", ...SECRETS };

    expect(createChildEnvironment({ parent, platform: "linux" })).toEqual({ PATH: "/usr/bin", HOME: "/home/dev", LANG: "C.UTF-8", JAVA_HOME: "/jdk" });
    expect(CHILD_ENVIRONMENT_ALLOWLIST.filter((name) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CONCLAVE/iu.test(name))).toEqual([]);
  });

  it("matches Windows variable names without regard to case and keeps their spelling", () => {
    const parent = { Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "cmd.exe", Conclave_Api_Key: SECRETS.CONCLAVE_API_KEY };

    expect(createChildEnvironment({ parent, platform: "win32" })).toEqual({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "cmd.exe" });
    expect(createChildEnvironment({ parent, platform: "linux" })).toEqual({});
  });

  it("forwards a variable only when the operator names it", async () => {
    const parent = { ...process.env, ...SECRETS };
    const seen = await childEnvironment(parent, ["DATABASE_URL"]);

    expect(seen["DATABASE_URL"]).toBe(SECRETS.DATABASE_URL);
    for (const name of Object.keys(SECRETS).filter((item) => item !== "DATABASE_URL")) expect(seen[name]).toBeUndefined();
  });

  it("never forwards a Conclave credential and rejects malformed names", () => {
    for (const name of ["CONCLAVE_API_KEY", "CONCLAVE_OPENAI_API_KEY", "CONCLAVE_COMMENT_TOKEN", "conclave_embedding_api_key"]) {
      expect(() => parseForwardedVariables([name])).toThrow("Refusing to forward a Conclave credential");
    }
    for (const name of ["", "A=B", "1ABC", "A B", "PATH;rm", "*"]) expect(() => parseForwardedVariables([name])).toThrow("Invalid environment variable name");
    expect(() => parseForwardedVariables(Array.from({ length: 11 }, (_, index) => `VAR_${String(index)}`))).toThrow("At most 10");
    expect(parseForwardedVariables(["CONCLAVE_LANGUAGE", "DATABASE_URL", "DATABASE_URL"])).toEqual(["CONCLAVE_LANGUAGE", "DATABASE_URL"]);
    expect(() => createChildEnvironment({ parent: SECRETS, forward: ["CONCLAVE_API_KEY"] })).toThrow("Refusing to forward");
  });

  it("takes forwarding from the command line only", () => {
    expect(parseCollectArguments(["repo", "report.json", "--forward-env", "DATABASE_URL", "plan.json", "--forward-env=CI_NODE_INDEX", "out.json"])).toEqual({
      positionals: ["repo", "report.json", "plan.json", "out.json"],
      forwardEnvironment: ["DATABASE_URL", "CI_NODE_INDEX"],
    });
    expect(() => parseCollectArguments(["repo", "--forward-env"])).toThrow("requires a variable name");
    expect(() => parseCollectArguments(["repo", "--forward-env", "CONCLAVE_API_KEY"])).toThrow("Refusing to forward");
    expect(() => parseCollectArguments(["repo", "--inherit-env"])).toThrow("Unknown collect option");
    // A plan cannot ask for variables: unknown plan fields carry no authority.
    expect(parseExecutionPlan({ version: 1, checks: [{ ...check, env: ["CONCLAVE_API_KEY"], forwardEnvironment: ["CONCLAVE_API_KEY"] }] })).toHaveLength(1);
  });

  it("records forwarded names, never values, in the receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-collect-forward-"));
    try {
      await writeFile(join(root, "feature.ts"), "export const value = 1;\n");
      for (const args of [["init"], ["add", "feature.ts"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]]) await execute("git", args, { cwd: root });
      await writeFile(join(root, "feature.ts"), "export const value = 2;\n");
      const change = await new GitChangeSetService().collect(root, { kind: "working" });
      const { index } = await createDeterministicValidationIndex(root);
      const report = new SuperValidator().validate(index, change, { objective: "Change value", claims: [], allowedPathPrefixes: [] });
      const options = { environment: { ...process.env, ...SECRETS }, forwardEnvironment: ["DATABASE_URL"] };
      const requires = { ...check, argv: [process.execPath, "-e", "process.exit(process.env.DATABASE_URL && !process.env.CONCLAVE_API_KEY && !process.env.OPENAI_API_KEY ? 0 : 9)"] };

      const [receipt] = await collectExecutionEvidence(root, report, { version: 1, checks: [requires] }, options);
      expect(receipt?.exitCode).toBe(0);
      expect(receipt?.summary).toContain("Forwarded environment variables: DATABASE_URL.");
      for (const value of Object.values(SECRETS)) expect(JSON.stringify(receipt)).not.toContain(value);
      expect((await collectExecutionEvidence(root, report, { version: 1, checks: [requires] }, { environment: options.environment }))[0]?.exitCode).toBe(9);
      await expect(collectExecutionEvidence(root, report, { version: 1, checks: [check] }, { forwardEnvironment: ["CONCLAVE_API_KEY"] })).rejects.toThrow("Refusing to forward");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);
});
