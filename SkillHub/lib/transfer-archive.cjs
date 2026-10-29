const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const { createWriteStream, createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const yazl = require('yazl');

const LIMITS = Object.freeze({ packageBytes: 512 * 1024 * 1024, expandedBytes: 512 * 1024 * 1024, entries: 50000, manifestBytes: 64 * 1024 * 1024, fileBytes: 20 * 1024 * 1024 });
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const safeName = value => typeof value === 'string' && !!value && value !== '.' && value !== '..' && !/[<>:"/\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value);
const within = (root, item) => { const relative = path.relative(root, item); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
const fail = message => { throw new Error(message); };
const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });

async function ancestry(location, allowMissing = false) {
  if (typeof location !== 'string' || !path.isAbsolute(location) || location.includes('\0')) fail('ตำแหน่งไฟล์ย้ายเครื่องไม่ถูกต้อง');
  const absolute = path.resolve(location), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory())) fail('ไม่รองรับลิงก์หรือส่วนพาธที่ไม่ใช่โฟลเดอร์');
    } catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
  }
}

function archivePath(value, directory = false) {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('\\')) fail('พาธในชุดย้ายเครื่องไม่ปลอดภัย');
  const normalized = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  const parts = normalized.split('/');
  if (parts.length > 20 || parts.some(part => !safeName(part))) fail('ชื่อไฟล์ในชุดย้ายเครื่องไม่รองรับบน Windows');
  if (normalized === 'manifest.json' && !directory) return normalized;
  if (parts[0] !== 'skills' || (parts.length < 3 && !directory) || (parts.length > 1 && !validId(parts[1]))) fail('ชุดย้ายเครื่องมีไฟล์อยู่นอกโฟลเดอร์ Skill');
  return normalized;
}

async function hashHandle(handle, maximum) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
    bytes += chunk.length;
    if (bytes > maximum) fail('ไฟล์ย้ายเครื่องมีขนาดใหญ่เกินกำหนด');
    hash.update(chunk);
  }
  return { size: bytes, sha256: hash.digest('hex') };
}

async function hashFile(file, maximum = LIMITS.packageBytes) {
  await ancestry(file);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > maximum) fail('ไฟล์ย้ายเครื่องไม่ถูกต้องหรือใหญ่เกินกำหนด');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail('ไฟล์เปลี่ยนระหว่างอ่าน กรุณาลองใหม่');
    const result = await hashHandle(handle, maximum);
    const after = await handle.stat();
    if (result.size !== stat.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail('ไฟล์เปลี่ยนระหว่างอ่าน กรุณาลองใหม่');
    return result;
  } finally { await handle.close(); }
}

async function writeArchive(destination, manifest, files) {
  const serialized = Buffer.from(JSON.stringify(manifest, null, 2));
  if (serialized.length > LIMITS.manifestBytes || files.length + 1 > LIMITS.entries) fail('ข้อมูลย้ายเครื่องมีขนาดเกินกำหนด');
  await ancestry(path.dirname(destination));
  const archive = new yazl.ZipFile();
  const max = new Transform({ transform(chunk, _encoding, done) {
    this.bytes = (this.bytes || 0) + chunk.length;
    done(this.bytes > LIMITS.packageBytes ? new Error('ชุดย้ายเครื่องใหญ่เกิน 512 MB') : null, chunk);
  } });
  const output = createWriteStream(destination, { flags: 'wx' });
  const writing = pipeline(archive.outputStream, max, output);
  archive.on('error', error => archive.outputStream.destroy(error));
  try {
    archive.addBuffer(serialized, 'manifest.json');
    for (const file of files) { archivePath(file.path); await ancestry(file.absolute); archive.addFile(file.absolute, file.path); }
    archive.end();
    await writing;
  } catch (error) { archive.outputStream.destroy(error); await writing.catch(() => {}); throw error; }
}

