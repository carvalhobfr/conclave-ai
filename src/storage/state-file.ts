import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { ensureConclaveDirectory } from "./conclave-directory.js";

const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const STRAY_TEMPORARY_MS = 60_000;
const BACKUP_SUFFIX = ".bak";

/**
 * Serialises read-modify-write across processes (CLI, cockpit, agent skill). The lock is a
 * directory, because creating one is atomic on every supported filesystem. A lock left by a
 * crashed process is reclaimed once it is clearly stale.
 */
export async function withFileLock<T>(lock: string, busyMessage: string, action: () => Promise<T>): Promise<T> {
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
      if (Date.now() > deadline) throw new Error(busyMessage, { cause: error });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * A directory under the repository's `.conclave`, created if missing. Refuses a `.conclave` or
 * a subdirectory that is a symbolic link, so local state can never be redirected outside the
 * repository by something the repository itself contains.
 */
export async function conclaveStateDirectory(repositoryRoot: string, ...segments: readonly string[]): Promise<string> {
  let directory = join(await realpath(repositoryRoot), ".conclave");
  for (const segment of ["", ...segments]) {
    if (segment !== "") directory = join(directory, segment);
    await ensureConclaveDirectory(directory);
    if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Conclave state directory must not be a symbolic link: ${directory}`);
  }
  return directory;
}

/** The same directory when it already exists, without creating anything; `undefined` otherwise. */
export async function existingStateDirectory(repositoryRoot: string, ...segments: readonly string[]): Promise<string | undefined> {
  let directory = join(await realpath(repositoryRoot), ".conclave");
  for (const segment of ["", ...segments]) {
    if (segment !== "") directory = join(directory, segment);
    const details = await lstat(directory).catch(() => undefined);
    if (details === undefined) return undefined;
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`Conclave state directory must be a real directory: ${directory}`);
  }
  return directory;
}

async function parseFile(path: string): Promise<{ readonly value: unknown } | undefined> {
  let text: string;
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Conclave state file must not be a symbolic link: ${path}`);
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return { value: JSON.parse(text) as unknown };
}

export interface StateRead {
  readonly value: unknown;
  /** True when the main file was unreadable and the previous version was used instead. */
  readonly recovered: boolean;
}

/**
 * Reads a state file written by `writeStateFile`. A file that does not parse (a write cut short
 * by something other than this module, a manual edit) falls back to the previous version kept
 * beside it. When neither parses the call fails: state is never silently replaced by nothing.
 */
export async function readStateFile(path: string): Promise<StateRead | undefined> {
  try {
    const main = await parseFile(path);
    if (main !== undefined) return { value: main.value, recovered: false };
    return undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const backup = await parseFile(path + BACKUP_SUFFIX).catch(() => undefined);
    if (backup !== undefined) return { value: backup.value, recovered: true };
    throw new Error(`${basename(path)} is corrupt and no readable previous version exists. Move it aside to start over: ${path}`, { cause: error });
  }
}

/**
 * Replaces a state file atomically: the new content is written and flushed to a temporary file
 * in the same directory and then renamed over the target, so a reader sees the old file or the
 * new one and never a partial write. With `backup`, the last readable version is kept as
 * `<file>.bak` for `readStateFile` to fall back to.
 */
export async function writeStateFile(path: string, value: unknown, options: { readonly backup?: boolean } = {}): Promise<void> {
  const directory = dirname(path);
  const name = basename(path);
  const temporary = join(directory, `${name}.tmp-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Only a version that still parses is worth keeping as the fallback.
  if (options.backup === true && await parseFile(path).then((parsed) => parsed !== undefined, () => false)) await copyFile(path, path + BACKUP_SUFFIX);
  await rename(temporary, path);
  // Temporary files left by an interrupted write are never read; remove the old ones.
  for (const entry of await readdir(directory).catch(() => [])) {
    if (!entry.startsWith(`${name}.tmp-`)) continue;
    const stray = join(directory, entry);
    const age = await stat(stray).then((details) => Date.now() - details.mtimeMs, () => 0);
    if (age > STRAY_TEMPORARY_MS) await rm(stray, { force: true });
  }
}
