import * as THREE from 'three';
import { decodeProbeVolume, ProbeVolume, DYNAMIC_SAMPLE } from './lightprobe.js';
import { clamp } from './utils.js';

/**
 * Probe-volume lighting, for **dynamic objects only**.
 *
 * Static geometry is no longer lit this way — it uses the baked texture atlas
 * (see `lightmapfile.js`), which resolves per texel instead of per vertex and
 * is therefore far sharper.
 *
 * The probe volume survives for moving characters, because a texture lightmap
 * fundamentally cannot light them: a lightmap is indexed by a surface's UVs,
 * and a character's UVs travel with it, so it would carry the lighting of
 * wherever it happened to be standing. A probe grid is indexed by world
 * position, which is exactly the right thing to ask about a body that moves.
 *
 * So the two systems coexist, and they plug into different stages of the
 * pipeline — one is a texture lookup, the other a uniform write — which is why
 * they compose without fighting.
 */

export async function loadProbeVolume(url = '/lightmap.bin') {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(
      `Could not load ${url} (HTTP ${response.status}). Run \`npm run bake\` to generate it.`
    );
  }
  return new ProbeVolume(decodeProbeVolume(await response.arrayBuffer()));
}

/* ── Shader injection, for the dynamic path ───────────────────── */

/** Every uniform set handed out, so the day/night dim can reach them all. */
const dynamicUniformSets = new Set();

/** Latest day/night dim, so a material compiled mid-frame gets the right value. */
let dynamicIntensity = 1;

/**
 * Add a baked-light term to a `MeshStandardMaterial`, evaluated per vertex from
 * the probe volume's spherical harmonics.
 *
 * ## Why the SH are evaluated here rather than on the CPU
 *
 * This used to sample the volume once on the CPU and pass the resulting colour
 * as a uniform, which made every vertex of a character exactly the same value.
 * Two things went wrong with that:
 *
 *  - The normal was hardcoded to `+Y`. Evaluating L2 at that direction zeroes
 *    five of the nine basis functions outright, so 15 of the 27 stored floats
 *    per probe were multiplied by zero and thrown away — and a body got no
 *    shading variation from its own shape at all.
 *  - A uniform is constant across the mesh, so the `vBakedLight` *varying* had
 *    nothing to interpolate. A sim standing next to a lamp was uniformly bright
 *    from head to foot.
 *
 * Between them that is why dynamic objects read as flat cut-outs at night,
 * when the probe light is the only thing lighting them.
 *
 * So the interpolation stays on the CPU — it is over 8 probes × 27 floats, done
 * once per object per frame — but the *evaluation* moves into the vertex shader,
 * where the real normal is available for free. The cost is ~30 flops per
 * vertex; the benefit is that the varying finally carries something.
 *
 * Two coefficient sets are passed, sampled at the object's feet and head, and
 * mixed by the vertex's own world height. That is what gives a body a vertical
 * gradient instead of one value, and it costs a second `sampleCoeffs` call.
 *
 * ## One caveat
 *
 * The world normal is reconstructed as `mat3( modelMatrix ) * objectNormal`,
 * which is only correct while the model matrix carries no non-uniform scale.
 * Every sim part bakes its scaling into the geometry (`ellipsoid` in `sims.js`)
 * specifically to keep that true.
 */
function patchShader(shader) {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
       uniform vec3 uSHa[ 9 ];
       uniform vec3 uSHb[ 9 ];
       uniform vec2 uBakedRange;
       varying vec3 vBakedLight;

       // Must match \`shBasis\` in lightprobe.js term for term, or the shader and
       // the CPU would disagree about what the coefficients mean.
       vec3 bakedSh( vec3 sh[ 9 ], vec3 n ) {
         return
           sh[ 0 ] * 0.282095 +
           sh[ 1 ] * ( 0.488603 * n.y ) +
           sh[ 2 ] * ( 0.488603 * n.z ) +
           sh[ 3 ] * ( 0.488603 * n.x ) +
           sh[ 4 ] * ( 1.092548 * n.x * n.y ) +
           sh[ 5 ] * ( 1.092548 * n.y * n.z ) +
           sh[ 6 ] * ( 0.315392 * ( 3.0 * n.z * n.z - 1.0 ) ) +
           sh[ 7 ] * ( 1.092548 * n.x * n.z ) +
           sh[ 8 ] * ( 0.546274 * ( n.x * n.x - n.y * n.y ) );
       }`
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         vec3 bakedNormal = normalize( mat3( modelMatrix ) * objectNormal );
         float bakedY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;
         float bakedT = clamp(
           ( bakedY - uBakedRange.x ) / max( uBakedRange.y - uBakedRange.x, 1e-4 ),
           0.0, 1.0
         );
         vBakedLight = mix(
           bakedSh( uSHa, bakedNormal ),
           bakedSh( uSHb, bakedNormal ),
           bakedT
         );
       }`
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
       uniform float uBakedIntensity;
       varying vec3 vBakedLight;`
    )
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
       reflectedLight.indirectDiffuse +=
         max( vBakedLight, vec3( 0.0 ) ) * uBakedIntensity * BRDF_Lambert( material.diffuseColor );`
    );
}