async function extractArchive(source, destination) {
  await ancestry(source);
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.size > LIMITS.packageBytes) fail('ชุดย้ายเครื่องต้องเป็นไฟล์ปกติ ขนาดไม่เกิน 512 MB');
  const archiveFd = await new Promise((resolve, reject) => nativeFs.open(source, 'r', (error, fd) => error ? reject(error) : resolve(fd)));
  let verifier;
  let archiveClosedHandle = false;
  try {
    verifier = await fs.open(source, 'r');
    const opened = await new Promise((resolve, reject) => nativeFs.fstat(archiveFd, (error, result) => error ? reject(error) : resolve(result)));
    const verifierOpened = await verifier.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || verifierOpened.ino !== opened.ino || verifierOpened.dev !== opened.dev || verifierOpened.size !== opened.size) fail('ไฟล์ย้ายเครื่องเปลี่ยนระหว่างอ่าน');
    const before = await hashHandle(verifier, LIMITS.packageBytes);
    const files = [];
    let total = 0;
    await new Promise((resolve, reject) => {
      yauzl.fromFd(archiveFd, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false }, (error, archive) => {
        if (error) { reject(new Error('ไฟล์ชุดย้ายเครื่องไม่ใช่ ZIP ที่ถูกต้อง')); return; }
        const seen = new Set(), prefixes = new Map();
        let count = 0, settled = false, actualBytes = 0;
        const abort = cause => { if (!settled) { settled = true; archiveClosedHandle = true; archive.close(); reject(cause); } };
        archive.on('error', () => abort(new Error('อ่าน ZIP ชุดย้ายเครื่องไม่ได้')));
        archive.on('end', () => { if (!settled) { settled = true; archiveClosedHandle = true; archive.close(); resolve(); } });
        archive.on('entry', entry => {
          (async () => {
            if (++count > LIMITS.entries) fail('ชุดย้ายเครื่องมีไฟล์เกิน 50,000 รายการ');
            if (entry.generalPurposeBitFlag & 1) fail('ไม่รองรับชุดย้ายเครื่องที่เข้ารหัส');
            const directory = entry.fileName.endsWith('/');
            const name = archivePath(entry.fileName, directory);
            const parts = name.split('/'), key = name.toLowerCase();
            if (seen.has(key)) fail('ชุดย้ายเครื่องมีชื่อไฟล์ซ้ำบน Windows');
            seen.add(key);
            for (let i = 0; i < parts.length; i++) {
              const prefix = parts.slice(0, i + 1).join('/'), isDirectory = i < parts.length - 1 || directory;
              const existing = prefixes.get(prefix.toLowerCase());
              if (existing && (existing.path !== prefix || existing.directory !== isDirectory)) fail('ชุดย้ายเครื่องมีพาธที่ชนกันบน Windows');
              prefixes.set(prefix.toLowerCase(), { path: prefix, directory: isDirectory });
            }
            const mode = entry.externalFileAttributes >>> 16 & 0xf000;
            if (mode && mode !== 0x4000 && mode !== 0x8000 || mode === 0x4000 && !directory || mode === 0x8000 && directory) fail('ชุดย้ายเครื่องมีลิงก์หรือชนิดไฟล์ที่ไม่รองรับ');
            const maximum = name === 'manifest.json' ? LIMITS.manifestBytes : LIMITS.fileBytes;
            if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > maximum) fail('ไฟล์ในชุดย้ายเครื่องใหญ่เกินกำหนด');
            total += entry.uncompressedSize;
            if (total > LIMITS.expandedBytes) fail('ชุดย้ายเครื่องหลังคลาย ZIP ใหญ่เกิน 512 MB');
            const target = path.resolve(destination, ...parts);
            if (!within(destination, target)) fail('พาธชุดย้ายเครื่องออกนอกโฟลเดอร์ที่กำหนด');
            if (directory) { if (entry.uncompressedSize !== 0) fail('โฟลเดอร์ในชุดย้ายเครื่องไม่ถูกต้อง'); await fs.mkdir(target, { recursive: true }); return; }
            await fs.mkdir(path.dirname(target), { recursive: true });
            const stream = await new Promise((success, failure) => archive.openReadStream(entry, (problem, value) => problem ? failure(problem) : success(value)));
            let checksum = 0xffffffff, size = 0;
            const hash = createHash('sha256');
            const counter = new Transform({ transform(chunk, _encoding, done) {
              size += chunk.length; actualBytes += chunk.length;
              if (size > maximum || actualBytes > LIMITS.expandedBytes) { done(new Error('ข้อมูลย้ายเครื่องหลังคลาย ZIP ใหญ่เกินกำหนด')); return; }
              hash.update(chunk);
              for (const byte of chunk) checksum = crcTable[(checksum ^ byte) & 255] ^ checksum >>> 8;
              done(null, chunk);
            } });
            await pipeline(stream, counter, createWriteStream(target, { flags: 'wx' }));
            if ((checksum ^ 0xffffffff) >>> 0 !== entry.crc32) fail('ข้อมูลไฟล์ย้ายเครื่องเสียหาย');
            files.push({ path: name, size, sha256: hash.digest('hex'), absolute: target });
          })().then(() => { if (!settled) archive.readEntry(); }).catch(abort);
        });
        archive.readEntry();
      });
    });
    const after = await hashHandle(verifier, LIMITS.packageBytes);
    const finalStat = await verifier.stat();
    if (before.sha256 !== after.sha256 || finalStat.size !== opened.size || finalStat.mtimeMs !== opened.mtimeMs) fail('ไฟล์ย้ายเครื่องเปลี่ยนระหว่างอ่าน กรุณาลองใหม่');
    return { packageHash: before.sha256, files };
  } finally {
    if (verifier) await verifier.close();
    if (!archiveClosedHandle) nativeFs.closeSync(archiveFd);
  }
}

module.exports = { LIMITS, validId, safeName, within, ancestry, archivePath, hashFile, writeArchive, extractArchive };
