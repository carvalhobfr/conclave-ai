import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectExecutionEvidence, executeCheck, parseExecutionPlan } from "../src/execution/collect-evidence.js";
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
