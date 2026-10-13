import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { renderCompactReview } from "../src/cli-review-output.js";
import { MultiLanguageCodeParser } from "../src/code-intelligence/multi-language-parser.js";
import type { RepositoryCodeIndex } from "../src/domain/code-index.js";
import type { CodeParser } from "../src/domain/code-intelligence.js";
import { createPullRequestSummary } from "../src/domain/pr-summary.js";
import { createReviewHandoff } from "../src/domain/review-handoff.js";
import type { ChangeSet, ValidationChangedFile, ValidationReport } from "../src/domain/validation.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { FileSystemCodeIndexStore } from "../src/indexing/file-system-index-store.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { hiddenSourceFiles, summarizeIndexCoverage } from "../src/validation/coverage.js";
import { SuperValidator } from "../src/validation/super-validator.js";

// Assembled at run time so this file does not itself match a credential detector.
const SYNTHETIC_SECRET = ["sk", "synthetic0coverage0secret0value"].join("-");

async function repository(files: Readonly<Record<string, string | Buffer>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-coverage-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function indexOf(root: string, parser: CodeParser = new MultiLanguageCodeParser()): Promise<RepositoryCodeIndex> {
  return (await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository({ maxFileBytes: 4_000 }),
    parser,
    embeddingProvider: new LocalHashEmbeddingProvider(),
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root)).index;
}

function changed(...paths: readonly string[]): ChangeSet {
  return {
    source: { kind: "working" },
    headSha: "a".repeat(40),
    files: paths.map((path): ValidationChangedFile => ({ path, status: "modified", hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }] })),
    patch: paths.join("\n"),
    collectedAt: "2026-10-12T00:00:00.000Z",
  };
}

function validate(index: RepositoryCodeIndex, changeSet: ChangeSet): ValidationReport {
  return new SuperValidator().validate(index, changeSet, { objective: "Rotate the session key", claims: [], allowedPathPrefixes: [] });
}

function gapFindings(report: ValidationReport) {
  return report.findings.filter((finding) => finding.kind === "coverage-gap");
}

const SOURCE = "export function session() {\n  return 1;\n}\n";

describe("repository exclusions", () => {
  it("records why each entry was not loaded, with safety exclusions apart from ignore rules", async () => {
    const root = await repository({
      ".gitignore": "generated/\n",
      ".env": "TOKEN=never-read\n",
      "deploy/server.pem": "never-read\n",
      "generated/schema.ts": SOURCE,
      "node_modules/pkg/index.js": "module.exports = {};\n",
      "src/session.ts": SOURCE,
      "asset.dat": Buffer.from([1, 0, 2]),
      "large.txt": "x".repeat(5_000),
    });
    await symlink(join(root, "src", "session.ts"), join(root, "linked.ts"));

    const snapshot = await new LocalFolderRepository({ maxFileBytes: 4_000 }).load({ path: root });

    expect(snapshot.exclusions).toEqual([
      { relativePath: ".env", reason: "sensitive-path" },
      { relativePath: "asset.dat", reason: "binary" },
      { relativePath: "deploy/server.pem", reason: "sensitive-path" },
      { relativePath: "generated/", reason: "ignored" },
      { relativePath: "large.txt", reason: "oversized" },
      { relativePath: "linked.ts", reason: "symlink" },
      { relativePath: "node_modules/", reason: "ignored" },
    ]);
    // Classification never changes what is read: the sensitive files are still not loaded.
    expect(snapshot.files.map((file) => file.relativePath)).toEqual([".gitignore", "src/session.ts"]);
  });
});

