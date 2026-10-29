const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMigration } = require('../lib/migration.cjs');

test('automatic migration installs selections in batches of at most 200', async () => {
  const scratch = path.resolve(__dirname, '../.test-data/migration-tests');
  await fs.mkdir(scratch, { recursive: true });
  const base = await fs.mkdtemp(path.join(scratch, 'batch-'));
  try {
    const skills = Array.from({ length: 201 }, (_, index) => ({
      id: randomUUID(),
      name: `Batch Skill ${index + 1}`,
      description: 'Migration batch fixture',
      category: 'Test',
      content: `# Batch Skill ${index + 1}\n\nTest migration.`,
      updatedAt: new Date().toISOString(),
      source: 'created',
      fileCount: 1
    }));
    const profile = { id: randomUUID(), name: 'Batch Codex', provider: 'Codex', skillIds: skills.map(skill => skill.id) };
    const snapshot = { version: 1, skills, profiles: [profile] };
    const plans = new Map();
    const planSizes = [];
    const store = {
      getState: async () => ({ version: 1, skills, profiles: [profile] }),
      materializeSkill: async (id, destination) => {
        const skill = skills.find(item => item.id === id);
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, 'SKILL.md'), skill.content, 'utf8');
        return { skill };
      },
      mergeSnapshot: async input => ({
        state: { version: 1, skills: input.skills, profiles: input.profiles },
        skillMap: Object.fromEntries(input.skills.map(skill => [skill.id, skill.id])),
        profileMap: Object.fromEntries(input.profiles.map(item => [item.id, item.id])),
        addedSkills: input.skills.length,
        addedProfiles: input.profiles.length
      })
    };
    const installer = {
      getDeploymentIntents: async () => [{ targetId: 'codex', skillIds: skills.map(skill => skill.id) }],
      detectTargets: async () => [{ id: 'codex', name: 'Codex', detected: true, supported: true }],
      planSelection: async input => {
        planSizes.push(input.skillIds.length);
        assert.ok(input.skillIds.length <= 200);
        const id = randomUUID();
        plans.set(id, input.skillIds);
        return { id };
      },
      apply: async id => ({ installedCount: plans.get(id).length, unchangedCount: 0, failures: [], backups: [] })
    };
    const destination = path.join(base, 'export');
    await fs.mkdir(destination);
    const migration = createMigration({ dataRoot: path.join(base, 'migration'), store, installer });
    const exported = await migration.exportPackage(destination);
    const preview = await migration.preview(exported.packagePath);
    const result = await migration.restore({ previewId: preview.id, autoInstall: true });
    assert.deepEqual(planSizes, [200, 1]);
    assert.equal(result.addedSkills, 201);
    assert.equal(result.installedCount, 201);
    assert.deepEqual(result.failures, []);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
