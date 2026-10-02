import * as THREE from 'three';
import { segmentsFor } from './config.js';

/* ── Math ─────────────────────────────────────────────────────── */

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Smooth Hermite interpolation. */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent damping factor. */
export function damp(lambda, dt) {
  return 1 - Math.exp(-lambda * dt);
}

const _cA = new THREE.Color();
const _cB = new THREE.Color();

/** Interpolate two hex colours, writing into a reused THREE.Color. */
export function mixColor(a, b, t, out = new THREE.Color()) {
  _cA.setHex(a);
  _cB.setHex(b);
  return out.copy(_cA).lerp(_cB, t);
}

/**
 * Sample a list of keyframes shaped `{ at, ...values }` at position `t`.
 * Numeric fields are lerped, `Color` fields are colour-lerped.
 */
export function sampleKeys(keys, t) {
  const out = {};
  if (t <= keys[0].at) return { ...keys[0], at: t };
  if (t >= keys[keys.length - 1].at) return { ...keys[keys.length - 1], at: t };

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].at < t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const raw = (t - a.at) / (b.at - a.at);
  const k = raw * raw * (3 - 2 * raw); // ease between keyframes

  for (const key of Object.keys(a)) {
    if (key === 'at') continue;
    const av = a[key];
    const bv = b[key];
    if (av instanceof THREE.Color) {
      out[key] = new THREE.Color().copy(av).lerp(bv, k);
    } else if (typeof av === 'number') {
      out[key] = lerp(av, bv, k);
    }
  }
  out.at = t;
  return out;
}

/* ── Mesh helpers ─────────────────────────────────────────────── */

/**
 * Axis-aligned box placed by its BASE, not its centre. `pos = [x, floorY, z]`.
 *
 * Boxes are subdivided automatically: baked lighting lives on vertices, so a
 * wall built from 8 corners could only show one flat value across its whole
 * face. `segmentsFor` keeps the spacing near `TESSEL` regardless of size.
 */
export function box(w, h, d, material, pos = [0, 0, 0], ry = 0) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d, segmentsFor(w), segmentsFor(h), segmentsFor(d)),
    material
  );
  mesh.position.set(pos[0], pos[1] + h / 2, pos[2]);
  mesh.rotation.y = ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Centre-anchored box, for pieces that hang (lamps, mirrors, TV). */
export function boxC(w, h, d, material, pos = [0, 0, 0], ry = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.y = ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function cyl(rTop, rBot, h, material, pos = [0, 0, 0], segments = 18) {
  const heightSegments = Math.min(6, segmentsFor(h));
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBot, h, segments, heightSegments),
    material
  );
  mesh.position.set(pos[0], pos[1] + h / 2, pos[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function sph(r, material, pos = [0, 0, 0], segments = 16) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, segments, Math.max(8, segments / 2)), material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A flat quad lying on the floor — rugs, paths, water.
 * Tessellation is opt-in here (`tess: true`), because the same helper builds
 * 140 m ground planes where subdividing would add ~190k pointless triangles.
 */
export function plane(w, d, material, pos = [0, 0, 0], ry = 0, tess = false) {
  const geometry = tess
    ? new THREE.PlaneGeometry(w, d, segmentsFor(w), segmentsFor(d))
    : new THREE.PlaneGeometry(w, d);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = ry;
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.receiveShadow = true;
  return mesh;
}

export function group(name, children = []) {
  const g = new THREE.Group();
  g.name = name;
  for (const c of children) g.add(c);
  return g;
}

/**
 * Flag a light fixture's meshes so the bake leaves them out of its BVH.
 *
 * A fixture sits *around* its own light — the ceiling lamp's shade and bulb
 * straddle the point the light is defined at — so shadow rays converging on
 * that point pass through the fixture and report themselves as occluded. The
 * lamp then shadows itself, painting dark bands on the nearby walls and
 * ceiling.
 *
 * Excluding the fixtures entirely is the simplest correct answer: they are thin
 * decorative shells that contribute nothing meaningful to bounced light, and
 * they are the only objects that can possibly enclose a light source.
 *
 * `noMerge` is set alongside because `mergeByMaterial` builds fresh meshes and
 * does not carry `userData` across, so a merged emitter would lose this flag.
 */
export function markEmitter(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.userData.emitter = true;
    o.userData.noMerge = true;
  });
  return root;
}

/* ── Geometry merging ────────────────────────────────────────── */

const MERGE_ATTRS = ['position', 'normal', 'uv'];

/**
 * Flatten a subtree into one mesh per material.
 *
 * Anything flagged `userData.noMerge`, or whose material is animated
 * independently, is left alone. This keeps the draw-call count sane
 * once a few hundred furniture boxes are on screen.
 */
