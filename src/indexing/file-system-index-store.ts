import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CODE_INDEX_SCHEMA_VERSION,
  CODE_INDEXING_VERSION,
  UnsupportedCodeIndexSchemaError,
  type RepositoryCodeIndex,
  type CodeIndexStore,
} from "../domain/code-index.js";
import { isPathInside, resolveRepositoryRoot } from "../security/path-policy.js";
import { assessRepositoryContent } from "../security/content-safety.js";
import { ensureConclaveDirectory } from "../storage/conclave-directory.js";

export const CODE_INDEX_DIRECTORY = ".conclave";
export const CODE_INDEX_FILENAME = "code-index-v2.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.startsWith("../") &&
    !path.includes("/../") &&
    !path.includes("\\")
  );
}

const GRAPH_RELATIONS = new Set([
  "belongs-to-file",
  "exports-symbol",
  "contains-symbol",
  "imports-file",
  "imports-symbol",
  "references-symbol",
  "calls-symbol",
  "extends-symbol",
  "implements-symbol",
]);

const RESOLUTION_METHODS = new Set([
  "parser-symbol-ownership",
  "explicit-export",
  "nested-source-range",
  "relative-import-path",
  "explicit-import-binding",
  "imported-identifier",
  "unique-same-file-identifier",
]);

