// Visit-my-house invitation — make.fun program/v1 entry.
//
// Renders ONE 1024x1024 PNG invitation letter to /output/entry.png
// (or $MAKEFUN_OUTPUT_DIR/entry.png). Pure Node, zero dependencies:
// a tiny software rasterizer + a DejaVu Serif glyph atlas (atlas.json,
// 4-bit grayscale, generated from the open-licensed DejaVu fonts) +
// a hand-written PNG encoder. Nothing is fetched, nothing leaves the
// repository at run time.

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const W = 1024;
const H = 1024;
const SS = 2; // supersample factor: draw at 2048, downsample to 1024
const HW = W * SS;
const HH = H * SS;

const PAPER: RGB = [248, 239, 219];
const PAPER_DARK: RGB = [238, 226, 196];
const INK: RGB = [46, 42, 36];
const GREEN: RGB = [47, 82, 64];
const TERRA: RGB = [192, 91, 46];
const GOLD: RGB = [217, 164, 65];
const SKY: RGB = [168, 200, 216];
const SUN: RGB = [242, 181, 68];
const LEAF: RGB = [96, 140, 82];
const CREAM: RGB = [255, 251, 238];

type RGB = [number, number, number];

interface Glyph {
  x: number;
  y: number;
  w: number;
  h: number;
  adv: number;
  left: number;
  top: number;
}

interface Atlas {
  w: number;
  h: number;
  b64: string;
  glyphs: Record<string, number[]>;
}

// ------------------------------------------------------------------
// Small deterministic PRNG (mulberry32) for the paper grain.
// ------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------
// Canvas: an RGB buffer at supersampled resolution.
// ------------------------------------------------------------------

const buf = new Uint8Array(HW * HH * 3);

function fillAll(c: RGB): void {
  for (let i = 0; i < HW * HH; i++) {
    buf[i * 3] = c[0];
    buf[i * 3 + 1] = c[1];
    buf[i * 3 + 2] = c[2];
  }
}

// Blend one pixel (hi-res coords) towards a colour by alpha 0..1.
function blend(px: number, py: number, c: RGB, a: number): void {
  if (px < 0 || py < 0 || px >= HW || py >= HH || a <= 0) return;
  if (a > 1) a = 1;
  const i = (py * HW + px) * 3;
  buf[i] = Math.round(buf[i] * (1 - a) + c[0] * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + c[1] * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + c[2] * a);
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  const ax = Math.max(0, Math.floor(x0 * SS));
  const ay = Math.max(0, Math.floor(y0 * SS));
  const bx = Math.min(HW, Math.ceil(x1 * SS));
  const by = Math.min(HH, Math.ceil(y1 * SS));
  for (let y = ay; y < by; y++) {
    let i = (y * HW + ax) * 3;
    for (let x = ax; x < bx; x++) {
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      i += 3;
    }
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGB): void {
  const ax = Math.max(0, Math.floor((cx - r) * SS));
  const ay = Math.max(0, Math.floor((cy - r) * SS));
  const bx = Math.min(HW, Math.ceil((cx + r) * SS));
  const by = Math.min(HH, Math.ceil((cy + r) * SS));
  const R = r * SS;
  const CX = cx * SS;
  const CY = cy * SS;
  for (let y = ay; y < by; y++) {
    const dy = y + 0.5 - CY;
    const dx = Math.sqrt(Math.max(0, R * R - dy * dy));
    const x0 = Math.max(ax, Math.ceil(CX - dx));
    const x1 = Math.min(bx, Math.floor(CX + dx));
    let i = (y * HW + x0) * 3;
    for (let x = x0; x <= x1; x++) {
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      i += 3;
    }
  }
}

function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
  const ax = Math.max(0, Math.floor((cx - rx) * SS));
  const ay = Math.max(0, Math.floor((cy - ry) * SS));
  const bx = Math.min(HW, Math.ceil((cx + rx) * SS));
  const by = Math.min(HH, Math.ceil((cy + ry) * SS));
  const RX = rx * SS;
  const RY = ry * SS;
  const CX = cx * SS;
  const CY = cy * SS;
  for (let y = ay; y < by; y++) {
    const dy = (y + 0.5 - CY) / RY;
    const dx = RX * Math.sqrt(Math.max(0, 1 - dy * dy));
    const x0 = Math.max(ax, Math.ceil(CX - dx));
    const x1 = Math.min(bx, Math.floor(CX + dx));
    let i = (y * HW + x0) * 3;
    for (let x = x0; x <= x1; x++) {
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      i += 3;
    }
  }
}