export function mergeByMaterial(root) {
  root.updateMatrixWorld(true);

  // Merging rebuilds the tree from meshes only, which would silently drop
  // lights and CSS2D labels. Refuse rather than quietly break the scene.
  let hasNonMesh = false;
  root.traverse((obj) => {
    if (obj !== root && (obj.isLight || obj.isCSS2DObject || obj.isPoints || obj.isSprite)) {
      hasNonMesh = true;
    }
  });
  if (hasNonMesh) return root;

  /** @type {Map<string, { material: THREE.Material, geos: THREE.BufferGeometry[] }>} */
  const buckets = new Map();
  const keep = [];

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (obj.userData.noMerge) {
      keep.push(obj);
      return;
    }
    if (!obj.geometry.attributes.position) return;

    const key = obj.material.uuid;
    if (!buckets.has(key)) buckets.set(key, { material: obj.material, geos: [] });
    buckets.get(key).geos.push(obj);
  });

  const merged = new THREE.Group();
  merged.name = `${root.name || 'group'}:merged`;

  for (const { material, geos } of buckets.values()) {
    const prepared = [];
    for (const mesh of geos) {
      let g = mesh.geometry.clone();
      if (g.index) g = g.toNonIndexed();

      // Normalise the attribute set so merging can't fail on a mismatch.
      for (const attr of MERGE_ATTRS) {
        if (!g.attributes[attr]) {
          const count = g.attributes.position.count;
          const size = attr === 'uv' ? 2 : 3;
          g.setAttribute(attr, new THREE.BufferAttribute(new Float32Array(count * size), size));
        }
      }
      for (const name of Object.keys(g.attributes)) {
        if (!MERGE_ATTRS.includes(name)) g.deleteAttribute(name);
      }
      g.clearGroups();
      g.applyMatrix4(mesh.matrixWorld);
      prepared.push(g);
    }

    if (prepared.length === 0) continue;
    const geo = mergeGeometriesSafe(prepared);
    if (!geo) continue;

    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = geos[0].castShadow;
    mesh.receiveShadow = geos[0].receiveShadow;
    merged.add(mesh);
  }

  reattachPreservingWorld(keep, merged);
  return merged;
}

/**
 * Re-parent `keep` objects into `merged` while preserving where they appear.
 *
 * `Object3D.add()` does not preserve world position — it only changes a node's
 * parent. So moving an object out of a positioned group (a rug out of its room's
 * group, say) into a new identity-transform group silently collapses it onto
 * the world origin. Every `noMerge` object in the scene was gathered at the
 * origin because of this, including geometry that then poked out through the
 * exterior walls.
 *
 * The fix is to bake each moved object's current world matrix into its local
 * transform first, so that under an identity parent it lands back where it was.
 * Children ride along because their own locals are untouched.
 *
 * An object whose ancestor is *also* being moved is skipped: that ancestor's
 * transform is about to be baked, and its world matrix already contains this
 * object's position, so baking both would apply the offset twice. The ancestor
 * chain is walked before anything is re-parented, while it is still intact.
 */
function reattachPreservingWorld(keep, merged) {
  const kept = new Set(keep);

  for (const obj of keep) {
    let ancestorKept = false;
    for (let parent = obj.parent; parent; parent = parent.parent) {
      if (kept.has(parent)) {
        ancestorKept = true;
        break;
      }
    }
    if (ancestorKept) continue;

    // `matrixWorld` includes every ancestor transform. Decomposing it into the
    // local transform makes the object's world placement identical once it
    // hangs off an identity-transform parent.
    obj.matrix.copy(obj.matrixWorld);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
  }

  for (const obj of keep) merged.add(obj);
}

/**
 * `mergeGeometries` returns null instead of throwing on mismatch, which
 * produces an invisible model rather than an obvious error. Fall back to
 * the first geometry so something always renders.
 */
function mergeGeometriesSafe(list) {
  const total = list.reduce((n, g) => n + g.attributes.position.count, 0);
  if (total === 0) return null;

  const merged = new THREE.BufferGeometry();
  for (const attr of MERGE_ATTRS) {
    const itemSize = list[0].attributes[attr].itemSize;
    const array = new Float32Array(total * itemSize);
    let offset = 0;
    for (const g of list) {
      array.set(g.attributes[attr].array, offset);
      offset += g.attributes[attr].array.length;
    }
    merged.setAttribute(attr, new THREE.BufferAttribute(array, itemSize));
  }
  return merged;
}

/** Dispose every geometry and material underneath `root`. */
export function disposeTree(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
  });
}
