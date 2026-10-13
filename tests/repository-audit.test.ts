import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runRules } from "../src/analysis/pipeline.js";
import { auditIndex, auditRepository } from "../src/analysis/repository-audit.js";
import { AnalysisContext, changeScopeFiles, repositoryScopeFiles } from "../src/analysis/rule.js";
import { CHANGE_RULES, REPOSITORY_RULES } from "../src/analysis/rules.js";
import { AUDIT_EXIT, auditExitCode, parseAuditArguments, renderAuditReport } from "../src/cli-audit.js";
import type { AuditReport } from "../src/domain/audit.js";
import type { ChangeSet } from "../src/domain/validation.js";
import { audit } from "../src/lib.js";
import { createDeterministicValidationIndex } from "../src/validation/deterministic-index.js";
import { GitChangeSetService } from "../src/validation/git-change-set.js";
import { SuperValidator } from "../src/validation/super-validator.js";

const execute = promisify(execFile);

// Assembled at run time so this file does not itself match a credential detector.
const SYNTHETIC_SECRET = ["sk", "synthetic0audit0secret0value000"].join("-");

async function repository(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-audit-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function commitAll(root: string): Promise<void> {
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "snapshot"]]) {
    await execute("git", args, { cwd: root });
  }
}

const TWO_CATCHES = [
  "export function load() {",
  "  try { read(); } catch {}",
  "}",
  "export function save() {",
  "  try { write(); } catch {}",
  "  try { write(); } catch {}",
  "}",
  "",
].join("\n");

const FILES = {
  "src/session.ts": TWO_CATCHES,
  "src/listen.ts": "export function watch() {\n  window.addEventListener(\"resize\", onResize);\n}\n",
  "src/clean.ts": "export function sum(a: number, b: number) {\n  return a + b;\n}\n",
};