/** Match the atlas's intensity so dynamic and static light dim together. */
export function setDynamicIntensity(value) {
  dynamicIntensity = value;
  for (const set of dynamicUniformSets) set.uBakedIntensity.value = value;
}

/**
 * Route a material through the dynamic-light shader path.
 * Returns the uniform set the caller must refresh each frame.
 */
export function patchForDynamicLight(material) {
  if (material.userData.dynamicLightUniforms) return material.userData.dynamicLightUniforms;

  const uniforms = {
    // Interleaved SH coefficients, grouped as vec3 so three's array-of-vec3
    // uniform path can upload them without a custom setter.
    uSHa: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) },
    uSHb: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) },
    uBakedRange: { value: new THREE.Vector2(0, 1) },
    uBakedIntensity: { value: dynamicIntensity },
  };

  material.userData.dynamicLightUniforms = uniforms;
  dynamicUniformSets.add(uniforms);

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchShader(shader);
  };
  material.needsUpdate = true;
  return uniforms;
}

/* ── Per-frame sampling ───────────────────────────────────────── */

const _probePoint = new THREE.Vector3();
const _shFeet = new Float32Array(27);
const _shHead = new Float32Array(27);

/**
 * Refresh a moving object's baked-light uniforms from the probe volume.
 *
 * Sampled twice — near the object's base and just above its head — and mixed in
 * the vertex shader by each vertex's own height. The two heights span a whole
 * body, so the coefficients are the only thing that differs between them; the
 * normal still comes from the geometry, which is where the directional detail
 * comes from.
 *
 * Sampling once at the chest would leave a sim uniformly lit from head to foot,
 * which is what made them look flat.
 *
 * The sample heights are **clamped into the volume**, and that is not
 * defensive padding. The volume's floor is inset at `PROBE_BOUNDS.min.y` (0.14)
 * so that no probe sits in the floor slab, which means a sample taken at an
 * object's actual base — y = 0 for a sim standing on the ground — falls outside
 * it and `sampleCoeffs` returns zeros. Unclamped, the lower body would blend
 * toward black rather than merely being the dimmer of the two samples.
 * Measured: every probe row at y = 0.12 reads `OUT` and evaluates to #000000.
 *
 * The bounds are nudged *inward* by `INSET` before clamping, which matters
 * because the volume's top layer now sits exactly on `DYNAMIC_SAMPLE.head` and
 * a sample for a sim taller than that clamps straight onto the boundary.
 * `gather()` rejects a point at `fy > ny - 1`, and at exactly `ny - 1` float
 * rounding decides the outcome — so an exact-boundary clamp can evaluate to
 * zero and turn the head of a tall object black. Shrinking the clamp range by a
 * hair makes the sample land infinitesimally inside the last cell instead,
 * where the weights are `[~0, 1]` and the result is the top layer, which is
 * what was wanted in the first place.
 *
 * @param {import('./lightprobe.js').ProbeVolume} volume
 * @param {THREE.Vector3} position  object origin, on the floor
 * @param {Iterable<object>} sets   uniform sets, one per material
 * @param {number} feet  sample height above the origin, before clamping
 * @param {number} head  sample height above the origin, before clamping
 */
export function refreshDynamicLight(
  volume,
  position,
  sets,
  feet = DYNAMIC_SAMPLE.feet,
  head = DYNAMIC_SAMPLE.head
) {
  const INSET = 1e-4;

  const y0 = clamp(position.y + feet, volume.min.y + INSET, volume.max.y - INSET);
  const y1 = clamp(position.y + head, volume.min.y + INSET, volume.max.y - INSET);

  volume.sampleCoeffs(_probePoint.set(position.x, y0, position.z), _shFeet);
  volume.sampleCoeffs(_probePoint.set(position.x, y1, position.z), _shHead);

  for (const set of sets) {
    for (let i = 0; i < 9; i++) {
      set.uSHa.value[i].set(_shFeet[i * 3], _shFeet[i * 3 + 1], _shFeet[i * 3 + 2]);
      set.uSHb.value[i].set(_shHead[i * 3], _shHead[i * 3 + 1], _shHead[i * 3 + 2]);
    }
    set.uBakedRange.value.set(y0, y1);
  }
}
