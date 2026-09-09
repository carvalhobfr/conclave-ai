import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { listFindingFeedback, recordFindingFeedback } from "../src/storage/finding-feedback.js";
import type { ValidationReport } from "../src/domain/validation.js";

it("keeps feedback bound to an actual finding without modifying its report", async () => {
  const root = await mkdtemp(join(tmpdir(), "conclave-feedback-"));
  const report = { verdict: "warn", findings: [{ fingerprint: "fp_1" }], lineage: { reviewId: "review_1", reportDigest: "digest_1" } } as unknown as ValidationReport;
  try {
    const record = await recordFindingFeedback(root, report, { fingerprint: "fp_1", classification: "false-positive", note: "Cleanup is delegated and tested" });
    expect(await listFindingFeedback(root)).toEqual([record]);
    expect(report.verdict).toBe("warn");
    await expect(recordFindingFeedback(root, report, { fingerprint: "invented", classification: "confirmed", note: "x" })).rejects.toThrow();
    expect((await listFindingFeedback(root)).length).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
