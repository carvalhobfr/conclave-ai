#!/usr/bin/env node
// Bumps the package version and every pinned `conclave-ai@x.y.z` reference in one step.
// Usage: node scripts/bump-version.mjs <patch|minor|major|x.y.z> ["changelog line (en)"] ["linha do changelog (pt-BR)"]
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [requested, noteEn, notePt] = process.argv.slice(2);
if (requested === undefined) {
  console.error("Usage: node scripts/bump-version.mjs <patch|minor|major|x.y.z> [\"note en\"] [\"nota pt-BR\"]");
  process.exit(1);
}

const packagePath = resolve(root, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const current = packageJson.version;
const [major, minor, patch] = current.split(".").map(Number);
const next = requested === "patch" ? `${major}.${minor}.${patch + 1}`
  : requested === "minor" ? `${major}.${minor + 1}.0`
  : requested === "major" ? `${major + 1}.0.0`
  : requested;
if (!/^\d+\.\d+\.\d+$/u.test(next)) {
  console.error(`Invalid version: ${next}`);
  process.exit(1);
}

async function replaceIn(path, transform) {
  const absolute = resolve(root, path);
  const before = await readFile(absolute, "utf8");
  const after = transform(before);
  if (after !== before) await writeFile(absolute, after);
}

packageJson.version = next;
await writeFile(packagePath, `${JSON.stringify(packageJson, undefined, 2)}\n`);

const lockPath = resolve(root, "package-lock.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
lock.version = next;
if (lock.packages?.[""] !== undefined) lock.packages[""].version = next;
await writeFile(lockPath, `${JSON.stringify(lock, undefined, 2)}\n`);

const pinned = [
  "skills/conclave-validate/scripts/run-validation.mjs",
  ".agents/skills/conclave-validate/scripts/run-validation.mjs",
  ".claude/skills/conclave-validate/scripts/run-validation.mjs",
  "examples/github-actions/conclave-review.yml",
];
for (const path of pinned) {
  await replaceIn(path, (text) => text.replaceAll(/conclave-ai@\d+\.\d+\.\d+/gu, `conclave-ai@${next}`));
}

const date = new Date().toISOString().slice(0, 10);
for (const [path, note] of [["CHANGELOG.md", noteEn], ["CHANGELOG.pt-BR.md", notePt ?? noteEn]]) {
  if (note === undefined) continue;
  await replaceIn(path, (text) => {
    const index = text.indexOf("\n## [");
    const entry = `\n## [${next}] — ${date}\n\n- ${note}\n`;
    return index === -1 ? `${text}${entry}` : `${text.slice(0, index)}${entry}${text.slice(index)}`;
  });
}

console.log(`conclave-ai ${current} → ${next}`);
