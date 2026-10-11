import * as THREE from 'three';
import { hashSeed, mulberry32 } from './utils.js';

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
