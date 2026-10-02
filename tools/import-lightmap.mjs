import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePngRgb, encodeSrgb, decodeSrgb } from './png.mjs';
import { buildCoverageMask, denoiseBilateral } from './denoise-atlas.mjs';

/**
 * Stage 3 of the Blender bake: turn Blender's output into what the app loads.
 *
 *   node tools/import-lightmap.mjs
 *
 * Emits three files:
 *
 *   public/lightmap.png      8-bit sRGB RGB — the atlas, as a normal image
 *   public/lightmap.json     metadata: peak, size, and the per-mesh face table
 *   public/lightmap-uv.bin   raw float32 UVs, two per face corner
 *
 * ## Why three files
 *
 * The image is an image, so it is a PNG: viewable, natively decoded by every
 * browser, and trivially cache-busted by name. That replaces an opaque binary
 * container that could not be looked at.
 *
 * The UVs cannot be an image — they are per-face-corner coordinates, not pixels,
 * and no bitmap format represents them. They stay raw `float32` because that is
 * the honest type for the data, and at ~60 KB per 10k triangles they are small
 * enough that compressing them would cost more in code than it saves in bytes.
 * The face table rides along in the JSON, since it is a handful of integers.
 *
 * ## Precision
 *
 * 8-bit, gamma-encoded, not float. The concern with 8 bits is banding in the dim
 * regions, and the sRGB transfer function is what addresses it — the linear
 * segment near zero keeps deep shadow detail that a plain gamma curve would
 * quantise away. This script measures the round-trip error and reports it, so
 * the claim is checked rather than asserted.
 *
 * ## Units
 *
 * Blender baked with `use_pass_color = False`, so this is irradiance with the
 * albedo divided out — exactly what three.js's `lightMap` expects, since it
 * multiplies by `BRDF_Lambert( diffuseColor )` at shade time.
 *
 * The light intensities were converted on the Blender side (x 4*pi) so these
 * values are in the same units as three.js's own lights, which is what lets the
 * sims — lit from the probe volume, using three.js maths — sit consistently
 * beside atlas-lit surfaces.
 *
 * Values are normalised by the atlas peak, which is stored in the JSON and
 * multiplied back through `lightMapIntensity`. That way the texture always spans
 * its full 8-bit range whatever the scene's absolute brightness.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BAKE = path.resolve(ROOT, 'bake');
const PUBLIC = path.resolve(ROOT, 'public');

const OUT_PNG = path.join(PUBLIC, 'lightmap.png');
const OUT_JSON = path.join(PUBLIC, 'lightmap.json');
const OUT_UV = path.join(PUBLIC, 'lightmap-uv.bin');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

/**
 * Bilateral denoise radius, in texels. 0 disables it.
 *
 * Needed because Blender's denoiser does not run on bakes (see
 * `denoise-atlas.mjs`), so this is the only place the grain can be removed.
 */
const DENOISE_RADIUS = args.denoise !== undefined ? Number(args.denoise) : 3;
const DENOISE_PASSES = args['denoise-passes'] !== undefined ? Number(args['denoise-passes']) : 1;

/* ── Inputs ───────────────────────────────────────────────────── */

const indexPath = path.join(BAKE, 'uv-index.json');
const pixelsPath = path.join(BAKE, 'bake-pixels.f32');
const uvPath = path.join(BAKE, 'uv.f32');
const manifestPath = path.join(BAKE, 'manifest.json');

