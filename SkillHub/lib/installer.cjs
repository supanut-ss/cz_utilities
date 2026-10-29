const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const YAML = require('yaml');

const digest = value => createHash('sha256').update(value).digest('hex');
const sourceIdentity = skill => skill.originRepo?.url && typeof skill.originRepo.subpath === 'string' ? digest(JSON.stringify(['repo', skill.originRepo.url, skill.originRepo.subpath])) : digest(JSON.stringify(['library', skill.id]));
const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
const equal = (a, b) => compare(a) === compare(b);
const within = (root, item) => { const relative = path.relative(root, item); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
const overlaps = (a, b) => within(a, b) || within(b, a);
const validFolder = name => typeof name === 'string' && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
const safeFileName = name => !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name);
const message = error => error.code === 'EACCES' || error.code === 'EPERM' ? 'ไม่มีสิทธิ์เขียนหรือไฟล์กำลังถูกใช้งาน กรุณาปิดโปรแกรมที่ใช้ไฟล์แล้วลองใหม่' : error.message || 'ติดตั้งไม่ได้';

async function ancestry(location, allowMissing = false) {
  if (typeof location !== 'string' || !path.isAbsolute(location) || location.includes('\0')) throw new Error('ตำแหน่งไฟล์ไม่ถูกต้อง');
  const absolute = path.resolve(location), parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('ไม่รองรับลิงก์ไฟล์หรือโฟลเดอร์ในตำแหน่งติดตั้ง');
      if (current !== absolute && !stat.isDirectory()) throw new Error('ตำแหน่งติดตั้งมีส่วนที่ไม่ใช่โฟลเดอร์');
    } catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
  }
}

