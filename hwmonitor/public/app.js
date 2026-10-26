'use strict';

const HISTORY = 60; // samples kept per chart
let specs = null;

const DEFAULT_THRESHOLDS = { cpuTemp: 90, gpuTemp: 85, memory: 90, vram: 90 };
const ALERT_COPY = {
  cpuTemp: ['CPU temperature is high', 'Check the CPU cooler, dust and case airflow.'],
  gpuTemp: ['GPU temperature is high', 'Check GPU fan operation and case airflow.'],
  memory: ['Memory pressure is high', 'Close large applications or reduce the workload.'],
  vram: ['Video memory is nearly full', 'Lower texture quality or close GPU intensive apps.'],
};
const OVERLAY_METRICS = [
  ['cpu', 'CPU load / clock'], ['cpuTemp', 'CPU temperature'], ['gpu', 'GPU load'], ['gpuTemp', 'GPU temperature'],
  ['memory', 'Memory use'], ['memorySpeed', 'RAM speed'], ['vram', 'VRAM use'], ['fan', 'Fan speed'], ['disk', 'Disk activity'],
  ['fps', 'FPS'], ['frameTime', 'Frame time'], ['low1', '1% low'],
];
const OVERLAY_PROFILES = {
  gaming: ['cpu', 'cpuTemp', 'gpu', 'gpuTemp', 'memory', 'vram', 'fps', 'frameTime', 'low1'],
  compact: ['cpu', 'gpu', 'memory', 'cpuTemp', 'gpuTemp', 'fps'],
  full: OVERLAY_METRICS.map(([key]) => key),
};
const readStored = (key, fallback) => {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; }
  catch { return fallback; }
};
let thresholds = { ...DEFAULT_THRESHOLDS, ...readStored('hwm-thresholds', {}) };
for (const [key, defaultValue] of Object.entries(DEFAULT_THRESHOLDS)) {
  const value = Number(thresholds[key]);
  const max = key === 'cpuTemp' || key === 'gpuTemp' ? 110 : 100;
  thresholds[key] = Number.isFinite(value) ? Math.max(50, Math.min(max, value)) : defaultValue;
}
const readArray = (key) => { const value = readStored(key, []); return Array.isArray(value) ? value : []; };
let alertHistory = readArray('hwm-alerts').slice(0, 40);
let sessionHistory = readArray('hwm-sessions').slice(0, 8);
let activeSession = null;
let sessionTimer = null;
let latestReadings = {};
let latestGameMetrics = null;
let gameProcesses = [];
let gameOverlayProfiles = readStored('hwm-game-overlay-profiles', {});
if (!gameOverlayProfiles || typeof gameOverlayProfiles !== 'object' || Array.isArray(gameOverlayProfiles)) gameOverlayProfiles = {};
let alertCounts = {};
let activeAlerts = new Set();
let lastAlertSampleAt = 0;
let presentMonPath = '';
let overlayConfig = normalizeOverlayConfig(readStored('hwm-overlay', {
  profile: 'gaming', metrics: OVERLAY_PROFILES.gaming, opacity: 94,
}));

function normalizeOverlayConfig(value) {
  value = value && typeof value === 'object' ? value : {};
  const valid = new Set(OVERLAY_METRICS.map(([key]) => key));
  const metrics = Array.isArray(value.metrics) ? value.metrics.filter((key) => valid.has(key)) : OVERLAY_PROFILES.gaming;
  return {
    profile: ['gaming', 'compact', 'full', 'custom'].includes(value.profile) ? value.profile : 'gaming',
    metrics: metrics.length ? metrics : OVERLAY_PROFILES.gaming,
    opacity: Math.max(55, Math.min(100, Number(value.opacity) || 94)),
  };
}

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (f(x) || 0), 0);
const setText = (id, text) => { const el = $(id); if (el && el.textContent !== text) el.textContent = text; };
const setHtml = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };

function fmtBytes(b, digits = 1) {
  if (b == null || isNaN(b)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i < 2 ? 0 : digits)} ${u[i]}`;
}
// Drives are sold in decimal units, so show them the same way
function fmtDrive(b) {
  if (!b) return '—';
  return b >= 1e12 ? `${(b / 1e12).toFixed(b >= 1e13 ? 0 : 1)} TB` : `${Math.round(b / 1e9)} GB`;
}
const fmtRate = (bps) => `${fmtBytes(bps)}/s`;
function fmtBits(bps) {
  const bits = (bps || 0) * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bits / 1e3)} Kbps`;
}
const fmtMHz = (m) => (!m ? '—' : m >= 1000 ? `${(m / 1000).toFixed(2)} GHz` : `${m} MHz`);
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const chip = (text, cls = '') => (text ? `<span class="chip ${cls}">${esc(text)}</span>` : '');
const specRows = (rows) => `<dl class="specs">${rows.filter(([, v]) => v != null && v !== '')
  .map(([k, v, id]) => `<dt>${esc(k)}</dt><dd${id ? ` id="${id}"` : ''}>${esc(v)}</dd>`).join('')}</dl>`;
const modelBlock = (vendor, name, chips) =>
  `<div class="model"><div class="vendor">${esc(vendor)}</div><div class="name">${esc(name)}</div><div class="chips">${chips.join('')}</div></div>`;
const barHtml = (id, pct = 0) => `<div class="bar" id="${id}"><div style="width:${clamp(pct)}%"></div></div>`;
function setBar(id, pct) {
  const el = $(id);
  if (!el) return;
  el.firstElementChild.style.width = `${clamp(pct)}%`;
  el.classList.toggle('warn', pct >= 80 && pct < 92);
  el.classList.toggle('bad', pct >= 92);
}

