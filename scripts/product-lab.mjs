#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const modes = ['prepare', 'review', 'score', 'all'];
if (!modes.includes(mode)) throw new Error('Usage: node scripts/product-lab.mjs prepare|review|score|all [run-directory]');
const cli = resolve(process.env.CONCLAVE_LAB_CLI ?? join(root, 'dist/cli.js'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const suites = { basic: '../tests/product-lab/cases.mjs', hard: '../tests/product-lab/cases-hard.mjs' };
// prepare/all choose the suite; review/score reuse the one recorded in the run manifest.
const suite = mode === 'review' || mode === 'score'
  ? JSON.parse(readFileSync(join(resolve(process.argv[3] ?? ''), 'manifest.json'), 'utf8')).suite ?? 'basic'
  : process.env.CONCLAVE_LAB_SUITE ?? 'basic';
assert.ok(suites[suite], `Unknown suite ${suite}. Available: ${Object.keys(suites).join(', ')}`);
const { cases } = await import(suites[suite]);
const suiteDigest = digest(JSON.stringify(cases));
const baselineFiles = (item) => item.baselineFiles ?? { 'src/feature.js': item.baseline };
const candidateFiles = (item) => item.candidateFiles ?? { 'src/feature.js': item.candidate, ...item.extra };
const entryOf = (item) => item.entry ?? 'src/feature.js';
const changedPaths = (item) => Object.entries(candidateFiles(item)).filter(([path, content]) => baselineFiles(item)[path] !== content).map(([path]) => path);
// Ignore inherited Git routing from hooks/agent sessions; every command targets its fixture.
const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_AUTHOR_NAME: 'Conclave Lab', GIT_AUTHOR_EMAIL: 'lab@example.invalid',
  GIT_COMMITTER_NAME: 'Conclave Lab', GIT_COMMITTER_EMAIL: 'lab@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
};
function command(executable, args, cwd, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 10_000_000 });
  if (result.error || result.signal || result.status === null) throw new Error(`Execution failed: ${executable}: ${result.error?.message ?? result.signal}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function git(cwd, ...args) {
  const result = command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], cwd, gitEnvironment);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function json(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
async function files(directory, content) {
  for (const [name, value] of Object.entries(content)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), value);
  }
}
async function prepare() {
  const parent = join(root, '.conclave', 'product-lab');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'run-'));
  const manifest = { version: 1, suite, suiteDigest, createdAt: new Date().toISOString(), cases: [] };
  for (const item of cases) {
    const repository = join(directory, 'repos', `case-${item.id}`);
    const baseline = join(directory, 'baselines', `case-${item.id}`);
    const shared = {
      'package.json': JSON.stringify({ name: `lab-case-${item.id}`, private: true, type: 'module' }) + '\n',
      '.gitignore': '.conclave/\nnode_modules/\n',
    };
    await files(repository, { ...shared, ...baselineFiles(item) });
    await files(baseline, { ...shared, ...baselineFiles(item) });
    git(repository, 'init', '--initial-branch=main');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-m', 'Baseline');
    const base = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'switch', '-c', 'candidate');
    await files(repository, candidateFiles(item));
    git(repository, 'add', '-A');
    git(repository, 'commit', '-m', 'Implement requested change');
    const head = git(repository, 'rev-parse', 'HEAD');
    manifest.cases.push({ id: item.id, repository, baseline, base, head, objective: item.objective });
  }
  await mkdir(join(directory, 'reports'));
  await json(join(directory, 'manifest.json'), manifest);
  console.log(`Prepared ${cases.length} independent Git repositories (${suite} suite): ${directory}`);
  return directory;
}
async function manifest(directory) {
  const value = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(value.version, 1);
  assert.equal(value.suiteDigest, suiteDigest, 'Scenario definitions changed; prepare a fresh run');
  assert.deepEqual(value.cases.map((item) => item.id), cases.map((item) => item.id));
  return value;
}
function unchanged(item) {
  assert.equal(git(item.repository, 'rev-parse', 'HEAD'), item.head, 'Candidate commit changed');
  assert.equal(git(item.repository, 'rev-parse', 'main'), item.base, 'Baseline commit changed');
  assert.equal(git(item.repository, 'status', '--porcelain'), '', 'Fixture was edited; create a fresh run');
}
async function review(directory) {
  const run = await manifest(directory);
  const engineHash = digest(await readFile(cli));
  const results = [];
  for (const item of run.cases) {
    unchanged(item);
    const started = performance.now();
    const args = [cli, 'check', item.repository, '--base', item.base, '--objective', item.objective, '--json'];
    const result = command(process.execPath, args, item.repository);
    await writeFile(join(directory, 'reports', `${item.id}.stdout.json`), result.stdout);
    await writeFile(join(directory, 'reports', `${item.id}.stderr.txt`), result.stderr);
    const envelope = JSON.parse(result.stdout);
    const report = envelope.report ?? envelope;
    assert.equal(result.status, { pass: 0, warn: 0, block: 1, inconclusive: 2 }[report.verdict], 'Verdict and exit code disagree');
    assert.equal(report.changeSet.headSha, item.head);
    const definition = cases.find((entry) => entry.id === item.id);
    assert.ok(changedPaths(definition).every((path) => report.changeSet.files.some((file) => file.path === path)), 'Real change was not reviewed');
    assert.equal(report.trustBoundary.reasoningModelCalls, 0);
    assert.equal(report.trustBoundary.repositoryScriptsExecuted, false);
    unchanged(item);
    results.push({ id: item.id, status: result.status, durationMs: performance.now() - started, stdoutDigest: digest(result.stdout), args });
    console.log(`Case ${item.id}: ${report.verdict} (${report.findings.length} findings)`);
  }
  assert.equal(digest(await readFile(cli)), engineHash, 'CLI changed during review');
  await json(join(directory, 'review-ledger.json'), { createdAt: new Date().toISOString(), cli, engineHash, results });
}
async function score(directory) {
  const run = await manifest(directory);
  const ledger = JSON.parse(await readFile(join(directory, 'review-ledger.json'), 'utf8'));
  assert.deepEqual(ledger.results.map((item) => item.id), cases.map((item) => item.id));
  const rows = [];
  await mkdir(join(directory, 'oracles'), { recursive: true });
  for (const item of run.cases) {
    unchanged(item);
    const definition = cases.find((entry) => entry.id === item.id);
    for (const [path, content] of Object.entries(baselineFiles(definition))) assert.equal(await readFile(join(item.baseline, path), 'utf8'), content, 'Baseline snapshot changed');
    for (const [path, content] of Object.entries(candidateFiles(definition))) assert.equal(await readFile(join(item.repository, path), 'utf8'), content, 'Candidate differs from frozen scenario');
    const original = await readFile(join(directory, 'reports', `${item.id}.stdout.json`), 'utf8');
    assert.equal(digest(original), ledger.results.find((entry) => entry.id === item.id).stdoutDigest, 'Report edited after blind review');
    const envelope = JSON.parse(original);
    const report = envelope.report ?? envelope;
    const oracle = join(directory, 'oracles', `${item.id}.mjs`);
    await writeFile(oracle, `import assert from 'node:assert/strict';\nimport { pathToFileURL } from 'node:url';\nconst subject = await import(pathToFileURL(process.argv[2]).href);\ntry {\n${definition.oracle}\nconsole.log('ORACLE_PASS');\n} catch (error) {\nif (error?.code !== 'ERR_ASSERTION') throw error;\nconsole.error(error.message);\nconsole.log('ORACLE_ASSERTION_FAILED');\nprocess.exitCode = 1;\n}\n`);
    const baseline = command(process.execPath, [oracle, join(item.baseline, entryOf(definition))], directory);
    const candidate = command(process.execPath, [oracle, join(item.repository, entryOf(definition))], directory);
    await json(join(directory, 'oracles', `${item.id}.result.json`), { baseline, candidate });
    assert.equal(baseline.status, 0, `Invalid baseline ${item.id}: ${baseline.stderr}`);
    assert.ok(baseline.stdout.includes('ORACLE_PASS'));
    assert.equal(candidate.status, definition.broken ? 1 : 0, `Wrong fixture label ${item.id}: ${candidate.stderr}`);
    assert.ok(candidate.stdout.includes(definition.broken ? 'ORACLE_ASSERTION_FAILED' : 'ORACLE_PASS'), 'Unexpected execution failure cannot establish a defect');
    // Generic WARN, missing-test warnings and escalation do NOT count as defect detection.
    const matching = definition.kind === null ? [] : report.findings.filter((finding) => finding.kind === definition.kind && finding.evidence.some((evidence) => changedPaths(definition).includes(evidence.path)));
    const sourceKinds = ['unreleased-resource', 'discarded-error', 'inconsistent-key'];
    const specific = report.findings.filter((finding) => sourceKinds.includes(finding.kind));
    const classification = definition.broken ? (matching.length ? 'TP' : 'FN') : (specific.length ? 'FP' : 'TN');
    rows.push({ id: item.id, title: definition.title, category: definition.category ?? null, broken: definition.broken, oraclePassed: candidate.status === 0, verdict: report.verdict, classification, matchedFindingIds: matching.map((finding) => finding.id), findings: report.findings.map((finding) => ({ kind: finding.kind, severity: finding.severity, title: finding.title, evidence: finding.evidence })), escalation: report.escalation, durationMs: ledger.results.find((entry) => entry.id === item.id).durationMs });
  }
  const counts = Object.fromEntries(['TP', 'FP', 'TN', 'FN'].map((key) => [key, rows.filter((row) => row.classification === key).length]));
  const summary = {
    runDirectory: directory, suite, suiteDigest, engineHash: ledger.engineHash, harnessVerified: true,
    productApproved: false, counts,
    precision: counts.TP + counts.FP ? counts.TP / (counts.TP + counts.FP) : null,
    recall: counts.TP / (counts.TP + counts.FN),
    warningOnlyHealthyCases: rows.filter((row) => !row.broken && row.findings.length > 0).map((row) => row.id),
    limitations: [`${cases.length} synthetic JavaScript repositories (${suite} suite); not representative market accuracy.`, 'Runtime oracle uses EventTarget, an in-memory storage adapter and a controlled timer registry; no real browser, disk persistence or HTTP server.', 'Matching a rule and evidence path is a targeted signal, not proof that the tool understood the defect.', 'Cases without a mapped rule are conservatively counted as misses; manually inspect raw findings for novel specific detection.', 'Generic risks and missing-test findings are reported separately and never credited as defect detection.', 'Ground truth is external to reviewed repositories; the supervising AI can still read it, so this is not a human double-blind study.'],
    results: rows,
  };
  await json(join(directory, 'score.json'), summary);
  const markdown = `# Resultado do laboratório\n\nExecução dos cenários verificada. Isto não aprova o produto.\n\n| Caso | Cenário | Comportamento | Veredito | Detecção específica |\n|---|---|---|---|---|\n${rows.map((row) => `| ${row.id} | ${row.title} | ${row.broken ? 'Defeituoso' : 'Saudável'} | ${row.verdict} | ${row.classification} |`).join('\n')}\n\nTP=${counts.TP}; FP=${counts.FP}; TN=${counts.TN}; FN=${counts.FN}.\n\nPrecisão=${summary.precision}; recall=${summary.recall}. Amostra sintética pequena; não é acurácia em PRs reais.\n\nAvisos em casos saudáveis: ${summary.warningOnlyHealthyCases.join(', ') || 'nenhum'}. Consulte score.json para todos os achados, lacunas e limitações.\n`;
  await writeFile(join(directory, 'RESULTADO.md'), markdown);
  console.log(markdown);
  console.log(`Evidence: ${join(directory, 'score.json')}`);
}

const directory = mode === 'prepare' || mode === 'all' ? await prepare() : resolve(process.argv[3] ?? '');
if ((mode === 'review' || mode === 'score') && !process.argv[3]) throw new Error('Supply the exact run-directory printed by prepare');
if (mode === 'review' || mode === 'all') await review(directory);
if (mode === 'score' || mode === 'all') await score(directory);
