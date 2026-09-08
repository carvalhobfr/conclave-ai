import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { MultiLanguageCodeParser } from "../src/code-intelligence/multi-language-parser.js";
import type {
  ChangeSet,
  EvidenceReceiptInput,
  ValidationContract,
} from "../src/domain/validation.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { finalizeReportDigest } from "../src/validation/review-lineage.js";
import { SuperValidator } from "../src/validation/super-validator.js";

async function validationFixture() {
  const root = await mkdtemp(join(tmpdir(), "conclave-validation-"));
  await mkdir(join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "src", "storage.ts"),
      [
        "export function persistToken(token: string) {",
        "  localStorage.setItem(\"token\", token);",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(root, "src", "flow.ts"),
      [
        "import { persistToken } from \"./storage\";",
        "export function authenticate(token: string) {",
        "  persistToken(token);",
        "}",
        "",
      ].join("\n"),
    ),
  ]);
  const embeddingProvider = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root);
  return indexed.index;
}

async function ambiguousSymbolFixture() {
  const root = await mkdtemp(join(tmpdir(), "conclave-validation-ambiguous-"));
  await mkdir(join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "src", "left.ts"), "export function duplicate() { return \"left\"; }\n"),
    writeFile(join(root, "src", "right.ts"), "export function duplicate() { return \"right\"; }\n"),
    writeFile(
      join(root, "src", "consumer.ts"),
      'import { duplicate } from "./left";\nexport function consume() { return duplicate(); }\n',
    ),
  ]);
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider: new LocalHashEmbeddingProvider(),
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root);
  return indexed.index;
}

function changeSet(paths: readonly string[] = ["src/storage.ts"]): ChangeSet {
  return {
    source: { kind: "working" },
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    files: paths.map((path) => ({
      path,
      status: "modified" as const,
      hunks: [{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 }],
    })),
    patch: "bounded test patch",
    collectedAt: "2026-08-11T00:00:00.000Z",
  };
}

function contract(overrides: Partial<ValidationContract> = {}): ValidationContract {
  return {
    objective: "Change token persistence safely",
    claims: [],
    allowedPathPrefixes: [],
    ...overrides,
  };
}

