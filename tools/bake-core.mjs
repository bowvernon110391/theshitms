import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { shBasis, applyCosineLobe } from '../src/lightprobe.js';

/**
 * The offline irradiance bake.
 *
 * Traces the artificial room lights into an SH L2 probe grid with real
 * **occlusion**. That occlusion is the whole point: the leak being fixed was
 * caused by three.js point lights passing straight through walls, and a shadow
 * ray per probe per light is what makes a wall actually stop light.
 *
 * Output units match three.js's shaders exactly — see the header of
 * `src/lightprobe.js`. In short: no PI anywhere in the baked value, because
 * `BRDF_Lambert` supplies it at shade time.
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * three.js's point-light falloff, transcribed from `getDistanceAttenuation`:
 *   1 / max(d^decay, 0.01) * pow2( saturate( 1 - pow4( d / cutoff ) ) )
 */
export function attenuation(distance, cutoff, decay) {
  let falloff = 1 / Math.max(Math.pow(distance, decay), 0.01);
  if (cutoff > 0) {
    const x = clamp01(1 - Math.pow(distance / cutoff, 4));
    falloff *= x * x;
  }
  return falloff;
}

/** Deterministic PRNG, so re-baking with the same seed reproduces the result. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Distance a shadow ray's origin is nudged off the surface it starts on.
 *
 * A ray leaving a point that lies *exactly* in the plane of the triangle it
 * came from may or may not immediately re-intersect that triangle, depending
 * purely on floating-point rounding. When it does, the light is reported as
 * occluded and the texel or probe goes dark for no physical reason — which
 * shows up as a scatter of isolated dark blocks across otherwise evenly lit
 * surfaces.
 *
 * 3 mm is far below the 160 mm wall thickness, so it cannot leak light through
 * anything real, and far above the ~1e-6 m rounding error at house scale.
 */
const SHADOW_BIAS = 0.003;

/**
 * Pack a lamp list into the shape the tracers want.
 */
export function prepareLamps(lights) {
  return lights.map((l) => ({
    position: new THREE.Vector3().fromArray(l.position),
    color: new THREE.Color().copy(l.color).multiplyScalar(l.intensity),
    cutoff: l.distance ?? 0,
    decay: l.decay ?? 2,
  }));
}

/**
 * Shared light evaluation, used by both the probe bake and the atlas bake.
 *
 * Keeping this in one place matters twice over: the two bakes must agree about
 * what a lamp's contribution *is*, or the sims (probe-lit) and the room around
 * them (atlas-lit) would disagree about the same lamp — and the shadow-ray
 * bias must be applied in both, which is easy to forget if it lives in two
 * places.
 */
export function makeSamplers(tracer, lamps) {
  const toLight = new THREE.Vector3();
  const origin = new THREE.Vector3();

  /**
   * Direct irradiance at a point with a known normal:
   *   Σ saturate( N · L ) · colour · intensity · attenuation
   * Exactly the quantity three.js accumulates per light, so it drops straight
   * into `irradiance` with no PI correction.
   */
  const directIrradiance = (point, normal, out) => {
    out.set(0, 0, 0);

    // Step off the surface before tracing, so the ray cannot hit the triangle
    // it is standing on.
    origin.copy(point).addScaledVector(normal, SHADOW_BIAS);

    for (const L of lamps) {
      toLight.copy(L.position).sub(origin);
      const d = toLight.length();
      if (d < 1e-4) continue;
      toLight.multiplyScalar(1 / d);

      const ndl = normal.dot(toLight);
      if (ndl <= 0) continue;
      if (tracer.occluded(origin, toLight, d - 0.02)) continue;

      const E = ndl * attenuation(d, L.cutoff, L.decay);
      if (E < 1e-7) continue;
      out.x += E * L.color.r;
      out.y += E * L.color.g;
      out.z += E * L.color.b;
    }
    return out;
  };

  /** Radiance leaving a surface, i.e. its irradiance times albedo/PI. */
  const outgoingRadiance = (point, normal, albedo, out) => {
    directIrradiance(point, normal, out);
    out.x *= albedo.x / Math.PI;
    out.y *= albedo.y / Math.PI;
    out.z *= albedo.z / Math.PI;
    return out;
  };

  return { directIrradiance, outgoingRadiance };
}

