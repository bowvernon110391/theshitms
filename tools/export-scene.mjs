import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

import { buildWorld, collectLightmapMeshes } from '../src/world.js';

/**
 * `GLTFExporter` was written for the browser and reaches for `FileReader` to
 * turn its internal `Blob` into an `ArrayBuffer`.
 *
 * Node has `Blob` but not `FileReader`, and the exporter only ever uses three
 * calls of one shape — `readAsArrayBuffer( blob )`, then read `.result` from
 * `onloadend`. Implementing exactly that is a few lines and keeps us on the
 * official exporter instead of hand-rolling a GLB encoder, which would be the
 * larger risk. The `else` branch makes a future change to that assumption fail
 * loudly rather than hang.
 */
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      Promise.resolve()
        .then(() => blob.arrayBuffer())
        .then((buffer) => {
          this.result = buffer;
          if (typeof this.onloadend === 'function') this.onloadend();
        })
        .catch((error) => {
          if (typeof this.onerror === 'function') this.onerror(error);
        });
    }

    readAsDataURL() {
      throw new Error('export-scene: GLTFExporter requested readAsDataURL, which is not polyfilled');
    }
  };
}

/**
 * Stage 1 of the Blender bake: write the static scene out as a GLB, plus a JSON
 * description of the lamps for the Blender script to recreate.
 *
 *   node tools/export-scene.mjs
 *
 * Why a GLB rather than a JSON dump of our own: Blender imports glTF natively
 * and correctly, including materials, so the only thing this file has to get
 * right is geometry order — and the format is compact binary, where a JSON
 * vertex dump would be tens of megabytes.
 *
 * Three properties matter, and each was arrived at by measurement:
 *
 *  - **One object.** UVs live on a mesh and occupy that mesh's own 0..1 square,
 *    so separate objects would each be packed into their own overlapping square
 *    instead of sharing one atlas.
 *  - **Welded, but with the triangle list untouched.** Unwrapping needs shared
 *    edges or every triangle becomes its own island, but Blender's own
 *    `remove_doubles` also deletes faces that collapse — it removed 22,002 of
 *    51,196 here, which would destroy the ordering. Welding in Node keeps the
 *    triangles exactly as built.
 *  - **Face order is the contract.** `import-lightmap.mjs` routes UVs back to
 *    geometry by triangle index, so a reorder would silently misplace lighting.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.resolve(ROOT, 'bake');

/**
 * Drop any stale outputs first. A GLB left over from a previous run would let a
 * failed export masquerade as a successful one, and the UV file is only valid
 * for the exact geometry it was produced from.
 *
 * Only **this stage's** three files are removed — not the whole directory.
 * Blender writes its pixels and UVs into the same folder, and deleting them
 * here made `bake:import` fail with "no such file" for a reason that pointed at
 * the importer rather than at the export that had just eaten the file.
 *
 * The stale-output problem is handled instead by deleting Blender's outputs too
 * when the export succeeds, so a re-import of half-old data is impossible
 * either way — but a wrong stage order now fails loudly at the missing GLB.
 */
const STAGE_OUTPUTS = ['scene.glb', 'lights.json', 'manifest.json'];

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const name of STAGE_OUTPUTS) {
  fs.rmSync(path.join(OUT_DIR, name), { force: true });
}

/**
 * Everything downstream of this export, so a stale bake cannot be silently
 * paired with new geometry. Removed at the end of the run rather than here: if
 * the export throws, whatever is on disk is still the last consistent set.
 */
const DOWNSTREAM_OUTPUTS = [
  'bake-pixels.f32',
  'bake-preview.png',
  'uv.f32',
  'uv-index.json',
];

/* ── Build the world, same code the runtime uses ──────────────── */

const world = buildWorld({ sims: false, labels: false });

// Same split as before: the shell and furniture are what interior lamps reach.
// The yard is deliberately excluded — baking it would waste atlas budget on
// surfaces no room light can illuminate.
//
// `lightmapRoots` rather than a hand-written list: `house.group` already
// contains the furniture, so naming both would walk every furniture mesh twice.
const roots = world.lightmapRoots;

/* ── Collect and prepare meshes ───────────────────────────────── */

// World matrices must be current before anything is flattened.
//
// `collectLightmapMeshes` only walks the graph — it deliberately does not touch
// transforms, because the runtime does not need them. But the exporter bakes
// `matrixWorld` into every vertex, and a stale identity matrix would silently
// export the whole house in local space: geometry in the wrong place, a
// meaningless bounds check, and a bake pointed at empty air.
for (const root of world.lightmapRoots) root.updateWorldMatrix(true, true);

const sources = collectLightmapMeshes(world);

