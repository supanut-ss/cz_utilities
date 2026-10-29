const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const LIMITS = Object.freeze({ files: 500, bytes: 20 * 1024 * 1024, contentBytes: 2 * 1024 * 1024, depth: 16 });
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const fail = message => { throw new Error(message); };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const text = (value, label, max, allowEmpty = false) => {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0')) fail(`${label}ไม่ถูกต้อง`);
  return value.trim();
};
const clone = value => JSON.parse(JSON.stringify(value));

function validateRepo(repo) {
  if (!repo || typeof repo !== 'object' || Array.isArray(repo)) fail('ข้อมูลแหล่ง repo ไม่ถูกต้อง');
  text(repo.url, 'ตำแหน่ง repo', 4096);
  if (!/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/.test(repo.url) && !path.isAbsolute(repo.url)) fail('ตำแหน่ง repo ไม่รองรับ');
  text(repo.ref, 'เวอร์ชัน repo', 1024, true);
  if (typeof repo.commit !== 'string' || (repo.commit !== '' && !/^[a-f0-9]{40,64}$/i.test(repo.commit))) fail('รหัส commit ไม่ถูกต้อง');
  if (typeof repo.subpath !== 'string' || repo.subpath.length > 4096 || repo.subpath.includes('\0') || path.isAbsolute(repo.subpath) || /^[a-z]:/i.test(repo.subpath) || repo.subpath.split(/[\\/]/).some(part => part === '..')) fail('ตำแหน่ง Skill ภายใน repo ไม่ถูกต้อง');
}

async function safeAncestry(folder) {
  const resolved = path.resolve(folder);
  let current = path.parse(resolved).root;
  for (const segment of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('โฟลเดอร์ปลายทางไม่ถูกต้องหรือมีลิงก์');
  }
}

function safeName(name) {
  return name !== '.' && name !== '..' && !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name);
}

async function directory(folder, create = false) {
  if (create) await fs.mkdir(folder, { recursive: true });
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('โฟลเดอร์ไม่ถูกต้อง หรือเป็นลิงก์ที่ไม่รองรับ');
}

async function collect(folder) {
  await directory(folder);
  const files = [];
  const seen = new Set();
  let bytes = 0, entries = 0, directories = 0;
  async function walk(current, relative, depth) {
    if (depth > LIMITS.depth) fail('โฟลเดอร์ Skill ซ้อนกันลึกเกินไป');
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (++entries > 10000) fail('Skill มีไฟล์หรือโฟลเดอร์มากเกินไป');
      if (!safeName(entry.name)) fail('ชื่อไฟล์ใน Skill ไม่รองรับบน Windows');
      const full = path.join(current, entry.name);
      const rel = path.join(relative, entry.name);
      const normalized = rel.toLowerCase();
      if (seen.has(normalized)) fail('Skill มีชื่อไฟล์หรือโฟลเดอร์ซ้ำบน Windows');
      seen.add(normalized);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) fail('Skill มีลิงก์ไฟล์หรือโฟลเดอร์ที่ไม่รองรับ');
      if (stat.isDirectory()) { if (++directories > 5000) fail('Skill มีโฟลเดอร์มากเกินไป'); await walk(full, rel, depth + 1); }
      else if (stat.isFile()) {
        bytes += stat.size;
        files.push({ full, relative: rel, size: stat.size });
        if (files.length > LIMITS.files || bytes > LIMITS.bytes) fail('Skill ใหญ่เกินกำหนด: สูงสุด 500 ไฟล์ และ 20 MB');
      } else fail('Skill มีชนิดไฟล์ที่ไม่รองรับ');
    }
  }
  await walk(folder, '', 0);
  return files;
}

function portableSkill(skill) {
  const result = { id: skill.id, name: skill.name, description: skill.description, category: skill.category, content: skill.content, updatedAt: skill.updatedAt, source: skill.source, fileCount: skill.fileCount };
  if (skill.originRepo !== undefined) {
    const repo = skill.originRepo;
    if (!repo || typeof repo !== 'object' || Array.isArray(repo) || typeof repo.url !== 'string') fail('ข้อมูลแหล่ง repo ไม่ถูกต้อง');
    if (!path.isAbsolute(repo.url) && !path.win32.isAbsolute(repo.url)) {
      validateRepo(repo);
      result.originRepo = { url: repo.url, ref: repo.ref, commit: repo.commit, subpath: repo.subpath };
    }
  }
  return result;
}

