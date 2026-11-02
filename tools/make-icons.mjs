#!/usr/bin/env node
/**
 * Generates the app icons as true vector geometry, rasterised at each target
 * size with 6x6 supersampling. Nothing is drawn at a small size and upscaled,
 * so edges stay clean at 48px and at 1024px.
 *
 *   node tools/make-icons.mjs
 *
 * Art: a road receding to the horizon on a lime tile — driving, and the road
 * you actually get paid for. The same shape is used in the app header.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..');

const LIME = [196, 240, 66];
const INK  = [11, 15, 13];

/* ---------- design space 0..100 ---------- */
// A coin with a tick cut out of it: money, kept. One glyph, no letters — it holds
// at 48px and still has room to breathe at 1024px, which is what Material and
// Nothing ask of an app icon.
const COIN = { cx: 50, cy: 50, r: 33 };
const TICK = [[35.5, 50.5], [45.5, 61], [64.5, 38.5]];   // polyline, pulled in from the rim
const TICK_W = 9;                                     // stroke weight

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function inTick(x, y) {
  for (let i = 1; i < TICK.length; i++) {
    const [x1, y1] = TICK[i - 1], [x2, y2] = TICK[i];
    if (distToSeg(x, y, x1, y1, x2, y2) <= TICK_W / 2) return true;
  }
  return false;
}
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Is (x,y) in ink? */
function inkAt(x, y) {
  if (!inCircle(x, y, COIN.cx, COIN.cy, COIN.r)) return false;
  return !inTick(x, y);          // the tick is punched through to the tile colour
}

/** Rounded-square mask for the lime tile itself. */
function inTile(px, py, size, r) {
  const rx = Math.min(Math.max(px, r), size - r);
  const ry = Math.min(Math.max(py, r), size - r);
  const dx = px - rx, dy = py - ry;
  return dx * dx + dy * dy <= r * r;
}

function rgba(size, { maskable = false, opaque = false } = {}) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 6;                       // 36 samples per pixel
  const inset = maskable ? 0.10 : 0;  // Android safe zone
  const off = inset * 100;
  const scale = 1 - inset * 2;
  const radius = opaque ? 0 : 23;     // corner radius in design units

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0, inkHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((px + (sx + 0.5) / SS) / size) * 100;
          const v = ((py + (sy + 0.5) / SS) / size) * 100;
          if (maskable || opaque) bgHits++;
          else if (inTile(u, v, 100, radius)) bgHits++;
          const ax = (u - off) / scale;
          const ay = (v - off) / scale;
          if (inkAt(ax, ay)) inkHits++;
        }
      }
      const n = SS * SS;
      const bgA = bgHits / n;
      const inkA = inkHits / n;
      const r = LIME[0] * (1 - inkA) + INK[0] * inkA;
      const g = LIME[1] * (1 - inkA) + INK[1] * inkA;
      const b = LIME[2] * (1 - inkA) + INK[2] * inkA;
      const i = (py * size + px) * 4;
      out[i] = Math.round(r);
      out[i + 1] = Math.round(g);
      out[i + 2] = Math.round(b);
      out[i + 3] = Math.round(bgA * 255);
    }
  }
  return out;
}

/* ---------- PNG ---------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, data) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    data.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const jobs = [
  ['icon-48.v2.png', 48, {}],
  ['icon-96.v2.png', 96, {}],
  ['icon-192.v2.png', 192, {}],
  ['icon-512.v2.png', 512, {}],
  ['icon-1024.v2.png', 1024, {}],
  ['icon-maskable-512.v2.png', 512, { maskable: true }],
  ['apple-touch-icon.v2.png', 180, { opaque: true }],
];

for (const [name, size, opts] of jobs) {
  writeFileSync(join(OUT, name), png(size, rgba(size, opts)));
  console.log('wrote', name, size + 'x' + size);
}
