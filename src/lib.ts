// Small public API: review a change, ask about a repository, hand findings back to an agent.
// Everything else in `src/` is internal. Provider settings come from process.env (same keys as the CLI).
import { auditRepository } from "./analysis/repository-audit.js";
import type { AuditReport } from "./domain/audit.js";
import { resolve } from "node:path";
import { MultiLanguageCodeParser } from "./code-intelligence/multi-language-parser.js";
import { loadReasoningConfiguration } from "./config/reasoning-config.js";
import { loadRuntimeConfig } from "./config/runtime-config.js";
import { DEFAULT_REASONING_LIMITS, type ReasoningResult } from "./domain/reasoning.js";
import type { ChangeSource, ValidationReport } from "./domain/validation.js";
import { createPullRequestSummary, type PullRequestSummary } from "./domain/pr-summary.js";
import { createReviewHandoff, type ReviewHandoff } from "./domain/review-handoff.js";
import { createEmbeddingProvider } from "./embeddings/embedding-factory.js";
import { FileSystemCodeIndexStore } from "./indexing/file-system-index-store.js";
import { RepositoryIndexer } from "./indexing/repository-indexer.js";
import { createRoleProviders } from "./providers/provider-factory.js";
import { StructuredAgentRuntime } from "./reasoning/agent-runtime.js";
import { inferReasoningChangeContext } from "./reasoning/change-context.js";
import { ReasoningEngine } from "./reasoning/reasoning-engine.js";
import { LocalFolderRepository } from "./repositories/local-folder-repository.js";
import { CodeRetrievalService } from "./retrieval/code-retrieval-service.js";
import { EnvironmentCredentialSource } from "./storage/environment-credential-source.js";
import { createValidationContract } from "./validation/contract-parser.js";
import { createDeterministicValidationIndex } from "./validation/deterministic-index.js";
import { GitChangeSetService } from "./validation/git-change-set.js";
import { SuperValidator } from "./validation/super-validator.js";
import { inferredReviewObjective, inspectRepository } from "./workflow/repository-inspector.js";

export type { PullRequestSummary, ReviewHandoff, ValidationReport, ChangeSource, ReasoningResult };
export type { AuditFinding, AuditReport } from "./domain/audit.js";

export interface CheckOptions {
  /** Repository folder. Defaults to the current directory. */
  readonly repository?: string;
  /** What the change must deliver. Pass the user's own request when you have it; otherwise it is inferred from the latest commit. */
  readonly objective?: string;
  /** Comparison base for the workspace. Defaults to the detected base branch. */
  readonly base?: string;
}

export interface CheckResult {
  readonly verdict: ValidationReport["verdict"];
  /** True when the objective was derived from the latest commit instead of supplied by the caller. */
  readonly objectiveInferred: boolean;
  readonly summary: PullRequestSummary;
  readonly handoff: ReviewHandoff;
  readonly report: ValidationReport;
}

/** Deterministic review of the current branch plus all local changes. Makes no model call and runs no repository code. */
export async function check(options: CheckOptions = {}): Promise<CheckResult> {
  const root = resolve(options.repository ?? ".");
  const inspection = await inspectRepository(root);
  const supplied = options.objective?.trim() ?? "";
  const objective = supplied === "" ? inferredReviewObjective(inspection) : supplied;
  const source: ChangeSource = { kind: "workspace", base: options.base ?? inspection.defaultBase };
  const service = new GitChangeSetService();
  const changeSet = await service.collect(inspection.root, source);
  const materialized = await service.materializeValidationRoot(inspection.root, source);
  try {
    const indexed = await createDeterministicValidationIndex(materialized.rootPath);
    const report = new SuperValidator().validate(indexed.index, changeSet, createValidationContract(objective), { receipts: [], newSeries: false });
    return {
      verdict: report.verdict,
      objectiveInferred: supplied === "",
      summary: createPullRequestSummary(report),
      handoff: createReviewHandoff(report),
      report,
    };
  } finally {
    await materialized.cleanup();
  }
}

/**
 * Deterministic audit of a whole repository as it is on disk. Makes no model call, runs no
 * repository code and writes nothing unless `write` is set.
 */
export async function audit(options: { readonly repository?: string; readonly write?: boolean } = {}): Promise<AuditReport> {
  return auditRepository(resolve(options.repository ?? "."), { write: options.write === true });
}

/** Correction request for a coding agent, derived from a report. */
export function handoff(report: ValidationReport): ReviewHandoff {
  return createReviewHandoff(report);
}

export interface AskOptions {
  readonly repository?: string;
  /** `investigate` runs the full multi-role route; `ask` (default) uses investigator and judge only. */
  readonly depth?: "ask" | "investigate";
}

/** Answer a question about the repository with the configured provider. Throws if none is configured. */
export async function ask(question: string, options: AskOptions = {}): Promise<ReasoningResult> {
  if (question.trim() === "") throw new Error("ask requires a question");
  const runtimeConfig = loadRuntimeConfig();
  const reasoningConfig = loadReasoningConfiguration(runtimeConfig);
  const credentials = new EnvironmentCredentialSource();
  const providers = createRoleProviders(runtimeConfig, reasoningConfig.assignments, credentials);
  const embeddingProvider = createEmbeddingProvider(process.env, credentials);
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new MultiLanguageCodeParser(),
    embeddingProvider,
    indexStore: new FileSystemCodeIndexStore(),
  }).index(resolve(options.repository ?? "."));
  const retrieval = new CodeRetrievalService(indexed.index, embeddingProvider);
  const changeContext = await inferReasoningChangeContext(indexed.index.repository.rootPath, retrieval);
  return new ReasoningEngine({
    retrieval,
    runtime: new StructuredAgentRuntime(providers, reasoningConfig.assignments, DEFAULT_REASONING_LIMITS),
    preset: reasoningConfig.preset,
    ...(changeContext === undefined ? {} : { changeContext }),
  }).ask(question, options.depth === "investigate" ? "conclave" : "investigator-judge");
}