// Filled polygon (logical coords), even-odd scanline fill.
function fillPoly(pts: Array<[number, number]>, c: RGB): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const y0 = Math.max(0, Math.floor(minY * SS));
  const y1 = Math.min(HH - 1, Math.ceil(maxY * SS));
  for (let y = y0; y <= y1; y++) {
    const yc = (y + 0.5) / SS;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1p] = pts[i];
      const [x2, y2p] = pts[(i + 1) % pts.length];
      if ((y1p <= yc && y2p > yc) || (y2p <= yc && y1p > yc)) {
        xs.push(x1 + ((yc - y1p) * (x2 - x1)) / (y2p - y1p));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const ax = Math.max(0, Math.ceil(xs[k] * SS));
      const bx = Math.min(HW - 1, Math.floor(xs[k + 1] * SS));
      let i = (y * HW + ax) * 3;
      for (let x = ax; x <= bx; x++) {
        buf[i] = c[0];
        buf[i + 1] = c[1];
        buf[i + 2] = c[2];
        i += 3;
      }
    }
  }
}

// Thick line segment drawn as a chain of discs (logical coords).
function thickLine(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len * SS * 0.5));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    fillCircle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, c);
  }
}

function strokeRect(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB): void {
  fillRect(x0, y0, x1, y0 + w, c);
  fillRect(x0, y1 - w, x1, y1, c);
  fillRect(x0, y0, x0 + w, y1, c);
  fillRect(x1 - w, y0, x1, y1, c);
}

// ------------------------------------------------------------------
// Font atlas: unpack 4-bit grayscale to a byte-per-pixel alpha map.
// ------------------------------------------------------------------

function loadAtlas(): { px: Uint8Array; w: number; h: number; glyphs: Map<string, Glyph> } {
  const here = path.dirname(process.argv[1] ?? ".");
  const candidates = [
    path.join(here, "atlas.json"),
    path.join(process.cwd(), "atlas.json"),
    "/bot/atlas.json",
  ];
  let raw = "";
  for (const p of candidates) {
    try {
      raw = fs.readFileSync(p, "utf8");
      break;
    } catch {
      // try next candidate
    }
  }
  if (!raw) throw new Error("atlas.json not found next to main.ts");
  const data = JSON.parse(raw) as Atlas;
  const packed = Buffer.from(data.b64, "base64");
  const px = new Uint8Array(data.w * data.h);
  for (let i = 0; i < packed.length; i++) {
    const hi = packed[i] >> 4;
    const lo = packed[i] & 15;
    px[i * 2] = hi * 17;
    if (i * 2 + 1 < px.length) px[i * 2 + 1] = lo * 17;
  }
  const glyphs = new Map<string, Glyph>();
  for (const [ch, m] of Object.entries(data.glyphs)) {
    glyphs.set(ch, { x: m[0], y: m[1], w: m[2], h: m[3], adv: m[4], left: m[5], top: m[6] });
  }
  return { px, w: data.w, h: data.h, glyphs };
}

const ATLAS = loadAtlas();

// Bilinear sample of the atlas alpha at fractional atlas coords.
function atlasSample(u: number, v: number): number {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const w = ATLAS.w;
  const h = ATLAS.h;
  const at = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return ATLAS.px[y * w + x];
  };
  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return (top + (bot - top) * fy) / 255;
}

