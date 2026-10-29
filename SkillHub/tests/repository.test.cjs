const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { deflateRawSync } = require('node:zlib');
const { createRepository, LIMITS } = require('../lib/repository.cjs');
const { createStore } = require('../lib/store.cjs');

const COMMIT = 'a'.repeat(40);
const SOURCE = 'https://github.com/example/skills';
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});
function crc32(buffer) { let value = 0xffffffff; for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name), content = Buffer.from(item.content || ''), compressed = deflateRawSync(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(item.flags || 0, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(content), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(item.size ?? content.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(item.flags || 0, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(content), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(item.size ?? content.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((item.mode ?? (item.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
const skill = (name = 'review-code') => `---\nname: ${name}\ndescription: Review changes\n---\n\n# Instructions\nReview correctness.\n`;
const goodZip = () => zip([
  { name: 'skills-commit/skills/review/SKILL.md', content: skill() },
  { name: 'skills-commit/skills/review/references/guide.txt', content: 'Reference content' },
  { name: 'skills-commit/README.md', content: '# Skills' },
]);
function fetchFixture(archive = goodZip(), options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://api.github.com/')) return new Response(options.json || JSON.stringify({ sha: COMMIT }), { status: options.apiStatus || 200 });
    return new Response(archive, { status: options.zipStatus || 200, headers: options.zipHeaders || {} });
  };
  return { fetchImpl, calls };
}
async function fixture(t, fetchImpl) {
  const parent = path.resolve(__dirname, '../.test-data/repository-tests');
  await fs.mkdir(parent, { recursive: true });
  const base = await fs.mkdtemp(path.join(parent, 'case-'));
  t.after(async () => { assert.equal(path.dirname(base), parent); await fs.rm(base, { recursive: true, force: true }); });
  return { base, repository: createRepository({ cacheRoot: path.join(base, 'cache'), fetchImpl }), store: createStore(path.join(base, 'data')) };
}

test('resolves an exact public GitHub commit, safely previews and imports only selected skill files', async t => {
  const network = fetchFixture();
  const { repository, store, base } = await fixture(t, network.fetchImpl);
  const preview = await repository.preview({ url: SOURCE + '.git', ref: 'release/v1' });
  assert.equal(preview.url, SOURCE); assert.equal(preview.ref, 'release/v1'); assert.equal(preview.commit, COMMIT);
  assert.equal(preview.items.length, 1); assert.equal(preview.items[0].name, 'review-code'); assert.equal(preview.items[0].path, 'skills/review');
  assert.match(network.calls[0].url, /commits\/release%2Fv1$/);
  assert.match(network.calls[1].url, new RegExp('/zip/' + COMMIT + '$'));
  assert.equal(network.calls[0].init.redirect, 'error');
  const result = await repository.importSelected({ repoId: preview.id, skillIds: [preview.items[0].id] }, store);
  assert.equal(result.importedCount, 1); assert.deepEqual(result.failures, []);
  const imported = result.state.skills[0];
  assert.deepEqual(imported.originRepo, { url: SOURCE, ref: 'release/v1', commit: COMMIT, subpath: 'skills/review' });
  assert.equal(await fs.readFile(path.join(base, 'data/skills', imported.id, 'references/guide.txt'), 'utf8'), 'Reference content');
  const again = await repository.importSelected({ repoId: preview.id, skillIds: [preview.items[0].id] }, store);
  assert.equal(again.importedCount, 0); assert.equal(again.state.skills.length, 1);
});

test('uses a completed cache snapshot for the same commit and rotates preview tokens', async t => {
  const network = fetchFixture();
  const { repository, store } = await fixture(t, network.fetchImpl);
  const first = await repository.preview({ url: SOURCE });
  const next = await repository.preview({ url: SOURCE, ref: 'main' });
  assert.equal(network.calls.length, 3); assert.notEqual(first.id, next.id);
  await assert.rejects(repository.importSelected({ repoId: first.id, skillIds: [first.items[0].id] }, store), /หมดอายุ/);
  const arbitrary = await repository.importSelected({ repoId: next.id, skillIds: [path.resolve('SKILL.md')] }, store);
  assert.equal(arbitrary.importedCount, 0); assert.equal(arbitrary.failures.length, 1);
});

test('validates repo URLs and ref inputs before any network request', async t => {
  const network = fetchFixture(); const { repository } = await fixture(t, network.fetchImpl);
  for (const url of ['http://github.com/example/skills', 'https://github.com.evil.test/example/skills', 'https://user:pass@github.com/example/skills', 'https://github.com/example/skills/tree/main', 'https://github.com/example/skills?token=x', 'https://github.com/example/skills#x', 'file:///repo']) {
    await assert.rejects(repository.preview({ url }));
  }
  await assert.rejects(repository.preview({ url: SOURCE, ref: 'bad\0ref' }));
  assert.equal(network.calls.length, 0);
});

test('reports network failures, private or missing repositories and invalid commit metadata', async t => {
  for (const options of [{ apiStatus: 404 }, { apiStatus: 403 }, { json: '{broken' }, { json: JSON.stringify({ sha: '../bad' }) }, { zipStatus: 503 }]) {
    const { repository } = await fixture(t, fetchFixture(goodZip(), options).fetchImpl);
    await assert.rejects(repository.preview({ url: SOURCE }));
  }
});

test('rejects unsafe archive paths, symlinks and case-insensitive Windows collisions', async t => {
  const cases = [
    [{ name: '../escape.txt', content: 'bad' }],
    [{ name: '/absolute.txt', content: 'bad' }],
    [{ name: 'root/C:/bad.txt', content: 'bad' }],
    [{ name: 'root/x:stream', content: 'bad' }],
    [{ name: 'root/CON.txt', content: 'bad' }],
    [{ name: 'root/trailing./SKILL.md', content: skill() }],
    [{ name: 'root\\bad.txt', content: 'bad' }],
    [{ name: 'root/link', content: '../outside', mode: 0o120777 }],
    [{ name: 'root/skills/A.txt', content: 'a' }, { name: 'root/skills/a.txt', content: 'b' }],
    [{ name: 'root/Skills/a.txt', content: 'a' }, { name: 'root/skills/b.txt', content: 'b' }],
  ];
  for (const entries of cases) {
    const { repository, base } = await fixture(t, fetchFixture(zip(entries)).fetchImpl);
    await assert.rejects(repository.preview({ url: SOURCE }));
    assert.equal((await fs.readdir(path.join(base, 'cache'))).length, 0);
  }
});

test('bounds downloads, expanded entries, compression ratio and rejects malformed ZIPs', async t => {
  const archives = [Buffer.from('not a zip'), zip([{ name: 'root/large', content: 'a', size: LIMITS.fileBytes + 1 }]), zip([{ name: 'root/bomb', content: Buffer.alloc(2 * 1024 * 1024, 65) }])];
  for (const archive of archives) {
    const { repository } = await fixture(t, fetchFixture(archive).fetchImpl);
    await assert.rejects(repository.preview({ url: SOURCE }));
  }
  const { repository } = await fixture(t, fetchFixture(goodZip(), { zipHeaders: { 'content-length': String(LIMITS.downloadBytes + 1) } }).fetchImpl);
  await assert.rejects(repository.preview({ url: SOURCE }), /ใหญ่เกิน/);
});

test('rejects CRC corruption and incomplete cache markers instead of trusting partial snapshots', async t => {
  const damaged = goodZip();
  const centralOffset = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  damaged.writeUInt32LE(0, centralOffset + 16);
  const bad = await fixture(t, fetchFixture(damaged).fetchImpl);
  await assert.rejects(bad.repository.preview({ url: SOURCE }), /เสียหาย/);
  const network = fetchFixture(); const { repository, base } = await fixture(t, network.fetchImpl);
  await repository.preview({ url: SOURCE });
  const [snapshot] = await fs.readdir(path.join(base, 'cache'));
  await fs.writeFile(path.join(base, 'cache', snapshot, 'snapshot.json'), '{}');
  await assert.rejects(repository.preview({ url: SOURCE }), /แคช/);
});

test('previews local repositories read-only and reports partial failures without reading Git configuration', async t => {
  const network = fetchFixture(); const { repository, store, base } = await fixture(t, network.fetchImpl);
  const local = path.join(base, 'local');
  for (const name of ['first', 'second']) { await fs.mkdir(path.join(local, name), { recursive: true }); await fs.writeFile(path.join(local, name, 'SKILL.md'), skill(name)); }
  await fs.mkdir(path.join(local, '.git'), { recursive: true }); await fs.writeFile(path.join(local, '.git/config'), '[credential]\npassword=DO_NOT_READ');
  const preview = await repository.previewLocal(local);
  assert.equal(preview.items.length, 2); assert.equal(preview.commit, ''); assert.equal(preview.url, await fs.realpath(local)); assert.equal(network.calls.length, 0);
  await fs.unlink(path.join(local, 'second/SKILL.md'));
  const imported = await repository.importSelected({ repoId: preview.id, skillIds: preview.items.map(item => item.id) }, store);
  assert.equal(imported.importedCount, 1); assert.equal(imported.failures.length, 1); assert.equal(imported.state.skills[0].originRepo.commit, '');
  assert.equal(await fs.readFile(path.join(local, '.git/config'), 'utf8'), '[credential]\npassword=DO_NOT_READ');
});

test('rejects duplicate or oversized selections and explains empty repositories', async t => {
  const { repository, store } = await fixture(t, fetchFixture(zip([{ name: 'root/README.md', content: '# Empty' }])).fetchImpl);
  const preview = await repository.preview({ url: SOURCE });
  assert.equal(preview.items.length, 0); assert.ok(preview.warnings.some(w => w.includes('ไม่พบ')));
  for (const skillIds of [[], ['x', 'x'], Array.from({ length: 201 }, (_, i) => String(i))]) await assert.rejects(repository.importSelected({ repoId: preview.id, skillIds }, store));
});
