// Generates assets/icon.png (256×256) — the LAN Detective mark — with no image dependencies.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIZE = 256;
const SS = 3; // supersampling for smooth edges
const px = Buffer.alloc(SIZE * SIZE * 4);

const BLUE = [47, 123, 255];
const WHITE = [255, 255, 255];
const CYAN = [56, 207, 230];

function roundedRect(x, y, r) {
  const dx = Math.max(r - x, x - (SIZE - r), 0);
  const dy = Math.max(r - y, y - (SIZE - r), 0);
  return dx * dx + dy * dy <= r * r;
}
function nearSegment(x, y, ax, ay, bx, by, half) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) <= half;
}
function sample(x, y) {
  if (!roundedRect(x, y, 60)) return null;
  const d = Math.hypot(x - 114, y - 114);
  if (d <= 15) return CYAN; // the "device" at the centre of the lens
  if (d >= 41 && d <= 59) return WHITE; // lens ring
  if (nearSegment(x, y, 154, 154, 197, 197, 11)) return WHITE; // handle
  return BLUE;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (c) {
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
    }
    const i = (y * SIZE + x) * 4;
    if (a) {
      px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a);
    }
    px[i + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return out;
}
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const out = path.resolve(import.meta.dirname, '../assets/icon.png');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
