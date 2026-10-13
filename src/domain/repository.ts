import type { ContentSafetyAssessment } from "./security.js";

export type RepositoryKind = "local-folder";

export type SourceLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "java"
  | "json"
  | "markdown"
  | "css"
  | "html"
  | "yaml"
  | "shell"
  | "unknown";

export interface RepositoryDescriptor {
  readonly id: string;
  readonly kind: RepositoryKind;
  readonly name: string;
  readonly rootPath: string;
}

export interface RepositoryFile {
  readonly relativePath: string;
  readonly language: SourceLanguage;
  readonly content: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly safety: ContentSafetyAssessment;
}

export interface RepositoryScanStats {
  readonly filesLoaded: number;
  readonly bytesLoaded: number;
  readonly ignoredEntries: number;
  readonly skippedBinaryFiles: number;
  readonly skippedOversizedFiles: number;
  readonly skippedUnreadableFiles: number;
  readonly skippedSymlinks: number;
  readonly safetyBlockedFiles: number;
}

export type RepositoryExclusionReason =
  /** File name matches a built-in credential pattern; the file was never read. */
  | "sensitive-path"
  /** `.gitignore`, `.conclaveignore`, or a built-in build-output rule. */
  | "ignored"
  | "symlink"
  | "binary"
  | "oversized"
  | "unreadable";

/** An entry the source saw but did not load. An ignored directory is one entry ending in `/`. */
export interface RepositoryExclusion {
  readonly relativePath: string;
  readonly reason: RepositoryExclusionReason;
}

export interface RepositorySnapshot {
  readonly repository: RepositoryDescriptor;
  readonly files: readonly RepositoryFile[];
  readonly scannedAt: string;
  readonly stats: RepositoryScanStats;
  /** Absent when a source does not record what it skipped; absence is not an empty list. */
  readonly exclusions?: readonly RepositoryExclusion[];
}

export interface LoadRepositoryRequest {
  readonly path: string;
}

export interface RepositorySource {
  load(request: LoadRepositoryRequest): Promise<RepositorySnapshot>;
}

export interface EvidenceReference {
  readonly repositoryId: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
  readonly excerpt?: string;
}
