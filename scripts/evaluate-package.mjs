import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execute = promisify(execFile);
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this with npm run eval:package");
const workspace = process.cwd();
const expected = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")).version;
const temporary = await mkdtemp(join(tmpdir(), "conclave-package-"));
const started = performance.now();
try {
  const { stdout } = await execute(process.execPath, [npm, "pack", "--ignore-scripts", "--pack-destination", temporary, "--json"], { cwd: workspace, maxBuffer: 4_000_000 });
  const manifest = JSON.parse(stdout)[0];
  for (const path of ["dist/cli.js", "dist/web-client/index.html", "schemas/validation-report.v2.schema.json", "schemas/validation-report.v3.schema.json", "schemas/validation-report.v4.schema.json", "schemas/validation-report.v5.schema.json", "docs/acceptance.md", "docs/ci-evidence.md", "docs/browser-smoke.md", "skills/conclave-validate/scripts/run-validation.mjs"]) assert(manifest.files.some((file) => file.path === path), `Package misses ${path}`);
  assert(!manifest.files.some((file) => /(^|\/)(\.env|\.conclave|node_modules)(\/|$)/.test(file.path)), "Private state entered package");
  const install = join(temporary, "installed");
  await execute(process.execPath, [npm, "install", "--prefix", install, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, manifest.filename)], { timeout: 120_000 });
  const packageRoot = join(install, "node_modules", "conclave-ai");
  const entry = join(packageRoot, "dist", "cli.js");
  assert.equal((await execute(process.execPath, [entry, "--version"])).stdout.trim(), expected);
  const root = join(temporary, "fixture"); await mkdir(root);
  const run = async (args) => {
    try { const result = await execute(process.execPath, [entry, ...args], { cwd: root, maxBuffer: 4_000_000, env: { ...process.env, CONCLAVE_LANGUAGE: "en" } }); return { code: 0, ...result }; }
    catch (error) { if (typeof error.code !== "number") throw error; return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, ".gitignore"), ".conclave/\n");
  await writeFile(join(root, "feature.js"), "export function value() { return 1; }\n");
  for (const args of [["init", "-b", "master"], ["add", "package.json", ".gitignore", "feature.js"], ["-c", "user.name=Conclave", "-c", "user.email=conclave@example.invalid", "commit", "-m", "baseline"]]) await execute("git", args, { cwd: root });
  await writeFile(join(root, "feature.js"), "export function value() { return 2; }\n");
  const { saveAcceptanceContract } = await import(pathToFileURL(join(packageRoot, "dist/storage/acceptance-contract.js")));
  await saveAcceptanceContract(root, { objective: "Return the new value", claims: [], allowedPathPrefixes: [], criteria: [{ id: "value", statement: "Returns 2", verificationPlan: "Import value and assert 2", kind: "test", confirmed: true, claimIds: [], implementationPaths: ["feature.js"] }] }, null);
  const first = await run(["check", root, "--working", "--json"]); assert.equal(first.code, 0, first.stderr);
  const initial = JSON.parse(first.stdout).report; assert.equal(initial.criteria[0].status, "not-verified");
  const reportPath = join(temporary, "report.json"); const planPath = join(temporary, "plan.json"); const receiptPath = join(temporary, "receipts.json");
  await writeFile(reportPath, JSON.stringify(initial));
  await writeFile(planPath, JSON.stringify({ version: 1, checks: [{ id: "value-test", type: "test", argv: [process.execPath, "--input-type=module", "-e", "import {value} from './feature.js'; if(value()!==2)process.exit(1)"], timeoutMs: 10000, criterionIds: ["value"] }] }));
  assert.equal((await run(["collect", root, reportPath, planPath, receiptPath])).code, 0);
  const recheck = await run(["check", root, "--working", "--previous-report", reportPath, "--receipt", receiptPath, "--json"]);
  assert.equal(recheck.code, 0, recheck.stderr);
  const current = JSON.parse(recheck.stdout).report;
  assert.equal(current.criteria[0].status, "supported"); assert.equal(current.criteria[0].previousStatus, "not-verified"); assert.equal(current.lineage.contractStatus, "preserved");
  await writeFile(join(root, "feature.js"), "export function value() { return 3; }\n");
  const stale = JSON.parse((await run(["check", root, "--working", "--previous-report", reportPath, "--receipt", receiptPath, "--json"])).stdout).report;
  assert.equal(stale.criteria[0].status, "not-verified"); assert.equal(stale.receipts.items[0].status, "stale");
  const result = { version: expected, platform: process.platform, node: process.version, durationMs: Math.round(performance.now() - started), tarballIntegrity: manifest.integrity, gates: ["package contents", "clean install", "CLI startup", "persisted criteria", "executed fixture", "bound recheck", "stale evidence rejection"], passed: true };
  await mkdir(resolve(".conclave"), { recursive: true });
  await writeFile(resolve(".conclave/package-evaluation.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
