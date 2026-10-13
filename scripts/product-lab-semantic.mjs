#!/usr/bin/env node
// Product Lab for `conclave audit --semantic`: whole-tree discovery with no diff, no ticket and no hint.
//
//   node scripts/product-lab-semantic.mjs run   [--suite basic|hard|all] [--runs N] [--concurrency N] [-- AUDIT FLAGS]
//   node scripts/product-lab-semantic.mjs score RUN_DIRECTORY
//
// `run` makes real model calls with the provider configured for Conclave, which may be billed. It
// sends only the synthetic lab sources. Each tree holds the case's source files and a package.json:
// labels, titles, objectives and oracles stay in this run directory, outside every audited tree.
//
// `score` counts a defect as detected only when a hypothesis sits on the changed lines AND an
// adjudication entry says it describes the target behavior. Location is checked by this script;
// behavior needs a reader, recorded in RUN_DIRECTORY/adjudications.json:
//   { "reviewer": "...", "entries": [{ "run": 1, "case": "hard-H01", "variant": "candidate",
//     "fingerprint": "audit_...", "verdict": "target" | "false" | "real-other", "explanation": "..." }] }
// A hypothesis without an entry is pending and is never counted as a detection.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist/cli.js');
const [action, ...rest] = process.argv.slice(2);
const SUITES = { basic: '../tests/product-lab/cases.mjs', hard: '../tests/product-lab/cases-hard.mjs' };
const LOCATION_TOLERANCE = 2;
const json = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const digest = (text) => createHash('sha256').update(text).digest('hex');
const option = (name, fallback) => { const index = rest.indexOf(name); return index === -1 ? fallback : rest[index + 1]; };

const baselineFiles = (item) => item.baselineFiles ?? { 'src/feature.js': item.baseline };
const candidateFiles = (item) => item.candidateFiles ?? { 'src/feature.js': item.candidate, ...item.extra };

/** Candidate lines that the baseline file does not contain: where the change, and so the defect, is. */
function changedLines(item) {
  const changed = {};
  for (const [path, content] of Object.entries(candidateFiles(item))) {
    const before = new Set((baselineFiles(item)[path] ?? '').split('\n').map((line) => line.trim()));
    const lines = content.split('\n').flatMap((line, index) => (line.trim() !== '' && !before.has(line.trim()) ? [index + 1] : []));
    if (lines.length > 0) changed[path] = lines;
  }
  return changed;
}

async function loadCases(suite) {
  const names = suite === 'all' ? Object.keys(SUITES) : [suite];
  const loaded = [];
  for (const name of names) {
    assert.ok(SUITES[name], `Unknown suite ${name}`);
    const { cases } = await import(SUITES[name]);
    for (const item of cases) loaded.push({ ...item, key: `${name}-${item.id}` });
  }
  return loaded;
}

function audit(tree, flags) {
  return new Promise((done) => {
    const started = performance.now();
    // cwd is the project so that its .env selects the provider; the audited path is the tree alone.
    const child = spawn(process.execPath, [cli, 'audit', tree, '--semantic', '--json', '--no-write', '--fail-on', 'none', ...flags], { cwd: root, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20 * 60_000);
    child.on('close', (status) => { clearTimeout(timer); done({ status, stdout, stderr, wallMs: performance.now() - started }); });
  });
}

async function run() {
  const separator = rest.indexOf('--');
  const flags = separator === -1 ? [] : rest.slice(separator + 1);
  const suite = option('--suite', 'all');
  const runs = Math.max(1, Number(option('--runs', '1')) || 1);
  const concurrency = Math.max(1, Number(option('--concurrency', '1')) || 1);
  const cases = await loadCases(suite);
  const parent = join(root, '.conclave', 'product-lab');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'semantic-'));
  const truth = [];
  const jobs = [];
  for (const item of cases) {
    for (const [variant, files] of [['candidate', candidateFiles(item)], ['baseline', baselineFiles(item)]]) {
      const tree = join(directory, 'trees', item.key, variant);
      const content = { 'package.json': JSON.stringify({ name: 'lab-case', private: true, type: 'module' }) + '\n', ...files };
      for (const [path, text] of Object.entries(content)) {
        await mkdir(dirname(join(tree, path)), { recursive: true });
        await writeFile(join(tree, path), text);
      }
      for (let index = 1; index <= runs; index += 1) jobs.push({ key: item.key, variant, tree, run: index });
    }
    truth.push({ key: item.key, broken: item.broken, title: item.title, expectedRule: item.kind ?? null, changed: changedLines(item) });
  }
  const engineDigest = digest(await readFile(cli));
  await json(join(directory, 'truth.json'), truth);
  await json(join(directory, 'experiment.json'), {
    createdAt: new Date().toISOString(), suite, runs, concurrency, auditFlags: flags, engineDigest,
    input: 'Source tree only: no diff, no pull-request description, no question, no label.',
    notes: ['One process per tree and run; no retry and no best-of selection.', 'A failed process is an operational failure, not a miss.'],
  });
  console.log(`${String(jobs.length)} audits (${String(cases.length)} cases x candidate+baseline x ${String(runs)} run(s)) in ${directory}`);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      const result = await audit(job.tree, flags);
      const base = join(directory, 'results', `run-${String(job.run)}`);
      await mkdir(base, { recursive: true });
      await writeFile(join(base, `${job.key}.${job.variant}.json`), result.stdout);
      await writeFile(join(base, `${job.key}.${job.variant}.stderr.txt`), result.stderr);
      await json(join(base, `${job.key}.${job.variant}.meta.json`), { status: result.status, wallMs: result.wallMs, stdoutDigest: digest(result.stdout) });
      console.log(`run ${String(job.run)} ${job.key} ${job.variant}: exit ${String(result.status)} in ${String(Math.round(result.wallMs / 1000))} s`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  assert.equal(digest(await readFile(cli)), engineDigest, 'CLI changed during the experiment');
  console.log(`Done. Adjudicate, then: node scripts/product-lab-semantic.mjs score ${directory}`);
}

