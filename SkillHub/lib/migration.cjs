const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LIMITS, validId, safeName, within, ancestry, archivePath, hashFile, writeArchive, extractArchive } = require('./transfer-archive.cjs');

const TARGETS = Object.freeze({ codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', gemini: 'Gemini CLI', opencode: 'OpenCode', copilot: 'GitHub Copilot' });
const fail = message => { throw new Error(message); };
const message = error => error.code === 'ENOENT' ? 'ไม่พบไฟล์หรือโฟลเดอร์ย้ายเครื่อง' : error.code === 'EACCES' || error.code === 'EPERM' ? 'ไม่มีสิทธิ์อ่านหรือเขียนไฟล์ย้ายเครื่อง' : /[ก-๙]/.test(error.message || '') ? error.message : 'ทำรายการย้ายเครื่องไม่สำเร็จ กรุณาตรวจไฟล์แล้วลองใหม่';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const string = (value, maximum, allowEmpty = false) => typeof value === 'string' && value.length <= maximum && !value.includes('\0') && (allowEmpty || !!value.trim());
const isoDate = value => string(value, 64) && Number.isFinite(Date.parse(value));

function portableRepo(repo) {
  return exactKeys(repo, ['url', 'ref', 'commit', 'subpath']) && /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/.test(repo.url || '') && string(repo.ref, 1024, true) && typeof repo.commit === 'string' && (repo.commit === '' || /^[a-f0-9]{40,64}$/i.test(repo.commit)) && string(repo.subpath, 4096, true) && !repo.subpath.startsWith('/') && !repo.subpath.includes('\\') && !/^[a-z]:/i.test(repo.subpath) && repo.subpath.split('/').every(part => part !== '..');
}

function portableSkill(skill) {
  const result = { id: skill.id, name: skill.name, description: skill.description, category: skill.category, content: skill.content, updatedAt: skill.updatedAt, source: skill.source, fileCount: skill.fileCount };
  if (skill.originRepo && typeof skill.originRepo.url === 'string' && !path.isAbsolute(skill.originRepo.url) && !path.win32.isAbsolute(skill.originRepo.url)) {
    const repo = { url: skill.originRepo.url, ref: skill.originRepo.ref, commit: skill.originRepo.commit, subpath: skill.originRepo.subpath?.split('\\').join('/') };
    if (!portableRepo(repo)) fail('ข้อมูลแหล่ง repo ในคลังไม่ถูกต้อง');
    result.originRepo = repo;
  }
  return result;
}

function validateManifest(manifest) {
  if (!exactKeys(manifest, ['format', 'version', 'createdAt', 'snapshot', 'deployments', 'files']) || manifest.format !== 'skill-hub-transfer' || manifest.version !== 1 || !isoDate(manifest.createdAt)) fail('รูปแบบหรือเวอร์ชันชุดย้ายเครื่องไม่รองรับ');
  const snapshot = manifest.snapshot;
  if (!exactKeys(snapshot, ['version', 'skills', 'profiles']) || snapshot.version !== 1 || !Array.isArray(snapshot.skills) || snapshot.skills.length > 5000 || !Array.isArray(snapshot.profiles) || snapshot.profiles.length > 500) fail('รายการ Skill หรือโปรไฟล์ในชุดย้ายเครื่องไม่ถูกต้อง');
  if (Buffer.byteLength(JSON.stringify(snapshot)) > LIMITS.manifestBytes) fail('ข้อมูลคลังในชุดย้ายเครื่องใหญ่เกิน 64 MB');
  const skills = new Map(), profiles = new Set();
  for (const skill of snapshot.skills) {
    if (!exactKeys(skill, ['id', 'name', 'description', 'category', 'content', 'updatedAt', 'source', 'fileCount'], ['originRepo']) || !validId(skill.id) || skills.has(skill.id) || !string(skill.name, 120) || !string(skill.description, 600, true) || !string(skill.category, 80) || !string(skill.content, 2 * 1024 * 1024) || Buffer.byteLength(skill.content) > 2 * 1024 * 1024 || !isoDate(skill.updatedAt) || !['created', 'imported'].includes(skill.source) || !Number.isInteger(skill.fileCount) || skill.fileCount < 1 || skill.fileCount > 500 || skill.originRepo !== undefined && !portableRepo(skill.originRepo)) fail('รายละเอียด Skill ในชุดย้ายเครื่องไม่ถูกต้องหรือมีพาธจากเครื่องต้นทาง');
    skills.set(skill.id, skill);
  }
  for (const profile of snapshot.profiles) {
    if (!exactKeys(profile, ['id', 'name', 'provider', 'skillIds']) || !validId(profile.id) || profiles.has(profile.id) || !string(profile.name, 120) || !string(profile.provider, 80) || !Array.isArray(profile.skillIds) || profile.skillIds.length > 5000 || new Set(profile.skillIds).size !== profile.skillIds.length || profile.skillIds.some(id => !skills.has(id))) fail('โปรไฟล์ในชุดย้ายเครื่องอ้างอิง Skill ไม่ถูกต้อง');
    profiles.add(profile.id);
  }
  if (!Array.isArray(manifest.deployments) || manifest.deployments.length > Object.keys(TARGETS).length) fail('รายการ AI ปลายทางในชุดย้ายเครื่องไม่ถูกต้อง');
  const deployed = new Set();
  for (const intent of manifest.deployments) {
    if (!exactKeys(intent, ['targetId', 'skillIds']) || !Object.hasOwn(TARGETS, intent.targetId) || deployed.has(intent.targetId) || !Array.isArray(intent.skillIds) || !intent.skillIds.length || intent.skillIds.length > 5000 || new Set(intent.skillIds).size !== intent.skillIds.length || intent.skillIds.some(id => !skills.has(id))) fail('รายการติดตั้งในชุดย้ายเครื่องไม่ถูกต้อง');
    deployed.add(intent.targetId);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length + 1 > LIMITS.entries) fail('รายการไฟล์ในชุดย้ายเครื่องเกินกำหนด');
  const paths = new Set(), counts = new Map(), sizes = new Map();
  for (const file of manifest.files) {
    if (!exactKeys(file, ['path', 'size', 'sha256']) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) fail('ข้อมูลตรวจสอบไฟล์ย้ายเครื่องไม่ถูกต้อง');
    const normalized = archivePath(file.path);
    if (normalized === 'manifest.json' || paths.has(normalized.toLowerCase())) fail('รายการไฟล์ย้ายเครื่องซ้ำกัน');
    const parts = normalized.split('/'), id = parts[1];
    if (!skills.has(id) || parts.length > 19) fail('ไฟล์ย้ายเครื่องอ้างอิง Skill หรือความลึกที่ไม่ถูกต้อง');
    paths.add(normalized.toLowerCase()); counts.set(id, (counts.get(id) || 0) + 1); sizes.set(id, (sizes.get(id) || 0) + file.size);
    if (counts.get(id) > 500 || sizes.get(id) > 20 * 1024 * 1024) fail('Skill ในชุดย้ายเครื่องใหญ่เกิน 500 ไฟล์ หรือ 20 MB');
  }
  if ([...sizes.values()].reduce((sum, bytes) => sum + bytes, 0) > LIMITS.expandedBytes) fail('ชุดย้ายเครื่องใหญ่เกิน 512 MB');
  for (const skill of skills.values()) if (counts.get(skill.id) !== skill.fileCount || !manifest.files.some(file => file.path === `skills/${skill.id}/SKILL.md`)) fail('ไฟล์ประกอบ Skill ในชุดย้ายเครื่องไม่ครบ');
  return manifest;
}

async function collectPayload(root, skillIds) {
  const files = [], seen = new Set();
  let total = 0;
  async function walk(folder, relative, depth) {
    await ancestry(folder);
    if (!(await fs.lstat(folder)).isDirectory()) fail('โฟลเดอร์ข้อมูลย้ายเครื่องไม่ถูกต้อง');
    if (depth > 18) fail('โฟลเดอร์ Skill ในชุดย้ายเครื่องซ้อนลึกเกินไป');
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (!safeName(entry.name)) fail('ชื่อไฟล์ย้ายเครื่องไม่รองรับบน Windows');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (seen.has(name.toLowerCase())) fail('ชื่อไฟล์ย้ายเครื่องชนกันบน Windows');
      seen.add(name.toLowerCase());
      if (seen.size > LIMITS.entries * 2) fail('ข้อมูลย้ายเครื่องมีโฟลเดอร์มากเกินกำหนด');
      const absolute = path.join(folder, entry.name), stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) fail('ข้อมูลย้ายเครื่องมีลิงก์ที่ไม่รองรับ');
      if (relative === '' && entry.name !== 'skills') fail('พบไฟล์อยู่นอกโฟลเดอร์ Skill');
      if (relative === 'skills' && (!skillIds.has(entry.name) || !stat.isDirectory())) fail('พบโฟลเดอร์ Skill ที่ไม่มีในรายการย้ายเครื่อง');
      if (stat.isDirectory()) { archivePath(name, true); await walk(absolute, name, depth + 1); }
      else if (stat.isFile()) {
        archivePath(name);
        total += stat.size;
        if (files.length + 2 > LIMITS.entries || total > LIMITS.expandedBytes) fail('ข้อมูลย้ายเครื่องใหญ่เกินกำหนด');
        const checksum = await hashFile(absolute, LIMITS.fileBytes);
        files.push({ path: name, absolute, ...checksum });
      } else fail('ข้อมูลย้ายเครื่องมีชนิดไฟล์ที่ไม่รองรับ');
    }
  }
  await walk(root, '', 0);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function validatePayload(manifest, root, extractedFiles) {
  validateManifest(manifest);
  const files = extractedFiles || await collectPayload(root, new Set(manifest.snapshot.skills.map(skill => skill.id)));
  const actual = new Map(files.map(file => [file.path, file]));
  if (actual.size !== manifest.files.length || files.length !== manifest.files.length) fail('ไฟล์จริงในชุดย้ายเครื่องไม่ตรงกับรายการที่ประกาศ');
  for (const expected of manifest.files) {
    const file = actual.get(expected.path);
    if (!file || file.size !== expected.size || file.sha256 !== expected.sha256) fail('ข้อมูลชุดย้ายเครื่องเสียหายหรือค่า SHA256 ไม่ตรงกัน');
  }
  for (const skill of manifest.snapshot.skills) {
    const file = actual.get(`skills/${skill.id}/SKILL.md`);
    if (!file || file.size > 2 * 1024 * 1024) fail('SKILL.md ในชุดย้ายเครื่องไม่ถูกต้อง');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file.absolute)); } catch { fail('SKILL.md ต้องเป็นข้อความ UTF-8 ที่ถูกต้อง'); }
    if (content !== skill.content) fail('เนื้อหา SKILL.md ไม่ตรงกับข้อมูลคลังที่ย้ายมา');
  }
}

