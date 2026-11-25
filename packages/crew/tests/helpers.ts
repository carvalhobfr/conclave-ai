import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false"];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });
}

/** A throwaway repository with one commit on main. */
export function temporaryRepository(files: Record<string, string> = { "math.js": "export function add(a, b) {\n  return a + b;\n}\n" }): { path: string; cleanup: () => void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "crew-test-")));
  git(path, "init", "--quiet", "-b", "main");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content);
  git(path, "add", "--all");
  git(path, "commit", "--quiet", "-m", "base");
  return { path, cleanup: () => { rmSync(path, { recursive: true, force: true }); } };
}
