const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const yauzl = require('yauzl');
const { createStore } = require('../lib/store.cjs');
const { createInstaller } = require('../lib/installer.cjs');

const root = path.resolve(__dirname, '..');
const scratch = path.join(root, '.test-data', 'migration-desktop');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const safePath = path.join(systemRoot, 'System32');
const sourceElectron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

function testEnvironment(base, home, library, scanRoot, extra = {}) {
  return {
    ...process.env,
    PATH: safePath,
    Path: safePath,
    CODEX_HOME: '',
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(base, 'appdata'),
    LOCALAPPDATA: path.join(base, 'localappdata'),
    TEMP: path.join(base, 'temp'),
    TMP: path.join(base, 'temp'),
    SKILL_HUB_TEST_MODE: '1',
    SKILL_HUB_TEST_DATA: library,
    SKILL_HUB_TEST_HOME: home,
    SKILL_HUB_TEST_SCAN_ROOT: scanRoot,
    SKILL_HUB_TEST_PORTABLE_EXE: '',
    SKILL_HUB_TEST_SIDECAR: '',
    PORTABLE_EXECUTABLE_FILE: '',
    ...extra
  };
}

async function createApp(executable, base, home, library, scanRoot, extra = {}) {
  const source = path.resolve(executable).toLowerCase() === path.resolve(sourceElectron).toLowerCase();
  return electron.launch({
    executablePath: executable,
    args: source ? [root] : [],
    env: testEnvironment(base, home, library, scanRoot, extra)
  });
}

async function closeApp(app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {});
  await app.close().catch(() => {});
}

async function fileExists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = new Map();
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

async function waitForApp(app) {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.locator('.sidebar-transfer').waitFor();
  return page;
}

