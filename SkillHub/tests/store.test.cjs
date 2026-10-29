const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createStore, LIMITS } = require('../lib/store.cjs');

async function fixture(t) {
  const testRoot = path.resolve(__dirname, '../.test-data/store-tests');
  await fs.mkdir(testRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testRoot, 'skillhub-store-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'data');
  return { base, root, store: createStore(root) };
}
const skillInput = (name = 'Example') => ({ name, description: 'A test skill', category: 'Development', content: '# Example\n\nReview the source.' });

test('materializes current skill content into a new folder only', async t => {
  const { store, base } = await fixture(t);
  const state = await store.saveSkill(skillInput());
  const destination = path.join(base, 'prepared');
  const prepared = await store.materializeSkill(state.skills[0].id, destination);
  assert.equal(prepared.skill.id, state.skills[0].id);
  assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), skillInput().content);
  await assert.rejects(store.materializeSkill(state.skills[0].id, destination));
  assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), skillInput().content);
  await assert.rejects(store.materializeSkill('../bad', path.join(base, 'bad')));
});

test('preserves repository provenance through edits and materializes support files', async t => {
  const { store, base } = await fixture(t);
  const source = path.join(base, 'repo-skill');
  await fs.mkdir(path.join(source, 'references'), {recursive:true});
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Repo skill');
  await fs.writeFile(path.join(source, 'references', 'guide.txt'), 'Repo support');
  const repo = {url:'https://github.com/example/skills', ref:'main', commit:'a'.repeat(40), subpath:'skills/review'};
  let state = await store.importSkill(source, {repo});
  const skill = state.skills[0];
  state = await store.saveSkill({...skill, content:'# Edited repo skill'});
  assert.deepEqual(state.skills[0].originRepo, repo);
  const destination = path.join(base, 'materialized');
  await store.materializeSkill(skill.id, destination);
  assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'),'utf8'),'# Edited repo skill');
  assert.equal(await fs.readFile(path.join(destination, 'references', 'guide.txt'),'utf8'),'Repo support');
  await assert.rejects(store.importSkill(source,{repo:{...repo,subpath:'../escape'}}));
});

test('rejects materializing inside private storage or to an ancestor', async t => {
  const { store, root, base } = await fixture(t);
  const state = await store.saveSkill(skillInput());
  const id = state.skills[0].id;
  await assert.rejects(store.materializeSkill(id,path.join(root,'other')));
  await assert.rejects(store.materializeSkill(id,base));
});

test('starts empty and persists independent profiles and skills', async t => {
  const { store, root } = await fixture(t);
  const initial = await store.getState();
  assert.equal(initial.skills.length, 0);
  assert.equal(initial.profiles.length, 4);
  assert.equal(initial.dataPath, root);
  const state = await store.saveSkill(skillInput());
  const id = state.skills[0].id;
  await store.saveProfile({ ...state.profiles[0], skillIds: [id] });
  const reopened = await createStore(root).getState();
  assert.equal(reopened.skills[0].content, skillInput().content);
  assert.deepEqual(reopened.profiles[0].skillIds, [id]);
  assert.deepEqual(reopened.profiles[1].skillIds, []);
});

test('serializes concurrent mutations without losing writes', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 15 }, (_, i) => store.saveSkill(skillInput(`Skill ${i}`))));
  assert.equal((await store.getState()).skills.length, 15);
});

test('validates input and recovers mutation queue after rejection', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.saveSkill({ ...skillInput(), name: ' ' }));
  await assert.rejects(store.saveSkill({ ...skillInput(), content: 'x'.repeat(LIMITS.contentBytes + 1) }));
  await assert.rejects(store.saveSkill({ ...skillInput(), id: '../escape' }));
  await assert.rejects(store.deleteSkill('../escape'));
  await assert.rejects(store.saveProfile({ name: 'Bad', provider: 'AI', skillIds: ['missing'] }));
  await assert.rejects(store.deleteProfile('missing'));
  const state = await store.saveSkill(skillInput());
  const profile = state.profiles[0];
  await assert.rejects(store.saveProfile({ ...profile, skillIds: [state.skills[0].id, state.skills[0].id] }));
  assert.equal((await store.getState()).skills.length, 1);
});