/**
 * A BVH over one flat, world-space triangle soup, with a reusable hit record.
 *
 * `raycastFirst` rather than `raycast` throughout: we only ever want the
 * nearest surface, and the unsorted-array variant allocates per call.
 */
export class Tracer {
  constructor({ positions, normals, albedos }) {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

    this.albedos = albedos;
    this.bvh = new MeshBVH(this.geometry, { targetLeafSize: 8 });

    this._ray = new THREE.Ray();
    this._hit = { distance: 0, normal: new THREE.Vector3(), albedo: new THREE.Vector3() };
    this._normalAttr = this.geometry.attributes.normal;
  }

  /** Nearest surface along `dir`, or null. */
  trace(origin, dir) {
    this._ray.origin.copy(origin);
    this._ray.direction.copy(dir);

    const hit = this.bvh.raycastFirst(this._ray, THREE.DoubleSide);
    if (!hit) return null;

    const h = this._hit;
    h.distance = hit.distance;
    h.normal.fromBufferAttribute(this._normalAttr, hit.faceIndex * 3);

    const fi = hit.faceIndex * 3;
    h.albedo.set(this.albedos[fi], this.albedos[fi + 1], this.albedos[fi + 2]);
    return h;
  }

  /** Is the segment origin → origin + dir·maxDistance interrupted? */
  occluded(origin, dir, maxDistance) {
    this._ray.origin.copy(origin);
    this._ray.direction.copy(dir);
    const hit = this.bvh.raycastFirst(this._ray, THREE.DoubleSide);
    return hit !== null && hit.distance < maxDistance;
  }
}

/**
 * A probe buried inside solid geometry reads as pitch black, and trilinear
 * interpolation then smears that blackness onto every surface near it. Detect
 * those probes and rebuild them from their neighbours.
 *
 * Detection needs **two** signals, and getting this wrong is subtle:
 *
 *  1. *Enclosed* — every axis ray hits within `BURIED_REACH`.
 *  2. *Dark* — the probe received no light whatsoever.
 *
 * The enclosure test alone is not enough. A probe inside a 1.1 x 1.35
 * bookshelf can see +X for 1.07 m and +Y for 1.21 m, so it slips past a short
 * reach; but raising the reach alone would start flagging probes in genuinely
 * small spaces. The darkness test alone is not enough either, because the
 * topmost layer of the grid sits *above* every lamp and is legitimately black
 * — filing it from its neighbours would light up the ceiling.
 *
 * Requiring both is what makes this precise: a probe that is boxed in on all
 * six axes *and* saw no light at all is inside something.
 *
 * Filling is safe here specifically because the whole probe volume lies inside
 * the building envelope, so a near-black probe can only mean "inside
 * something", never "outdoors" — it cannot reintroduce the light leak.
 */
const BURIED_REACH = 1.5;

