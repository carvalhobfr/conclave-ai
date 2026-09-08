import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listReviewHistory, saveReviewHistory, type ReviewHistoryRecord } from "../src/storage/review-history.js";

const summary = {
  title: "Update src/session.ts",
  summary: "One file changed.",
  comparison: "HEAD compared with origin/main",
  verdict: "pass" as const,
  changedFiles: [],
  changedCodeUnits: 1,
  impactedFiles: 1,
  risks: [],
  nextSteps: ["Run tests"],
};

describe("review history", () => {
  it("stores the latest review locally and keeps the file owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-review-history-"));
    const record: ReviewHistoryRecord = { id: "review-1", createdAt: "2026-01-01T00:00:00.000Z", repository: root, objective: "Test", headSha: "abc", summary };
    try {
      await saveReviewHistory(root, record);
      expect(await listReviewHistory(root)).toEqual([record]);
      expect(JSON.parse(await readFile(join(root, ".conclave", "review-history.json"), "utf8"))).toEqual([record]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps legacy summaries readable without exposing an incompatible v1 report", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-review-history-legacy-"));
    const legacy = {
      id: "legacy-review",
      createdAt: "2026-01-01T00:00:00.000Z",
      repository: root,
      objective: "Legacy",
      headSha: "abc",
      summary,
      report: { schemaVersion: 1, verdict: "pass" },
    };
    try {
      await saveReviewHistory(root, legacy as never);
      expect(await listReviewHistory(root)).toEqual([{
        id: legacy.id,
        createdAt: legacy.createdAt,
        repository: root,
        objective: legacy.objective,
        headSha: legacy.headSha,
        summary,
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("report version retention", () => {
  it.each([2, 3])("preserves schema %s reports through subsequent history writes", async (version) => {
    const root = await mkdtemp(join(tmpdir(), "conclave-history-version-"));
    const first = { id: "first", createdAt: "2026-09-08T00:00:00Z", repository: root, objective: "Test", headSha: "abc", summary, report: { schemaVersion: version, verdict: "pass" } };
    try {
      await saveReviewHistory(root, first as never);
      await saveReviewHistory(root, { ...first, id: "second" } as never);
      expect((await listReviewHistory(root))[1]?.report?.schemaVersion).toBe(version);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
