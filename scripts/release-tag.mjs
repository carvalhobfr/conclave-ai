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
  // Re-running after a failed publish (for example before trusted publishing was configured)
  // should retry that release, not demand a new version.
  let published = false;
  try { published = run("npm", ["view", `conclave-ai@${version}`, "version"]) === version; } catch { published = false; }
  if (published) {
    console.error(`${tag} is already published. Run \`npm run release:bump -- patch "…"\` for a new version.`);
    process.exit(1);
  }
  // The retry republishes the commit the tag already points at; the tag itself never moves.
  execFileSync("git", ["push", "origin", tag], { stdio: "inherit" });
  let runId = "";
  try {
    runId = run("gh", ["run", "list", "--workflow", "publish.yml", "--branch", tag, "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId // \"\""]);
  } catch {
    console.error(`${tag} is not on npm yet. Retry the publish run: gh workflow run publish.yml --ref ${tag}`);
    process.exit(1);
  }
  if (runId === "") execFileSync("gh", ["workflow", "run", "publish.yml", "--ref", tag], { stdio: "inherit" });
  else execFileSync("gh", ["run", "rerun", runId], { stdio: "inherit" });
  console.log(`Retrying the publish of ${tag}. Follow it: https://github.com/carvalhobfr/conclave-ai/actions/workflows/publish.yml`);
  process.exit(0);
}
run("git", ["tag", "-a", tag, "-m", `conclave-ai ${version}`]);
execFileSync("git", ["push", "--follow-tags"], { stdio: "inherit" });
console.log(`Pushed ${tag}. Follow the publish run: https://github.com/carvalhobfr/conclave-ai/actions/workflows/publish.yml`);
