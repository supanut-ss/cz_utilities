const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createInstaller } = require('../lib/installer.cjs');

async function fixture(t, extra = {}) {
  const scratch = path.resolve(__dirname, '../../../work/installer-tests');
  await fs.mkdir(scratch, { recursive: true });
  const base = await fs.mkdtemp(path.join(scratch, 'case-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), dataRoot = path.join(base, 'install-data'), native = path.join(home, '.test-ai', 'skills');
  await fs.mkdir(home);
  const state = { version: 1, skills: [{ id: 'skill-one', name: 'Example Skill', description: 'Useful instructions', source: 'created', content: '# Original instructions', fileCount: 1 }], profiles: [{ id: 'profile-one', name: 'Developer', skillIds: ['skill-one'] }] };
  const supporting = new Map();
  const store = {
    async getState() { return structuredClone(state); },
    async materializeSkill(id, destination) {
      const skill = state.skills.find(s => s.id === id);
      if (!skill) throw new Error('ไม่พบ Skill');
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, 'SKILL.md'), skill.content);
      for (const [name, content] of supporting) { await fs.mkdir(path.dirname(path.join(destination, name)), { recursive: true }); await fs.writeFile(path.join(destination, name), content); }
      return { path: destination, skill: structuredClone(skill) };
    }
  };
  const testTargets = extra.testTargets || [{ id: 'test-ai', name: 'Test AI', path: native, detected: true }];
  const installer = createInstaller({ home, dataRoot, store, env: {}, testTargets });
  const plan = () => installer.plan({ profileId: 'profile-one', targetIds: ['test-ai'] });
  return { base, home, dataRoot, native, state, store, supporting, installer, plan };
}

test('detects only existing configuration or executable evidence and marks ChatGPT unsupported', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.home, '.claude'));
  await fs.mkdir(path.join(f.home, '.vscode', 'extensions', 'github.copilot-1.0.0'), { recursive: true });
  const bin = path.join(f.base, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini'), '@echo marker');
  const installer = createInstaller({ home: f.home, dataRoot: f.dataRoot, store: f.store, env: { PATH: bin } });
  const targets = await installer.detectTargets();
  assert.equal(targets.find(t => t.id === 'claude').detected, true);
  assert.ok(targets.find(t => t.id === 'claude').evidence[0].includes('.claude'));
  assert.equal(targets.find(t => t.id === 'gemini').detected, true);
  assert.equal(targets.find(t => t.id === 'copilot').detected, true);
  assert.ok(targets.find(t => t.id === 'copilot').evidence.some(evidence => evidence.includes('github.copilot-1.0.0')));
  assert.equal(targets.find(t => t.id === 'codex').detected, false);
  assert.equal(targets.find(t => t.id === 'chatgpt').supported, false);
  assert.equal(await fs.readFile(path.join(bin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini'), 'utf8'), '@echo marker');
  assert.equal(await fs.stat(f.dataRoot).then(() => true, () => false), false);
});

test('plans and installs normalized created skills with supporting files and private receipts', async t => {
  const f = await fixture(t);
  f.supporting.set('references/guide.txt', 'Guidance');
  const plan = await f.plan();
  assert.equal(plan.entries[0].status, 'new');
  assert.equal(plan.entries[0].folder, 'example-skill');
  assert.equal(await fs.stat(f.native).then(() => true, () => false), false);
  const result = await f.installer.apply(plan.id);
  assert.equal(result.installedCount, 1);
  assert.deepEqual(result.failures, []);
  assert.match(await fs.readFile(path.join(f.native, 'example-skill', 'SKILL.md'), 'utf8'), /^---\nname: example-skill\ndescription: Useful instructions\n---\n# Original instructions/);
  assert.equal(await fs.readFile(path.join(f.native, 'example-skill', 'references', 'guide.txt'), 'utf8'), 'Guidance');
  assert.deepEqual(await fs.readdir(f.native), ['example-skill']);
  assert.equal((await fs.readdir(path.join(f.dataRoot, 'receipts'))).length, 1);
  assert.equal(f.state.skills[0].content, '# Original instructions');
});

test('managed repeat is unchanged; managed updates retain backups', async t => {
  const f = await fixture(t);
  let plan = await f.plan();
  await f.installer.apply(plan.id);
  plan = await f.plan();
  assert.equal(plan.entries[0].status, 'unchanged');
  let result = await f.installer.apply(plan.id);
  assert.equal(result.unchangedCount, 1);
  assert.equal(result.installedCount, 0);
  f.state.skills[0].content = '# Updated instructions';
  plan = await f.plan();
  assert.equal(plan.entries[0].status, 'update');
  result = await f.installer.apply(plan.id);
  assert.equal(result.installedCount, 1);
  assert.equal(result.backups.length, 1);
  assert.match(await fs.readFile(path.join(result.backups[0], 'SKILL.md'), 'utf8'), /Original instructions/);
  assert.match(await fs.readFile(path.join(f.native, 'example-skill', 'SKILL.md'), 'utf8'), /Updated instructions/);
});

test('unmanaged folders conflict even if content matches; user modifications conflict', async t => {
  const f = await fixture(t);
  const destination = path.join(f.native, 'example-skill');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'SKILL.md'), '# Original instructions');
  let plan = await f.plan();
  assert.equal(plan.entries[0].status, 'conflict');
  const conflict = await f.installer.apply(plan.id);
  assert.equal(conflict.installedCount, 0);
  assert.equal(conflict.failures.length, 1);
  assert.equal(await fs.readFile(path.join(destination, 'SKILL.md'), 'utf8'), '# Original instructions');
  await fs.rm(destination, { recursive: true });
  plan = await f.plan(); await f.installer.apply(plan.id);
  await fs.writeFile(path.join(destination, 'SKILL.md'), '# User modified');
  plan = await f.plan();
  assert.equal(plan.entries[0].status, 'conflict');
  assert.match(plan.entries[0].reason, /ถูกแก้ไข/);
});

test('rejects source and target changes after plan, and expires old tokens', async t => {
  const f = await fixture(t);
  let plan = await f.plan();
  const stale = plan.id;
  plan = await f.plan();
  await assert.rejects(f.installer.apply(stale), /หมดอายุ/);
  plan = await f.plan();
  f.state.skills[0].content = '# Changed after plan';
  let result = await f.installer.apply(plan.id);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /เนื้อหา Skill เปลี่ยน/);
  plan = await f.plan(); await f.installer.apply(plan.id);
  plan = await f.plan();
  await fs.writeFile(path.join(f.native, 'example-skill', 'SKILL.md'), '# User change after plan');
  result = await f.installer.apply(plan.id);
  assert.equal(result.failures.length, 1);
  assert.equal(await fs.readFile(path.join(f.native, 'example-skill', 'SKILL.md'), 'utf8'), '# User change after plan');
});

