import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { PullRequestSummary } from "../domain/pr-summary.js";
import type { ReviewHandoff } from "../domain/review-handoff.js";
import type { ValidationReport } from "../domain/validation.js";
import { ensureConclaveDirectory } from "./conclave-directory.js";

export interface ReviewHistoryRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly repository: string;
  readonly objective: string;
  readonly headSha: string;
  readonly summary: PullRequestSummary;
  readonly report?: ValidationReport;
  readonly handoff?: ReviewHandoff;
}

const HISTORY_LIMIT = 50;

function historyPath(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), ".conclave", "review-history.json");
}

async function readHistory(repositoryRoot: string): Promise<ReviewHistoryRecord[]> {
  try {
    const value: unknown = JSON.parse(await readFile(historyPath(repositoryRoot), "utf8"));
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ReviewHistoryRecord =>
      typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string",
    ).map((item) => {
      const reportVersion = (item as { report?: { schemaVersion?: unknown } }).report?.schemaVersion;
      if (reportVersion === undefined || reportVersion === 2 || reportVersion === 3 || reportVersion === 4 || reportVersion === 5) return item;
      return Object.fromEntries(
        Object.entries(item).filter(([key]) => key !== "report"),
      ) as unknown as ReviewHistoryRecord;
    });
  } catch {
    return [];
  }
}

const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

/**
 * Serialises read-append-write across processes (CLI, cockpit, agent skill) so concurrent reviews
 * of one repository do not overwrite each other's entries. A lock left by a crashed process is
 * reclaimed once it is clearly stale.
 */
async function withHistoryLock<T>(lock: string, action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then((details) => Date.now() - details.mtimeMs, () => 0);
      if (age > STALE_LOCK_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("Review history is busy; another review is still saving. Retry in a moment.", { cause: error });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function saveReviewHistory(
  repositoryRoot: string,
  record: ReviewHistoryRecord,
): Promise<void> {
  const destination = historyPath(repositoryRoot);
  const directory = resolve(destination, "..");
  await ensureConclaveDirectory(directory);
  await withHistoryLock(destination + ".lock", async () => {
    const records = [record, ...(await readHistory(repositoryRoot))]
      .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
      .slice(0, HISTORY_LIMIT);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(records, undefined, 2) + "\n", { mode: 0o600 });
    await rename(temporary, destination);
  });
}

export async function listReviewHistory(repositoryRoot: string): Promise<readonly ReviewHistoryRecord[]> {
  return readHistory(repositoryRoot);
}
