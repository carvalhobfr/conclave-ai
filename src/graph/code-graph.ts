import { createHash } from "node:crypto";
import { dirname, extname, posix } from "node:path";

import type {
  GraphEdge,
  GraphNodeReference,
  IndexedCodeUnit,
  IndexedFile,
  RepositoryCodeIndex,
} from "../domain/code-index.js";

type ImporterFamily = "javascript" | "python" | "java";

/**
 * Extensions an extensionless specifier may resolve to. A specifier only ever resolves inside
 * its importer's language family: `./config` in TypeScript never means `config.py`.
 */
const FAMILY_EXTENSIONS: Readonly<Record<ImporterFamily, readonly string[]>> = {
  javascript: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
  python: [".py", ".pyw"],
  java: [".java"],
};

/**
 * TypeScript projects that emit ES modules (NodeNext, Node16, or a bundler with explicit
 * extensions) name the emitted file in the specifier: `./store.js` is written in `store.ts`.
 * Each entry is the inverse of the compiler's emit: the sources that produce that output.
 */
const SOURCES_FOR_OUTPUT_EXTENSION: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

export type ImportResolution =
  | { readonly status: "resolved"; readonly path: string }
  /** More than one indexed source would emit the imported output; no edge is drawn. */
  | { readonly status: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly status: "unresolved" };

const UNRESOLVED: ImportResolution = { status: "unresolved" };

function importerFamily(language: IndexedFile["language"]): ImporterFamily {
  if (language === "python" || language === "java") return language;
  return "javascript";
}

function fileNode(path: string): GraphNodeReference {
  return { kind: "file", id: path };
}

function symbolNode(id: string): GraphNodeReference {
  return { kind: "symbol", id };
}

function nodeKey(node: GraphNodeReference): string {
  return `${node.kind}:${node.id}`;
}