describe("index coverage", () => {
  it("lists every entry missing from the index with a distinct reason and no content", async () => {
    const root = await repository({
      ".env": `TOKEN=${SYNTHETIC_SECRET}\n`,
      "README.md": "# Notes\n",
      "node_modules/pkg/index.js": "module.exports = {};\n",
      "src/keys.ts": `export const key = "${SYNTHETIC_SECRET}";\n`,
      "src/session.ts": SOURCE,
    });
    const index = await indexOf(root);

    expect(index.coverage?.gaps).toEqual([
      { path: ".env", reason: "safety-excluded-path" },
      { path: "node_modules/", reason: "ignored" },
      { path: "README.md", reason: "unsupported-language" },
      { path: "src/keys.ts", reason: "safety-excluded-content", detail: "credential" },
    ]);
    expect(Object.keys(index.files)).toEqual(["src/session.ts"]);
    expect(JSON.stringify(index)).not.toContain(SYNTHETIC_SECRET);
  });

  it("reports a parser failure instead of dropping the file", async () => {
    const real = new MultiLanguageCodeParser();
    const failing: CodeParser = {
      id: real.id,
      supports: (language) => real.supports(language),
      parse: (file) => {
        if (file.relativePath === "src/broken.ts") throw new Error("parser crashed");
        return real.parse(file);
      },
    };
    const index = await indexOf(await repository({ "src/broken.ts": SOURCE, "src/session.ts": SOURCE }), failing);

    expect(index.coverage?.gaps).toEqual([{ path: "src/broken.ts", reason: "parser-failure" }]);
    const report = validate(index, changed("src/broken.ts", "src/session.ts"));
    expect(report.coverage?.gaps).toEqual([{ path: "src/broken.ts", reason: "parser-failure" }]);
    expect(gapFindings(report).map((finding) => finding.title)).toEqual(["Changed source could not be parsed"]);
  });

  it("persists coverage with the index and rejects a tampered record", async () => {
    const root = await repository({ "src/keys.ts": `export const key = "${SYNTHETIC_SECRET}";\n`, "src/session.ts": SOURCE });
    const store = new FileSystemCodeIndexStore();
    const { index } = await new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new MultiLanguageCodeParser(),
      embeddingProvider: new LocalHashEmbeddingProvider(),
      indexStore: store,
    }).index(root);

    expect((await store.load(root))?.coverage).toEqual(index.coverage);
    const persisted = join(root, ".conclave", "code-index-v2.json");
    expect(await readFile(persisted, "utf8")).not.toContain(SYNTHETIC_SECRET);
    const tampered = JSON.parse(await readFile(persisted, "utf8")) as { coverage: { gaps: { path: string }[] } };
    tampered.coverage.gaps = [{ path: "../outside", reason: "ignored" } as never];
    await writeFile(persisted, JSON.stringify(tampered));
    await expect(store.load(root)).rejects.toThrow("Code index coverage is invalid");
  });
});