test('imports support files, edits main content, and exports non-overwriting bundles', async t => {
  const { store, base } = await fixture(t);
  const source = path.join(base, 'source');
  await fs.mkdir(path.join(source, 'references'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: "Imported Example"\ndescription: Safe reference\n---\n# Original');
  await fs.writeFile(path.join(source, 'references', 'guide.txt'), 'Supporting material');
  const state = await store.importSkill(source);
  const skill = state.skills[0];
  assert.equal(skill.name, 'Imported Example');
  assert.equal(skill.fileCount, 2);
  assert.equal(skill.source, 'imported');
  assert.equal(skill.originPath, await fs.realpath(source));
  await store.saveSkill({ ...skill, content: '# Edited main instruction' });
  assert.equal((await store.importSkill(source)).skills.length, 1);
  assert.equal((await store.getState()).skills[0].originPath, skill.originPath);
  await store.saveProfile({ ...state.profiles[0], skillIds: [skill.id] });
  const out = path.join(base, 'exports');
  await fs.mkdir(out);
  await fs.writeFile(path.join(out, 'keep.txt'), 'Leave me alone');
  const first = await store.exportProfile(state.profiles[0].id, out);
  const second = await store.exportProfile(state.profiles[0].id, out);
  assert.notEqual(first.path, second.path);
  assert.equal(first.count, 1);
  assert.equal(await fs.readFile(path.join(first.path, 'skills', skill.id, 'SKILL.md'), 'utf8'), '# Edited main instruction');
  assert.equal(await fs.readFile(path.join(first.path, 'skills', skill.id, 'references', 'guide.txt'), 'utf8'), 'Supporting material');
  assert.equal(await fs.readFile(path.join(out, 'keep.txt'), 'utf8'), 'Leave me alone');
  assert.equal(JSON.parse(await fs.readFile(path.join(first.path, 'manifest.json'), 'utf8')).profile.id, state.profiles[0].id);
});

test('deleting a skill cleans every profile assignment', async t => {
  const { store } = await fixture(t);
  const state = await store.saveSkill(skillInput());
  const id = state.skills[0].id;
  for (const profile of state.profiles) await store.saveProfile({ ...profile, skillIds: [id] });
  const deleted = await store.deleteSkill(id);
  assert.equal(deleted.skills.length, 0);
  assert.ok(deleted.profiles.every(p => p.skillIds.length === 0));
  await store.deleteProfile(deleted.profiles[0].id);
  assert.equal((await store.getState()).profiles.length, 3);
});

test('rejects missing main file, oversized imports, and exports with no skills', async t => {
  const { store, base } = await fixture(t);
  const source = path.join(base, 'source');
  await fs.mkdir(source);
  await assert.rejects(store.importSkill(source), /SKILL.md/);
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Main');
  await fs.writeFile(path.join(source, 'huge.bin'), Buffer.alloc(LIMITS.bytes + 1));
  await assert.rejects(store.importSkill(source), /20 MB/);
  const state = await store.getState();
  await assert.rejects(store.exportProfile(state.profiles[0].id, base), /อย่างน้อย/);
  await assert.rejects(store.exportProfile('../escape', base));
});

test('rejects directory links and linked state without following targets', async t => {
  const { store, base, root } = await fixture(t);
  const source = path.join(base, 'source');
  const external = path.join(base, 'external');
  await fs.mkdir(source);
  await fs.mkdir(external);
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Main');
  try { await fs.symlink(external, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Host does not permit symlink creation'); throw error; }
  await assert.rejects(store.importSkill(source), /ลิงก์/);
  await store.getState();
  const linkedRoot = path.join(base, 'linked-root');
  await fs.symlink(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createStore(linkedRoot).getState(), /ลิงก์/);
});

test('corrupt and unsupported state is preserved rather than reset', async t => {
  const { store, root } = await fixture(t);
  await store.getState();
  const stateFile = path.join(root, 'state.json');
  await fs.writeFile(stateFile, '{ broken');
  await assert.rejects(store.getState(), /ไฟล์ข้อมูล/);
  assert.equal(await fs.readFile(stateFile, 'utf8'), '{ broken');
  const unsupported = JSON.stringify({ version: 900, skills: [], profiles: [] });
  await fs.writeFile(stateFile, unsupported);
  await assert.rejects(store.saveSkill(skillInput()), /เวอร์ชัน/);
  assert.equal(await fs.readFile(stateFile, 'utf8'), unsupported);
});

test('revalidates imported support files at export time', async t => {
  const { store, base, root } = await fixture(t);
  const source = path.join(base, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'SKILL.md'), '# Main');
  const state = await store.importSkill(source);
  const skill = state.skills[0];
  await store.saveProfile({ ...state.profiles[0], skillIds: [skill.id] });
  await fs.unlink(path.join(root, 'skills', skill.id, 'SKILL.md'));
  const out = path.join(base, 'out');
  await fs.mkdir(out);
  await assert.rejects(store.exportProfile(state.profiles[0].id, out), /ไม่ครบ/);
  assert.deepEqual(await fs.readdir(out), []);
});

test('exports cannot write inside the app data directory', async t => {
  const { store, root } = await fixture(t);
  const state = await store.saveSkill(skillInput());
  await store.saveProfile({ ...state.profiles[0], skillIds: [state.skills[0].id] });
  await assert.rejects(store.exportProfile(state.profiles[0].id, root), /นอกพื้นที่ข้อมูล/);
  assert.deepEqual((await store.getState()).skills.map(s => s.name), ['Example']);
});

function portableSkill(overrides = {}) {
  return { id: 'portable-skill', name: 'Portable Skill', description: 'Portable instructions', category: 'Development', content: '# Portable instructions', source: 'created', fileCount: 1, updatedAt: '2026-10-29T00:00:00.000Z', ...overrides };
}
function portableSnapshot(skills = [portableSkill()], profiles) {
  return { version: 1, skills, profiles: profiles || [{ id: 'portable-profile', name: 'Portable profile', provider: 'Codex', skillIds: skills.map(skill => skill.id) }] };
}
async function payloadFor(base, snapshot, supporting = {}) {
  const folder = path.join(base, `payload-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(path.join(folder, 'skills'), { recursive: true });
  for (const skill of snapshot.skills) {
    const skillFolder = path.join(folder, 'skills', skill.id);
    await fs.mkdir(skillFolder);
    await fs.writeFile(path.join(skillFolder, 'SKILL.md'), skill.content);
    for (const [name, content] of Object.entries(supporting[skill.id] || {})) {
      const file = path.join(skillFolder, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
  }
  return folder;
}

test('merges transfer snapshots additively with supports, source types and portable repo metadata', async t => {
  const { store, base } = await fixture(t);
  const httpsRepo = { url: 'https://github.com/example/skills', ref: 'main', commit: 'a'.repeat(40), subpath: 'skills/example' };
  const snapshot = portableSnapshot([
    portableSkill({ fileCount: 2, originPath: path.join(base, 'old-machine') }),
    portableSkill({ id: 'repo-skill', name: 'Repo Skill', source: 'imported', fileCount: 2, originRepo: httpsRepo }),
    portableSkill({ id: 'local-skill', name: 'Local Skill', source: 'imported', originRepo: { url: path.join(base, 'old-local-repo'), ref: '', commit: '', subpath: '' } })
  ]);
  const payload = await payloadFor(base, snapshot, { 'portable-skill': { 'references/guide.txt': 'Created support' }, 'repo-skill': { 'assets/data.txt': 'Repo support' } });
  const merged = await store.mergeSnapshot(snapshot, payload);
  assert.equal(merged.addedSkills, 3);
  assert.equal(merged.addedProfiles, 1);
  assert.equal(merged.skillMap['portable-skill'], 'portable-skill');
  assert.equal(merged.state.skills.find(skill => skill.id === 'portable-skill').source, 'created');
  assert.equal(merged.state.skills.find(skill => skill.id === 'portable-skill').originPath, undefined);
  assert.deepEqual(merged.state.skills.find(skill => skill.id === 'repo-skill').originRepo, httpsRepo);
  assert.equal(merged.state.skills.find(skill => skill.id === 'local-skill').originRepo, undefined);
  const materialized = path.join(base, 'materialized');
  await store.materializeSkill('portable-skill', materialized);
  assert.equal(await fs.readFile(path.join(materialized, 'references', 'guide.txt'), 'utf8'), 'Created support');
  assert.equal(await fs.readFile(path.join(materialized, 'SKILL.md'), 'utf8'), '# Portable instructions');
  const repeated = await store.mergeSnapshot(snapshot, payload);
  assert.equal(repeated.addedSkills, 0);
  assert.equal(repeated.addedProfiles, 0);
  assert.deepEqual(repeated.skillMap, merged.skillMap);
  assert.deepEqual(repeated.profileMap, merged.profileMap);
});

test('remaps different skill and profile id collisions without replacing destination data', async t => {
  const { store, base } = await fixture(t);
  const before = await store.saveSkill(skillInput('Keep original'));
  const source = portableSkill({ id: before.skills[0].id });
  const snapshot = portableSnapshot([source], [{ id: before.profiles[0].id, name: 'Incoming profile', provider: 'Codex', skillIds: [source.id] }]);
  const merged = await store.mergeSnapshot(snapshot, await payloadFor(base, snapshot));
  assert.notEqual(merged.skillMap[source.id], source.id);
  assert.notEqual(merged.profileMap[before.profiles[0].id], before.profiles[0].id);
  assert.equal(merged.state.skills.find(skill => skill.id === before.skills[0].id).name, 'Keep original');
  assert.deepEqual(merged.state.profiles.find(profile => profile.id === merged.profileMap[before.profiles[0].id]).skillIds, [merged.skillMap[source.id]]);
  assert.deepEqual(merged.state.profiles.find(profile => profile.id === before.profiles[0].id).skillIds, []);
});

test('deduplicates identical content with different ids and remaps duplicate profile assignments', async t => {
  const { store, base } = await fixture(t);
  const snapshot = portableSnapshot();
  const first = await store.mergeSnapshot(snapshot, await payloadFor(base, snapshot));
  const duplicate = portableSnapshot([portableSkill({ id: 'another-id' }), portableSkill({ id: 'third-id' })]);
  const merged = await store.mergeSnapshot(duplicate, await payloadFor(base, duplicate));
  assert.equal(merged.addedSkills, 0);
  assert.equal(merged.skillMap['another-id'], first.skillMap['portable-skill']);
  assert.equal(merged.skillMap['third-id'], first.skillMap['portable-skill']);
  assert.equal(merged.addedProfiles, 0);
  assert.deepEqual(merged.state.profiles.find(profile => profile.id === merged.profileMap['portable-profile']).skillIds, ['portable-skill']);
});

test('validates all transfer payloads before changing library state', async t => {
  const { store, base, root } = await fixture(t);
  await store.saveSkill(skillInput('Keep original'));
  const before = await fs.readFile(path.join(root, 'state.json'), 'utf8');
  const snapshot = portableSnapshot([portableSkill(), portableSkill({ id: 'missing-support', fileCount: 2 })]);
  const payload = await payloadFor(base, snapshot);
  await assert.rejects(store.mergeSnapshot(snapshot, payload), /ไม่ครบ|จำนวนไม่ตรง/);
  assert.equal(await fs.readFile(path.join(root, 'state.json'), 'utf8'), before);
  assert.equal(await fs.stat(path.join(root, 'skills')).then(() => true, () => false), false);
  await fs.writeFile(path.join(payload, 'skills', 'portable-skill', 'SKILL.md'), '# Tampered');
  await assert.rejects(store.mergeSnapshot(snapshot, payload), /เนื้อหา/);
  assert.equal(await fs.readFile(path.join(root, 'state.json'), 'utf8'), before);
  const invalid = portableSnapshot([portableSkill({ id: '../escape' })]);
  await assert.rejects(store.mergeSnapshot(invalid, payload));
});

test('cleans only newly copied assets if atomic merge commit fails', async t => {
  const { store, base, root } = await fixture(t);
  await store.saveSkill(skillInput('Keep original'));
  const statePath = path.join(root, 'state.json');
  const before = await fs.readFile(statePath, 'utf8');
  const snapshot = portableSnapshot();
  const payload = await payloadFor(base, snapshot);
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === statePath) throw new Error('จำลองบันทึกไม่ได้'); return rename(from, to); };
  try { await assert.rejects(store.mergeSnapshot(snapshot, payload), /จำลอง/); } finally { fs.rename = rename; }
  assert.equal(await fs.readFile(statePath, 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.join(root, 'skills')), []);
});
