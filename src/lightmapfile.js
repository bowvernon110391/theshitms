import * as THREE from 'three';

/**
 * Loading and applying the baked lightmap.
 *
 * The lightmap is a **normal PNG** — `public/lightmap.png` — plus a small JSON
 * sidecar and a raw UV array. There is no custom container: the image is an
 * image, so it uses an image format that browsers decode natively and that you
 * can open in any viewer to see what the bake actually produced.
 *
 * ## Colour space
 *
 * The PNG is written with the sRGB transfer function applied, and the texture is
 * tagged `SRGBColorSpace`. That pairing is what makes it come back linear: the
 * GPU inverts sRGB in hardware on sample, so no shader work is needed and the
 * round trip is exact apart from 8-bit quantisation.
 *
 * Tagging it linear instead — or writing linear values without the curve —
 * would be worse in both directions: linear-in-8-bits bands badly in the dim
 * regions, which is most of this atlas.
 *
 * ## Range
 *
 * Irradiance peaks around 22 here and sits near 0.1 in the corners, so storing
 * raw values in 8 bits would spend the entire byte range on the highlights.
 * The bake normalises by its own peak and records it; `lightMapIntensity`
 * multiplies it back, which also means the day/night dimming and the peak
 * scaling fold into a single number.
 */

/**
 * @typedef {{
 *   atlasSize: number,
 *   margin: number,
 *   texelsPerMetre: number,
 *   triangles: number,
 *   peak: number,
 *   blackUv: number[],
 *   uvFile: string,
 *   meshes: number[][],
 * }} LightmapMeta
 */

/**
 * Fetch the sidecar, the UV array and the image.
 *
 * @param {string} base  directory the three files live in, e.g. `import.meta.env.BASE_URL`
 * @param {number} expectedTriangles  from the bake, to check the UV file against
 */
export async function loadLightmap(base, expectedTriangles) {
  const metaUrl = `${base}lightmap.json`;
  const metaResponse = await fetch(metaUrl, { cache: 'no-cache' });

  if (!metaResponse.ok) {
    throw new Error(
      `Could not load ${metaUrl} (HTTP ${metaResponse.status}). Run \`npm run bake\`.`
    );
  }

  /** @type {LightmapMeta} */
  const meta = await metaResponse.json();

  if (meta.format !== 'jjjs-lightmap') {
    throw new Error(`lightmap: unexpected format ${JSON.stringify(meta.format)}`);
  }

  const [uvBuffer, texture] = await Promise.all([
    fetch(`${base}${meta.uvFile}`, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${base}${meta.uvFile} (HTTP ${r.status})`);
      return r.arrayBuffer();
    }),
    loadTexture(`${base}lightmap.png`),
  ]);

  const uv = new Float32Array(uvBuffer);

  if (uv.length !== meta.triangles * 6) {
    throw new Error(
      `lightmap: uv file holds ${uv.length} floats, expected ${meta.triangles * 6}. ` +
        `The UV file and the metadata are from different bakes.`
    );
  }

  if (expectedTriangles !== undefined && meta.triangles !== expectedTriangles) {
    throw new Error(
      `lightmap: the bake covers ${meta.triangles} triangles but the scene has ` +
        `${expectedTriangles}. Geometry changed since the last bake — re-run ` +
        `\`npm run bake\`. Refusing to apply, since the light would land on the ` +
        `wrong surfaces.`
    );
  }

  return { meta, uv, texture };
}

/**
 * Load the PNG as a texture.
 *
 * `flipY` is left at its default of `true`, which pairs with the row reversal
 * done when writing the PNG: Blender's pixel buffer starts at the bottom-left
 * and a PNG's first scanline is the top, so the two flips cancel and V=0 lands
 * where Blender's V=0 is.
 */
export function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.channel = 1; // sample uv1, not uv
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = 4;
        texture.name = 'lightmap';
        resolve(texture);
      },
      undefined,
      () => reject(new Error(`Could not decode ${url}`))
    );
  });
}

/* ── Applying UVs ─────────────────────────────────────────────── */

/**
 * Write `uv1` onto each mesh's geometry, splitting the single UV array by the
 * per-mesh face ranges the bake recorded.
 *
 * The face ranges are keyed to mesh order, so a mesh whose geometry cannot be
 * de-indexed to match its recorded triangle count aborts rather than guessing —
 * a partial application would leave some surfaces lit and others black with no
 * indication which was which.
 *
 * @param {Float32Array} uv
 * @param {THREE.Object3D[]} meshes  in the same order the exporter used
 * @param {number[][]} faceTable     [triangleOffset, triangleCount] per mesh
 */
