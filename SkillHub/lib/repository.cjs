const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { createDiscovery } = require('./discovery.cjs');

const LIMITS = Object.freeze({ downloadBytes: 50 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, fileBytes: 20 * 1024 * 1024, entries: 10000, depth: 32, ratio: 1000, timeoutMs: 45000 });
const fail = message => { throw new Error(message); };
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
const safeSegment = value => value && value !== '.' && value !== '..' && !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value);
const errorMessage = error => error.code === 'ENOENT' ? 'ไม่พบโฟลเดอร์หรือไฟล์ต้นทาง กรุณาอ่าน repo ใหม่' : error.code === 'EACCES' || error.code === 'EPERM' ? 'ไม่มีสิทธิ์อ่านหรือเขียนโฟลเดอร์นี้' : /[ก-๙]/.test(error.message || '') ? error.message : 'อ่านหรือคัดลอกข้อมูล repo ไม่สำเร็จ กรุณาลองใหม่';
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });

async function plainDirectory(folder, create = false) {
  if (!path.isAbsolute(folder)) fail('ตำแหน่ง repo ต้องเป็นพาธแบบเต็ม');
  const absolute = path.resolve(folder);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (error.code !== 'ENOENT' || !create) throw error; await fs.mkdir(current); stat = await fs.lstat(current); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ตำแหน่ง repo มีลิงก์หรือไม่ใช่โฟลเดอร์ปกติ');
  }
  return fs.realpath(absolute);
}

function parseRepository(input) {
  if (!input || typeof input !== 'object' || typeof input.url !== 'string' || input.url.length > 2048) fail('กรุณาระบุ URL ของ GitHub repo');
  let url;
  try { url = new URL(input.url.trim()); } catch { fail('URL ของ repo ไม่ถูกต้อง'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) fail('รองรับเฉพาะ HTTPS GitHub repo แบบสาธารณะ โดยไม่มีข้อมูลเข้าสู่ระบบ');
  const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  if (segments.length !== 2 || url.pathname.includes('//')) fail('ใช้ URL หน้าหลัก repo เช่น https://github.com/owner/repo แล้วระบุ branch แยกต่างหาก');
  const [owner, rawRepo] = segments;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..') fail('ชื่อเจ้าของหรือชื่อ repo ไม่ถูกต้อง');
  if (input.ref !== undefined && (typeof input.ref !== 'string' || input.ref.length > 200 || /[\x00-\x1f]/.test(input.ref))) fail('ชื่อ branch, tag หรือ commit ไม่ถูกต้อง');
  return { owner, repo, url: `https://github.com/${owner}/${repo}`, ref: input.ref?.trim() || 'HEAD' };
}

async function readResponse(response, maximum, signal) {
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) { await response.body?.cancel?.(); fail('ข้อมูล repo ใหญ่เกินขนาดที่รองรับ'); }
  if (!response.body || !response.body[Symbol.asyncIterator]) fail('อ่านข้อมูลจาก GitHub ไม่สำเร็จ');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    if (signal.aborted) fail('การดาวน์โหลด repo ใช้เวลานานเกินไป กรุณาลองใหม่');
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximum) fail('ข้อมูล repo ใหญ่เกินขนาดที่รองรับ');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function download(fetchImpl, url, maximum) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal, headers: { 'User-Agent': 'SkillHub-Windows/0.3', Accept: url.includes('api.github.com') ? 'application/vnd.github+json' : 'application/zip' } });
    if (!response || !response.ok) {
      await response?.body?.cancel?.();
      if (response?.status === 403 || response?.status === 429) fail('GitHub จำกัดจำนวนการดาวน์โหลด กรุณารอสักครู่แล้วลองใหม่');
      if (response?.status === 404) fail('ไม่พบ repo หรือ ref นี้ รองรับ repo สาธารณะเท่านั้น');
      fail('ดาวน์โหลด repo จาก GitHub ไม่สำเร็จ');
    }
    if (response.url) {
      const actual = new URL(response.url), expected = new URL(url);
      if (actual.protocol !== 'https:' || actual.hostname !== expected.hostname || actual.username || actual.password) fail('ปลายทางดาวน์โหลด repo ไม่ถูกต้อง');
    }
    return await readResponse(response, maximum, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) fail('การดาวน์โหลด repo ใช้เวลานานเกินไป กรุณาลองใหม่');
    if (error instanceof TypeError) fail('เชื่อมต่อ GitHub ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตหรือใช้ repo ในเครื่อง');
    throw error;
  } finally { clearTimeout(timer); }
}

