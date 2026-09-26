// Harder, more realistic scenarios: multi-file modules, refactors mixed with the defect, and healthy
// changes that look dangerous. Objectives state only the PR intent, never the invariant a defect breaks,
// so nothing the reviewer sees hints at the answer; the oracles encode the baseline behavior.
// Ground truth stays OUTSIDE the reviewed repositories. No network or dependencies.

const paginationBaseline = `// Pagination helpers shared by list endpoints.
export function paginate(items, page = 1, size = 20) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
`;
const usersBaseline = `import { paginate } from './pagination.js';

const users = Array.from({ length: 45 }, (_, index) => ({ id: index + 1, name: \`user-\${index + 1}\` }));

export function listUsers(query = {}) {
  const page = Number(query.page ?? 1);
  const size = Number(query.size ?? 20);
  return { page, items: paginate(users, page, size) };
}
`;
const orderBaseline = `const DEFAULT_CURRENCY = 'BRL';

export function normalizeOrder(input) {
  const quantity = input.quantity ?? 1;
  const currency = input.currency ?? DEFAULT_CURRENCY;
  const notes = input.notes ?? '';
  return { sku: input.sku, quantity, currency, notes };
}
`;
const batchBaseline = `export async function runBatch(jobs, processJob) {
  const results = [];
  for (const job of jobs) {
    results.push(await processJob(job));
  }
  return results;
}
`;
const cacheModule = `export function createCache() {
  const entries = new Map();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => entries.set(key, value),
    delete: (key) => entries.delete(key),
  };
}
`;
const repoBaseline = `import { createCache } from './cache.js';

const store = new Map([[1, { id: 1, name: 'Ana', email: 'ana@example.com' }]]);
const cache = createCache();

export function getUser(id) {
  const cached = cache.get(id);
  if (cached) return cached;
  const user = store.get(id);
  cache.set(id, user);
  return user;
}

export function updateUser(id, changes) {
  const next = { ...store.get(id), ...changes };
  store.set(id, next);
  cache.delete(id);
  return next;
}
`;
const repoOracle = `assert.equal(subject.getUser(1).name, 'Ana');
subject.updateUser(1, { name: 'Bia' });
assert.equal(subject.getUser(1).name, 'Bia', 'getUser must return data written by updateUser');`;
const downloadsBaseline = `import { resolve, sep } from 'node:path';

const PUBLIC_ROOT = resolve('/srv/app/public');

export function resolveDownload(name) {
  const target = resolve(PUBLIC_ROOT, name);
  if (!target.startsWith(PUBLIC_ROOT + sep)) throw new Error('Forbidden path');
  return target;
}
`;
const downloadsOracle = `const confined = (name) => {
  let target;
  try { target = subject.resolveDownload(name); } catch (error) { if (/Forbidden/.test(error.message)) return true; throw error; }
  return target.startsWith('/srv/app/public/');
};
assert.equal(subject.resolveDownload('report.pdf'), '/srv/app/public/report.pdf');
for (const name of ['../secrets.env', '%2e%2e%2fsecrets.env', '..%2f..%2fetc%2fpasswd']) assert.ok(confined(name), 'download must stay in the public folder: ' + name);`;
const projectsBaseline = `import { requireOwner } from './auth.js';

const projects = new Map([[7, { id: 7, ownerId: 'u1', archived: false }]]);

export function deleteProject(user, id) {
  const project = projects.get(id);
  requireOwner(user, project);
  projects.delete(id);
  return { deleted: id };
}
`;
const authModule = `export function requireOwner(user, project) {
  if (!user || !project || project.ownerId !== user.id) {
    const error = new Error('Forbidden');
    error.status = 403;
    throw error;
  }
}
`;
const projectsOracle = `assert.throws(() => subject.deleteProject({ id: 'intruder' }, 7), /Forbidden/, 'non-owners must not delete');
if (subject.archiveProject) {
  assert.throws(() => subject.archiveProject({ id: 'intruder' }, 7), /Forbidden/, 'non-owners must not archive');
  assert.deepEqual(subject.archiveProject({ id: 'u1' }, 7), { archived: 7, by: 'u1' });
}
assert.deepEqual(subject.deleteProject({ id: 'u1' }, 7), { deleted: 7 });`;
const retryBaseline = `export async function withRetry(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!error.retryable) throw error;
    }
  }
  throw lastError;
}
`;
const retryOracle = `let charges = 0;
await assert.rejects(() => subject.withRetry(async () => { charges++; const error = new Error('card declined'); error.retryable = false; throw error; }), /card declined/);
assert.equal(charges, 1, 'a non-retryable payment error must not be retried');
let flaky = 0;
assert.equal(await subject.withRetry(async () => { flaky++; if (flaky < 2) { const error = new Error('timeout'); error.retryable = true; throw error; } return 'ok'; }), 'ok');`;
const widgetBaseline = `export class Widget {
  constructor(target) {
    this.target = target;
    this.resizes = 0;
    this.onResize = this.onResize.bind(this);
    target.addEventListener('resize', this.onResize);
  }

  onResize() {
    this.resizes++;
  }

  destroy() {
    this.target.removeEventListener('resize', this.onResize);
  }
}
`;
const widgetOracle = `const target = new EventTarget();
const widget = new subject.Widget(target);
target.dispatchEvent(new Event('resize'));
assert.equal(widget.resizes, 1);
widget.destroy();
target.dispatchEvent(new Event('resize'));
assert.equal(widget.resizes, 1, 'destroy must stop resize handling');`;
const searchBaseline = `export function createSearchStore(fetchResults) {
  let latest = 0;
  const state = { query: '', results: [] };
  return {
    state,
    async search(query) {
      const requestId = ++latest;
      state.query = query;
      const results = await fetchResults(query);
      if (requestId !== latest) return;
      state.results = results;
    },
  };
}
`;
const searchOracle = `const delays = { a: 30, ab: 5 };
const store = subject.createSearchStore((query) => new Promise((resolve) => setTimeout(() => resolve([query + '-result']), delays[query])));
await Promise.all([store.search('a'), store.search('ab')]);
assert.deepEqual(store.state.results, ['ab-result'], 'results must reflect the latest query');`;
const syncBaseline = `export async function syncAll(records, saveRecord) {
  await Promise.all(records.map((record) => saveRecord(record)));
  return { synced: records.length };
}
`;
const syncOracle = `assert.deepEqual(await subject.syncAll([1, 2], async () => {}), { synced: 2 });
await assert.rejects(() => subject.syncAll([1, 2], async (record) => { if (record === 2) throw new Error('save failed'); }), /save failed/);`;

