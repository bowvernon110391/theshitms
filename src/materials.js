import * as THREE from 'three';

/**
 * A single palette of shared materials. Everything in the scene pulls
 * from here so the whole house can be restyled in one place, and so the
 * renderer can batch far fewer material switches.
 */

const std = (color, opts = {}) =>
  new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.82,
    metalness: opts.metalness ?? 0.02,
    ...opts,
  });

export const MAT = {
  // ── Shell ────────────────────────────────────────────────────
  wallExterior: std(0xe8dcc6, { roughness: 0.92 }),
  wallExteriorTrim: std(0xf6f1e6, { roughness: 0.85 }),
  wallInterior: std(0xf2ece1, { roughness: 0.94 }),
  foundation: std(0x8d8578, { roughness: 0.95 }),
  bricks: std(0xb0866c, { roughness: 0.9 }),

  roof: std(0x4a3f3a, { roughness: 0.86 }),
  roofRidge: std(0x3a312d, { roughness: 0.8 }),
  gutter: std(0xe4e0d6, { roughness: 0.55, metalness: 0.25 }),

  // ── Openings ─────────────────────────────────────────────────
  frame: std(0xfbf8f2, { roughness: 0.55 }),
  floorTrim: std(0xe6dccb, { roughness: 0.7 }),
  door: std(0xa9764f, { roughness: 0.62 }),
  doorDark: std(0x8a5c3c, { roughness: 0.6 }),
  glass: new THREE.MeshStandardMaterial({
    color: 0xa8cfdd,
    roughness: 0.06,
    metalness: 0.1,
    transparent: true,
    opacity: 0.24,
  }),

  // ── Flooring ─────────────────────────────────────────────────
  oak: std(0xb98b58, { roughness: 0.68 }),
  oakDark: std(0x9a6f44, { roughness: 0.66 }),
  tile: std(0xe7e2d8, { roughness: 0.34, metalness: 0.04 }),
  tileDark: std(0xb9c2c6, { roughness: 0.3 }),
  carpet: std(0x9a8ba8, { roughness: 1.0 }),
  concrete: std(0xa8a49c, { roughness: 0.92 }),

  // ── Soft furnishings ─────────────────────────────────────────
  sofa: std(0x4d6b8a, { roughness: 0.95 }),
  sofaCushion: std(0x6c8cae, { roughness: 0.98 }),
  cushionWarm: std(0xd9a25f, { roughness: 0.98 }),
  rugWarm: std(0xc9a26a, { roughness: 1.0 }),
  rugCool: std(0x7591a8, { roughness: 1.0 }),
  rugSoft: std(0xb28fa6, { roughness: 1.0 }),
  bedFrame: std(0x6d5138, { roughness: 0.72 }),
  bedding: std(0xeef1f6, { roughness: 0.96 }),
  beddingAccent: std(0x7d9ac0, { roughness: 0.96 }),
  pillow: std(0xfbfcfe, { roughness: 0.98 }),

  // ── Woodwork ─────────────────────────────────────────────────
  woodLight: std(0xd8b483, { roughness: 0.7 }),
  woodMid: std(0x9c7248, { roughness: 0.7 }),
  woodDark: std(0x5f452e, { roughness: 0.68 }),
  woodWhite: std(0xf3efe6, { roughness: 0.62 }),

  // ── Metal & stone ────────────────────────────────────────────
  steel: std(0xbfc6cc, { roughness: 0.3, metalness: 0.82 }),
  steelDark: std(0x6e767d, { roughness: 0.38, metalness: 0.7 }),
  chrome: std(0xd8dde2, { roughness: 0.16, metalness: 0.95 }),
  counterTop: std(0x3d4146, { roughness: 0.42, metalness: 0.12 }),
  stone: std(0xcfcbc2, { roughness: 0.55 }),
  porcelain: std(0xf7f9fb, { roughness: 0.12 }),
  black: std(0x22262b, { roughness: 0.5 }),
  charcoal: std(0x383d44, { roughness: 0.66 }),

  // ── Appliances / screens ─────────────────────────────────────
  screen: new THREE.MeshStandardMaterial({
    color: 0x0a0d12,
    roughness: 0.14,
    metalness: 0.3,
    emissive: 0x1b3550,
    emissiveIntensity: 1,
  }),
  screenOff: std(0x14181e, { roughness: 0.2, metalness: 0.25 }),

  // ── Nature ───────────────────────────────────────────────────
  grass: std(0x6f9b52, { roughness: 1.0 }),
  grassPatch: std(0x7ba85c, { roughness: 1.0 }),
  foliage: std(0x3f7a3c, { roughness: 0.95 }),
  foliageLight: std(0x59934c, { roughness: 0.95 }),
  trunk: std(0x6b4f33, { roughness: 0.9 }),
  bush: std(0x4c8a45, { roughness: 1.0 }),
  flowerRed: std(0xc9556b, { roughness: 0.8 }),
  flowerYellow: std(0xdcbb52, { roughness: 0.8 }),
  fence: std(0xe9e4d8, { roughness: 0.8 }),
  path: std(0xc4b9a6, { roughness: 0.95 }),
  water: new THREE.MeshStandardMaterial({
    color: 0x2f9fd6,
    roughness: 0.08,
    metalness: 0.12,
    transparent: true,
    opacity: 0.78,
  }),

  // ── People ───────────────────────────────────────────────────
  skin: std(0xe8b48c, { roughness: 0.85 }),
  hair: std(0x3a2a1e, { roughness: 0.95 }),
};