test('rejects malformed, reserved and mismatched frontmatter while preserving extensions', async t => {
  const f = await fixture(t);
  const invalid = ['---\nname: Bad_Name\ndescription: Valid\n---\nBody', '---\nname: con\ndescription: Valid\n---\nBody', '---\nname: good\ndescription: 42\n---\nBody', '---\nname: good\nname: duplicate\ndescription: Valid\n---\nBody', '---\nname: [broken\n---\nBody'];
  for (const content of invalid) { f.state.skills[0].content = content; assert.equal((await f.plan()).entries[0].status, 'conflict'); }
  f.state.skills[0].source = 'imported';
  f.state.skills[0].content = '# Missing YAML';
  assert.equal((await f.plan()).entries[0].status, 'conflict');
  const content = '---\nname: correct-name\ndescription: Valid description\nallowed-tools: Read\ncustom:\n  value: retained\n---\n# Body';
  f.state.skills[0].content = content;
  const plan = await f.plan();
  assert.equal(plan.entries[0].folder, 'correct-name');
  const result = await f.installer.apply(plan.id);
  assert.deepEqual(result.failures, []);
  assert.equal(await fs.readFile(path.join(f.native, 'correct-name', 'SKILL.md'), 'utf8'), content);
});

test('same folder from multiple selected skills conflicts', async t => {
  const f = await fixture(t);
  f.state.skills.push({ ...f.state.skills[0], id: 'skill-two' });
  f.state.profiles[0].skillIds.push('skill-two');
  const plan = await f.plan();
  assert.equal(plan.entries.length, 2);
  assert.ok(plan.entries.every(e => e.status === 'conflict'));
});

