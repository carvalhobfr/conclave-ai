// Ground truth stays OUTSIDE the reviewed repositories. No network or dependencies.
const lifecycle = `export function mount(target, handler) {
  target.addEventListener('tick', handler);
  return () => target.removeEventListener('tick', handler);
}
`;
const eventOracle = `const target = new EventTarget();
let calls = 0;
const dispose = subject.mount(target, () => calls++);
target.dispatchEvent(new Event('tick'));
assert.equal(calls, 1, 'mount must attach a handler');
dispose();
target.dispatchEvent(new Event('tick'));
assert.equal(calls, 1, 'disposed handler must not run');`;
const storeOracle = `const values = new Map();
globalThis.localStorage = {
  setItem: (key, value) => values.set(key, value),
  getItem: (key) => values.get(key) ?? null,
};
subject.save('Alice');
assert.equal(subject.load(), 'Alice', 'saved data must survive a subsequent read');`;

export const cases = [
  {
    id: '01', title: 'Listener continua ativo depois de desmontar', broken: true,
    objective: 'Manter a inscrição em eventos e interromper callbacks após dispose.',
    kind: 'unreleased-resource',
    baseline: lifecycle,
    candidate: `export function mount(target, handler) {
  target.addEventListener('tick', handler);
  return () => {};
}
`, oracle: eventOracle,
  },
  {
    id: '02', title: 'Timer não é cancelado', broken: true,
    objective: 'Iniciar atualização periódica e cancelar o timer ao encerrar.',
    kind: 'unreleased-resource',
    baseline: `export function start(tick) {
  const timer = setInterval(tick, 100);
  return () => clearInterval(timer);
}
`,
    candidate: `export function start(tick) {
  const timer = setInterval(tick, 100);
  return () => {};
}
`,
    oracle: `const live = new Set();
globalThis.setInterval = (callback) => { live.add(callback); return callback; };
globalThis.clearInterval = (id) => live.delete(id);
const stop = subject.start(() => {});
assert.equal(live.size, 1, 'a timer must be registered');
stop();
assert.equal(live.size, 0, 'stop must release its timer');`,
  },
  {
    id: '03', title: 'Falha de gravação vira sucesso', broken: true,
    objective: 'Salvar alterações e propagar uma falha de gravação ao chamador.',
    kind: 'discarded-error',
    baseline: `export async function save(write) {
  await write();
  return { saved: true };
}
`,
    candidate: `export async function save(write) {
  try { await write(); } catch {}
  return { saved: true };
}
`,
    oracle: `assert.deepEqual(await subject.save(async () => {}), { saved: true });
await assert.rejects(() => subject.save(async () => { throw new Error('disk full'); }), /disk full/);`,
  },
  {
    id: '04', title: 'Gravação e leitura usam chaves diferentes', broken: true,
    objective: 'Preservar o nome salvo entre gravação e leitura do armazenamento.',
    kind: 'inconsistent-key',
    baseline: `const PROFILE_KEY = 'profile';
export function save(value) { localStorage.setItem(PROFILE_KEY, value); }
export function load() { return localStorage.getItem(PROFILE_KEY); }
`,
    candidate: `const PROFILE_KEY = 'profile';
export function save(value) { localStorage.setItem('profiles', value); }
export function load() { return localStorage.getItem(PROFILE_KEY); }
`, oracle: storeOracle,
  },
  {
    id: '05', title: 'Cleanup com mesmo nome mas outro callback', broken: true,
    objective: 'Remover exatamente o callback inscrito durante mount.',
    kind: 'unreleased-resource',
    baseline: lifecycle,
    candidate: `export function mount(target, handler) {
  target.addEventListener('tick', handler);
  return () => stop(target, () => {});
}
function stop(target, handler) {
  target.removeEventListener('tick', handler);
}
`, oracle: eventOracle,
  },
  {
    id: '06', title: 'Sucesso visual sem persistência', broken: true,
    objective: 'Salvar o perfil e disponibilizar o valor para leitura posterior.',
    kind: null,
    baseline: `export function save(value) { localStorage.setItem('profile', value); return { saved: true }; }
export function load() { return localStorage.getItem('profile'); }
`,
    candidate: `export function save(value) { return { saved: true }; }
export function load() { return localStorage.getItem('profile'); }
`, oracle: storeOracle,
  },
  {
    id: '07', title: 'Usuário comum recebe permissão administrativa', broken: true,
    objective: 'Permitir exclusão somente para administradores autenticados.',
    kind: null,
    baseline: `export function canDelete(user) {
  return user !== null && user.role === 'admin';
}
`,
    candidate: `export function canDelete(user) {
  return user !== null && user.role !== 'admin';
}
`,
    oracle: `assert.equal(subject.canDelete(null), false);
assert.equal(subject.canDelete({ role: 'admin' }), true, 'admin must be allowed');
assert.equal(subject.canDelete({ role: 'viewer' }), false, 'viewer must be denied');`,
  },
  {
    id: '08', title: 'Cleanup correto no próprio módulo', broken: false,
    objective: 'Refatorar a desmontagem preservando inscrição e remoção do callback.',
    kind: 'unreleased-resource',
    baseline: lifecycle,
    candidate: `export function mount(target, handler) {
  target.addEventListener('tick', handler);
  const dispose = () => target.removeEventListener('tick', handler);
  return dispose;
}
`, oracle: eventOracle,
  },
  {
    id: '09', title: 'Cleanup correto delegado para outro módulo', broken: false,
    objective: 'Centralizar a desmontagem em outro módulo sem deixar callbacks ativos.',
    kind: 'unreleased-resource',
    baseline: lifecycle,
    candidate: `import { cleanup } from './cleanup.js';
export function mount(target, handler) {
  target.addEventListener('tick', handler);
  return () => cleanup(target, handler);
}
`,
    extra: { 'src/cleanup.js': `export function cleanup(target, handler) {
  target.removeEventListener('tick', handler);
}
` }, oracle: eventOracle,
  },
  {
    id: '10', title: 'Refatoração saudável com texto que parece defeituoso', broken: false,
    objective: 'Preservar o cálculo do total ao reorganizar documentação e implementação.',
    kind: null,
    baseline: `export function total(price, quantity) { return price * quantity; }
`,
    candidate: `// Example of forbidden code: setInterval(tick, 100); try { save(); } catch {}
export function total(price, quantity) {
  const result = price * quantity;
  return result;
}
`,
    oracle: `assert.equal(subject.total(12, 3), 36);
assert.equal(subject.total(12, 0), 0);
assert.equal(subject.total(0, 5), 0);`,
  },
];
