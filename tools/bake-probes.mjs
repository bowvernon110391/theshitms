/**
 * Bakes the probe volume that lights the sims.
 *
 *   npm run bake:dynamic
 *
 *     node tools/bake-probes.mjs [--samples=N] [--spacing=N] [--out=PATH]
 *
 * Static geometry is **not** baked here — Blender does that (see
 * `tools/blender-bake.py`), with Cycles, real GI and denoising. This script
 * exists only for the moving characters, which a texture cannot light: a
 * lightmap is indexed by UVs and a character's UVs travel with it, whereas a
 * probe grid is indexed by world position.
 *
 * The scene comes from the same `src/world.js` the browser uses, so both bakes
 * agree with the runtime about geometry and both place themselves against the
 * same lamp data.
 *
 * Flags:
 *   --samples=N   hemisphere samples per probe (default 96)
 *   --spacing=N   probe spacing in metres (default from PROBE_COUNT)
 *   --out=PATH    output file (default public/lightmap.bin)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWorld, flattenForBake } from '../src/world.js';
import { encodeProbeVolume, PROBE_BOUNDS, PROBE_COUNT } from '../src/lightprobe.js';
import { Tracer, bakeProbes, fillBuriedProbes, prepareLamps } from './bake-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const SAMPLES = args.samples !== undefined ? Number(args.samples) : 96;
const OUT = path.resolve(ROOT, String(args.out ?? 'public/lightmap.bin'));

function gridFor(bounds) {
  const counts = PROBE_COUNT.slice();
  if (args.spacing) {
    const spacing = Number(args.spacing);
    for (let i = 0; i < 3; i++) {
      const span = bounds.max[i] - bounds.min[i];
      counts[i] = Math.max(2, Math.round(span / spacing) + 1);
    }
  }
  return counts;
}

const t0 = Date.now();
console.log('▲ probe bake (dynamic objects)');

const world = buildWorld({ sims: false, labels: false });

// `staticRoots` rather than a hand-written list: `house.group` already contains
// the furniture, and naming both would walk every furniture mesh twice — which
// silently doubled the geometry this scene reported until it was measured.
const { positions, normals, albedos, triangleCount } = flattenForBake(world.staticRoots);

console.log(`  geometry    ${triangleCount} triangles`);

// Only the interior lamps are baked. The lamp post stays real-time: it is
// outdoors and its spill onto the lawn wants to be smooth.
const lights = world.interiorLightSpecs;
console.log(`  lights      ${lights.length} interior lamps`);

const tracer = new Tracer({ positions, normals, albedos });
const lamps = prepareLamps(lights);

const count = gridFor(PROBE_BOUNDS);
const total = count[0] * count[1] * count[2];
console.log(`  probes      ${count.join(' x ')} = ${total}`);

let last = -1;
const volume = bakeProbes({
  tracer,
  lights,
  bounds: PROBE_BOUNDS,
  count,
  samples: SAMPLES,
  onProgress(done, all) {
    const pct = Math.round((done / all) * 100);
    if (pct !== last) {
      last = pct;
      process.stdout.write(`\r  baking      ${String(pct).padStart(3)}%`);
    }
  },
});
process.stdout.write('\r  baking      100%\n');

const repair = fillBuriedProbes({ tracer, bounds: PROBE_BOUNDS, count, coeffs: volume.coeffs });
volume.flags = repair.flags;
console.log(`  repair      ${repair.buriedCount} buried probes found, ${repair.filled} filled`);

let maxValue = 0;
let nonZero = 0;
for (let i = 0; i < volume.coeffs.length; i++) {
  const v = volume.coeffs[i];
  if (v !== 0) nonZero++;
  if (v > maxValue) maxValue = v;
}

console.log(
  `  energy      ${((nonZero / volume.coeffs.length) * 100).toFixed(1)}% non-zero, peak ${maxValue.toFixed(2)}`
);

if (maxValue <= 0) {
  console.error('\n✗ probe bake produced no light at all');
  process.exit(1);
}

const buffer = encodeProbeVolume(volume);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(buffer));

console.log(
  `  wrote       ${path.relative(ROOT, OUT).replace(/\\/g, '/')} (${(buffer.byteLength / 1024).toFixed(0)} KB)`
);
console.log(`✓ probe bake finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
