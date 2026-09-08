import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { ConclaveProductService } from "../src/web/product-service.js";

const execFileAsync = promisify(execFile);

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

describe("web validation workflow", () => {
  it("rebuilds deterministic validation knowledge after a project was opened", async () => {
    const parent = await mkdtemp(join(tmpdir(), "conclave-web-validation-refresh-"));
    const root = join(parent, "repository");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "session.ts"), "export function restoreSession() { return false; }\n");
    await git(root, ["init", "-b", "master"]);
    await git(root, ["add", "--", "src/session.ts"]);
    await git(root, ["commit", "-m", "baseline"]);

    try {
      const product = new ConclaveProductService({ allowedRoot: parent });
      const project = await product.openLocal(root);
      await writeFile(
        join(root, "src", "session.ts"),
        "export function restoreSession() { return true; }\nexport function restoredAfterOpen() { return true; }\n",
      );

      const result = await product.validate(
        project.id,
        { kind: "working" },
        "Restore the session after the project was opened.",
        {
          claims: [{
            id: "fresh-symbol",
            statement: "restoredAfterOpen exists in the change being validated.",
            check: { kind: "symbol-exists", symbol: "restoredAfterOpen", expectation: "present" },
          }],
        },
      );

      expect(result.report.claims[0]?.outcome).toBe("supported");
      expect(result.report.trustBoundary).toMatchObject({
        deterministic: true,
        reasoningModelCalls: 0,
        repositoryScriptsExecuted: false,
        knowledge: { embedding: { kind: "deterministic-feature-hash", remoteCalls: 0 } },
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("returns a product summary backed by the real super-validator report", async () => {
    const parent = await mkdtemp(join(tmpdir(), "conclave-web-validation-"));
    const root = join(parent, "repository");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "session.ts"), "export function restoreSession() { return false; }\n");
    await git(root, ["init", "-b", "master"]);
    await git(root, ["add", "--", "src/session.ts"]);
    await git(root, ["commit", "-m", "baseline"]);
    await writeFile(join(root, "src", "session.ts"), "export function restoreSession() { return true; }\n");

    try {
      const product = new ConclaveProductService({ allowedRoot: parent });
      const project = await product.openLocal(root);
      const result = await product.validate(
        project.id,
        { kind: "working" },
        "Restore the session using the existing public API.",
        {
          allowedPathPrefixes: ["src"],
          claims: [{
            id: "restore-exists",
            statement: "restoreSession remains available.",
            check: { kind: "symbol-exists", symbol: "restoreSession", expectation: "present" },
          }],
        },
      );

      expect(result.intent).toBe("validate");
      expect(result.report.changeSet.files).toEqual([
        expect.objectContaining({ path: "src/session.ts", status: "modified" }),
      ]);
      expect(result.report.claims[0]?.outcome).toBe("supported");
      expect(result.headline).toBe("Change needs review before approval");
      expect(result.largestRisk?.title).toBe("Exported behavior changed without a test change");
      expect(result.report.metrics.graphEdgesInspected).toBeGreaterThan(0);
      expect(result.patch).toContain("restoreSession");
      expect(result.handoff).toContain("Address the Conclave review findings");
      const history = await product.history(project.id);
      expect(history[0]).toEqual(expect.objectContaining({
        verdict: result.verdict,
        objective: "Restore the session using the existing public API.",
      }));
      expect(result.demo).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

it("retains saved criteria through a reopened project and compares rechecks", async () => {
  const root = await mkdtemp(join(tmpdir(), "conclave-criteria-flow-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "feature.ts"), "export const feature = false;\n");
    await git(root, ["init", "-b", "master"]);
    await git(root, ["add", "src/feature.ts"]);
    await git(root, ["commit", "-m", "baseline"]);
    const firstService = new ConclaveProductService({ allowedRoot: root });
    const firstProject = await firstService.openLocal(root);
    const contract = { objective: "Keep preference", claims: [], allowedPathPrefixes: [], criteria: [{ id: "persist", statement: "Survives reload", verificationPlan: "Save and reload", kind: "runtime", confirmed: true, claimIds: [], implementationPaths: ["src/feature.ts"] }] };
    await firstService.saveAcceptance(firstProject.id, contract, null);
    const product = new ConclaveProductService({ allowedRoot: root });
    const project = await product.openLocal(root);
    expect((await product.acceptance(project.id))?.contract).toEqual(contract);
    await writeFile(join(root, "src", "feature.ts"), "export const feature = true;\n");
    const initial = await product.validate(project.id, { kind: "working" }, contract.objective);
    expect(initial.report.criteria?.[0]?.status).toBe("not-verified");
    const receipt = { version: 1, receipts: [{ id: "reload-check", type: "runtime", command: "reload scenario", runner: "local", exitCode: 0, startedAt: "2026-09-08T00:00:00Z", finishedAt: "2026-09-08T00:01:00Z", outputDigest: "a".repeat(64), diffDigest: initial.report.lineage.diffDigest, criterionDigests: { persist: initial.report.criteria?.[0]?.digest } }] };
    const recheck = await product.validate(project.id, { kind: "working" }, contract.objective, undefined, { previousReviewId: initial.report.lineage.reviewId, receipts: receipt });
    expect(recheck.report.criteria?.[0]).toMatchObject({ status: "supported", previousStatus: "not-verified" });
    expect(recheck.handoff).toContain("Survives reload");
    expect(recheck.report.lineage.contractStatus).toBe("preserved");
    expect((await product.history(project.id)).length).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
