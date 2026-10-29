const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { createStore } = require('../lib/store.cjs');
const { createDiscovery } = require('../lib/discovery.cjs');
const { createInstaller } = require('../lib/installer.cjs');
const { createRepository } = require('../lib/repository.cjs');
const { createMigration } = require('../lib/migration.cjs');

app.setName('Skill Hub');
if (process.env.SKILL_HUB_TEST_MODE === '1' && process.env.SKILL_HUB_TEST_DATA) {
  const isolatedUserData = path.join(path.dirname(path.resolve(process.env.SKILL_HUB_TEST_DATA)), 'electron-user-data');
  require('node:fs').mkdirSync(isolatedUserData, { recursive: true });
  app.setPath('userData', isolatedUserData);
}
protocol.registerSchemesAsPrivileged([{ scheme: 'skillhub', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window;
let activeWrites = 0;
const writeChannels = new Set(['skills:save', 'skills:delete', 'profiles:save', 'profiles:delete', 'skills:import', 'skills:import-discovered', 'repo:import', 'install:apply', 'migration:export', 'migration:restore']);
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    const dist = path.resolve(__dirname, '../dist');
    protocol.handle('skillhub', async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Not found', { status: 404 });
        const file = path.resolve(dist, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        const actual = await fs.realpath(file);
        if (!actual.startsWith(dist + path.sep)) return new Response('Forbidden', { status: 403 });
        return net.fetch(pathToFileURL(actual).href);
      } catch { return new Response('Not found', { status: 404 }); }
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const dataPath = process.env.SKILL_HUB_TEST_DATA || path.join(app.getPath('userData'), 'library');
    const store = createStore(dataPath);
    const home = process.env.SKILL_HUB_TEST_MODE === '1' && process.env.SKILL_HUB_TEST_HOME ? path.resolve(process.env.SKILL_HUB_TEST_HOME) : app.getPath('home');
    const installer = createInstaller({ home, dataRoot: path.join(app.getPath('userData'), 'installer'), store, env: process.env });
    const repository = createRepository({ cacheRoot: path.join(app.getPath('userData'), 'repositories') });
    const portableSource = process.env.SKILL_HUB_TEST_MODE === '1' && process.env.SKILL_HUB_TEST_PORTABLE_EXE
      ? path.resolve(process.env.SKILL_HUB_TEST_PORTABLE_EXE)
      : process.env.PORTABLE_EXECUTABLE_FILE && path.isAbsolute(process.env.PORTABLE_EXECUTABLE_FILE) && /\.exe$/i.test(process.env.PORTABLE_EXECUTABLE_FILE)
        ? process.env.PORTABLE_EXECUTABLE_FILE : undefined;
    const migration = createMigration({ dataRoot: path.join(app.getPath('userData'), 'migration'), store, installer, binarySource: portableSource });
    const migrationSidecar = process.env.SKILL_HUB_TEST_MODE === '1' && process.env.SKILL_HUB_TEST_SIDECAR
      ? path.resolve(process.env.SKILL_HUB_TEST_SIDECAR)
      : portableSource ? path.join(path.dirname(portableSource), 'SkillHub-Transfer.skillhub') : undefined;
    const discoveryRoots = process.env.SKILL_HUB_TEST_MODE === '1' && process.env.SKILL_HUB_TEST_SCAN_ROOT
      ? [{ path: process.env.SKILL_HUB_TEST_SCAN_ROOT, provider: 'Test AI' }]
      : [
        { path: path.join(home, '.codex', 'skills'), provider: 'Codex' },
        { path: path.join(home, '.codex', 'plugins', 'cache'), provider: 'Codex plugins' },
        { path: path.join(home, '.agents', 'skills'), provider: 'Shared agents' },
        { path: path.join(home, '.claude', 'skills'), provider: 'Claude' },
        { path: path.join(home, '.cursor', 'skills'), provider: 'Cursor' },
        { path: path.join(home, '.gemini', 'skills'), provider: 'Gemini' },
        ...(process.env.CODEX_HOME ? [{ path: path.join(process.env.CODEX_HOME, 'skills'), provider: 'Codex custom home' }] : [])
      ];
    const discovery = createDiscovery({ roots: discoveryRoots });
    let scanPromise;
    const handle = (channel, action) => ipcMain.handle(channel, async (event, ...args) => {
      let writing = false;
      try {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== 'skillhub://app/index.html') throw new Error('ไม่อนุญาตให้เรียกใช้จากหน้าต่างนี้');
        if (writeChannels.has(channel)) { writing = true; activeWrites++; }
        return { ok: true, value: await action(...args) };
      } catch (error) {
        console.error(channel, error);
        return { ok: false, error: error.message || 'ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง' };
      } finally { if (writing) activeWrites--; }
    });
    handle('skills:state', () => store.getState());
    handle('skills:save', input => store.saveSkill(input));
    handle('skills:delete', id => store.deleteSkill(id));
    handle('profiles:save', input => store.saveProfile(input));
    handle('profiles:delete', id => store.deleteProfile(id));
    handle('skills:discover', () => {
      if (!scanPromise) scanPromise = store.getState().then(state => discovery.scan(state)).finally(() => { scanPromise = undefined; });
      return scanPromise;
    });
    handle('skills:import-discovered', ids => discovery.importSelected(ids, store));
    handle('install:targets', () => installer.detectTargets());
    handle('install:plan', input => installer.plan(input));
    handle('install:apply', id => installer.apply(id));
    handle('repo:preview', input => repository.preview(input));
    handle('repo:import', input => repository.importSelected(input, store));
    handle('migration:pending', () => migrationSidecar ? migration.pending(migrationSidecar) : null);
    handle('migration:restore', input => migration.restore(input));
    handle('migration:export', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'เลือกที่เก็บชุดย้ายเครื่อง', properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] });
      return result.canceled ? null : migration.exportPackage(result.filePaths[0]);
    });
    handle('migration:preview', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'เปิดแพ็กย้ายเครื่อง Skill Hub', filters: [{ name: 'Skill Hub transfer', extensions: ['skillhub'] }], properties: ['openFile', 'dontAddToRecent'] });
      return result.canceled ? null : migration.preview(result.filePaths[0]);
    });
    handle('repo:local', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'เลือกโฟลเดอร์ repo ที่มี Skill', properties: ['openDirectory', 'dontAddToRecent'] });
      return result.canceled ? null : repository.previewLocal(result.filePaths[0]);
    });
    handle('skills:import', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'เลือกโฟลเดอร์ Skill ที่มี SKILL.md', properties: ['openDirectory', 'dontAddToRecent'] });
      return result.canceled ? null : store.importSkill(result.filePaths[0]);
    });
    handle('profiles:export', async id => {
      const result = await dialog.showOpenDialog(window, { title: 'เลือกที่เก็บชุด Skill', properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] });
      return result.canceled ? null : store.exportProfile(id, result.filePaths[0]);
    });
    handle('app:open-data', async () => {
      await store.getState();
      const error = await shell.openPath(dataPath);
      if (error) throw new Error('เปิดโฟลเดอร์ข้อมูลไม่สำเร็จ');
    });
    window = new BrowserWindow({
      width: 1380, height: 900, minWidth: 860, minHeight: 620,
      title: 'Skill Hub', backgroundColor: '#f6f7fa', autoHideMenuBar: true,
      icon: path.join(__dirname, '../assets/icon.png'),
      show: process.env.SKILL_HUB_TEST_MODE !== '1',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: process.env.SKILL_HUB_TEST_MODE !== '1' }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.on('close', event => {
      if (activeWrites > 0) {
        event.preventDefault();
        dialog.showMessageBox(window, { type: 'info', title: 'Skill Hub', message: 'กำลังบันทึกหรือติดตั้ง Skill กรุณารอให้เสร็จก่อนปิดแอป' });
      }
    });
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-prevent-unload', event => {
      const choice = dialog.showMessageBoxSync(window, {
        type: 'question', buttons: ['แก้ไขต่อ', 'ละทิ้งและปิด'], defaultId: 0, cancelId: 0,
        title: 'ยังไม่ได้บันทึกชุด Skill', message: 'มีการเปลี่ยนแปลงที่ยังไม่บันทึก ต้องการปิดแอปหรือไม่?'
      });
      if (choice === 1) event.preventDefault();
    });
    await window.loadURL('skillhub://app/index.html');
    window.on('closed', () => { window = null; });
  }).catch(error => { console.error(error); dialog.showErrorBox('Skill Hub', 'เปิดแอปไม่สำเร็จ: ' + error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