async function runMachineTransfer(executable, label) {
  const base = await fs.mkdtemp(path.join(scratch, `${label}-`));
  let sourceApp, destinationApp, restartedApp;
  try {
    const sourceRoot = path.join(base, 'source');
    const sourceHome = path.join(sourceRoot, 'home');
    const sourceLibrary = path.join(sourceRoot, 'library');
    const sourceScan = path.join(sourceRoot, 'scan');
    const sourceUserData = path.join(sourceRoot, 'electron-user-data');
    const exportDestination = path.join(base, 'export');
    const stubFolder = path.join(base, 'source-stub');
    for (const folder of [
      path.join(sourceHome, '.codex'), path.join(sourceHome, '.claude'),
      sourceScan, exportDestination, stubFolder,
      path.join(base, 'temp'), path.join(base, 'appdata'), path.join(base, 'localappdata')
    ]) await fs.mkdir(folder, { recursive: true });
    const sourceStub = path.join(stubFolder, 'SkillHub.exe');
    const stubBytes = Buffer.concat([Buffer.from('MZ'), Buffer.from('portable-app-fixture')]);
    await fs.writeFile(sourceStub, stubBytes);

    const sourceStore = createStore(sourceLibrary);
    let sourceState = await sourceStore.getState();
    sourceState = await sourceStore.saveSkill({
      name: 'Created Helper',
      description: 'Created on the source machine',
      category: 'Development',
      content: '# Created Helper\n\nKeep the generated Skill available after transfer.'
    });
    const createdSkill = sourceState.skills.at(-1);
    const repositoryFolder = path.join(sourceRoot, 'repo', 'skills', 'repo-helper');
    await fs.mkdir(path.join(repositoryFolder, 'references'), { recursive: true });
    await fs.writeFile(path.join(repositoryFolder, 'SKILL.md'), '---\nname: repo-helper\ndescription: Imported from a repository\n---\n\n# Repo Helper\nUse the source snapshot.', 'utf8');
    await fs.writeFile(path.join(repositoryFolder, 'references', 'guide.md'), 'Repository support file.', 'utf8');
    sourceState = await sourceStore.importSkill(repositoryFolder, { repo: {
      url: 'https://github.com/example/skills', ref: 'main', commit: 'a'.repeat(40), subpath: 'skills/repo-helper'
    } });
    const repositorySkill = sourceState.skills.find(skill => skill.name === 'repo-helper');
    assert.ok(repositorySkill);
    sourceState = await sourceStore.saveProfile({ name: 'Transfer Codex', provider: 'Codex', skillIds: [createdSkill.id, repositorySkill.id] });
    sourceState = await sourceStore.saveProfile({ name: 'Transfer Claude', provider: 'Claude Code', skillIds: [repositorySkill.id] });
    assert.ok(sourceState.profiles.some(profile => profile.name === 'Transfer Codex'));

    const sourceInstaller = createInstaller({
      home: sourceHome,
      dataRoot: path.join(sourceUserData, 'installer'),
      store: sourceStore,
      env: testEnvironment(sourceRoot, sourceHome, sourceLibrary, sourceScan)
    });
    const detectedSource = await sourceInstaller.detectTargets();
    for (const targetId of ['codex', 'claude']) assert.equal(detectedSource.find(target => target.id === targetId)?.detected, true, `${label}: source ${targetId} fixture not detected`);
    for (const targetId of ['codex', 'claude']) {
      const plan = await sourceInstaller.planSelection({ skillIds: [createdSkill.id, repositorySkill.id], targetIds: [targetId] });
      const result = await sourceInstaller.apply(plan.id);
      assert.equal(result.installedCount, 2, `${label}: source installation to ${targetId}`);
    }
    assert.deepEqual(
      (await sourceInstaller.getDeploymentIntents()).map(item => item.targetId).sort(),
      ['claude', 'codex']
    );

    sourceApp = await createApp(executable, base, sourceHome, sourceLibrary, sourceScan, { SKILL_HUB_TEST_PORTABLE_EXE: sourceStub });
    const sourcePage = await waitForApp(sourceApp);
    await sourceApp.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, exportDestination);
    await sourcePage.locator('.sidebar-transfer').click();
    await sourcePage.getByRole('button', { name: 'สร้างโฟลเดอร์ย้ายเครื่อง', exact: true }).click();
    const exportRegion = sourcePage.getByRole('region', { name: 'ผลการสร้างชุดย้ายเครื่อง', exact: true });
    await exportRegion.waitFor();
    assert.match(await exportRegion.innerText(), /รวมตัวแอปรุ่นพกพาแล้ว/);
    const outputPaths = await exportRegion.locator('.transfer-path code').allTextContents();
    const transferFolder = outputPaths[0];
    const packagePath = outputPaths[1];
    assert.equal(path.dirname(packagePath), transferFolder);
    assert.deepEqual(await fs.readFile(path.join(transferFolder, 'SkillHub.exe')), stubBytes);

    const zip = await readZip(packagePath);
    const manifestText = zip.get('manifest.json').toString('utf8');
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.snapshot.skills.length, 2);
    assert.ok(manifest.snapshot.profiles.some(profile => profile.name === 'Transfer Codex'));
    assert.deepEqual(manifest.deployments.map(item => item.targetId).sort(), ['claude', 'codex']);
    const archivedRepo = manifest.snapshot.skills.find(skill => skill.name === 'repo-helper');
    assert.equal(Object.hasOwn(archivedRepo, 'originPath'), false);
    assert.deepEqual(archivedRepo.originRepo, { url: 'https://github.com/example/skills', ref: 'main', commit: 'a'.repeat(40), subpath: 'skills/repo-helper' });
    assert.ok(zip.has(`skills/${repositorySkill.id}/references/guide.md`));
    assert.equal(zip.get(`skills/${repositorySkill.id}/references/guide.md`).toString('utf8'), 'Repository support file.');
    assert.equal(manifestText.toLowerCase().includes(sourceRoot.toLowerCase()), false);
    await closeApp(sourceApp);
    sourceApp = null;

    const destinationRoot = path.join(base, 'destination');
    const destinationHome = path.join(destinationRoot, 'home');
    const destinationLibrary = path.join(destinationRoot, 'library');
    const destinationScan = path.join(destinationRoot, 'scan');
    for (const folder of [
      path.join(destinationHome, '.codex'), destinationScan,
      path.join(base, 'temp'), path.join(base, 'appdata'), path.join(base, 'localappdata')
    ]) await fs.mkdir(folder, { recursive: true });
    const destinationStore = createStore(destinationLibrary);
    let destinationState = await destinationStore.saveSkill({
      name: 'Destination Note', description: 'Keep destination data', category: 'Personal', content: '# Destination Note\n\nKeep this local skill.'
    });
    const destinationSkill = destinationState.skills[0];
    const defaultCodex = destinationState.profiles[0];
    destinationState = await destinationStore.saveProfile({ ...defaultCodex, skillIds: [destinationSkill.id] });

    destinationApp = await createApp(executable, base, destinationHome, destinationLibrary, destinationScan, {
      PORTABLE_EXECUTABLE_FILE: path.join(transferFolder, 'SkillHub.exe')
    });
    const destinationPage = await waitForApp(destinationApp);
    const previewHeading = destinationPage.getByRole('heading', { name: 'พร้อมนำเข้าที่เครื่องนี้', exact: true });
    await previewHeading.waitFor();
    const autoInstall = destinationPage.getByRole('checkbox', { name: /ติดตั้งให้ AI ที่พบในเครื่องนี้โดยอัตโนมัติ/ });
    assert.equal(await autoInstall.isChecked(), true);
    assert.ok(await destinationPage.locator('.transfer-target').filter({ hasText: 'Codex' }).innerText().then(text => text.includes('พบในเครื่องนี้')));
    assert.ok(await destinationPage.locator('.transfer-target').filter({ hasText: 'Claude Code' }).innerText().then(text => text.includes('ยังไม่พบในเครื่องนี้')));
    await destinationPage.getByRole('button', { name: 'นำเข้าและติดตั้งให้ AI', exact: true }).click();
    const restoreRegion = destinationPage.getByRole('region', { name: 'ผลการย้ายเครื่อง', exact: true });
    await restoreRegion.waitFor();
    const counts = await restoreRegion.locator('.transfer-result-counts').innerText();
    assert.match(counts, /เพิ่ม 2 Skill/);
    assert.match(counts, /ติดตั้ง 2 รายการ/);
    assert.match(await restoreRegion.locator('.transfer-skipped').innerText(), /Claude Code/);

    destinationState = await destinationStore.getState();
    assert.equal(destinationState.skills.length, 3);
    assert.ok(destinationState.skills.some(skill => skill.id === destinationSkill.id));
    const restoredCreated = destinationState.skills.find(skill => skill.name === 'Created Helper');
    const restoredRepo = destinationState.skills.find(skill => skill.name === 'repo-helper');
    assert.ok(restoredCreated && restoredRepo);
    assert.equal(Object.hasOwn(restoredRepo, 'originPath'), false);
    assert.equal(restoredRepo.originRepo.commit, 'a'.repeat(40));
    assert.equal(destinationState.profiles.find(profile => profile.id === defaultCodex.id).skillIds[0], destinationSkill.id);
    assert.equal(destinationState.profiles.find(profile => profile.name === 'Transfer Codex').skillIds.length, 2);
    assert.ok(destinationState.profiles.some(profile => profile.name === 'Transfer Claude' && profile.skillIds.includes(restoredRepo.id)));
    const installedRoot = path.join(destinationHome, '.agents', 'skills');
    assert.match(await fs.readFile(path.join(installedRoot, 'created-helper', 'SKILL.md'), 'utf8'), /Created Helper/);
    assert.equal(await fs.readFile(path.join(installedRoot, 'repo-helper', 'references', 'guide.md'), 'utf8'), 'Repository support file.');
    await assert.rejects(fs.access(path.join(destinationHome, '.claude', 'skills')));

    await destinationPage.getByRole('button', { name: 'ปิด', exact: true }).click();
    await destinationPage.locator('.sidebar-transfer').click();
    await destinationApp.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, packagePath);
    await destinationPage.getByRole('button', { name: 'เปิดชุดย้ายเครื่อง', exact: true }).click();
    await destinationPage.getByRole('heading', { name: 'พร้อมนำเข้าที่เครื่องนี้', exact: true }).waitFor();
    await destinationPage.getByRole('button', { name: 'นำเข้าและติดตั้งให้ AI', exact: true }).click();
    await destinationPage.getByRole('region', { name: 'ผลการย้ายเครื่อง', exact: true }).waitFor();
    const repeatedCounts = await destinationPage.locator('.transfer-result-counts').innerText();
    assert.match(repeatedCounts, /เพิ่ม 0 Skill/);
    assert.match(repeatedCounts, /ติดตั้ง 0 รายการ/);
    assert.match(repeatedCounts, /ไฟล์เหมือนเดิม 2 รายการ/);
    assert.equal((await destinationStore.getState()).skills.length, 3);
    await closeApp(destinationApp);
    destinationApp = null;

    restartedApp = await createApp(executable, base, destinationHome, destinationLibrary, destinationScan, {
      PORTABLE_EXECUTABLE_FILE: path.join(transferFolder, 'SkillHub.exe')
    });
    const restartedPage = await waitForApp(restartedApp);
    await restartedPage.waitForTimeout(750);
    assert.equal(await restartedPage.getByRole('heading', { name: 'พร้อมนำเข้าที่เครื่องนี้', exact: true }).count(), 0);
    assert.equal(await restartedPage.evaluate(() => window.skillHub.pendingMigration()), null);
    await closeApp(restartedApp);
    restartedApp = null;
    console.log(`PASS: ${label} exported a transfer package, auto-restored on a second fixture home, installed into detected Codex, skipped missing Claude Code, preserved repo files and destination data, and replayed safely.`);
  } finally {
    if (sourceApp) await closeApp(sourceApp);
    if (destinationApp) await closeApp(destinationApp);
    if (restartedApp) await closeApp(restartedApp);
    await fs.rm(base, { recursive: true, force: true });
  }
}

(async () => {
  await fs.mkdir(scratch, { recursive: true });
  const packedElectron = path.join(root, 'release', 'win-unpacked', 'Skill Hub.exe');
  await runMachineTransfer(sourceElectron, 'source');
  if (!process.argv.includes('--source-only')) {
    if (await fileExists(packedElectron)) await runMachineTransfer(packedElectron, 'packaged');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