function fallbackDeployments(snapshot) {
  const providerMap = { codex: 'codex', claude: 'claude', 'claude code': 'claude', cursor: 'cursor', gemini: 'gemini', 'gemini cli': 'gemini', opencode: 'opencode', copilot: 'copilot', 'github copilot': 'copilot' };
  const result = new Map();
  for (const profile of snapshot.profiles) {
    const targetId = providerMap[profile.provider.trim().toLowerCase()];
    if (!targetId) continue;
    if (!result.has(targetId)) result.set(targetId, new Set());
    for (const id of profile.skillIds) result.get(targetId).add(id);
  }
  return [...result].filter(([, ids]) => ids.size).map(([targetId, ids]) => ({ targetId, skillIds: [...ids] }));
}

function createMigration({ dataRoot, store, installer, binarySource } = {}) {
  if (!path.isAbsolute(dataRoot || '') || !store?.getState || !store?.materializeSkill || !store?.mergeSnapshot || !installer?.detectTargets || !installer?.planSelection || !installer?.apply) fail('ตั้งค่าระบบย้ายเครื่องไม่ถูกต้อง');
  dataRoot = path.resolve(dataRoot);
  let current = null, queue = Promise.resolve(), prepared = false;
  const run = task => { const next = queue.then(task).catch(error => { throw new Error(message(error), { cause: error }); }); queue = next.catch(() => {}); return next; };
  const staging = path.join(dataRoot, 'staging'), receipts = path.join(dataRoot, 'receipts');
  async function removeOwned(folder) {
    if (path.dirname(folder) !== staging || !/^(preview|export)-[a-f0-9-]{36}$/.test(path.basename(folder))) fail('ตำแหน่งชั่วคราวย้ายเครื่องไม่ถูกต้อง');
    const stat = await fs.lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('โฟลเดอร์ชั่วคราวย้ายเครื่องเปลี่ยนไป');
    await ancestry(staging);
    await fs.rm(folder, { recursive: true, force: true });
  }
  async function prepare() {
    await ancestry(dataRoot, true); await fs.mkdir(dataRoot, { recursive: true }); await ancestry(dataRoot);
    for (const folder of [staging, receipts]) { await ancestry(folder, true); await fs.mkdir(folder, { recursive: true }); await ancestry(folder); }
    if (!prepared) {
      for (const name of await fs.readdir(staging)) if (/^(preview|export)-[a-f0-9-]{36}$/.test(name)) await removeOwned(path.join(staging, name));
      prepared = true;
    }
  }
  async function receipt(hash, manifest) {
    const file = path.join(receipts, `${hash}.json`);
    let stat;
    try { await ancestry(file); stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) fail('บันทึกการย้ายเครื่องไม่ถูกต้อง');
    let value;
    try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { fail('บันทึกการย้ายเครื่องเสียหาย'); }
    const mapValid = (map, expected) => object(map) && Object.keys(map).length === expected.length && expected.every(item => Object.hasOwn(map, item.id) && validId(map[item.id]));
    if (!exactKeys(value, ['version', 'packageHash', 'skillMap', 'profileMap', 'mergedAt', 'completedTargets']) || value.version !== 1 || value.packageHash !== hash || !isoDate(value.mergedAt) || !mapValid(value.skillMap, manifest.snapshot.skills) || !mapValid(value.profileMap, manifest.snapshot.profiles) || !Array.isArray(value.completedTargets) || value.completedTargets.some(id => !Object.hasOwn(TARGETS, id))) fail('บันทึกการย้ายเครื่องไม่ตรงกับแพ็กเกจ');
    return value;
  }
  async function writeReceipt(hash, value) {
    const file = path.join(receipts, `${hash}.json`), temp = path.join(receipts, `${hash}-${randomUUID()}.tmp`);
    await ancestry(file, true);
    try { await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' }); await fs.rename(temp, file); }
    finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function detectedDeployments(manifest) {
    const targets = await installer.detectTargets();
    return manifest.deployments.map(intent => {
      const target = targets.find(item => item.id === intent.targetId);
      return { targetId: intent.targetId, targetName: target?.name || TARGETS[intent.targetId], skillCount: intent.skillIds.length, detected: !!target?.detected, supported: !!target?.supported, note: target?.note || (!target ? 'ไม่พบ AI ปลายทางบนเครื่องนี้' : '') };
    });
  }
  async function previewInternal(packagePath) {
    await prepare();
    if (current) { await removeOwned(current.stage); current = null; }
    if (typeof packagePath !== 'string' || !path.isAbsolute(packagePath)) fail('กรุณาเลือกไฟล์ชุดย้ายเครื่อง');
    const stage = path.join(staging, `preview-${randomUUID()}`), extracted = path.join(stage, 'extracted'), payload = path.join(stage, 'payload');
    await fs.mkdir(stage); await fs.mkdir(extracted); await fs.mkdir(payload);
    try {
      const result = await extractArchive(packagePath, extracted);
      const file = result.files.find(item => item.path === 'manifest.json');
      if (!file || file.size > LIMITS.manifestBytes) fail('ชุดย้ายเครื่องไม่มี manifest.json ที่ถูกต้อง');
      let manifest;
      try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file.absolute))); } catch { fail('ข้อมูล manifest.json ของชุดย้ายเครื่องเสียหาย'); }
      validateManifest(manifest);
      const skillFolder = path.join(extracted, 'skills');
      try { await fs.rename(skillFolder, path.join(payload, 'skills')); } catch (error) { if (error.code !== 'ENOENT' || manifest.snapshot.skills.length) throw error; }
      const actual = result.files.filter(item => item.path !== 'manifest.json').map(item => ({ ...item, absolute: path.join(payload, ...item.path.split('/')) }));
      await validatePayload(manifest, payload, actual);
      // Also enumerate the staged tree to validate empty directory paths and bounds.
      await validatePayload(manifest, payload);
      const saved = await receipt(result.packageHash, manifest);
      const deployments = await detectedDeployments(manifest);
      const id = randomUUID();
      current = { id, stage, payload, manifest, hash: result.packageHash };
      return { id, createdAt: manifest.createdAt, skillCount: manifest.snapshot.skills.length, profileCount: manifest.snapshot.profiles.length, deployments, warnings: ['ติดตั้งเฉพาะ AI ที่ตรวจพบบนเครื่องปลายทาง โดยไม่แทนที่ Skill ที่ผู้ใช้ดูแลเอง', ...(saved ? ['แพ็กเกจนี้เคยกู้คืนคลังแล้ว สามารถลองติดตั้งรายการที่ข้ามหรือไม่สำเร็จอีกครั้งได้'] : [])], alreadyRestored: !!saved };
    } catch (error) { await removeOwned(stage); throw error; }
  }
  return {
    exportPackage: destination => run(async () => {
      await prepare();
      if (typeof destination !== 'string' || !path.isAbsolute(destination)) fail('กรุณาเลือกโฟลเดอร์ปลายทางย้ายเครื่อง');
      await ancestry(destination);
      if (!(await fs.lstat(destination)).isDirectory() || within(dataRoot, path.resolve(destination))) fail('เลือกโฟลเดอร์ปลายทางนอกพื้นที่ข้อมูลย้ายเครื่อง');
      const stage = path.join(staging, `export-${randomUUID()}`), payload = path.join(stage, 'payload');
      await fs.mkdir(stage); await fs.mkdir(payload); await fs.mkdir(path.join(payload, 'skills'));
      let output;
      try {
        const state = await store.getState();
        const snapshot = { version: 1, skills: state.skills.map(portableSkill), profiles: state.profiles.map(profile => ({ id: profile.id, name: profile.name, provider: profile.provider, skillIds: [...profile.skillIds] })) };
        for (const skill of snapshot.skills) await store.materializeSkill(skill.id, path.join(payload, 'skills', skill.id));
        const files = await collectPayload(payload, new Set(snapshot.skills.map(skill => skill.id)));
        const warnings = [];
        let intents = [];
        if (installer.getDeploymentIntents) {
          try { intents = await installer.getDeploymentIntents(); } catch { warnings.push('อ่านรายการติดตั้งเดิมไม่สำเร็จ จะใช้ชุด Skill ในโปรไฟล์แทน'); }
        }
        const knownSkills = new Set(snapshot.skills.map(skill => skill.id)), merged = new Map();
        for (const intent of Array.isArray(intents) ? intents : []) if (Object.hasOwn(TARGETS, intent.targetId) && Array.isArray(intent.skillIds)) {
          if (!merged.has(intent.targetId)) merged.set(intent.targetId, new Set());
          for (const id of intent.skillIds) if (knownSkills.has(id)) merged.get(intent.targetId).add(id);
        }
        let deployments = [...merged].filter(([, ids]) => ids.size).map(([targetId, ids]) => ({ targetId, skillIds: [...ids] }));
        if (!deployments.length) { deployments = fallbackDeployments(snapshot); warnings.push('ยังไม่มีรายการติดตั้งที่จัดการอยู่ ใช้การจับคู่ระบบ AI ของโปรไฟล์เป็นค่าเริ่มต้น'); }
        const manifest = { format: 'skill-hub-transfer', version: 1, createdAt: new Date().toISOString(), snapshot, deployments, files: files.map(({ path: name, size, sha256 }) => ({ path: name, size, sha256 })) };
        await validatePayload(manifest, payload, files);
        output = path.join(destination, `SkillHub-Transfer-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
        await fs.mkdir(output);
        const packagePath = path.join(output, 'SkillHub-Transfer.skillhub');
        await writeArchive(packagePath, manifest, files);
        let appIncluded = false;
        const stub = path.join(output, 'SkillHub.exe');
        if (typeof binarySource === 'string' && path.isAbsolute(binarySource)) {
          try {
            await ancestry(binarySource);
            const stat = await fs.lstat(binarySource);
            if (!stat.isFile() || stat.size < 2 || stat.size > LIMITS.packageBytes) fail('ไฟล์แอปพกพาไม่ถูกต้อง');
            const handle = await fs.open(binarySource, 'r');
            try { const header = Buffer.alloc(2); await handle.read(header, 0, 2, 0); if (header.toString() !== 'MZ') fail('ไฟล์แอปพกพาไม่ใช่ Windows executable'); } finally { await handle.close(); }
            await fs.copyFile(binarySource, stub, 1); appIncluded = true;
          } catch { await fs.unlink(stub).catch(error => { if (error.code !== 'ENOENT') throw error; }); warnings.push('ไม่สามารถรวมไฟล์แอปพกพาได้ เปิดแพ็กเกจนี้ด้วย Skill Hub บนเครื่องปลายทาง'); }
        } else warnings.push('รุ่นพัฒนาหรือแอปที่แตกไฟล์แล้วไม่มีตัวพกพา เปิดแพ็กเกจนี้ด้วย Skill Hub บนเครื่องปลายทาง');
        await fs.writeFile(path.join(output, 'README.md'), '# Skill Hub machine transfer\n\nCopy this entire folder to the destination Windows computer. If SkillHub.exe is included, open it; it detects SkillHub-Transfer.skillhub beside the executable and offers Restore and install. Otherwise open this package using Skill Hub. Restore merges skills and profiles without deleting destination data, then installs the saved selections only into supported AI tools detected on that computer. Missing tools and unmanaged name conflicts are reported. Source-machine paths, receipts, credentials, caches and installation backups are not transferred.\n', { flag: 'wx' });
        return { path: output, packagePath, appIncluded, skillCount: snapshot.skills.length, profileCount: snapshot.profiles.length, warnings };
      } catch (error) {
        if (output) { if (path.dirname(output) !== path.resolve(destination) || !path.basename(output).startsWith('SkillHub-Transfer-')) throw error; await ancestry(output); await fs.rm(output, { recursive: true, force: true }); }
        throw error;
      } finally { await removeOwned(stage); }
    }),
    preview: packagePath => run(() => previewInternal(packagePath)),
    pending: packagePath => run(async () => {
      if (!packagePath) return null;
      try {
        const result = await previewInternal(packagePath);
        if (result.alreadyRestored) { await removeOwned(current.stage); current = null; return null; }
        return result;
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }),
    restore: input => run(async () => {
      if (!current || !input || input.previewId !== current.id || typeof input.autoInstall !== 'boolean') fail('รายการย้ายเครื่องหมดอายุ กรุณาเปิดแพ็กเกจอีกครั้ง');
      const selected = current;
      await validatePayload(selected.manifest, selected.payload);
      let saved = await receipt(selected.hash, selected.manifest);
      let state = await store.getState(), addedSkills = 0, addedProfiles = 0;
      const alreadyRestored = !!saved;
      const haveMappings = saved && Object.values(saved.skillMap).every(id => state.skills.some(skill => skill.id === id)) && Object.values(saved.profileMap).every(id => state.profiles.some(profile => profile.id === id));
      if (!haveMappings) {
        const merged = await store.mergeSnapshot(selected.manifest.snapshot, selected.payload);
        state = merged.state; addedSkills = merged.addedSkills; addedProfiles = merged.addedProfiles;
        saved = { version: 1, packageHash: selected.hash, skillMap: merged.skillMap, profileMap: merged.profileMap, mergedAt: new Date().toISOString(), completedTargets: [] };
        await writeReceipt(selected.hash, saved);
      }
      let installedCount = 0, unchangedCount = 0;
      const failures = [], backups = [], missingTargets = [];
      if (input.autoInstall) {
        let targets;
        try { targets = await installer.detectTargets(); } catch (error) { failures.push({ error: message(error) }); targets = []; }
        for (const intent of selected.manifest.deployments) {
          const target = targets.find(item => item.id === intent.targetId);
          if (!target?.detected || !target.supported) { missingTargets.push(target?.name || TARGETS[intent.targetId]); continue; }
          const skillIds = [...new Set(intent.skillIds.map(id => saved.skillMap[id]))];
          let targetFailed = false;
          try {
            for (let offset = 0; offset < skillIds.length; offset += 200) {
              const plan = await installer.planSelection({ skillIds: skillIds.slice(offset, offset + 200), targetIds: [intent.targetId] });
              const result = await installer.apply(plan.id);
              installedCount += result.installedCount || 0; unchangedCount += result.unchangedCount || 0;
              const batchFailures = result.failures || [];
              if (batchFailures.length) targetFailed = true;
              failures.push(...batchFailures.map(failure => ({ targetName: target.name, ...failure })));
              backups.push(...(result.backups || []));
            }
            if (!targetFailed) { if (!saved.completedTargets.includes(intent.targetId)) saved.completedTargets.push(intent.targetId); }
            else saved.completedTargets = saved.completedTargets.filter(id => id !== intent.targetId);
          } catch (error) { failures.push({ targetName: target.name, error: message(error) }); saved.completedTargets = saved.completedTargets.filter(id => id !== intent.targetId); }
        }
        await writeReceipt(selected.hash, saved);
      }
      return { state, addedSkills, addedProfiles, installedCount, unchangedCount, failures, backups, missingTargets, alreadyRestored };
    })
  };
}

module.exports = { createMigration, LIMITS };
