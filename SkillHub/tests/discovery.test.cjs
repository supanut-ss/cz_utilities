const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDiscovery, LIMITS } = require('../lib/discovery.cjs');
const { createStore } = require('../lib/store.cjs');

async function fixture(t) {
  const testRoot = path.resolve(__dirname, '../../../work/discovery-tests');
  await fs.mkdir(testRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testRoot, 'case-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  await fs.mkdir(root);
  return { base, root };
}
async function makeSkill(folder, name = 'Example') {
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: "${name}"\ndescription: A useful skill\n---\n# Instructions`);
}

test('finds nested skills only within configured roots, including missing status', async t => {
  const { base, root } = await fixture(t);
  await makeSkill(path.join(root, 'plugin', 'v1', 'skills', 'example'), 'Nested Example');
  await makeSkill(path.join(base, 'outside'), 'Outside');
  const discovery = createDiscovery({ roots: [{ path: root, provider: 'Codex' }, { path: path.join(base, 'missing'), provider: 'Claude' }] });
  const result = await discovery.scan();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, 'Nested Example');
  assert.equal(result.items[0].description, 'A useful skill');
  assert.equal(result.items[0].provider, 'Codex');
  assert.equal(result.items[0].path, await fs.realpath(path.join(root, 'plugin', 'v1', 'skills', 'example')));
  assert.equal(result.items[0].imported, false);
  assert.deepEqual(result.roots.map(r => r.status), ['scanned', 'missing']);
  assert.deepEqual(result.warnings, []);
});

test('does not recurse below a skill root and skips irrelevant directories', async t => {
  const { root } = await fixture(t);
  await makeSkill(path.join(root, 'parent'));
  await makeSkill(path.join(root, 'parent', 'references', 'nested'), 'Nested');
  await makeSkill(path.join(root, 'node_modules', 'hidden'), 'Dependency');
  await makeSkill(path.join(root, '.git', 'hidden'), 'Git');
  const result = await createDiscovery({ roots: [{ path: root, provider: 'Local' }] }).scan();
  assert.equal(result.items.length, 1);
  assert.ok(result.warnings.some(w => /build 2/.test(w)));
});

test('bounds depth and skill header size with truthful warnings', async t => {
  const { root } = await fixture(t);
  await makeSkill(path.join(root, ...Array(11).fill('deep')), 'Too Deep');
  const oversized = path.join(root, 'oversized');
  await fs.mkdir(oversized);
  await fs.writeFile(path.join(oversized, 'SKILL.md'), Buffer.alloc(LIMITS.skillBytes + 1));
  const result = await createDiscovery({ roots: [{ path: root, provider: 'Local' }] }).scan();
  assert.equal(result.items.length, 0);
  assert.ok(result.warnings.some(w => /10/.test(w)));
  assert.ok(result.warnings.some(w => /2 MB/.test(w)));
});

test('tokens are opaque, expire on refresh, and reject arbitrary supplied paths', async t => {
  const { base, root } = await fixture(t);
  await makeSkill(path.join(root, 'example'));
  const store = createStore(path.join(base, 'data'));
  const discovery = createDiscovery({ roots: [{ path: root, provider: 'Codex' }] });
  const first = await discovery.scan();
  const second = await discovery.scan();
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.ok(!first.items[0].id.includes(root));
  const result = await discovery.importSelected([first.items[0].id, path.join(root, 'example')], store);
  assert.equal(result.importedCount, 0);
  assert.equal(result.failures.length, 2);
  assert.equal(result.state.skills.length, 0);
});

