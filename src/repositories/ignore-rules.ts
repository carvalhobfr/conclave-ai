import { readFile } from "node:fs/promises";
import { join } from "node:path";

import createIgnore, { type Ignore } from "ignore";

/**
 * File names that conventionally hold credentials. They are never read. Kept apart from the
 * structural defaults so an exclusion can be reported as a safety exclusion, not as build output.
 */
export const SENSITIVE_PATH_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "!.env.example",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
  "credentials*.json",
  "secrets*.json",
];

export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".cache/",
  ".parcel-cache/",
  ".turbo/",
  ".conclave/",
  "*.min.js",
  "*.map",
  ...SENSITIVE_PATH_PATTERNS,
];

const sensitivePaths = createIgnore().add(SENSITIVE_PATH_PATTERNS);

/**
 * Whether a path matches a built-in credential file-name pattern. This classifies an entry the
 * repository matcher already ignored; it never decides on its own whether a file is read.
 */
export function isSensitivePath(relativePath: string): boolean {
  return sensitivePaths.ignores(relativePath);
}

async function readOptionalIgnoreFile(rootPath: string, filename: string): Promise<string | undefined> {
  try {
    return await readFile(join(rootPath, filename), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function createRepositoryIgnore(rootPath: string): Promise<Ignore> {
  const matcher = createIgnore().add(DEFAULT_IGNORE_PATTERNS);
  const [gitignore, conclaveignore] = await Promise.all([
    readOptionalIgnoreFile(rootPath, ".gitignore"),
    readOptionalIgnoreFile(rootPath, ".conclaveignore"),
  ]);

  if (gitignore !== undefined) {
    matcher.add(gitignore);
  }
  if (conclaveignore !== undefined) {
    matcher.add(conclaveignore);
  }

  return matcher;
}
