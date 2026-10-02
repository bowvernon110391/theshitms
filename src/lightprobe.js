import * as THREE from 'three';

/**
 * Spherical-harmonic irradiance probe volume.
 *
 * Conventions
 * ───────────
 * A probe stores L2 SH coefficients for **irradiance** — the incoming radiance
 * field already convolved with the clamped-cosine lobe. Evaluating it needs no
 * extra cosine weight, so a plain SH evaluation with the surface normal is
 * correct and folds in the `saturate(N·L)` term for free.
 *
 * Units follow three.js's WebGLRenderer shaders exactly:
 *
 *   distanceFalloff = 1 / max(d^decay, 0.01)
 *                   * pow2( saturate( 1 - pow4( d / cutoff ) ) )   // if cutoff > 0
 *   irradiance      = saturate( N · L ) * lightColor * intensity * distanceFalloff
 *   outgoing        = irradiance * BRDF_Lambert( albedo )           // albedo / PI
 *
 * Note there is no PI applied to the light uniforms — the PI lives inside
 * BRDF_Lambert. A baked irradiance must therefore carry no PI either, or it
 * would come out PI times too bright next to the real-time sun.
 */

/**
 * Per-band scaling converting **radiance** SH into **irradiance** SH, from
 * Ramamoorthi & Hanrahan: Â₀ = π, Â₁ = 2π/3, Â₂ = π/4.
 *
 * The bake projects radiance and applies this once, so the stored coefficients
 * are directly evaluable for any normal.
 */
export const SH_COSINE_LOBE = [
  Math.PI,
  (2 * Math.PI) / 3, (2 * Math.PI) / 3, (2 * Math.PI) / 3,
  Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4,
];

const BAND_OF = [0, 1, 1, 1, 2, 2, 2, 2, 2];

/** Apply the cosine-lobe convolution to 9 interleaved RGB coefficients, in place. */
export function applyCosineLobe(coeffs) {
  for (let i = 0; i < 9; i++) {
    const k = SH_COSINE_LOBE[BAND_OF[i]];
    coeffs[i * 3] *= k;
    coeffs[i * 3 + 1] *= k;
    coeffs[i * 3 + 2] *= k;
  }
  return coeffs;
}

/** L2 SH basis functions, evaluated for a unit direction. */
export function shBasis(x, y, z, out = new Float32Array(9)) {
  out[0] = 0.282095;
  out[1] = 0.488603 * y;
  out[2] = 0.488603 * z;
  out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y;
  out[5] = 1.092548 * y * z;
  out[6] = 0.315392 * (3 * z * z - 1);
  out[7] = 1.092548 * x * z;
  out[8] = 0.546274 * (x * x - y * y);
  return out;
}

/** Evaluate a set of 9 RGB SH coefficients for a direction. */
export function shEvaluate(coeffs, x, y, z, out = new THREE.Color()) {
  const b = shBasis(x, y, z, _basis);
  let r = 0;
  let g = 0;
  let bl = 0;
  // SH coefficients are stored interleaved: [r0,g0,b0, r1,g1,b1, ...]
  for (let i = 0; i < 9; i++) {
    const k = b[i];
    r += coeffs[i * 3] * k;
    g += coeffs[i * 3 + 1] * k;
    bl += coeffs[i * 3 + 2] * k;
  }
  // Negative lobes can push tiny values below zero; clamp for the output.
  out.setRGB(Math.max(r, 0), Math.max(g, 0), Math.max(bl, 0));
  return out;
}

const _basis = new Float32Array(9);

/**
 * A regular 3D grid of SH probes with trilinear sampling.
 *
 * Layout: index = (ix * nz + iz) * ny + iy, so neighbouring probes in Y are
 * contiguous — the runtime walk gathers 8 probes per vertex and benefits from
 * the tighter span.
 */
export class ProbeVolume {
  /**
   * @param {{bounds: {min: number[], max: number[]}, count: number[], coeffs: Float32Array}} data
   */
  constructor(data) {
    this.min = new THREE.Vector3().fromArray(data.bounds.min);
    this.max = new THREE.Vector3().fromArray(data.bounds.max);
    this.count = data.count;
    this.coeffs = data.coeffs;
    /** Per-probe flag bytes; zero-length when the file predates flags. */
    this.flags = data.flags ?? new Uint8Array(0);

    const [nx, ny, nz] = this.count;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.strideY = 1;
    this.strideZ = ny;
    this.strideX = ny * nz;

    this._out = new THREE.Color();
  }

