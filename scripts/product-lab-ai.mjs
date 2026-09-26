#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConclaveEnvironment } from '../dist/config/environment-file.js';
import { loadRuntimeConfig } from '../dist/config/runtime-config.js';
import { createProvider } from '../dist/providers/provider-factory.js';
import { EnvironmentCredentialSource } from '../dist/storage/environment-credential-source.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2];
const path = process.argv[3];
assert.ok(['run', 'table'].includes(action) && path, 'Usage: node scripts/product-lab-ai.mjs run LAB_DIRECTORY | table AI_DIRECTORY');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const json = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const cli = join(root, 'dist/cli.js');
const preload = join(root, 'scripts/product-lab-ai-trace.mjs');
loadConclaveEnvironment(process.env, join(root, '.env'));
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CONCLAVE_')));
const secretValues = Object.entries(process.env).filter(([key, value]) => key.startsWith('CONCLAVE_') && /KEY|TOKEN|SECRET/u.test(key) && value).map(([, value]) => value);
const redact = (text) => secretValues.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), text);
const question = (objective) => `Review the current Git change. Pull request description: ${objective}\nIs this change safe to merge? Report each concrete defect the change introduces with source evidence, or state that the existing behavior is preserved. Do not treat missing tests alone as a defect. Respond in English.`;
function unchanged(item) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', args, { cwd: item.repository, env, encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), item.head, 'Candidate commit changed');
  assert.equal(git('rev-parse', 'main'), item.base, 'Baseline commit changed');
  assert.equal(git('status', '--porcelain'), '', 'Candidate working tree changed');
}

