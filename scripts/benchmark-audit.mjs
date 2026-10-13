// Measures `conclave audit` on a repository (default: this one). Reads only; writes nothing.
// Usage: node scripts/benchmark-audit.mjs [repository] [--runs N] [--json]
import { resolve } from "node:path";

import { auditRepository } from "../dist/analysis/repository-audit.js";

const args = process.argv.slice(2);
const runsIndex = args.indexOf("--runs");
const runs = runsIndex === -1 ? 5 : Math.max(1, Number(args[runsIndex + 1]) || 5);
const json = args.includes("--json");
const repository = resolve(args.find((value, index) => !value.startsWith("--") && args[index - 1] !== "--runs") ?? ".");

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 10) / 10;
const spread = (values) => ({ min: round(Math.min(...values)), median: round(median(values)), max: round(Math.max(...values)) });

const samples = [];
let report;
let peakRss = 0;
let peakHeap = 0;
for (let run = 0; run < runs; run += 1) {
  report = await auditRepository(repository);
  samples.push(report.metrics);
  peakRss = Math.max(peakRss, report.metrics.rssBytes);
  peakHeap = Math.max(peakHeap, report.metrics.heapUsedBytes);
}

const result = {
  repository: report.repository.name,
  snapshot: report.snapshot.id,
  analyzer: report.analyzer.version,
  node: process.version,
  runs,
  files: { discovered: report.metrics.filesDiscovered, analyzed: report.metrics.filesAnalyzed, excluded: report.metrics.filesExcluded },
  graph: {
    symbols: report.metrics.symbols,
    edges: report.metrics.graphEdges,
    crossFileEdges: report.metrics.crossFileEdges,
    relativeImports: report.metrics.relativeImports,
    resolvedRelativeImports: report.metrics.resolvedRelativeImports,
  },
  // The first run includes module loading and a cold file cache; later runs do not.
  milliseconds: {
    total: spread(samples.map((item) => item.totalMs)),
    index: spread(samples.map((item) => item.indexMs)),
    rules: spread(samples.map((item) => item.rulesMs)),
    firstRunTotal: round(samples[0].totalMs),
  },
  memoryMegabytes: { peakRss: round(peakRss / 1_048_576), peakHeapUsed: round(peakHeap / 1_048_576) },
  rules: report.rules.map((rule) => ({ rule: rule.ruleId, status: rule.status, filesExamined: rule.filesExamined, matches: rule.matches, ms: round(rule.durationMs) })),
  findings: { active: report.summary.findings, suppressed: report.summary.suppressed, bySeverity: report.summary.bySeverity, byRule: report.summary.byRule },
  coverage: report.coverage.status,
};

if (json) {
  console.log(JSON.stringify(result, undefined, 2));
} else {
  console.log(`Audit benchmark · ${result.repository} · ${String(runs)} runs · Node ${result.node}`);
  console.log(`Files: ${String(result.files.analyzed)} analyzed of ${String(result.files.discovered)} discovered (${String(result.files.excluded)} excluded)`);
  console.log(`Graph: ${String(result.graph.edges)} edges, ${String(result.graph.crossFileEdges)} cross-file; ${String(result.graph.resolvedRelativeImports)} of ${String(result.graph.relativeImports)} relative imports resolved`);
  for (const [name, value] of Object.entries(result.milliseconds)) {
    console.log(typeof value === "number" ? `${name}: ${String(value)} ms` : `${name}: median ${String(value.median)} ms (min ${String(value.min)}, max ${String(value.max)})`);
  }
  console.log(`Memory: peak RSS ${String(result.memoryMegabytes.peakRss)} MB, peak heap used ${String(result.memoryMegabytes.peakHeapUsed)} MB`);
  for (const rule of result.rules) console.log(`  ${rule.rule.padEnd(20)} ${rule.status.padEnd(9)} ${String(rule.filesExamined).padStart(5)} files ${String(rule.matches).padStart(4)} matches ${String(rule.ms).padStart(7)} ms`);
  console.log(`Findings: ${String(result.findings.active)} active, ${String(result.findings.suppressed)} suppressed; coverage ${result.coverage}`);
}
