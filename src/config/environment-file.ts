import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { userPreferencesPath } from "./user-preferences.js";

const START = "# >>> Conclave CLI configuration >>>";
const END = "# <<< Conclave CLI configuration <<<";
const KEY_PATTERN = /^CONCLAVE_[A-Z0-9_]+$/;

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export interface EnvironmentFileLoadResult {
  readonly path: string;
  readonly loadedKeys: readonly string[];
  /**
   * Keys the file defines more than once. The last definition silently wins, so an earlier
   * block that still looks active is the usual cause of a provider that will not switch.
   */
  readonly duplicateKeys: readonly string[];
}

export interface EnvironmentFileWriteResult {
  readonly path: string;
  readonly updated: boolean;
}

function decodeValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(trimmed);
      if (typeof decoded === "string") return decoded;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  const comment = trimmed.search(/\s#/);
  return (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim();
}

function entries(content: string): {
  readonly values: ReadonlyMap<string, string>;
  readonly duplicates: readonly string[];
} {
  const parsed = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    if (!KEY_PATTERN.test(match[1])) continue;
    if (parsed.has(match[1])) duplicates.add(match[1]);
    parsed.set(match[1], decodeValue(match[2]));
  }
  return { values: parsed, duplicates: [...duplicates].sort() };
}

/** Loads only CONCLAVE_* values, never overwriting values supplied by the process. */
export function loadConclaveEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  path = resolve(".env"),
): EnvironmentFileLoadResult {
  const resolvedPath = resolve(path);
  let content: string;
  try {
    content = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { path: resolvedPath, loadedKeys: [], duplicateKeys: [] };
    throw error;
  }
  const loadedKeys: string[] = [];
  const { values, duplicates } = entries(content);
  for (const [key, value] of values) {
    if (environment[key] !== undefined) continue;
    environment[key] = value;
    loadedKeys.push(key);
  }
  return { path: resolvedPath, loadedKeys, duplicateKeys: duplicates };
}

/**
 * The per-user credentials file lives next to the global preferences, so a globally installed
 * CLI keeps working in every repository without a project `.env`.
 */
export function globalEnvironmentPath(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(dirname(userPreferencesPath(environment)), "credentials.env");
}

/** Reads every CONCLAVE_* value a file defines, without touching the process environment. */
export function readConclaveEnvironmentFile(path: string): ReadonlyMap<string, string> {
  try {
    return entries(readFileSync(resolve(path), "utf8")).values;
  } catch (error) {
    if (isMissingFile(error)) return new Map();
    throw error;
  }
}

/** A project `.env` that already defines Conclave keys wins; otherwise settings are per-user. */
export function activeEnvironmentPath(
  projectPath = resolve(".env"),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return readConclaveEnvironmentFile(projectPath).size > 0 ? resolve(projectPath) : globalEnvironmentPath(environment);
}

function ensureSafeEntry(key: string, value: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error(`Refusing to write a non-Conclave environment key: ${key}`);
  if (value.includes("\u0000") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`Refusing to write a multiline value for ${key}`);
  }
}

function configurationBlock(values: Readonly<Record<string, string>>): string {
  const lines = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      ensureSafeEntry(key, value);
      return `${key}=${JSON.stringify(value)}`;
    });
  return [START, "# Managed by `conclave init` and `conclave config`. Keep this file out of Git.", ...lines, END].join("\n");
}

/** Replaces only the managed block so unrelated local variables and comments survive setup reruns. */
export async function writeConclaveEnvironment(
  path: string,
  values: Readonly<Record<string, string>>,
): Promise<EnvironmentFileWriteResult> {
  const resolvedPath = resolve(path);
  let existing: string;
  try {
    existing = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    existing = "";
  }
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  const duplicateStart = start === -1 ? -1 : existing.indexOf(START, start + START.length);
  const duplicateEnd = end === -1 ? -1 : existing.indexOf(END, end + END.length);
  if (
    (start === -1) !== (end === -1) ||
    (start !== -1 && end < start) ||
    duplicateStart !== -1 ||
    duplicateEnd !== -1
  ) {
    throw new Error(`Refusing to modify malformed Conclave configuration markers in ${resolvedPath}`);
  }
  const block = configurationBlock(values);
  const next = start === -1
    ? `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${block}\n`
    : `${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`;
  if (next !== existing) {
    await mkdir(dirname(resolvedPath), { recursive: true, mode: 0o700 });
    await writeFile(resolvedPath, next, { encoding: "utf8", mode: 0o600 });
  }
  await chmod(resolvedPath, 0o600);
  return { path: resolvedPath, updated: next !== existing };
}

function managedBlockValues(content: string): Map<string, string> {
  const start = content.indexOf(START);
  const end = content.indexOf(END);
  if (start === -1 || end === -1 || end < start) return new Map();
  return new Map(entries(content.slice(start, end)).values);
}

/**
 * Merges changes into the managed block: a string sets a key, `undefined` removes it. Keys the
 * block does not mention are kept, so the CLI and the cockpit can edit settings independently.
 */
export async function updateConclaveEnvironment(
  path: string,
  changes: Readonly<Record<string, string | undefined>>,
): Promise<EnvironmentFileWriteResult> {
  let existing = "";
  try {
    existing = await readFile(resolve(path), "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const values = managedBlockValues(existing);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) values.delete(key);
    else values.set(key, value);
  }
  return writeConclaveEnvironment(path, Object.fromEntries(values));
}
