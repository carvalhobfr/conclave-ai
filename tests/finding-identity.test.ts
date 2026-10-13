import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import type { ValidationFinding, ValidationLineage, ValidationReport } from "../src/domain/validation.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { assignFindingIdentities } from "../src/validation/finding-identity.js";
import { createFindingLifecycle } from "../src/validation/review-lineage.js";
import { SuperValidator } from "../src/validation/super-validator.js";

const PATH = "src/session.ts";

/** Reviews one file as a whole; the patch is the source so each revision has its own diff digest. */
async function review(source: string, previousReport?: ValidationReport): Promise<ValidationReport> {
  const root = await mkdtemp(join(tmpdir(), "conclave-finding-identity-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, PATH), source);
  const { index } = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider: new LocalHashEmbeddingProvider(),
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root);
  return new SuperValidator().validate(
    index,
    {
      source: { kind: "working" },
      headSha: "a".repeat(40),
      files: [{ path: PATH, status: "added", hunks: [] }],
      patch: source,
      collectedAt: "2026-10-12T00:00:00.000Z",
    },
    { objective: "Keep the session in sync", claims: [], allowedPathPrefixes: [] },
    previousReport === undefined ? {} : { previousReport },
  );
}

function discarded(report: ValidationReport): readonly ValidationFinding[] {
  return report.findings.filter((finding) => finding.kind === "discarded-error");
}

function atLine(report: ValidationReport, line: number): ValidationFinding {
  const found = report.findings.find((finding) => finding.evidence[0]?.startLine === line);
  if (found === undefined) throw new Error(`No finding at line ${String(line)}`);
  return found;
}

const TWO_FUNCTIONS = [
  "export function load() {",
  "  try { read(); } catch {}",
  "}",
  "export function save() {",
  "  try { write(); } catch {}",
  "}",
  "",
].join("\n");

describe("finding identity", () => {
  it("gives two defects of one kind in one file distinct ids and fingerprints", async () => {
    const report = await review(TWO_FUNCTIONS);
    const findings = discarded(report);

    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((finding) => finding.fingerprint)).size).toBe(2);
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(2);
    // Every finding in the report is individually addressable.
    expect(new Set(report.findings.map((finding) => finding.id)).size).toBe(report.findings.length);
    expect(new Set(report.findings.map((finding) => finding.fingerprint)).size).toBe(report.findings.length);
    expect(report.findingLifecycle.current).toHaveLength(report.findings.length);
  });

  it("references each occurrence from the escalation checks", async () => {
    const report = await review(TWO_FUNCTIONS);
    const referenced = report.escalation.dimensions
      .flatMap((dimension) => dimension.checks ?? [])
      .filter((check) => check.rule === "discarded-error")
      .flatMap((check) => check.findingIds);

    expect([...new Set(referenced)].sort()).toEqual(discarded(report).map((finding) => finding.id).sort());
  });

  it("resolves only the corrected defect when the other remains", async () => {
    const first = await review(TWO_FUNCTIONS);
    const [load, save] = [atLine(first, 2), atLine(first, 5)];
    const second = await review(TWO_FUNCTIONS.replace("try { read(); } catch {}", "read();"), first);

    expect(second.findingLifecycle.resolved).toContain(load.fingerprint);
    expect(second.findingLifecycle.resolved).not.toContain(save.fingerprint);
    expect(discarded(second).map((finding) => finding.fingerprint)).toEqual([save.fingerprint]);
    expect(second.findingLifecycle.current.find((item) => item.fingerprint === save.fingerprint)).toEqual(
      expect.objectContaining({ status: "persistent", occurrences: 2 }),
    );
    expect(second.findingLifecycle.current.some((item) => item.fingerprint === load.fingerprint)).toBe(false);
  });

  it("separates different statements inside one function", async () => {
    const source = [
      "export function watch() {",
      "  window.addEventListener(\"storage\", onStorage);",
      "  window.addEventListener(\"resize\", onResize);",
      "}",
      "",
    ].join("\n");
    const first = await review(source);
    const [storage, resize] = [atLine(first, 2), atLine(first, 3)];
    expect(storage.fingerprint).not.toBe(resize.fingerprint);

    // Correcting the first leaves the second on line 2; it must keep its own identity.
    const second = await review(source.replace("  window.addEventListener(\"storage\", onStorage);\n", ""), first);
    expect(second.findingLifecycle.resolved).toContain(storage.fingerprint);
    expect(second.findings.filter((finding) => finding.kind === "unreleased-resource").map((finding) => finding.fingerprint))
      .toEqual([resize.fingerprint]);
  });

  it("counts identical statements separately and reports one resolution when one is removed", async () => {
    const twins = [
      "export function sync() {",
      "  try { push(); } catch {}",
      "  try { push(); } catch {}",
      "}",
      "",
    ].join("\n");
    const first = await review(twins);
    expect(new Set(discarded(first).map((finding) => finding.fingerprint)).size).toBe(2);

    const second = await review(twins.replace("  try { push(); } catch {}\n", ""), first);
    const remaining = discarded(second);
    expect(remaining).toHaveLength(1);
    expect(second.findingLifecycle.resolved.filter((fingerprint) =>
      discarded(first).some((finding) => finding.fingerprint === fingerprint))).toHaveLength(1);
    expect(second.findingLifecycle.current.find((item) => item.fingerprint === remaining[0]?.fingerprint)?.status).toBe("persistent");
  });

  it("keeps lineage when unrelated lines move a finding", async () => {
    const first = await review(TWO_FUNCTIONS);
    const shifted = [
      "// A header comment added later.",
      "export function unrelated() {",
      "  return 1;",
      "}",
      "",
      TWO_FUNCTIONS,
    ].join("\n");
    const second = await review(shifted, first);

    expect(discarded(second).map((finding) => finding.evidence[0]?.startLine)).toEqual([7, 10]);
    expect(discarded(second).map((finding) => finding.fingerprint)).toEqual(discarded(first).map((finding) => finding.fingerprint));
    expect(second.findingLifecycle.resolved.filter((fingerprint) =>
      discarded(first).some((finding) => finding.fingerprint === fingerprint))).toEqual([]);
    for (const finding of discarded(second)) {
      expect(second.findingLifecycle.current.find((item) => item.fingerprint === finding.fingerprint)?.status).toBe("persistent");
    }
  });

  it("produces identical identities for identical scans", async () => {
    const [left, right] = await Promise.all([review(TWO_FUNCTIONS), review(TWO_FUNCTIONS)]);

    expect(left.findings).toEqual(right.findings);
    expect(left.findingLifecycle).toEqual(right.findingLifecycle);
    expect(left.escalation).toEqual(right.escalation);
  });
});

