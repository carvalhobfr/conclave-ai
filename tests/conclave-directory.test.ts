import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureConclaveDirectory } from "../src/storage/conclave-directory.js";

describe(".conclave directory", () => {
  it("ignores itself so its cache never appears as untracked", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "conclave-dir-")), ".conclave");
    await ensureConclaveDirectory(directory);
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toMatch(/^\*$/mu);
  });

  it("keeps an existing .gitignore the user edited", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "conclave-dir-")), ".conclave");
    await ensureConclaveDirectory(directory);
    await writeFile(join(directory, ".gitignore"), "custom\n");
    await ensureConclaveDirectory(directory);
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toBe("custom\n");
  });
});
