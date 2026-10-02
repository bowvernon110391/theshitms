import * as THREE from 'three';
import { buildHouse } from './house.js';
import { buildFurnishings } from './furnish.js';
import { buildYard } from './props.js';
import { buildSims } from './sims.js';
import { mergeByMaterial } from './utils.js';

/**
 * Builds the whole world, independent of any renderer.
 *
 * This exists so the offline bake and the browser runtime construct the scene
 * from *one* code path. If the bake walked a separately-maintained copy of the
 * geometry, the two would drift and the lighting would stop matching the
 * surfaces it was baked for — the classic way a baked pipeline rots.
 *
 * Returns the pieces individually (rather than one merged blob) because the
 * runtime still needs to toggle them separately, while the bake needs them
 * unmerged and un-transformed so it can flatten them into world space itself.
 */
export function buildWorld({ sims = true, labels = true } = {}) {
  const house = buildHouse({ labels });

  // Furniture lives in the house's local space so it inherits the foundation
  // lift, but it is static — merge it down to a handful of draw calls.
  //
  // The free-standing lamps come back with it as light specs, because they are
  // built there and their emitter heights are read off the fixtures themselves.
  const furnishings = buildFurnishings();
  const furniture = mergeByMaterial(furnishings.group);
  house.group.add(furniture);

  const yard = buildYard();
  const yardMerged = mergeByMaterial(yard.group);

  let simsGroup = null;
  let simList = [];
  if (sims) {
    const built = buildSims();
    simsGroup = built.group;
    simList = built.sims;
    house.group.add(simsGroup);
  }

  return {
    house,
    furniture,
    yard,
    yardMerged,
    simsGroup,
    simList,

    /**
     * Root sets to traverse, with **no overlap**.
     *
     * `house.group` already contains `furniture`, so listing both would visit
     * every furniture mesh twice. That is not a small inefficiency: it doubled
     * the exported triangle count, and the atlas then packed every rug and
     * chair twice over. Every caller that needs to walk the static scene must
     * use one of these rather than assembling its own list.
     */
    staticRoots: [house.group, yardMerged],
    /** Just the interior — the shell and its furniture, but not the yard. */
    lightmapRoots: [house.group],

    /**
     * Every baked interior light, ceiling and free-standing alike.
     *
     * One list rather than two, so nothing downstream has to remember that the
     * lamps in the furnishings also emit — the bake, the probe bake and the
     * export all just see "the lights".
     *
     * Plain data, not scene objects: the bake turns these into irradiance.
     */
    interiorLightSpecs: [...house.lightSpecs, ...furnishings.lightSpecs],
    exteriorLightSpecs: yard.lights,
  };
}

/**
 * Meshes that receive baked light: the shell and its furniture, but not the
 * yard, the sims, or the lamp fixtures.
 */
function isLightmapMesh(obj) {
  if (!obj.isMesh || !obj.geometry) return false;
  if (obj.visible === false) return false;
  if (obj.userData.dynamicLight) return false;
  if (obj.userData.noBake) return false;
  if (obj.userData.emitter) return false;
  return true;
}

/**
 * The lightmapped meshes, in a **canonical order**.
 *
 * This exists so the export and the runtime agree on which mesh is "mesh 3"
 * without either reimplementing the traversal. The bake records UVs against an
 * index into this list, and the runtime looks them up by the same index — so if
 * the two ever disagreed about ordering, lighting would land on the wrong
 * surfaces with nothing to show for it.
 *
 * The order is deterministic because the scene is built by the same code from
 * the same data every time.
 */
export function collectLightmapMeshes(world) {
  const out = [];
  for (const root of world.lightmapRoots) {
    root.traverse((obj) => {
      if (isLightmapMesh(obj)) out.push(obj);
    });
  }
  return out;
}

/**
 * Flatten a subtree into a single world-space triangle soup plus a per-triangle
 * albedo lookup.
 *
 * Working in world space from one flat mesh — rather than raycasting the scene
 * graph — removes all ambiguity about which space a hit is in, and lets the
 * tracer read a surface's albedo straight from `faceIndex`.
 */
export function flattenForBake(roots) {
  const positions = [];
  const normals = [];
  const albedos = [];

  const matrix = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();

  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry || obj.visible === false) return;
      // Light fixtures enclose their own light source, so leaving them in the
      // BVH makes every lamp shadow itself. See `markEmitter`.
      if (obj.userData.emitter) return;

      matrix.copy(obj.matrixWorld);
      normalMatrix.getNormalMatrix(matrix);

      const geo = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry;
      const pos = geo.attributes.position;
      const nor = geo.attributes.normal;

      // Colours are the shared material instances, already converted to the
      // linear working space by Color.setHex.
      const color = obj.material?.color ?? { r: 1, g: 1, b: 1 };

      for (let i = 0; i < pos.count; i += 3) {
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, i + k).applyMatrix4(matrix);
          positions.push(v.x, v.y, v.z);
          if (nor) {
            v.fromBufferAttribute(nor, i + k).applyMatrix3(normalMatrix).normalize();
            normals.push(v.x, v.y, v.z);
          } else {
            normals.push(0, 1, 0);
          }
        }
        albedos.push(color.r, color.g, color.b);
      }
    });
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    albedos: new Float32Array(albedos),
    triangleCount: albedos.length / 3,
  };
}

/**
 * Collect the meshes that should *receive* baked light, in world space order.
 *
 * Anything flagged `userData.noBake` is skipped — the ground planes and the
 * roof. Skipping them is what removes the light leak outdoors: with no baked
 * contribution, the lawn simply has nothing to receive interior light from.
 */
export function collectBakeReceivers(roots) {
  const receivers = [];
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      if (obj.visible === false) return;
      if (obj.userData.noBake) return;
      if (obj.userData.skipBake) return;
      receivers.push(obj);
    });
  }
  return receivers;
}