/**
 * Everything is combined into **one** mesh, with one material slot per source
 * material.
 *
 * This is not a tidiness choice — it is required for the atlas to work. UV
 * coordinates live on a mesh and occupy their own 0..1 square, so 300 separate
 * objects would each be packed into their own square and every one of them
 * would overlap every other. Baking that produces a texture where hundreds of
 * surfaces fight over the same texels. One object means one 0..1 square, which
 * is the shared atlas we actually want.
 *
 * Faces are grouped by material and laid down in a deterministic order, with a
 * face range recorded per source mesh so the UVs can be handed back to the
 * right geometry afterwards.
 */
const parts = [];
for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
  const mesh = sources[sourceIndex];

  // `toNonIndexed` returns a new geometry, leaving the original scene untouched
  // — the probe bake still wants the scene as built.
  const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();

  // Flatten the world transform in, so a vertex's position in the file *is* its
  // world position. Blender then needs no matrix chain for the axis check.
  geo.applyMatrix4(mesh.matrixWorld);

  // Only position and normal survive. Blender authors its own UVs, and anything
  // else would just bloat the file.
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  }
  geo.clearGroups();

  if (!geo.attributes.normal) geo.computeVertexNormals();

  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  parts.push({ geo, material, name: mesh.name, sourceIndex });
}

/* Group by material, preserving first-seen order for determinism. */

const materialOrder = [];
const byMaterial = new Map();
for (const part of parts) {
  const key = part.material.uuid;
  if (!byMaterial.has(key)) {
    byMaterial.set(key, []);
    materialOrder.push(part.material);
  }
  byMaterial.get(key).push(part);
}

/* Concatenate with welding, so Blender receives connected, indexed geometry. */

/**
 * Weld here rather than letting Blender do it.
 *
 * Unwrapping needs shared edges: with none, every triangle becomes its own
 * island, which multiplies island count and wastes the atlas on per-island
 * margins. But Blender's `remove_doubles` also *deletes faces* that collapse
 * when their vertices merge — on this scene it dropped 22,002 of 51,196 faces,
 * which destroys the order the UV mapping depends on.
 *
 * Welding here keeps the triangle list exactly as built and only deduplicates
 * vertices, so the face order survives intact. Blender then imports an indexed
 * mesh with nothing to merge.
 *
 * Vertices are keyed on **position and normal together**. Position alone would
 * fuse a box's three corner vertices into one, and with flat shading that is
 * harmless — but keeping them apart preserves the per-face topology, which is
 * what makes a box face unwrap as one island.
 */
const vertexKey = (x, y, z, nx, ny, nz) =>
  `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}|` +
  `${Math.round(nx * 1e3)},${Math.round(ny * 1e3)},${Math.round(nz * 1e3)}`;

const vertexIndex = new Map();
const positions = [];
const normals = [];
const indices = [];

const groups = [];

/**
 * Face range per **original mesh index**, not per emission order.
 *
 * These are two different orderings and conflating them is silently wrong. The
 * combined buffer is laid out grouped by material, because glTF needs
 * contiguous index ranges per primitive — so triangles are emitted in
 * material-group order. But the runtime holds meshes in
 * `collectLightmapMeshes` order and looks ranges up by that index.
 *
 * Recording ranges as they were emitted would therefore attach every mesh's
 * UVs to whichever mesh happened to share its material group. The runtime
 * asserts on the counts and refused to apply the result, which is what surfaced
 * this.
 */
const rangeByMesh = new Array(sources.length);

let triangleCursor = 0;

for (let materialIndex = 0; materialIndex < materialOrder.length; materialIndex++) {
  const list = byMaterial.get(materialOrder[materialIndex].uuid);
  const groupStartIndex = indices.length;

  for (const part of list) {
    const p = part.geo.attributes.position.array;
    const n = part.geo.attributes.normal.array;

    for (let i = 0; i < p.length; i += 3) {
      const px = p[i];
      const py = p[i + 1];
      const pz = p[i + 2];
      const nx = n[i];
      const ny = n[i + 1];
      const nz = n[i + 2];

      const key = vertexKey(px, py, pz, nx, ny, nz);
      let index = vertexIndex.get(key);
      if (index === undefined) {
        index = positions.length / 3;
        positions.push(px, py, pz);
        normals.push(nx, ny, nz);
        vertexIndex.set(key, index);
      }
      indices.push(index);
    }

    const triangles = p.length / 9;
    rangeByMesh[part.sourceIndex] = {
      name: part.name,
      triangleOffset: triangleCursor,
      triangles,
    };
    triangleCursor += triangles;
  }

  groups.push({
    // For indexed geometry, group ranges are measured in *indices*.
    start: groupStartIndex,
    count: indices.length - groupStartIndex,
    materialIndex,
  });
}

// Safety net: a hole here would mean a mesh whose UVs can never be found.
const missing = rangeByMesh.findIndex((r) => r === undefined);
if (missing >= 0) {
  throw new Error(`export: no face range recorded for mesh ${missing}`);
}