function skillMetadataHash(skill) {
  const portable = portableSkill(skill);
  delete portable.id;
  delete portable.updatedAt;
  return createHash('sha256').update(JSON.stringify(portable)).digest('hex');
}

async function boundedRead(file, expectedSize) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize || stat.size > LIMITS.bytes) fail('ไฟล์ต้นทางเปลี่ยนระหว่างอ่าน กรุณาลองใหม่');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.size !== stat.size || opened.dev !== stat.dev || opened.ino !== stat.ino) fail('ไฟล์ต้นทางเปลี่ยนระหว่างอ่าน กรุณาลองใหม่');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== opened.mtimeMs) fail('ไฟล์ต้นทางเปลี่ยนระหว่างอ่าน กรุณาลองใหม่');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

async function skillFilesHash(skill, files) {
  const hash = createHash('sha256').update(skillMetadataHash(skill));
  for (const file of [...files].filter(f => f.relative !== 'SKILL.md').sort((a, b) => a.relative.localeCompare(b.relative))) {
    hash.update(JSON.stringify(file.relative.split(path.sep).join('/'))).update('\0').update(String(file.size)).update('\0').update(await boundedRead(file.full, file.size)).update('\0');
  }
  return hash.digest('hex');
}

function metadata(content, folder) {
  const header = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const field = key => {
    const match = header.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm'));
    if (!match || /^[>|]/.test(match[1])) return '';
    return match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
  };
  return { name: (field('name') || path.basename(folder)).slice(0, 120), description: field('description').slice(0, 600), category: 'ทั่วไป' };
}

function validateState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.skills) || !Array.isArray(value.profiles) || value.skills.length > 5000 || value.profiles.length > 500) fail('ไฟล์ข้อมูลเสียหายหรือเป็นเวอร์ชันที่ไม่รองรับ กรุณาเก็บไฟล์เดิมไว้ก่อน');
  const skillIds = new Set();
  for (const skill of value.skills) {
    if (!validId(skill.id) || skillIds.has(skill.id)) fail('รหัส Skill ในไฟล์ข้อมูลไม่ถูกต้อง');
    skillIds.add(skill.id);
    validateSkill(skill);
    if (skill.originPath !== undefined && (typeof skill.originPath !== 'string' || skill.originPath.includes('\0') || skill.originPath.length > 32767 || !path.isAbsolute(skill.originPath))) fail('ตำแหน่งต้นทาง Skill ในไฟล์ข้อมูลไม่ถูกต้อง');
    if (skill.originRepo !== undefined) validateRepo(skill.originRepo);
    if (!['created', 'imported'].includes(skill.source) || !Number.isInteger(skill.fileCount) || skill.fileCount < 1 || skill.fileCount > LIMITS.files || typeof skill.updatedAt !== 'string' || !Number.isFinite(Date.parse(skill.updatedAt))) fail('รายละเอียด Skill ในไฟล์ข้อมูลไม่ถูกต้อง');
  }
  const profiles = new Set();
  for (const profile of value.profiles) {
    if (!validId(profile.id) || profiles.has(profile.id)) fail('รหัสโปรไฟล์ในไฟล์ข้อมูลไม่ถูกต้อง');
    profiles.add(profile.id);
    validateProfile(profile, skillIds);
  }
  return value;
}

function validateSkill(input) {
  if (!input || typeof input !== 'object') fail('ข้อมูล Skill ไม่ถูกต้อง');
  text(input.name, 'ชื่อ Skill', 120);
  text(input.description, 'คำอธิบาย', 600, true);
  text(input.category, 'หมวดหมู่', 80);
  if (typeof input.content !== 'string' || !input.content.trim() || input.content.includes('\0') || Buffer.byteLength(input.content) > LIMITS.contentBytes) fail('เนื้อหา Skill ต้องไม่ว่างและไม่เกิน 2 MB');
  if (input.id !== undefined && !validId(input.id)) fail('รหัส Skill ไม่ถูกต้อง');
}

function validateProfile(input, skillIds) {
  if (!input || typeof input !== 'object') fail('ข้อมูลโปรไฟล์ไม่ถูกต้อง');
  text(input.name, 'ชื่อโปรไฟล์', 120);
  text(input.provider, 'ชื่อ AI', 80);
  if (input.id !== undefined && !validId(input.id)) fail('รหัสโปรไฟล์ไม่ถูกต้อง');
  if (!Array.isArray(input.skillIds) || input.skillIds.length > 5000 || input.skillIds.some(id => !validId(id) || !skillIds.has(id)) || new Set(input.skillIds).size !== input.skillIds.length) fail('รายการ Skill ในโปรไฟล์ไม่ถูกต้อง');
}

