import { join } from "node:path";

import { LEDGER_FINGERPRINT_SCHEME, LEDGER_SCHEMA_VERSION, type FindingLedger } from "../domain/finding-ledger.js";
import { PROPOSAL_SCHEMA_VERSION, type IssueProposalStore } from "../domain/issue-proposal.js";
import { conclaveStateDirectory, existingStateDirectory, readStateFile, withFileLock, writeStateFile } from "./state-file.js";

/**
 * Local triage state of one repository, under its `.conclave` directory (ignored by Git and by
 * audits):
 *
 *   .conclave/findings/ledger.json    every finding audits have observed, with its lifecycle
 *   .conclave/issues/proposals.json   issue proposals and their approvals
 *
 * Plain JSON files: the data is one repository's findings, read and rewritten whole a few times
 * per session, which needs neither queries nor concurrent writers beyond a lock.
 */
export const LEDGER_DIRECTORY = "findings";
export const LEDGER_FILENAME = "ledger.json";
export const PROPOSALS_DIRECTORY = "issues";
export const PROPOSALS_FILENAME = "proposals.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Schema-version rule shared by both files: the current version is read as is; a newer one is
 * refused rather than rewritten by a release that would drop what it does not understand; an
 * older one would be migrated here, one version at a time (none exists yet).
 */
function assertVersion(value: unknown, current: number, name: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || typeof value["schemaVersion"] !== "number") throw new Error(`${name} is not a Conclave state file. Move it aside to start over.`);
  if (value["schemaVersion"] > current) throw new Error(`${name} was written by a newer Conclave (schema ${String(value["schemaVersion"])}; this release reads ${String(current)}). Update Conclave; the file was left untouched.`);
  if (value["schemaVersion"] !== current) throw new Error(`${name} has unsupported schema ${String(value["schemaVersion"])}. Move it aside to start over.`);
}

export interface LoadedState<T> {
  readonly value: T | undefined;
  /** True when the file was unreadable and its previous version was used. */
  readonly recovered: boolean;
}

async function load<T>(path: string, name: string, validate: (value: Record<string, unknown>) => void, version: number): Promise<LoadedState<T>> {
  const read = await readStateFile(path);
  if (read === undefined) return { value: undefined, recovered: false };
  assertVersion(read.value, version, name);
  validate(read.value);
  return { value: read.value as unknown as T, recovered: read.recovered };
}

/** Reading never creates anything: a repository that was never audited stays untouched. */
export async function loadFindingLedger(repositoryRoot: string): Promise<LoadedState<FindingLedger>> {
  const directory = await existingStateDirectory(repositoryRoot, LEDGER_DIRECTORY);
  if (directory === undefined) return { value: undefined, recovered: false };
  return load<FindingLedger>(join(directory, LEDGER_FILENAME), LEDGER_FILENAME, (value) => {
    if (value["fingerprintScheme"] !== LEDGER_FINGERPRINT_SCHEME) throw new Error(`${LEDGER_FILENAME} uses fingerprint scheme ${JSON.stringify(value["fingerprintScheme"])}; this release uses ${LEDGER_FINGERPRINT_SCHEME} and has no migration for it.`);
    if (!isRecord(value["findings"]) || !Array.isArray(value["runs"]) || !isRecord(value["repository"])) throw new Error(`${LEDGER_FILENAME} is malformed. Move it aside to start over.`);
  }, LEDGER_SCHEMA_VERSION);
}

export async function saveFindingLedger(repositoryRoot: string, ledger: FindingLedger): Promise<void> {
  const directory = await conclaveStateDirectory(repositoryRoot, LEDGER_DIRECTORY);
  await writeStateFile(join(directory, LEDGER_FILENAME), ledger, { backup: true });
}

export async function loadIssueProposals(repositoryRoot: string): Promise<LoadedState<IssueProposalStore>> {
  const directory = await existingStateDirectory(repositoryRoot, PROPOSALS_DIRECTORY);
  if (directory === undefined) return { value: undefined, recovered: false };
  return load<IssueProposalStore>(join(directory, PROPOSALS_FILENAME), PROPOSALS_FILENAME, (value) => {
    if (!isRecord(value["proposals"])) throw new Error(`${PROPOSALS_FILENAME} is malformed. Move it aside to start over.`);
  }, PROPOSAL_SCHEMA_VERSION);
}

export async function saveIssueProposals(repositoryRoot: string, store: IssueProposalStore): Promise<void> {
  const directory = await conclaveStateDirectory(repositoryRoot, PROPOSALS_DIRECTORY);
  await writeStateFile(join(directory, PROPOSALS_FILENAME), store, { backup: true });
}

/** One lock for ledger and proposals: several operations read one and write the other. */
export async function withTriageLock<T>(repositoryRoot: string, action: () => Promise<T>): Promise<T> {
  const directory = await conclaveStateDirectory(repositoryRoot);
  return withFileLock(join(directory, "triage.lock"), "Conclave triage state is busy; another command is still saving. Retry in a moment.", action);
}
