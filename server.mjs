#!/usr/bin/env node
import zlib from 'node:zlib';
import crypto from 'node:crypto';
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
import dgram from 'node:dgram';
import https from 'node:https';
import { readFile, writeFile, rename, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DATA_FILE = process.env.DATA_FILE ? resolve(process.env.DATA_FILE) : join(ROOT, 'data.json');
const ROUTES_FILE = process.env.ROUTES_FILE ? resolve(process.env.ROUTES_FILE) : join(ROOT, 'routes.json');
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
// Optional shared API token. Empty keeps the original open-LAN behaviour.
const TOKEN = String(process.env.BAKI_TOKEN || '').trim();

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
    statements: {},
    settings: { name: '', cats: { in: [], out: [] }, profit: {}, budgets: {}, gpsCorrection: 1, dailyFoodCapCents: null, nextServiceKm: null, nextServiceOn: null, envelopeCarry: false, reserveTargets: {}, serviceOdoBase: null, serviceOdoBaseOn: null },
    tomb: { ids: [], cats: [] },
    dayNotes: {},
    dayCloses: {},
    statementMarks: {},
    envelopeMoves: {},
    reserveTxns: [],
    odometerReadings: [],
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
    breakMinutes: Math.min(24 * 60, Math.max(0, Math.round(Number(s.breakMinutes) || 0))),
    odoStart: s.odoStart == null || s.odoStart === '' ? null : Math.max(0, Number(s.odoStart) || 0),
    odoEnd: s.odoEnd == null || s.odoEnd === '' ? null : Math.max(0, Number(s.odoEnd) || 0),
    km: Math.max(0, Number(s.km) || 0),
    gross: Math.round(Number(s.gross)),
    incentive: Math.max(0, Math.round(Number(s.incentive) || 0)),
    extra: Math.max(0, Math.round(Number(s.extra) || 0)),
    kmPerLitre: Number(s.kmPerLitre) > 0 ? Number(s.kmPerLitre) : null,
    grabFee: s.grabFee == null ? null : Math.max(0, Math.round(Number(s.grabFee) || 0)),
    note: String(s.note || '').slice(0, 200),
    // payout times: what lets the week review talk about idle stretches
    ...(Array.isArray(s.payouts) && s.payouts.length ? {
      payouts: s.payouts
        .filter(p => p && Number.isFinite(Number(p.c)) && Number.isFinite(Number(p.at)))
        .slice(0, 200)
        .map(p => ({ c: Math.round(Number(p.c)), at: Number(p.at) })),
    } : {}),
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
/** Optional per-day page notes; old clients simply omit the map. */
function cleanDayNotes(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [date, note] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !note || typeof note !== 'object') continue;
    if (typeof note.text !== 'string') continue;
    out[date] = {
      text: note.text.slice(0, 500),
      updated: String(note.updated || new Date().toISOString()),
    };
  }
  return out;
}

function cleanDayCloses(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [date, close] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !close || typeof close !== 'object') continue;
    out[date] = {
      closed: close.closed !== false,
      updated: String(close.updated || new Date().toISOString()),
    };
  }
  return out;
}

function cleanBudgets(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [cat, value] of Object.entries(raw)) {
    const n = Number(value);
    if (n > 0) out[String(cat).slice(0, 40)] = n;
  }
  return out;
}

function cleanTargets(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const fund of ['fuel', 'wear']) {
    const n = Number(raw[fund]);
    if (Number.isFinite(n) && n > 0) out[fund] = n;
  }
  return out;
}

function cleanEnvelopeMoves(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [month, moves] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}$/.test(month) || !moves || typeof moves !== 'object') continue;
    const clean = {};
    for (const [cat, value] of Object.entries(moves)) {
      const n = Number(value);
      if (Number.isFinite(n) && n !== 0) clean[String(cat).slice(0, 40)] = n;
    }
    if (Object.keys(clean).length) out[month] = clean;
  }
  return out;
}

