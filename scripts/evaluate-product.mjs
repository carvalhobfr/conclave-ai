import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findSourceDefects } from "../dist/validation/source-defects.js";
const fixture = JSON.parse(await readFile(resolve("tests/fixtures/product-evaluation/v1.json"), "utf8"));
const started = performance.now();
const cases = fixture.cases.map((item) => {
  const findings = findSourceDefects({ files: { "fixture.ts": { path: "fixture.ts", sourceText: item.source } } }, [{ path: "fixture.ts", status: "added", hunks: [] }]);
  return { id: item.id, expectedProblem: item.problem, detected: findings.length > 0, findings: findings.map((finding) => finding.kind), ...(item.knownLimitation ? { knownLimitation: item.knownLimitation } : {}) };
});
const tp = cases.filter((item) => item.detected && item.expectedProblem).length;
const fp = cases.filter((item) => item.detected && !item.expectedProblem).length;
const fn = cases.filter((item) => !item.detected && item.expectedProblem).length;
const unexpected = cases.filter((item) => item.detected !== item.expectedProblem && !item.knownLimitation);
const result = { fixtureVersion: fixture.version, scope: fixture.scope, cases: cases.length, truePositives: tp, falsePositives: fp, falseNegatives: fn, precision: tp / (tp + fp), recall: tp / (tp + fn), durationMs: performance.now() - started, unexpectedRegressions: unexpected.map((item) => item.id), results: cases };
await mkdir(resolve(".conclave"), { recursive: true });
await writeFile(resolve(".conclave/product-evaluation.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
if (unexpected.length) process.exitCode = 1;
