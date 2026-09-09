import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ValidationReport } from "../domain/validation.js";

export interface FindingFeedback { readonly id: string; readonly reviewId: string; readonly reportDigest: string; readonly fingerprint: string; readonly classification: "confirmed" | "false-positive" | "accepted-risk"; readonly note: string; readonly createdAt: string }
async function pathFor(root: string): Promise<string> {
  const canonical = await realpath(root); const directory = join(canonical, ".conclave");
  await mkdir(directory, { recursive: true, mode: 0o700 });
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
