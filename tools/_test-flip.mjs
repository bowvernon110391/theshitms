// Throwaway: verify the V-flip end to end, by asking the PNG itself.
//
// Every triangle's UV centroid must land on a texel the bake actually wrote,
// and canvases/attribute reads must agree with where the GPU would sample.
// Testing "does it look right" is not decisive on an atlas this dense, so this
// decodes public/lightmap.png and measures.
//
// The PNG was written with filter type 0 on every scanline, so decoding is
// inflate + strip one byte per row — no unfiltering needed.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { buildCoverageMask } from './denoise-atlas.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const size = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/lightmap.json'), 'utf8')).atlasSize;

/* ── Decode the PNG back to bytes ─────────────────────────────── */

const png = fs.readFileSync(path.join(ROOT, 'public/lightmap.png'));
let off = 8;
const idat = [];
while (off < png.length) {
  const len = png.readUInt32BE(off);
  const type = png.toString('latin1', off + 4, off + 8);
  if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
  off += 12 + len;
}

const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = 1 + size * 3;
const px = new Uint8Array(size * size * 3);
for (let y = 0; y < size; y++) {
  if (raw[y * stride] !== 0) throw new Error(`row ${y} filter ${raw[y * stride]}`);
  for (let x = 0; x < size * 3; x++) px[y * size * 3 + x] = raw[y * stride + 1 + x];
}

/* ── Load the UVs ─────────────────────────────────────────────── */

const uvBytes = fs.readFileSync(path.join(ROOT, 'public/lightmap-uv.bin'));
const uv = new Float32Array(uvBytes.buffer, uvBytes.byteOffset, uvBytes.byteLength / 4);
const triangles = uv.length / 6;

/** Luminance of the PNG byte at a texel, top-row-first. */
function lumAt(x, y) {
  if (x < 0 || y < 0 || x >= size || y >= size) return -1;
  const i = (y * size + x) * 3;
  return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
}

/**
 * Compare the islands the UVs *claim* to the region the bake actually *filled*.
 *
 * The decisive measurement is contrast, not brightness. If the convention is
 * right, the mask lands on the islands — which are the only place Cycles wrote
 * anything — so the masked mean is far above the unmasked one, because the
 * unmasked side is empty atlas. If the convention is wrong, the mask lands on
 * the wrong half of the image and, since islands are dense, the masked mean
 * collapses towards the unmasked one.
 *
 * Averaging over every texel is what gives this power. The earlier attempts
 * sampled inside individual triangles, where the atlas varies at texel scale
 * and a handful of samples is a coin flip however they are mapped.
 */
function contrast(label, uvForMask) {
  const mask = buildCoverageMask(uvForMask, triangles, size);

  let inSum = 0;
  let inCount = 0;
  let outSum = 0;
  let outCount = 0;

  for (let i = 0; i < size * size; i++) {
    const l = 0.2126 * px[i * 3] + 0.7152 * px[i * 3 + 1] + 0.0722 * px[i * 3 + 2];
    if (mask[i]) {
      inSum += l;
      inCount++;
    } else {
      outSum += l;
      outCount++;
    }
  }

  const inside = inSum / inCount;
  const outside = outSum / outCount;
  console.log(
    `  ${label.padEnd(34)} inside ${inside.toFixed(1)}  outside ${outside.toFixed(1)}  ` +
      `ratio ${(inside / outside).toFixed(2)}x  (${((inCount / (size * size)) * 100).toFixed(1)}% of atlas)`
  );
  return inside / outside;
}

console.log(`atlas ${size}px, ${triangles} triangles\n`);
console.log('  UV islands masked against the pixels Cycles actually wrote:');

const flipped = new Float32Array(uv.length);
for (let i = 0; i < uv.length; i += 2) {
  flipped[i] = uv[i];
  flipped[i + 1] = 1 - uv[i + 1];
}

const ratioBottom = contrast('v as-is (row = v*size)', uv);
const ratioTop = contrast('v flipped (row = (1-v)*size)', flipped);

console.log('');
if (ratioBottom > ratioTop) {
  console.log(`  -> islands live at row = v*size  (${ratioBottom.toFixed(2)}x vs ${ratioTop.toFixed(2)}x)`);
  console.log('     three.js flipY would then sample mirrored — the PNG rows need swapping.');
} else {
  console.log(`  -> islands live at row = (1-v)*size  (${ratioTop.toFixed(2)}x vs ${ratioBottom.toFixed(2)}x)`);
  console.log('     which is what three.js flipY=true gives for the rows as written. Agreement.');
}