export function applyLightmapUvs(uv, meshes, faceTable) {
  if (meshes.length !== faceTable.length) {
    throw new Error(
      `lightmap: ${meshes.length} meshes but ${faceTable.length} face ranges. The ` +
        `runtime scene and the bake disagree about what to light.`
    );
  }

  const geometryOwner = new Map();
  let applied = 0;
  let cloned = 0;
  let converted = 0;
  let totalCorners = 0;
  let triangles = 0;

  for (let m = 0; m < meshes.length; m++) {
    const mesh = meshes[m];
    const [offset, count] = faceTable[m];

    let geometry = mesh.geometry;

    // Two meshes can share one geometry at different transforms, in which case
    // they need separate uv1 attributes — a shared one could not hold both.
    if (geometryOwner.has(geometry) && geometryOwner.get(geometry) !== mesh) {
      geometry = geometry.clone();
      mesh.geometry = geometry;
      cloned++;
    }
    geometryOwner.set(geometry, mesh);

    if (geometry.index) {
      geometry = geometry.toNonIndexed();
      mesh.geometry = geometry;
      converted++;
    }

    const corners = geometry.attributes.position.count;
    if (corners !== count * 3) {
      throw new Error(
        `lightmap: mesh ${m} has ${corners} corners but the bake recorded ` +
          `${count * 3} (${count} triangles). Refusing to apply mismatched UVs.`
      );
    }

    const uv1 = new Float32Array(corners * 2);
    const base = offset * 6;
    uv1.set(uv.subarray(base, base + count * 6));
    geometry.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));

    applied++;
    totalCorners += corners;
    triangles += count;
  }

  return { applied, cloned, converted, totalCorners, triangles };
}

/**
 * Meshes outside the bake still need a `uv1`, because three.js keys that
 * requirement off the *material* and materials are shared between indoors and
 * outdoors. Theirs points at a texel the importer explicitly cleared, so they
 * sample black and receive no baked light.
 *
 * The coordinate comes from the metadata rather than being a constant here.
 * There is exactly one place that knows the atlas is black there — the stage
 * that made it black — and a second copy of the number would be a silent
 * mismatch the day the atlas layout changed.
 *
 * @param {THREE.Object3D} root
 * @param {Set<THREE.Mesh>} baked  meshes the bake already covers
 * @param {number[]} blackUv  `[u, v]` from the sidecar
 */
export function ensureUv1ForUnbaked(root, baked, blackUv) {
  const [BLACK_U, BLACK_V] = blackUv ?? [0.002, 0.002];
  let added = 0;

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (baked.has(obj)) return;
    if (obj.geometry.getAttribute('uv1')) return;

    const count = obj.geometry.attributes.position?.count ?? 0;
    if (!count) return;

    const fill = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      fill[i * 2] = BLACK_U;
      fill[i * 2 + 1] = BLACK_V;
    }
    obj.geometry.setAttribute('uv1', new THREE.BufferAttribute(fill, 2));
    added++;
  });

  return added;
}

/* ── Applying to materials ────────────────────────────────────── */

/**
 * Point every standard material at the lightmap.
 *
 * Applied scene-wide rather than only to lightmapped meshes, because materials
 * are shared: `MAT.woodDark` dresses both a bedroom dresser and the garden
 * fence. Setting `lightMap` for one unavoidably sets it for the other, so the
 * meshes that should get no baked light are handled on the *geometry* side
 * instead — their `uv1` points at the empty corner.
 *
 * Materials without a `lightMap` slot and no lighting model — the sky's
 * `ShaderMaterial`, the unlit window-glow cards — are skipped.
 */
export function applyLightmap(scene, texture) {
  const materials = new Set();

  scene.traverse((obj) => {
    if (!obj.isMesh) return;
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const material of list) {
      if (!material || !material.isMeshStandardMaterial) continue;
      materials.add(material);
    }
  });

  for (const material of materials) {
    material.lightMap = texture;
    material.lightMapIntensity = 1;
    // Changing a map from null to a texture requires a program rebuild.
    material.needsUpdate = true;
  }

  return materials;
}

/**
 * Set the baked contribution.
 *
 * `lightMapIntensity` is a plain uniform read every frame, so this writes
 * through without touching `needsUpdate` — which matters, because it runs every
 * frame to follow the day/night curve and a program rebuild per frame would be
 * ruinous.
 *
 * The value folds together the bake's peak (which the 8-bit normalisation
 * divided out) and the day/night dimming, so there is one number to reason
 * about rather than two.
 */
export function setLightmapIntensity(materials, value) {
  for (const material of materials) material.lightMapIntensity = value;
}
