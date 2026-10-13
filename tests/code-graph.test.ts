import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import type { IndexedFile } from "../src/domain/code-index.js";
import { buildCodeGraph, CodeGraph, resolveImport } from "../src/graph/code-graph.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { CodeRetrievalService } from "../src/retrieval/code-retrieval-service.js";

async function graphFixture() {
  const root = await mkdtemp(join(tmpdir(), "conclave-graph-"));
  await mkdir(join(root, "src", "auth"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "src", "auth", "storage.ts"),
      `export function getStoredToken() {
  return localStorage.getItem("token");
}
`,
    ),
    writeFile(
      join(root, "src", "auth", "AuthProvider.tsx"),
      `import React from "react";
import { getStoredToken } from "./storage";
export class SessionController {
  bootstrapSession() {
    return getStoredToken();
  }
}
`,
    ),
  ]);
  const embeddingProvider = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root);
  return { index: indexed.index, embeddingProvider };
}

describe("deterministic code graph", () => {
  it("derives only resolved import, ownership, containment, reference, and direct-call edges", async () => {
    const { index } = await graphFixture();
    const relations = index.graphEdges.map((edge) => edge.relation);

    expect(relations).toEqual(
      expect.arrayContaining([
        "belongs-to-file",
        "exports-symbol",
        "contains-symbol",
        "imports-file",
        "imports-symbol",
        "references-symbol",
        "calls-symbol",
      ]),
    );
    expect(
      index.graphEdges.some(
        (edge) => edge.relation === "imports-file" && edge.provenance.reason.includes("react"),
      ),
    ).toBe(false);
    expect(
      index.graphEdges.find((edge) => edge.relation === "calls-symbol")?.provenance,
    ).toEqual(
      expect.objectContaining({ path: "src/auth/AuthProvider.tsx", line: 5 }),
    );
  });

  it("bounds graph expansion depth and evidence budget with duplicate suppression", async () => {
    const { index } = await graphFixture();
    const bootstrap = Object.values(index.units).find((unit) => unit.symbol === "bootstrapSession");
    expect(bootstrap).toBeDefined();
    const graph = new CodeGraph(index);

    expect(graph.expand([bootstrap!.id], { maxDepth: 0, maxEvidence: 10 })).toEqual([]);
    const expanded = graph.expand([bootstrap!.id], { maxDepth: 2, maxEvidence: 1 });
    expect(expanded).toHaveLength(1);
    expect(new Set(expanded.map((item) => item.unit.id)).size).toBe(expanded.length);
    expect(expanded[0]?.depth).toBeLessThanOrEqual(2);
  });
});

describe("repository retrieval primitives", () => {
  it("finds references, imports, related symbols, and graph-expanded hybrid evidence", async () => {
    const { index, embeddingProvider } = await graphFixture();
    const service = new CodeRetrievalService(index, embeddingProvider);

    expect(service.findReferences("getStoredToken").map((result) => result.evidence.symbol)).toContain(
      "bootstrapSession",
    );
    expect(
      service
        .findImports("src/auth/AuthProvider.tsx")
        .map((result) => result.evidence.symbol),
    ).toContain("getStoredToken");
    expect(service.findImports("getStoredToken")[0]?.evidence.excerpt).toContain(
      "import { getStoredToken }",
    );
    expect(service.findRelated("bootstrapSession", 2, 10).map((result) => result.evidence.symbol)).toContain(
      "getStoredToken",
    );

    const search = await service.search("bootstrapSession", { limit: 5, graphDepth: 2 });
    const storedToken = search.find((result) => result.evidence.symbol === "getStoredToken");
    expect(storedToken?.signals.graph).toBeGreaterThan(0);
    expect(storedToken?.reasons.some((reason) => reason.strategy === "graph")).toBe(true);
  });
});

function indexedFile(path: string, imports: IndexedFile["imports"] = []): IndexedFile {
  const language = path.endsWith(".py") ? "python" : path.endsWith(".java") ? "java" : path.endsWith(".tsx") ? "tsx" : /\.[cm]?js$/u.test(path) ? "javascript" : "typescript";
  return { path, language, contentHash: "", sourceText: "", imports, exports: [], symbolIds: [], diagnostics: [], parserId: "test", indexingVersion: 0 };
}

function fileMap(...paths: readonly string[]): Record<string, IndexedFile> {
  return Object.fromEntries(paths.map((path) => [path, indexedFile(path)]));
}

