import type { IndexedFile, RepositoryCodeIndex } from "../domain/code-index.js";
import type { SourceLanguage } from "../domain/repository.js";
import type { ChangedLineRange, ValidationChangedFile, ValidationEvidence } from "../domain/validation.js";

/**
 * What an analysis looks at.
 *
 * `change`: the files and lines a Git change touches. This is pull-request review.
 * `repository`: every indexed file of one repository snapshot, whether or not anything changed.
 */
export type AnalysisScope = "change" | "repository";

/**
 * One indexed file in scope. `changedRanges` narrows a rule to the lines a change touched and
 * exists only in change scope; a file without it is examined whole. A repository audit never
 * fabricates ranges: its files simply have none.
 */
export interface AnalysisFile {
  readonly path: string;
  readonly changedRanges?: readonly ChangedLineRange[];
}

export type RuleCategory = "parse" | "reliability" | "correctness" | "structure";

/** A place where a rule's pattern matched. A match is an observation, not a confirmed defect. */
export interface RuleMatch {
  readonly ruleId: string;
  readonly title: string;
  readonly detail: string;
  readonly remediation: string;
  /** The first item is the primary location. */
  readonly evidence: readonly ValidationEvidence[];
  /** Position among all matches of the same file, so callers can keep source order across rules. */
  readonly sequence: number;
}

export interface RuleResult {
  readonly matches: readonly RuleMatch[];
  /** Files the rule actually examined; a rule that examined nothing proves nothing. */
  readonly filesExamined: readonly string[];
}

export interface AnalysisRule {
  /** Stable across releases; part of every finding's identity. */
  readonly id: string;
  readonly category: RuleCategory;
  readonly languages: readonly SourceLanguage[];
  readonly scopes: readonly AnalysisScope[];
  /** What a match, or the absence of one, does not establish. */
  readonly limitation: string;
  run(context: AnalysisContext): RuleResult;
}

/** Everything a rule may read. Rules never touch the filesystem, the network or a model. */
export class AnalysisContext {
  public readonly scope: AnalysisScope;
  public readonly index: RepositoryCodeIndex;
  public readonly files: readonly AnalysisFile[];
  readonly #memo = new Map<string, unknown>();

  public constructor(scope: AnalysisScope, index: RepositoryCodeIndex, files: readonly AnalysisFile[]) {
    this.scope = scope;
    this.index = index;
    this.files = files;
  }

  /** Files in scope that a rule for these languages applies to, with their indexed content. */
  public filesFor(languages: readonly SourceLanguage[]): readonly { readonly file: AnalysisFile; readonly indexed: IndexedFile }[] {
    return this.files.flatMap((file) => {
      const indexed = this.index.files[file.path];
      return indexed !== undefined && languages.includes(indexed.language) ? [{ file, indexed }] : [];
    });
  }

  /** Per-run cache so several rules can share one parse or one derived structure. */
  public memo<T>(key: string, compute: () => T): T {
    if (!this.#memo.has(key)) this.#memo.set(key, compute());
    return this.#memo.get(key) as T;
  }
}

/** Change scope: the changed files that still exist in the index. Added files are examined whole. */
export function changeScopeFiles(index: RepositoryCodeIndex, files: readonly ValidationChangedFile[]): readonly AnalysisFile[] {
  return files
    .filter((file) => file.status !== "deleted" && Object.hasOwn(index.files, file.path))
    .map((file) => (file.status === "added" ? { path: file.path } : { path: file.path, changedRanges: file.hunks }));
}

/** Repository scope: every indexed file of the snapshot, in path order. */
export function repositoryScopeFiles(index: RepositoryCodeIndex): readonly AnalysisFile[] {
  return Object.keys(index.files).sort((left, right) => left.localeCompare(right)).map((path) => ({ path }));
}
