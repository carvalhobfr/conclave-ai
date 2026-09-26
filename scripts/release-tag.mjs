#!/usr/bin/env node
// Tags the committed package.json version and pushes the commit and tag. The tag push triggers
// .github/workflows/publish.yml, which publishes to npm through trusted publishing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = `v${version}`;

if (run("git", ["status", "--porcelain"]) !== "") {
  console.error("Commit or stash your changes first; the tag must point at the released commit.");
  process.exit(1);
}
if (run("git", ["tag", "--list", tag]) !== "") {
  console.error(`${tag} already exists. Run \`npm run release:bump -- patch "…"\` for a new version.`);
  process.exit(1);
}
run("git", ["tag", "-a", tag, "-m", `conclave-ai ${version}`]);
execFileSync("git", ["push", "--follow-tags"], { stdio: "inherit" });
console.log(`Pushed ${tag}. Follow the publish run: https://github.com/carvalhobfr/conclave-ai/actions/workflows/publish.yml`);
