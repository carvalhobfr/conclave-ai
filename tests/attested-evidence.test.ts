import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const verifier = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: verifier }));
import { hasVerifiedProvenance, loadAttestedEvidence } from "../src/validation/attested-evidence.js";
import { parseEvidenceReceiptEnvelope } from "../src/validation/evidence-receipts.js";

afterEach(() => vi.resetAllMocks());
it("JSON cannot grant verified provenance", () => {
  const parsed = parseEvidenceReceiptEnvelope({ version: 1, receipts: [{ id: "x", type: "test", effectiveTrustLevel: "ci-verified" }] });
  expect(hasVerifiedProvenance(parsed[0]!)).toBe(false);
});
it("verifies a byte snapshot with repository, workflow and commit policy; failure is closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "conclave-attested-test-"));
  const path = join(root, "input.json");
  const bytes = JSON.stringify({ version: 1, receipts: [{ id: "test", type: "test", headSha: "a".repeat(40) }] });
  await writeFile(path, bytes);
  try {
    verifier.mockImplementation((command: string, args: string[], options: unknown, callback: (error: Error | null) => void) => {
      expect(command).toBe("gh");
      expect(args).toContain("--deny-self-hosted-runners");
      expect(args).toContain("owner/repo/.github/workflows/ci.yml");
      expect(args).toContain("a".repeat(40));
      expect(args[2]).not.toBe(path);
      void readFile(args[2]!, "utf8").then((value) => { expect(value).toBe(bytes); callback(null); });
    });
    const result = await loadAttestedEvidence(path, "owner/repo", "owner/repo/.github/workflows/ci.yml");
    expect(hasVerifiedProvenance(result[0]!)).toBe(true);
    expect(hasVerifiedProvenance({ ...result[0]! })).toBe(false);
    verifier.mockImplementation((_command: unknown, _args: unknown, _options: unknown, callback: (error: Error) => void) => callback(new Error("Invalid signature")));
    await expect(loadAttestedEvidence(path, "owner/repo", "owner/repo/.github/workflows/ci.yml")).rejects.toThrow("Invalid signature");
  } finally { await rm(root, { recursive: true, force: true }); }
});
