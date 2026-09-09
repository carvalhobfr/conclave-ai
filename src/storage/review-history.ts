import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { PullRequestSummary } from "../domain/pr-summary.js";
import type { ReviewHandoff } from "../domain/review-handoff.js";
import type { ValidationReport } from "../domain/validation.js";

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

export async function saveReviewHistory(
  repositoryRoot: string,
  record: ReviewHistoryRecord,
): Promise<void> {
  const destination = historyPath(repositoryRoot);
  const directory = resolve(destination, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const records = [record, ...(await readHistory(repositoryRoot))]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, HISTORY_LIMIT);
  const temporary = destination + ".tmp-" + String(process.pid);
  await writeFile(temporary, JSON.stringify(records, undefined, 2) + "\n", { mode: 0o600 });
  await rename(temporary, destination);
}

export async function listReviewHistory(repositoryRoot: string): Promise<readonly ReviewHistoryRecord[]> {
  return readHistory(repositoryRoot);
}
