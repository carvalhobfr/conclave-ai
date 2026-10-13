import { randomUUID } from "node:crypto";
import { appendFile, lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { FindingDisposition, TriageActor } from "../domain/finding-ledger.js";
import type { ValidationReport } from "../domain/validation.js";
import { redactSecrets } from "../security/model-context.js";
import { ensureConclaveDirectory } from "./conclave-directory.js";

/**
 * One human classification of one finding, appended to `.conclave/finding-feedback.jsonl`.
 * The log is the durable record for review findings and audit findings alike. For a review
 * finding `reviewId` and `reportDigest` name the saved review; for an audit finding (`origin:
 * "audit"`) they hold the audit run id and the snapshot id.
 */
export interface FindingFeedback { readonly id: string; readonly reviewId: string; readonly reportDigest: string; readonly fingerprint: string; readonly classification: FindingDisposition; readonly note: string; readonly createdAt: string; readonly origin?: "audit"; readonly actor?: TriageActor }
async function pathFor(root: string): Promise<string> {
  const canonical = await realpath(root); const directory = join(canonical, ".conclave");
  await ensureConclaveDirectory(directory);
  if (await realpath(directory) !== directory) throw new Error("Feedback directory must not be a symlink");
  const path = join(directory, "finding-feedback.jsonl");
  const details = await lstat(path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  if (details?.isSymbolicLink()) throw new Error("Feedback file must not be a symlink");
  if ((details?.size ?? 0) > 1_000_000) throw new Error("Feedback log exceeds 1 MB; archive it before adding more");
  return path;
}
export async function listFindingFeedback(root: string): Promise<readonly FindingFeedback[]> {
  const path = await pathFor(root);
  try { return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as FindingFeedback); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export async function recordFindingFeedback(root: string, report: ValidationReport, value: unknown): Promise<FindingFeedback> {
  const input = value as Partial<FindingFeedback> | null;
  if (input === null || typeof input.fingerprint !== "string" || !report.findings.some((item) => item.fingerprint === input.fingerprint) || !["confirmed", "false-positive", "accepted-risk"].includes(input.classification ?? "") || typeof input.note !== "string" || !input.note.trim() || input.note.length > 1000) throw new Error("Feedback requires a finding in the saved report, a classification and a note of 1–1000 characters");
  const record: FindingFeedback = { id: randomUUID(), reviewId: report.lineage.reviewId, reportDigest: report.lineage.reportDigest, fingerprint: input.fingerprint, classification: input.classification as FindingFeedback["classification"], note: input.note.trim(), createdAt: new Date().toISOString() };
  await appendFile(await pathFor(root), JSON.stringify(record) + "\n", { mode: 0o600 });
  return record;
}

const AUDIT_CLASSIFICATIONS: readonly FindingDisposition[] = ["unreviewed", "confirmed", "false-positive", "accepted-risk", "needs-investigation"];
/** Dismissing a finding, or accepting its risk, is a decision someone must be able to audit later. */
const NOTE_REQUIRED: readonly FindingDisposition[] = ["false-positive", "accepted-risk"];

export interface AuditFeedbackInput { readonly classification: FindingDisposition; readonly note?: string; readonly actor: TriageActor }

/** A note is free text typed by a person; it must not become a place where a credential is stored. */
export function sanitizeTriageText(value: string, label: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, " ").trim();
  if (text.length > max) throw new Error(`${label} must be at most ${String(max)} characters`);
  const scan = redactSecrets(text);
  if (scan.residual || Object.keys(scan.redactions).length > 0) throw new Error(`${label} matched a credential detector. Remove the value; it would be stored on disk.`);
  return text;
}

/** Appends a classification of an audit finding. The caller has already resolved the finding in the ledger. */
export async function recordAuditFindingFeedback(root: string, target: { readonly fingerprint: string; readonly runId: string; readonly snapshot: string }, input: AuditFeedbackInput): Promise<FindingFeedback> {
  if (!AUDIT_CLASSIFICATIONS.includes(input.classification)) throw new Error(`Classification must be one of: ${AUDIT_CLASSIFICATIONS.join(", ")}`);
  const note = sanitizeTriageText(input.note ?? "", "Note", 1000);
  if (note === "" && NOTE_REQUIRED.includes(input.classification)) throw new Error(`Classifying a finding as ${input.classification} requires a note explaining why`);
  const actor: TriageActor = { kind: input.actor.kind, ...(input.actor.name === undefined ? {} : { name: sanitizeTriageText(input.actor.name, "Actor name", 100) }) };
  const record: FindingFeedback = { id: randomUUID(), reviewId: target.runId, reportDigest: target.snapshot, fingerprint: target.fingerprint, classification: input.classification, note, createdAt: new Date().toISOString(), origin: "audit", actor };
  await appendFile(await pathFor(root), JSON.stringify(record) + "\n", { mode: 0o600 });
  return record;
}

/** The latest audit classification per fingerprint, for rebuilding dispositions from the log. */
export async function latestAuditFeedback(root: string): Promise<ReadonlyMap<string, FindingFeedback>> {
  const latest = new Map<string, FindingFeedback>();
  for (const record of await listFindingFeedback(root)) {
    if (record.origin !== "audit" || typeof record.fingerprint !== "string") continue;
    const known = latest.get(record.fingerprint);
    if (known === undefined || known.createdAt <= record.createdAt) latest.set(record.fingerprint, record);
  }
  return latest;
}