describe("validation coverage", () => {
  it("keeps withheld source files inside the capped safety list", () => {
    const gaps = [
      ...Array.from({ length: 60 }, (_, position) => ({ path: `config/${String(position).padStart(2, "0")}.env`, reason: "safety-excluded-path" as const })),
      { path: "src/keys.ts", reason: "safety-excluded-content" as const, detail: "credential" },
    ];
    const summary = summarizeIndexCoverage({ gaps });

    expect(summary.safetyExcluded[0]?.path).toBe("src/keys.ts");
    expect(summary.safetyExcludedOmitted).toBe(11);
    expect(hiddenSourceFiles({ changedFiles: { total: 0, analyzed: 0, deleted: 0, notAnalyzed: 0 }, gaps: [], repository: { analyzedFiles: 0, ...summary } })).toEqual({ count: 1, truncated: true });
  });

  it("turns a safety-excluded changed file into an explicit gap, not a pass and not a vulnerability", async () => {
    const root = await repository({ "src/keys.ts": `export const key = "${SYNTHETIC_SECRET}";\n`, "src/session.ts": SOURCE });
    const report = validate(await indexOf(root), changed("src/keys.ts", "src/session.ts"));

    expect(report.coverage).toEqual({
      changedFiles: { total: 2, analyzed: 1, deleted: 0, notAnalyzed: 1 },
      gaps: [{ path: "src/keys.ts", reason: "safety-excluded-content", detail: "credential" }],
      repository: {
        analyzedFiles: 1,
        excluded: { "safety-excluded-content": 1 },
        safetyExcluded: [{ path: "src/keys.ts", reason: "safety-excluded-content", detail: "credential" }],
        safetyExcludedOmitted: 0,
      },
    });
    const [gap, ...others] = gapFindings(report);
    expect(others).toEqual([]);
    expect(gap).toEqual(expect.objectContaining({
      severity: "warning",
      title: "Changed files were excluded from analysis for safety",
      evidence: [{ path: "src/keys.ts", reason: "Content matched a built-in credential detector; the file was left out of the index" }],
    }));
    expect(gap?.detail).toContain("not a detected vulnerability");
    // The excluded file is never counted as reviewed, and never escalated to a blocker.
    expect(report.verdict).toBe("warn");
    expect(report.findings.some((finding) => finding.severity === "blocking")).toBe(false);
    expect(report.summary).toContain("1 changed file(s) not analyzed.");
    expect(report.escalation.recommended).toBe(true);
    expect(report.escalation.reasons.join(" ")).toContain("Some changed files were not analyzed");
  });

  it("keeps the excluded content out of the report, the summary, the handoff and the terminal", async () => {
    const root = await repository({
      ".env.production": `TOKEN=${SYNTHETIC_SECRET}\n`,
      "src/keys.ts": `export const key = "${SYNTHETIC_SECRET}";\n`,
      "src/session.ts": SOURCE,
    });
    const report = validate(await indexOf(root), changed(".env.production", "src/keys.ts", "src/session.ts"));
    const summary = createPullRequestSummary(report);
    const terminal = renderCompactReview(report, summary, "en", false);

    for (const output of [JSON.stringify(report), JSON.stringify(summary), JSON.stringify(createReviewHandoff(report)), terminal]) {
      expect(output).not.toContain(SYNTHETIC_SECRET);
      expect(output).not.toContain("synthetic0coverage");
    }
    expect(report.coverage?.gaps.map((gap) => gap.reason)).toEqual(["safety-excluded-path", "safety-excluded-content"]);
    expect(terminal).toContain("Coverage: 2 changed files were not analyzed (1 safety-excluded-content, 1 safety-excluded-path). No result applies to them.");
    expect(summary.risks).toContain("WARNING: Changed files were excluded from analysis for safety");
  });

  it("records changed files without a parser as gaps without warning about them", async () => {
    const root = await repository({ "README.md": "# Notes\n", "package.json": "{}\n", "src/session.ts": SOURCE });
    const report = validate(await indexOf(root), changed("README.md", "package.json", "src/session.ts"));

    expect(report.coverage?.changedFiles).toEqual({ total: 3, analyzed: 1, deleted: 0, notAnalyzed: 2 });
    expect(report.coverage?.gaps).toEqual([
      { path: "package.json", reason: "unsupported-language" },
      { path: "README.md", reason: "unsupported-language" },
    ]);
    expect(gapFindings(report)).toEqual([]);
    expect(report.summary).not.toContain("not analyzed");
    expect(renderCompactReview(report, createPullRequestSummary(report), "en", false)).not.toContain("Coverage:");
  });

  it("warns when changed source sits under an ignored directory", async () => {
    const root = await repository({ "src/build/tool.ts": SOURCE, "src/session.ts": SOURCE });
    const report = validate(await indexOf(root), changed("src/build/tool.ts"));

    expect(report.coverage?.gaps).toEqual([{ path: "src/build/tool.ts", reason: "ignored" }]);
    expect(gapFindings(report)).toEqual([expect.objectContaining({
      severity: "warning",
      title: "Changed source files were not analyzed",
      evidence: [{ path: "src/build/tool.ts", reason: "Excluded by an ignore rule (.gitignore, .conclaveignore or a built-in default)" }],
    })]);
  });

  it("does not count a deleted file as a gap", async () => {
    const index = await indexOf(await repository({ "src/session.ts": SOURCE }));
    const report = validate(index, {
      ...changed("src/session.ts"),
      files: [
        { path: "src/session.ts", status: "modified", hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }] },
        { path: "src/removed.ts", status: "deleted", hunks: [] },
      ],
    });

    expect(report.coverage?.changedFiles).toEqual({ total: 2, analyzed: 1, deleted: 1, notAnalyzed: 0 });
    expect(report.coverage?.gaps).toEqual([]);
    expect(gapFindings(report)).toEqual([]);
  });

  it("reports an unexplained absence when the index carries no coverage record", async () => {
    const recorded = await indexOf(await repository({ "src/session.ts": SOURCE }));
    const legacy = Object.fromEntries(Object.entries(recorded).filter(([key]) => key !== "coverage")) as unknown as RepositoryCodeIndex;
    const report = validate(legacy, changed("src/missing.ts", "src/session.ts"));

    expect(report.coverage?.gaps).toEqual([{ path: "src/missing.ts", reason: "not-indexed" }]);
    // Unknown repository coverage is reported as unknown, never as "nothing excluded".
    expect(report.coverage?.repository).toBeUndefined();
    expect(gapFindings(report)).toEqual([expect.objectContaining({ title: "Changed source files were not analyzed" })]);
  });

  it("points out safety-excluded source outside the change, because impact cannot pass through it", async () => {
    const root = await repository({
      ".env": "TOKEN=never-read\n",
      "src/keys.ts": `import { session } from "./session.js";\nexport const key = "${SYNTHETIC_SECRET}";\nexport const active = session();\n`,
      "src/session.ts": SOURCE,
      "tests/session.test.ts": "import { session } from \"../src/session.js\";\nsession();\n",
    });
    const report = validate(await indexOf(root), changed("src/session.ts", "tests/session.test.ts"));
    const terminal = renderCompactReview(report, createPullRequestSummary(report), "en", false);

    expect(report.coverage?.gaps).toEqual([]);
    expect(gapFindings(report)).toEqual([]);
    expect(report.coverage?.repository?.safetyExcluded.map((gap) => gap.path)).toEqual([".env", "src/keys.ts"]);
    expect(report.impact.impactedFiles).not.toContain("src/keys.ts");
    // Only withheld source limits the graph; a credential file was never part of it.
    expect(terminal).toContain("Coverage: 1 source file(s) elsewhere in the repository are excluded for safety");
    expect(terminal).not.toContain(SYNTHETIC_SECRET);
  });
});

