#!/usr/bin/env node
/**
 * Baki sync server
 * ---------------------------------------------------------------
 * Serves the tracker and one shared data file, so the phone and the
 * laptop always see the same entries.
 *
 *   node server.mjs            (or ./sync.sh)
 *   PORT=8787 node server.mjs
 *
 * Data lives in ./data.json next to this file. Back it up by copying
 * that file, or with More → Backup in the app.
 */
import http from 'node:http';
import https from 'node:https';
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DATA_FILE = process.env.DATA_FILE ? resolve(process.env.DATA_FILE) : join(ROOT, 'data.json');
const BACKUP_DIR = join(ROOT, 'backups');
const KEEP_BACKUPS = 30;
const PORT = Number(process.env.PORT || 8787);
// keep the HTTPS port distinct when someone runs a second copy on another PORT
const TLS_PORT = Number(process.env.TLS_PORT || (PORT === 8787 ? 8443 : PORT + 1000));
const TLS_DIR = join(ROOT, 'tls');
const TLS_KEY = join(TLS_DIR, 'server.key');
const TLS_CERT = join(TLS_DIR, 'server.crt');
const TLS_CA = join(TLS_DIR, 'ca.crt');
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

let cache = null; // { data, version }
let writeQueue = Promise.resolve();
let lastAccess = 0;

const TOMB_MAX = 600;
function emptyData() {
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    entries: [],
    shifts: [],
    settings: { name: '', cats: { in: [], out: [] }, profit: {} },
    tomb: { ids: [], cats: [] },
  };
}
function cleanShift(s) {
  if (!s || typeof s !== 'object') return null;
  if (typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) return null;
  if (!Number.isFinite(Number(s.gross)) || Number(s.gross) < 0) return null;
  return {
    id: String(s.id || `shift-${Math.random().toString(36).slice(2)}`),
    date: s.date,
    start: typeof s.start === 'string' && /^\d{2}:\d{2}$/.test(s.start) ? s.start : '',
    hours: Math.min(24, Math.max(0, Number(s.hours) || 0)),
    odoStart: s.odoStart == null || s.odoStart === '' ? null : Math.max(0, Number(s.odoStart) || 0),
    odoEnd: s.odoEnd == null || s.odoEnd === '' ? null : Math.max(0, Number(s.odoEnd) || 0),
    km: Math.max(0, Number(s.km) || 0),
    gross: Math.round(Number(s.gross)),
    incentive: Math.max(0, Math.round(Number(s.incentive) || 0)),
    extra: Math.max(0, Math.round(Number(s.extra) || 0)),
    kmPerLitre: Number(s.kmPerLitre) > 0 ? Number(s.kmPerLitre) : null,
    grabFee: s.grabFee == null ? null : Math.max(0, Math.round(Number(s.grabFee) || 0)),
    note: String(s.note || '').slice(0, 200),
    ...(s.sample ? { sample: true } : {}),
    updated: String(s.updated || new Date().toISOString()),
  };
}
function cleanProfit(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  for (const [k, v] of Object.entries(p)) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[String(k).slice(0, 40)] = n;
  }
  return out;
}
function cleanTomb(t) {
  const raw = t && typeof t === 'object' ? t : {};
  return {
    ids: [...new Set((Array.isArray(raw.ids) ? raw.ids : []).map(String))].slice(-TOMB_MAX),
    cats: [...new Set((Array.isArray(raw.cats) ? raw.cats : []).map(String))].slice(-100),
  };
}

async function load() {
  if (cache) return cache;
  if (!existsSync(DATA_FILE)) {
    cache = { data: null, version: '0' };
    return cache;
  }
  try {
    const raw = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    const data = raw && typeof raw === 'object' ? (raw.data || raw) : null;
    const parsed = data && data.updatedAt ? Date.parse(data.updatedAt) : NaN;
    const version = Number.isFinite(parsed) ? String(parsed) : String(Date.now());
    cache = { data: data && Array.isArray(data.entries) ? data : null, version };
  } catch (err) {
    console.warn('[warn] could not read data.json:', err.message, '— starting empty');
    cache = { data: null, version: '0' };
  }
  return cache;
}