function extractArchive(buffer, destination) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: true }, (error, archive) => {
      if (error) { reject(new Error('ไฟล์ ZIP จาก repo ไม่ถูกต้อง')); return; }
      let count = 0, declaredBytes = 0, actualBytes = 0, settled = false;
      const seen = new Set(), prefixes = new Map();
      const abort = cause => { if (!settled) { settled = true; archive.close(); reject(cause); } };
      archive.on('error', () => abort(new Error('อ่านไฟล์ ZIP จาก repo ไม่สำเร็จ')));
      archive.on('end', () => { if (!settled) { settled = true; resolve(); } });
      archive.on('entry', entry => {
        (async () => {
          count++;
          if (count > LIMITS.entries) fail('repo มีจำนวนไฟล์เกิน 10,000 รายการ');
          if (entry.generalPurposeBitFlag & 1) fail('ไม่รองรับ repo ZIP ที่เข้ารหัส');
          const raw = entry.fileName;
          const directory = raw.endsWith('/');
          const name = directory ? raw.slice(0, -1) : raw;
          const parts = name.split('/');
          if (raw.length > 1024 || !name || parts.length > LIMITS.depth || parts.some(part => !safeSegment(part))) fail('repo มีพาธไฟล์ที่ไม่ปลอดภัยหรือไม่รองรับบน Windows');
          const key = name.toLowerCase();
          if (seen.has(key)) fail('repo มีชื่อไฟล์ซ้ำหรือแตกต่างกันเฉพาะตัวพิมพ์');
          seen.add(key);
          for (let index = 0; index < parts.length; index++) {
            const prefix = parts.slice(0, index + 1).join('/');
            const existing = prefixes.get(prefix.toLowerCase());
            const isDirectory = index < parts.length - 1 || directory;
            if (existing && (existing.path !== prefix || existing.directory !== isDirectory)) fail('repo มีโฟลเดอร์หรือชื่อไฟล์ที่ชนกันบน Windows');
            prefixes.set(prefix.toLowerCase(), { path: prefix, directory: isDirectory });
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode && mode !== 0x4000 && mode !== 0x8000) fail('repo มีลิงก์หรือชนิดไฟล์ที่ไม่รองรับ');
          if ((mode === 0x4000 && !directory) || (mode === 0x8000 && directory)) fail('ชนิดไฟล์ใน repo ZIP ไม่ถูกต้อง');
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > LIMITS.fileBytes || (!directory && entry.uncompressedSize > Math.max(entry.compressedSize, 1) * LIMITS.ratio)) fail('ไฟล์ใน repo ใหญ่หรือบีบอัดหนาแน่นเกินกำหนด');
          declaredBytes += entry.uncompressedSize;
          if (declaredBytes > LIMITS.expandedBytes) fail('ขนาด repo หลังคลาย ZIP เกิน 100 MB');
          const target = path.resolve(destination, ...parts);
          if (!inside(destination, target)) fail('ไฟล์ repo อยู่นอกโฟลเดอร์ที่กำหนด');
          if (directory) { if (entry.uncompressedSize !== 0) fail('โฟลเดอร์ใน repo ZIP มีขนาดไม่ถูกต้อง'); await fs.mkdir(target, { recursive: true }); return; }
          await fs.mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise((success, failure) => archive.openReadStream(entry, (problem, value) => problem ? failure(problem) : success(value)));
          let checksum = 0xffffffff;
          const limit = new Transform({ transform(chunk, _encoding, done) {
            actualBytes += chunk.length;
            for (const byte of chunk) checksum = CRC_TABLE[(checksum ^ byte) & 255] ^ checksum >>> 8;
            if (actualBytes > LIMITS.expandedBytes) done(new Error('ขนาด repo หลังคลาย ZIP เกิน 100 MB'));
            else done(null, chunk);
          } });
          await pipeline(stream, limit, createWriteStream(target, { flags: 'wx' }));
          if (((checksum ^ 0xffffffff) >>> 0) !== entry.crc32) fail('ข้อมูลไฟล์ใน repo ZIP เสียหาย');
        })().then(() => { if (!settled) archive.readEntry(); }).catch(abort);
      });
      archive.readEntry();
    });
  });
}