  probeCount() {
    return this.nx * this.ny * this.nz;
  }

  /**
   * Gather the 8 surrounding probes and their trilinear weights.
   * Returns 0 when the point falls outside the volume.
   */
  gather(pos, indices, weights) {
    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;

    const fx = ((pos.x - this.min.x) / (this.max.x - this.min.x)) * (nx - 1);
    const fy = ((pos.y - this.min.y) / (this.max.y - this.min.y)) * (ny - 1);
    const fz = ((pos.z - this.min.z) / (this.max.z - this.min.z)) * (nz - 1);

    if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) return 0;

    const ix = Math.min(Math.floor(fx), nx - 2);
    const iy = Math.min(Math.floor(fy), ny - 2);
    const iz = Math.min(Math.floor(fz), nz - 2);

    const tx = fx - ix;
    const ty = fy - iy;
    const tz = fz - iz;

    const sx = [1 - tx, tx];
    const sy = [1 - ty, ty];
    const sz = [1 - tz, tz];

    let n = 0;
    for (let a = 0; a < 2; a++) {
      const wx = a === 0 ? 1 - tx : tx;
      for (let b = 0; b < 2; b++) {
        const wy = b === 0 ? 1 - ty : ty;
        for (let c = 0; c < 2; c++) {
          indices[n] = (ix + a) * this.strideX + (iz + c) * this.strideZ + (iy + b);
          weights[n] = wx * wy * (c === 0 ? 1 - tz : tz);
          n++;
        }
      }
    }
    return n;
  }

  /**
   * Interpolate the 27 SH coefficients at a position, *without* evaluating them.
   *
   * Separate from `sample` because the two callers want different things. A
   * single point wants an evaluated colour back. A moving object wants the raw
   * coefficients, because its shader can then evaluate them per vertex with
   * each vertex's real normal — which is what gives a character form instead of
   * one flat colour.
   *
   * Both paths interpolate first and evaluate once, so they agree.
   *
   * @param {THREE.Vector3} pos
   * @param {Float32Array} out  27 floats, interleaved `[r0,g0,b0, r1,g1,b1, ...]`
   * @returns {boolean} false when the position lies outside the volume
   */
  sampleCoeffs(pos, out) {
    out.fill(0);

    const n = this.gather(pos, _idxBuf, _wtBuf);
    if (n === 0) return false;

    for (let i = 0; i < n; i++) {
      const base = _idxBuf[i] * 27;
      const w = _wtBuf[i];
      for (let k = 0; k < 27; k++) out[k] += this.coeffs[base + k] * w;
    }
    return true;
  }

  /**
   * Sample irradiance at a world position for a surface normal.
   * Coefficients are interpolated first and evaluated once, which is both
   * cheaper and smoother than evaluating per-probe and blending.
   */
  sample(pos, normal, out = this._out) {
    if (!this.sampleCoeffs(pos, _accBuf)) return out.setRGB(0, 0, 0);
    return shEvaluate(_accBuf, normal.x, normal.y, normal.z, out);
  }
}

const _idxBuf = new Int32Array(8);
const _wtBuf = new Float32Array(8);
const _accBuf = new Float32Array(27);

/* ── Serialisation ────────────────────────────────────────────── */

/**
 * Binary layout, little-endian:
 *   +0x00  uint32  magic   "LMPB"
 *   +0x04  uint32  version
 *   +0x08  uint32  nx, ny, nz        (3 × uint32)
 *   +0x14  float32 min.xyz, max.xyz  (6 × float32)
 *   +0x2C  float32 coeffs[probes × 27]
 *   +...   uint8   flags[probes]
 */
const MAGIC = 0x42504d4c;
const HEADER_FLOATS = 3 + 6;
export const PROBE_FILE_VERSION = 2;

const HEADER_BYTES = 4 + 4 + HEADER_FLOATS * 4;

/** Per-probe flags. */
export const PROBE_FLAG = {
  /** The probe sat inside solid geometry and was rebuilt from its neighbours. */
  BURIED: 1,
};