test('imports snapshots idempotently, persists provenance, and marks imported paths', async t => {
  const { base, root } = await fixture(t);
  const folder = path.join(root, 'example');
  await makeSkill(folder);
  await fs.writeFile(path.join(folder, 'support.txt'), 'Source content');
  const store = createStore(path.join(base, 'data'));
  const discovery = createDiscovery({ roots: [{ path: root, provider: 'Codex' }] });
  const scan = await discovery.scan();
  const result = await discovery.importSelected([scan.items[0].id], store);
  assert.equal(result.importedCount, 1);
  assert.deepEqual(result.failures, []);
  assert.equal(result.state.skills[0].originPath, await fs.realpath(folder));
  const repeated = await discovery.importSelected([scan.items[0].id], store);
  assert.equal(repeated.importedCount, 0);
  const refreshed = await discovery.scan(await store.getState());
  assert.equal(refreshed.items[0].imported, true);
  await store.saveSkill({ ...result.state.skills[0], content: '# Edited snapshot' });
  assert.equal((await store.getState()).skills[0].originPath, await fs.realpath(folder));
  assert.match(await fs.readFile(path.join(folder, 'SKILL.md'), 'utf8'), /# Instructions/);
});

test('reports partial failures if a source disappears before import', async t => {
  const { base, root } = await fixture(t);
  await makeSkill(path.join(root, 'one'), 'One');
  await makeSkill(path.join(root, 'two'), 'Two');
  const store = createStore(path.join(base, 'data'));
  const discovery = createDiscovery({ roots: [{ path: root, provider: 'Local' }] });
  const scan = await discovery.scan();
  await fs.unlink(path.join(root, 'one', 'SKILL.md'));
  const result = await discovery.importSelected(scan.items.map(item => item.id), store);
  assert.equal(result.importedCount, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].name, 'One');
  assert.equal(result.state.skills[0].name, 'Two');
});

test('validates selection bounds and handles empty discovery', async t => {
  const { base, root } = await fixture(t);
  const store = createStore(path.join(base, 'data'));
  const discovery = createDiscovery({ roots: [{ path: root, provider: 'Local' }] });
  assert.deepEqual((await discovery.scan()).items, []);
  await assert.rejects(discovery.importSelected([], store), /200/);
  await assert.rejects(discovery.importSelected(Array.from({ length: 201 }, (_, i) => String(i)), store), /200/);
  await assert.rejects(discovery.importSelected(['same', 'same'], store), /ซ้ำ/);
  await assert.rejects(discovery.importSelected([{}], store));
  assert.throws(() => createDiscovery({ roots: [{ path: '../escape', provider: 'Local' }] }));
});

test('deduplicates overlapping roots by canonical path', async t => {
  const { root } = await fixture(t);
  const nested = path.join(root, 'nested');
  await makeSkill(path.join(nested, 'example'));
  const result = await createDiscovery({ roots: [{ path: root, provider: 'First' }, { path: nested, provider: 'Second' }] }).scan();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].provider, 'First');
});

test('caps candidates and reports incomplete discovery', async t => {
  const { root } = await fixture(t);
  for (let i = 0; i <= LIMITS.candidates; i++) await makeSkill(path.join(root, `skill-${String(i).padStart(4, '0')}`));
  const result = await createDiscovery({ roots: [{ path: root, provider: 'Local' }] }).scan();
  assert.equal(result.items.length, LIMITS.candidates);
  assert.ok(result.warnings.some(w => /ค้นหายังไม่ครบ.*ขีดจำกัด/.test(w)));
});

test('skips symlinks and rejects replacement with linked folders', async t => {
  const { base, root } = await fixture(t);
  const outside = path.join(base, 'outside');
  await makeSkill(outside, 'Outside');
  try { await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Host does not permit symlink creation'); throw error; }
  const discovery = createDiscovery({ roots: [{ path: root, provider: 'Local' }] });
  let scan = await discovery.scan();
  assert.equal(scan.items.length, 0);
  assert.ok(scan.warnings.some(w => /ลิงก์/.test(w)));
  const replace = path.join(root, 'replace');
  await makeSkill(replace);
  scan = await discovery.scan();
  await fs.rm(replace, { recursive: true });
  await fs.symlink(outside, replace, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await discovery.importSelected([scan.items[0].id], createStore(path.join(base, 'data')));
  assert.equal(result.importedCount, 0);
  assert.equal(result.failures.length, 1);
});