async function exists(location) {
  try { await fs.lstat(location); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function tree(folder) {
  await ancestry(folder);
  if (!(await fs.lstat(folder)).isDirectory()) throw new Error('ตำแหน่ง Skill ไม่ใช่โฟลเดอร์');
  const files = [], directories = [], seen = new Set();
  let bytes = 0, entries = 0;
  async function walk(current, relative = '', depth = 0) {
    if (depth > 16) throw new Error('Skill มีโฟลเดอร์ซ้อนลึกเกินไป');
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (++entries > 10000) throw new Error('Skill มีไฟล์หรือโฟลเดอร์มากเกินไป');
      if (!safeFileName(entry.name)) throw new Error('Skill มีชื่อไฟล์ที่ไม่รองรับบน Windows');
      const absolute = path.join(current, entry.name), rel = path.join(relative, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Skill มีลิงก์ที่ไม่รองรับ');
      if (stat.isDirectory()) { if (directories.length >= 5000) throw new Error('Skill มีโฟลเดอร์มากเกินไป'); directories.push(rel); await walk(absolute, rel, depth + 1); }
      else if (stat.isFile()) {
        bytes += stat.size;
        const key = rel.toLowerCase();
        if (seen.has(key)) throw new Error('Skill มีชื่อไฟล์ซ้ำเมื่อใช้บน Windows');
        seen.add(key);
        files.push({ absolute, relative: rel, size: stat.size });
        if (files.length > 500 || bytes > 20 * 1024 * 1024) throw new Error('Skill ใหญ่เกิน 500 ไฟล์ หรือ 20 MB');
      } else throw new Error('Skill มีชนิดไฟล์ที่ไม่รองรับ');
    }
  }
  await walk(folder);
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  directories.sort((a, b) => a.localeCompare(b));
  const hash = createHash('sha256');
  for (const directory of directories) hash.update('directory\0').update(JSON.stringify(directory.split(path.sep).join('/'))).update('\0');
  for (const file of files) {
    await ancestry(file.absolute);
    const content = await fs.readFile(file.absolute);
    if (content.length !== file.size) throw new Error('Skill เปลี่ยนระหว่างอ่าน กรุณาสร้างแผนใหม่');
    hash.update(JSON.stringify(file.relative.split(path.sep).join('/'))).update('\0').update(String(file.size)).update('\0').update(content);
  }
  return { hash: hash.digest('hex'), files, directories };
}

async function copyTree(source, destination) {
  const snapshot = await tree(source);
  await ancestry(destination, true);
  await fs.mkdir(destination);
  for (const directory of snapshot.directories) await fs.mkdir(path.join(destination, directory), { recursive: true });
  for (const file of snapshot.files) {
    const target = path.join(destination, file.relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await ancestry(file.absolute);
    await fs.copyFile(file.absolute, target, 1);
  }
  if ((await tree(destination)).hash !== snapshot.hash) throw new Error('Skill เปลี่ยนระหว่างสำรองข้อมูล');
  return snapshot.hash;
}

function defaults(home, env) {
  const target = (id, name, relative, config, commands, note = '') => ({ id, name, path: path.join(home, ...relative), configPaths: config.map(parts => path.join(home, ...parts)), commands, supported: true, note });
  return [
    target('codex', 'Codex', ['.agents', 'skills'], [['.codex']], ['codex'], 'โฟลเดอร์ .agents/skills อาจถูกอ่านโดย AI อื่นที่ใช้มาตรฐานเดียวกัน'),
    target('claude', 'Claude Code', ['.claude', 'skills'], [['.claude']], ['claude'], 'สำหรับ Claude Code บนเครื่อง ไม่ใช่บัญชี Claude หรือ Cowork'),
    target('cursor', 'Cursor', ['.cursor', 'skills'], [['.cursor']], ['cursor']),
    target('gemini', 'Gemini CLI', ['.gemini', 'skills'], [['.gemini']], ['gemini']),
    target('opencode', 'OpenCode', ['.config', 'opencode', 'skills'], [['.config', 'opencode']], ['opencode']),
    target('copilot', 'GitHub Copilot', ['.copilot', 'skills'], [['.copilot']], ['copilot']),
    { id: 'chatgpt', name: 'ChatGPT', path: '', configPaths: [], commands: [], supported: false, note: 'ไม่รองรับติดตั้ง Skill เข้าเว็บหรือบัญชี ChatGPT จากโฟลเดอร์บนเครื่อง' }
  ];
}

async function normalizePayload(folder, skill) {
  const file = path.join(folder, 'SKILL.md');
  await ancestry(file);
  const content = await fs.readFile(file, 'utf8');
  if (Buffer.byteLength(content) > 2 * 1024 * 1024 || !content.trim()) throw new Error('SKILL.md ต้องไม่ว่างและมีขนาดไม่เกิน 2 MB');
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let name, description;
  if (match) {
    const doc = YAML.parseDocument(match[1], { uniqueKeys: true });
    if (doc.errors.length) throw new Error('ส่วนหัว YAML ของ Skill ไม่ถูกต้อง');
    let metadata;
    try { metadata = doc.toJS({ maxAliasCount: 20 }); } catch { throw new Error('ส่วนหัว YAML ซับซ้อนเกินไป'); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('ส่วนหัว YAML ต้องเป็นรายการข้อมูล Skill');
    name = metadata.name; description = metadata.description;
  } else {
    if (/^\uFEFF?---(?:\r?\n|$)/.test(content) || skill.source !== 'created') throw new Error('Skill ต้องมีส่วนหัว YAML ที่ถูกต้อง พร้อม name และ description');
    name = String(skill.name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, '');
    if (!name) name = `skill-${String(skill.id).replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}`;
    description = skill.description?.trim() || `Instructions for ${skill.name}`;
    const header = YAML.stringify({ name, description });
    await fs.writeFile(file, `---\n${header}---\n${content}`);
  }
  if (!validFolder(name)) throw new Error('ชื่อ Skill ต้องเป็นภาษาอังกฤษตัวเล็ก ตัวเลข และขีดกลาง ยาวไม่เกิน 64 ตัว และไม่เป็นชื่อสงวนของ Windows');
  if (typeof description !== 'string' || !description.trim() || description.length > 1024 || description.includes('\0')) throw new Error('คำอธิบายในส่วนหัว YAML ต้องเป็นข้อความ 1 ถึง 1024 ตัวอักษร');
  return name;
}

function createInstaller({ home, dataRoot, store, env = process.env, testTargets } = {}) {
  if (!path.isAbsolute(home || '') || !path.isAbsolute(dataRoot || '') || !store?.getState || !store?.materializeSkill) throw new Error('ตั้งค่าระบบติดตั้งไม่ถูกต้อง');
  dataRoot = path.resolve(dataRoot);
  const adapters = testTargets ? testTargets.map(t => ({ supported: true, configPaths: [], commands: [], note: '', ...t })) : defaults(home, env);
  if (adapters.some(t => typeof t.id !== 'string' || !t.id || (t.supported && (!path.isAbsolute(t.path || '') || overlaps(dataRoot, path.resolve(t.path)))))) throw new Error('ตำแหน่งจัดเก็บการติดตั้งต้องแยกจากโฟลเดอร์ Skill ของ AI');
  if (new Set(adapters.map(t => t.id)).size !== adapters.length) throw new Error('รหัสปลายทางติดตั้งซ้ำกัน');
  let queue = Promise.resolve(), activePlan = null;
  const run = operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  async function prepare() {
    await ancestry(dataRoot, true);
    await fs.mkdir(dataRoot, { recursive: true });
    await ancestry(dataRoot);
    for (const name of ['staging', 'receipts', 'backups']) {
      const location = path.join(dataRoot, name);
      await ancestry(location, true);
      await fs.mkdir(location, { recursive: true });
    }
  }
  const receiptPath = (target, folder) => path.join(dataRoot, 'receipts', `${digest(`${compare(path.resolve(target.path))}\0${folder}`)}.json`);
  async function readReceipt(target, folder) {
    const location = receiptPath(target, folder);
    if (!await exists(location)) return null;
    await ancestry(location);
    const stat = await fs.lstat(location);
    if (!stat.isFile() || stat.size > 16384) throw new Error('บันทึกการติดตั้งไม่ถูกต้อง');
    let receipt;
    try { receipt = JSON.parse(await fs.readFile(location, 'utf8')); } catch { throw new Error('บันทึกการติดตั้งอ่านไม่ได้'); }
    if (receipt.version !== 1 || receipt.targetId !== target.id || !equal(receipt.targetPath || '', path.resolve(target.path)) || receipt.folder !== folder || typeof receipt.skillId !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.hash || '') || (receipt.sourceKey !== undefined && !/^[a-f0-9]{64}$/.test(receipt.sourceKey))) throw new Error('บันทึกการติดตั้งไม่ตรงกับปลายทาง กรุณาตรวจโฟลเดอร์ด้วยตนเอง');
    return receipt;
  }
  async function writeReceipt(target, folder, receipt) {
    const location = receiptPath(target, folder), temporary = `${location}.${randomUUID()}.tmp`;
    await ancestry(location, true);
    try { await fs.writeFile(temporary, JSON.stringify(receipt, null, 2), { flag: 'wx' }); await fs.rename(temporary, location); }
    finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function detect() {
    const results = [];
    const pathDirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).filter(p => path.isAbsolute(p));
    for (const adapter of adapters) {
      const evidence = [];
      let invalid = false;
      if (adapter.supported) {
        try { await ancestry(adapter.path, true); } catch (error) { evidence.push(message(error)); invalid = true; }
        for (const config of adapter.configPaths || []) {
          try { await ancestry(config); if ((await fs.lstat(config)).isDirectory()) evidence.push(`พบโฟลเดอร์ตั้งค่า: ${config}`); } catch { /* Detection is read-only and optional. */ }
        }
        const candidates = [];
        for (const command of adapter.commands || []) for (const folder of pathDirs) for (const extension of process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['', '.exe', '.cmd']) candidates.push(path.join(folder, command + extension));
        if (adapter.id === 'cursor' && env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe'));
        for (const executable of candidates) {
          try { await ancestry(executable); if ((await fs.lstat(executable)).isFile()) { evidence.push(`พบโปรแกรม: ${executable}`); break; } } catch { /* Never execute discovered programs. */ }
        }
        if (adapter.id === 'copilot') {
          for (const configName of ['.vscode', '.vscode-insiders']) {
            const extensions = path.join(home, configName, 'extensions');
            try {
              await ancestry(extensions);
              const directory = await fs.opendir(extensions);
              let checked = 0;
              for await (const entry of directory) {
                if (++checked > 2000) break;
                if (entry.isDirectory() && !entry.isSymbolicLink() && /^github\.copilot(?:-chat)?-/i.test(entry.name)) {
                  const extensionPath = path.join(extensions, entry.name);
                  await ancestry(extensionPath);
                  evidence.push(`พบส่วนขยาย GitHub Copilot: ${extensionPath}`);
                  break;
                }
              }
            } catch { /* An optional extensions directory may not exist. */ }
          }
        }
        if (testTargets && adapter.detected === true) evidence.push('ตรวจพบจากค่าทดสอบ');
      }
      results.push({ id: adapter.id, name: adapter.name, path: adapter.path, supported: adapter.supported, detected: adapter.supported && !invalid && evidence.length > 0, evidence, note: adapter.note || (!evidence.length ? 'ยังไม่พบโปรแกรมหรือโฟลเดอร์ตั้งค่าบนเครื่อง' : '') });
    }
    return results;
  }
  async function snapshot(target, skill, folder, sourceHash) {
    if (target.id === 'claude' && ['synced', 'anthropic-skills'].includes(folder)) return { status: 'conflict', reason: 'Claude Code สงวนชื่อ synced และ anthropic-skills กรุณาเปลี่ยนชื่อใน YAML' };
    await ancestry(target.path, true);
    const destination = path.join(target.path, folder);
    await ancestry(destination, true);
    const receipt = await readReceipt(target, folder);
    const present = await exists(destination);
    if (!present) return receipt ? { status: 'conflict', reason: 'บันทึกเดิมมีอยู่ แต่โฟลเดอร์ปลายทางหายไป' } : { status: 'new', reason: 'ยังไม่มี Skill ชื่อนี้', oldHash: null, receiptHash: null };
    if (!receipt) return { status: 'conflict', reason: 'โฟลเดอร์นี้ไม่ได้ติดตั้งโดย Skill Hub จึงไม่เขียนทับ' };
    if (receipt.sourceKey ? receipt.sourceKey !== sourceIdentity(skill) : receipt.skillId !== skill.id) return { status: 'conflict', reason: 'ชื่อโฟลเดอร์ชนกับ Skill อื่นที่ติดตั้งไว้' };
    const actual = await tree(destination);
    if (actual.hash !== receipt.hash) return { status: 'conflict', reason: 'ไฟล์ปลายทางถูกแก้ไขหลังติดตั้ง จึงไม่เขียนทับ' };
    return { status: actual.hash === sourceHash ? 'unchanged' : 'update', reason: actual.hash === sourceHash ? 'ตรงกับ Skill ในคลังแล้ว' : 'มีเนื้อหาใหม่ จะสำรองเวอร์ชันเดิมก่อนแทนที่', oldHash: actual.hash, receiptHash: digest(JSON.stringify(receipt)) };
  }
  async function sourcePayload(skill, folder) {
    await store.materializeSkill(skill.id, folder);
    const name = await normalizePayload(folder, skill);
    return { folder: name, hash: (await tree(folder)).hash, sourceKey: sourceIdentity(skill) };
  }
  async function localStageFor(target) {
    let parent = path.dirname(path.resolve(target.path));
    while (adapters.some(adapter => adapter.supported && within(path.resolve(adapter.path), parent))) {
      const next = path.dirname(parent);
      if (next === parent) throw new Error('ไม่พบพื้นที่เตรียมติดตั้งนอกโฟลเดอร์ Skill');
      parent = next;
    }
    await ancestry(parent);
    const stage = path.join(parent, `.skillhub-stage-${randomUUID()}`);
    await ancestry(stage, true);
    await fs.mkdir(stage);
    await ancestry(stage);
    return stage;
  }
  async function makePlan(input, selection = false) {
      activePlan = null;
      if (!input || (!selection && typeof input.profileId !== 'string') || !Array.isArray(input.targetIds) || !input.targetIds.length || input.targetIds.length > adapters.length || new Set(input.targetIds).size !== input.targetIds.length) throw new Error('เลือกโปรไฟล์และปลายทางติดตั้งให้ถูกต้อง');
      await prepare();
      const state = await store.getState();
      if (selection && (!Array.isArray(input.skillIds) || !input.skillIds.length || input.skillIds.length > 200 || input.skillIds.some(id => typeof id !== 'string' || !state.skills.some(skill => skill.id === id)) || new Set(input.skillIds).size !== input.skillIds.length)) throw new Error('เลือก Skill ที่มีอยู่ในคลัง 1 ถึง 200 รายการ โดยไม่ซ้ำกัน');
      const profile = selection ? { id: null, name: 'ชุด Skill ที่ย้ายเครื่อง', skillIds: [...input.skillIds] } : state.profiles.find(p => p.id === input.profileId);
      if (!profile || !profile.skillIds.length || profile.skillIds.length > 200) throw new Error('โปรไฟล์ต้องมี Skill 1 ถึง 200 รายการ');
      const allTargets = await detect();
      const targets = input.targetIds.map(id => allTargets.find(t => t.id === id));
      if (targets.some(t => !t || !t.supported || !t.detected)) throw new Error('เลือกได้เฉพาะ AI ที่รองรับและตรวจพบบนเครื่อง');
      const id = randomUUID(), staging = path.join(dataRoot, 'staging', id);
      await fs.mkdir(staging);
      const entries = [], sources = new Map(), warnings = ['ส่วนขยาย YAML เฉพาะ AI จะคัดลอกตามต้นฉบับ ระบบไม่แปลงความหมายระหว่างผู้ให้บริการ'];
      if (targets.some(t => t.id === 'codex')) warnings.push('Codex ใช้ .agents/skills ร่วมกับเครื่องมืออื่นที่รองรับมาตรฐานเดียวกัน Skill ที่ติดตั้งอาจแสดงใน AI อื่นด้วย');
      try {
        for (const skillId of profile.skillIds) {
          const skill = state.skills.find(s => s.id === skillId);
          if (!skill) throw new Error('Skill ในโปรไฟล์หายไป กรุณาบันทึกโปรไฟล์ใหม่');
          let payload, problem;
          try { payload = await sourcePayload(skill, path.join(staging, randomUUID())); sources.set(skill.id, payload); }
          catch (error) { problem = message(error); }
          for (const target of targets) {
            const entry = { targetId: target.id, targetName: target.name, skillId: skill.id, skillName: skill.name, folder: payload?.folder || '', status: 'conflict', reason: problem || '' };
            if (payload) {
              try { Object.assign(entry, await snapshot(target, skill, payload.folder, payload.hash)); }
              catch (error) { entry.reason = message(error); }
            }
            entries.push(entry);
          }
        }
        for (const target of targets) {
          const groups = new Map();
          for (const entry of entries.filter(e => e.targetId === target.id && e.folder)) { const group = groups.get(entry.folder) || []; group.push(entry); groups.set(entry.folder, group); }
          for (const group of groups.values()) if (group.length > 1) group.forEach(entry => { entry.status = 'conflict'; entry.reason = 'มี Skill หลายรายการใช้ชื่อโฟลเดอร์เดียวกัน กรุณาแก้ชื่อใน YAML'; });
        }
        activePlan = { id, profileId: profile.id, profileIds: [...profile.skillIds], targets, entries, sources };
        return { id, profileName: profile.name, targets, entries: entries.map(({ oldHash, receiptHash, ...entry }) => entry), warnings };
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  return {
    detectTargets: () => run(detect),
    plan: input => run(() => makePlan(input)),
    planSelection: input => run(() => makePlan(input, true)),
    getDeploymentIntents: () => run(async () => {
      const receiptRoot = path.join(dataRoot, 'receipts');
      if (!await exists(receiptRoot)) return [];
      await ancestry(receiptRoot);
      const state = await store.getState();
      const grouped = new Map();
      const directory = await fs.opendir(receiptRoot);
      let count = 0;
      for await (const entry of directory) {
        if (++count > 50000) throw new Error('บันทึกการติดตั้งมากเกินไป กรุณาตรวจสอบพื้นที่ข้อมูลแอป');
        if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        try {
          const receiptFile = path.join(receiptRoot, entry.name);
          await ancestry(receiptFile);
          if ((await fs.lstat(receiptFile)).size > 16384) continue;
          const preliminary = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
          const target = adapters.find(adapter => adapter.supported && adapter.id === preliminary.targetId);
          if (!target || !validFolder(preliminary.folder) || path.basename(receiptPath(target, preliminary.folder)) !== entry.name) continue;
          const receipt = await readReceipt(target, preliminary.folder);
          if (!receipt || (await tree(path.join(target.path, receipt.folder))).hash !== receipt.hash) continue;
          const matches = state.skills.filter(skill => receipt.sourceKey ? sourceIdentity(skill) === receipt.sourceKey : skill.id === receipt.skillId);
          const skill = matches.find(item => item.id === receipt.skillId) || matches.sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))[0];
          if (!skill) continue;
          const selected = grouped.get(target.id) || new Set();
          selected.add(skill.id);
          grouped.set(target.id, selected);
        } catch { /* Ignore corrupt, stale, foreign, linked or user-modified deployments. */ }
      }
      return [...grouped].map(([targetId, skillIds]) => ({ targetId, skillIds: [...skillIds] }));
    }),
    apply: planId => run(async () => {
      const plan = activePlan;
      activePlan = null;
      if (!plan || plan.id !== planId) throw new Error('แผนติดตั้งหมดอายุ กรุณาตรวจสอบและสร้างแผนใหม่');
      await prepare();
      const state = await store.getState();
      const profile = state.profiles.find(p => p.id === plan.profileId);
      if (plan.profileId !== null && (!profile || JSON.stringify(profile.skillIds) !== JSON.stringify(plan.profileIds))) throw new Error('โปรไฟล์เปลี่ยนหลังสร้างแผน กรุณาสร้างแผนใหม่');
      const staging = path.join(dataRoot, 'staging', randomUUID());
      await fs.mkdir(staging);
      const result = { installedCount: 0, unchangedCount: 0, failures: [], backups: [], restartNote: 'ให้ AI โหลด Skill ใหม่ หรือปิดแล้วเปิด AI ด้วยตนเอง หากยังไม่แสดงรายการใหม่' };
      const payloads = new Map();
      try {
        for (const entry of plan.entries) {
          const target = plan.targets.find(t => t.id === entry.targetId), skill = state.skills.find(s => s.id === entry.skillId);
          let rollback = null, moved = false, published = false, localStage = null, retainStage = false;
          const destination = path.join(target.path, entry.folder);
          try {
            if (entry.status === 'conflict') throw new Error(entry.reason);
            if (!skill) throw new Error('Skill ถูกลบหลังสร้างแผน');
            if (!payloads.has(skill.id)) {
              const folder = path.join(staging, randomUUID());
              try { const payload = await sourcePayload(skill, folder); payloads.set(skill.id, { ...payload, location: folder }); }
              catch (error) { payloads.set(skill.id, { error }); }
            }
            const payload = payloads.get(skill.id);
            if (payload.error) throw payload.error;
            const original = plan.sources.get(skill.id);
            if (payload.hash !== original.hash || payload.folder !== original.folder || payload.sourceKey !== original.sourceKey) throw new Error('เนื้อหา Skill เปลี่ยนหลังสร้างแผน กรุณาสร้างแผนใหม่');
            const current = await snapshot(target, skill, entry.folder, payload.hash);
            if (current.status !== entry.status || current.oldHash !== entry.oldHash || current.receiptHash !== entry.receiptHash) throw new Error('ไฟล์ปลายทางหรือบันทึกติดตั้งเปลี่ยนหลังสร้างแผน กรุณาสร้างแผนใหม่');
            if (current.status === 'unchanged') { result.unchangedCount++; continue; }
            await ancestry(target.path, true);
            await fs.mkdir(target.path, { recursive: true });
            await ancestry(target.path);
            localStage = await localStageFor(target);
            const incoming = path.join(localStage, 'incoming');
            await copyTree(payload.location, incoming);
            const finalSnapshot = await snapshot(target, skill, entry.folder, payload.hash);
            if (finalSnapshot.status !== entry.status || finalSnapshot.oldHash !== entry.oldHash || finalSnapshot.receiptHash !== entry.receiptHash) throw new Error('ปลายทางเปลี่ยนระหว่างเตรียมติดตั้ง กรุณาสร้างแผนใหม่');
            if (entry.status === 'update') {
              const backup = path.join(dataRoot, 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
              const backupHash = await copyTree(destination, backup);
              result.backups.push(backup);
              if (backupHash !== entry.oldHash) throw new Error('ปลายทางเปลี่ยนระหว่างสำรองข้อมูล กรุณาสร้างแผนใหม่');
              rollback = path.join(localStage, 'rollback');
              await ancestry(destination);
              if ((await tree(destination)).hash !== entry.oldHash) throw new Error('ปลายทางเปลี่ยนระหว่างติดตั้ง กรุณาสร้างแผนใหม่');
              if (digest(JSON.stringify(await readReceipt(target, entry.folder))) !== entry.receiptHash) throw new Error('บันทึกติดตั้งเปลี่ยนระหว่างสำรองข้อมูล กรุณาสร้างแผนใหม่');
              await fs.rename(destination, rollback);
              moved = true;
            } else if (await exists(destination)) throw new Error('มีโฟลเดอร์ใหม่ที่ปลายทาง จึงไม่เขียนทับ');
            await ancestry(destination, true);
            await fs.rename(incoming, destination);
            published = true;
            const receipt = { version: 1, targetId: target.id, targetPath: path.resolve(target.path), folder: entry.folder, skillId: skill.id, sourceKey: sourceIdentity(skill), hash: payload.hash, installedAt: new Date().toISOString() };
            await writeReceipt(target, entry.folder, receipt);
            result.installedCount++;
          } catch (error) {
            let failure = message(error);
            try {
              if (published) { await ancestry(destination); await fs.rename(destination, path.join(localStage, 'failed-install')); }
              if (moved) { await ancestry(destination, true); await fs.rename(rollback, destination); }
            } catch (rollbackError) { retainStage = true; failure += `; กู้คืนอัตโนมัติไม่สำเร็จ: ${message(rollbackError)} เก็บไฟล์กู้คืนไว้ที่ ${localStage} และโฟลเดอร์สำรอง`; }
            result.failures.push({ targetName: target.name, skillName: entry.skillName, error: failure });
          } finally {
            if (localStage && !retainStage) {
              try { await ancestry(localStage); await fs.rm(localStage, { recursive: true, force: true }); }
              catch (error) { result.failures.push({ targetName: target.name, skillName: entry.skillName, error: `ล้างไฟล์เตรียมติดตั้งไม่ได้: ${message(error)} (${localStage})` }); }
            }
          }
        }
        return result;
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    })
  };
}

module.exports = { createInstaller };