/**
 * The two heights a moving object is sampled at, above its own origin.
 *
 * These are the *only* heights anything reads out of the volume — the shader
 * mixes the two samples by each vertex's world height, clamped to this range,
 * so a vertex above `head` still reads the `head` sample rather than a third
 * one. Everything below about `head` is dead weight, which is what
 * `PROBE_BOUNDS.max.y` is derived from.
 */
export const DYNAMIC_SAMPLE = { feet: 0.25, head: 1.7 };

/** Height of the lowest probe layer: just inside the floor slab. */
const PROBE_MIN_Y = 0.14;

/**
 * Vertical layers in the grid.
 *
 * Three, which is the fewest that still gives a vertical gradient at all: the
 * bottom layer sits at the floor, the top at `DYNAMIC_SAMPLE.head`, and the one
 * between them carries the interpolation. With two, the feet and head samples
 * would *be* the only two rows, so the shader's height blend would have nothing
 * to interpolate between and a sim would read as two flat bands rather than a
 * body.
 *
 * Three is also all the height this needs. The volume's only job vertically is
 * to interpolate between the two heights a sim is sampled at — it is not trying
 * to resolve the ceiling any more, because the atlas lights that.
 */
const PROBE_LAYERS_Y = 3;

/**
 * Vertical probe spacing, in metres.
 *
 * Derived rather than fixed, so the top layer lands exactly on
 * `DYNAMIC_SAMPLE.head` instead of leaving unused headroom above it.
 */
const PROBE_SPACING_Y = (DYNAMIC_SAMPLE.head - PROBE_MIN_Y) / (PROBE_LAYERS_Y - 1);

/**
 * Probe grid geometry, shared by the bake and the runtime so they cannot
 * disagree.
 *
 * The bounds are deliberately *inset* from the walls (walls sit at
 * x ∈ {0,4,8,12}, z ∈ {0,4,6,10}) and lie entirely inside the building
 * envelope: no probe sits in the open air outside the shell, where it would
 * read as zero and drag the interpolation down for everything near it.
 *
 * The extent is set by the *inner* faces of the four outer walls, each of
 * which is sampled at `face + PROBE_NORMAL_OFFSET`:
 *
 *   x = 0.08  → 0.20   (covered: min.x = 0.20)
 *   x = 11.92 → 11.80  (covered: max.x = 11.80)
 *   z = 0.08  → 0.20   (covered: min.z = 0.20)
 *   z = 9.92  → 9.80   (covered: max.z = 9.80)
 *
 * and by the floor:
 *
 *   floor  y = 0.02 → 0.14   (covered: min.y = 0.14)
 *
 * That leaves one problem — a wall's inner face (+0.08) and outer face
 * (-0.08) are only 16 cm apart, so no grid can serve one and not the other.
 * The normal offset resolves it: each vertex is sampled at
 * `position + normal * offset`, which steps off the surface into whichever
 * side that face looks at. An inner face lands in room air and is lit; an
 * outer face lands *outside* the volume and correctly gets nothing — and
 * because the whole volume is inside the envelope, no exterior probe exists
 * to leak light back through.
 *
 * ## The ceiling of the volume is derived, not chosen
 *
 * `max.y` used to be 2.84, covering the wall tops — a leftover from when the
 * probe volume lit *static* geometry. It does not any more: the atlas does
 * that, and the volume exists solely for the sims, which are sampled at
 * `DYNAMIC_SAMPLE.head` and nothing higher.
 *
 * At the old 0.45 m spacing that extent put layers at 0.14, 0.59, 1.04, 1.49,
 * 1.94, **2.39, 2.84**, and the top two were never read by anything. Dropping
 * them and ending the volume at `head` costs nothing at all: the interpolation
 * at both sample heights is still between real layers, just fewer of them.
 *
 * So the extent is now `[PROBE_MIN_Y, DYNAMIC_SAMPLE.head]` with
 * `PROBE_LAYERS_Y` rows between, and raising `DYNAMIC_SAMPLE.head` grows the
 * volume rather than silently clamping against a stale ceiling.
 */

export const PROBE_BOUNDS = {
  min: [0.2, PROBE_MIN_Y, 0.2],
  max: [11.8, PROBE_MIN_Y + (PROBE_LAYERS_Y - 1) * PROBE_SPACING_Y, 9.8],
};