function edgeId(edge: Omit<GraphEdge, "id">): string {
  return `edge_${createHash("sha256")
    .update(
      `${nodeKey(edge.from)}\0${nodeKey(edge.to)}\0${edge.relation}\0${edge.provenance.kind}\0${edge.provenance.path}\0${String(edge.provenance.line ?? "")}\0${String(edge.provenance.endLine ?? "")}\0${edge.provenance.resolutionMethod}\0${edge.provenance.reason}`,
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function createEdge(edge: Omit<GraphEdge, "id">): GraphEdge {
  return { id: edgeId(edge), ...edge };
}

/**
 * Resolves an import specifier to an indexed file, or reports why no edge may be drawn.
 *
 * 1. A specifier that names an indexed file literally resolves to that file.
 * 2. Otherwise a JavaScript output extension maps back to the TypeScript source that emits it.
 *    Two sources emitting the same output (`a.ts` beside `a.tsx`) are ambiguous, not guessed.
 * 3. Otherwise a specifier without a source extension gains one, then tries a directory index.
 *
 * A specifier with a recognised source extension never falls through to step 3: `./a.js` does
 * not mean `./a/index.ts`.
 */
export function resolveImport(
  importerPath: string,
  source: string,
  importerLanguage: IndexedFile["language"],
  files: Readonly<Record<string, IndexedFile>>,
): ImportResolution {
  const relative = source.startsWith(".");
  const family = importerFamily(importerLanguage);
  if (!relative && family === "javascript") return UNRESOLVED;
  const importerDirectory = dirname(importerPath).replaceAll("\\", "/");
  let relativeDirectory = importerDirectory;
  let relativeSource = source;
  if (relative && importerLanguage === "python") {
    const dots = source.match(/^\.+/)?.[0].length ?? 0;
    relativeSource = source.slice(dots).replaceAll(".", "/");
    for (let index = 1; index < dots; index += 1) relativeDirectory = dirname(relativeDirectory);
  }
  const normalizedSource = source.replaceAll(".", "/").replace(/^\/+/, "");
  const base = relative
    ? posix.normalize(posix.join(relativeDirectory, relativeSource.replace(/^\//, "")))
    : posix.normalize(normalizedSource);
  // Own-property lookup: a persisted index is a plain object, where `files["constructor"]` exists.
  const indexed = (candidate: string): boolean => Object.hasOwn(files, candidate);
  if (indexed(base)) return { status: "resolved", path: base };

  const extension = extname(base);
  if (family === "javascript") {
    const sourceExtensions = SOURCES_FOR_OUTPUT_EXTENSION[extension];
    if (sourceExtensions !== undefined) {
      const stem = base.slice(0, -extension.length);
      const sources = sourceExtensions.map((candidate) => `${stem}${candidate}`).filter(indexed);
      const [only] = sources;
      if (only === undefined) return UNRESOLVED;
      return sources.length === 1 ? { status: "resolved", path: only } : { status: "ambiguous", candidates: sources };
    }
  }
  if (FAMILY_EXTENSIONS[family].includes(extension)) return UNRESOLVED;

  // No source extension (`./store`, or a dotted basename such as `./user.service`).
  const candidates: string[] = [];
  for (const candidate of FAMILY_EXTENSIONS[family]) {
    candidates.push(`${base}${candidate}`);
    if (family === "javascript") candidates.push(`${base}/index${candidate}`);
  }
  if (family === "python") candidates.push(`${base}/__init__.py`);
  const path = candidates.find(indexed);
  return path === undefined ? UNRESOLVED : { status: "resolved", path };
}

function unitsByPath(
  units: Readonly<Record<string, IndexedCodeUnit>>,
): ReadonlyMap<string, readonly IndexedCodeUnit[]> {
  const grouped = new Map<string, IndexedCodeUnit[]>();
  for (const unit of Object.values(units)) {
    const values = grouped.get(unit.path) ?? [];
    values.push(unit);
    grouped.set(unit.path, values);
  }
  for (const values of grouped.values()) {
    values.sort((left, right) => left.startLine - right.startLine || left.id.localeCompare(right.id));
  }
  return grouped;
}

function explicitlyExportedUnit(
  file: IndexedFile,
  units: readonly IndexedCodeUnit[],
  importedName: string,
): IndexedCodeUnit | undefined {
  const exportReference = file.exports.find((entry) => entry.name === importedName);
  if (exportReference === undefined) {
    return undefined;
  }
  const localName = exportReference.localName ?? exportReference.name;
  return units.find((unit) => unit.symbol === localName && unit.exported);
}

function closestParent(
  child: IndexedCodeUnit,
  units: readonly IndexedCodeUnit[],
): IndexedCodeUnit | undefined {
  return units
    .filter(
      (candidate) =>
        candidate.id !== child.id &&
        candidate.symbol === child.parentSymbol &&
        candidate.startLine <= child.startLine &&
        candidate.endLine >= child.endLine,
    )
    .sort(
      (left, right) =>
        left.endLine - left.startLine - (right.endLine - right.startLine) ||
        left.startLine - right.startLine,
    )[0];
}

export function buildCodeGraph(
  files: Readonly<Record<string, IndexedFile>>,
  units: Readonly<Record<string, IndexedCodeUnit>>,
): readonly GraphEdge[] {
  const edges = new Map<string, GraphEdge>();
  const groupedUnits = unitsByPath(units);
  const add = (edge: Omit<GraphEdge, "id">): void => {
    const complete = createEdge(edge);
    edges.set(complete.id, complete);
  };

  for (const unit of Object.values(units)) {
    add({
      from: symbolNode(unit.id),
      to: fileNode(unit.path),
      relation: "belongs-to-file",
      provenance: {
        kind: "extracted",
        path: unit.path,
        line: unit.startLine,
        endLine: unit.endLine,
        resolutionMethod: "parser-symbol-ownership",
        reason: "symbol declaration is directly located in this file",
      },
    });
    if (unit.exported) {
      add({
        from: fileNode(unit.path),
        to: symbolNode(unit.id),
        relation: "exports-symbol",
        provenance: {
          kind: "extracted",
          path: unit.path,
          line: unit.startLine,
          endLine: unit.startLine,
          resolutionMethod: "explicit-export",
          reason: "declaration has an explicit export",
        },
      });
    }
    if (unit.parentSymbol !== undefined) {
      const parent = closestParent(unit, groupedUnits.get(unit.path) ?? []);
      if (parent !== undefined) {
        add({
          from: symbolNode(parent.id),
          to: symbolNode(unit.id),
          relation: "contains-symbol",
          provenance: {
            kind: "extracted",
            path: unit.path,
            line: unit.startLine,
            endLine: unit.endLine,
            resolutionMethod: "nested-source-range",
            reason: "declaration source range is nested inside its named parent",
          },
        });
      }
    }
  }

  for (const file of Object.values(files)) {
    const importedTargets = new Map<string, IndexedCodeUnit>();
    for (const importReference of file.imports) {
      const resolution = resolveImport(file.path, importReference.source, file.language, files);
      if (resolution.status !== "resolved") {
        continue;
      }
      const targetPath = resolution.path;
      add({
        from: fileNode(file.path),
        to: fileNode(targetPath),
        relation: "imports-file",
        provenance: {
          kind: "resolved",
          path: file.path,
          line: importReference.line,
          endLine: importReference.line,
          resolutionMethod: "relative-import-path",
          reason: `resolved relative import ${importReference.source}`,
        },
      });
      const targetFile = files[targetPath];
      if (targetFile === undefined) {
        continue;
      }
      const targetUnits = groupedUnits.get(targetPath) ?? [];
      for (const binding of importReference.bindings) {
        const imported = explicitlyExportedUnit(targetFile, targetUnits, binding.imported);
        if (imported === undefined) {
          continue;
        }
        importedTargets.set(binding.local, imported);
        add({
          from: fileNode(file.path),
          to: symbolNode(imported.id),
          relation: "imports-symbol",
          provenance: {
            kind: "resolved",
            path: file.path,
            line: importReference.line,
            endLine: importReference.line,
            resolutionMethod: "explicit-import-binding",
            reason: `explicit ${binding.kind} import ${binding.imported}`,
          },
        });
      }
    }

    const localUnits = groupedUnits.get(file.path) ?? [];
    const localByName = new Map<string, IndexedCodeUnit>();
    for (const unit of localUnits) {
      if (localUnits.filter((candidate) => candidate.symbol === unit.symbol).length === 1) {
        localByName.set(unit.symbol, unit);
      }
    }
    for (const unit of localUnits) {
      for (const reference of unit.references) {
        const target = importedTargets.get(reference) ?? localByName.get(reference);
        if (target === undefined || target.id === unit.id) {
          continue;
        }
        add({
          from: symbolNode(unit.id),
          to: symbolNode(target.id),
          relation: "references-symbol",
          provenance: {
            kind: "resolved",
            path: unit.path,
            line: unit.startLine,
            endLine: unit.endLine,
            resolutionMethod: importedTargets.has(reference)
              ? "imported-identifier"
              : "unique-same-file-identifier",
            reason: importedTargets.has(reference)
              ? `identifier resolves through import ${reference}`
              : `unique same-file identifier ${reference}`,
          },
        });
      }
      for (const call of unit.calls) {
        const target = importedTargets.get(call.name) ?? localByName.get(call.name);
        if (target === undefined || target.id === unit.id) {
          continue;
        }
        add({
          from: symbolNode(unit.id),
          to: symbolNode(target.id),
          relation: "calls-symbol",
          provenance: {
            kind: "resolved",
            path: unit.path,
            line: call.line,
            endLine: call.line,
            resolutionMethod: importedTargets.has(call.name)
              ? "imported-identifier"
              : "unique-same-file-identifier",
            reason: importedTargets.has(call.name)
              ? `direct call resolves through import ${call.name}`
              : `direct call resolves to unique same-file symbol ${call.name}`,
          },
        });
      }
      for (const heritage of unit.heritage) {
        const target = importedTargets.get(heritage.name) ?? localByName.get(heritage.name);
        if (target === undefined || target.id === unit.id) {
          continue;
        }
        add({
          from: symbolNode(unit.id),
          to: symbolNode(target.id),
          relation: heritage.relation === "extends" ? "extends-symbol" : "implements-symbol",
          provenance: {
            kind: "resolved",
            path: unit.path,
            line: heritage.line,
            endLine: heritage.line,
            resolutionMethod: importedTargets.has(heritage.name)
              ? "imported-identifier"
              : "unique-same-file-identifier",
            reason: `${heritage.relation} clause resolves to ${heritage.name}`,
          },
        });
      }
    }
  }

  return [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export interface GraphExpansionOptions {
  readonly maxDepth: number;
  readonly maxEvidence: number;
}

export interface ExpandedGraphUnit {
  readonly unit: IndexedCodeUnit;
  readonly depth: number;
  readonly edge: GraphEdge;
  readonly direction: "outgoing" | "incoming";
}

interface AdjacentEdge {
  readonly edge: GraphEdge;
  readonly next: GraphNodeReference;
  readonly direction: ExpandedGraphUnit["direction"];
}

export class CodeGraph {
  readonly #index: RepositoryCodeIndex;
  readonly #adjacency = new Map<string, AdjacentEdge[]>();

  public constructor(index: RepositoryCodeIndex) {
    this.#index = index;
    for (const edge of index.graphEdges) {
      const outgoing = this.#adjacency.get(nodeKey(edge.from)) ?? [];
      outgoing.push({ edge, next: edge.to, direction: "outgoing" });
      this.#adjacency.set(nodeKey(edge.from), outgoing);
      const incoming = this.#adjacency.get(nodeKey(edge.to)) ?? [];
      incoming.push({ edge, next: edge.from, direction: "incoming" });
      this.#adjacency.set(nodeKey(edge.to), incoming);
    }
    for (const adjacent of this.#adjacency.values()) {
      adjacent.sort((left, right) => left.edge.id.localeCompare(right.edge.id));
    }
  }

  public expand(
    startUnitIds: readonly string[],
    options: GraphExpansionOptions,
  ): readonly ExpandedGraphUnit[] {
    if (options.maxDepth <= 0 || options.maxEvidence <= 0) {
      return [];
    }
    const startKeys = new Set(startUnitIds.map((id) => nodeKey(symbolNode(id))));
    const visited = new Set(startKeys);
    const queued = [...startUnitIds]
      .sort()
      .map((id) => ({ node: symbolNode(id), depth: 0 }));
    const results: ExpandedGraphUnit[] = [];
    const evidenceIds = new Set<string>();

    while (queued.length > 0 && results.length < options.maxEvidence) {
      const current = queued.shift();
      if (current === undefined || current.depth >= options.maxDepth) {
        continue;
      }
      for (const adjacent of this.#adjacency.get(nodeKey(current.node)) ?? []) {
        const key = nodeKey(adjacent.next);
        if (visited.has(key)) {
          continue;
        }
        visited.add(key);
        const depth = current.depth + 1;
        queued.push({ node: adjacent.next, depth });
        if (adjacent.next.kind !== "symbol" || startKeys.has(key)) {
          continue;
        }
        const unit = this.#index.units[adjacent.next.id];
        if (unit !== undefined && !evidenceIds.has(unit.id)) {
          evidenceIds.add(unit.id);
          results.push({ unit, depth, edge: adjacent.edge, direction: adjacent.direction });
          if (results.length >= options.maxEvidence) {
            break;
          }
        }
      }
    }
    return results;
  }
}
