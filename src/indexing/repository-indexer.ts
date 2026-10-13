import { createHash } from "node:crypto";

import {
  CODE_INDEX_SCHEMA_VERSION,
  CODE_INDEXING_VERSION,
  UnsupportedCodeIndexSchemaError,
  type CodeIndexStore,
  type CoverageGap,
  type CoverageGapReason,
  type IndexedCodeUnit,
  type IndexedFile,
  type IndexUpdateResult,
  type RepositoryCodeIndex,
} from "../domain/code-index.js";
import type { CodeParser, StructuralCodeUnit } from "../domain/code-intelligence.js";
import type { EmbeddingProvider, EmbeddingRequest } from "../domain/embedding.js";
import { NullRetrievalEventSink, type RetrievalEventSink } from "../domain/observability.js";
import type { RepositoryExclusionReason, RepositorySource } from "../domain/repository.js";
import { createLexicalDocument } from "../retrieval/tokenizer.js";
import { buildCodeGraph } from "../graph/code-graph.js";

interface MutableIndexStats {
  filesAdded: number;
  filesChanged: number;
  filesUnchanged: number;
  filesDeleted: number;
  filesSkippedSecret: number;
  filesSkippedUnsupported: number;
  parserFailures: number;
  unitsIndexed: number;
  embeddingsCreated: number;
  embeddingCacheHits: number;
}

function emptyStats(): MutableIndexStats {
  return {
    filesAdded: 0,
    filesChanged: 0,
    filesUnchanged: 0,
    filesDeleted: 0,
    filesSkippedSecret: 0,
    filesSkippedUnsupported: 0,
    parserFailures: 0,
    unitsIndexed: 0,
    embeddingsCreated: 0,
    embeddingCacheHits: 0,
  };
}

const EXCLUSION_GAP_REASON: Readonly<Record<RepositoryExclusionReason, CoverageGapReason>> = {
  "sensitive-path": "safety-excluded-path",
  ignored: "ignored",
  symlink: "symlink",
  binary: "binary",
  oversized: "oversized",
  unreadable: "unreadable",
};

function embeddingKey(providerId: string, unit: StructuralCodeUnit): string {
  return createHash("sha256")
    .update(`${providerId}\0${unit.sourceIdentity}`)
    .digest("hex");
}

function indexedUnit(unit: StructuralCodeUnit, key: string): IndexedCodeUnit {
  return {
    id: unit.id,
    sourceIdentity: unit.sourceIdentity,
    path: unit.path,
    language: unit.language,
    symbol: unit.symbol,
    symbolKind: unit.symbolKind,
    startLine: unit.startLine,
    endLine: unit.endLine,
    ...(unit.parentSymbol === undefined ? {} : { parentSymbol: unit.parentSymbol }),
    references: unit.references,
    calls: unit.calls,
    heritage: unit.heritage,
    exported: unit.exported,
    async: unit.async,
    lexical: createLexicalDocument(unit.sourceText, unit.symbol, unit.path),
    embeddingKey: key,
  };
}

function compatibleIndex(
  index: RepositoryCodeIndex | undefined,
  parser: CodeParser,
  embedder: EmbeddingProvider,
): index is RepositoryCodeIndex {
  return (
    index !== undefined &&
    index.schemaVersion === CODE_INDEX_SCHEMA_VERSION &&
    index.indexingVersion === CODE_INDEXING_VERSION &&
    index.parserId === parser.id &&
    index.embedding.id === embedder.id &&
    index.embedding.dimensions === embedder.dimensions &&
    index.embedding.kind === embedder.kind
  );
}

export interface RepositoryIndexerOptions {
  readonly repositorySource: RepositorySource;
  readonly parser: CodeParser;
  readonly embeddingProvider: EmbeddingProvider;
  readonly indexStore: CodeIndexStore;
  readonly events?: RetrievalEventSink;
}

export class RepositoryIndexer {
  readonly #repositorySource: RepositorySource;
  readonly #parser: CodeParser;
  readonly #embeddingProvider: EmbeddingProvider;
  readonly #indexStore: CodeIndexStore;
  readonly #events: RetrievalEventSink;

  public constructor(options: RepositoryIndexerOptions) {
    this.#repositorySource = options.repositorySource;
    this.#parser = options.parser;
    this.#embeddingProvider = options.embeddingProvider;
    this.#indexStore = options.indexStore;
    this.#events = options.events ?? new NullRetrievalEventSink();
  }