test('same repository subpath can update a new library revision; unrelated identities conflict', async t => {
  const f = await fixture(t);
  f.state.skills[0].originRepo = { url: 'https://github.com/example/repo', subpath: 'skills/example', commit: 'old' };
  let plan = await f.plan(); await f.installer.apply(plan.id);
  f.state.skills[0].id = 'new-revision';
  f.state.skills[0].originRepo.commit = 'new';
  f.state.skills[0].content = '# New repository revision';
  f.state.profiles[0].skillIds = ['new-revision'];
  plan = await f.plan();
  assert.equal(plan.entries[0].status, 'update');
  assert.equal((await f.installer.apply(plan.id)).installedCount, 1);
  f.state.skills[0].originRepo.subpath = 'unrelated/path';
  assert.equal((await f.plan()).entries[0].status, 'conflict');
});

test('corrupt or stale receipts never grant permission to overwrite', async t => {
  const f = await fixture(t);
  let plan = await f.plan(); await f.installer.apply(plan.id);
  const receiptFile = path.join(f.dataRoot, 'receipts', (await fs.readdir(path.join(f.dataRoot, 'receipts')))[0]);
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  await fs.writeFile(receiptFile, '{broken');
  assert.equal((await f.plan()).entries[0].status, 'conflict');
  await fs.writeFile(receiptFile, JSON.stringify({ ...receipt, targetPath: f.base }));
  assert.equal((await f.plan()).entries[0].status, 'conflict');
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  await fs.rm(path.join(f.native, 'example-skill'), { recursive: true });
  assert.equal((await f.plan()).entries[0].status, 'conflict');
});