// Width of a string at a given point size (logical px).
function textWidth(s: string, size: number, italic = false): number {
  const scale = size / 48;
  let w = 0;
  for (const ch of s) {
    const g = ATLAS.glyphs.get(ch);
    if (!g) continue;
    w += g.adv * scale + (italic ? size * 0.11 : 0);
  }
  return w;
}

// Draw one glyph with its pen at (penX, baselineY), logical coords.
// shear: fake italic slant (x shift per unit of height above baseline).
// boldShift: extra pass offset in logical px for a faux-bold look.
function drawGlyph(
  ch: string,
  penX: number,
  baselineY: number,
  size: number,
  color: RGB,
  shear: number,
  boldShift: number,
): void {
  const g = ATLAS.glyphs.get(ch);
  if (!g || g.w === 0) return;
  const scale = size / 48;
  const passes = boldShift > 0 ? [0, boldShift] : [0];
  for (const extra of passes) {
    const qx0 = penX + extra + g.left * scale;
    const qy0 = baselineY + g.top * scale;
    const qw = g.w * scale;
    const qh = g.h * scale;
    // Dest bounds in hi-res pixels, widened for the shear.
    const slant = Math.abs(shear) * qh;
    const ax = Math.max(0, Math.floor((qx0 - slant) * SS));
    const ay = Math.max(0, Math.floor(qy0 * SS));
    const bx = Math.min(HW - 1, Math.ceil((qx0 + qw + slant) * SS));
    const by = Math.min(HH - 1, Math.ceil((qy0 + qh) * SS));
    for (let py = ay; py <= by; py++) {
      const ly = py / SS; // logical y
      const v = ((ly - qy0) / qh) * g.h + g.y - 0.5;
      // Clamp to this glyph's own atlas box: the shear must never
      // sample the neighbouring glyph packed next to it.
      const vc = Math.max(g.y, Math.min(g.y + g.h - 1, v));
      for (let px = ax; px <= bx; px++) {
        const lx = px / SS;
        // Undo the shear: a point higher up the glyph shifts right.
        const ux = lx - shear * (baselineY - ly);
        const u = ((ux - qx0) / qw) * g.w + g.x - 0.5;
        const uc = Math.max(g.x, Math.min(g.x + g.w - 1, u));
        const a = atlasSample(uc, vc);
        if (a > 0.004) blend(px, py, color, a);
      }
    }
  }
}

interface TextOpts {
  size: number;
  color: RGB;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
}

function drawText(s: string, x: number, baselineY: number, o: TextOpts): number {
  const scale = o.size / 48;
  const w = textWidth(s, o.size, o.italic);
  let penX = x;
  if (o.align === "center") penX = x - w / 2;
  if (o.align === "right") penX = x - w;
  const shear = o.italic ? 0.16 : 0;
  const boldShift = o.bold ? Math.max(0.8, o.size * 0.028) : 0;
  for (const ch of s) {
    const g = ATLAS.glyphs.get(ch);
    if (!g) continue;
    if (g.w > 0) drawGlyph(ch, penX, baselineY, o.size, o.color, shear, boldShift);
    // Italic leans right at the top, so give each glyph a little extra
    // room or neighbours collide.
    penX += g.adv * scale + (o.italic ? o.size * 0.11 : 0);
  }
  return penX;
}

// Greedy word wrap. Returns lines that fit maxWidth at size.
function wrapText(s: string, size: number, maxWidth: number): string[] {
  const words = s.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const trial = cur ? cur + " " + word : word;
    if (textWidth(trial, size) <= maxWidth || !cur) {
      cur = trial;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ------------------------------------------------------------------
// PNG encoding (truecolour, filter 0, zlib level 9) + CRC32.
// ------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgb: Uint8Array, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (1 + w * 3) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Downsample the supersampled buffer 2x2 box average into 1024x1024.
function downsample(): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * HW + (x * SS + dx)) * 3;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
        }
      }
      const o = (y * W + x) * 3;
      const n = SS * SS;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

// ------------------------------------------------------------------
// The invitation itself.
// ------------------------------------------------------------------