export function fillBuriedProbes({ tracer, bounds, count, coeffs, onProgress }) {
  const [nx, ny, nz] = count;
  const strideY = 1;
  const strideZ = ny;
  const strideX = ny * nz;
  const total = nx * ny * nz;

  const span = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];

  const probe = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const AXES = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];

  const buried = new Uint8Array(total);

  /** Did this probe receive no light at all? */
  const isDark = (i) => {
    const base = i * 27;
    for (let k = 0; k < 27; k++) if (coeffs[base + k] !== 0) return false;
    return true;
  };

  const posFor = (ix, iy, iz) =>
    probe.set(
      bounds.min[0] + (nx === 1 ? 0 : (ix / (nx - 1)) * span[0]),
      bounds.min[1] + (ny === 1 ? 0 : (iy / (ny - 1)) * span[1]),
      bounds.min[2] + (nz === 1 ? 0 : (iz / (nz - 1)) * span[2])
    );

  let buriedCount = 0;
  let i = 0;
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++, i++) {
        if (!isDark(i)) continue;
        posFor(ix, iy, iz);
        let enclosed = true;
        for (const a of AXES) {
          dir.set(a[0], a[1], a[2]);
          if (!tracer.occluded(probe, dir, BURIED_REACH)) {
            enclosed = false;
            break;
          }
        }
        if (enclosed) {
          buried[i] = 1;
          buriedCount++;
        }
      }
    }
  }

  if (buriedCount === 0) return { buriedCount: 0, filled: 0, flags: new Uint8Array(total) };

  const filled = new Float32Array(27);
  let filledCount = 0;

  i = 0;
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++, i++) {
        if (!buried[i]) continue;

        filled.fill(0);
        let n = 0;

        // Average whichever of the six axis neighbours are themselves in
        // open air. Those neighbours are inside the same room on the other
        // side of the obstruction, which is the value we want to smear onto
        // the occluding surface.
        const neighbours = [
          [ix + 1, iy, iz], [ix - 1, iy, iz],
          [ix, iy + 1, iz], [ix, iy - 1, iz],
          [ix, iy, iz + 1], [ix, iy, iz - 1],
        ];
        for (const [ax, ay, az] of neighbours) {
          if (ax < 0 || ax >= nx || ay < 0 || ay >= ny || az < 0 || az >= nz) continue;
          const j = ax * strideX + az * strideZ + ay * strideY;
          if (buried[j]) continue;
          const base = j * 27;
          for (let k = 0; k < 27; k++) filled[k] += coeffs[base + k];
          n++;
        }

        if (n === 0) continue;
        const base = i * 27;
        for (let k = 0; k < 27; k++) coeffs[base + k] = filled[k] / n;
        filledCount++;
      }
    }
  }

  return { buriedCount, filled: filledCount, flags: buried };
}

/**
 * Bake the probe grid.
 *
 * @param {{
 *   tracer: Tracer,
 *   lights: Array<{position: number[], color: THREE.Color, intensity: number, distance: number, decay: number}>,
 *   bounds: {min: number[], max: number[]},
 *   count: number[],
 *   samples: number,   // sphere samples per probe for the GI bounce (0 = off)
 *   seed: number,
 *   onProgress?: (done: number, total: number) => void,
 * }} options
 */
