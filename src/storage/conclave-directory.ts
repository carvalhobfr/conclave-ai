import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GITIGNORE = "# Created by Conclave: local code map, review history, and criteria. Not meant for Git.\n*\n";

/**
 * Creates a repository's `.conclave` directory with a self-ignoring `.gitignore`, so its cache
 * and history never show up as untracked files or get committed, without editing the
 * repository's own ignore rules.
 */
export async function ensureConclaveDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, ".gitignore"), GITIGNORE, { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return;
    throw error;
  });
}