for (const p of [indexPath, pixelsPath, uvPath, manifestPath]) {
  if (!fs.existsSync(p)) {
    console.error(`✗ missing ${path.relative(ROOT, p).replace(/\\/g, '/')}`);
    console.error('  run: npm run bake:blender   (it produces these)');
    process.exit(1);
  }
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (index.format !== 'jjjs-uv') throw new Error(`unexpected uv format ${index.format}`);
if (manifest.format !== 'jjjs-manifest') {
  throw new Error(`unexpected manifest format ${manifest.format}`);
}

const atlasSize = index.atlasSize;
const triangles = index.triangles;

/* ── Verify the inputs agree before combining them ─────────────── */

if (manifest.totalTriangles !== triangles) {
  throw new Error(
    `triangle count disagrees: manifest says ${manifest.totalTriangles}, ` +
      `bake says ${triangles}. The GLB and the bake are from different exports.`
  );
}

const ranges = manifest.ranges;
const rangedTriangles = ranges.reduce((n, r) => n + r.triangles, 0);
if (rangedTriangles !== triangles) {
  throw new Error(
    `per-mesh ranges cover ${rangedTriangles} triangles but the bake has ${triangles}`
  );
}

const pixels = new Float32Array(
  fs.readFileSync(pixelsPath).buffer,
  0,
  atlasSize * atlasSize * 4
);

const uvBytes = fs.readFileSync(uvPath);
const uv = new Float32Array(uvBytes.buffer, uvBytes.byteOffset, uvBytes.byteLength / 4);

if (uv.length !== triangles * 6) {
  throw new Error(
    `uv array holds ${uv.length} floats, expected ${triangles * 6} ` +
      `(${triangles} triangles x 3 corners x 2)`
  );
}

let uvMin = Infinity;
let uvMax = -Infinity;
let outside = 0;
for (let i = 0; i < uv.length; i++) {
  const v = uv[i];
  if (v < uvMin) uvMin = v;
  if (v > uvMax) uvMax = v;
  if (v < -0.001 || v > 1.001) outside++;
}
if (outside > 0) {
  console.warn(`  ! ${outside} UV values fall outside 0..1 and would wrap or clamp`);
}

/* ── Denoise ──────────────────────────────────────────────────── */

let denoiseStats = null;
let finalPixels = pixels;

if (DENOISE_RADIUS > 0) {
  // The mask comes from the UVs, because the atlas itself cannot distinguish an
  // unlit texel from an empty one.
  const mask = buildCoverageMask(uv, triangles, atlasSize);
  let covered = 0;
  for (let i = 0; i < mask.length; i++) covered += mask[i];

  const result = denoiseBilateral(pixels, mask, atlasSize, {
    radius: DENOISE_RADIUS,
    passes: DENOISE_PASSES,
  });

  finalPixels = result.data;
  denoiseStats = { ...result.stats, covered };
}

/* ── Find the peak, to normalise against ──────────────────────── */

let peak = 0;
let litTexels = 0;
let nanCount = 0;

for (let i = 0; i < atlasSize * atlasSize; i++) {
  const r = finalPixels[i * 4];
  const g = finalPixels[i * 4 + 1];
  const b = finalPixels[i * 4 + 2];

  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    nanCount++;
    continue;
  }

  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum > peak) peak = lum;
  if (lum > 1e-4) litTexels++;
}

if (!(peak > 0)) {
  throw new Error('atlas is entirely black — the bake or the denoiser produced nothing');
}
if (nanCount > 0) {
  console.warn(`  ! ${nanCount} texels were not finite; written as black`);
}

/* ── Reserve a black texel for the unbaked meshes ─────────────── */

/**
 * The runtime gives every mesh *outside* the bake a `uv1` pointing here, so it
 * samples black and receives no baked light. Materials are shared between the
 * house and the yard, so the exclusion has to happen on the geometry rather
 * than by not setting `material.lightMap`.
 *
 * Nothing in the Blender pipeline reserves this location — the packer is simply
 * unlikely to have put an island 4 texels into the very corner of a 22%-full
 * atlas. "Unlikely" is not a guarantee, and the failure mode is silent: the
 * fence would pick up whichever wall happened to occupy the corner. So the
 * corner is cleared here, which makes the assumption true by construction, and
 * the coordinate is published in the metadata so the runtime is not carrying a
 * second copy of it.
 */
const BLACK_UV = [0.002, 0.002];
const blackX = Math.floor(BLACK_UV[0] * atlasSize);
const blackY = Math.floor(BLACK_UV[1] * atlasSize);

// Clear the 2x2 block bilinear filtering can reach from that coordinate, plus
// one texel of slack for the rounding above.
for (let dy = -1; dy <= 1; dy++) {
  for (let dx = -1; dx <= 1; dx++) {
    const x = blackX + dx;
    const y = blackY + dy;
    if (x < 0 || y < 0 || x >= atlasSize || y >= atlasSize) continue;
    // `finalPixels` is Blender's order: row 0 is the bottom, which is V=0.
    const i = (y * atlasSize + x) * 4;
    finalPixels[i] = 0;
    finalPixels[i + 1] = 0;
    finalPixels[i + 2] = 0;
  }
}

/* ── Encode to 8-bit sRGB, rows reversed ──────────────────────── */

/**
 * Blender's pixel buffer starts at the bottom-left; a PNG's first scanline is
 * the top. three.js flips image uploads by default (`flipY = true`), so the
 * texture's V=0 ends up at the image's *bottom* row — which is where Blender's
 * V=0 is. Reversing the rows here is therefore what makes the two agree.
 *
 * Writing them in the other order would mirror every chart vertically. That is
 * a silent failure: the lighting still looks plausible, just attached to the
 * wrong half of each surface.
 */
const rgb = new Uint8Array(atlasSize * atlasSize * 3);
const inversePeak = 1 / peak;

/**
 * Quantisation is measured two ways, because one number cannot say whether 8
 * bits is enough.
 *
 * A *mean relative* error over every lit texel is dominated by the darkest
 * ones, where any fixed encoding is coarse — 8 bits cannot resolve 1% of a
 * value that is 0.1% of the peak, and no format short of 16-bit will. That
 * number is therefore alarming without being informative.
 *
 * The one that decides it is the relative error over texels contributing
 * meaningfully to the image, which is what `BRIGHT` gates. Pair it with the
 * absolute step below: if the step is below the bake's own noise level,
 * quantisation is not what limits the picture.
 */
const BRIGHT = peak * 0.01;
let quantError = 0;
let quantCount = 0;
let brightError = 0;
let brightCount = 0;