function nearChanged(finding, changed) {
  const lines = changed[finding.location.path];
  return lines !== undefined && lines.some((line) => Math.abs(line - (finding.location.startLine ?? -99)) <= LOCATION_TOLERANCE);
}

async function score() {
  const directory = resolve(rest[0] ?? '');
  const truth = await readJson(join(directory, 'truth.json'));
  const experiment = await readJson(join(directory, 'experiment.json'));
  const adjudications = await readJson(join(directory, 'adjudications.json')).catch(() => ({ reviewer: null, entries: [] }));
  const verdictOf = (run, key, variant, fingerprint) => adjudications.entries.find((entry) => entry.run === run && entry.case === key && entry.variant === variant && entry.fingerprint === fingerprint)?.verdict;
  const rows = [];
  for (const name of (await readdir(join(directory, 'results'))).sort()) {
    const run = Number(name.replace('run-', ''));
    const total = { run, operationalFailures: 0, pending: 0, usage: { modelCalls: 0, approximateInputTokens: 0, approximateOutputTokens: 0, providerReportedInputTokens: 0, providerReportedOutputTokens: 0, modelMs: 0, wallMs: 0 }, coverage: { eligibleLines: 0, linesExamined: 0 }, models: new Set(), costStatuses: new Set() };
    const semantic = { tp: 0, fn: 0, fpCandidates: 0, tnCandidates: 0, fpBaselines: 0, baselines: 0, located: 0, targetHypotheses: 0, hypotheses: 0, falseHypotheses: 0, review: { 'model-supported': 0, inconclusive: 0, 'not-reviewed': 0, 'model-disputed': 0 }, byReviewTruth: {}, reachabilityUnproven: 0, verificationFailed: 0, rejectedByReview: 0, missed: [], falseAlarms: [] };
    const rules = { tp: 0, fn: 0, fpCandidates: 0, tnCandidates: 0, fpBaselines: 0 };
    for (const item of truth) {
      const reports = {};
      for (const variant of ['candidate', 'baseline']) {
        const meta = await readJson(join(directory, 'results', name, `${item.key}.${variant}.meta.json`));
        total.usage.wallMs += meta.wallMs;
        try {
          reports[variant] = JSON.parse(await readFile(join(directory, 'results', name, `${item.key}.${variant}.json`), 'utf8'));
          assert.ok(reports[variant].semantic, 'no semantic section');
        } catch {
          total.operationalFailures += 1;
          continue;
        }
        const section = reports[variant].semantic;
        for (const field of ['modelCalls', 'approximateInputTokens', 'approximateOutputTokens', 'providerReportedInputTokens', 'providerReportedOutputTokens']) total.usage[field] += section.usage[field];
        total.usage.modelMs += section.usage.durationMs;
        total.coverage.eligibleLines += section.coverage.eligibleLines;
        total.coverage.linesExamined += section.coverage.linesExamined;
        total.models.add(`${section.discovery.providerId}/${section.discovery.modelId}`);
        total.costStatuses.add(section.usage.cost.status);
        semantic.rejectedByReview += section.hypotheses.rejectedByReview;
        semantic.reachabilityUnproven += section.hypotheses.reachabilityUnproven ?? 0;
        semantic.verificationFailed += section.hypotheses.verificationFailed ?? 0;
      }
      if (reports.candidate === undefined || reports.baseline === undefined) continue;
      const split = (report) => ({
        hypotheses: report.findings.filter((finding) => finding.origin === 'ai-hypothesis' && finding.suppression === undefined),
        rules: report.findings.filter((finding) => finding.origin !== 'ai-hypothesis' && finding.suppression === undefined),
      });
      const [candidate, baseline] = [split(reports.candidate), split(reports.baseline)];

      // Rules: a detection is a rule finding in the candidate that the correct baseline does not have.
      const baselineRules = new Set(baseline.rules.map((finding) => `${finding.ruleId}\0${finding.location.path}`));
      const introduced = candidate.rules.filter((finding) => !baselineRules.has(`${finding.ruleId}\0${finding.location.path}`) && (item.expectedRule === null || !item.broken || finding.ruleId === item.expectedRule));
      if (item.broken) rules[introduced.length > 0 ? 'tp' : 'fn'] += 1;
      else rules[candidate.rules.length > 0 ? 'fpCandidates' : 'tnCandidates'] += 1;
      if (baseline.rules.length > 0) rules.fpBaselines += 1;

      // Hypotheses: location by this script, behavior by adjudication.
      semantic.baselines += 1;
      const judged = (variant, list) => list.map((finding) => ({ finding, verdict: verdictOf(run, item.key, variant, finding.fingerprint) }));
      const candidateJudged = judged('candidate', candidate.hypotheses);
      const baselineJudged = judged('baseline', baseline.hypotheses);
      for (const entry of [...candidateJudged, ...baselineJudged]) {
        semantic.hypotheses += 1;
        semantic.review[entry.finding.hypothesis.review.status] += 1;
        const cell = `${entry.finding.hypothesis.review.status}:${entry.verdict ?? 'pending'}`;
        semantic.byReviewTruth[cell] = (semantic.byReviewTruth[cell] ?? 0) + 1;
        if (entry.verdict === undefined) total.pending += 1;
        if (entry.verdict === 'false') semantic.falseHypotheses += 1;
      }
      // In a tree the oracle calls correct, a hypothesis is a false alarm unless a reader showed it is real.
      const alarm = (list) => list.some((entry) => entry.verdict !== 'real-other');
      if (alarm(baselineJudged)) { semantic.fpBaselines += 1; semantic.falseAlarms.push(`${item.key} baseline`); }
      if (item.broken) {
        const targets = candidateJudged.filter((entry) => entry.verdict === 'target');
        const located = targets.filter((entry) => nearChanged(entry.finding, item.changed));
        semantic.targetHypotheses += targets.length;
        semantic.located += located.length;
        if (located.length > 0) semantic.tp += 1;
        else { semantic.fn += 1; semantic.missed.push(item.key); }
      } else if (alarm(candidateJudged)) { semantic.fpCandidates += 1; semantic.falseAlarms.push(`${item.key} candidate`); } else semantic.tnCandidates += 1;
    }
    const ratio = (top, bottom) => (bottom === 0 ? null : Math.round((top / bottom) * 1000) / 1000);
    const summarize = (arm) => ({ ...arm, precision: ratio(arm.tp, arm.tp + arm.fpCandidates), recall: ratio(arm.tp, arm.tp + arm.fn) });
    rows.push({
      run,
      models: [...total.models],
      operationalFailures: total.operationalFailures,
      pendingAdjudications: total.pending,
      deterministicRules: summarize(rules),
      semanticDiscovery: { ...summarize(semantic), localizationAccuracy: ratio(semantic.located, semantic.targetHypotheses), hypothesisPrecision: ratio(semantic.hypotheses - semantic.falseHypotheses - total.pending, semantic.hypotheses) },
      usage: { ...total.usage, modelMs: Math.round(total.usage.modelMs), wallMs: Math.round(total.usage.wallMs), cost: [...total.costStatuses] },
      aiCoverage: { ...total.coverage, share: ratio(total.coverage.linesExamined, total.coverage.eligibleLines) },
    });
  }
  const output = {
    experiment,
    reviewer: adjudications.reviewer,
    rows,
    limitations: [
      'Synthetic trees of one to three small files; whole-tree coverage is trivial here and says nothing about prioritization on a real repository.',
      'Precision counts cases: a candidate is one false positive however many false hypotheses it holds. hypothesisPrecision counts hypotheses.',
      'Behavior match is a reader\'s judgement recorded in adjudications.json; location match is computed.',
      'A pending adjudication is never a detection, so pending runs understate recall.',
      'Token counts are the audit\'s own; no price is assumed.',
    ],
  };
  await json(join(directory, 'score.json'), output);
  console.log(JSON.stringify(output, null, 2));
}

assert.ok(action === 'run' || action === 'score', 'Usage: node scripts/product-lab-semantic.mjs run [--suite basic|hard|all] [--runs N] [--concurrency N] [-- AUDIT FLAGS] | score RUN_DIRECTORY');
await (action === 'run' ? run() : score());