/**
 * Last-writer-wins merge keyed by entry id + updated timestamp.
 * `deletedIds` / `deletedCats` are explicit tombstones: a phone that
 * deleted an entry tells the server to drop it everywhere, instead of
 * the entry being resurrected by an additive merge.
 */
function mergeData(current, incoming, tombstones = {}) {
  const base = current && Array.isArray(current.entries) ? current : emptyData();
  const stored = cleanTomb(base.tomb);
  const undeleteIds = new Set(tombstones.undeleteIds || []);
  const deletedIds = new Set([...stored.ids, ...(tombstones.deletedIds || [])].filter(id => !undeleteIds.has(id)));
  const deletedCats = new Set([...stored.cats, ...(tombstones.deletedCats || [])]);
  const byId = new Map();
  for (const e of base.entries) if (!deletedIds.has(e.id)) byId.set(e.id, e);
  for (const e of incoming.entries) {
    if (deletedIds.has(e.id)) continue;
    const cur = byId.get(e.id);
    if (!cur || String(e.updated || '') >= String(cur.updated || '')) byId.set(e.id, e);
  }
  const mergeCats = (a = [], b = []) => {
    const m = new Map();
    for (const c of a) if (c && c.id) m.set(c.id, c);
    for (const c of b) if (c && c.id) m.set(c.id, c);
    return [...m.values()].filter(c => !deletedCats.has(c.id));
  };
  const shiftById = new Map();
  for (const x of base.shifts || []) if (!deletedIds.has(x.id)) shiftById.set(x.id, x);
  for (const x of incoming.shifts || []) {
    if (deletedIds.has(x.id)) continue;
    const cur = shiftById.get(x.id);
    if (!cur || String(x.updated || '') >= String(cur.updated || '')) shiftById.set(x.id, x);
  }
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    entries: [...byId.values()],
    shifts: [...shiftById.values()],
    settings: {
      name: (incoming.settings && incoming.settings.name) || (base.settings && base.settings.name) || '',
      cats: {
        in: mergeCats(base.settings?.cats?.in, incoming.settings?.cats?.in),
        out: mergeCats(base.settings?.cats?.out, incoming.settings?.cats?.out),
      },
      profit: { ...cleanProfit(base.settings?.profit), ...cleanProfit(incoming.settings?.profit) },
    },
    tomb: {
      ids: [...deletedIds].slice(-TOMB_MAX),
      cats: [...deletedCats].slice(-100),
    },
  };
}

async function pruneBackups() {
  try {
    const files = (await readdir(BACKUP_DIR)).filter(f => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) {
      await unlink(join(BACKUP_DIR, f)).catch(() => {});
    }
  } catch {}
}