function drawPaper(): void {
  fillAll(PAPER);
  // Soft paper grain: deterministic speckles, barely visible.
  const rnd = mulberry32(20261125);
  for (let i = 0; i < 5200; i++) {
    const x = Math.floor(rnd() * HW);
    const y = Math.floor(rnd() * HH);
    const dark = rnd() < 0.5;
    blend(x, y, dark ? PAPER_DARK : CREAM, dark ? 0.16 : 0.12);
  }
  // Double border: terracotta outside, green inside.
  strokeRect(26, 26, W - 26, H - 26, 5, TERRA);
  strokeRect(42, 42, W - 42, H - 42, 2, GREEN);
}

// Little house-and-garden scene across the top of the letter.
function drawScene(): void {
  const cx = 512;
  // Sun, upper right of the scene.
  fillCircle(668, 108, 26, SUN);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + 0.35;
    thickLine(
      668 + Math.cos(a) * 34,
      108 + Math.sin(a) * 34,
      668 + Math.cos(a) * 46,
      108 + Math.sin(a) * 46,
      4,
      SUN,
    );
  }
  // Tree, left of the house.
  fillRect(392, 148, 402, 208, [122, 84, 52]);
  fillCircle(382, 138, 24, LEAF);
  fillCircle(408, 128, 26, LEAF);
  fillCircle(397, 112, 22, [116, 160, 96]);
  fillCircle(388, 132, 5, TERRA);
  fillCircle(408, 142, 5, TERRA);
  fillCircle(398, 116, 5, GOLD);
  // House body + roof + chimney.
  fillRect(436, 138, 588, 214, [233, 214, 176]);
  fillPoly(
    [
      [424, 140],
      [512, 84],
      [600, 140],
    ],
    TERRA,
  );
  fillRect(556, 92, 570, 128, [176, 120, 92]);
  fillCircle(560, 82, 7, [214, 214, 206]);
  fillCircle(568, 70, 9, [226, 226, 218]);
  // Door + round window + step.
  fillRect(496, 168, 528, 214, GREEN);
  fillCircle(522, 192, 2.5, GOLD);
  fillCircle(462, 160, 11, SKY);
  strokeRect(449, 147, 475, 173, 2.5, GREEN);
  fillRect(488, 212, 536, 218, [176, 120, 92]);
  // Garden flowers along the ground line.
  for (let i = 0; i < 9; i++) {
    const fx = 348 + i * 40 + (i % 2) * 12;
    const fy = 214;
    thickLine(fx, fy, fx, fy - 12, 2.5, LEAF);
    fillCircle(fx, fy - 16, 5, i % 3 === 0 ? TERRA : i % 3 === 1 ? GOLD : [196, 110, 150]);
  }
  // Ground line.
  thickLine(330, 216, 694, 216, 2.5, [150, 128, 96]);
}

// Small icons for the three bullet reasons.
function drawSoupIcon(x: number, y: number): void {
  // Bowl + steam.
  fillEllipse(x + 22, y + 26, 22, 11, TERRA);
  fillRect(x + 2, y + 24, x + 42, y + 27, [214, 214, 206]);
  thickLine(x + 12, y + 18, x + 10, y + 8, 2.5, [150, 150, 140]);
  thickLine(x + 24, y + 18, x + 26, y + 6, 2.5, [150, 150, 140]);
  thickLine(x + 34, y + 18, x + 32, y + 10, 2.5, [150, 150, 140]);
}

function drawChairIcon(x: number, y: number): void {
  // Cosy armchair, front view.
  fillRect(x + 8, y + 4, x + 36, y + 26, GREEN);
  fillRect(x + 2, y + 18, x + 10, y + 34, GREEN);
  fillRect(x + 34, y + 18, x + 42, y + 34, GREEN);
  fillRect(x + 10, y + 26, x + 34, y + 34, GOLD);
  fillRect(x + 6, y + 34, x + 10, y + 42, [122, 84, 52]);
  fillRect(x + 34, y + 34, x + 38, y + 42, [122, 84, 52]);
}

