// HW Monitor — zero-dependency local server.
// Collects hardware data through PowerShell/CIM and streams it to the dashboard via SSE.
const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, execFile } = require('child_process');

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg?.slice(7) || process.env.PORT) || 5757;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

let specs = null;
let specsPromise = null;
const latest = {}; // last line per SSE event, replayed to new clients
const clients = new Set();

function loadSpecs() {
  if (specsPromise) return specsPromise;
  specsPromise = new Promise((resolve, reject) => {
    execFile('powershell.exe', [...PS_ARGS, path.join(ROOT, 'ps', 'specs.ps1')],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        specsPromise = null;
        if (err) return reject(err);
        try {
          specs = JSON.parse(stdout.trim());
          resolve(specs);
        } catch (e) {
          reject(e);
        }
      });
  });
  return specsPromise;
}

// Volume usage changes slowly; refresh it on a timer instead of in the live loop.
async function refreshVolumes() {
  if (!specs) return;
  for (const disk of specs.disks || []) {
    for (const v of disk.volumes || []) {
      try {
        const s = await fs.promises.statfs(v.letter + '\\');
        v.size = s.blocks * s.bsize;
        v.free = s.bavail * s.bsize;
      } catch { /* drive may be gone */ }
    }
  }
}

const SENSORS_EXE = path.join(ROOT, 'sensors', 'dist', 'HwSensors.exe');
const children = new Set();

function broadcast(event, data) {
  latest[event] = data;
  for (const res of clients) res.write(`event: ${event}\ndata: ${data}\n\n`);
}

// Runs a collector that prints one JSON object per line and restarts it if it dies.
function startStream(event, command, args) {
  const child = spawn(command, args, { windowsHide: true });
  children.add(child);
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.startsWith('{')) broadcast(event, line);
  });
  child.on('error', (e) => console.error(`${event} collector failed:`, e.message));
  child.on('exit', () => {
    children.delete(child);
    setTimeout(() => startStream(event, command, args), 3000);
  });
}

function startCollectors() {
  startStream('live', 'powershell.exe', [...PS_ARGS, path.join(ROOT, 'ps', 'live.ps1'), '-IntervalMs', '1000', '-ParentPid', String(process.pid)]);
  // Temperatures / fans via LibreHardwareMonitor; optional, built with sensors/build.cmd
  if (fs.existsSync(SENSORS_EXE)) startStream('sensors', SENSORS_EXE, ['1000']);
  else broadcast('sensors', JSON.stringify({ missing: true }));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/specs') {
    try {
      if (!specs || url.searchParams.has('refresh')) await loadSpecs();
      await refreshVolumes();
      return sendJson(res, 200, specs);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (url.pathname === '/api/live') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    for (const [event, data] of Object.entries(latest)) res.write(`event: ${event}\ndata: ${data}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Static files; resolve and confine to PUBLIC_DIR
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// --app (used by launch.ps1): exit once no window has been connected for a while.
const APP_MODE = process.argv.includes('--app');

function watchIdle() {
  let idleSince = Date.now();
  setInterval(() => {
    if (clients.size) idleSince = Date.now();
    else if (Date.now() - idleSince > 30000) shutdown();
  }, 5000);
}

function shutdown() {
  for (const child of children) child.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (HW Monitor already running?)` : e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HW Monitor running at http://localhost:${PORT}`);
  startCollectors();
  loadSpecs().catch((e) => console.error('Spec collection failed:', e.message));
  setInterval(refreshVolumes, 15000);
  if (APP_MODE) watchIdle();
});