function createRepository({ cacheRoot, fetchImpl = globalThis.fetch } = {}) {
  if (typeof cacheRoot !== 'string' || !path.isAbsolute(cacheRoot) || typeof fetchImpl !== 'function') fail('ระบบแคช repo ไม่พร้อมใช้งาน');
  cacheRoot = path.resolve(cacheRoot);
  let current = null;
  let queue = Promise.resolve();
  const run = operation => { const next = queue.then(operation).catch(error => { throw new Error(errorMessage(error), { cause: error }); }); queue = next.catch(() => {}); return next; };
  async function removeStage(stage) {
    if (path.dirname(stage) !== cacheRoot || !path.basename(stage).startsWith('.staging-')) fail('ตำแหน่งไฟล์ชั่วคราวไม่ถูกต้อง');
    const stat = await fs.lstat(stage).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat) { if (!stat.isDirectory() || stat.isSymbolicLink()) fail('โฟลเดอร์ชั่วคราวเปลี่ยนไป'); await fs.rm(stage, { recursive: true, force: true }); }
  }
  async function scan(root, source) {
    const scanner = createDiscovery({ roots: [{ path: root, provider: source.commit ? 'GitHub repo' : 'Local repo' }] });
    const found = await scanner.scan();
    const id = randomUUID();
    const candidates = new Map(found.items.map(item => [item.id, { ...item, absolute: item.path, subpath: path.relative(root, item.path).split(path.sep).join('/') }]));
    current = { id, root, source, candidates };
    return { id, url: source.url, ref: source.ref, commit: source.commit, items: [...candidates.values()].map(item => ({ id: item.id, name: item.name, description: item.description, path: item.subpath || '.' })), warnings: [...found.warnings, ...(!found.items.length ? ['ไม่พบโฟลเดอร์ที่มี SKILL.md ใน repo นี้'] : [])] };
  }
  return {
    preview: input => run(async () => {
      current = null;
      const source = parseRepository(input);
      await plainDirectory(cacheRoot, true);
      const data = await download(fetchImpl, `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref)}`, 1024 * 1024);
      let info;
      try { info = JSON.parse(data.toString('utf8')); } catch { fail('ข้อมูล commit จาก GitHub ไม่ถูกต้อง'); }
      if (!/^[a-f0-9]{40}$/i.test(info?.sha || '')) fail('ไม่พบ commit ที่ถูกต้องจาก GitHub');
      const commit = info.sha.toLowerCase();
      const identifier = createHash('sha256').update(source.url.toLowerCase()).digest('hex').slice(0, 16) + '-' + commit;
      const snapshot = path.join(cacheRoot, identifier);
      const sourceInfo = { url: source.url, ref: source.ref, commit };
      let rootName;
      const exists = await fs.lstat(snapshot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (exists) {
        await plainDirectory(snapshot);
        const marker = path.join(snapshot, 'snapshot.json');
        const stat = await fs.lstat(marker);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) fail('แคช repo ไม่ถูกต้อง กรุณาใช้โฟลเดอร์แคชใหม่');
        let saved;
        try { saved = JSON.parse(await fs.readFile(marker, 'utf8')); } catch { fail('แคช repo เสียหาย'); }
        if (!saved || typeof saved.url !== 'string' || saved.url.toLowerCase() !== source.url.toLowerCase() || saved.commit !== commit || !safeSegment(saved.rootName)) fail('แคช repo ไม่ตรงกับต้นทาง');
        rootName = saved.rootName;
      } else {
        const archive = await download(fetchImpl, `https://codeload.github.com/${source.owner}/${source.repo}/zip/${commit}`, LIMITS.downloadBytes);
        const stage = path.join(cacheRoot, `.staging-${randomUUID()}`);
        await fs.mkdir(stage);
        try {
          const contents = path.join(stage, 'contents'); await fs.mkdir(contents);
          await extractArchive(archive, contents);
          const entries = await fs.readdir(contents, { withFileTypes: true });
          if (entries.length !== 1 || !entries[0].isDirectory() || entries[0].isSymbolicLink() || !safeSegment(entries[0].name)) fail('โครงสร้าง ZIP ของ GitHub repo ไม่ถูกต้อง');
          rootName = entries[0].name;
          await fs.writeFile(path.join(stage, 'snapshot.json'), JSON.stringify({ url: source.url, commit, rootName }), { flag: 'wx' });
          await fs.rename(stage, snapshot);
        } finally { await removeStage(stage); }
      }
      const root = await plainDirectory(path.join(snapshot, 'contents', rootName));
      return scan(root, sourceInfo);
    }),
    previewLocal: folder => run(async () => {
      current = null;
      if (typeof folder !== 'string' || !path.isAbsolute(folder)) fail('กรุณาเลือกโฟลเดอร์ repo บนเครื่อง');
      const root = await plainDirectory(folder);
      return scan(root, { url: root, ref: '', commit: '' });
    }),
    importSelected: (input, store) => run(async () => {
      if (!current || !input || input.repoId !== current.id) fail('รายการ repo หมดอายุ กรุณาอ่าน repo อีกครั้ง');
      const ids = input.skillIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) fail('เลือก Skill ได้ครั้งละ 1 ถึง 200 รายการ และต้องไม่ซ้ำกัน');
      if (!store || typeof store.getState !== 'function' || typeof store.importSkill !== 'function') fail('ระบบจัดเก็บไม่พร้อมใช้งาน');
      let state = await store.getState(), importedCount = 0;
      const failures = [];
      for (const id of ids) {
        const candidate = current.candidates.get(id);
        if (!candidate) { failures.push({ name: 'Skill ที่เลือก', error: 'ไม่พบ Skill ในรายการ repo นี้' }); continue; }
        try {
          if (!inside(current.root, candidate.absolute) || comparable(await plainDirectory(candidate.absolute)) !== comparable(candidate.absolute)) fail('ตำแหน่ง Skill ต้นทางเปลี่ยนไป กรุณาอ่าน repo ใหม่');
          const before = state.skills.length;
          state = await store.importSkill(candidate.absolute, { repo: { ...current.source, subpath: candidate.subpath } });
          importedCount += Math.max(0, state.skills.length - before);
        } catch (error) { failures.push({ name: candidate.name, error: errorMessage(error) }); }
      }
      return { state, importedCount, failures };
    })
  };
}

module.exports = { createRepository, LIMITS };