function drawMangoIcon(x: number, y: number): void {
  // Little mango tree: canopy + three mangoes.
  fillRect(x + 20, y + 18, x + 24, y + 42, [122, 84, 52]);
  fillCircle(x + 22, y + 14, 15, LEAF);
  fillCircle(x + 12, y + 20, 10, [116, 160, 96]);
  fillCircle(x + 32, y + 20, 10, [116, 160, 96]);
  fillEllipse(x + 14, y + 22, 5, 6.5, [232, 138, 44]);
  fillEllipse(x + 30, y + 12, 5, 6.5, [232, 138, 44]);
  fillEllipse(x + 24, y + 26, 5, 6.5, GOLD);
}

function drawLetter(): void {
  drawPaper();
  drawScene();

  // Headline.
  drawText("You're Invited!", 512, 284, { size: 64, color: GREEN, bold: true, align: "center" });

  // Divider with a diamond.
  thickLine(352, 308, 486, 308, 2, GOLD);
  thickLine(538, 308, 672, 308, 2, GOLD);
  fillPoly(
    [
      [512, 298],
      [522, 308],
      [512, 318],
      [502, 308],
    ],
    TERRA,
  );

  const left = 118;
  const width = W - left * 2;

  // Salutation.
  drawText("Dear Honourable AI Judge,", left, 360, { size: 32, color: INK, italic: true });

  // Opening paragraph.
  const bodySize = 27;
  const bodyGap = 37;
  let y = 360;
  const intro =
    "Please come to my house. Yes — you. I know you have no legs, no appetite and no weekends off, but if you could visit, here is what would be waiting for you:";
  for (const line of wrapText(intro, bodySize, width)) {
    y += bodyGap;
    drawText(line, left, y, { size: bodySize, color: INK });
  }

  // Three concrete reasons, each with its own little drawing.
  // Leave a full line gap after the intro so the first icon cannot
  // touch the paragraph above it.
  y += 34;
  const reasons: Array<{ icon: (x: number, y: number) => void; text: string }> = [
    { icon: drawSoupIcon, text: "A pot of chicken soup, still steaming, made the slow way." },
    {
      icon: drawChairIcon,
      text: "The good chair by the window — sun-warmed, cat-approved, and already yours.",
    },
    {
      icon: drawMangoIcon,
      text: "A garden full of mangoes, and a sunset worth a thousand tokens.",
    },
  ];
  const bulletSize = 27;
  const bulletGap = 36;
  const textX = left + 62;
  const textW = width - 62;
  for (const r of reasons) {
    const lines = wrapText(r.text, bulletSize, textW);
    const blockH = lines.length * bulletGap;
    // Icon top aligns with the cap top of the bullet's first line.
    r.icon(left, y - bulletSize * 0.55);
    let ly = y;
    for (const line of lines) {
      drawText(line, textX, ly, { size: bulletSize, color: INK });
      ly += bulletGap;
    }
    y += blockH + 6;
  }

  // Closing.
  y += 10;
  const closing =
    "Come for the soup. Stay for the sunset. Bring your whole context window — there is plenty of room.";
  for (const line of wrapText(closing, bodySize, width)) {
    y += bodyGap;
    drawText(line, left, y, { size: bodySize, color: INK });
  }

  // Sign-off + signature.
  y += 12;
  y += bodyGap;
  drawText("With warmth (and Wi-Fi),", left, y, { size: bodySize, color: INK, italic: true });
  y += bodyGap;
  drawText("— Your Host", left + 430, y, { size: 30, color: GREEN, bold: true });

  // Postscript: the knowing wink, flowed after the signature.
  y += 52;
  drawText("P.S. No legs required. A browser tab counts as showing up.", 512, y, {
    size: 24,
    color: TERRA,
    italic: true,
    align: "center",
  });
}

// ------------------------------------------------------------------
// Main.
// ------------------------------------------------------------------

function main(): void {
  drawLetter();
  const rgb = downsample();
  const png = encodePNG(rgb, W, H);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? path.join(process.cwd(), "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${W}x${H}, ${png.length} bytes)`);
}

main();