function cleanOdometerReadings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(r => r && typeof r.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')) && Number.isFinite(Number(r.km)) && Number(r.km) > 0)
    .slice(0, 5000)
    .map(r => ({
      id: r.id.slice(0, 80),
      date: r.date,
      km: Math.round(Number(r.km)),
      note: typeof r.note === 'string' ? r.note.slice(0, 80) : '',
      updated: String(r.updated || new Date().toISOString()),
    }));
}

function cleanReserveTxns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(tx => tx && typeof tx.id === 'string' && ['fuel', 'wear'].includes(tx.fund) && Number.isFinite(Number(tx.amount)) && Number(tx.amount) !== 0)
    .slice(0, 5000)
    .map(tx => ({
      id: tx.id.slice(0, 80), fund: tx.fund,
      amount: Math.round(Number(tx.amount)),
      date: typeof tx.date === 'string' ? tx.date : '',
      note: typeof tx.note === 'string' ? tx.note.slice(0, 120) : '',
      updated: String(tx.updated || new Date().toISOString()),
    }));
}

function cleanStatementMarks(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [week, mark] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !mark || typeof mark !== 'object') continue;
    out[week] = {
      reconciled: mark.reconciled !== false,
      updated: String(mark.updated || new Date().toISOString()),
    };
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

/* ---------- live change feed (Server-Sent Events) ----------
 * One-way server -> clients: "the data changed, version is now X".
 * Writes still go over POST /api/data, so this needs no framing, no
 * handshake and no dependency — and EventSource reconnects by itself.
 */
const sseClients = new Set();

function sseSend(res, event, payload) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }
  catch (e) { sseClients.delete(res); }
}
function broadcastChange(meta) {
  for (const res of sseClients) sseSend(res, 'change', meta);
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
/** Imported Grab statements, keyed by the Monday they cover. Reference data only. */
function cleanStatements(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [week, st] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) continue;
    if (!st || typeof st !== 'object') continue;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    out[week] = {
      week_start: week,
      range_text: typeof st.range_text === 'string' ? st.range_text.slice(0, 80) : '',
      income: num(st.income),
      deductions: num(st.deductions),
      weekly: num(st.weekly),
      transport_net: num(st.transport_net),
      pickup_fares: num(st.pickup_fares),
      trip_fares: num(st.trip_fares),
      other_income: num(st.other_income),
      incentives: num(st.incentives),
      tips: num(st.tips),
      insurance_count: num(st.insurance_count),
      consistent: !!st.consistent,
      imported_at: typeof st.imported_at === 'string' ? st.imported_at : '',
    };
  }
  return out;
}

function cleanBill(b) {
  if (!b || typeof b !== 'object') return null;
  if (typeof b.id !== 'string' || !b.id) return null;
  if (typeof b.name !== 'string' || !b.name.trim()) return null;
  if (!Number.isFinite(Number(b.amount)) || Number(b.amount) < 0) return null;
  const cadence = b.cadence === 'annual' ? 'annual' : 'monthly';
  const anchor = Number(b.anchorMonth);
  return {
    id: b.id.slice(0, 80),
    name: b.name.slice(0, 60),
    amount: Math.round(Number(b.amount)),
    cadence,
    category: typeof b.category === 'string' ? b.category.slice(0, 40) : 'other',
    business: b.business === true,
    optional: b.optional === true,
    anchorMonth: Number.isInteger(anchor) && anchor >= 1 && anchor <= 12 ? anchor : null,
    updated: typeof b.updated === 'string' ? b.updated : '',
    active: b.active !== false,
  };
}