// ---------- Theme-aware colors ----------
let colorCache = {};
function cssVar(name) {
  if (!(name in colorCache)) colorCache[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return colorCache[name];
}
function rgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- Canvas chart ----------
// History lives outside chart instances so it survives re-rendering on rescan.
const historyStore = {};
const charts = new Map();

class Chart {
  constructor(canvas, key, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = { max: 100, grid: true, series: [], label: null, ...opts };
    this.data = historyStore[key] ||= this.opts.series.map(() => []);
    new ResizeObserver(() => this.resize()).observe(canvas);
    charts.set(key, this);
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.draw();
  }
  draw() {
    const { ctx, w, h, opts } = this;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    let max = opts.max;
    if (max === 'auto') max = Math.max(opts.minMax || 1, ...this.data.flat()) * 1.2;
    const pad = opts.grid ? 4 : 2;

    if (opts.grid) {
      ctx.strokeStyle = cssVar('--line');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      for (let i = 1; i < 4; i++) {
        const y = Math.round((h * i) / 4) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    const step = w / (HISTORY - 1);
    opts.series.forEach((s, si) => {
      const a = this.data[si];
      if (a.length < 2) return;
      const x0 = w - (a.length - 1) * step;
      const pts = a.map((v, i) => [x0 + i * step, h - pad - (Math.min(v, max) / max) * (h - pad * 2)]);
      const color = cssVar(s.color);

      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = color;
      ctx.lineWidth = s.width || 1.8;
      ctx.lineJoin = 'round';
      ctx.setLineDash(s.dash || []);
      ctx.stroke();
      ctx.setLineDash([]);

      if (s.fill !== false) {
        ctx.lineTo(pts.at(-1)[0], h);
        ctx.lineTo(pts[0][0], h);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, rgba(color, 0.26));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fill();
      }
    });

    if (opts.label) {
      ctx.font = '11px "Cascadia Mono", Consolas, monospace';
      ctx.fillStyle = cssVar('--faint');
      ctx.fillText(opts.label(max), 4, 13);
    }
  }
}

// Overview sparklines mirror these main series
const SPARKS = { cpu: 'cpu-spark', mem: 'mem-spark', gpu: 'gpu-spark', disk: 'disk-spark', net: 'net-spark' };

function pushChart(key, values) {
  const store = historyStore[key];
  if (store) {
    values.forEach((v, i) => {
      store[i].push(v || 0);
      if (store[i].length > HISTORY) store[i].shift();
    });
    charts.get(key)?.draw();
  }
  if (SPARKS[key]) pushChart(SPARKS[key], values);
}

function makeChart(id, key, opts) {
  const el = $(id);
  if (el) new Chart(el, key, opts);
}

// ---------- Name cleanup ----------
function cpuName(raw) {
  let n = String(raw || '').replace(/\((R|TM)\)/gi, '').replace(/\s+CPU\b/i, '').replace(/\s*@.*$/, '').replace(/\s+/g, ' ').trim();
  const gen = n.match(/^(\d+\w{2} Gen)\s+/i)?.[1] || null;
  if (gen) n = n.slice(gen.length).trim();
  n = n.replace(/^(Intel|AMD)\s+/i, '').replace(/\s+\d+-Core Processor$/i, '');
  return { name: n, gen };
}
function cpuVendor(c) {
  const m = `${c.manufacturer} ${c.name}`;
  if (/intel/i.test(m)) return 'Intel';
  if (/amd/i.test(m)) return 'AMD';
  if (/qualcomm|snapdragon/i.test(m)) return 'Qualcomm';
  return c.manufacturer || 'Processor';
}
const GPU_VENDORS = { '0x10DE': 'NVIDIA', '0x1002': 'AMD', '0x1022': 'AMD', '0x8086': 'Intel', '0x5143': 'Qualcomm' };
function gpuVendor(g) {
  return GPU_VENDORS[g.vendorId] || (g.name.match(/nvidia|amd|radeon|intel/i)?.[0] ?? 'Graphics');
}
function diskVendor(model) {
  const m = String(model || '');
  const known = ['Samsung', 'WD', 'Western Digital', 'Seagate', 'Crucial', 'Kingston', 'SK hynix', 'Intel', 'Toshiba', 'Kioxia', 'Sandisk', 'ADATA', 'Corsair', 'Lexar', 'Micron', 'Transcend', 'Teamgroup', 'Hitachi', 'HGST', 'Apacer'];
  if (/^APS-/i.test(m)) return 'Apacer';
  return known.find((k) => m.toLowerCase().startsWith(k.toLowerCase().replace(' ', ''))
    || m.toLowerCase().startsWith(k.toLowerCase())) || m.split(/[\s_-]/)[0] || 'Drive';
}
const isRealGpu = (g) => !/basic render|basic display|remote display|indirect display|parsec|virtual/i.test(g.name);

// ---------- Render: static specs ----------
function renderSpecs(s) {
  specs = s;
  const cpu = s.cpu?.[0] || {};
  const { name: cName, gen } = cpuName(cpu.name);
  const board = s.board || {};
  const os = s.os || {};

  setText('host', s.system.hostname);
  setText('brand-host', s.system.hostname);
  setText('subtitle', [`${board.manufacturer || ''} ${board.product || ''}`.trim(), `${os.name} ${os.displayVersion || ''}`.trim()].filter(Boolean).join('  ·  '));
  setText('collected', `scanned ${new Date(s.collectedAt).toLocaleString()}`);
  document.title = `HW Monitor — ${s.system.hostname}`;

  setText('t-cpu-sub', cName);
  const gpus = (s.gpus || []).filter(isRealGpu);
  const primaryGpu = [...gpus].sort((a, b) => (b.vram || 0) - (a.vram || 0))[0];
  setText('t-gpu-sub', primaryGpu?.name || 'No GPU detected');

  renderCpu(cpu, cName, gen);
  renderMemory(s.memory);
  renderGpus(gpus);
  renderDisks(s.disks || []);
  renderNetwork(s.network || []);
  renderSystem(s);
}

function renderCpu(cpu, name, gen) {
  const cache = (kb) => (kb ? (kb >= 1024 ? `${(kb / 1024).toFixed(kb % 1024 ? 1 : 0)} MB` : `${kb} KB`) : null);
  const socket = /^cpu\s*socket$/i.test(cpu.socket || '') ? null : cpu.socket;
  const count = specs.cpu.length > 1 ? `${specs.cpu.length} × ` : '';
  setHtml('cpu-spec',
    modelBlock(gen ? `${cpuVendor(cpu)} · ${gen}` : cpuVendor(cpu), count + name, [
      chip(`${cpu.cores} Cores`, 'accent'), chip(`${cpu.threads} Threads`, 'accent'), chip(cpu.architecture),
    ]) +
    specRows([
      ['Full name', cpu.name],
      ['Base clock', fmtMHz(cpu.baseClockMHz)],
      ['Current clock', '—', 'cpu-clock'],
      ['L2 cache', cache(cpu.l2KB)],
      ['L3 cache', cache(cpu.l3KB)],
      ['Socket', socket],
      ['Identifier', cpu.description],
    ]));
  setText('cpu-meta', `${cpu.cores} cores · ${cpu.threads} threads`);

  $('cores').innerHTML = Array.from({ length: cpu.threads || 0 }, (_, i) =>
    `<div class="core" id="core-${i}"><span>CPU ${i}</span><b>0%</b></div>`).join('');
}

function renderMemory(mem) {
  const mods = mem.modules || [];
  const installed = sum(mods, (m) => m.capacity);
  const first = mods[0] || {};
  const speed = first.configuredMTs || first.speedMTs;
  const slots = mem.slots || mods.length;

  setHtml('mem-spec',
    modelBlock(first.type || 'Memory', `${fmtBytes(installed || mem.total, 0)} ${first.type || ''}`.trim(), [
      chip(speed ? `${speed} MT/s` : null, 'accent'),
      chip(`${mods.length} / ${slots} slots`, 'accent'),
      chip(first.formFactor),
    ]) +
    specRows([
      ['Installed', fmtBytes(installed, 0)],
      ['Usable', fmtBytes(mem.total)],
      ['Type', first.type],
      ['Speed', speed ? `${speed} MT/s` : null],
      ['SPD / JEDEC speed', first.speedMTs && first.speedMTs !== speed ? `${first.speedMTs} MT/s` : null],
      ['Voltage', first.voltage ? `${first.voltage} V` : null],
      ['Slots used', `${mods.length} of ${slots}`],
      ['Max supported', mem.maxCapacity ? fmtBytes(mem.maxCapacity, 0) : null],
    ]));

  const rows = mods.map((m) => `<tr>
      <td><span class="slot-dot"></span>${esc(m.slot || m.bank)}</td>
      <td>${esc(m.manufacturer || '—')}</td>
      <td class="mono">${esc(m.partNumber || '—')}</td>
      <td class="mono">${fmtBytes(m.capacity, 0)}</td>
      <td>${esc([m.type, m.formFactor].filter(Boolean).join(' '))}</td>
      <td class="mono">${m.configuredMTs || m.speedMTs || '—'} MT/s</td>
      <td class="mono">${m.voltage ? `${m.voltage} V` : '—'}</td>
    </tr>`);
  for (let i = mods.length; i < slots; i++) rows.push(`<tr class="empty"><td><span class="slot-dot"></span>Slot ${i + 1}</td><td colspan="6">Empty</td></tr>`);
  $('mem-table').innerHTML = `<thead><tr><th>Slot</th><th>Manufacturer</th><th>Part number</th><th>Capacity</th><th>Type</th><th>Speed</th><th>Voltage</th></tr></thead><tbody>${rows.join('')}</tbody>`;

  setHtml('mem-stats', [
    ['In use', 'mem-used', '--mem'], ['Available', 'mem-avail', '--faint'], ['Committed', 'mem-commit', '--cpu'], ['Cached', 'mem-cache', '--sys'],
  ].map(([k, id, dot]) => `<div class="stat"><span><i style="--dot:var(${dot})"></i>${k}</span><b id="${id}">—</b></div>`).join(''));
}

function renderGpus(gpus) {
  if (!gpus.length) { setHtml('gpu-list', '<div class="card muted">No graphics adapter detected.</div>'); return; }
  setHtml('gpu-list', gpus.map((g, i) => {
    const vendor = gpuVendor(g);
    const short = g.name.replace(new RegExp(`^${vendor}\\s+`, 'i'), '');
    return `<div class="card"><div class="gpu-card">
      <div>
        ${modelBlock(vendor, short, [chip(g.vram ? `${fmtBytes(g.vram, 0)} VRAM` : null, 'accent'), chip(g.refreshHz ? `${g.refreshHz} Hz` : null)])}
        ${specRows([
          ['Dedicated memory', g.vram ? fmtBytes(g.vram) : null],
          ['Shared memory', g.sharedMemory ? fmtBytes(g.sharedMemory) : null],
          ['Driver version', g.driverVersion],
          ['Driver date', g.driverDate],
          ['Display mode', g.resolution ? `${g.resolution}${g.refreshHz ? ` @ ${g.refreshHz} Hz` : ''}` : null],
          ['Vendor ID', g.vendorId],
        ])}
      </div>
      <div>
        <div class="card-head">
          <div><h3>Utilization</h3><p class="muted"><span style="color:var(--gpu)">━</span> GPU load &nbsp; <span style="color:var(--mem)">┅</span> VRAM</p></div>
          <div class="big" id="gpu-big-${i}">—</div>
        </div>
        <canvas class="chart" id="c-gpu-${i}"></canvas>
        <h4 class="label">Video memory · <span id="gpu-vram-txt-${i}">—</span></h4>
        ${barHtml(`gpu-vram-${i}`)}
        <h4 class="label">Engines</h4>
        <div class="engines" id="gpu-eng-${i}"></div>
        <div class="stats" id="gpu-sens-${i}" hidden>
          <div class="stat"><span><i style="--dot:var(--temp)"></i>Temperature</span><b id="gpu-temp-${i}">—</b></div>
          <div class="stat"><span><i style="--dot:var(--bad)"></i>Hot spot</span><b id="gpu-hot-${i}">—</b></div>
          <div class="stat"><span><i style="--dot:var(--cpu)"></i>Fan</span><b id="gpu-fan-${i}">—</b></div>
          <div class="stat"><span><i style="--dot:var(--gpu)"></i>Power</span><b id="gpu-pow-${i}">—</b></div>
        </div>
      </div>
    </div></div>`;
  }).join(''));
  gpus.forEach((g, i) => makeChart(`c-gpu-${i}`, `gpu-${g.luid || i}`, {
    series: [{ color: '--gpu' }, { color: '--mem', fill: false, dash: [4, 3], width: 1.4 }],
  }));
}

function renderDisks(disks) {
  setHtml('disk-list', disks.map((d) => {
    const healthy = /healthy/i.test(d.health);
    const vols = (d.volumes || []).map((v) => {
      const used = v.size - v.free;
      const pct = v.size ? (used / v.size) * 100 : 0;
      return `<div class="vol">
        <div class="row"><b>${esc(v.letter)} ${esc(v.label || '')}</b><span id="vol-txt-${v.letter[0]}">${fmtBytes(v.free)} free of ${fmtBytes(v.size)} · ${esc(v.fileSystem || '')}</span></div>
        ${barHtml(`vol-${v.letter[0]}`, pct)}
      </div>`;
    }).join('') || '<p class="muted">No mounted volumes</p>';
    return `<div class="card">
      ${modelBlock(diskVendor(d.model), d.model, [
        chip(d.busType, 'accent'), chip(d.mediaType && d.mediaType !== 'Unspecified' ? d.mediaType : null, 'accent'),
        chip(fmtDrive(d.size)), chip(d.health, healthy ? 'ok' : 'bad'),
        `<span class="chip accent" id="disk-temp-${d.index}" hidden></span>`,
      ])}
      ${specRows([['Disk', `#${d.index}`], ['Capacity', `${fmtDrive(d.size)} (${fmtBytes(d.size)})`], ['Firmware', d.firmware], ['Serial', d.serial]])}
      ${vols}
      <div class="io">
        <div class="stat"><span>Active</span><b id="disk-act-${d.index}">—</b></div>
        <div class="stat"><span><i style="--dot:var(--disk)"></i>Read</span><b id="disk-r-${d.index}">—</b></div>
        <div class="stat"><span><i style="--dot:var(--cpu)"></i>Write</span><b id="disk-w-${d.index}">—</b></div>
      </div>
      <canvas class="chart small" id="c-disk-${d.index}"></canvas>
    </div>`;
  }).join(''));
  disks.forEach((d) => makeChart(`c-disk-${d.index}`, `disk-${d.index}`, {
    max: 'auto', minMax: 1024 * 1024, label: (m) => fmtRate(m),
    series: [{ color: '--disk' }, { color: '--cpu', width: 1.4 }],
  }));
}

function renderNetwork(nics) {
  const up = nics.filter((n) => n.status === 'Up');
  const others = nics.filter((n) => n.status !== 'Up');
  let html = up.map((n, i) => `<div class="card"><div class="net-card">
      <div>
        ${modelBlock(n.physical ? (n.mediaType === 'Native 802.11' ? 'Wi-Fi adapter' : 'Network adapter') : 'Virtual adapter', n.description, [
          chip(n.linkSpeed, 'accent'), chip('Connected', 'ok'), chip(n.name),
        ])}
        ${specRows([['Interface', n.name], ['Link speed', n.linkSpeed], ['IPv4 address', n.ipv4], ['MAC address', n.mac], ['Media', n.mediaType]])}
      </div>
      <div>
        <div class="card-head">
          <div><h3>Throughput</h3><p class="muted"><span style="color:var(--net)">━</span> Download &nbsp; <span style="color:var(--cpu)">━</span> Upload</p></div>
          <div class="big" id="net-big-${i}">—</div>
        </div>
        <canvas class="chart" id="c-net-${i}"></canvas>
        <div class="stats">
          <div class="stat"><span><i style="--dot:var(--net)"></i>Download</span><b id="net-rx-${i}">—</b></div>
          <div class="stat"><span><i style="--dot:var(--cpu)"></i>Upload</span><b id="net-tx-${i}">—</b></div>
        </div>
      </div>
    </div></div>`).join('');
  if (others.length) {
    html += `<div class="card"><h3>Other adapters</h3>${others.map((n) =>
      `<div class="list-item"><div>${esc(n.description)}</div><span>${esc(n.name)} · ${esc(n.status)}</span></div>`).join('')}</div>`;
  }
  setHtml('net-list', html || '<div class="card muted">No network adapters found.</div>');
  up.forEach((n, i) => makeChart(`c-net-${i}`, `net-${norm(n.description)}`, {
    max: 'auto', minMax: 125000, label: (m) => fmtBits(m),
    series: [{ color: '--net' }, { color: '--cpu', width: 1.4 }],
  }));
}

function renderSystem(s) {
  const b = s.board || {}, os = s.os || {}, sys = s.system || {};
  const oem = (v) => (v && !/to be filled|default string|system product name|system manufacturer/i.test(v) ? v : null);
  const cards = [];
  cards.push(`<div class="card"><h3>Motherboard</h3>${specRows([
    ['Manufacturer', b.manufacturer], ['Model', b.product], ['Revision', b.version?.trim()],
    ['BIOS vendor', b.biosVendor], ['BIOS version', b.biosVersion], ['BIOS date', b.biosDate], ['SMBIOS', b.smbios],
  ])}</div>`);
  cards.push(`<div class="card"><h3>Operating system</h3>${specRows([
    ['Edition', os.name], ['Version', os.displayVersion], ['Build', os.version], ['Architecture', os.arch],
    ['Installed', os.installDate], ['Last boot', os.lastBoot ? new Date(os.lastBoot).toLocaleString() : null],
  ])}</div>`);
  cards.push(`<div class="card"><h3>Computer</h3>${specRows([
    ['Device name', sys.hostname], ['Manufacturer', oem(sys.manufacturer)], ['Model', oem(sys.model)], ['User', sys.user],
    ['Processes', '—', 'sys-proc'], ['Threads', '—', 'sys-thr'],
  ])}</div>`);

  const gpuMode = (s.gpus || []).find((g) => g.resolution);
  if (s.monitors?.length) {
    cards.push(`<div class="card"><h3>Displays</h3>${s.monitors.map((m, i) => `<div class="list-item">
      <div>${esc(m.name || `Display ${i + 1}`)}</div>
      <span>${esc([m.sizeInch ? `${m.sizeInch}"` : null, m.manufacturer, m.year].filter(Boolean).join(' · '))}</span></div>`).join('')}
      ${gpuMode ? `<div class="list-item"><div class="muted">Primary mode</div><span>${esc(gpuMode.resolution)} @ ${gpuMode.refreshHz} Hz</span></div>` : ''}</div>`);
  }
  if (s.audio?.length) {
    cards.push(`<div class="card"><h3>Audio devices</h3>${s.audio.map((a) =>
      `<div class="list-item"><div>${esc(a.name)}</div><span>${esc(a.manufacturer || '')}</span></div>`).join('')}</div>`);
  }
  if (s.battery) {
    const bt = s.battery;
    const wear = bt.designCapacity && bt.fullCapacity ? Math.round((bt.fullCapacity / bt.designCapacity) * 100) : null;
    cards.push(`<div class="card"><h3>Battery</h3>${specRows([
      ['Name', bt.name], ['Chemistry', bt.chemistry],
      ['Design capacity', bt.designCapacity ? `${bt.designCapacity} mWh` : null],
      ['Full charge capacity', bt.fullCapacity ? `${bt.fullCapacity} mWh` : null],
      ['Health', wear ? `${wear}%` : null],
    ])}</div>`);
  }
  cards.push('<div class="card" id="thermal-card" hidden><h3>Thermal zones</h3><div id="thermal-list"></div></div>');
  setHtml('sys-list', cards.join(''));
}

// ---------- Live updates ----------
function onLive(d) {
  setText('uptime', `Uptime ${fmtUptime(d.system.uptime)}`);

  // CPU
  const cpu = specs?.cpu?.[0];
  const clock = cpu?.baseClockMHz && d.cpu.perfPct ? Math.round((cpu.baseClockMHz * d.cpu.perfPct) / 100) : null;
  setHtml('t-cpu', `${d.cpu.total}<small>%</small>`);
  setHtml('cpu-big', `${d.cpu.total}<small>%</small>`);
  if (clock) {
    setText('cpu-clock', fmtMHz(clock));
    setText('cpu-meta', `${cpu.cores} cores · ${cpu.threads} threads · ${fmtMHz(clock)}`);
    if (specs) setText('t-cpu-sub', `${cpuName(cpu.name).name} · ${fmtMHz(clock)}`);
  }
  pushChart('cpu', [d.cpu.total]);
  d.cpu.cores.forEach((v, i) => {
    const el = $(`core-${i}`);
    if (!el) return;
    el.style.setProperty('--v', v);
    el.lastElementChild.textContent = `${v}%`;
  });

  // Memory
  const m = d.memory;
  const used = m.total - m.free;
  const memPct = m.total ? (used / m.total) * 100 : 0;
  latestReadings.cpuLoad = Number(d.cpu.total);
  latestReadings.memoryPct = memPct;
  latestReadings.at = Date.now();
  setHtml('t-mem', `${Math.round(memPct)}<small>%</small>`);
  setText('t-mem-sub', `${fmtBytes(used)} / ${fmtBytes(m.total)}`);
  setHtml('mem-big', `${fmtBytes(used)}`);
  setText('mem-meta', `${Math.round(memPct)}% of ${fmtBytes(m.total)} in use`);
  setText('mem-used', fmtBytes(used));
  setText('mem-avail', fmtBytes(m.free));
  setText('mem-commit', `${fmtBytes(m.committed)} / ${fmtBytes(m.commitLimit)}`);
  setText('mem-cache', fmtBytes(m.cache));
  pushChart('mem', [memPct]);

  setText('sys-proc', String(d.system.processes));
  setText('sys-thr', d.system.threads.toLocaleString());

  if (!specs) { updateHealth(); updateGameDiagnosis(); return; } // the rest needs spec data to map counters to devices

  // GPU
  const gpus = specs.gpus.filter(isRealGpu);
  let primaryUtil = null, primaryVram = -1, primaryVramPct = null;
  gpus.forEach((g, i) => {
    const live = d.gpus.find((x) => x.luid === g.luid) || (gpus.length === 1 ? [...d.gpus].sort((a, b) => b.dedicated - a.dedicated)[0] : null);
    if (!live) return;
    const vramPct = g.vram ? (live.dedicated / g.vram) * 100 : 0;
    setHtml(`gpu-big-${i}`, `${live.util}<small>%</small>`);
    setText(`gpu-vram-txt-${i}`, `${fmtBytes(live.dedicated)} / ${fmtBytes(g.vram)}`);
    setBar(`gpu-vram-${i}`, vramPct);
    pushChart(`gpu-${g.luid || i}`, [live.util, vramPct]);

    const engines = Object.entries(live.engines || {})
      .filter(([k]) => /^(3D|Copy|VideoDecode|VideoEncode|Compute.*|Graphics.*|Cuda)$/i.test(k))
      .sort((a, b) => b[1] - a[1]).slice(0, 6);
    const engEl = $(`gpu-eng-${i}`);
    if (engEl) {
      if (engEl.childElementCount !== engines.length) {
        engEl.innerHTML = engines.map(([k]) => `<div class="engine"><div class="row"><span>${esc(k.replace(/([a-z])([A-Z])/g, '$1 $2'))}</span><b data-v>0%</b></div>${barHtml(`eng-${i}-${norm(k)}`)}</div>`).join('');
      }
      engines.forEach(([k, v]) => {
        const bar = $(`eng-${i}-${norm(k)}`);
        if (!bar) return;
        bar.previousElementSibling.querySelector('[data-v]').textContent = `${v}%`;
        bar.firstElementChild.style.width = `${clamp(v)}%`;
      });
    }
    if ((g.vram || 0) > primaryVram) { primaryVram = g.vram || 0; primaryUtil = live.util; primaryVramPct = vramPct; }
  });
  latestReadings.gpuLoad = primaryUtil;
  latestReadings.vramPct = primaryVramPct;
  if (primaryUtil != null) {
    setHtml('t-gpu', `${primaryUtil}<small>%</small>`);
    pushChart('gpu', [primaryUtil]);
  }

  // Disks
  let maxActive = 0, totalR = 0, totalW = 0;
  for (const disk of d.disks) {
    maxActive = Math.max(maxActive, disk.active);
    totalR += disk.read; totalW += disk.write;
    setText(`disk-act-${disk.index}`, `${disk.active}%`);
    setText(`disk-r-${disk.index}`, fmtRate(disk.read));
    setText(`disk-w-${disk.index}`, fmtRate(disk.write));
    pushChart(`disk-${disk.index}`, [disk.read, disk.write]);
  }
  setHtml('t-disk', `${maxActive}<small>%</small>`);
  setText('t-disk-sub', `R ${fmtRate(totalR)} · W ${fmtRate(totalW)}`);
  pushChart('disk', [maxActive]);

  // Network: match perf counter instance names (which mangle "()#/") to adapter descriptions
  const up = specs.network.filter((n) => n.status === 'Up');
  let rx = 0, tx = 0;
  up.forEach((n, i) => {
    const key = norm(n.description);
    const live = d.net.find((x) => norm(x.name) === key);
    if (!live) return;
    if (n.physical) { rx += live.rx; tx += live.tx; }
    setText(`net-big-${i}`, fmtBits(live.rx));
    setText(`net-rx-${i}`, fmtBits(live.rx));
    setText(`net-tx-${i}`, fmtBits(live.tx));
    pushChart(`net-${key}`, [live.rx, live.tx]);
  });
  const [rxNum, rxUnit] = fmtBits(rx).split(' ');
  setHtml('t-net', `${rxNum}<small>${rxUnit}</small>`);
  setText('t-net-sub', `↓ ${fmtBits(rx)} · ↑ ${fmtBits(tx)}`);
  pushChart('net', [rx, tx]);

  // Thermal zones are only shown when the firmware exposes them
  const tc = $('thermal-card');
  if (tc && d.thermal?.length) {
    tc.hidden = false;
    setHtml('thermal-list', d.thermal.map((t) =>
      `<div class="list-item"><div>${esc(t.name)}</div><span class="mono">${t.celsius.toFixed(1)} °C</span></div>`).join(''));
  }
  updateHealth();
  updateGameDiagnosis();
}

// ---------- Sensors (LibreHardwareMonitor) ----------
const SENSOR_GROUPS = [['Temperature', 'Temperatures'], ['Fan', 'Fans'], ['Control', 'Fan control'], ['Power', 'Power']];
const HW_COLORS = { Cpu: '--cpu', GpuNvidia: '--gpu', GpuAmd: '--gpu', GpuIntel: '--gpu', Storage: '--disk', Memory: '--mem', Motherboard: '--sys', SuperIO: '--sys' };
const HW_LABELS = { Cpu: 'Processor', GpuNvidia: 'Graphics', GpuAmd: 'Graphics', GpuIntel: 'Graphics', Storage: 'Drive', Memory: 'Memory', Motherboard: 'Motherboard', SuperIO: 'Super I/O', EmbeddedController: 'Embedded controller' };
const HEADLINE_TEMPS = ['CPU Package', 'Core (Tctl/Tdie)', 'Core (Tctl)', 'Core Max', 'GPU Core', 'Composite Temperature', 'Temperature'];
const fmtTemp = (t) => (t == null ? '—' : `${t.toFixed(0)} °C`);

// Hide per-core TjMax distances, and power rails / fan controls that never left 0 (no driver access or unsupported)
const visibleSensors = (h) => h.sensors.filter((s) =>
  !/distance to tjmax/i.test(s.name) && !((s.type === 'Power' || s.type === 'Control') && !s.max));
const findSensor = (h, type, names) => {
  if (!h) return null;
  for (const n of names) {
    const s = h.sensors.find((x) => x.type === type && x.name === n);
    if (s) return s;
  }
  return null;
};
function headlineTemp(h) {
  const s = findSensor(h, 'Temperature', HEADLINE_TEMPS);
  if (s) return s.value;
  const temps = h.sensors.filter((x) => x.type === 'Temperature').map((x) => x.value);
  return temps.length ? Math.max(...temps) : null;
}

function sensorRow(id, s) {
  const unit = { Temperature: '°C', Fan: 'RPM', Control: '%', Power: 'W' }[s.type];
  const max = s.max != null && s.type !== 'Control' ? `<small>max ${s.max.toFixed(s.type === 'Fan' ? 0 : 1)}</small>` : '';
  return `<div class="srow"><span title="${esc(s.name)}">${esc(s.name)}</span>
    <div class="bar ${s.type === 'Temperature' ? 'temp-bar' : ''}" id="${id}-bar"><div></div></div>
    <b id="${id}">— ${unit}${max}</b></div>`;
}

function sensorCard(h, hi) {
  const sensors = visibleSensors(h);
  const groups = SENSOR_GROUPS.map(([type, title]) => {
    const rows = sensors.map((s) => [s, h.sensors.indexOf(s)]).filter(([s]) => s.type === type);
    return rows.length ? `<div class="sgroup"><h4 class="label">${title}</h4>${rows.map(([s, si]) => sensorRow(`sn-${hi}-${si}`, s)).join('')}</div>` : '';
  }).join('');
  const vendor = HW_LABELS[h.type] || h.type;
  return `<div class="card" style="--c:var(${HW_COLORS[h.type] || '--temp'})">
    <div class="sensor-head">
      ${modelBlock(h.parent ? `${vendor} · ${h.parent}` : vendor, h.name, [])}
      <div class="big" id="sn-${hi}-head"></div>
    </div>${groups}</div>`;
}

function updateSensorRow(id, s) {
  const el = $(id);
  if (!el) return;
  let pct;
  if (s.type === 'Temperature') pct = s.value;
  else if (s.type === 'Fan') pct = (s.value / Math.max(2000, s.max || 0)) * 100;
  else if (s.type === 'Control') pct = s.value;
  else pct = s.max ? (s.value / s.max) * 100 : 0;
  const unit = { Temperature: '°C', Fan: 'RPM', Control: '%', Power: 'W' }[s.type];
  const val = s.type === 'Fan' || s.type === 'Control' ? Math.round(s.value) : s.value.toFixed(1);
  el.firstChild.textContent = `${val} ${unit}`;
  const small = el.querySelector('small');
  if (small && s.max != null) small.textContent = `max ${s.max.toFixed(s.type === 'Fan' ? 0 : 1)}`;
  const bar = $(`${id}-bar`);
  bar.firstElementChild.style.width = `${clamp(pct)}%`;
  if (s.type === 'Temperature') {
    bar.classList.toggle('warn', s.value >= 70 && s.value < 85);
    bar.classList.toggle('bad', s.value >= 85);
  }
}

let noticeHtml = '';
function renderSensorNotice(d) {
  const msgs = [];
  // The app always runs elevated and installs PawnIO at startup, so these only show when something went wrong
  if (!d.admin) msgs.push('HW Monitor is not running as administrator, so CPU, motherboard and drive sensors are unavailable.');
  if (!d.pawnIo) msgs.push('The <b>PawnIO</b> driver is not installed, so CPU and motherboard sensors are unavailable. Restart HW Monitor to install it.');
  if (d.error) msgs.push(`Sensor library error: ${esc(d.error)}`);
  const html = msgs.length
    ? `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke-width="1.8"/><path d="M12 8v5m0 3v.5" fill="none" stroke-width="2"/></svg><div>${msgs.map((m) => `<p>${m}</p>`).join('')}</div>`
    : '';
  if (html === noticeHtml) return;
  noticeHtml = html;
  const el = $('sensor-notice');
  el.innerHTML = html;
  el.hidden = !html;
}

function setTileTemp(id, t) {
  const el = $(id);
  el.hidden = t == null;
  if (t == null) return;
  el.textContent = `${Math.round(t)}°C`;
  el.classList.toggle('hot', t >= 85);
}

let sensorSig = null;
function onSensors(d) {
  renderSensorNotice(d);
  const hw = (d.hardware || []).filter((h) => visibleSensors(h).length);

  // Rebuild cards only when the set of sensors changes; otherwise patch values in place
  const sig = hw.map((h) => `${h.id}:${visibleSensors(h).map((s) => s.type + s.name).join(',')}`).join('|');
  if (sig !== sensorSig) {
    sensorSig = sig;
    setHtml('sensor-list', hw.map(sensorCard).join('')
      || `<div class="card muted">${d.missing ? 'Sensor helper not available.' : 'No sensors reported yet.'}</div>`);
  }
  hw.forEach((h, hi) => {
    const head = headlineTemp(h);
    setText(`sn-${hi}-head`, head == null ? '' : fmtTemp(head));
    $(`sn-${hi}-head`)?.classList.toggle('hot', head >= 85);
    h.sensors.forEach((s, si) => updateSensorRow(`sn-${hi}-${si}`, s));
  });

  // CPU
  const cpuHw = hw.find((h) => h.type === 'Cpu');
  const cpuTemp = findSensor(cpuHw, 'Temperature', HEADLINE_TEMPS)?.value ?? null;
  const cpuMax = findSensor(cpuHw, 'Temperature', ['Core Max'])?.value ?? null;
  const cpuPow = findSensor(cpuHw, 'Power', ['CPU Package', 'Package'])?.value;
  $('cpu-sens').hidden = cpuTemp == null && !cpuPow;
  setText('cpu-temp', fmtTemp(cpuTemp));
  setText('cpu-tmax', fmtTemp(cpuMax));
  setText('cpu-pow', cpuPow ? `${cpuPow.toFixed(1)} W` : '—');
  setTileTemp('t-cpu-temp', cpuTemp);

  // GPU: match LHM device to the spec list by name, then by vendor
  let primaryGpuTemp = null;
  const gpus = (specs?.gpus || []).filter(isRealGpu);
  const vendorType = { NVIDIA: 'GpuNvidia', AMD: 'GpuAmd', Intel: 'GpuIntel' };
  gpus.forEach((g, i) => {
    const gh = hw.find((h) => h.type.startsWith('Gpu') && h.name === g.name)
      || hw.find((h) => h.type === vendorType[gpuVendor(g)]);
    const box = $(`gpu-sens-${i}`);
    if (!box) return;
    box.hidden = !gh;
    if (!gh) return;
    const temp = findSensor(gh, 'Temperature', ['GPU Core'])?.value ?? headlineTemp(gh);
    const hot = findSensor(gh, 'Temperature', ['GPU Hot Spot'])?.value;
    const fan = gh.sensors.find((s) => s.type === 'Fan');
    const fanPct = gh.sensors.find((s) => s.type === 'Control');
    const pow = findSensor(gh, 'Power', ['GPU Package', 'GPU Power', 'GPU Core']);
    setText(`gpu-temp-${i}`, fmtTemp(temp));
    setText(`gpu-hot-${i}`, fmtTemp(hot));
    setText(`gpu-fan-${i}`, fan ? `${Math.round(fan.value)} RPM${fanPct?.value ? ` · ${Math.round(fanPct.value)}%` : ''}` : '—');
    setText(`gpu-pow-${i}`, pow ? `${pow.value.toFixed(1)} W` : '—');
    if (i === 0 || primaryGpuTemp == null) primaryGpuTemp = temp;
  });
  setTileTemp('t-gpu-temp', primaryGpuTemp);

  // Drives
  for (const disk of specs?.disks || []) {
    const dh = hw.find((h) => h.type === 'Storage' && h.name === disk.model);
    const t = dh ? headlineTemp(dh) : null;
    const el = $(`disk-temp-${disk.index}`);
    if (!el) continue;
    el.hidden = t == null;
    if (t != null) el.textContent = fmtTemp(t);
  }

  // History chart of the headline CPU / GPU temperatures that exist on this machine
  const series = [];
  if (cpuTemp != null) series.push(['CPU', '--cpu', cpuTemp]);
  if (primaryGpuTemp != null) series.push(['GPU', '--gpu', primaryGpuTemp]);
  $('temp-chart-card').hidden = !series.length;
  if (series.length) {
    const key = `temp-${series.map((s) => s[0]).join('-')}`;
    if (!charts.has(key)) {
      makeChart('c-temp', key, { max: 100, label: () => '100 °C', series: series.map(([, color]) => ({ color })) });
      setHtml('temp-legend', series.map(([n, c]) => `<span style="color:var(${c})">━</span> ${n}`).join(' &nbsp; '));
    }
    pushChart(key, series.map((s) => s[2]));
    const hottest = Math.max(...series.map((s) => s[2]));
    setText('temp-big', fmtTemp(hottest));
    $('temp-big').classList.toggle('hot', hottest >= 85);
  }
  latestReadings.cpuTemp = cpuTemp;
  latestReadings.gpuTemp = primaryGpuTemp;
  latestReadings.at = Date.now();
  updateHealth();
}

// ---------- Health checks & saved monitoring sessions ----------
function persist(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* keep the current run usable if storage is full */ }
}

function renderHealth() {
  const checks = [
    ['cpuTemp', latestReadings.cpuTemp, '°C'], ['gpuTemp', latestReadings.gpuTemp, '°C'],
    ['memory', latestReadings.memoryPct, '%'], ['vram', latestReadings.vramPct, '%'],
  ].filter(([, value]) => Number.isFinite(value));
  const hot = checks.filter(([key, value]) => value >= Number(thresholds[key]));
  setHtml('health-metrics', checks.map(([key, value, unit]) => {
    const label = { cpuTemp: 'CPU temp', gpuTemp: 'GPU temp', memory: 'Memory', vram: 'VRAM' }[key];
    const cls = value >= Number(thresholds[key]) ? 'bad' : 'ok';
    return `<span class="chip ${cls}">${label} ${value.toFixed(0)}${unit}</span>`;
  }).join('') || '<span class="muted">Waiting for supported readings…</span>');
  const state = $('health-state');
  state.textContent = !checks.length ? 'Waiting' : hot.length ? 'Needs attention' : 'Normal';
  state.classList.toggle('bad', hot.length > 0);
  state.classList.toggle('ok', checks.length > 0 && hot.length === 0);
  const guidance = hot.length
    ? hot.map(([key]) => ALERT_COPY[key][1]).join(' ')
    : checks.length ? 'Current temperatures and memory use are within the saved limits.' : 'Waiting for live readings…';
  setText('health-guidance', guidance);
}

function updateHealth() {
  renderHealth();
  const now = Date.now();
  if (now - lastAlertSampleAt < 900) return;
  lastAlertSampleAt = now;
  const values = {
    cpuTemp: latestReadings.cpuTemp,
    gpuTemp: latestReadings.gpuTemp,
    memory: latestReadings.memoryPct,
    vram: latestReadings.vramPct,
  };
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) continue;
    const limit = Number(thresholds[key]);
    if (value >= limit) {
      alertCounts[key] = (alertCounts[key] || 0) + 1;
      if (alertCounts[key] >= 3 && !activeAlerts.has(key)) {
        activeAlerts.add(key);
        const [title, advice] = ALERT_COPY[key];
        alertHistory.unshift({ at: new Date().toISOString(), key, title, advice, value: Number(value.toFixed(1)) });
        alertHistory = alertHistory.slice(0, 40);
        persist('hwm-alerts', alertHistory);
        renderAlertHistory();
      }
    } else if (value < limit - 3) {
      alertCounts[key] = 0;
      activeAlerts.delete(key);
    }
  }
}

function renderAlertHistory() {
  const target = $('alert-list');
  if (!alertHistory.length) { target.innerHTML = '<p class="muted">No alerts yet.</p>'; return; }
  target.innerHTML = alertHistory.slice(0, 8).map((item) =>
    `<div class="alert-row"><div><strong>${esc(item.title)}</strong><div class="muted">${esc(item.advice)}</div></div><span class="alert-time">${new Date(item.at).toLocaleTimeString()}</span></div>`).join('');
}

function renderSessionUi() {
  const start = $('btn-session-start'), stop = $('btn-session-stop'), exportButton = $('btn-session-export');
  start.disabled = Boolean(activeSession);
  stop.disabled = !activeSession;
  exportButton.disabled = !activeSession && !sessionHistory.length;
  const shown = activeSession || sessionHistory[0];
  if (!shown) {
    setText('session-status', 'No session recorded');
    setText('session-summary', 'Start a session to save readings every 10 seconds.');
  } else {
    const startAt = new Date(shown.startedAt);
    setText('session-status', activeSession
      ? `Recording since ${startAt.toLocaleTimeString()}`
      : `Last session · ${startAt.toLocaleString()}`);
    const samples = shown.samples || [];
    const maxOf = (key) => Math.max(0, ...samples.map((sample) => Number(sample[key]) || 0));
    const avgOf = (key) => {
      const values = samples.map((sample) => sample[key]).filter((value) => value != null).map(Number).filter(Number.isFinite);
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };
    const fps = avgOf('fps'), cpuTemp = maxOf('cpuTemp'), gpuTemp = maxOf('gpuTemp');
    setText('session-summary', `${samples.length} samples · Max CPU ${cpuTemp ? `${cpuTemp.toFixed(0)} °C` : '—'} · Max GPU ${gpuTemp ? `${gpuTemp.toFixed(0)} °C` : '—'} · Avg FPS ${fps ? fps.toFixed(0) : '—'}`);
  }
  $('session-history').innerHTML = sessionHistory.slice(0, 5).map((session) => {
    const at = new Date(session.startedAt).toLocaleString();
    const count = (session.samples || []).length;
    return `<div class="session-row"><strong>${esc(at)}</strong><span>${count} samples</span></div>`;
  }).join('');
}

function captureSessionSample() {
  if (!activeSession || !latestReadings.at) return;
  activeSession.samples.push({
    at: new Date().toISOString(),
    cpuLoad: latestReadings.cpuLoad ?? null,
    cpuTemp: latestReadings.cpuTemp ?? null,
    gpuLoad: latestReadings.gpuLoad ?? null,
    gpuTemp: latestReadings.gpuTemp ?? null,
    memoryPct: latestReadings.memoryPct ?? null,
    vramPct: latestReadings.vramPct ?? null,
    fps: latestGameMetrics?.fps ?? null,
    frameTimeMs: latestGameMetrics?.frameTimeMs ?? null,
    low1Fps: latestGameMetrics?.low1Fps ?? null,
    game: latestGameMetrics?.processName ?? '',
  });
  if (activeSession.samples.length > 360) activeSession.samples.shift();
  renderSessionUi();
}

function startSession() {
  if (activeSession) return;
  activeSession = { startedAt: new Date().toISOString(), samples: [] };
  captureSessionSample();
  sessionTimer = setInterval(captureSessionSample, 10000);
  renderSessionUi();
}

function stopSession() {
  if (!activeSession) return;
  clearInterval(sessionTimer);
  sessionTimer = null;
  activeSession.endedAt = new Date().toISOString();
  if (activeSession.samples.length) {
    sessionHistory.unshift(activeSession);
    sessionHistory = sessionHistory.slice(0, 8);
    persist('hwm-sessions', sessionHistory);
  }
  activeSession = null;
  renderSessionUi();
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function exportSessionCsv() {
  const session = activeSession || sessionHistory[0];
  if (!session) return;
  const columns = ['at', 'game', 'cpuLoad', 'cpuTemp', 'gpuLoad', 'gpuTemp', 'memoryPct', 'vramPct', 'fps', 'frameTimeMs', 'low1Fps'];
  const rows = [columns.join(','), ...(session.samples || []).map((sample) => columns.map((key) => csvCell(sample[key])).join(','))];
  const blob = new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `hwmonitor-session-${new Date(session.startedAt).toISOString().replace(/[:.]/g, '-')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initHealthUi() {
  const form = $('threshold-form');
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) form.elements[key].value = thresholds[key];
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    for (const key of Object.keys(DEFAULT_THRESHOLDS)) thresholds[key] = Number(form.elements[key].value) || DEFAULT_THRESHOLDS[key];
    persist('hwm-thresholds', thresholds);
    Object.keys(alertCounts).forEach((key) => { alertCounts[key] = 0; activeAlerts.delete(key); });
    setText('threshold-saved', 'Saved on this device');
    renderHealth();
    setTimeout(() => setText('threshold-saved', ''), 2500);
  });
  $('btn-alerts-clear').addEventListener('click', () => {
    alertHistory = [];
    alertCounts = {};
    activeAlerts.clear();
    persist('hwm-alerts', alertHistory);
    renderAlertHistory();
  });
  $('btn-session-start').addEventListener('click', startSession);
  $('btn-session-stop').addEventListener('click', stopSession);
  $('btn-session-export').addEventListener('click', exportSessionCsv);
  renderAlertHistory();
  renderSessionUi();
}

// ---------- Game mode / PresentMon ----------
let gameCapturing = false;
function updateGameControls() {
  $('btn-game-start').disabled = !host || gameCapturing || !presentMonPath || !$('game-process').value;
  $('btn-game-stop').disabled = !gameCapturing;
  $('btn-presentmon').disabled = !host;
  $('btn-process-refresh').disabled = !host;
}

function renderProcesses(data) {
  const select = $('game-process');
  const selected = select.value;
  gameProcesses = Array.isArray(data.processes) ? data.processes : [];
  select.innerHTML = '<option value="">Select a running app</option>' + gameProcesses.map((p) =>
    `<option value="${Number(p.id)}">${esc(p.title || p.name)} · ${esc(p.name)}</option>`).join('');
  if (gameProcesses.some((p) => String(p.id) === selected)) select.value = selected;
  updateGameControls();
}

function onGameProcessChanged() {
  const process = gameProcesses.find((item) => String(item.id) === $('game-process').value);
  const saved = process && gameOverlayProfiles[process.name.toLowerCase()];
  if (saved) {
    overlayConfig = normalizeOverlayConfig(saved);
    syncOverlayDialog();
    applyOverlayConfig();
  }
  setText('overlay-profile-note', process
    ? saved ? `Loaded the saved overlay setup for ${process.name}.` : `Overlay setup changes will be saved for ${process.name}.`
    : 'Choose a game in Game mode to remember a separate overlay layout for it.');
  updateGameControls();
}

function updateGameDiagnosis() {
  const cpu = latestReadings.cpuLoad, gpu = latestReadings.gpuLoad;
  const hint = cpu == null || gpu == null ? '—'
    : gpu >= 95 && cpu < 80 ? 'Likely GPU limited'
      : cpu >= 90 && gpu < 85 ? 'Likely CPU limited'
        : 'Balanced / variable';
  setText('game-diagnosis', hint);
}

function renderGameMetrics(data) {
  latestGameMetrics = data;
  setText('game-fps', Number.isFinite(data.fps) ? data.fps.toFixed(0) : '—');
  setText('game-frame-time', Number.isFinite(data.frameTimeMs) ? `${data.frameTimeMs.toFixed(2)} ms` : '—');
  setText('game-low1', Number.isFinite(data.low1Fps) ? data.low1Fps.toFixed(0) : '—');
  if (data.frameTimeMs > 0) pushChart('game', [data.frameTimeMs]);
  updateGameDiagnosis();
}

function handleGameState(data) {
  gameCapturing = data.state === 'running';
  if (data.state === 'running') setText('game-message', `Capturing ${data.processName || 'game'} · ${new Date().toLocaleTimeString()}`);
  else {
    latestGameMetrics = null;
    setText('game-fps', '—');
    setText('game-frame-time', '—');
    setText('game-low1', '—');
    setText('game-message', data.message || (data.state === 'error' ? 'Could not start PresentMon capture.' : 'Capture stopped.'));
  }
  updateGameControls();
}

function handlePresentMonState(data) {
  presentMonPath = data.path || '';
  try {
    if (presentMonPath) localStorage.setItem('hwm-presentmon-path', presentMonPath);
    else localStorage.removeItem('hwm-presentmon-path');
  } catch { /* optional */ }
  $('btn-presentmon').textContent = presentMonPath ? 'Change PresentMon' : 'Locate manually';
  setText('game-tool-status', presentMonPath
    ? `PresentMon ready · ${presentMonPath.split(/[\\/]/).at(-1)}`
    : data.busy ? 'Setting up PresentMon…' : 'PresentMon is not configured');
  setText('game-message', host
    ? presentMonPath ? 'Select a running game, then start capture.' : data.message || 'PresentMon will be set up automatically.'
    : 'Game capture is available in the desktop app.');
  updateGameControls();
}

function initGameUi() {
  $('game-process').addEventListener('change', onGameProcessChanged);
  $('btn-process-refresh').addEventListener('click', () => host?.postMessage({ type: 'game-processes' }));
  $('btn-presentmon').addEventListener('click', () => host?.postMessage({ type: 'game-locate-presentmon' }));
  $('btn-game-start').addEventListener('click', () => {
    const processId = Number($('game-process').value);
    if (!processId || !host) return;
    startSession();
    host.postMessage({ type: 'game-start', processId });
  });
  $('btn-game-stop').addEventListener('click', () => host?.postMessage({ type: 'game-stop' }));
  $('presentmon-download').addEventListener('click', (event) => {
    if (host) { event.preventDefault(); host.postMessage({ type: 'open-external', url: event.currentTarget.href }); }
  });
  if (!host) {
    $('game-tool-status').textContent = 'Game capture is available in the desktop app';
    $('btn-presentmon').hidden = true;
  }
  updateGameControls();
}

// ---------- Overlay layout profiles ----------
function renderOverlayMetricChoices() {
  $('overlay-metrics').innerHTML = OVERLAY_METRICS.map(([key, label]) =>
    `<label class="check-label"><input type="checkbox" value="${key}" ${overlayConfig.metrics.includes(key) ? 'checked' : ''}>${esc(label)}</label>`).join('');
  $('overlay-metrics').querySelectorAll('input').forEach((input) => input.addEventListener('change', () => {
    const selected = [...$('overlay-metrics').querySelectorAll('input:checked')].map((item) => item.value);
    if (!selected.length) { input.checked = true; return; }
    overlayConfig.metrics = selected;
    overlayConfig.profile = 'custom';
    $('overlay-profile').value = 'custom';
    saveOverlayConfig();
  }));
}

function saveOverlayConfig() {
  overlayConfig.opacity = Number($('overlay-opacity').value);
  overlayConfig.metrics = [...$('overlay-metrics').querySelectorAll('input:checked')].map((item) => item.value);
  if (!overlayConfig.metrics.length) overlayConfig.metrics = ['cpu'];
  applyOverlayConfig();
  const process = gameProcesses.find((item) => String(item.id) === $('game-process').value);
  if (process) {
    gameOverlayProfiles[process.name.toLowerCase()] = { ...overlayConfig, metrics: [...overlayConfig.metrics] };
    persist('hwm-game-overlay-profiles', gameOverlayProfiles);
    setText('overlay-profile-note', `Overlay setup is remembered for ${process.name}.`);
  }
}

function applyOverlayConfig() {
  persist('hwm-overlay', overlayConfig);
  renderOverlayMetricChoices();
  host?.postMessage({ type: 'overlay-config', config: overlayConfig });
}

function syncOverlayDialog() {
  $('overlay-profile').value = overlayConfig.profile;
  $('overlay-opacity').value = overlayConfig.opacity;
  $('overlay-opacity-value').textContent = `${overlayConfig.opacity}%`;
  renderOverlayMetricChoices();
}

function initOverlaySettings() {
  const button = $('btn-overlay-config');
  $('btn-overlay').hidden = !host;
  button.hidden = !host;
  if (!host) return;
  $('btn-overlay').addEventListener('click', () => host.postMessage({ type: 'overlay-toggle' }));
  button.addEventListener('click', () => {
    syncOverlayDialog();
    $('overlay-dialog').showModal();
  });
  $('overlay-profile').addEventListener('change', (event) => {
    const profile = event.currentTarget.value;
    if (profile !== 'custom') overlayConfig.metrics = [...OVERLAY_PROFILES[profile]];
    overlayConfig.profile = profile;
    renderOverlayMetricChoices();
    saveOverlayConfig();
  });
  $('overlay-opacity').addEventListener('input', (event) => {
    $('overlay-opacity-value').textContent = `${event.currentTarget.value}%`;
    saveOverlayConfig();
  });
  host.postMessage({ type: 'overlay-config', config: overlayConfig });
}

// ---------- Wiring ----------
function initOverviewCharts() {
  makeChart('s-cpu', 'cpu-spark', { grid: false, series: [{ color: '--cpu' }] });
  makeChart('s-mem', 'mem-spark', { grid: false, series: [{ color: '--mem' }] });
  makeChart('s-gpu', 'gpu-spark', { grid: false, series: [{ color: '--gpu' }] });
  makeChart('s-disk', 'disk-spark', { grid: false, series: [{ color: '--disk' }] });
  makeChart('s-net', 'net-spark', { grid: false, max: 'auto', minMax: 125000, series: [{ color: '--net' }, { color: '--cpu', fill: false, width: 1.2 }] });
  makeChart('c-cpu', 'cpu', { series: [{ color: '--cpu' }] });
  makeChart('c-mem', 'mem', { series: [{ color: '--mem' }] });
  // Totals without a section chart still need a history buffer
  historyStore.gpu ||= [[]];
  historyStore.disk ||= [[]];
  historyStore.net ||= [[], []];
  makeChart('c-game', 'game', { max: 'auto', minMax: 8, label: (m) => `${m.toFixed(0)} ms`, series: [{ color: '--gpu' }] });
}

// ---------- Transport ----------
// The desktop app (WebView2) pushes data with postMessage; the Node.js build uses HTTP + Server-Sent Events.
const host = window.chrome?.webview || null;
let specsWaiter = null;

function onEvent(event, data) {
  if (event === 'specs' || event === 'specs-error') {
    const waiter = specsWaiter;
    specsWaiter = null;
    if (waiter) event === 'specs' ? waiter.resolve(data) : waiter.reject(new Error(data.error));
    return;
  }
  if (event === 'overlay-state') {
    const button = $('btn-overlay');
    if (button) {
      button.setAttribute('aria-pressed', String(Boolean(data.visible)));
      button.title = data.visible ? 'Hide always-on-top hardware overlay' : 'Show always-on-top hardware overlay';
    }
    return;
  }
  if (event === 'game-processes') { renderProcesses(data); return; }
  if (event === 'presentmon-state') { handlePresentMonState(data); return; }
  if (event === 'game-state') { handleGameState(data); return; }
  if (event === 'game-metrics') { renderGameMetrics(data); return; }
  if (event === 'live') {
    $('live-dot').classList.add('on');
    setText('live-label', `Live · ${new Date().toLocaleTimeString()}`);
    onLive(data);
  } else if (event === 'sensors') {
    onSensors(data);
  }
}

async function fetchSpecs(refresh) {
  if (host) {
    return new Promise((resolve, reject) => {
      specsWaiter = { resolve, reject };
      host.postMessage({ type: 'specs', refresh });
    });
  }
  const res = await fetch(`/api/specs${refresh ? '?refresh=1' : ''}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function loadSpecs(refresh = false) {
  const btn = $('btn-refresh');
  btn.classList.add('spin');
  btn.disabled = true;
  try {
    renderSpecs(await fetchSpecs(refresh));
  } catch (e) {
    setText('host', 'Could not read hardware info');
    setText('subtitle', String(e.message || e));
  } finally {
    btn.classList.remove('spin');
    btn.disabled = false;
  }
}

function connectLive() {
  const handle = (event, data) => {
    try { onEvent(event, data); } catch (err) { console.error(err); }
  };
  if (host) {
    host.addEventListener('message', (e) => handle(e.data.event, e.data.data));
    host.postMessage({ type: 'ready' });
    host.postMessage({ type: 'game-processes' });
    let savedPresentMonPath = '';
    try { savedPresentMonPath = localStorage.getItem('hwm-presentmon-path') || ''; } catch { /* optional */ }
    host.postMessage({ type: 'presentmon-state', path: savedPresentMonPath });
    return;
  }
  const es = new EventSource('/api/live');
  for (const event of ['live', 'sensors']) es.addEventListener(event, (e) => handle(event, JSON.parse(e.data)));
  es.onerror = () => {
    $('live-dot').classList.remove('on');
    setText('live-label', 'Reconnecting…');
  };
}

function initNav() {
  const links = [...document.querySelectorAll('nav a')];
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`));
    }
  }, { rootMargin: '-30% 0px -60% 0px' });
  document.querySelectorAll('main > section').forEach((s) => observer.observe(s));

  const target = { cpu: 'cpu', mem: 'memory', gpu: 'gpu', disk: 'storage', net: 'network' };
  document.querySelectorAll('.tile').forEach((t) =>
    t.addEventListener('click', () => $(target[t.dataset.k]).scrollIntoView()));
}

function initTheme() {
  const root = document.documentElement;
  // Keep the native title bar in sync with the page theme
  const syncHost = () => host?.postMessage({ type: 'theme', dark: root.dataset.theme !== 'light' });
  syncHost();
  $('btn-theme').addEventListener('click', () => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    try { localStorage.setItem('hwm-theme', next); } catch { /* storage unavailable */ }
    colorCache = {};
    charts.forEach((c) => c.draw());
    syncHost();
  });
}

initOverviewCharts();
initNav();
initTheme();
initHealthUi();
initGameUi();
initOverlaySettings();
$('btn-refresh').addEventListener('click', () => loadSpecs(true));
connectLive();
loadSpecs();
