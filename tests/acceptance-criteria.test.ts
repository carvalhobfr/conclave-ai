import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AcceptanceCriterion, ChangeSet, EvidenceReceiptInput, ValidationContract } from "../src/domain/validation.js";
import type { RepositoryCodeIndex } from "../src/domain/code-index.js";
import { evaluateCriteria } from "../src/validation/acceptance-criteria.js";
import { createValidationLineage, validationDigest } from "../src/validation/review-lineage.js";
import { parseValidationContract } from "../src/validation/contract-parser.js";
import { evaluateEvidenceReceipts, parseEvidenceReceiptEnvelope } from "../src/validation/evidence-receipts.js";
import { SuperValidator } from "../src/validation/super-validator.js";
import { loadAcceptanceContract, saveAcceptanceContract } from "../src/storage/acceptance-contract.js";

const criterion: AcceptanceCriterion = { id: "reload", statement: "Setting survives reload", kind: "runtime", verificationPlan: "Save, reload, read the saved value", confirmed: true, claimIds: [], implementationPaths: ["src/settings.ts"] };
const contract: ValidationContract = { objective: "Persist settings", claims: [], allowedPathPrefixes: [], criteria: [criterion] };
const change: ChangeSet = { source: { kind: "working" }, headSha: "a".repeat(40), files: [], patch: "changed", collectedAt: "2026-09-08T00:00:00Z" };
const lineage = createValidationLineage({ changeSet: change, contract });
const receipt: EvidenceReceiptInput = { id: "browser", type: "runtime", exitCode: 0, command: "check reload", startedAt: "2026-09-08T00:00:00Z", finishedAt: "2026-09-08T00:01:00Z", runner: "local", outputDigest: "a".repeat(64), diffDigest: lineage.diffDigest, criterionDigests: { reload: validationDigest("criterion", criterion) } };
const receipts = (input: readonly EvidenceReceiptInput[]) => evaluateEvidenceReceipts(parseEvidenceReceiptEnvelope({ version: 1, receipts: input }), lineage, change.headSha, true);

describe("acceptance evidence", () => {
  it("requires confirmation before using a result", () => {
    expect(evaluateCriteria([{ ...criterion, confirmed: false }], [], receipts([receipt]))[0]?.status).toBe("not-verified");
  });
  it("supports only explicitly linked matching criteria and execution kinds", () => {
    expect(evaluateCriteria([criterion], [], receipts([receipt]))[0]?.status).toBe("supported");
    expect(evaluateCriteria([criterion], [], receipts([{ ...receipt, criterionDigests: {} }]))[0]?.status).toBe("not-verified");
    expect(evaluateCriteria([criterion], [], receipts([{ ...receipt, type: "build" }]))[0]?.status).toBe("not-verified");
    expect(evaluateCriteria([{ ...criterion, verificationPlan: "Different scenario" }], [], receipts([receipt]))[0]?.status).toBe("not-verified");
  });
  it("retains contradictions even beside a successful execution", () => {
    expect(evaluateCriteria([criterion], [], receipts([receipt, { ...receipt, id: "failed", exitCode: 1 }]))[0]?.status).toBe("contradicted");
  });
  it.each([{ diffDigest: "b".repeat(64) }, { runner: "" }, { headSha: "b".repeat(40) }])("does not promote stale or incomplete receipts %j", (override) => {
    expect(evaluateCriteria([criterion], [], receipts([{ ...receipt, ...override }]))[0]?.status).toBe("not-verified");
  });
  it("retains the self-reported provenance limitation", () => {
    expect(evaluateCriteria([criterion], [], receipts([{ ...receipt, claimedTrustLevel: "ci-attested" }]))[0]?.reasons.join(" ")).toContain("self-reported");
  });
  it("does not decide human criteria", () => {
    expect(evaluateCriteria([{ ...criterion, kind: "human" }], [], receipts([receipt]))[0]?.status).toBe("human-decision");
  });
  it("rejects duplicate IDs, invalid confirmation and unknown structural links", () => {
    for (const criteria of [[criterion, criterion], [{ ...criterion, confirmed: "yes" }], [{ ...criterion, claimIds: ["unknown"] }]]) expect(() => parseValidationContract({ ...contract, criteria })).toThrow();
  });
});

describe("saved acceptance contract", () => {
  it("persists across readers and rejects stale concurrent saves", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-acceptance-"));
    try {
      expect(await loadAcceptanceContract(root)).toBeNull();
      const saved = await saveAcceptanceContract(root, contract, null);
      expect(await loadAcceptanceContract(root)).toEqual(saved);
      await expect(saveAcceptanceContract(root, { ...contract, objective: "Other" }, null)).rejects.toThrow("changed elsewhere");
      const updated = await saveAcceptanceContract(root, { ...contract, objective: "Other" }, saved.revision);
      expect(updated.revision).not.toBe(saved.revision);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("preserves criterion progress and requires a baseline decision after edits", () => {
    const index = { files: {}, units: {}, graph: { nodes: [], edges: [] }, embedding: { kind: "deterministic-feature-hash", id: "local" }, parser: "typescript" } as unknown as RepositoryCodeIndex;
    const validator = new SuperValidator();
    const first = validator.validate(index, change, contract);
    const next = validator.validate(index, change, contract, { previousReport: first, receipts: [receipt] });
    expect(next.lineage.contractStatus).toBe("preserved");
    expect(next.criteria?.[0]).toMatchObject({ status: "supported", previousStatus: "not-verified" });
    const altered = validator.validate(index, change, { ...contract, criteria: [{ ...criterion, statement: "A weaker requirement" }] }, { previousReport: next, receipts: [receipt] });
    expect(altered.lineage.rebaselineRequired).toBe(true);
    expect(altered.criteria?.[0]?.status).toBe("not-verified");
  });
});