describe("SuperValidator", () => {
  it.each([
    ["python", "src/service.py", "def public_service():\n    return True\n", "tests/test_service.py"],
    ["java", "src/main/java/Service.java", "public class Service { public boolean run() { return true; } }\n", "src/test/java/ServiceTest.java"],
  ] as const)("recognizes %s production and test files", async (_language, sourcePath, source, testPath) => {
    const root = await mkdtemp(join(tmpdir(), "conclave-multilanguage-validation-"));
    await mkdir(join(root, sourcePath, ".."), { recursive: true });
    await mkdir(join(root, testPath, ".."), { recursive: true });
    await writeFile(join(root, sourcePath), source);
    await writeFile(join(root, testPath), source);
    const indexed = await new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new MultiLanguageCodeParser(),
      embeddingProvider: new LocalHashEmbeddingProvider(),
      indexStore: new InMemoryCodeIndexStore(),
    }).index(root);
    const report = new SuperValidator().validate(indexed.index, changeSet([sourcePath, testPath]), contract());
    expect(report.findings.some((finding) => finding.kind === "exported-change-without-tests")).toBe(false);
    expect(report.impact.changedSymbols.length).toBeGreaterThan(0);
  });
  it("uses graph impact to surface unchanged callers outside the diff", async () => {
    const report = new SuperValidator({ impactDepth: 3 }).validate(
      await validationFixture(),
      changeSet(),
      contract(),
    );

    expect(report.verdict).toBe("warn");
    expect(report.findings.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["impact-outside-diff", "exported-change-without-tests"]),
    );
    expect(report.impact.impactedFiles).toContain("src/flow.ts");
    expect(report.impact.changedSymbols).toContain("persistToken");
    expect(report.metrics.symbolsChanged).toBe(report.impact.changedSymbols.length);
  });

  it("emits a digest-bound review lineage and deterministic risk challenges", async () => {
    const report = new SuperValidator({ impactDepth: 3 }).validate(
      await validationFixture(),
      changeSet(),
      contract(),
    );

    expect(report.schemaVersion).toBe(3);
    expect(report.metrics.deterministicChecks).toBeGreaterThan(report.findings.length);
    expect(report.lineage).toEqual(expect.objectContaining({
      contractStatus: "initial",
      baselineTrust: "none",
      rebaselineRequired: false,
    }));
    expect(report.lineage.reportDigest).toMatch(/^report_[a-f0-9]{64}$/u);
    expect(report.findings.every((item) => /^fingerprint_[a-f0-9]{20}$/u.test(item.fingerprint))).toBe(true);
    // public-api-compatibility ranks below test-gap but is a defect probe, so the process
    // signal no longer takes its slot.
    expect(report.challengePlan.map((item) => item.strategy)).toEqual([
      "baseline",
      "security",
      "test-gap",
      "data-integrity",
      "public-api-compatibility",
    ]);
  });

  it("requires an explicit rebaseline when the objective changes between reviews", async () => {
    const validator = new SuperValidator({ impactDepth: 3 });
    const index = await validationFixture();
    const previous = validator.validate(index, changeSet(), contract());
    const current = validator.validate(
      index,
      { ...changeSet(), patch: "second patch" },
      contract({ objective: "Remove token persistence entirely" }),
      { previousReport: previous },
    );

    expect(current.verdict).toBe("inconclusive");
    expect(current.lineage).toEqual(expect.objectContaining({
      seriesId: previous.lineage.seriesId,
      previousReviewId: previous.lineage.reviewId,
      baselineTrust: "unattested",
      contractStatus: "rebaseline-required",
      rebaselineRequired: true,
    }));
    expect(current.lineage.contractDelta.objectiveChanged).toBe(true);
    expect(current.findings.some((item) => item.kind === "contract-drift")).toBe(true);
  });

  it("allows a review contract to be strengthened with added claims", async () => {
    const validator = new SuperValidator();
    const index = await validationFixture();
    const previous = validator.validate(index, changeSet(), contract());
    const current = validator.validate(index, { ...changeSet(), patch: "claim-strengthening patch" }, contract({
      claims: [{
        id: "storage-changed",
        statement: "Token storage changed.",
        check: { kind: "file-changed", path: "src/storage.ts", expectation: "present" },
      }],
    }), { previousReport: previous });

    expect(current.lineage.contractStatus).toBe("strengthened");
    expect(current.lineage.rebaselineRequired).toBe(false);
    expect(current.lineage.contractDelta.addedClaimIds).toEqual(["storage-changed"]);
    expect(current.claims[0]?.outcome).toBe("supported");
  });

  it("refuses lineage trust when the previous report content was changed", async () => {
    const validator = new SuperValidator();
    const index = await validationFixture();
    const previous = validator.validate(index, changeSet(), contract());
    const tampered = { ...previous, summary: "tampered after validation" };
    const current = validator.validate(
      index,
      { ...changeSet(), patch: "next patch" },
      contract(),
      { previousReport: tampered },
    );

    expect(current.verdict).toBe("inconclusive");
    expect(current.lineage.baselineTrust).toBe("invalid");
    expect(current.lineage.rebaselineRequired).toBe(true);
    expect(current.findingLifecycle.progress).toBe("initial");
  });

  it("opens a distinct lineage when an intentional new series is requested", async () => {
    const validator = new SuperValidator();
    const index = await validationFixture();
    const previous = validator.validate(index, changeSet(), contract());
    const current = validator.validate(
      index,
      { ...changeSet(), patch: "intentional rebaseline patch" },
      contract(),
      { previousReport: previous, newSeries: true },
    );

    expect(current.lineage.seriesId).not.toBe(previous.lineage.seriesId);
    expect(current.lineage.contractStatus).toBe("initial");
    expect(current.lineage.previousReviewId).toBeUndefined();
  });

  it("rejects a malformed previous report before it can influence comparison", async () => {
    const validator = new SuperValidator();
    const index = await validationFixture();

    expect(() => validator.validate(index, changeSet(), contract(), {
      previousReport: { schemaVersion: 2, lineage: {} } as never,
    })).toThrow("Previous report is not a comparable Conclave schema v2/v3 report");
  });

  it("rejects duplicate claim identities before creating lineage", async () => {
    const validator = new SuperValidator();
    const index = await validationFixture();
    const duplicateClaim = {
      id: "same-claim",
      statement: "Storage changed.",
      check: { kind: "file-changed" as const, path: "src/storage.ts", expectation: "present" as const },
    };

    expect(() => validator.validate(index, changeSet(), contract({
      claims: [duplicateClaim, duplicateClaim],
    }))).toThrow("Validation contract contains a duplicate claim id");
  });

  it("classifies bound, stale, failed, and HEAD-only mutable-worktree receipts", async () => {
    const validator = new SuperValidator();
    const index = await validationFixture();
    const baseline = validator.validate(index, changeSet(), contract());
    const outputDigest = "f".repeat(64);
    const receipt = (overrides: Partial<EvidenceReceiptInput>): EvidenceReceiptInput => ({
      id: "test-receipt",
      type: "test",
      artifactDigest: baseline.lineage.artifactDigest,
      outputDigest,
      command: "npm test",
      exitCode: 0,
      startedAt: "2026-08-13T10:00:00.000Z",
      finishedAt: "2026-08-13T10:01:00.000Z",
      runner: "test-runner",
      ...overrides,
    });
    const current = validator.validate(index, changeSet(), contract(), {
      receipts: [
        receipt({ id: "current" }),
        receipt({ id: "stale", artifactDigest: "artifact_" + "0".repeat(64) }),
        receipt({ id: "failed", exitCode: 1 }),
        {
          id: "head-only",
          type: "test",
          outputDigest,
          command: "npm test",
          exitCode: 0,
          startedAt: "2026-08-13T10:00:00.000Z",
          finishedAt: "2026-08-13T10:01:00.000Z",
          runner: "test-runner",
          headSha: changeSet().headSha,
        },
      ],
    });

    expect(current.receipts.items.map((item) => [item.id, item.status])).toEqual([
      ["current", "current"],
      ["stale", "stale"],
      ["failed", "failed"],
      ["head-only", "unbound"],
    ]);
    expect(current.verdict).toBe("warn");
  });

  it("distinguishes duplicate rechecks from stagnating review loops", async () => {
    const validator = new SuperValidator();
    const index = await validationFixture();
    const first = validator.validate(index, changeSet(), contract());
    const duplicate = validator.validate(index, changeSet(), contract(), { previousReport: first, stagnationThreshold: 3 });
    const second = validator.validate(
      index,
      { ...changeSet(), patch: "iteration two" },
      contract(),
      { previousReport: duplicate, stagnationThreshold: 3 },
    );
    const third = validator.validate(
      index,
      { ...changeSet(), patch: "iteration three" },
      contract(),
      { previousReport: second, stagnationThreshold: 3 },
    );

    expect(duplicate.findingLifecycle.progress).toBe("duplicate-recheck");
    expect(second.findingLifecycle.progress).toBe("mixed");
    expect(third.findingLifecycle.progress).toBe("stagnant");
    expect(third.findingLifecycle.stagnating.length).toBeGreaterThan(0);
  });

  it("blocks a completion claim contradicted by deterministic graph evidence", async () => {
    const report = new SuperValidator({ impactDepth: 3 }).validate(
      await validationFixture(),
      changeSet(),
      contract({
        claims: [{
          id: "no-callers",
          statement: "persistToken has no remaining callers.",
          check: {
            kind: "callers",
            symbol: "persistToken",
            expectation: "absent",
          },
        }],
      }),
    );

    expect(report.verdict).toBe("block");
    expect(report.claims[0]?.outcome).toBe("rejected");
    expect(report.findings.some((item) => item.kind === "claim-contradicted")).toBe(true);
  });

  it("blocks files outside an explicit validation scope", async () => {
    const report = new SuperValidator().validate(
      await validationFixture(),
      changeSet(["src/storage.ts", "src/flow.ts"]),
      contract({ allowedPathPrefixes: ["src/storage.ts"] }),
    );

    expect(report.verdict).toBe("block");
    expect(report.findings.find((item) => item.kind === "scope-expansion")?.evidence).toEqual([
      expect.objectContaining({ path: "src/flow.ts" }),
    ]);
  });

  it("does not treat a mixed source edit as a deletion-only change", async () => {
    const report = new SuperValidator().validate(
      await validationFixture(),
      {
        ...changeSet(),
        files: [{
          path: "src/storage.ts",
          status: "modified",
          hunks: [
            { oldStart: 1, oldCount: 1, newStart: 1, newCount: 0 },
            { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
          ],
        }],
      },
      contract(),
    );

    expect(report.findings.some((item) => item.kind === "head-only-deletion")).toBe(false);
  });

  it("keeps callers claims inconclusive when a symbol name resolves to multiple declarations", async () => {
    const report = new SuperValidator({ impactDepth: 3 }).validate(
      await ambiguousSymbolFixture(),
      changeSet(["src/left.ts"]),
      contract({
        claims: [{
          id: "duplicate-callers",
          statement: "duplicate has callers.",
          check: { kind: "callers", symbol: "duplicate", expectation: "present" },
        }],
      }),
    );

    expect(report.verdict).toBe("inconclusive");
    expect(report.claims[0]?.outcome).toBe("inconclusive");
    expect(report.claims[0]?.evidence.map((item) => item.path)).toEqual([
      "src/left.ts",
      "src/right.ts",
    ]);
  });

  it("refuses a non-deterministic embedding index instead of misreporting the trust boundary", async () => {
    const index = await validationFixture();
    const nonDeterministic = {
      ...index,
      embedding: { ...index.embedding, kind: "learned-semantic" as const },
    };

    expect(() => new SuperValidator().validate(nonDeterministic, changeSet(), contract())).toThrow(
      "requires deterministic local embeddings",
    );
  });
});

describe("schema migration lineage", () => {
  it("continues an authentic v2 report without silently changing its digest or contract", async () => {
    const validator = new SuperValidator();
    const index = await validationFixture();
    const previous = finalizeReportDigest({ ...validator.validate(index, changeSet(), contract()), schemaVersion: 2, escalation: { recommended: false, dimensions: [{ dimension: "lifecycle-state", coverage: "checked-clean", reason: "Legacy check" }], reasons: [] } });
    const digest = previous.lineage.reportDigest;
    const current = validator.validate(index, changeSet(), contract(), { previousReport: previous });
    expect(current.schemaVersion).toBe(3);
    expect(current.lineage.contractStatus).toBe("preserved");
    expect(current.lineage.previousReportDigest).toBe(digest);
    expect(current.lineage.baselineTrust).toBe("unattested");
    expect(previous.lineage.reportDigest).toBe(digest);
  });
});