test('rolls a managed update back if receipt publication fails', async t => {
  const f = await fixture(t);
  let plan = await f.plan(); await f.installer.apply(plan.id);
  const previous = await fs.readFile(path.join(f.native, 'example-skill', 'SKILL.md'), 'utf8');
  const receiptFile = path.join(f.dataRoot, 'receipts', (await fs.readdir(path.join(f.dataRoot, 'receipts')))[0]);
  const receiptBefore = await fs.readFile(receiptFile, 'utf8');
  f.state.skills[0].content = '# Update that fails';
  plan = await f.plan();
  const originalRename = fs.rename;
  fs.rename = async (from, to) => { if (to === receiptFile) throw new Error('จำลองความผิดพลาดขณะบันทึก'); return originalRename(from, to); };
  let result;
  try { result = await f.installer.apply(plan.id); } finally { fs.rename = originalRename; }
  assert.equal(result.installedCount, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(await fs.readFile(path.join(f.native, 'example-skill', 'SKILL.md'), 'utf8'), previous);
  assert.equal(await fs.readFile(receiptFile, 'utf8'), receiptBefore);
  assert.equal(result.backups.length, 1);
});

test('rejects target ancestry links and never writes through them', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside');
  await fs.mkdir(outside);
  try { await fs.symlink(outside, path.join(f.home, '.test-ai'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Host does not permit symlink creation'); throw error; }
  assert.equal((await f.installer.detectTargets())[0].detected, false);
  await assert.rejects(f.plan(), /ตรวจพบ/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('rejects Claude Code reserved names per target', async t => {
  const f = await fixture(t);
  const installer = createInstaller({ home: f.home, dataRoot: f.dataRoot, store: f.store, env: {}, testTargets: [{ id: 'claude', name: 'Claude Code', path: f.native, detected: true }] });
  for (const name of ['synced', 'anthropic-skills']) {
    f.state.skills[0].content = `---\nname: ${name}\ndescription: Valid description\n---\n# Body`;
    const plan = await installer.plan({ profileId: 'profile-one', targetIds: ['claude'] });
    assert.equal(plan.entries[0].status, 'conflict');
    assert.match(plan.entries[0].reason, /สงวนชื่อ/);
    assert.equal((await installer.apply(plan.id)).installedCount, 0);
  }
});

test('publication uses local staging instead of cross-volume renames from app data', async t => {
  const f = await fixture(t);
  const plan = await f.plan();
  const originalRename = fs.rename;
  const moves = [];
  fs.rename = async (from, to) => {
    moves.push({ from, to });
    if (from.startsWith(f.dataRoot + path.sep) && to.startsWith(f.native + path.sep)) { const error = new Error('Cross-device rename'); error.code = 'EXDEV'; throw error; }
    return originalRename(from, to);
  };
  let result;
  try { result = await f.installer.apply(plan.id); } finally { fs.rename = originalRename; }
  assert.equal(result.installedCount, 1);
  assert.deepEqual(result.failures, []);
  const publication = moves.find(move => move.to === path.join(f.native, 'example-skill'));
  assert.ok(publication.from.startsWith(path.dirname(f.native) + path.sep));
  assert.match(publication.from, /\.skillhub-stage-/);
  assert.ok(!publication.from.startsWith(f.native + path.sep));
  assert.deepEqual((await fs.readdir(path.dirname(f.native))).filter(name => name.startsWith('.skillhub-stage-')), []);
});

test('retains recoverable rollback outside provider roots when restore fails', async t => {
  const f = await fixture(t);
  let plan = await f.plan(); await f.installer.apply(plan.id);
  f.state.skills[0].content = '# Updated content';
  plan = await f.plan();
  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (to.endsWith('.json') && to.includes(`${path.sep}receipts${path.sep}`)) throw new Error('จำลองบันทึกไม่ได้');
    if (path.basename(from) === 'rollback') throw new Error('จำลองกู้คืนไม่ได้');
    return originalRename(from, to);
  };
  let result;
  try { result = await f.installer.apply(plan.id); } finally { fs.rename = originalRename; }
  assert.equal(result.installedCount, 0);
  assert.match(result.failures[0].error, /เก็บไฟล์กู้คืนไว้ที่/);
  const retained = (await fs.readdir(path.dirname(f.native))).find(name => name.startsWith('.skillhub-stage-'));
  assert.ok(retained);
  assert.match(await fs.readFile(path.join(path.dirname(f.native), retained, 'rollback', 'SKILL.md'), 'utf8'), /Original instructions/);
  assert.match(await fs.readFile(path.join(result.backups[0], 'SKILL.md'), 'utf8'), /Original instructions/);
});

test('selection plans install without creating or requiring synthetic profiles', async t => {
  const f = await fixture(t);
  f.state.profiles = [];
  const plan = await f.installer.planSelection({ skillIds: ['skill-one'], targetIds: ['test-ai'] });
  assert.equal(plan.entries[0].status, 'new');
  assert.equal((await f.installer.apply(plan.id)).installedCount, 1);
  assert.deepEqual(f.state.profiles, []);
  await assert.rejects(f.installer.planSelection({ skillIds: ['missing'], targetIds: ['test-ai'] }));
  await assert.rejects(f.installer.planSelection({ skillIds: ['skill-one', 'skill-one'], targetIds: ['test-ai'] }));
  const stale = await f.installer.planSelection({ skillIds: ['skill-one'], targetIds: ['test-ai'] });
  f.state.skills[0].content = '# Changed during transfer';
  const result = await f.installer.apply(stale.id);
  assert.equal(result.installedCount, 0);
  assert.equal(result.failures.length, 1);
});

test('deployment intents expose only logical ids from valid managed installations', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.installer.getDeploymentIntents(), []);
  const plan = await f.plan(); await f.installer.apply(plan.id);
  assert.deepEqual(await f.installer.getDeploymentIntents(), [{ targetId: 'test-ai', skillIds: ['skill-one'] }]);
  const receiptDirectory = path.join(f.dataRoot, 'receipts');
  await fs.writeFile(path.join(receiptDirectory, 'a'.repeat(64) + '.json'), '{broken');
  assert.deepEqual(await f.installer.getDeploymentIntents(), [{ targetId: 'test-ai', skillIds: ['skill-one'] }]);
  await fs.writeFile(path.join(f.native, 'example-skill', 'SKILL.md'), '# User managed edit');
  assert.deepEqual(await f.installer.getDeploymentIntents(), []);
});

test('deployment intents resolve managed repo identity after the installed library revision is removed', async t => {
  const f = await fixture(t);
  f.state.skills[0].originRepo = { url: 'https://github.com/example/skills', subpath: 'skills/example', commit: 'old' };
  const plan = await f.plan(); await f.installer.apply(plan.id);
  f.state.skills[0].id = 'new-revision';
  f.state.skills[0].originRepo.commit = 'new';
  assert.deepEqual(await f.installer.getDeploymentIntents(), [{ targetId: 'test-ai', skillIds: ['new-revision'] }]);
  f.state.skills[0].originRepo.url = 'https://github.com/another/skills';
  assert.deepEqual(await f.installer.getDeploymentIntents(), []);
});