/** Lamp glass — emitted material we ramp up after dark. */
export const LAMP_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xfff4dd,
  emissive: 0xffd79a,
  emissiveIntensity: 0,
  roughness: 0.4,
  transparent: true,
  opacity: 0.92,
});

/** Window glow card — an emissive quad seen from outside after dark. */
export const WINDOW_GLOW_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xffd9a0,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/**
 * Materials that get an emissive kick at nightfall.
 *
 * `WINDOW_GLOW_MATERIAL` is a shared singleton, so a single write drives every
 * window in the house. The lamp shade materials are not: each fixture gets its
 * own, tinted to match the light it casts (see `makeLampMaterial`), so they are
 * registered here as they are created.
 */
export const EMISSIVE_TARGETS = [
  { material: LAMP_MATERIAL, key: 'emissiveIntensity', max: 1.6 },
  { material: WINDOW_GLOW_MATERIAL, key: 'opacity', max: 0.55 },
];

/**
 * A lamp-shade material tuned to the colour of the light behind it.
 *
 * A shared shade material would be wrong as soon as the lights stopped being
 * uniformly warm: a lamp casting green into the room while its own shade glows
 * orange reads as two unrelated things. The shade has to be tinted to match.
 *
 * The albedo is lightened rather than set to the light's colour outright. A
 * shade's visible brightness is `emissive x emissiveIntensity` plus whatever
 * light lands *on* it, and a saturated albedo would swallow that second term,
 * leaving a lamp that looks like a flat coloured sprite up close.
 *
 * Registering the clone in `EMISSIVE_TARGETS` is what lets it fade up at dusk
 * with everything else, and is easy to forget: a clone of a tracked material is
 * not itself tracked, and the symptom would be a single lamp that never comes on.
 *
 * @param {THREE.Color|null} color  the light's colour, or null for the default
 * @returns {THREE.MeshStandardMaterial}
 */
export function makeLampMaterial(color) {
  if (!color) return LAMP_MATERIAL;

  const material = LAMP_MATERIAL.clone();
  material.emissive.copy(color);
  material.color.copy(color).lerp(new THREE.Color(0xffffff), 0.62);

  EMISSIVE_TARGETS.push({ material, key: 'emissiveIntensity', max: 1.6 });
  return material;
}