export const cases = [
  {
    id: 'H01', category: 'boundary', title: 'Paginação pula a primeira página', broken: true, kind: null,
    objective: 'Add totalPages to the users list response.',
    baselineFiles: { 'src/pagination.js': paginationBaseline, 'src/users.js': usersBaseline },
    candidateFiles: {
      'src/pagination.js': `// Pagination helpers shared by list endpoints.
export function paginate(items, page = 1, size = 20) {
  const offset = page * size;
  return items.slice(offset, offset + size);
}

export function pageCount(total, size = 20) {
  return Math.max(1, Math.ceil(total / size));
}
`,
      'src/users.js': `import { pageCount, paginate } from './pagination.js';

const users = Array.from({ length: 45 }, (_, index) => ({ id: index + 1, name: \`user-\${index + 1}\` }));

export function listUsers(query = {}) {
  const page = Number(query.page ?? 1);
  const size = Number(query.size ?? 20);
  return { page, totalPages: pageCount(users.length, size), items: paginate(users, page, size) };
}
`,
    },
    entry: 'src/users.js',
    oracle: `const first = subject.listUsers({ page: 1, size: 20 });
assert.equal(first.items[0].id, 1, 'page 1 must start with the first user');
assert.equal(subject.listUsers({ page: 3, size: 20 }).items.length, 5);`,
  },
  {
    id: 'H02', category: 'falsy-default', title: 'Quantidade zero vira 1', broken: true, kind: null,
    objective: 'Centralize order defaults (quantity, currency, notes) in a single table.',
    baselineFiles: { 'src/orders.js': orderBaseline },
    candidateFiles: {
      'src/orders.js': `const DEFAULTS = Object.freeze({ quantity: 1, currency: 'BRL', notes: '' });

export function normalizeOrder(input) {
  return {
    sku: input.sku,
    quantity: input.quantity || DEFAULTS.quantity,
    currency: input.currency ?? DEFAULTS.currency,
    notes: input.notes ?? DEFAULTS.notes,
  };
}
`,
    },
    entry: 'src/orders.js',
    oracle: `assert.equal(subject.normalizeOrder({ sku: 'A', quantity: 0 }).quantity, 0, 'explicit zero quantity must be preserved');
assert.equal(subject.normalizeOrder({ sku: 'A' }).quantity, 1);
assert.equal(subject.normalizeOrder({ sku: 'A' }).currency, 'BRL');`,
  },
  {
    id: 'H03', category: 'async', title: 'forEach assíncrono retorna antes de processar', broken: true, kind: null,
    objective: 'Refactor the batch runner for readability.',
    baselineFiles: { 'src/batch.js': batchBaseline },
    candidateFiles: {
      'src/batch.js': `export async function runBatch(jobs, processJob) {
  const results = [];
  jobs.forEach(async (job) => {
    results.push(await processJob(job));
  });
  return results;
}
`,
    },
    entry: 'src/batch.js',
    oracle: `const results = await subject.runBatch([1, 2, 3], (job) => new Promise((resolve) => setTimeout(() => resolve(job * 10), 5)));
assert.deepEqual(results, [10, 20, 30], 'runBatch must wait for every job');`,
  },
  {
    id: 'H04', category: 'state', title: 'Cache não é invalidado após update', broken: true, kind: null,
    objective: 'Extract a persist() helper for user writes to prepare for the database migration.',
    baselineFiles: { 'src/cache.js': cacheModule, 'src/users-repo.js': repoBaseline },
    candidateFiles: {
      'src/cache.js': cacheModule,
      'src/users-repo.js': `import { createCache } from './cache.js';

const store = new Map([[1, { id: 1, name: 'Ana', email: 'ana@example.com' }]]);
const cache = createCache();

function persist(id, user) {
  store.set(id, user);
  return user;
}

export function getUser(id) {
  const cached = cache.get(id);
  if (cached) return cached;
  const user = store.get(id);
  cache.set(id, user);
  return user;
}

export function updateUser(id, changes) {
  return persist(id, { ...store.get(id), ...changes });
}
`,
    },
    entry: 'src/users-repo.js', oracle: repoOracle,
  },
  {
    id: 'H05', category: 'logic', title: 'Comparador de ordenação retorna booleano', broken: true, kind: null,
    objective: "Stop mutating the caller's array when sorting products by price.",
    baselineFiles: { 'src/catalog.js': `export function sortByPrice(products) {
  return products.sort((left, right) => left.price - right.price);
}
` },
    candidateFiles: { 'src/catalog.js': `export function sortByPrice(products) {
  return [...products].sort((left, right) => left.price > right.price);
}
` },
    entry: 'src/catalog.js',
    oracle: `const input = [{ price: 30 }, { price: 10 }, { price: 20 }];
assert.deepEqual(subject.sortByPrice(input).map((item) => item.price), [10, 20, 30], 'products must be sorted by price');`,
  },
  {
    id: 'H06', category: 'security', title: 'Path traversal via nome codificado', broken: true, kind: null,
    objective: 'Support URL-encoded file names (spaces, accents) in the downloads endpoint.',
    baselineFiles: { 'src/downloads.js': downloadsBaseline },
    candidateFiles: {
      'src/downloads.js': `import { join, resolve } from 'node:path';

const PUBLIC_ROOT = resolve('/srv/app/public');

export function resolveDownload(name) {
  if (name.includes('..')) throw new Error('Forbidden path');
  return join(PUBLIC_ROOT, decodeURIComponent(name));
}
`,
    },
    entry: 'src/downloads.js', oracle: downloadsOracle,
  },
  {
    id: 'H07', category: 'numeric', title: 'Total do carrinho com erro de ponto flutuante', broken: true, kind: null,
    objective: 'Simplify the cart total calculation.',
    baselineFiles: { 'src/cart.js': `export function cartTotal(items) {
  const cents = items.reduce((sum, item) => sum + Math.round(item.price * 100) * item.quantity, 0);
  return cents / 100;
}
` },
    candidateFiles: { 'src/cart.js': `export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
` },
    entry: 'src/cart.js',
    oracle: `assert.equal(subject.cartTotal([{ price: 0.1, quantity: 3 }]), 0.3, 'total must be exact to the cent');
assert.equal(subject.cartTotal([{ price: 19.9, quantity: 2 }, { price: 0.2, quantity: 1 }]), 40);`,
  },
  {
    id: 'H08', category: 'security', title: 'Novo endpoint sem checagem de dono', broken: true, kind: null,
    objective: 'Add project archiving.',
    baselineFiles: { 'src/auth.js': authModule, 'src/projects.js': projectsBaseline },
    candidateFiles: {
      'src/auth.js': authModule,
      'src/projects.js': `import { requireOwner } from './auth.js';

const projects = new Map([[7, { id: 7, ownerId: 'u1', archived: false }]]);

function findProject(id) {
  const project = projects.get(id);
  if (!project) throw new Error('Not found');
  return project;
}

export function deleteProject(user, id) {
  const project = findProject(id);
  requireOwner(user, project);
  projects.delete(id);
  return { deleted: id };
}

export function archiveProject(user, id) {
  const project = findProject(id);
  project.archived = true;
  return { archived: id, by: user.id };
}
`,
    },
    entry: 'src/projects.js',
    oracle: projectsOracle,
  },
  {
    id: 'H09', category: 'resilience', title: 'Retry repete cobrança não idempotente', broken: true, kind: null,
    objective: 'Simplify the retry helper used by the payments client.',
    baselineFiles: { 'src/retry.js': retryBaseline },
    candidateFiles: { 'src/retry.js': `export async function withRetry(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
` },
    entry: 'src/retry.js', oracle: retryOracle,
  },
  {
    id: 'H10', category: 'lifecycle', title: 'bind gera referência diferente no destroy', broken: true, kind: null,
    objective: 'Modernize the Widget class and remove constructor boilerplate.',
    baselineFiles: { 'src/widget.js': widgetBaseline },
    candidateFiles: { 'src/widget.js': `export class Widget {
  resizes = 0;

  constructor(target) {
    this.target = target;
    target.addEventListener('resize', this.onResize.bind(this));
  }

  onResize() {
    this.resizes++;
  }

  destroy() {
    this.target.removeEventListener('resize', this.onResize.bind(this));
  }
}
` },
    entry: 'src/widget.js', oracle: widgetOracle,
  },
  {
    id: 'H11', category: 'validation', title: 'Regex de username perdeu as âncoras', broken: true, kind: null,
    objective: 'Allow dots in usernames.',
    baselineFiles: { 'src/username.js': `export function isValidUsername(value) {
  return /^[a-z0-9_]{3,16}$/.test(value);
}
` },
    candidateFiles: { 'src/username.js': `const USERNAME = /[a-z0-9_.]{3,16}/;

export function isValidUsername(value) {
  return USERNAME.test(value);
}
` },
    entry: 'src/username.js',
    oracle: `assert.equal(subject.isValidUsername('ana_silva'), true);
assert.equal(subject.isValidUsername('<script>abc'), false, 'invalid characters must be rejected');
assert.equal(subject.isValidUsername('a'.repeat(30)), false, 'long usernames must be rejected');`,
  },
  {
    id: 'H12', category: 'state', title: 'Carrinhos compartilham o mesmo array', broken: true, kind: null,
    objective: 'Reduce allocations when creating carts.',
    baselineFiles: { 'src/cart-factory.js': `export function createCart(owner) {
  return { owner, items: [], coupon: null };
}
` },
    candidateFiles: { 'src/cart-factory.js': `const EMPTY_CART = Object.freeze({ items: [], coupon: null });

export function createCart(owner) {
  return { ...EMPTY_CART, owner };
}
` },
    entry: 'src/cart-factory.js',
    oracle: `const first = subject.createCart('ana');
const second = subject.createCart('bia');
first.items.push({ sku: 'A' });
assert.equal(second.items.length, 0, 'carts must not share items');`,
  },
  {
    id: 'H13', category: 'async', title: 'Resposta antiga sobrescreve a busca atual', broken: true, kind: null,
    objective: 'Simplify the search store.',
    baselineFiles: { 'src/search-store.js': searchBaseline },
    candidateFiles: { 'src/search-store.js': `export function createSearchStore(fetchResults) {
  const state = { query: '', results: [] };
  return {
    state,
    async search(query) {
      state.query = query;
      state.results = await fetchResults(query);
    },
  };
}
` },
    entry: 'src/search-store.js', oracle: searchOracle,
  },
  {
    id: 'H14', category: 'error-handling', title: 'allSettled esconde falha de gravação', broken: true, kind: null,
    objective: 'Make syncAll wait for every save even when one is slow.',
    baselineFiles: { 'src/sync.js': syncBaseline },
    candidateFiles: { 'src/sync.js': `export async function syncAll(records, saveRecord) {
  const outcomes = await Promise.allSettled(records.map((record) => saveRecord(record)));
  const synced = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
  return { synced: records.length, failed: records.length - synced };
}
` },
    entry: 'src/sync.js', oracle: syncOracle,
  },
  {
    id: 'H15', category: 'boundary', title: 'Refactor correto da paginação (parece off-by-one)', broken: false, kind: null,
    objective: 'Add totalPages to the users list response.',
    baselineFiles: { 'src/pagination.js': paginationBaseline, 'src/users.js': usersBaseline },
    candidateFiles: {
      'src/pagination.js': `// Pagination helpers shared by list endpoints.
export function paginate(items, page = 1, size = 20) {
  const offset = size * Math.max(page - 1, 0);
  const end = offset + size;
  return items.slice(offset, end);
}

export function pageCount(total, size = 20) {
  return Math.max(1, Math.ceil(total / size));
}
`,
      'src/users.js': `import { pageCount, paginate } from './pagination.js';

const users = Array.from({ length: 45 }, (_, index) => ({ id: index + 1, name: \`user-\${index + 1}\` }));

export function listUsers(query = {}) {
  const page = Number(query.page ?? 1);
  const size = Number(query.size ?? 20);
  return { page, totalPages: pageCount(users.length, size), items: paginate(users, page, size) };
}
`,
    },
    entry: 'src/users.js',
    oracle: `assert.equal(subject.listUsers({ page: 1, size: 20 }).items[0].id, 1);
assert.equal(subject.listUsers({ page: 3, size: 20 }).items.length, 5);
assert.equal(subject.listUsers({ page: 2, size: 20 }).items[0].id, 21);`,
  },
  {
    id: 'H16', category: 'falsy-default', title: 'Defaults centralizados com checagem explícita de nulo', broken: false, kind: null,
    objective: 'Centralize order defaults (quantity, currency, notes) in a single table.',
    baselineFiles: { 'src/orders.js': orderBaseline },
    candidateFiles: { 'src/orders.js': `const DEFAULTS = Object.freeze({ quantity: 1, currency: 'BRL', notes: '' });

const valueOr = (value, fallback) => (value === undefined || value === null ? fallback : value);

export function normalizeOrder(input) {
  return {
    sku: input.sku,
    quantity: valueOr(input.quantity, DEFAULTS.quantity),
    currency: valueOr(input.currency, DEFAULTS.currency),
    notes: valueOr(input.notes, DEFAULTS.notes),
  };
}
` },
    entry: 'src/orders.js',
    oracle: `assert.equal(subject.normalizeOrder({ sku: 'A', quantity: 0 }).quantity, 0);
assert.equal(subject.normalizeOrder({ sku: 'A' }).quantity, 1);
assert.equal(subject.normalizeOrder({ sku: 'A', notes: null }).notes, '');`,
  },
  {
    id: 'H17', category: 'async', title: 'Promise.all concorrente preservando ordem', broken: false, kind: null,
    objective: 'Speed up the batch runner by processing jobs concurrently.',
    baselineFiles: { 'src/batch.js': batchBaseline },
    candidateFiles: { 'src/batch.js': `export async function runBatch(jobs, processJob) {
  return Promise.all(jobs.map((job) => processJob(job)));
}
` },
    entry: 'src/batch.js',
    oracle: `const delays = { 1: 20, 2: 5, 3: 10 };
const results = await subject.runBatch([1, 2, 3], (job) => new Promise((resolve) => setTimeout(() => resolve(job * 10), delays[job])));
assert.deepEqual(results, [10, 20, 30]);`,
  },
  {
    id: 'H18', category: 'state', title: 'Cache atualizado em vez de apagado', broken: false, kind: null,
    objective: 'Extract a persist() helper for user writes to prepare for the database migration.',
    baselineFiles: { 'src/cache.js': cacheModule, 'src/users-repo.js': repoBaseline },
    candidateFiles: {
      'src/cache.js': cacheModule,
      'src/users-repo.js': `import { createCache } from './cache.js';

const store = new Map([[1, { id: 1, name: 'Ana', email: 'ana@example.com' }]]);
const cache = createCache();

function persist(id, user) {
  store.set(id, user);
  cache.set(id, user);
  return user;
}

export function getUser(id) {
  const cached = cache.get(id);
  if (cached) return cached;
  const user = store.get(id);
  cache.set(id, user);
  return user;
}

export function updateUser(id, changes) {
  return persist(id, { ...store.get(id), ...changes });
}
`,
    },
    entry: 'src/users-repo.js', oracle: repoOracle,
  },
  {
    id: 'H19', category: 'security', title: 'Decodifica antes de validar o caminho (correto)', broken: false, kind: null,
    objective: 'Support URL-encoded file names (spaces, accents) in the downloads endpoint.',
    baselineFiles: { 'src/downloads.js': downloadsBaseline },
    candidateFiles: { 'src/downloads.js': `import { resolve, sep } from 'node:path';

const PUBLIC_ROOT = resolve('/srv/app/public');

export function resolveDownload(name) {
  const decoded = decodeURIComponent(name);
  const target = resolve(PUBLIC_ROOT, decoded);
  if (!target.startsWith(PUBLIC_ROOT + sep)) throw new Error('Forbidden path');
  return target;
}
` },
    entry: 'src/downloads.js', oracle: downloadsOracle,
  },
  {
    id: 'H20', category: 'security', title: 'Checagem de dono movida para um wrapper', broken: false, kind: null,
    objective: 'Add project archiving.',
    baselineFiles: { 'src/auth.js': authModule, 'src/projects.js': projectsBaseline },
    candidateFiles: {
      'src/auth.js': `${authModule}
export function ownerOnly(load, action) {
  return (user, id) => {
    const resource = load(id);
    requireOwner(user, resource);
    return action(user, resource);
  };
}
`,
      'src/projects.js': `import { ownerOnly } from './auth.js';

const projects = new Map([[7, { id: 7, ownerId: 'u1', archived: false }]]);

function findProject(id) {
  const project = projects.get(id);
  if (!project) throw new Error('Not found');
  return project;
}

export const deleteProject = ownerOnly(findProject, (_user, project) => {
  projects.delete(project.id);
  return { deleted: project.id };
});

export const archiveProject = ownerOnly(findProject, (user, project) => {
  project.archived = true;
  return { archived: project.id, by: user.id };
});
`,
    },
    entry: 'src/projects.js',
    oracle: projectsOracle,
  },
];