/**
 * Grid resolution: [nx, ny, nz]. 11 × 3 × 9 = 297 probes, ~31 KB.
 *
 * **X/Z are deliberately below the density the field wants.** The sweep
 * recorded on `PROBE_BOUNDS` shows correlation falling away below 2400 probes,
 * so at 297 the sims get a smooth, soft field in which local light pools smear
 * together rather than resolving — a sim walking past a lamp brightens
 * gradually and globally, not in a distinct pool. That is the intended trade:
 * cheaper bake, lighter file, blurrier sim lighting. Do not "correct" this back
 * upwards without asking.
 *
 * Going from 5 vertical layers to 3 frees about 40% of the budget, and it is
 * spent back into X/Z rather than banked: spacing improves from
 * 1.45 × 1.60 m to 1.16 × 1.20 m at roughly the same probe count. Vertical
 * resolution was never the limiting factor — the sims sample two heights and
 * the shader interpolates between them — so that is where the cheap wins were.
 *
 * The X and Z counts are still chosen so the spacing steps over the 3.92–4.08
 * and 7.92–8.08 wall bands in X and the 3.92–4.08 and 5.92–6.08 bands in Z.
 * That constraint is free to satisfy at any density, and worth keeping: a probe
 * inside a wall reads black and smears a dark band down both of its faces.
 */
export const PROBE_COUNT = [11, PROBE_LAYERS_Y, 9];

/**
 * How far along the surface normal a vertex is sampled from its position.
 *
 * This must be smaller than a wall is thick (0.16), or a face would sample
 * past its own wall into the room on the far side.
 */
export const PROBE_NORMAL_OFFSET = 0.12;

export function encodeProbeVolume({ bounds, count, coeffs, flags }) {
  const probes = count[0] * count[1] * count[2];
  const total = probes * 27;
  const flagsBytes = probes;
  const buffer = new ArrayBuffer(HEADER_BYTES + total * 4 + flagsBytes);
  const view = new DataView(buffer);

  view.setUint32(0, MAGIC, true);
  view.setUint32(4, PROBE_FILE_VERSION, true);
  view.setUint32(8, count[0], true);
  view.setUint32(12, count[1], true);
  view.setUint32(16, count[2], true);

  let o = 20;
  for (const v of [...bounds.min, ...bounds.max]) {
    view.setFloat32(o, v, true);
    o += 4;
  }

  if (coeffs.length !== total) {
    throw new Error(`encodeProbeVolume: expected ${total} coefficients, got ${coeffs.length}`);
  }
  new Float32Array(buffer, HEADER_BYTES, total).set(coeffs);

  if (flags) {
    if (flags.length !== probes) {
      throw new Error(`encodeProbeVolume: expected ${probes} flags, got ${flags.length}`);
    }
    new Uint8Array(buffer, HEADER_BYTES + total * 4, flagsBytes).set(flags);
  }

  return buffer;
}

export function decodeProbeVolume(arrayBuffer) {
  const view = new DataView(arrayBuffer);

  if (view.getUint32(0, true) !== MAGIC) throw new Error('probe file: bad magic');

  const version = view.getUint32(4, true);
  if (version !== PROBE_FILE_VERSION) {
    throw new Error(
      `probe file: version ${version}, expected ${PROBE_FILE_VERSION} — re-run \`npm run bake\``
    );
  }

  const count = [view.getUint32(8, true), view.getUint32(12, true), view.getUint32(16, true)];
  const numbers = [];
  for (let i = 0; i < 6; i++) numbers.push(view.getFloat32(20 + i * 4, true));

  const probes = count[0] * count[1] * count[2];
  const total = probes * 27;
  const flagsOffset = HEADER_BYTES + total * 4;

  if (arrayBuffer.byteLength < flagsOffset + probes) {
    throw new Error('probe file: truncated — re-run `npm run bake`');
  }

  return {
    bounds: { min: numbers.slice(0, 3), max: numbers.slice(3, 6) },
    count,
    // Views, not copies — the backing ArrayBuffer must stay alive.
    coeffs: new Float32Array(arrayBuffer, HEADER_BYTES, total),
    flags: new Uint8Array(arrayBuffer, flagsOffset, probes),
  };
}