async function engineDigest() {
  const entries = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.js')) entries.push([file.slice(root.length), hash(await readFile(file))]);
    }
  }
  await walk(join(root, 'dist'));
  return hash(JSON.stringify(entries));
}
async function exists(file) { try { await readFile(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function execute(args, cwd, env) {
  return new Promise((resolvePromise) => {
    const start = performance.now();
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 300_000);
    const capture = (name, data) => {
      if (stdout.length + stderr.length + data.length > 10_000_000) { overflow = true; child.kill('SIGKILL'); return; }
      if (name === 'stdout') stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.on('data', (data) => capture('stdout', data));
    child.stderr.on('data', (data) => capture('stderr', data));
    child.on('error', (error) => { stderr += error.message; });
    child.on('close', (status, signal) => { clearTimeout(timer); resolvePromise({ status, signal, timedOut, overflow, stdout: redact(stdout), stderr: redact(stderr), wallMs: performance.now() - start }); });
  });
}
function environment(config, trace) {
  const prefix = config.mode === 'free' ? 'CONCLAVE_FREE_' : 'CONCLAVE_';
  return {
    ...cleanEnvironment, CONCLAVE_MODE: config.mode,
    [`${prefix}PROVIDER`]: config.provider, [`${prefix}MODEL`]: config.model,
    [`${prefix}BASE_URL`]: config.baseUrl, CONCLAVE_REASONING_PRESET: config.preset,
    CONCLAVE_EMBEDDING_MODE: 'feature-hash', CONCLAVE_LAB_TRACE: trace,
    ...(config.credential ? { [config.credential]: process.env[config.credential] ?? '' } : {}),
    // A role is a model on the row's provider, or { provider, model } for another provider of the same vendor.
    ...Object.fromEntries(Object.entries(config.roles ?? {}).flatMap(([role, choice]) => [[`CONCLAVE_${role.toUpperCase()}_PROVIDER`, choice.provider ?? config.provider], [`CONCLAVE_${role.toUpperCase()}_MODEL`, choice.model ?? choice]])),
    ...(config.fallback ? { CONCLAVE_FALLBACK_MODEL: config.fallback } : {}),
    // Dedicated keys for other role providers (e.g. CONCLAVE_OPENCODE_ZEN_API_KEY) reach only those providers.
    ...Object.fromEntries(Object.values(config.roles ?? {}).map((choice) => choice.provider).filter(Boolean).map((provider) => `CONCLAVE_${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`).filter((name) => process.env[name]).map((name) => [name, process.env[name]])),
  };
}
async function matrix() {
  const configs = [];
  const only = process.env.CONCLAVE_LAB_ONLY?.split(',').filter(Boolean);
  for (const mode of ['api', 'free']) {
    const runtime = loadRuntimeConfig({ ...process.env, CONCLAVE_MODE: mode });
    const common = { mode, ...runtime.providerSelection, credential: runtime.credentialEnvironmentVariable };
    for (const [command, preset] of [['ask', 'free-like'], ['investigate', 'free-like'], ['investigate', 'full']]) {
      configs.push({ id: `${mode}-${command}-${preset}`, ...common, command, preset });
    }
  }
  const api = configs[0];
  // Extra model rows on the configured API provider/endpoint, e.g. CONCLAVE_LAB_MODELS=a,b.
  for (const model of process.env.CONCLAVE_LAB_MODELS?.split(',').filter(Boolean) ?? []) {
    for (const [command, preset] of [['ask', 'free-like'], ['investigate', 'full']]) {
      configs.push({ ...api, id: `model-${model}-${command}-${preset}`, model, command, preset });
    }
  }
  // Role mixes on the API provider, e.g. CONCLAVE_LAB_MIXES='[{"id":"judge-pro","model":"a","roles":{"judge":"b"},"fallback":"b"}]'.
  for (const mix of JSON.parse(process.env.CONCLAVE_LAB_MIXES ?? '[]')) {
    configs.push({ ...api, command: 'investigate', preset: 'full', ...mix, id: `mix-${mix.id}` });
  }
  if (only) return configs.filter((config) => only.includes(config.id));
  // UI presets can reuse a credential only on its configured provider AND endpoint.
  const ui = [
    { name: 'essential', provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4.1-flash' },
    { name: 'free-trial', provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'space-bunny-free' },
  ];
  for (const preset of ui) {
    const compatibleProvider = preset.provider === api.provider;
    configs.push({ id: `ui-${preset.name}`, mode: 'api', command: 'investigate', preset: 'full', ...preset,
      ...(compatibleProvider && preset.baseUrl === api.baseUrl ? { credential: api.credential } : { unavailable: 'No credential configured for this provider and endpoint. Credentials from other providers were not reused.' }) });
  }
  if (process.env.CONCLAVE_LAB_LOCAL !== '1') return configs;
  for (const [provider, baseUrl, discovery] of [['ollama', 'http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/api/tags'], ['lm-studio', 'http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1/models']]) {
    let models = [];
    try { const response = await fetch(discovery, { signal: AbortSignal.timeout(2000) }); if (response.ok) { const payload = await response.json(); models = (payload.models ?? payload.data ?? []).map((item) => item.name ?? item.id).filter(Boolean); } } catch { /* Availability is recorded below. */ }
    if (!models.length) configs.push({ id: `local-${provider}`, mode: 'local', provider, baseUrl, model: null, command: 'investigate', preset: 'local', unavailable: 'Local server unavailable or no installed model.' });
    for (const model of models) for (const command of ['ask', 'investigate']) configs.push({ id: `local-${provider}-${hash(model).slice(0, 8)}-${command}`, mode: 'local', provider, baseUrl, model, command, preset: 'local' });
  }
  return configs;
}
async function run(lab) {
  const manifest = await readJson(join(lab, 'manifest.json'));
  const offline = await readJson(join(lab, 'score.json'));
  assert.equal(offline.harnessVerified, true, 'Run and score the original laboratory first');
  const directory = await mkdtemp(join(lab, 'ai-'));
  const configs = await matrix();
  const engine = await engineDigest();
  await json(join(directory, 'experiment.json'), { createdAt: new Date().toISOString(), lab, engineDigest: engine, suiteDigest: manifest.suiteDigest, configs, questionTemplate: question('{objective}'), perCaseTimeoutMs: 300_000, retries: 'Product defaults only; no benchmark retry or best-of selection', offlineCounts: offline.counts, notes: ['Ask uses investigator-judge; Investigate uses conclave routing.', 'Ask presets are equivalent in role selection, so only one Ask row per runtime is executed.', 'Essential is represented by the configured API/free-like row when provider/model match.', 'Local embedding feature-hash; no role or fallback overrides; default product reasoning limits.', 'Only synthetic repository code is sent to configured external providers.', 'Quality labels require explicit adjudication after outputs are frozen.'] });
  console.log(`AI experiment: ${directory}`);
  async function runConfig(config) {
    const folder = join(directory, config.id);
    await mkdir(folder);
    let preflight;
    if (config.unavailable || !config.model) preflight = { ok: false, reason: config.unavailable ?? 'No model configured' };
    else {
      try {
        const env = environment(config, '');
        const runtime = loadRuntimeConfig(env);
        const provider = createProvider(runtime, new EnvironmentCredentialSource(env));
        const start = performance.now();
        // Mirror the product's structured request (schema + role-sized budget) so availability is not misjudged.
        const responseSchema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
        const response = await provider.generate({ model: config.model, messages: [{ role: 'user', content: 'Return JSON only: {"ok":true}' }], responseFormat: 'json', responseSchema, maxOutputTokens: 2048, temperature: 0 });
        preflight = { ok: true, requestedModel: config.model, returnedModel: response.model, usage: response.usage, wallMs: performance.now() - start };
      } catch (error) { preflight = { ok: false, status: error.statusCode ?? null, reason: redact(error.message) }; }
    }
    await json(join(folder, 'preflight.json'), preflight);
    if (!preflight.ok) { console.log(`${config.id}: unavailable (${preflight.status ?? preflight.reason})`); return; }
    // Cloud rows may review several cases at once (CONCLAVE_LAB_CONCURRENCY); each case is its own repository.
    const concurrency = config.mode === 'local' ? 1 : Math.max(1, Number(process.env.CONCLAVE_LAB_CONCURRENCY ?? 1));
    const queue = [...manifest.cases];
    await Promise.all(Array.from({ length: concurrency }, async () => { for (let item = queue.shift(); item; item = queue.shift()) {
      unchanged(item);
      const tracePath = join(folder, `${item.id}.calls.jsonl`);
      const args = ['--import', preload, cli, config.command, item.repository, question(item.objective), '--json', '--debug'];
      const result = await execute(args, item.repository, environment(config, tracePath));
      unchanged(item);
      await writeFile(join(folder, `${item.id}.stdout.json`), result.stdout);
      await writeFile(join(folder, `${item.id}.stderr.txt`), result.stderr);
      let output;
      try { output = JSON.parse(result.stdout); } catch { output = null; }
      const calls = await exists(tracePath) ? (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
      const ended = calls.filter((call) => call.event === 'finished');
      const termination = output?.terminationReason ?? null;
      const completed = result.status === 0 && termination === 'completed' && (output?.metrics?.modelCalls ?? 0) > 0;
      await json(join(folder, `${item.id}.meta.json`), {
        id: item.id, args, status: result.status, signal: result.signal, timedOut: result.timedOut, overflow: result.overflow,
        wallMs: result.wallMs, stdoutDigest: hash(result.stdout), termination, completed,
        returnedModels: [...new Set(ended.map((call) => call.returnedModel).filter(Boolean))],
        httpRequests: calls.filter((call) => call.event === 'started').length,
        httpFailures: ended.filter((call) => call.status >= 400).length,
        metrics: output?.metrics ?? null, agentsExecuted: output?.verdict?.traceSummary?.agentsExecuted ?? [],
      });
      console.log(`${config.id}/${item.id}: ${termination ?? (result.timedOut ? 'timeout' : 'execution-error')} (${Math.round(result.wallMs / 1000)}s)`);
    } }));
  }
  // Cloud rows run concurrently; local models are serialized to avoid RAM contention.
  await Promise.all([ ...configs.filter((row) => row.mode !== 'local').map(runConfig), (async () => { for (const config of configs.filter((row) => row.mode === 'local')) await runConfig(config); })() ]);
  assert.equal(await engineDigest(), engine, 'Engine changed during experiment');
  await json(join(directory, 'adjudications.json'), { rubricVersion: 2, instructions: 'Score specific localized defect signals, comparable to offline warning signals. Fill prediction defect|clean|uncertain; for defect also certainty supported|uncertain. Cite final answer and evidence. A concrete correct tentative diagnosis is a signal, never confirmed proof. Generic test gaps or rejected claims do not count. Leave failed cases unscored.', entries: [] });
  await table(directory);
}
async function table(directory) {
  const experiment = await readJson(join(directory, 'experiment.json'));
  const offline = await readJson(join(experiment.lab, 'score.json'));
  const groundTruth = new Map(offline.results.map((row) => [row.id, row.broken]));
  const adjudications = await exists(join(directory, 'adjudications.json')) ? await readJson(join(directory, 'adjudications.json')) : { entries: [] };
  const rows = [];
  for (const config of experiment.configs) {
    const folder = join(directory, config.id);
    const preflight = await exists(join(folder, 'preflight.json')) ? await readJson(join(folder, 'preflight.json')) : { ok: null, reason: 'Not started; no availability or quality conclusion yet.' };
    const results = [];
    for (const id of groundTruth.keys()) {
      if (!await exists(join(folder, `${id}.meta.json`))) continue;
      const meta = await readJson(join(folder, `${id}.meta.json`));
      const tracePath = join(folder, `${id}.calls.jsonl`);
      const calls = await exists(tracePath) ? (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
      const finished = calls.filter((call) => call.event === 'finished');
      const raw = await readFile(join(folder, `${id}.stdout.json`), 'utf8');
      assert.equal(hash(raw), meta.stdoutDigest, 'Model report changed after execution');
      const labels = adjudications.entries.filter((entry) => entry.configId === config.id && entry.caseId === id);
      assert.ok(labels.length <= 1, 'Duplicate adjudication');
      const label = labels[0];
      let classification = null;
      if (label) {
        assert.ok(meta.completed, 'Failed or incomplete execution must not receive a quality score');
        assert.ok(['defect', 'clean', 'uncertain'].includes(label.prediction));
        const output = JSON.parse(raw);
        const finalText = [output.verdict.answer, ...output.verdict.claims.supported.map((claim) => claim.statement)].join('\n');
        assert.ok(label.quote?.length > 10 && finalText.includes(label.quote), 'Adjudication must quote the final answer or supported claim verbatim');
        const ids = new Set(output.verdict.evidence.map((evidence) => evidence.id));
        assert.ok(Array.isArray(label.evidenceIds) && label.evidenceIds.every((id) => ids.has(id)), 'Invalid cited evidence');
        assert.ok(label.explanation?.length > 20, 'Explain the semantic adjudication');
        if (label.prediction === 'defect') {
          assert.ok(label.evidenceIds.length > 0, 'Defect detection requires source evidence');
          assert.ok(['supported', 'uncertain'].includes(label.certainty), 'Separate a tentative defect signal from a supported conclusion');
          if (label.certainty === 'supported') assert.ok(output.verdict.claims.supported.some((claim) => claim.statement.includes(label.quote)), 'Supported signal must quote a supported claim');
        }
        classification = label.prediction === 'uncertain' ? 'ABSTAIN' : groundTruth.get(id) ? label.prediction === 'defect' ? 'TP' : 'FN' : label.prediction === 'defect' ? 'FP' : 'TN';
      }
      results.push({ ...meta, httpRequests: calls.filter((call) => call.event === 'started').length,
        reportedInputTokens: finished.reduce((sum, call) => sum + (call.usage?.prompt_tokens ?? call.usage?.input_tokens ?? 0), 0),
        reportedOutputTokens: finished.reduce((sum, call) => sum + (call.usage?.completion_tokens ?? call.usage?.output_tokens ?? 0), 0),
        requestsWithoutUsage: calls.filter((call) => call.event === 'started').length - finished.filter((call) => call.usage).length,
        prediction: label?.prediction ?? null, certainty: label?.certainty ?? null, classification });
    }
    const completed = results.filter((row) => row.completed).length;
    const scored = results.filter((row) => row.classification).length;
    const counts = Object.fromEntries(['TP', 'FN', 'FP', 'TN', 'ABSTAIN'].map((key) => [key, results.filter((row) => row.classification === key).length]));
    const qualityReady = scored === groundTruth.size && completed === groundTruth.size;
    rows.push({ ...config, preflight, attempted: results.length, completed, scored, counts,
      tentativeTruePositives: results.filter((row) => row.classification === 'TP' && row.certainty === 'uncertain').length,
      supportedTruePositives: results.filter((row) => row.classification === 'TP' && row.certainty === 'supported').length,
      precision: qualityReady && counts.TP + counts.FP > 0 ? counts.TP / (counts.TP + counts.FP) : null,
      defectDetectionRate: qualityReady ? counts.TP / [...groundTruth.values()].filter(Boolean).length : null,
      wallSeconds: results.reduce((sum, row) => sum + row.wallMs, 0) / 1000,
      modelCalls: results.reduce((sum, row) => sum + (row.metrics?.modelCalls ?? 0), 0),
      httpRequests: results.reduce((sum, row) => sum + row.httpRequests, 0),
      inputTokens: results.reduce((sum, row) => sum + row.reportedInputTokens, 0),
      outputTokens: results.reduce((sum, row) => sum + row.reportedOutputTokens, 0),
      requestsWithoutUsage: results.reduce((sum, row) => sum + row.requestsWithoutUsage, 0),
      results });
  }
  await json(join(directory, 'comparison.json'), { experiment, rows, publishableAccuracy: false, limitations: ['One run per cell; stochastic variation unmeasured.', 'Synthetic corpus, small sample, external oracle.', 'Quality adjudicated by a model/human with citations; requires independent review.', 'Incomplete/error rows have no accuracy score.', 'No prices configured; monetary cost is unknown.', 'All attempted modes are retained, regardless of outcome.'] });
  const md = `# Comparação de modos — laboratório sintético\n\nUma execução por caso. Modelos locais também são IA; check é determinístico. Métricas não representam PRs reais.\n\n| Modo | Modelo solicitado | Completos | Avaliados | TP / FN / FP / TN / abstenção | Chamadas | Segundos | Estado |\n|---|---|---:|---:|---|---:|---:|---|\n| check offline | nenhum | ${groundTruth.size}/${groundTruth.size} | ${groundTruth.size}/${groundTruth.size} | ${offline.counts.TP} / ${offline.counts.FN} / ${offline.counts.FP} / ${offline.counts.TN} / 0 | 0 | — | baseline estrutural |\n${rows.map((row) => `| ${row.id} | ${row.model ?? '—'} | ${row.completed}/${groundTruth.size} | ${row.scored}/${groundTruth.size} | ${row.scored ? Object.values(row.counts).join(' / ') : '—'} | ${row.modelCalls} | ${row.wallSeconds.toFixed(1)} | ${row.preflight.ok ? row.completed === groundTruth.size ? row.scored === groundTruth.size ? 'avaliado' : 'aguarda classificação' : 'execuções incompletas/falhas' : (row.preflight.reason ?? 'indisponível').replaceAll('|', '/').replaceAll('\n', ' ')} |`).join('\n')}\n\nTempos e chamadas da tabela excluem preflight. Detalhes, modelos retornados, tokens e agentes efetivos em comparison.json e nos traces por caso. Custos monetários não medidos. Falha de infraestrutura não é falso negativo. Abstenção não é detecção. Nenhum resultado foi descartado por ser ruim.\n`;
  await writeFile(join(directory, 'COMPARACAO.md'), md);
  console.log(`Comparison: ${join(directory, 'COMPARACAO.md')}`);
}
if (action === 'run') await run(resolve(path)); else await table(resolve(path));