function finding(fingerprint: string, line?: number): ValidationFinding {
  return {
    id: "finding_legacy",
    fingerprint,
    kind: "discarded-error",
    severity: "warning",
    title: "Changed code has an empty catch block",
    detail: "",
    evidence: line === undefined ? [] : [{ path: PATH, startLine: line, endLine: line, reason: "" }],
    remediation: "",
  };
}

describe("finding identity assignment", () => {
  it("orders indistinguishable findings by source position and keeps the first unsuffixed", () => {
    const [later, earlier] = [finding("fingerprint_same", 9), finding("fingerprint_same", 3)];
    const { findings, legacyFingerprints } = assignFindingIdentities([later, earlier], new Map());

    expect(findings[1]?.fingerprint).toBe("fingerprint_same");
    expect(findings[0]?.fingerprint).not.toBe("fingerprint_same");
    expect(new Set(findings.map((item) => item.id)).size).toBe(2);
    // Unanchored findings keep their fingerprint format, so there is nothing to bridge.
    expect(legacyFingerprints.size).toBe(0);
  });

  it("lets exactly one anchored finding inherit a pre-anchor fingerprint", () => {
    const [first, second] = [finding("fingerprint_old", 2), finding("fingerprint_old", 5)];
    const { findings, legacyFingerprints } = assignFindingIdentities(
      [first, second],
      new Map([[first, "load\0try { read(); } catch {}"], [second, "save\0try { write(); } catch {}"]]),
    );

    expect(new Set(findings.map((item) => item.fingerprint)).size).toBe(2);
    // Only the first in source order inherits; the second must not share that history.
    expect(findings.map((item) => legacyFingerprints.get(item.fingerprint))).toEqual(["fingerprint_old", undefined]);
  });
});

describe("lineage across the fingerprint format change", () => {
  const lineage = { diffDigest: "diff_current" } as ValidationLineage;
  const previous = {
    lineage: { diffDigest: "diff_previous" },
    findingLifecycle: {
      progress: "initial",
      current: [{ fingerprint: "fingerprint_old", status: "new", occurrences: 1, consecutive: 1 }],
      resolved: [],
      seen: ["fingerprint_old"],
      stagnating: [],
    },
  } as unknown as ValidationReport;

  it("continues one finding under its older fingerprint and treats a second as new", () => {
    const lifecycle = createFindingLifecycle(
      [finding("fingerprint_new_a"), finding("fingerprint_new_b")],
      lineage,
      previous,
      3,
      new Map([["fingerprint_new_a", "fingerprint_old"]]),
    );

    expect(lifecycle.resolved).toEqual([]);
    expect(lifecycle.current).toEqual([
      { fingerprint: "fingerprint_new_a", status: "persistent", occurrences: 2, consecutive: 2 },
      { fingerprint: "fingerprint_new_b", status: "new", occurrences: 1, consecutive: 1 },
    ]);
  });

  it("still reports a resolution when no current finding carries the older fingerprint", () => {
    const lifecycle = createFindingLifecycle([finding("fingerprint_unrelated")], lineage, previous);

    expect(lifecycle.resolved).toEqual(["fingerprint_old"]);
    expect(lifecycle.current).toEqual([{ fingerprint: "fingerprint_unrelated", status: "new", occurrences: 1, consecutive: 1 }]);
  });
});