  public async index(path: string): Promise<IndexUpdateResult> {
    const snapshot = await this.#repositorySource.load({ path });
    this.#events.emit({
      type: "repository_index_started",
      occurredAt: new Date().toISOString(),
      repositoryId: snapshot.repository.id,
    });
    let loaded: RepositoryCodeIndex | undefined;
    try {
      loaded = await this.#indexStore.load(snapshot.repository.rootPath);
    } catch (error) {
      if (!(error instanceof UnsupportedCodeIndexSchemaError)) {
        throw error;
      }
      loaded = undefined;
    }
    const previous = compatibleIndex(loaded, this.#parser, this.#embeddingProvider)
      ? loaded
      : undefined;
    const stats = emptyStats();
    const files: Record<string, IndexedFile> = Object.create(null) as Record<string, IndexedFile>;
    const units: Record<string, IndexedCodeUnit> = Object.create(null) as Record<string, IndexedCodeUnit>;
    const embeddingCache: Record<string, readonly number[]> = Object.create(null) as Record<
      string,
      readonly number[]
    >;
    const pendingEmbeddings = new Map<string, EmbeddingRequest>();
    // Every entry that exists in the repository but will be absent from the index, with the
    // reason. Paths and categories only: a gap never carries file content.
    const gaps: CoverageGap[] = (snapshot.exclusions ?? []).map((exclusion) => ({
      path: exclusion.relativePath,
      reason: EXCLUSION_GAP_REASON[exclusion.reason],
    }));

    for (const file of snapshot.files) {
      if (!file.safety.externalTransmissionAllowed) {
        stats.filesSkippedSecret += 1;
        gaps.push({
          path: file.relativePath,
          reason: "safety-excluded-content",
          detail: [...new Set(file.safety.findings.filter((item) => item.severity === "block").map((item) => item.kind))].sort().join(", "),
        });
        this.#events.emit({
          type: "file_skipped",
          occurredAt: new Date().toISOString(),
          repositoryId: snapshot.repository.id,
          path: file.relativePath,
          data: { reason: "secret" },
        });
        continue;
      }
      if (!this.#parser.supports(file.language)) {
        stats.filesSkippedUnsupported += 1;
        gaps.push({ path: file.relativePath, reason: "unsupported-language" });
        continue;
      }

      const previousFile = previous?.files[file.relativePath];
      if (previousFile?.contentHash === file.sha256) {
        files[file.relativePath] = previousFile;
        for (const unitId of previousFile.symbolIds) {
          const unit = previous?.units[unitId];
          if (unit !== undefined) {
            units[unit.id] = unit;
            const vector = previous?.embeddingCache[unit.embeddingKey];
            if (vector !== undefined) {
              embeddingCache[unit.embeddingKey] = vector;
              stats.embeddingCacheHits += 1;
              this.#events.emit({
                type: "embedding_cache_hit",
                occurredAt: new Date().toISOString(),
                repositoryId: snapshot.repository.id,
                path: file.relativePath,
              });
            }
          }
        }
        stats.filesUnchanged += 1;
        continue;
      }

      let parsed;
      try {
        parsed = this.#parser.parse(file);
      } catch {
        stats.parserFailures += 1;
        gaps.push({ path: file.relativePath, reason: "parser-failure" });
        this.#events.emit({
          type: "file_skipped",
          occurredAt: new Date().toISOString(),
          repositoryId: snapshot.repository.id,
          path: file.relativePath,
          data: { reason: "parser-failure" },
        });
        continue;
      }

      const symbolIds: string[] = [];
      for (const unit of parsed.units) {
        const key = embeddingKey(this.#embeddingProvider.id, unit);
        const storedUnit = indexedUnit(unit, key);
        units[storedUnit.id] = storedUnit;
        symbolIds.push(storedUnit.id);
        const cachedVector = previous?.embeddingCache[key];
        if (cachedVector !== undefined) {
          embeddingCache[key] = cachedVector;
          stats.embeddingCacheHits += 1;
        } else if (!pendingEmbeddings.has(key)) {
          pendingEmbeddings.set(key, { identity: key, text: unit.sourceText });
        }
      }
      files[file.relativePath] = {
        path: file.relativePath,
        language: file.language,
        contentHash: file.sha256,
        sourceText: parsed.sourceText,
        imports: parsed.imports,
        exports: parsed.exports,
        symbolIds,
        diagnostics: parsed.diagnostics,
        parserId: parsed.parserId,
        indexingVersion: CODE_INDEXING_VERSION,
      };
      stats.unitsIndexed += symbolIds.length;
      if (previousFile === undefined) {
        stats.filesAdded += 1;
      } else {
        stats.filesChanged += 1;
      }
      this.#events.emit({
        type: "file_parsed",
        occurredAt: new Date().toISOString(),
        repositoryId: snapshot.repository.id,
        path: file.relativePath,
        data: { symbols: symbolIds.length, diagnostics: parsed.diagnostics.length },
      });
    }

    stats.filesDeleted = Object.keys(previous?.files ?? {}).filter((filePath) => files[filePath] === undefined).length;
    if (pendingEmbeddings.size > 0) {
      const embedded = await this.#embeddingProvider.embed([...pendingEmbeddings.values()]);
      for (const result of embedded) {
        if (
          result.vector.length !== this.#embeddingProvider.dimensions ||
          !result.vector.every((component) => Number.isFinite(component))
        ) {
          throw new Error(`Embedding provider ${this.#embeddingProvider.id} returned an invalid vector`);
        }
        embeddingCache[result.identity] = [...result.vector];
      }
      if (embedded.length !== pendingEmbeddings.size) {
        throw new Error(`Embedding provider ${this.#embeddingProvider.id} returned an incomplete batch`);
      }
      stats.embeddingsCreated = embedded.length;
    }

    for (const unit of Object.values(units)) {
      if (embeddingCache[unit.embeddingKey] === undefined) {
        throw new Error(`Missing embedding for structural unit ${unit.id}`);
      }
    }

    const now = new Date().toISOString();
    const index: RepositoryCodeIndex = {
      schemaVersion: CODE_INDEX_SCHEMA_VERSION,
      indexingVersion: CODE_INDEXING_VERSION,
      repository: snapshot.repository,
      parserId: this.#parser.id,
      embedding: {
        id: this.#embeddingProvider.id,
        dimensions: this.#embeddingProvider.dimensions,
        kind: this.#embeddingProvider.kind,
      },
      files,
      units,
      embeddingCache,
      graphEdges: buildCodeGraph(files, units),
      coverage: { gaps: gaps.sort((left, right) => left.path.localeCompare(right.path)) },
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await this.#indexStore.save(snapshot.repository.rootPath, index);
    this.#events.emit({
      type: "index_updated",
      occurredAt: now,
      repositoryId: snapshot.repository.id,
      data: {
        files: Object.keys(files).length,
        units: Object.keys(units).length,
        changed: stats.filesAdded + stats.filesChanged + stats.filesDeleted,
      },
    });
    return { index, stats };
  }
}