function validatePersistedIndex(value: unknown, canonicalRoot: string): RepositoryCodeIndex {
  if (!isRecord(value) || value["schemaVersion"] !== CODE_INDEX_SCHEMA_VERSION) {
    throw new UnsupportedCodeIndexSchemaError();
  }
  if (value["indexingVersion"] !== CODE_INDEXING_VERSION) {
    throw new UnsupportedCodeIndexSchemaError();
  }
  const repository = value["repository"];
  // A cache describing another root is stale, not tampered with: moving or renaming the
  // repository directory produces one. It is discarded and rebuilt like an outdated schema,
  // rather than failing every command until the user deletes the cache by hand.
  if (isRecord(repository) && typeof repository["rootPath"] === "string" && repository["rootPath"] !== canonicalRoot) {
    throw new UnsupportedCodeIndexSchemaError();
  }
  const files = value["files"];
  const units = value["units"];
  const embedding = value["embedding"];
  const embeddingCache = value["embeddingCache"];
  if (
    !isRecord(repository) ||
    repository["rootPath"] !== canonicalRoot ||
    !isRecord(files) ||
    !isRecord(units) ||
    !isRecord(embedding) ||
    !isRecord(embeddingCache) ||
    !Array.isArray(value["graphEdges"])
  ) {
    throw new Error("Code index is corrupt or belongs to another repository");
  }
  if (
    typeof embedding["id"] !== "string" ||
    typeof embedding["dimensions"] !== "number" ||
    embedding["dimensions"] <= 0 ||
    (embedding["kind"] !== "deterministic-feature-hash" && embedding["kind"] !== "learned-semantic")
  ) {
    throw new Error("Code index embedding metadata is invalid");
  }
  for (const [path, file] of Object.entries(files)) {
    if (
      !isSafeRelativePath(path) ||
      !isRecord(file) ||
      file["path"] !== path ||
      typeof file["sourceText"] !== "string" ||
      typeof file["contentHash"] !== "string" ||
      createHash("sha256").update(file["sourceText"]).digest("hex") !== file["contentHash"]
    ) {
      throw new Error("Code index contains an invalid file path");
    }
    if (!assessRepositoryContent(file["sourceText"]).externalTransmissionAllowed) {
      throw new Error("Code index contains secret-classified source");
    }
  }
  for (const [unitId, unit] of Object.entries(units)) {
    if (
      !isRecord(unit) ||
      unit["id"] !== unitId ||
      typeof unit["path"] !== "string" ||
      !isSafeRelativePath(unit["path"]) ||
      typeof unit["startLine"] !== "number" ||
      typeof unit["endLine"] !== "number" ||
      typeof unit["embeddingKey"] !== "string" ||
      !Array.isArray(unit["heritage"]) ||
      !unit["heritage"].every(
        (heritage) =>
          isRecord(heritage) &&
          typeof heritage["name"] === "string" &&
          (heritage["relation"] === "extends" || heritage["relation"] === "implements") &&
          typeof heritage["line"] === "number" &&
          Number.isInteger(heritage["line"]),
      )
    ) {
      throw new Error("Code index contains an invalid unit path");
    }
    const owner = files[unit["path"]];
    if (!isRecord(owner) || typeof owner["sourceText"] !== "string") {
      throw new Error("Code index unit references a missing file");
    }
    const lineCount = owner["sourceText"].split("\n").length;
    if (
      !Number.isInteger(unit["startLine"]) ||
      !Number.isInteger(unit["endLine"]) ||
      unit["startLine"] < 1 ||
      unit["endLine"] < unit["startLine"] ||
      unit["endLine"] > lineCount
    ) {
      throw new Error("Code index unit contains an invalid source range");
    }
  }
  for (const vector of Object.values(embeddingCache)) {
    if (
      !Array.isArray(vector) ||
      vector.length !== embedding["dimensions"] ||
      !vector.every((component) => typeof component === "number" && Number.isFinite(component))
    ) {
      throw new Error("Code index contains an invalid embedding vector");
    }
  }
  for (const edge of value["graphEdges"]) {
    if (!isRecord(edge) || !isRecord(edge["from"]) || !isRecord(edge["to"]) || !isRecord(edge["provenance"])) {
      throw new Error("Code index contains an invalid graph edge");
    }
    const from = edge["from"];
    const to = edge["to"];
    const provenance = edge["provenance"];
    const provenancePath = provenance["path"];
    const provenanceFile = typeof provenancePath === "string" ? files[provenancePath] : undefined;
    const provenanceLineCount =
      isRecord(provenanceFile) && typeof provenanceFile["sourceText"] === "string"
        ? provenanceFile["sourceText"].split("\n").length
        : 0;
    const provenanceLine = provenance["line"];
    const provenanceEndLine = provenance["endLine"];
    if (
      typeof edge["id"] !== "string" ||
      typeof edge["relation"] !== "string" ||
      !GRAPH_RELATIONS.has(edge["relation"]) ||
      (from["kind"] !== "file" && from["kind"] !== "symbol") ||
      (to["kind"] !== "file" && to["kind"] !== "symbol") ||
      typeof from["id"] !== "string" ||
      typeof to["id"] !== "string" ||
      typeof provenance["path"] !== "string" ||
      (provenance["kind"] !== "extracted" && provenance["kind"] !== "resolved") ||
      typeof provenance["resolutionMethod"] !== "string" ||
      !RESOLUTION_METHODS.has(provenance["resolutionMethod"]) ||
      typeof provenance["reason"] !== "string" ||
      (provenanceLine !== undefined &&
        (typeof provenanceLine !== "number" ||
          !Number.isInteger(provenanceLine) ||
          provenanceLine < 1 ||
          provenanceLine > provenanceLineCount)) ||
      (provenanceEndLine !== undefined &&
        (typeof provenanceEndLine !== "number" ||
          !Number.isInteger(provenanceEndLine) ||
          typeof provenanceLine !== "number" ||
          provenanceEndLine < provenanceLine ||
          provenanceEndLine > provenanceLineCount)) ||
      !isSafeRelativePath(provenance["path"]) ||
      !(provenance["path"] in files) ||
      (from["kind"] === "file" ? !(from["id"] in files) : !(from["id"] in units)) ||
      (to["kind"] === "file" ? !(to["id"] in files) : !(to["id"] in units))
    ) {
      throw new Error("Code index graph edge references an invalid node or path");
    }
  }
  return value as unknown as RepositoryCodeIndex;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class FileSystemCodeIndexStore implements CodeIndexStore {
  public async load(repositoryRoot: string): Promise<RepositoryCodeIndex | undefined> {
    const canonicalRoot = await resolveRepositoryRoot(repositoryRoot);
    const indexPath = join(canonicalRoot, CODE_INDEX_DIRECTORY, CODE_INDEX_FILENAME);
    if (!isPathInside(canonicalRoot, indexPath)) {
      throw new Error("Resolved index path escaped the repository root");
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(indexPath, "utf8"));
      return validatePersistedIndex(parsed, canonicalRoot);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  public async save(repositoryRoot: string, index: RepositoryCodeIndex): Promise<void> {
    const canonicalRoot = await resolveRepositoryRoot(repositoryRoot);
    if (index.repository.rootPath !== canonicalRoot) {
      throw new Error("Cannot persist an index for a different repository root");
    }
    validatePersistedIndex(index, canonicalRoot);
    const indexDirectory = join(canonicalRoot, CODE_INDEX_DIRECTORY);
    const indexPath = join(indexDirectory, CODE_INDEX_FILENAME);
    const temporaryPath = join(indexDirectory, `${CODE_INDEX_FILENAME}.${randomUUID()}.tmp`);
    await ensureConclaveDirectory(indexDirectory);
    await writeFile(temporaryPath, `${JSON.stringify(index)}\n`, { mode: 0o600 });
    await rename(temporaryPath, indexPath);
    await chmod(indexPath, 0o600);
  }
}