/** Everything about a report that must not vary between two audits of the same content. */
function stable(report: AuditReport): unknown {
  return { snapshot: report.snapshot.id, findings: report.findings, summary: report.summary, coverage: report.coverage, rules: report.rules.map((rule) => ({ ...rule, durationMs: 0 })) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("repository scope", () => {
  it("analyzes files that no Git change touches", async () => {
    const root = await repository(FILES);
    await commitAll(root);

    // Nothing is changed: change scope has nothing to examine.
    const changeSet = await new GitChangeSetService().collect(root, { kind: "working" });
    const { index } = await createDeterministicValidationIndex(root);
    expect(changeSet.files).toEqual([]);
    expect(new SuperValidator().validate(index, changeSet, { objective: "Review", claims: [], allowedPathPrefixes: [] }).findings.map((item) => item.kind)).toEqual(["no-change"]);

    const report = await auditRepository(root);
    expect(report.scope).toBe("repository");
    expect(report.findings.map((item) => `${item.ruleId} ${item.location.path}:${String(item.location.startLine)}`)).toEqual([
      "unreleased-resource src/listen.ts:2",
      "discarded-error src/session.ts:2",
      "discarded-error src/session.ts:5",
      "discarded-error src/session.ts:6",
    ]);
    expect(report.snapshot.kind).toBe("working-tree");
    expect(report.snapshot.headCommit).toMatch(/^[a-f0-9]{40}$/u);
  }, 30000);

  it("examines whole files of the snapshot and fabricates no change", async () => {
    const root = await repository(FILES);
    const { index } = await createDeterministicValidationIndex(root);
    const files = repositoryScopeFiles(index);

    expect(files).toEqual([{ path: "src/clean.ts" }, { path: "src/listen.ts" }, { path: "src/session.ts" }]);
    expect(files.every((file) => file.changedRanges === undefined)).toBe(true);
    // Works without Git at all, and the report has no diff, objective or merge verdict.
    const report = await auditRepository(root);
    expect(report.snapshot).toEqual({ id: expect.stringMatching(/^snapshot_[a-f0-9]{32}$/u) as unknown, kind: "directory" });
    for (const key of ["changeSet", "verdict", "objective", "lineage", "claims", "findingLifecycle"]) expect(key in report).toBe(false);
    expect(report.findings.some((item) => item.title.includes("Changed"))).toBe(false);
  });

  it("gives identical snapshots identical identities and ordering", async () => {
    const [left, right] = await Promise.all([auditRepository(await repository(FILES)), auditRepository(await repository(FILES))]);

    expect(stable(left)).toEqual(stable(right));
    expect(left.findings.map((item) => item.id)).toEqual(right.findings.map((item) => item.id));
    const changed = await auditRepository(await repository({ ...FILES, "src/clean.ts": "export const other = 1;\n" }));
    expect(changed.snapshot.id).not.toBe(left.snapshot.id);
  });

  it("keeps several findings in one file distinct and stable when unrelated lines move", async () => {
    const before = await auditRepository(await repository(FILES));
    const after = await auditRepository(await repository({ ...FILES, "src/session.ts": `// header\n\n${TWO_CATCHES}` }));
    const session = (report: AuditReport) => report.findings.filter((item) => item.location.path === "src/session.ts");

    expect(session(before)).toHaveLength(3);
    expect(new Set(before.findings.map((item) => item.fingerprint)).size).toBe(before.findings.length);
    expect(new Set(before.findings.map((item) => item.id)).size).toBe(before.findings.length);
    expect(session(after).map((item) => item.location.startLine)).toEqual([4, 7, 8]);
    expect(session(after).map((item) => item.fingerprint)).toEqual(session(before).map((item) => item.fingerprint));
    expect(session(before).map((item) => item.location.symbol)).toEqual(["load", "save", "save"]);
  });

  it("records what each finding does and does not establish", async () => {
    const report = await auditRepository(await repository(FILES));

    for (const finding of report.findings) {
      expect(finding.origin).toBe("deterministic-rule");
      expect(finding.status).toEqual({ ruleMatched: true, evidence: "source-located", reproduction: "not-attempted", humanConfirmation: "none", publication: "not-requested" });
      expect(finding.snapshot).toBe(report.snapshot.id);
      expect(finding.evidence.length).toBeGreaterThan(0);
      expect(finding.limitations.length).toBeGreaterThan(0);
    }
  });

  it("keeps an inline-suppressed finding visible and out of the counts", async () => {
    const report = await auditRepository(await repository({ "src/a.ts": "export function a() {\n  try { run(); } catch {} // conclave-ignore: discarded-error\n\n  try { run(); } catch {}\n}\n" }));

    expect(report.findings.map((item) => item.suppression)).toEqual([{ directive: "conclave-ignore" }, undefined]);
    expect(report.summary).toEqual(expect.objectContaining({ findings: 1, suppressed: 1, byRule: { "discarded-error": 1 } }));
  });
});

describe("change scope", () => {
  it("still reports only what the change touched, in source order", async () => {
    const root = await repository({ "src/session.ts": TWO_CATCHES, "src/listen.ts": FILES["src/listen.ts"] });
    const { index } = await createDeterministicValidationIndex(root);
    const changeSet: ChangeSet = {
      source: { kind: "working" },
      headSha: "a".repeat(40),
      files: [
        { path: "src/session.ts", status: "modified", hunks: [{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 }] },
        { path: "src/listen.ts", status: "added", hunks: [] },
      ],
      patch: "bounded",
      collectedAt: "2026-10-12T00:00:00.000Z",
    };
    const report = new SuperValidator().validate(index, changeSet, { objective: "Review", claims: [], allowedPathPrefixes: [] });

    expect(report.findings.filter((item) => item.severity === "warning").map((item) => `${item.kind} ${item.evidence[0]?.path ?? ""}:${String(item.evidence[0]?.startLine)} ${item.title}`)).toEqual([
      "discarded-error src/session.ts:5 Changed code has an empty catch block",
      "unreleased-resource src/listen.ts:2 Changed resource has no matching cleanup candidate in this file",
    ]);
    // One parse check per changed file plus the three defect rules per file.
    const run = runRules(CHANGE_RULES, new AnalysisContext("change", index, changeScopeFiles(index, changeSet.files)));
    expect(run.executions.map((item) => `${item.ruleId}:${String(item.filesExamined)}`)).toEqual(["parser-diagnostic:2", "unreleased-resource:2", "inconsistent-key:2", "discarded-error:2"]);
  });

  it("does not run repository-only rules on a change", async () => {
    const { index } = await createDeterministicValidationIndex(await repository(FILES));
    const run = runRules(REPOSITORY_RULES, new AnalysisContext("change", index, changeScopeFiles(index, [{ path: "src/clean.ts", status: "added", hunks: [] }])));

    expect(run.executions.filter((item) => item.status === "skipped").map((item) => [item.ruleId, item.reason])).toEqual([
      ["unresolved-import", "Not applicable to change scope"],
      ["import-cycle", "Not applicable to change scope"],
    ]);
  });
});

describe("graph rules", () => {
  it("reports a relative import with no target and ignores ones the index explains", async () => {
    const report = await auditRepository(await repository({
      ".gitignore": "generated/\n",
      "generated/schema.ts": "export const schema = 1;\n",
      "src/styles.css": "body {}\n",
      "src/keys.ts": `export const key = "${SYNTHETIC_SECRET}";\n`,
      "src/panel.ts": "export const panel = 1;\n",
      "src/panel.tsx": "export const Panel = 1;\n",
      "src/main.ts": [
        "import \"./styles.css\";",
        "import { schema } from \"../generated/schema.js\";",
        "import { key } from \"./keys.js\";",
        "import { gone } from \"./missing.js\";",
        "import { panel } from \"./panel.js\";",
        "export const all = [schema, key, gone, panel];",
        "",
      ].join("\n"),
    }));

    expect(report.findings.filter((item) => item.ruleId === "unresolved-import").map((item) => [item.location.startLine, item.title])).toEqual([
      [4, "Relative import does not resolve to an analyzed file"],
      [5, "Relative import matches more than one source file"],
    ]);
  });

  it("does not let an excluded sibling with the same stem explain a broken import", async () => {
    const report = await auditRepository(await repository({
      "src/store.fixture.ts": `export const key = "${SYNTHETIC_SECRET}";\n`,
      "src/data.json": "{}\n",
      "src/main.ts": "import { store } from \"./store.js\";\nimport { data } from \"./data.js\";\nexport const all = [store, data];\n",
    }));

    expect(report.findings.filter((item) => item.ruleId === "unresolved-import").map((item) => item.location.startLine)).toEqual([1, 2]);
  });

  it("finds a load-time import cycle and ignores a type-only one", async () => {
    const report = await auditRepository(await repository({
      "src/a.ts": "import { b } from \"./b.js\";\nexport const a = () => b;\n",
      "src/b.ts": "import { a } from \"./a.js\";\nexport const b = () => a;\n",
      "src/c.ts": "import type { D } from \"./d.js\";\nexport interface C { d: D }\n",
      "src/d.ts": "import type { C } from \"./c.js\";\nexport interface D { c: C }\n",
    }));
    const cycles = report.findings.filter((item) => item.ruleId === "import-cycle");

    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(expect.objectContaining({ severity: "low", title: "Import cycle between 2 files", location: expect.objectContaining({ path: "src/a.ts", startLine: 1 }) as unknown }));
    expect(cycles[0]?.evidence.map((item) => item.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("audit coverage", () => {
  it("reports unsupported and safety-excluded files and never calls a partial audit complete", async () => {
    const report = await auditRepository(await repository({
      ".env": "TOKEN=never-read\n",
      "README.md": "# Notes\n",
      "src/keys.ts": `export const key = "${SYNTHETIC_SECRET}";\n`,
      "src/clean.ts": FILES["src/clean.ts"],
    }));

    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.excluded).toEqual({ "safety-excluded-path": 1, "safety-excluded-content": 1, "unsupported-language": 1 });
    expect(report.coverage.unanalyzedSource).toEqual([
      { path: ".env", reason: "safety-excluded-path" },
      { path: "src/keys.ts", reason: "safety-excluded-content", detail: "credential" },
    ]);
    expect(report.coverage).toEqual(expect.objectContaining({ filesDiscovered: 4, filesAnalyzed: 1 }));
    expect(report.summary.findings).toBe(0);
    expect(report.conclusion).toContain("Coverage is partial");
    expect(report.conclusion).toContain("not evidence that the repository is free of defects");
    const text = renderAuditReport(report, undefined);
    expect(text).toContain("Coverage  PARTIAL · 1 of 4 files analyzed");
    expect(text).toContain("src/keys.ts — Content matched a built-in credential detector");
    for (const output of [text, JSON.stringify(report)]) {
      expect(output).not.toContain(SYNTHETIC_SECRET);
      expect(output).not.toMatch(/\b(?:clean|fully verified|no issues|all clear)\b/iu);
    }
  });

  it("counts files with one meaning each and never presents overlapping categories as a partition", async () => {
    const root = await repository({
      ".env": "TOKEN=never-read\n",
      ".gitignore": "*.log\nvendor/\n",
      "README.md": "# Notes\n",
      "debug.log": "noise\n",
      "vendor/lib/a.js": "export const a = 1;\n",
      "vendor/lib/b.js": "export const b = 2;\n",
      "node_modules/pkg/index.js": "module.exports = 1;\n",
      "src/keys.ts": `export const key = "${SYNTHETIC_SECRET}";\n`,
      "src/clean.ts": FILES["src/clean.ts"],
      "src/session.ts": TWO_CATCHES,
      "assets/logo.png": "\u0000\u0001\u0002binary",
    });
    const report = await auditRepository(root);
    const { accounting, excluded } = report.coverage;
    const sum = (counts: object): number => Object.values(counts as Record<string, number>).reduce((total, count) => total + count, 0);

    // Every discovered file is analyzed or has exactly one reason.
    expect(accounting).toEqual({
      filesDiscovered: 8,
      filesAnalyzed: 2,
      filesNotAnalyzed: { ignored: 1, safetyExcluded: 2, unsupported: 2, parserFailure: 0, unexamined: 1 },
      eligibleSourceFiles: 3,
      ignoredDirectories: 2,
    });
    expect(accounting.filesAnalyzed + sum(accounting.filesNotAnalyzed)).toBe(accounting.filesDiscovered);
    expect(report.coverage.filesDiscovered).toBe(accounting.filesDiscovered);
    expect(report.coverage.filesAnalyzed).toBe(accounting.filesAnalyzed);
    expect(report.metrics.filesExcluded).toBe(sum(accounting.filesNotAnalyzed));
    expect(sum(report.coverage.analyzedByLanguage)).toBe(accounting.filesAnalyzed);

    // `excluded` counts entries, so it exceeds the file difference by exactly the ignored directories.
    expect(excluded).toEqual({ ignored: 3, "safety-excluded-path": 1, "safety-excluded-content": 1, "unsupported-language": 2, binary: 1 });
    expect(sum(excluded)).toBe(sum(accounting.filesNotAnalyzed) + accounting.ignoredDirectories);

    // Eligible source overlaps the partition: the withheld source file is in both.
    expect(accounting.eligibleSourceFiles).toBe(accounting.filesAnalyzed + 1);
    expect(accounting.eligibleSourceFiles).toBeLessThanOrEqual(accounting.filesDiscovered);

    // The three files inside ignored directories were never listed and are in no count; the text says so.
    const text = renderAuditReport(report, undefined);
    expect(text).toContain("Coverage  PARTIAL · 2 of 8 files analyzed");
    expect(text).toContain("eligible source files: 3 (2 analyzed, 1 not)");
    expect(text).toContain("files not analyzed (6): 1 ignored, 2 safety-excluded, 2 unsupported type, 1 binary, oversized, unreadable or symlink");
    expect(text).toContain("not enumerated: 2 ignored directories (files inside are in no count)");
    expect(report.coverage.limits.join(" ")).toContain("1 file(s) and 2 directories");

    // Excluded files lower the ratio; they are not removed from the denominator.
    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.filesAnalyzed / report.coverage.filesDiscovered).toBe(0.25);
  });

  it("does not overstate a fully covered audit either", async () => {
    const report = await auditRepository(await repository({ "src/clean.ts": FILES["src/clean.ts"] }));

    expect(report.coverage.status).toBe("supported-source-analyzed");
    expect(report.coverage.limits.length).toBeGreaterThan(0);
    expect(report.conclusion).toBe("No rule matched in 1 analyzed file(s). That is the result of the listed rules only, not evidence that the repository is free of defects.");
  });

  it("treats an index without recorded coverage as partial", async () => {
    const { index } = await createDeterministicValidationIndex(await repository({ "src/clean.ts": FILES["src/clean.ts"] }));
    const legacy = Object.fromEntries(Object.entries(index).filter(([key]) => key !== "coverage")) as unknown as typeof index;

    expect(auditIndex({ index: legacy, analyzerVersion: "0.0.0" }).coverage.status).toBe("partial");
  });
});

describe("audit trust boundary", () => {
  it("calls no model provider and no network, even when a provider is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
    vi.stubEnv("CONCLAVE_MODE", "api");
    vi.stubEnv("CONCLAVE_PROVIDER", "openai");
    vi.stubEnv("CONCLAVE_API_KEY", "synthetic");
    vi.stubEnv("CONCLAVE_EMBEDDING_MODE", "openai-compatible");
    try {
      const report = await auditRepository(await repository(FILES));
      expect(report.trustBoundary).toEqual({ deterministic: true, modelCalls: 0, repositoryCodeExecuted: false, networkOperations: false });
      expect(report.summary.findings).toBe(4);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it("executes no repository code and starts no GitHub or package tool", async () => {
    const root = await repository({
      ...FILES,
      "package.json": JSON.stringify({ scripts: { preinstall: "node side-effect.js", test: "node side-effect.js", audit: "node side-effect.js" } }),
      "side-effect.js": "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'EXECUTED'), 'x');\n",
      "src/index.ts": "import { writeFileSync } from \"node:fs\";\nwriteFileSync(\"EXECUTED\", \"x\");\n",
    });
    // Decoys ahead of the real tools: running any of them leaves a marker.
    const bin = await mkdtemp(join(tmpdir(), "conclave-audit-bin-"));
    const marker = join(bin, "INVOKED");
    for (const tool of ["gh", "npm", "npx", "node", "hub", "curl"]) {
      await writeFile(join(bin, tool), `#!/bin/sh\necho ${tool} >> "${marker}"\n`);
      await chmod(join(bin, tool), 0o755);
    }
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env["PATH"] ?? ""}`);
    try {
      await commitAll(root);
      const report = await auditRepository(root);
      expect(report.snapshot.headCommit).toBeDefined();
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(root, "EXECUTED"))).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  }, 30000);

  it("writes nothing unless asked, and only its own state when asked", async () => {
    const root = await repository(FILES);
    const before = (await readdir(root, { recursive: true })).sort();

    await auditRepository(root);
    await audit({ repository: root });
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before);

    const report = await auditRepository(root, { write: true });
    const added = (await readdir(root, { recursive: true })).filter((entry) => !before.includes(entry)).sort();
    // Its report and the finding ledger, both under the self-ignoring `.conclave`. Nothing else.
    expect(added).toEqual([
      ".conclave",
      join(".conclave", ".gitignore"),
      join(".conclave", "audits"),
      join(".conclave", "audits", ".gitignore"),
      join(".conclave", "audits", "latest.json"),
      join(".conclave", "findings"),
      join(".conclave", "findings", ".gitignore"),
      join(".conclave", "findings", "ledger.json"),
    ]);
    expect((JSON.parse(await readFile(join(root, ".conclave", "audits", "latest.json"), "utf8")) as AuditReport).snapshot.id).toBe(report.snapshot.id);
    // The saved report is ignored by the next audit, so saving does not change the snapshot.
    expect((await auditRepository(root)).snapshot.id).toBe(report.snapshot.id);
  });
});

describe("audit command", () => {
  it("parses its options and rejects unknown ones", () => {
    expect(parseAuditArguments([])).toEqual({ path: ".", json: false, write: true, failOn: "high", requireComplete: false, baseline: true, updateBaseline: false });
    expect(parseAuditArguments(["repo", "--json", "--no-write", "--fail-on", "low", "--require-complete"])).toEqual({ path: "repo", json: true, write: false, failOn: "low", requireComplete: true, baseline: true, updateBaseline: false });
    expect(parseAuditArguments(["--no-baseline"]).baseline).toBe(false);
    expect(parseAuditArguments(["--update-baseline"]).updateBaseline).toBe(true);
    // Writing the committed baseline is never implied and cannot ride along with --no-write.
    expect(() => parseAuditArguments(["--update-baseline", "--no-write"])).toThrow("cannot be combined with --no-write");
    expect(() => parseAuditArguments(["--update-baseline", "--no-baseline"])).toThrow("contradict");
    expect(parseAuditArguments(["--fail-on=none"]).failOn).toBe("none");
    expect(() => parseAuditArguments(["--fail-on", "critical"])).toThrow("--fail-on must be");
    expect(() => parseAuditArguments(["--publish"])).toThrow("Unknown audit option");
    expect(() => parseAuditArguments(["a", "b"])).toThrow("one repository path");
  });

  it("derives exit codes from findings and coverage, independently of review verdicts", async () => {
    const findings = await auditRepository(await repository(FILES));
    const partial = await auditRepository(await repository({ "src/keys.ts": `export const key = "${SYNTHETIC_SECRET}";\n`, "src/clean.ts": FILES["src/clean.ts"] }));

    expect(auditExitCode(findings, { failOn: "high", requireComplete: false })).toBe(AUDIT_EXIT.completed);
    expect(auditExitCode(findings, { failOn: "medium", requireComplete: false })).toBe(AUDIT_EXIT.findings);
    expect(auditExitCode(findings, { failOn: "none", requireComplete: true })).toBe(AUDIT_EXIT.completed);
    expect(auditExitCode(partial, { failOn: "high", requireComplete: false })).toBe(AUDIT_EXIT.completed);
    expect(auditExitCode(partial, { failOn: "high", requireComplete: true })).toBe(AUDIT_EXIT.partialCoverage);
    expect(AUDIT_EXIT).toEqual({ completed: 0, findings: 1, partialCoverage: 2, failed: 3 });
  });

  it("renders a dense table and states what was not done", async () => {
    const text = renderAuditReport(await auditRepository(await repository(FILES)), ".conclave/audits/latest.json");

    expect(text).toContain("SEVERITY  RULE                 LOCATION          FINDING");
    expect(text).toContain("medium    discarded-error      src/session.ts:2  Empty catch block");
    expect(text).toContain("No model was called and no repository code was executed.");
    expect(text).toContain("Saved: .conclave/audits/latest.json");
  });
});

describe("published audit schema", () => {
  it("declares every field an audit report emits", async () => {
    interface Node { readonly properties?: Readonly<Record<string, Node>>; readonly required?: readonly string[]; readonly enum?: readonly string[] }
    const schema = JSON.parse(await readFile(resolve("schemas/audit-report.v1.schema.json"), "utf8")) as Node & { readonly $defs: Readonly<Record<string, Node>> };
    const report = await auditRepository(await repository({ ...FILES, "src/keys.ts": `export const key = "${SYNTHETIC_SECRET}";\n`, "src/a.ts": "try { run(); } catch {} // conclave-ignore\n" }));
    const undeclared = (value: object, node: Node | undefined): readonly string[] => Object.keys(value).filter((key) => !(key in (node?.properties ?? {})));

    expect(undeclared(report, schema)).toEqual([]);
    expect((schema.required ?? []).filter((key) => !(key in report))).toEqual([]);
    for (const key of ["analyzer", "snapshot", "coverage", "summary", "metrics", "trustBoundary"] as const) expect(undeclared(report[key], schema.properties?.[key])).toEqual([]);
    for (const finding of report.findings) {
      expect(undeclared(finding, schema.$defs["finding"])).toEqual([]);
      expect(undeclared(finding.status, schema.$defs["finding"]?.properties?.["status"])).toEqual([]);
    }
    for (const rule of report.rules) expect(undeclared(rule, schema.$defs["ruleExecution"])).toEqual([]);
    expect(report.findings.some((finding) => finding.suppression !== undefined)).toBe(true);
  });
});
