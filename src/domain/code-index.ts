import type {
  CallReference,
  CodeSymbolKind,
  ExportReference,
  HeritageReference,
  ImportReference,
  ParseDiagnostic,
} from "./code-intelligence.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { RepositoryDescriptor, SourceLanguage } from "./repository.js";

export const CODE_INDEX_SCHEMA_VERSION = 2;
export const CODE_INDEXING_VERSION = 3;

export class UnsupportedCodeIndexSchemaError extends Error {
  public constructor() {
    super("Code index schema is missing or unsupported");
    this.name = "UnsupportedCodeIndexSchemaError";
  }
}

export interface LexicalDocument {
  readonly terms: Readonly<Record<string, number>>;
  readonly length: number;
}

export interface IndexedCodeUnit {
  readonly id: string;
  readonly sourceIdentity: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly symbol: string;
  readonly symbolKind: CodeSymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly parentSymbol?: string;
  readonly references: readonly string[];
  readonly calls: readonly CallReference[];
  readonly heritage: readonly HeritageReference[];
  readonly exported: boolean;
  readonly async: boolean;
  readonly lexical: LexicalDocument;
  readonly embeddingKey: string;
}

export interface IndexedFile {
  readonly path: string;
  readonly language: SourceLanguage;
  readonly contentHash: string;
  /** Stored once per file; structural units retain line ranges instead of duplicate source. */
  readonly sourceText: string;
  readonly imports: readonly ImportReference[];
  readonly exports: readonly ExportReference[];
  readonly symbolIds: readonly string[];
  readonly diagnostics: readonly ParseDiagnostic[];
  readonly parserId: string;
  readonly indexingVersion: number;
}

export type GraphNodeKind = "file" | "symbol";

export interface GraphNodeReference {
  readonly kind: GraphNodeKind;
  readonly id: string;
}

export type GraphRelation =
  | "belongs-to-file"
  | "exports-symbol"
  | "contains-symbol"
  | "imports-file"
  | "imports-symbol"
  | "references-symbol"
  | "calls-symbol"
  | "extends-symbol"
  | "implements-symbol";

export type RelationProvenance = "extracted" | "resolved";

export type RelationResolutionMethod =
  | "parser-symbol-ownership"
  | "explicit-export"
  | "nested-source-range"
  | "relative-import-path"
  | "explicit-import-binding"
  | "imported-identifier"
  | "unique-same-file-identifier";

export interface GraphEdgeProvenance {
  readonly kind: RelationProvenance;
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly resolutionMethod: RelationResolutionMethod;
  readonly reason: string;
}

export interface GraphEdge {
  readonly id: string;
  readonly from: GraphNodeReference;
  readonly to: GraphNodeReference;
  readonly relation: GraphRelation;
  readonly provenance: GraphEdgeProvenance;
}

export type CoverageGapReason =
  /** File name matches a built-in credential pattern; never read. */
  | "safety-excluded-path"
  /** Content matched a credential or private-key detector; read locally, never indexed. */
  | "safety-excluded-content"
  /** `.gitignore`, `.conclaveignore`, or a built-in build-output rule. */
  | "ignored"
  /** No structural parser exists for this file type. */
  | "unsupported-language"
  /** The parser threw; nothing about the file is known. */
  | "parser-failure"
  | "binary"
  | "oversized"
  | "symlink"
  | "unreadable";

/** A repository entry that exists but is absent from the index. Never carries file content. */
export interface CoverageGap {
  /** Repository-relative path; an ignored directory is one entry ending in `/`. */
  readonly path: string;
  readonly reason: CoverageGapReason;
  /** Detector categories for a content exclusion, e.g. `credential`. */
  readonly detail?: string;
}

export interface IndexCoverage {
  /** Sorted by path. */
  readonly gaps: readonly CoverageGap[];
}

export interface RepositoryCodeIndex {
  readonly schemaVersion: number;
  readonly indexingVersion: number;
  readonly repository: RepositoryDescriptor;
  readonly parserId: string;
  readonly embedding: Pick<EmbeddingProvider, "id" | "dimensions" | "kind">;
  readonly files: Readonly<Record<string, IndexedFile>>;
  readonly units: Readonly<Record<string, IndexedCodeUnit>>;
  readonly embeddingCache: Readonly<Record<string, readonly number[]>>;
  readonly graphEdges: readonly GraphEdge[];
  /**
   * What the index does not contain, and why. Absent on an index built before coverage was
   * recorded or assembled by hand; absence means unknown, not complete.
   */
  readonly coverage?: IndexCoverage;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CodeIndexStore {
  load(repositoryRoot: string): Promise<RepositoryCodeIndex | undefined>;
  save(repositoryRoot: string, index: RepositoryCodeIndex): Promise<void>;
}

export interface IndexUpdateStats {
  readonly filesAdded: number;
  readonly filesChanged: number;
  readonly filesUnchanged: number;
  readonly filesDeleted: number;
  readonly filesSkippedSecret: number;
  readonly filesSkippedUnsupported: number;
  readonly parserFailures: number;
  readonly unitsIndexed: number;
  readonly embeddingsCreated: number;
  readonly embeddingCacheHits: number;
}

export interface IndexUpdateResult {
  readonly index: RepositoryCodeIndex;
  readonly stats: IndexUpdateStats;
}