function save(data) {
  const snapshot = JSON.stringify(data, null, 2);
  const version = String(Date.parse(data.updatedAt) || Date.now());
  cache = { data, version };
  writeQueue = writeQueue.then(async () => {
    // keep a dated copy of the previous version before overwriting
    try {
      if (existsSync(DATA_FILE)) {
        await mkdir(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        await writeFile(join(BACKUP_DIR, 'data-' + stamp + '.json'), await readFile(DATA_FILE), 'utf8');
        await pruneBackups();
      }
    } catch (err) {
      console.warn('[warn] could not write a rotation backup:', err.message);
    }
    const tmp = DATA_FILE + '.tmp';
    await writeFile(tmp, snapshot, 'utf8');
    await rename(tmp, DATA_FILE);
  }).catch(err => console.error('[error] write failed:', err.message));
  return writeQueue;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve_, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve_(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const path = decodeURIComponent(url.pathname);
  lastAccess = Date.now();

  // CORS: allows the same HTML opened as a local file to talk to this server.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    // The private CA certificate, so a phone can download and trust it.
    if (path === '/ca.crt') {
      if (!existsSync(TLS_CA)) return json(res, 404, { ok: false, error: 'Run ./tools/setup-https.sh first' });
      const pem = await readFile(TLS_CA);
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="grab-money-ca.crt"',
        'content-length': pem.length,
      });
      return res.end(pem);
    }

    // Test-only reset. Disabled unless ALLOW_RESET=1, and only from this machine.
    if (path === '/api/reset') {
      if (process.env.ALLOW_RESET !== '1') return json(res, 404, { ok: false, error: 'Not found' });
      const remote = req.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return json(res, 403, { ok: false, error: 'Local only' });
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Use POST' });
      await save(emptyData());
      return json(res, 200, { ok: true });
    }

    if (path === '/api/ping') {
      const { data, version } = await load();
      return json(res, 200, {
        ok: true,
        app: 'grab-money',
        version,
        entries: data ? data.entries.length : 0,
        at: new Date().toISOString(),
      });
    }

    if (path === '/api/data') {
      if (req.method === 'GET') {
        const { data, version } = await load();
        return json(res, 200, { ok: true, version, data: data || null, tomb: cleanTomb(data?.tomb) });
      }
      if (req.method === 'POST') {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message === 'body too large' ? 'Backup too large' : 'Invalid JSON' });
        }
        // Accept both {data:{...}, replace:false} and a bare store object,
        // so payloads from the app's backup files work directly.
        // A full replace can wipe the shared history by accident. Only honoured in
        // explicitly-enabled reset mode; otherwise it degrades to a merge.
        let replace = payload && payload.replace === true;
        if (replace && process.env.ALLOW_RESET !== '1') {
          console.warn('[warn] replace refused (set ALLOW_RESET=1 to allow) — merging instead');
          replace = false;
        }
        const incoming = payload && payload.data ? payload.data : payload;
        if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.entries)) {
          return json(res, 400, { ok: false, error: 'Expected { entries: [...] }' });
        }
        const clean = incoming.entries
          .filter(e => e && typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
          .filter(e => Number.isFinite(Number(e.amount)) && Number(e.amount) > 0)
          .map(e => ({
            id: String(e.id || `srv-${Math.random().toString(36).slice(2)}`),
            date: e.date,
            type: e.type === 'income' ? 'income' : 'expense',
            cat: String(e.cat || 'other'),
            amount: Math.round(Number(e.amount)),
            note: String(e.note || '').slice(0, 200),
            updated: String(e.updated || new Date().toISOString()),
            ...(e.sample ? { sample: true } : {}),
          }));
        const cleanShifts = (Array.isArray(incoming.shifts) ? incoming.shifts : []).map(cleanShift).filter(Boolean).slice(0, 5000);
        const profitIn = cleanProfit(incoming.settings?.profit);
        const current = await load();
        const deletedIds = Array.isArray(payload.deletedIds) ? payload.deletedIds.map(String).slice(0, 2000) : [];
        const deletedCats = Array.isArray(payload.deletedCats) ? payload.deletedCats.map(String).slice(0, 200) : [];
        const undeleteIds = Array.isArray(payload.undeleteIds) ? payload.undeleteIds.map(String).slice(0, 200) : [];
        let next;
        if (replace) {
          next = {
            ...emptyData(),
            v: 1,
            updatedAt: new Date().toISOString(),
            entries: clean.filter(e => !deletedIds.includes(e.id) || undeleteIds.includes(e.id)),
            shifts: cleanShifts.filter(x => !deletedIds.includes(x.id) || undeleteIds.includes(x.id)),
            settings: {
              name: incoming.settings?.name || '',
              cats: {
                in: (incoming.settings?.cats?.in || []).filter(c => !deletedCats.includes(c.id)),
                out: (incoming.settings?.cats?.out || []).filter(c => !deletedCats.includes(c.id)),
              },
              profit: profitIn,
            },
            tomb: {
              ids: [...new Set(deletedIds)].filter(id => !undeleteIds.includes(id)).slice(-TOMB_MAX),
              cats: [...new Set(deletedCats)].slice(-100),
            },
          };
        } else {
          next = mergeData(current.data, { ...incoming, entries: clean, shifts: cleanShifts }, { deletedIds, deletedCats, undeleteIds });
        }
        await save(next);
        console.log(`[${new Date().toLocaleTimeString('en-GB')}] saved ${next.entries.length} entries  (${req.headers['x-forwarded-for'] || req.socket.remoteAddress})`);
        return json(res, 200, { ok: true, version: cache.version, data: next, tomb: cleanTomb(next.tomb), entries: next.entries.length });
      }
      return json(res, 405, { ok: false, error: 'Use GET or POST' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { ok: false, error: 'Method not allowed' });
    }

    // static: serve index.html for / and any unknown path
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT + sep) || rel.startsWith('data.json')) {
      return json(res, 403, { ok: false, error: 'Forbidden' });
    }
    if (existsSync(file)) {
      const body = await readFile(file);
      const ext = extname(file).toLowerCase();
      const headers = {
        'content-type': MIME[ext] || 'application/octet-stream',
        // icons and the shell must never be served stale — a cached icon survives reinstalls
        'cache-control': (rel === 'index.html' || ext === '.webmanifest' || ext === '.png' || ext === '.ico')
          ? 'no-store' : 'public, max-age=3600',
      };
      if (rel === 'sw.js') headers['service-worker-allowed'] = '/';
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    }
    // fall back to the app for unknown routes (e.g. /?tab=summary)
    const index = await readFile(join(ROOT, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(index);
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) return json(res, 500, { ok: false, error: 'Server error' });
    res.end();
  }
}
const server = http.createServer(handle);

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ name, ip: net.address });
    }
  }
  return out;
}

