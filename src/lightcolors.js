import * as THREE from 'three';

/**
 * Deterministic "random" colours for the interior lights.
 *
 * ## Why seeded rather than actually random
 *
 * A light colour is an *input to a bake*, and a bake is expensive and meant to
 * be comparable. Tying the colours to `Math.random()` would make every re-bake
 * differ for no visible reason: you could not tell a colour change from a
 * sampling change, and the atlas would never be reproducible. So the colours
 * are drawn from a seeded stream keyed on each light's own name, which gives
 * the arranged-but-arbitrary look without giving up the ability to re-run.
 *
 * Change `LIGHT_SEED` in `config.js` to re-roll the whole house at once.
 *
 * ## Why HSL rather than a hex list
 *
 * The brief was a *range* — "yellowish to whiteish" for the ceilings, "wild"
 * for everything else — and a hand-written list of hexes encodes a range badly:
 * it is a fixed set of samples rather than the range itself, and widening it
 * means inventing more literals. Ranges over hue/saturation/lightness express
 * the constraint directly, so "never blue" is a property of the code rather
 * than of a palette someone has to keep remembering not to violate.
 */

/**
 * FNV-1a, 32-bit.
 *
 * Any stable string hash would do; this one is short, has good avalanche and
 * needs no state. It exists so a light's colour is a pure function of its name,
 * which means reordering the fixtures cannot secretly recolour the house.
 */
function hashSeed(text) {
  let h = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return h >>> 0;
}

/**
 * mulberry32 — a small, fast, well-distributed PRNG.
 *
 * `Math.sin(seed)` style hashes are the usual shortcut here and are worth
 * avoiding: they correlate for nearby seeds, which would show up as adjacent
 * lights getting near-identical hues.
 */
function mulberry32(seed) {
  let a = seed >>> 0;

  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A colour drawn from `range`, determined by `name` and `salt`.
 *
 * @param {string} name   the light's own name, so the result follows the light
 * @param {{hue: number[], sat: number[], light: number[]}} range
 *        each entry an inclusive `[min, max]`; hue in degrees, the others 0..1
 * @param {number|string} [salt]  changes every colour at once, without renaming
 * @returns {THREE.Color}
 */
export function lightColor(name, range, salt = 0) {
  const next = mulberry32(hashSeed(`${salt}:${name}`));

  const pick = ([lo, hi]) => lo + (hi - lo) * next();

  // Authored in sRGB, not the linear working space. `setHSL` defaults to the
  // working space, which would interpret these as already-linear values and
  // produce something noticeably darker and more saturated than intended —
  // sRGB is the space these numbers are chosen in because it is the one a
  // person reading "yellowish to whiteish" is thinking in.
  return new THREE.Color().setHSL(
    pick(range.hue) / 360,
    pick(range.sat),
    pick(range.light),
    THREE.SRGBColorSpace
  );
}