export function bakeProbes({ tracer, lights, bounds, count, samples = 96, seed = 1337, onProgress }) {
  const [nx, ny, nz] = count;
  const total = nx * ny * nz;
  const coeffs = new Float32Array(total * 27);

  const span = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];

  // Pre-multiply colour by intensity once, mirroring the renderer's
  // `uniforms.color.copy( light.color ).multiplyScalar( light.intensity )`.
  const lamps = lights.map((l) => ({
    position: new THREE.Vector3().fromArray(l.position),
    color: new THREE.Color().copy(l.color).multiplyScalar(l.intensity),
    cutoff: l.distance ?? 0,
    decay: l.decay ?? 2,
  }));

  const probe = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const toLight = new THREE.Vector3();
  const hitPoint = new THREE.Vector3();
  const basis = new Float32Array(9);

  // Radiance SH accumulated for the probe currently being baked.
  const radiance = new Float64Array(27);
  const indirect = new Float64Array(27);

  /** Project direct light arriving at `point` into `target`, as Σ E·Y(ω). */
  const projectDirect = (point, target) => {
    for (const L of lamps) {
      toLight.copy(L.position).sub(point);
      const d = toLight.length();
      if (d < 1e-4) continue;
      toLight.multiplyScalar(1 / d);

      // Unlike the atlas rasteriser, no shadow bias is needed here: probe
      // positions sit at 0.5 m spacing on a grid whose rows never coincide
      // with a floor or ceiling plane (see `PROBE_BOUNDS` / `PROBE_COUNT`), so
      // no probe lies *on* a surface to begin with. If the bounds ever change
      // so that one does, this comment is the thing to revisit.
      if (tracer.occluded(point, toLight, d - 0.02)) continue;

      const E = attenuation(d, L.cutoff, L.decay);
      if (E < 1e-6) continue;

      shBasis(toLight.x, toLight.y, toLight.z, basis);
      for (let i = 0; i < 9; i++) {
        const w = basis[i] * E;
        target[i * 3] += w * L.color.r;
        target[i * 3 + 1] += w * L.color.g;
        target[i * 3 + 2] += w * L.color.b;
      }
    }
  };

  // Pre-draw the sample directions. Uniform over the sphere, because we are
  // estimating the incoming *radiance field*, not a cosine-weighted integral —
  // the cosine lobe is applied to the finished coefficients instead.
  const rng = mulberry32(seed);
  const sampleY = new Float32Array(samples);
  const samplePhi = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    sampleY[i] = 2 * rng() - 1;
    samplePhi[i] = rng() * Math.PI * 2;
  }

  let written = 0;

  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        probe.set(
          bounds.min[0] + (nx === 1 ? 0 : (ix / (nx - 1)) * span[0]),
          bounds.min[1] + (ny === 1 ? 0 : (iy / (ny - 1)) * span[1]),
          bounds.min[2] + (nz === 1 ? 0 : (iz / (nz - 1)) * span[2])
        );

        radiance.fill(0);
        projectDirect(probe, radiance);

        // ── One bounce of indirect ──────────────────────────────
        if (samples > 0) {
          indirect.fill(0);
          const sphereWeight = (4 * Math.PI) / samples;

          for (let s = 0; s < samples; s++) {
            const y = sampleY[s];
            const rr = Math.sqrt(Math.max(0, 1 - y * y));
            const a = samplePhi[s];
            dir.set(rr * Math.cos(a), y, rr * Math.sin(a));

            const hit = tracer.trace(probe, dir);
            if (!hit) continue;

            // Step off the hit surface so the next shadow rays do not
            // immediately re-intersect the triangle they start on.
            hitPoint.copy(probe).addScaledVector(dir, hit.distance + 0.02);

            // Radiance leaving that surface: its own direct irradiance times
            // albedo/PI. N·L is applied here, per light, against the *hit*
            // normal — this is what makes bounce light directional.
            let r = 0;
            let g = 0;
            let b = 0;
            for (const L of lamps) {
              toLight.copy(L.position).sub(hitPoint);
              const d = toLight.length();
              if (d < 1e-4) continue;
              toLight.multiplyScalar(1 / d);

              const ndl = hit.normal.dot(toLight);
              if (ndl <= 0) continue;
              if (tracer.occluded(hitPoint, toLight, d - 0.02)) continue;

              const E = ndl * attenuation(d, L.cutoff, L.decay);
              if (E < 1e-6) continue;
              r += E * L.color.r;
              g += E * L.color.g;
              b += E * L.color.b;
            }

            if (r + g + b < 1e-7) continue;

            // Fold in albedo/PI and the sample's solid-angle weight.
            const k = sphereWeight / Math.PI;
            r *= hit.albedo.x * k;
            g *= hit.albedo.y * k;
            b *= hit.albedo.z * k;

            shBasis(dir.x, dir.y, dir.z, basis);
            for (let i = 0; i < 9; i++) {
              const w = basis[i];
              indirect[i * 3] += w * r;
              indirect[i * 3 + 1] += w * g;
              indirect[i * 3 + 2] += w * b;
            }
          }

          for (let k = 0; k < 27; k++) radiance[k] += indirect[k];
        }

        // Radiance → irradiance, once, at the end.
        applyCosineLobe(radiance);
        coeffs.set(radiance, written * 27);
        written++;

        if (onProgress && written % 64 === 0) onProgress(written, total);
      }
    }
  }

  if (onProgress) onProgress(total, total);
  return { bounds, count, coeffs };
}