function cleanBillPayment(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.billId !== 'string' || !p.billId) return null;
  if (typeof p.period !== 'string' || !/^\d{4}(-\d{2})?$/.test(p.period)) return null;
  if (typeof p.entryId !== 'string' || !p.entryId) return null;
  return {
    billId: p.billId.slice(0, 80),
    period: p.period,
    amount: Math.max(0, Math.round(Number(p.amount) || 0)),
    entryId: p.entryId.slice(0, 80),
    paidAt: typeof p.paidAt === 'string' ? p.paidAt : '',
    updated: typeof p.updated === 'string' ? p.updated : '',
    active: p.active !== false,
  };
}

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
    if (!cur || String(e.updated || '') >= String(cur.updated || '')) {
      // Older clients do not know about receipts; preserve one on an unrelated edit.
      const merged = { ...cur, ...e };
      if (e.receipt === undefined && cur && typeof cur.receipt === 'string') merged.receipt = cur.receipt;
      byId.set(e.id, merged);
    }
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
  const statements = cleanStatements(incoming.statements || {});
  for (const [week, st] of Object.entries(cleanStatements(base.statements || {}))) {
    const cur = statements[week];
    if (!cur || (st.imported_at || '') > (cur.imported_at || '')) statements[week] = st;
  }
  const billById = new Map();
  for (const b of (base.bills || [])) { const c = cleanBill(b); if (c) billById.set(c.id, c); }
  for (const b of (incoming.bills || [])) {
    const c = cleanBill(b);
    if (!c) continue;
    const cur = billById.get(c.id);
    if (!cur || c.updated >= cur.updated) billById.set(c.id, c);
  }
  const paymentByKey = new Map();
  const putPayment = (p) => {
    const c = cleanBillPayment(p);
    if (!c) return;
    const key = c.billId + '|' + c.period;
    const cur = paymentByKey.get(key);
    if (!cur || c.updated >= cur.updated) paymentByKey.set(key, c);
  };
  for (const p of (base.billPayments || [])) putPayment(p);
  for (const p of (incoming.billPayments || [])) putPayment(p);
  const dayNotes = { ...cleanDayNotes(base.dayNotes) };
  for (const [date, note] of Object.entries(cleanDayNotes(incoming.dayNotes))) {
    const cur = dayNotes[date];
    if (!cur || note.updated >= cur.updated) dayNotes[date] = note;
  }
  const dayCloses = { ...cleanDayCloses(base.dayCloses) };
  for (const [date, close] of Object.entries(cleanDayCloses(incoming.dayCloses))) {
    const cur = dayCloses[date];
    if (!cur || close.updated >= cur.updated) dayCloses[date] = close;
  }
  const statementMarks = { ...cleanStatementMarks(base.statementMarks) };
  for (const [week, mark] of Object.entries(cleanStatementMarks(incoming.statementMarks))) {
    const cur = statementMarks[week];
    if (!cur || mark.updated >= cur.updated) statementMarks[week] = mark;
  }
  const envelopeMoves = { ...cleanEnvelopeMoves(base.envelopeMoves) };
  for (const [month, moves] of Object.entries(cleanEnvelopeMoves(incoming.envelopeMoves))) {
    envelopeMoves[month] = { ...(envelopeMoves[month] || {}), ...moves };
  }
  const txnById = new Map();
  for (const tx of cleanReserveTxns(base.reserveTxns)) txnById.set(tx.id, tx);
  for (const tx of cleanReserveTxns(incoming.reserveTxns)) {
    const cur = txnById.get(tx.id);
    if (!cur || tx.updated >= cur.updated) txnById.set(tx.id, tx);
  }

  const readingById = new Map();
  for (const r of cleanOdometerReadings(base.odometerReadings)) readingById.set(r.id, r);
  for (const r of cleanOdometerReadings(incoming.odometerReadings)) {
    const cur = readingById.get(r.id);
    if (!cur || r.updated >= cur.updated) readingById.set(r.id, r);
  }
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    entries: [...byId.values()],
    odometerReadings: [...readingById.values()],
    bills: [...billById.values()],
    billPayments: [...paymentByKey.values()],
    shifts: [...shiftById.values()],
    statements,
    dayNotes,
    dayCloses,
    statementMarks,
    envelopeMoves,
    reserveTxns: [...txnById.values()],
    settings: {
      name: (incoming.settings && incoming.settings.name) || (base.settings && base.settings.name) || '',
      cats: {
        in: mergeCats(base.settings?.cats?.in, incoming.settings?.cats?.in),
        out: mergeCats(base.settings?.cats?.out, incoming.settings?.cats?.out),
      },
      profit: { ...cleanProfit(base.settings?.profit), ...cleanProfit(incoming.settings?.profit) },
      budgets: Object.prototype.hasOwnProperty.call(incoming.settings || {}, 'budgets')
        ? cleanBudgets(incoming.settings.budgets) : cleanBudgets(base.settings?.budgets),
      // These came after the original server schema. Presence checks keep older clients from
      // erasing them, while allowing the current client to explicitly clear them.
      gpsCorrection: Object.prototype.hasOwnProperty.call(incoming.settings || {}, 'gpsCorrection')
        && Number.isFinite(Number(incoming.settings.gpsCorrection))
        && Number(incoming.settings.gpsCorrection) > 0
        ? Number(incoming.settings.gpsCorrection)
        : (Number.isFinite(Number(base.settings?.gpsCorrection)) && Number(base.settings?.gpsCorrection) > 0
          ? Number(base.settings.gpsCorrection) : 1),
      dailyFoodCapCents: Object.prototype.hasOwnProperty.call(incoming.settings || {}, 'dailyFoodCapCents')
        ? (Number.isFinite(Number(incoming.settings.dailyFoodCapCents)) && Number(incoming.settings.dailyFoodCapCents) > 0
          ? Math.round(Number(incoming.settings.dailyFoodCapCents)) : null)
        : (Number.isFinite(Number(base.settings?.dailyFoodCapCents)) && Number(base.settings?.dailyFoodCapCents) > 0
          ? Math.round(Number(base.settings.dailyFoodCapCents)) : null),
      nextServiceKm: Object.prototype.hasOwnProperty.call(incoming.settings || {}, 'nextServiceKm')
        ? (Number.isFinite(Number(incoming.settings.nextServiceKm)) && Number(incoming.settings.nextServiceKm) > 0
          ? Math.round(Number(incoming.settings.nextServiceKm)) : null)
        : (Number.isFinite(Number(base.settings?.nextServiceKm)) && Number(base.settings?.nextServiceKm) > 0
          ? Math.round(Number(base.settings.nextServiceKm)) : null),
      nextServiceOn: Object.prototype.hasOwnProperty.call(incoming.settings || {}, 'nextServiceOn')
        ? (typeof incoming.settings.nextServiceOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(incoming.settings.nextServiceOn)
          ? incoming.settings.nextServiceOn : null)
        : (typeof base.settings?.nextServiceOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(base.settings.nextServiceOn)
          ? base.settings.nextServiceOn : null),
      envelopeCarry: Object.prototype.hasOwnProperty.call(incoming.settings || {}, 'envelopeCarry')
        ? incoming.settings.envelopeCarry === true : base.settings?.envelopeCarry === true,
      reserveTargets: Object.prototype.hasOwnProperty.call(incoming.settings || {}, 'reserveTargets')
        ? cleanTargets(incoming.settings.reserveTargets) : cleanTargets(base.settings?.reserveTargets),
      serviceOdoBase: Object.prototype.hasOwnProperty.call(incoming.settings || {}, 'serviceOdoBase')
        ? (Number.isFinite(Number(incoming.settings.serviceOdoBase)) && Number(incoming.settings.serviceOdoBase) > 0
          ? Math.round(Number(incoming.settings.serviceOdoBase)) : null)
        : (Number.isFinite(Number(base.settings?.serviceOdoBase)) && Number(base.settings?.serviceOdoBase) > 0
          ? Math.round(Number(base.settings.serviceOdoBase)) : null),
      serviceOdoBaseOn: Object.prototype.hasOwnProperty.call(incoming.settings || {}, 'serviceOdoBaseOn')
        ? (typeof incoming.settings.serviceOdoBaseOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(incoming.settings.serviceOdoBaseOn)
          ? incoming.settings.serviceOdoBaseOn : null)
        : (typeof base.settings?.serviceOdoBaseOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(base.settings.serviceOdoBaseOn)
          ? base.settings.serviceOdoBaseOn : null),
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


/** The newest APK in dist-android, by modification time. */
async function newestApk() {
  const list = await apkList();
  return list[0] || null;
}

async function apkList() {
  const dir = join(ROOT, 'dist-android');
  try {
    const names = (await readdir(dir)).filter(n => n.endsWith('.apk'));
    const rows = await Promise.all(names.map(async name => {
      const st = await stat(join(dir, name));
      return { name, size: st.size, mtime: st.mtimeMs, when: st.mtime.toISOString().slice(0, 16).replace('T', ' ') };
    }));
    return rows.sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function json(req, res, code, obj) {
  const raw = JSON.stringify(obj);
  // payloads are JSON and highly compressible; the client advertises gzip support
  const acceptsGzip = String(req?.headers?.['accept-encoding'] || '').includes('gzip');
  const body = acceptsGzip && raw.length > 1024 ? zlib.gzipSync(raw) : Buffer.from(raw);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
    vary: 'accept-encoding',
  };
  if (acceptsGzip && raw.length > 1024) headers['content-encoding'] = 'gzip';
  res.writeHead(code, headers);
  res.end(body);
}

/* ---------------------------------------------------------------- routes
 * Opaque encrypted blobs, one per shift. The server never sees a coordinate: the phone seals the
 * trace with a key only the two clients know, and the desk opens it again. Kept out of data.json so
 * a ledger backup never drags a month of movement history with it.
 */
let routesCache = null;

async function loadRoutes() {
  if (routesCache) return routesCache;
  try {
    const parsed = JSON.parse(await readFile(ROUTES_FILE, 'utf8'));
    routesCache = { v: 1, items: parsed && parsed.items ? parsed.items : {} };
  } catch (e) {
    routesCache = { v: 1, items: {} };
  }
  return routesCache;
}

async function saveRoutes(next) {
  routesCache = next;
  const tmp = ROUTES_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(next), 'utf8');
  await rename(tmp, ROUTES_FILE);
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

function shutdown() {
  try { if (beaconTimer) clearInterval(beaconTimer); } catch (e) {}
  try { if (mdns) mdns.destroy(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function authorized(req) {
  if (!TOKEN) return true;
  const supplied = req.headers['x-baki-token'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!supplied) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const path = decodeURIComponent(url.pathname);
  lastAccess = Date.now();
  if (process.env.LOG_REQUESTS === '1') {
    console.log(`[req] :${req.socket.localPort} ${req.method} ${path} from ${req.socket.remoteAddress} origin=${req.headers.origin||'-'} ua=${(req.headers['user-agent']||'').slice(0,28)}`);
  }

  // CORS: allows the same HTML opened as a local file to talk to this server.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-baki-token, authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // The ledger and movement APIs require the token when one is configured. Ping and the
  // install/CA pages remain public for discovery and setup.
  if (path.startsWith('/api/') && path !== '/api/ping' && !authorized(req)) {
    return json(req, res, 401, { ok: false, error: 'Unauthorized' });
  }

  try {
    // The private CA certificate, so a phone can download and trust it.
    if (path === '/ca.crt') {
      if (!existsSync(TLS_CA)) return json(req, res, 404, { ok: false, error: 'Run ./tools/setup-https.sh first' });
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
      if (process.env.ALLOW_RESET !== '1') return json(req, res, 404, { ok: false, error: 'Not found' });
      const remote = req.socket.remoteAddress || '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return json(req, res, 403, { ok: false, error: 'Local only' });
      if (req.method !== 'POST') return json(req, res, 405, { ok: false, error: 'Use POST' });
      await save(emptyData());
      broadcastChange({ version: cache.version, entries: 0, at: new Date().toISOString(), reset: true });
      return json(req, res, 200, { ok: true });
    }

    if (path === '/api/events') {
      if (req.method !== 'GET') return json(req, res, 405, { ok: false, error: 'Use GET' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      const { version } = await load();
      sseSend(res, 'hello', { version, at: new Date().toISOString() });
      const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (e) { /* gone */ } }, 25000);
      const done = () => { clearInterval(keepalive); sseClients.delete(res); };
      req.on('close', done);
      req.on('error', done);
      return;
    }

    if (path === '/api/ping') {
      const { data, version } = await load();
      return json(req, res, 200, {
        ok: true,
        app: 'grab-money',
        version,
        entries: data ? data.entries.length : 0,
        at: new Date().toISOString(),
      });
    }

    if (path === '/api/routes') {
      if (req.method === 'GET') {
        const since = url.searchParams.get('since') || '0000-00-00';
        const store = await loadRoutes();
        const items = Object.values(store.items)
          .filter(it => it && typeof it.date === 'string' && it.date >= since)
          .sort((a, b) => a.date.localeCompare(b.date));
        return json(req, res, 200, { ok: true, items });
      }
      if (req.method === 'POST') {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch (err) {
          return json(req, res, 400, { ok: false, error: err.message === 'body too large' ? 'Payload too large' : 'Invalid JSON' });
        }
        const incoming = Array.isArray(payload.items) ? payload.items : [];
        const store = await loadRoutes();
        let count = 0;
        for (const it of incoming) {
          if (!it || typeof it.shiftId !== 'string' || !it.shiftId) continue;
          if (typeof it.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(it.date)) continue;
          if (typeof it.blob !== 'string' || it.blob.length < 16 || it.blob.length > 400_000) continue;
          store.items[it.shiftId] = { shiftId: it.shiftId, date: it.date, blob: it.blob, at: new Date().toISOString() };
          count++;
        }
        if (count === 0) return json(req, res, 400, { ok: false, error: 'No valid route items' });
        await saveRoutes(store);
        return json(req, res, 200, { ok: true, count, stored: Object.keys(store.items).length });
      }
      return json(req, res, 405, { ok: false, error: 'Use GET or POST' });
    }

    if (path === '/api/data') {
      if (req.method === 'GET') {
        const { data, version } = await load();
        const etag = `W/"${version}"`;
        res.setHeader('etag', etag);
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag, 'cache-control': 'no-store' });
          return res.end();
        }
        return json(req, res, 200, { ok: true, version, data: data || null, tomb: cleanTomb(data?.tomb) });
      }
      if (req.method === 'POST') {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch (err) {
          return json(req, res, 400, { ok: false, error: err.message === 'body too large' ? 'Backup too large' : 'Invalid JSON' });
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
          return json(req, res, 400, { ok: false, error: 'Expected { entries: [...] }' });
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
            // odometer at a fuel stop: the only way to measure real km/L
            ...(e.cat === 'fuel' && Number.isFinite(Number(e.odo)) && Number(e.odo) > 0 ? { odo: Math.round(Number(e.odo)) } : {}),
            // Small synced JPEG receipt; absent means "no change" for older clients.
            ...(typeof e.receipt === 'string' && e.receipt.length <= 180_000 ? { receipt: e.receipt } : {}),
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
              budgets: cleanBudgets(incoming.settings?.budgets),
              envelopeCarry: incoming.settings?.envelopeCarry === true,
              reserveTargets: cleanTargets(incoming.settings?.reserveTargets),
              serviceOdoBase: Number.isFinite(Number(incoming.settings?.serviceOdoBase)) && Number(incoming.settings?.serviceOdoBase) > 0
                ? Math.round(Number(incoming.settings.serviceOdoBase)) : null,
              serviceOdoBaseOn: typeof incoming.settings?.serviceOdoBaseOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(incoming.settings.serviceOdoBaseOn)
                ? incoming.settings.serviceOdoBaseOn : null,
            },
            tomb: {
              ids: [...new Set(deletedIds)].filter(id => !undeleteIds.includes(id)).slice(-TOMB_MAX),
              cats: [...new Set(deletedCats)].slice(-100),
            },
            dayNotes: cleanDayNotes(incoming.dayNotes),
            dayCloses: cleanDayCloses(incoming.dayCloses),
            statementMarks: cleanStatementMarks(incoming.statementMarks),
            envelopeMoves: cleanEnvelopeMoves(incoming.envelopeMoves),
            reserveTxns: cleanReserveTxns(incoming.reserveTxns),
            odometerReadings: cleanOdometerReadings(incoming.odometerReadings),
          };
        } else {
          next = mergeData(current.data, {
            ...incoming,
            entries: clean,
            shifts: cleanShifts,
            dayNotes: cleanDayNotes(incoming.dayNotes),
            dayCloses: cleanDayCloses(incoming.dayCloses),
            bills: (Array.isArray(incoming.bills) ? incoming.bills : []).map(cleanBill).filter(Boolean),
            billPayments: (Array.isArray(incoming.billPayments) ? incoming.billPayments : []).map(cleanBillPayment).filter(Boolean),
            odometerReadings: cleanOdometerReadings(incoming.odometerReadings),
          }, { deletedIds, deletedCats, undeleteIds });
        }
        await save(next);
        broadcastChange({ version: cache.version, entries: next.entries.length, at: new Date().toISOString() });
        console.log(`[${new Date().toLocaleTimeString('en-GB')}] saved ${next.entries.length} entries  (${req.headers['x-forwarded-for'] || req.socket.remoteAddress})`);
        return json(req, res, 200, { ok: true, version: cache.version, data: next, tomb: cleanTomb(next.tomb), entries: next.entries.length });
      }
      return json(req, res, 405, { ok: false, error: 'Use GET or POST' });
    }

    // ---- app download shortcut ----------------------------------------------
    // /apk always points at the newest APK, so the phone can bookmark one URL.
    if (path === '/apk') {
      const found = await newestApk();
      if (!found) return json(req, res, 404, { ok: false, error: 'No APK published yet' });
      res.writeHead(302, {
        location: '/dist-android/' + encodeURIComponent(found.name),
        'cache-control': 'no-store',
      });
      return res.end();
    }

    // /dl is the "download page": current version, size, and a QR for the phone.
    if (path === '/dl') {
      const found = await newestApk();
      const rows = found ? await apkList() : [];
      const body = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Baki — install</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0D110C; color:#E8F2D6;
         font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
         display:flex; justify-content:center; padding:28px 18px; }
  main { width:100%; max-width:420px; }
  h1 { font-size:22px; margin:0 0 4px; }
  p.sub { color:#9AA694; margin:0 0 20px; font-size:14px; }
  a.big { display:block; text-align:center; background:#B3C78D; color:#141A0C;
          font-weight:700; text-decoration:none; padding:16px; border-radius:999px;
          font-size:17px; margin:16px 0 6px; }
  .meta { color:#9AA694; font-size:13px; text-align:center; }
  h2 { font-size:12px; letter-spacing:1px; color:#9AA694; margin:26px 0 8px; }
  ul { list-style:none; padding:0; margin:0; }
  li { background:#171B12; border-radius:16px; padding:12px 14px; margin-bottom:8px;
       display:flex; justify-content:space-between; font-size:13px; }
  li a { color:#B3C78D; text-decoration:none; }
  .qr { background:#fff; padding:12px; border-radius:18px; width:max-content; margin:14px auto 0; }
  img { display:block; width:200px; height:200px; }
</style></head><body><main>
  <h1>Baki</h1>
  <p class="sub">Scan once on your phone, then bookmark the page.</p>
  <div class="qr"><img src="/qr.png" alt="QR code to this page"></div>
  <a class="big" href="/apk">Download latest APK</a>
  <div class="meta">${found ? `${found.name} · ${(found.size / 1048576).toFixed(2)} MB · ${found.when}` : 'nothing published yet'}</div>
  <h2>PREVIOUS BUILDS</h2>
  <ul>${rows.map(r => `<li><a href="/dist-android/${encodeURIComponent(r.name)}">${r.name}</a><span>${(r.size / 1048576).toFixed(1)} MB</span></li>`).join('')}</ul>
</main></body></html>`;
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      return res.end(body);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(req, res, 405, { ok: false, error: 'Method not allowed' });
    }

    // static: serve index.html for / and any unknown path
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT + sep) || rel.startsWith('data.json')) {
      return json(req, res, 403, { ok: false, error: 'Forbidden' });
    }
    if (existsSync(file)) {
      const body = await readFile(file);
      const ext = extname(file).toLowerCase();
      const headers = {
        'content-type': MIME[ext] || 'application/octet-stream',
        // icons and the shell must never be served stale — a cached icon survives reinstalls
        // icons, the shell and installers must never be served stale: a cached APK
        // means an old build gets installed from a link you just refreshed
        'cache-control': (rel === 'index.html' || ext === '.webmanifest' || ext === '.png' || ext === '.ico' || ext === '.apk')
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
    if (!res.headersSent) return json(req, res, 500, { ok: false, error: 'Server error' });
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

/* ---------- UDP beacon ----------
 * mDNS works between Node and Node, but mdns-sd (Rust) resolves the PTR and then
 * never gets an answer to its SRV/TXT query. A plain broadcast has no such
 * ambiguity: the client just listens on a fixed port.
 */
const BEACON_PORT = 43871;   // broadcast, one-way
const PROBE_PORT = 43872;    // unicast requests (separate, so the client can bind 43871)
let beaconTimer = null;

function beaconPayload() {
  return Buffer.from(JSON.stringify({
    app: 'baki', v: 1,
    port: httpsServer ? TLS_PORT : PORT,
    tls: !!httpsServer,
    plainPort: PORT,          // apps can fall back to this when TLS is untrusted
    path: '/api',
    host: hostname(),
  }));
}

/** Answer unicast probes: broadcast is filtered on many home routers. */
function startProbeResponder() {
  try {
    const listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    listener.on('error', () => {});
    listener.on('message', (_msg, rinfo) => {
      try { const p = beaconPayload(); listener.send(p, 0, p.length, rinfo.port, rinfo.address); } catch (e) {}
    });
    listener.bind({ port: PROBE_PORT, exclusive: false });
  } catch (e) {}
}

function startBeacon() {
  if (process.env.NO_MDNS === '1') return;
  const targets = ['255.255.255.255'];
  for (const { ip, mask } of lanAddresses()) {
    // also hit each subnet's directed broadcast, which some APs handle better
    const b = broadcastOf(ip, mask);
    if (b && !targets.includes(b)) targets.push(b);
  }
  let sock;
  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => console.log('  beacon : off —', e.message));
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch (e) {}
      const send = () => {
        const payload = Buffer.from(JSON.stringify({
          app: 'baki', v: 1,
          port: httpsServer ? TLS_PORT : PORT,
          tls: !!httpsServer,
          plainPort: PORT,
          path: '/api',
          host: hostname(),
        }));
        for (const t of targets) {
          try { sock.send(payload, 0, payload.length, BEACON_PORT, t); } catch (e) {}
        }
      };
      send();
      beaconTimer = setInterval(send, 2000);
      beaconTimer.unref?.();


    });
  } catch (e) {
    console.log('  beacon : off —', e.message);
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ ip: net.address, mask: net.netmask });
    }
  }
  return out;
}
function broadcastOf(ip, mask) {
  const toInt = (a) => a.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  const ipN = toInt(ip), mN = toInt(mask);
  const b = (ipN | (~mN >>> 0)) >>> 0;
  return [(b >>> 24) & 255, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join('.');
}

/* ---------- mDNS: let other devices find this server without typing an IP ----------
 * Optional dependency: if bonjour-service is not installed the server still runs,
 * it just cannot be discovered. Set NO_MDNS=1 to switch it off (used by the tests).
 */
let mdns = null;
async function advertise() {
  if (process.env.NO_MDNS === '1') { console.log('  mDNS   : off (NO_MDNS=1)'); return; }
  let Bonjour;
  try { ({ Bonjour } = await import('bonjour-service')); }
  catch (e) { console.log('  mDNS   : off (npm install bonjour-service to enable discovery)'); return; }
  try {
    // include the port: two servers on one machine must not fight over one mDNS name
    const instance = `Baki on ${hostname()} (${httpsServer ? TLS_PORT : PORT})`;
    mdns = new Bonjour();
    const servicePort = httpsServer ? TLS_PORT : PORT;
    mdns.publish({
      name: instance,
      type: 'baki',
      protocol: 'tcp',
      port: servicePort,
      txt: { app: 'baki', v: '1', path: '/api', tls: httpsServer ? '1' : '0', plainPort: String(PORT) },
    });
    console.log(`  mDNS   : advertising _baki._tcp on ${servicePort}`);
  } catch (e) {
    console.log('  mDNS   : failed —', e.message);
  }
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
server.on('listening', () => { advertise(); startBeacon(); startProbeResponder(); });

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
    if (TOKEN) console.log('  API token: required (BAKI_TOKEN is set).');
    else console.warn('  [security] API token is not set; the ledger API is open on this LAN. Set BAKI_TOKEN to require one.');
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