describe("published coverage schema", () => {
  it("declares every coverage field and reason a report can emit", async () => {
    const schema = JSON.parse(await readFile(resolve("schemas/validation-report.v5.schema.json"), "utf8")) as {
      readonly required: readonly string[];
      readonly $defs: Readonly<Record<string, { readonly properties: Readonly<Record<string, { readonly enum?: readonly string[]; readonly properties?: Readonly<Record<string, unknown>> }>> }>>;
    };
    const root = await repository({ "src/keys.ts": `export const key = "${SYNTHETIC_SECRET}";\n`, "src/session.ts": SOURCE });
    const report = validate(await indexOf(root), changed("src/keys.ts", "src/missing.ts"));
    const coverage = report.coverage;
    if (coverage?.repository === undefined) throw new Error("expected recorded coverage");

    // Optional, so reports written before coverage existed remain valid.
    expect(schema.required).not.toContain("coverage");
    expect(Object.keys(coverage).filter((key) => !(key in (schema.$defs["coverage"]?.properties ?? {})))).toEqual([]);
    expect(Object.keys(coverage.repository).filter((key) => !(key in (schema.$defs["coverage"]?.properties["repository"]?.properties ?? {})))).toEqual([]);
    const gap = schema.$defs["coverageGap"]?.properties ?? {};
    for (const item of [...coverage.gaps, ...coverage.repository.safetyExcluded]) {
      expect(Object.keys(item).filter((key) => !(key in gap))).toEqual([]);
      expect(gap["reason"]?.enum).toContain(item.reason);
    }
  });
});