describe("import specifier resolution", () => {
  it("maps an emitted JavaScript extension back to the TypeScript source that produces it", () => {
    const files = fileMap("src/store.ts", "src/View.tsx", "src/worker.mts", "src/legacy.cts", "src/main.ts");

    expect(resolveImport("src/main.ts", "./store.js", "typescript", files)).toEqual({ status: "resolved", path: "src/store.ts" });
    expect(resolveImport("src/main.ts", "./View.js", "typescript", files)).toEqual({ status: "resolved", path: "src/View.tsx" });
    expect(resolveImport("src/main.ts", "./View.jsx", "typescript", files)).toEqual({ status: "resolved", path: "src/View.tsx" });
    expect(resolveImport("src/main.ts", "./worker.mjs", "typescript", files)).toEqual({ status: "resolved", path: "src/worker.mts" });
    expect(resolveImport("src/main.ts", "./legacy.cjs", "typescript", files)).toEqual({ status: "resolved", path: "src/legacy.cts" });
    expect(resolveImport("src/nested/deep.ts", "../store.js", "typescript", files)).toEqual({ status: "resolved", path: "src/store.ts" });
  });

  it("leaves a missing target unresolved instead of substituting a neighbour", () => {
    const files = fileMap("src/main.ts", "src/store/index.ts", "src/store.py", "src/other.mts");

    // An explicit file extension never means a directory index or another language.
    expect(resolveImport("src/main.ts", "./store.js", "typescript", files)).toEqual({ status: "unresolved" });
    expect(resolveImport("src/main.ts", "./absent.js", "typescript", files)).toEqual({ status: "unresolved" });
    // `.mjs` is emitted by `.mts` only, and `.js` never by `.mts`.
    expect(resolveImport("src/main.ts", "./other.js", "typescript", files)).toEqual({ status: "unresolved" });
    expect(resolveImport("src/main.ts", "../dist/store.js", "typescript", files)).toEqual({ status: "unresolved" });
    expect(resolveImport("src/main.ts", "react", "typescript", files)).toEqual({ status: "unresolved" });
  });

  it("draws no edge when two sources would emit the imported file", () => {
    const main = indexedFile("src/main.ts", [{ source: "./panel.js", line: 1, bindings: [] }]);
    const files = { ...fileMap("src/panel.ts", "src/panel.tsx"), [main.path]: main };

    expect(resolveImport("src/main.ts", "./panel.js", "typescript", files)).toEqual({
      status: "ambiguous",
      candidates: ["src/panel.ts", "src/panel.tsx"],
    });
    expect(buildCodeGraph(files, {}).filter((edge) => edge.relation === "imports-file")).toEqual([]);
    // The `.jsx` output has exactly one possible source, so that specifier stays resolvable.
    expect(resolveImport("src/main.ts", "./panel.jsx", "typescript", files)).toEqual({ status: "resolved", path: "src/panel.tsx" });
  });

  it("keeps a specifier that names an indexed file bound to that file", () => {
    const files = fileMap("src/main.ts", "src/store.js", "src/store.ts", "src/direct.ts");

    expect(resolveImport("src/main.ts", "./store.js", "typescript", files)).toEqual({ status: "resolved", path: "src/store.js" });
    expect(resolveImport("src/main.ts", "./direct.ts", "typescript", files)).toEqual({ status: "resolved", path: "src/direct.ts" });
  });

  it("resolves extensionless specifiers exactly as before", () => {
    const files = fileMap("src/main.ts", "src/store.ts", "src/store.js", "src/auth/index.ts", "src/widget.tsx", "src/user.service.ts");

    expect(resolveImport("src/main.ts", "./store", "typescript", files)).toEqual({ status: "resolved", path: "src/store.ts" });
    expect(resolveImport("src/main.ts", "./auth", "typescript", files)).toEqual({ status: "resolved", path: "src/auth/index.ts" });
    expect(resolveImport("src/main.ts", "./widget", "typescript", files)).toEqual({ status: "resolved", path: "src/widget.tsx" });
    expect(resolveImport("src/auth/index.ts", "..", "typescript", { ...files, ...fileMap("src/index.ts") })).toEqual({ status: "resolved", path: "src/index.ts" });
    // A dotted basename is not a file extension.
    expect(resolveImport("src/main.ts", "./user.service", "typescript", files)).toEqual({ status: "resolved", path: "src/user.service.ts" });
  });

  it("never resolves a specifier into another language or onto an inherited property", () => {
    const files = fileMap("src/main.ts", "src/config.py", "utils.ts", "utils.py", "app/models.py", "app/views.py", "com/acme/Order.java", "com/acme/Order.ts");

    expect(resolveImport("src/main.ts", "./config", "typescript", files)).toEqual({ status: "unresolved" });
    expect(resolveImport("app/views.py", "utils", "python", files)).toEqual({ status: "resolved", path: "utils.py" });
    expect(resolveImport("app/views.py", ".models", "python", files)).toEqual({ status: "resolved", path: "app/models.py" });
    expect(resolveImport("com/acme/Cart.java", "com.acme.Order", "java", files)).toEqual({ status: "resolved", path: "com/acme/Order.java" });
    expect(resolveImport("main.ts", "./constructor", "typescript", files)).toEqual({ status: "unresolved" });
  });

  it("connects a NodeNext-style project across files through the real indexer", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-nodenext-"));
    await mkdir(join(root, "src"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "src", "storage.ts"), "export function getStoredToken() {\n  return \"token\";\n}\n"),
      writeFile(join(root, "src", "session.ts"), "import { getStoredToken } from \"./storage.js\";\nexport function bootstrapSession() {\n  return getStoredToken();\n}\n"),
    ]);
    const { index } = await new RepositoryIndexer({
      repositorySource: new LocalFolderRepository(),
      parser: new TypeScriptCodeParser(),
      embeddingProvider: new LocalHashEmbeddingProvider(),
      indexStore: new InMemoryCodeIndexStore(),
    }).index(root);
    const target = Object.values(index.units).find((unit) => unit.symbol === "getStoredToken");
    const crossFile = index.graphEdges.filter((edge) => edge.provenance.path === "src/session.ts" &&
      (edge.to.id === "src/storage.ts" || edge.to.id === target?.id));

    expect(crossFile.map((edge) => edge.relation).sort()).toEqual(["calls-symbol", "imports-file", "imports-symbol", "references-symbol"]);
    expect(crossFile.find((edge) => edge.relation === "imports-file")?.provenance).toEqual(expect.objectContaining({
      resolutionMethod: "relative-import-path",
      reason: "resolved relative import ./storage.js",
      line: 1,
    }));
  });
});
