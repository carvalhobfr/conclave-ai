import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import type { ChangeSet, ValidationReport } from "../src/domain/validation.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { SuperValidator } from "../src/validation/super-validator.js";

interface ReportSchema {
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, { readonly maxItems?: number }>>;
}

async function schema(): Promise<ReportSchema> {
  return JSON.parse(
    await readFile(resolve("schemas/validation-report.v4.schema.json"), "utf8"),
  ) as ReportSchema;
}

/** A change that trips several risk dimensions at once, so the plan is as long as it gets. */
async function report(): Promise<ValidationReport> {
  const root = await mkdtemp(join(tmpdir(), "conclave-report-schema-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "storage.ts"),
    [
      'const TOKEN_KEY = "auth-token";',
      "export function persistToken(token: string) { localStorage.setItem(TOKEN_KEY, token); }",
      'export function clearToken() { localStorage.removeItem("token"); }',
      'export function watchSession() { window.addEventListener("storage", () => undefined); }',
      "export function migrate() { try { persistToken(\"x\"); } catch {} }",
      "",
    ].join("\n"),
  );
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider: new LocalHashEmbeddingProvider(),
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root);
  const changeSet: ChangeSet = {
    source: { kind: "working" },
    headSha: "a".repeat(40),
    files: [{ path: "src/storage.ts", status: "added", hunks: [] }],
    patch: "session token migration schema cache render aria listener",
    collectedAt: "2026-08-18T00:00:00.000Z",
  };
  return new SuperValidator().validate(indexed.index, changeSet, {
    objective: "Keep session storage consistent",
    claims: [],
    allowedPathPrefixes: [],
  });
}

describe("published report schema", () => {
  it("declares every field a real report emits", async () => {
    const [declared, produced] = await Promise.all([schema(), report()]);
    // The schema sets additionalProperties:false, so an undeclared field makes valid Conclave
    // output fail validation for anyone who checks it against the published contract.
    const undeclared = Object.keys(produced).filter((key) => !(key in declared.properties));
    expect(undeclared).toEqual([]);
  });

  it("emits every field the schema marks required", async () => {
    const [declared, produced] = await Promise.all([schema(), report()]);
    const missing = declared.required.filter((key) => !(key in produced));
    expect(missing).toEqual([]);
  });

  it("keeps the challenge plan within the declared maximum", async () => {
    const [declared, produced] = await Promise.all([schema(), report()]);
    const maxItems = declared.properties["challengePlan"]?.maxItems;
    expect(maxItems).toBeGreaterThan(0);
    expect(produced.challengePlan.length).toBeLessThanOrEqual(maxItems ?? 0);
  });
});
