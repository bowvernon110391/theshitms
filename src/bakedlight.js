import * as THREE from 'three';
import { decodeProbeVolume, ProbeVolume } from './lightprobe.js';

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

const patchedShaders = new Set();

/**
 * Add a baked-light term to a `MeshStandardMaterial` from a uniform.
 *
 * The term lands in `reflectedLight.indirectDiffuse` immediately after
 * `<lights_fragment_end>`, scaled by `BRDF_Lambert( material.diffuseColor )`.
 *
 * That is deliberately the same expression the renderer uses for a real light —
 * `irradiance * BRDF_Lambert( albedo )` — so a probe-lit character composites
 * with the sun under identical maths to an atlas-lit floor, including the
 * shared /π. `lights_physical_fragment` has already run by this point, so
 * `material.diffuseColor` is populated and metalness-corrected.
 */
function patchShader(shader, source, vertexDecls) {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
       varying vec3 vBakedLight;
       ${vertexDecls}`
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vBakedLight = ${source};`
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

  patchedShaders.add(shader);
}

/** Match the atlas's intensity so dynamic and static light dim together. */
export function setDynamicIntensity(value) {
  for (const shader of patchedShaders) {
    if (shader.uniforms.uBakedIntensity) shader.uniforms.uBakedIntensity.value = value;
  }
}

/**
 * Route a material through the dynamic-light shader path.
 * Returns the uniform the caller must refresh each frame.
 */
export function patchForDynamicLight(material) {
  if (material.userData.dynamicLightUniform) return material.userData.dynamicLightUniform;

  const uniform = { value: new THREE.Vector3() };
  material.userData.dynamicLightUniform = uniform;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDynamicLight = uniform;
    shader.uniforms.uBakedIntensity = { value: uniform.__intensity ?? 1 };
    patchShader(shader, 'uDynamicLight', 'uniform vec3 uDynamicLight;');
  };
  material.needsUpdate = true;
  return uniform;
}

/* ── Per-frame sampling ───────────────────────────────────────── */

const _point = new THREE.Vector3();
const _out = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Refresh a moving object's baked-light uniform from the probe volume.
 *
 * Sampled just above the character's chest with an up-facing normal, which
 * follows the dominant ceiling light and tracks them from room to room.
 * Directional variation across a 1.8 m body would not be worth the extra
 * transforms every frame.
 */
export function refreshDynamicLight(volume, position, uniform, height = 1.0) {
  _point.set(position.x, position.y + height, position.z);
  volume.sample(_point, _up, _out);
  uniform.value.set(_out.r, _out.g, _out.b);
}