for (let y = 0; y < atlasSize; y++) {
  const srcRow = atlasSize - 1 - y;
  for (let x = 0; x < atlasSize; x++) {
    const src = (srcRow * atlasSize + x) * 4;
    const dst = (y * atlasSize + x) * 3;

    for (let c = 0; c < 3; c++) {
      const linear = finalPixels[src + c];
      const value = Number.isFinite(linear) ? Math.max(linear, 0) * inversePeak : 0;
      const byte = encodeSrgb(value);
      rgb[dst + c] = byte;

      // Track the round trip so the precision claim can be checked.
      const restored = decodeSrgb(byte) * peak;
      const truth = Number.isFinite(linear) ? Math.max(linear, 0) : 0;
      if (truth > 1e-4) {
        quantError += Math.abs(restored - truth) / truth;
        quantCount++;
      }
      if (truth > BRIGHT) {
        brightError += Math.abs(restored - truth) / truth;
        brightCount++;
      }
    }
  }
}

const png = encodePngRgb(rgb, atlasSize, atlasSize);
fs.mkdirSync(PUBLIC, { recursive: true });
fs.writeFileSync(OUT_PNG, png);

/* ── UVs and metadata ─────────────────────────────────────────── */

fs.writeFileSync(OUT_UV, Buffer.from(uv.buffer, uv.byteOffset, uv.byteLength));

const meta = {
  format: 'jjjs-lightmap',
  version: 3,
  atlasSize,
  margin: index.margin ?? 0,
  texelsPerMetre: index.packing.texels_mean,
  triangles,
  /** Multiplied back into the decoded, gamma-inverted texel to recover radiance. */
  peak,
  /** `uv1` for meshes outside the bake: cleared above, so it samples true black. */
  blackUv: BLACK_UV,
  uvFile: 'lightmap-uv.bin',
  /** Per mesh: [triangleOffset, triangleCount], in `collectLightmapMeshes` order. */
  meshes: ranges.map((r) => [r.triangleOffset, r.triangles]),
};

fs.writeFileSync(OUT_JSON, JSON.stringify(meta));

/* ── Report ───────────────────────────────────────────────────── */

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const texels = atlasSize * atlasSize;

console.log('▲ import lightmap');
console.log(`  atlas       ${atlasSize} x ${atlasSize} (${texels} texels)`);
console.log(`  triangles   ${triangles} across ${ranges.length} meshes`);
console.log(`  density     ${index.packing.texels_mean.toFixed(1)} texels/m`);
console.log(
  `  uv range    ${uvMin.toFixed(4)} .. ${uvMax.toFixed(4)}` +
    (outside ? `  (${outside} outside 0..1)` : '')
);
console.log(
  `  radiance    ${litTexels} lit texels (${((litTexels / texels) * 100).toFixed(1)}%), ` +
    `peak ${peak.toFixed(2)}`
);

if (denoiseStats) {
  console.log(
    `  denoise     bilateral r=${denoiseStats.radius} x${denoiseStats.passes}, ` +
      `${denoiseStats.covered} covered texels`
  );
  console.log(
    `  noise       ${denoiseStats.noiseBefore.toFixed(5)} -> ` +
      `${denoiseStats.noiseAfter.toFixed(5)} ` +
      `(${(denoiseStats.reduction * 100).toFixed(1)}% removed)`
  );
  console.log(
    `  edges       ${(denoiseStats.edgeRetention * 100).toFixed(1)}% of strong-edge ` +
      `gradient retained`
  );
} else {
  console.log('  denoise     disabled');
}

if (quantCount > 0) {
  // The sRGB curve is linear below 0.04045, so one byte step is worth
  // 1/(255 * 12.92) of the normalised value. That is the smallest change the
  // format can represent in radiance, and it is the number to compare against
  // the bake's own residual noise: if noise is larger, the grain on screen is
  // Cycles', not the encoding's.
  const step = peak / (255 * 12.92);
  const noise = denoiseStats?.noiseAfter ?? null;

  console.log(
    `  8-bit error ${((brightError / Math.max(brightCount, 1)) * 100).toFixed(1)}% mean relative ` +
      `over texels above ${BRIGHT.toFixed(2)} radiance (1% of peak), ` +
      `${((quantError / quantCount) * 100).toFixed(1)}% over everything lit`
  );
  console.log(
    `  quant step  ${step.toExponential(2)} radiance` +
      (noise !== null
        ? `, ${(step / noise).toFixed(2)}x the bake noise (${noise.toFixed(5)} rounded)`
        : '')
  );

  if (noise !== null && step > noise) {
    console.log('  ! quantisation exceeds the bake noise — banding will be the visible limit');
  }
}

console.log(`  wrote       ${rel(OUT_PNG)} (${(png.byteLength / 1024).toFixed(0)} KB)`);
console.log(`  wrote       ${rel(OUT_JSON)} (${(JSON.stringify(meta).length / 1024).toFixed(1)} KB)`);
console.log(`  wrote       ${rel(OUT_UV)} (${(uvBytes.byteLength / 1024).toFixed(0)} KB)`);
