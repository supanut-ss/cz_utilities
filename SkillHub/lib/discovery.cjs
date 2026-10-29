const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const LIMITS = Object.freeze({ directories: 5000, entries: 20000, depth: 10, candidates: 1000, skillBytes: 2 * 1024 * 1024 });
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', '.next', 'target', '.cache']);
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => comparable(a) === comparable(b);
const inside = (root, folder) => { const rel = path.relative(root, folder); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const errorMessage = error => error.code === 'EACCES' || error.code === 'EPERM' ? 'ไม่มีสิทธิ์อ่านโฟลเดอร์' : error.message || 'อ่านโฟลเดอร์ไม่ได้';

async function validateFolder(root, folder) {
  if (!inside(root, folder)) throw new Error('ตำแหน่ง Skill อยู่นอกโฟลเดอร์ที่สแกน');
  const relative = path.relative(root, folder);
  let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('โฟลเดอร์ Skill เปลี่ยนไปหรือเป็นลิงก์ กรุณาค้นหาใหม่');
  }
  if (!samePath(await fs.realpath(folder), folder)) throw new Error('ตำแหน่งต้นทางเปลี่ยนไป กรุณาค้นหาใหม่');
}

async function readHeader(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SKILL.md ต้องเป็นไฟล์ปกติและไม่ใช่ลิงก์');
  if (stat.size > LIMITS.skillBytes) throw new Error('SKILL.md ใหญ่เกิน 2 MB');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > LIMITS.skillBytes || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('SKILL.md เปลี่ยนระหว่างอ่าน กรุณาค้นหาใหม่');
    const buffer = Buffer.alloc(Math.min(opened.size, 65536));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

function parseHeader(content, folder) {
  const frontmatter = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const field = key => {
    const value = frontmatter.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm'))?.[1] || '';
    return /^[>|]/.test(value) ? '' : value.replace(/^(['"])(.*)\1$/, '$2').trim();
  };
  return { name: (field('name') || path.basename(folder)).slice(0, 120), description: field('description').slice(0, 600) };
}

function createDiscovery({ roots } = {}) {
  if (!Array.isArray(roots) || roots.some(r => !r || typeof r.path !== 'string' || !path.isAbsolute(r.path) || typeof r.provider !== 'string' || !r.provider.trim()) || roots.length > 30) throw new Error('รายการโฟลเดอร์ค้นหาไม่ถูกต้อง');
  roots = roots.map(root => ({ path: path.resolve(root.path), provider: root.provider }));
  let allowed = new Map();
  let queue = Promise.resolve();
  const run = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
  return {
    scan: state => run(async () => {
      allowed = new Map();
      const items = [], statuses = [], warnings = [];
      const imported = new Set((Array.isArray(state?.skills) ? state.skills : []).filter(s => typeof s.originPath === 'string').map(s => comparable(s.originPath)));
      const visited = new Set();
      const warned = new Set();
      let directories = 0, entries = 0, links = 0, irrelevant = 0;
      const warn = (key, message) => { if (!warned.has(key)) { warned.add(key); warnings.push(message); } };
      const exhausted = () => directories >= LIMITS.directories || entries >= LIMITS.entries || items.length >= LIMITS.candidates;
      const boundWarning = () => warn('bounds', 'ค้นหายังไม่ครบ: ถึงขีดจำกัดจำนวนโฟลเดอร์ ไฟล์ หรือ Skill แล้ว');
      async function walk(folder, root, provider, depth) {
        if (exhausted()) { boundWarning(); return; }
        if (depth > LIMITS.depth) { warn('depth', 'ค้นหายังไม่ครบ: มีโฟลเดอร์ซ้อนเกิน 10 ระดับ'); return; }
        const stat = await fs.lstat(folder);
        if (stat.isSymbolicLink()) { links++; return; }
        if (!stat.isDirectory()) return;
        const canonical = await fs.realpath(folder);
        if (!inside(root, canonical)) { warn('outside', 'ข้ามโฟลเดอร์ที่ชี้ออกนอกพื้นที่ค้นหา'); return; }
        const key = comparable(canonical);
        if (visited.has(key)) return;
        visited.add(key);
        directories++;
        let foundSkill = false;
        try {
          const mainStat = await fs.lstat(path.join(canonical, 'SKILL.md'));
          foundSkill = true;
          if (mainStat.isSymbolicLink()) { links++; return; }
          const content = await readHeader(path.join(canonical, 'SKILL.md'));
          const item = { id: randomUUID(), ...parseHeader(content, canonical), provider, path: canonical, imported: imported.has(key) };
          items.push(item);
          allowed.set(item.id, { path: canonical, root, name: item.name });
        } catch (error) {
          if (error.code !== 'ENOENT' || foundSkill) warn(`read:${canonical}`, `ข้าม ${path.basename(canonical)}: ${errorMessage(error)}`);
        }
        if (foundSkill) return;
        const children = [];
        const directory = await fs.opendir(canonical);
        for await (const entry of directory) {
          entries++;
          if (entries >= LIMITS.entries) { boundWarning(); break; }
          if (entry.isSymbolicLink()) { links++; continue; }
          if (!entry.isDirectory()) continue;
          if (SKIP.has(entry.name.toLowerCase())) { irrelevant++; continue; }
          children.push(entry.name);
        }
        children.sort((a, b) => a.localeCompare(b));
        for (const child of children) {
          if (exhausted()) { boundWarning(); break; }
          try { await walk(path.join(canonical, child), root, provider, depth + 1); }
          catch (error) { warn(`folder:${canonical}/${child}`, `ข้าม ${child}: ${errorMessage(error)}`); }
        }
      }
      for (const configured of roots) {
        const status = { ...configured, status: 'scanned' };
        statuses.push(status);
        try {
          const stat = await fs.lstat(configured.path);
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            status.status = 'error';
            warn(`root:${configured.path}`, `ข้าม ${configured.provider}: โฟลเดอร์ค้นหาไม่ใช่โฟลเดอร์ปกติหรือเป็นลิงก์`);
            continue;
          }
          const canonical = await fs.realpath(configured.path);
          if (exhausted()) { boundWarning(); status.status = 'error'; continue; }
          await walk(canonical, canonical, configured.provider, 0);
        } catch (error) {
          status.status = error.code === 'ENOENT' ? 'missing' : 'error';
          if (status.status === 'error') warn(`root:${configured.path}`, `อ่าน ${configured.provider} ไม่ได้: ${errorMessage(error)}`);
        }
      }
      if (links) warnings.push(`ข้ามลิงก์ไฟล์หรือโฟลเดอร์ ${links} รายการ`);
      if (irrelevant) warnings.push(`ข้ามโฟลเดอร์ระบบและผลลัพธ์การ build ${irrelevant} รายการ`);
      items.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
      return { items, roots: statuses, warnings };
    }),
    importSelected: (ids, store) => run(async () => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('เลือก Skill ได้ครั้งละ 1 ถึง 200 รายการ และต้องไม่ซ้ำกัน');
      if (!store || typeof store.getState !== 'function' || typeof store.importSkill !== 'function') throw new Error('ระบบจัดเก็บไม่พร้อมใช้งาน');
      let state = await store.getState();
      let importedCount = 0;
      const failures = [];
      for (const id of ids) {
        const candidate = allowed.get(id);
        if (!candidate) { failures.push({ name: 'Skill ที่เลือก', error: 'รายการค้นหาหมดอายุหรือไม่ถูกต้อง กรุณาค้นหาใหม่' }); continue; }
        try {
          await validateFolder(candidate.root, candidate.path);
          await readHeader(path.join(candidate.path, 'SKILL.md'));
          if (state.skills.some(s => s.originPath && samePath(s.originPath, candidate.path))) continue;
          const previousCount = state.skills.length;
          state = await store.importSkill(candidate.path);
          if (state.skills.length > previousCount) importedCount++;
        } catch (error) { failures.push({ name: candidate.name, error: errorMessage(error) }); }
      }
      return { state, importedCount, failures };
    })
  };
}

module.exports = { createDiscovery, LIMITS };