function failPort(err, port) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use.\n` +
      `  The tracker may already be running — try opening it.\n` +
      `  Otherwise stop the other copy, or run:  PORT=8788 ./sync.sh\n`);
    process.exit(1);
  }
  throw err;
}

/** Is a tracker already serving on this port? */
async function trackerOn(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.app === 'grab-money' ? j : null;
  } catch { return null; }
}

// If we're already running, say so clearly instead of dying with a port error.
const running = await trackerOn(PORT);
if (running) {
  const lan = addresses();
  const line = '─'.repeat(56);
  console.log(`\n  Baki is already running — nothing to start.\n  ${line}`);
  console.log(`  Laptop : http://localhost:${PORT}`);
  for (const a of lan) console.log(`  Phone  : http://${a.ip}:${PORT}`);
  if (existsSync(TLS_CERT)) {
    console.log(`  Phone  : https://${lan[0]?.ip || '<laptop-ip>'}:${TLS_PORT}   (install + offline)`);
  }
  console.log(`  ${line}`);
  console.log(`  Entries stored : ${running.entries}`);
  console.log('  To stop it, press Ctrl+C in the window that is running it.');
  console.log('  To restart after changing certificates: stop it first, then run ./sync.sh\n');
  process.exit(0);
}

const servers = [server];
let httpsServer = null;

if (existsSync(TLS_KEY) && existsSync(TLS_CERT)) {
  httpsServer = https.createServer(
    { key: await readFile(TLS_KEY), cert: await readFile(TLS_CERT) },
    handle
  );
  servers.push(httpsServer);
  httpsServer.listen(TLS_PORT, HOST).on('error', err => failPort(err, TLS_PORT));
}
server.listen(PORT, HOST).on('error', err => failPort(err, PORT));

setTimeout(async () => {
  const { data } = await load();
  const line = '─'.repeat(56);
  const lan = addresses();
  console.log(`\n  Baki sync server\n  ${line}`);
  console.log(`  Data file : ${DATA_FILE}`);
  console.log(`  Entries   : ${data ? data.entries.length : 0}`);
  console.log(`  ${line}`);
  if (httpsServer) {
    console.log('  INSTALL + OFFLINE (recommended, needs the CA trusted once):');
    console.log(`    Phone   : https://${lan[0]?.ip || '<laptop-ip>'}:${TLS_PORT}`);
    console.log(`    Laptop  : https://localhost:${TLS_PORT}`);
    console.log(`    CA file : http://${lan[0]?.ip || '<laptop-ip>'}:${PORT}/ca.crt`);
    console.log('  Plain (works now, no install):');
  } else {
    console.log('  For app install + offline mode, run ./tools/setup-https.sh once.');
    console.log('  Addresses (plain):');
  }
  console.log(`    Laptop  : http://localhost:${PORT}`);
  for (const a of lan) console.log(`    Phone   : http://${a.ip}:${PORT}   (${a.name})`);
  if (!lan.length) console.log('  (no Wi-Fi/LAN address found — connect both devices to the same network)');
  console.log(`  ${line}`);
  console.log('  Keep this window open while you use the tracker. Ctrl+C to stop.\n');
}, 120);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nStopping… data is saved in ' + DATA_FILE);
    for (const s of servers) { try { s.close(); } catch {} }
    setTimeout(() => process.exit(0), 800);
  });
}