const ranges = rangeByMesh;

const combined = new THREE.BufferGeometry();
combined.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
combined.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
combined.setIndex(indices.length > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
for (const g of groups) combined.addGroup(g.start, g.count, g.materialIndex);

const combinedMesh = new THREE.Mesh(
  combined,
  materialOrder.map((m) => m ?? new THREE.MeshBasicMaterial())
);
combinedMesh.name = 'house';
combinedMesh.matrix.identity();
combinedMesh.updateMatrixWorld(true);

/* ── Export GLB ───────────────────────────────────────────────── */

const exportRoot = new THREE.Group();
exportRoot.name = 'scene';
exportRoot.add(combinedMesh);

const exporter = new GLTFExporter();

const glb = await new Promise((resolve, reject) => {
  exporter.parse(exportRoot, resolve, reject, {
    binary: true,
    onlyVisible: false,
    includeCustomExtensions: false,
  });
});

const glbPath = path.join(OUT_DIR, 'scene.glb');
fs.writeFileSync(glbPath, Buffer.from(glb));

/* ── Lamp description ─────────────────────────────────────────── */

/**
 * The lamps are written as plain numbers rather than exported as glTF lights.
 *
 * Three's GLTFExporter does not emit `KHR_lights_punctual`, and even if it did,
 * Blender's importer maps punctual lights onto its own light types with its own
 * power units — an intensity round trip through two unit systems is exactly the
 * kind of thing that silently comes out wrong. Writing the raw values and
 * letting Blender construct the lights is unambiguous.
 */
const lights = world.interiorLightSpecs.map((l) => ({
  name: l.name,
  // three's Color is already linear-light after setHex, which is the space we
  // want to hand over. Blender's light colours are also linear.
  color: [l.color.r, l.color.g, l.color.b],
  position: l.position,
  intensity: l.intensity,
  distance: l.distance ?? 0,
  decay: l.decay ?? 2,
}));

/**
 * Bounds of what was exported, in our Y-up space.
 *
 * The Blender script transforms lamp positions from Y-up into Blender's Z-up,
 * and then verifies that every lamp lands inside the geometry it imported. If
 * the axis convention were wrong, the lamps would end up outside the house and
 * the check fails loudly instead of quietly baking light in the wrong places.
 */
const bounds = new THREE.Box3();
combined.computeBoundingBox();
bounds.copy(combined.boundingBox);

fs.writeFileSync(
  path.join(OUT_DIR, 'lights.json'),
  JSON.stringify(
    {
      // Declared so the far side can assert it read a format it understands.
      format: 'jjjs-lights',
      version: 1,
      upAxis: 'Y',
      lights,
      bounds: {
        min: bounds.min.toArray(),
        max: bounds.max.toArray(),
      },
    },
    null,
    2
  )
);

/* ── Face-range manifest, for the round-trip check ────────────── */

/**
 * Where each source mesh's triangles ended up in the combined mesh.
 *
 * This is the mapping the whole pipeline rests on. Blender hands back UVs
 * indexed by face; `import-lightmap.mjs` uses these ranges to route each face's
 * UV back to the runtime geometry that owns it. Because the faces were laid
 * down in a known order and never reordered afterwards, a range check is exact
 * — unlike a vertex-count or hash check, which welding would invalidate.
 */
const manifest = {
  format: 'jjjs-manifest',
  version: 1,
  totalTriangles: triangleCursor,
  totalMaterials: materialOrder.length,
  ranges,
};

fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2)
);

// The export is complete, so anything Blender produced against the *previous*
// geometry is now meaningless. Clearing it here means a forgotten `bake:blender`
// fails at the first read rather than quietly colouring new walls with old UVs.
for (const name of DOWNSTREAM_OUTPUTS) {
  fs.rmSync(path.join(OUT_DIR, name), { force: true });
}

/* ── Report ───────────────────────────────────────────────────── */

console.log('▲ export scene');
console.log(`  meshes      ${ranges.length} merged into 1 object, ${materialOrder.length} material slots`);
console.log(`  triangles   ${triangleCursor}`);
console.log(`  vertices    ${positions.length / 3} after welding`);
console.log(`  lights      ${lights.length} (${lights.map((l) => l.name.split(':')[1]).join(', ')})`);
console.log(
  `  bounds      [${bounds.min.toArray().map((v) => v.toFixed(2)).join(', ')}] .. ` +
    `[${bounds.max.toArray().map((v) => v.toFixed(2)).join(', ')}]`
);
console.log(`  wrote       ${path.relative(ROOT, glbPath).replace(/\\/g, '/')} (${(glb.byteLength / 1024 / 1024).toFixed(2)} MB)`);
console.log('  wrote       bake/lights.json, bake/manifest.json');
