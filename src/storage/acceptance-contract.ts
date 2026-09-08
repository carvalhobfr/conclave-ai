import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidationContract } from "../domain/validation.js";
import { parseValidationContract } from "../validation/contract-parser.js";
import { validationDigest } from "../validation/review-lineage.js";

export interface SavedAcceptanceContract { readonly revision: string; readonly contract: ValidationContract }

async function location(root: string): Promise<string> {
  const canonical = await realpath(root);
  const directory = join(canonical, ".conclave");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error("Acceptance storage must be inside the repository, without symlinks");
  const path = join(directory, "acceptance-contract.json");
  const details = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (details?.isSymbolicLink()) throw new Error("Acceptance contract must not be a symlink");
  return path;
}

export async function loadAcceptanceContract(root: string): Promise<SavedAcceptanceContract | null> {
  const path = await location(root);
  try {
    const contract = parseValidationContract(JSON.parse(await readFile(path, "utf8")));
    return { revision: validationDigest("contract", contract), contract };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveAcceptanceContract(root: string, value: unknown, expectedRevision: string | null): Promise<SavedAcceptanceContract> {
  const contract = parseValidationContract(value);
  const path = await location(root);
  const lock = path + ".lock";
  await mkdir(lock).catch(() => { throw new Error("Acceptance contract is being saved; retry after the other save completes"); });
  const temporary = path + "." + randomUUID();
  try {
    const previous = await loadAcceptanceContract(root);
    if ((previous?.revision ?? null) !== expectedRevision) throw new Error("Acceptance contract changed elsewhere. Reload before saving.");
    await writeFile(temporary, JSON.stringify(contract, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    return { contract, revision: validationDigest("contract", contract) };
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