function createStore(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('ตำแหน่งข้อมูลต้องเป็นโฟลเดอร์แบบเต็ม');
  root = path.resolve(root);
  const statePath = path.join(root, 'state.json');
  const assets = path.join(root, 'skills');
  let queue = Promise.resolve();
  const run = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
  const view = state => ({ ...clone(state), dataPath: root });
  async function persist(state) {
    validateState(state);
    const serialized = JSON.stringify(state, null, 2);
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) fail('ข้อมูลรวมใหญ่เกิน 64 MB กรุณาลดจำนวนหรือขนาด Skill');
    await directory(root, true);
    const temp = path.join(root, `state-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, serialized, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temp, statePath);
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function load(initialize = true) {
    await directory(root, true);
    try {
      const stat = await fs.lstat(statePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) fail('ไฟล์ข้อมูลไม่ถูกต้อง');
      return validateState(JSON.parse(await fs.readFile(statePath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error instanceof SyntaxError) fail('อ่านไฟล์ข้อมูลไม่ได้ กรุณาเก็บไฟล์เดิมไว้ก่อน');
        throw error;
      }
      const state = { version: 1, skills: [], profiles: ['Codex', 'Claude', 'Gemini', 'ChatGPT'].map(name => ({ id: randomUUID(), name, provider: name, skillIds: [] })) };
      if (initialize) await persist(state);
      return state;
    }
  }
  async function copyFiles(files, target) {
    for (const file of files) {
      const stat = await fs.lstat(file.full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) fail('ไฟล์ต้นทางเปลี่ยนระหว่างนำเข้า กรุณาลองใหม่');
      const dest = path.join(target, file.relative);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(file.full, dest, 1);
    }
  }
  return {
    getState: () => run(async () => view(await load())),
    mergeSnapshot: (snapshot, payloadRoot) => run(async () => {
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.skills) || !Array.isArray(snapshot.profiles) || snapshot.skills.length > 5000 || snapshot.profiles.length > 500) fail('ข้อมูลย้ายเครื่องไม่ถูกต้องหรือเกินขีดจำกัด');
      let incoming;
      try {
        if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_STATE_BYTES) fail('ข้อมูลย้ายเครื่องใหญ่เกิน 64 MB');
        incoming = { version: 1, skills: snapshot.skills.map(portableSkill), profiles: snapshot.profiles.map(profile => ({ id: profile.id, name: profile.name, provider: profile.provider, skillIds: Array.isArray(profile.skillIds) ? [...profile.skillIds] : profile.skillIds })) };
      } catch (error) { if (error instanceof TypeError) fail('ข้อมูลย้ายเครื่องอ่านไม่ได้'); throw error; }
      validateState(incoming);
      if (typeof payloadRoot !== 'string' || !path.isAbsolute(payloadRoot)) fail('โฟลเดอร์ข้อมูลย้ายเครื่องไม่ถูกต้อง');
      await safeAncestry(payloadRoot);
      payloadRoot = await fs.realpath(payloadRoot);
      const inside = (a, b) => { const rel = path.relative(a, b); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
      if (inside(root, payloadRoot) || inside(payloadRoot, root)) fail('โฟลเดอร์ย้ายเครื่องต้องแยกจากคลังข้อมูล');
      const sourceRoot = path.join(payloadRoot, 'skills');
      const sourceIds = new Set(), descriptors = [];
      let fileCount = 0, byteCount = 0;
      if (incoming.skills.length) {
        await safeAncestry(sourceRoot);
        const declared = new Set(incoming.skills.map(skill => skill.id));
        for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) if (!declared.has(entry.name)) fail('พบข้อมูล Skill ที่ไม่ได้ประกาศในชุดย้ายเครื่อง');
      }
      // Validate every source before initializing or changing destination state.
      for (const skill of incoming.skills) {
        if (!safeName(skill.id) || sourceIds.has(skill.id.toLowerCase())) fail('รหัส Skill ซ้ำหรือไม่รองรับบน Windows');
        sourceIds.add(skill.id.toLowerCase());
        const folder = path.join(sourceRoot, skill.id);
        await safeAncestry(folder);
        const files = await collect(folder);
        const main = files.find(file => file.relative === 'SKILL.md');
        if (!main || main.size > LIMITS.contentBytes || files.length !== skill.fileCount) fail('ไฟล์ Skill ในชุดย้ายเครื่องไม่ครบหรือจำนวนไม่ตรง');
        const content = await boundedRead(main.full, main.size);
        if (!content.equals(Buffer.from(skill.content, 'utf8'))) fail('เนื้อหา SKILL.md ไม่ตรงกับข้อมูลย้ายเครื่อง');
        fileCount += files.length;
        byteCount += files.reduce((sum, file) => sum + file.size, 0);
        if (fileCount > 50000 || byteCount > 512 * 1024 * 1024) fail('ชุดย้ายเครื่องใหญ่เกิน 50,000 ไฟล์ หรือ 512 MB');
        descriptors.push({ skill, files, fingerprint: await skillFilesHash(skill, files) });
      }
      const state = await load(false);
      const skillMap = {}, profileMap = {}, added = [], copied = [];
      const usedIds = new Set(state.skills.map(skill => skill.id.toLowerCase()));
      const existingByMetadata = new Map(), fingerprints = new Map();
      for (const skill of state.skills) {
        const key = skillMetadataHash(skill), group = existingByMetadata.get(key) || [];
        group.push(skill);
        existingByMetadata.set(key, group);
      }
      async function existingFingerprint(skill) {
        if (!fingerprints.has(skill.id)) {
          try {
            let files = [];
            if (skill.source === 'imported' || skill.fileCount > 1) {
              await safeAncestry(path.join(assets, skill.id));
              files = await collect(path.join(assets, skill.id));
              if (!files.some(file => file.relative === 'SKILL.md') || files.length !== skill.fileCount) throw new Error('Incomplete assets');
            }
            fingerprints.set(skill.id, await skillFilesHash(skill, files));
          } catch { fingerprints.set(skill.id, null); }
        }
        return fingerprints.get(skill.id);
      }
      for (const descriptor of descriptors) {
        const source = descriptor.skill;
        const candidates = existingByMetadata.get(skillMetadataHash(source)) || [];
        candidates.sort((a, b) => Number(b.id === source.id) - Number(a.id === source.id));
        let identical;
        for (const candidate of candidates) if (await existingFingerprint(candidate) === descriptor.fingerprint) { identical = candidate; break; }
        if (identical) { skillMap[source.id] = identical.id; continue; }
        let id = source.id;
        const present = async value => fs.lstat(path.join(assets, value)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        while (usedIds.has(id.toLowerCase()) || await present(id)) id = randomUUID();
        usedIds.add(id.toLowerCase());
        const skill = { ...clone(source), id };
        state.skills.push(skill);
        skillMap[source.id] = id;
        added.push({ ...descriptor, skill });
        fingerprints.set(id, descriptor.fingerprint);
        const key = skillMetadataHash(skill), group = existingByMetadata.get(key) || [];
        group.push(skill); existingByMetadata.set(key, group);
      }
      let addedProfiles = 0;
      const profileSignature = profile => JSON.stringify([profile.name, profile.provider, [...profile.skillIds].sort()]);
      for (const source of incoming.profiles) {
        const profile = { ...source, skillIds: [...new Set(source.skillIds.map(id => skillMap[id]))] };
        const signature = profileSignature(profile);
        const identical = state.profiles.find(item => profileSignature(item) === signature);
        if (identical) { profileMap[source.id] = identical.id; continue; }
        if (state.profiles.some(item => item.id === profile.id)) profile.id = randomUUID();
        state.profiles.push(profile);
        profileMap[source.id] = profile.id;
        addedProfiles++;
      }
      validateState(state);
      if (Buffer.byteLength(JSON.stringify(state, null, 2)) > MAX_STATE_BYTES) fail('ข้อมูลรวมหลังย้ายเครื่องใหญ่เกิน 64 MB');
      let committed = false;
      try {
        if (added.length) { await safeAncestry(root); await directory(assets, true); await safeAncestry(assets); }
        for (const descriptor of added) {
          const target = path.join(assets, descriptor.skill.id);
          await fs.mkdir(target);
          copied.push(target);
          await copyFiles(descriptor.files, target);
          const resultFiles = await collect(target);
          const main = resultFiles.find(file => file.relative === 'SKILL.md');
          if (!main || !(await boundedRead(main.full, main.size)).equals(Buffer.from(descriptor.skill.content)) || await skillFilesHash(descriptor.skill, resultFiles) !== descriptor.fingerprint) fail('ไฟล์ย้ายเครื่องเปลี่ยนระหว่างคัดลอก กรุณาลองใหม่');
        }
        await persist(state);
        committed = true;
        return { state: view(state), skillMap, profileMap, addedSkills: added.length, addedProfiles };
      } finally {
        if (!committed) for (const target of copied) await fs.rm(target, { recursive: true, force: true });
      }
    }),
    saveSkill: input => run(async () => {
      validateSkill(input);
      const state = await load();
      const previous = input.id ? state.skills.find(s => s.id === input.id) : null;
      if (input.id && !previous) fail('ไม่พบ Skill ที่ต้องการแก้ไข');
      const skill = { id: previous?.id || randomUUID(), name: input.name.trim(), description: input.description.trim(), category: input.category.trim(), content: input.content, updatedAt: new Date().toISOString(), source: previous?.source || 'created', fileCount: previous?.fileCount || 1 };
      if (previous?.originPath) skill.originPath = previous.originPath;
      if (previous?.originRepo) skill.originRepo = clone(previous.originRepo);
      state.skills = previous ? state.skills.map(s => s.id === skill.id ? skill : s) : [...state.skills, skill];
      await persist(state);
      return view(state);
    }),
    deleteSkill: id => run(async () => {
      if (!validId(id)) fail('รหัส Skill ไม่ถูกต้อง');
      const state = await load();
      if (!state.skills.some(s => s.id === id)) fail('ไม่พบ Skill ที่ต้องการลบ');
      state.skills = state.skills.filter(s => s.id !== id);
      state.profiles.forEach(p => { p.skillIds = p.skillIds.filter(key => key !== id); });
      await persist(state);
      // Retain orphaned support files for recovery; they are no longer exported.
      return view(state);
    }),
    saveProfile: input => run(async () => {
      const state = await load();
      validateProfile(input, new Set(state.skills.map(s => s.id)));
      if (input.id && !state.profiles.some(p => p.id === input.id)) fail('ไม่พบโปรไฟล์ที่ต้องการแก้ไข');
      const profile = { id: input.id || randomUUID(), name: input.name.trim(), provider: input.provider.trim(), skillIds: [...input.skillIds] };
      state.profiles = input.id ? state.profiles.map(p => p.id === profile.id ? profile : p) : [...state.profiles, profile];
      await persist(state);
      return view(state);
    }),
    deleteProfile: id => run(async () => {
      if (!validId(id)) fail('รหัสโปรไฟล์ไม่ถูกต้อง');
      const state = await load();
      if (!state.profiles.some(p => p.id === id)) fail('ไม่พบโปรไฟล์ที่ต้องการลบ');
      state.profiles = state.profiles.filter(p => p.id !== id);
      await persist(state);
      return view(state);
    }),
    importSkill: (folder, options = {}) => run(async () => {
      if (typeof folder !== 'string' || !path.isAbsolute(folder)) fail('ตำแหน่ง Skill ไม่ถูกต้อง');
      if (!options || typeof options !== 'object' || Array.isArray(options)) fail('ตัวเลือกการนำเข้าไม่ถูกต้อง');
      if (options.repo !== undefined) validateRepo(options.repo);
      const state = await load();
      await directory(folder);
      const originPath = await fs.realpath(folder);
      const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
      if (state.skills.some(skill => skill.originPath && comparable(skill.originPath) === comparable(originPath))) return view(state);
      const files = await collect(folder);
      const main = files.find(f => f.relative === 'SKILL.md');
      if (!main || main.size > LIMITS.contentBytes) fail('ต้องมีไฟล์ SKILL.md ที่โฟลเดอร์หลัก ขนาดไม่เกิน 2 MB');
      const content = await fs.readFile(main.full, 'utf8');
      const input = { ...metadata(content, folder), content };
      validateSkill(input);
      await directory(assets, true);
      const id = randomUUID();
      const target = path.join(assets, id);
      await fs.mkdir(target);
      try {
        await copyFiles(files, target);
        const skill = { ...input, id, updatedAt: new Date().toISOString(), source: 'imported', fileCount: files.length, originPath };
        if (options.repo) skill.originRepo = clone(options.repo);
        state.skills.push(skill);
        await persist(state);
      } catch (error) { await fs.rm(target, { recursive: true, force: true }); throw error; }
      return view(state);
    }),
    materializeSkill: (id, destination) => run(async () => {
      if (!validId(id) || typeof destination !== 'string' || !path.isAbsolute(destination)) fail('ตำแหน่งเตรียมติดตั้ง Skill ไม่ถูกต้อง');
      const state = await load();
      const skill = state.skills.find(item => item.id === id);
      if (!skill) fail('ไม่พบ Skill ที่ต้องการติดตั้ง');
      await safeAncestry(path.dirname(destination));
      const realParent = await fs.realpath(path.dirname(destination));
      const resolvedDestination = path.join(realParent, path.basename(destination));
      const resolvedRoot = await fs.realpath(root);
      const relative = path.relative(resolvedRoot, resolvedDestination);
      const inverse = path.relative(resolvedDestination, resolvedRoot);
      const inside = value => value === '' || (value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
      if (inside(relative) || inside(inverse) || !safeName(path.basename(destination))) fail('ต้องเตรียมติดตั้งนอกโฟลเดอร์คลังข้อมูล');
      await fs.mkdir(resolvedDestination);
      try {
        if (skill.source === 'imported' || skill.fileCount > 1) {
          await safeAncestry(path.join(assets, skill.id));
          const files = await collect(path.join(assets, skill.id));
          if (!files.some(file => file.relative === 'SKILL.md')) fail('ไฟล์ Skill ที่นำเข้าไม่ครบ กรุณานำเข้าใหม่');
          await copyFiles(files.filter(file => file.relative !== 'SKILL.md'), resolvedDestination);
        }
        await fs.writeFile(path.join(resolvedDestination, 'SKILL.md'), skill.content, {encoding:'utf8',flag:'wx'});
        return { path: resolvedDestination, skill: clone(skill) };
      } catch (error) {
        await fs.rm(resolvedDestination, {recursive:true,force:true});
        throw error;
      }
    }),
    exportProfile: (profileId, destination) => run(async () => {
      if (!validId(profileId)) fail('รหัสโปรไฟล์ไม่ถูกต้อง');
      if (typeof destination !== 'string' || !path.isAbsolute(destination)) fail('ตำแหน่งส่งออกไม่ถูกต้อง');
      const state = await load();
      const profile = state.profiles.find(p => p.id === profileId);
      if (!profile) fail('ไม่พบโปรไฟล์ที่ต้องการส่งออก');
      if (!profile.skillIds.length) fail('เลือก Skill อย่างน้อยหนึ่งรายการก่อนส่งออก');
      await directory(destination);
      const resolvedDestination = await fs.realpath(destination);
      const resolvedRoot = await fs.realpath(root);
      const relative = path.relative(resolvedRoot, resolvedDestination);
      if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail('กรุณาส่งออกไปยังโฟลเดอร์นอกพื้นที่ข้อมูลของแอป');
      const target = path.join(destination, `SkillHub-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
      await fs.mkdir(target);
      try {
        const selected = state.skills.filter(s => profile.skillIds.includes(s.id));
        for (const skill of selected) {
          const dest = path.join(target, 'skills', skill.id);
          await fs.mkdir(dest, { recursive: true });
          if (skill.source === 'imported' || skill.fileCount > 1) {
            await directory(assets);
            const files = await collect(path.join(assets, skill.id));
            if (!files.some(f => f.relative === 'SKILL.md')) fail('ไฟล์ Skill ที่นำเข้าไม่ครบ กรุณานำเข้าใหม่');
            await copyFiles(files.filter(f => f.relative !== 'SKILL.md'), dest);
          }
          await fs.writeFile(path.join(dest, 'SKILL.md'), skill.content, { encoding: 'utf8', flag: 'wx' });
        }
        const manifest = { version: 1, exportedAt: new Date().toISOString(), profile, skills: selected.map(s => ({ id: s.id, name: s.name, path: `skills/${s.id}/SKILL.md` })) };
        await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
        await fs.writeFile(path.join(target, 'README.md'), '# Skill Hub bundle\n\nThis bundle contains Markdown instructions and supporting files. It does not install or execute skills. Review contents and copy the individual skill folders into the directory supported by your AI tool. Provider-specific installation is not automatic.\n', { flag: 'wx' });
        return { path: target, count: selected.length };
      } catch (error) { await fs.rm(target, { recursive: true, force: true }); throw error; }
    })
  };
}

module.exports = { createStore, LIMITS };
