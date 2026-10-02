/**
 * Layout data for the house.
 * All measurements are in metres (1 unit = 1 m, matching 2.7 m ceilings).
 * X runs left→right, Z runs front→back, Y is up.
 */

export const HOUSE = {
  width: 12, // X extent of the building footprint
  depth: 10, // Z extent
  wallHeight: 2.7,
  wallThickness: 0.16,
  floorThickness: 0.14,
  roofRise: 2.75,
  roofOverhang: 0.5,
  foundationLift: 0.22,
};

/**
 * Geometry is subdivided to roughly this spacing (in metres) as it is built.
 *
 * Baked lighting is carried on vertices, so a surface's lighting resolution is
 * its vertex density. A 4 m wall built from 8 corner vertices could only ever
 * show a flat wash of light; subdividing it to ~0.45 m gives it a real
 * gradient. This is the single knob that trades triangles for light quality.
 */
export const TESSEL = 0.45;

/** Clamp so a stray huge primitive can't explode the vertex count. */
export const MAX_SEGMENTS = 24;

/** Segment count for a span of `size` metres. */
export function segmentsFor(size, spacing = TESSEL) {
  return Math.max(1, Math.min(MAX_SEGMENTS, Math.round(Math.abs(size) / spacing)));
}

/** Opening presets, expressed in wall-height space. */
export const OPENING = {  door: { bottom: 0, top: 2.15 },
  arch: { bottom: 0, top: 2.3 },
  window: { bottom: 0.95, top: 2.15 },
  highWindow: { bottom: 1.45, top: 2.2 },
  patio: { bottom: 0, top: 2.25 },
};

/**
 * Rooms are axis-aligned rectangles in tile space.
 * `floor` selects a floor material, `accent` colours the UI chip, and
 * `lightIntensity` is the room's total light budget — see `CEILING_LAMPS` and
 * `ACCENT_LAMPS` for how it is divided up.
 *
 * There is deliberately no per-room light *colour* here: the colours are
 * generated from `LIGHT_PALETTE` so they can be re-rolled with `LIGHT_SEED`,
 * and a hand-set hex per room would silently win over nothing.
 */
export const ROOMS = [
  {
    id: 'living',
    name: 'Living Room',
    x0: 0, z0: 0, x1: 4, z1: 4,
    floor: 'oak',
    accent: 0xd9a066,
    lightIntensity: 16,
  },
  {
    id: 'dining',
    name: 'Dining Room',
    x0: 4, z0: 0, x1: 8, z1: 4,
    floor: 'oak',
    accent: 0xc98b56,
    lightIntensity: 14,
  },
  {
    id: 'kitchen',
    name: 'Kitchen',
    x0: 8, z0: 0, x1: 12, z1: 4,
    floor: 'tile',
    accent: 0x8fb8c9,
    lightIntensity: 18,
  },
  {
    id: 'hall',
    name: 'Hallway',
    x0: 0, z0: 4, x1: 12, z1: 6,
    floor: 'oak',
    accent: 0xb9a17e,
    lightIntensity: 12,
  },
  {
    id: 'bedroom',
    name: 'Bedroom',
    x0: 0, z0: 6, x1: 4, z1: 10,
    floor: 'carpet',
    accent: 0xa88bc4,
    lightIntensity: 10,
  },
  {
    id: 'bath',
    name: 'Bathroom',
    x0: 4, z0: 6, x1: 8, z1: 10,
    floor: 'tileDark',
    accent: 0x7fbfc9,
    lightIntensity: 12,
  },
  {
    id: 'office',
    name: 'Study',
    x0: 8, z0: 6, x1: 12, z1: 10,
    floor: 'oak',
    accent: 0x8aa87a,
    lightIntensity: 10,
  },
];

/**
 * Every wall is a straight run with a list of openings punched into it.
 *  dir: 'x' → the wall runs along X at a fixed Z (`at`)
 *  dir: 'z' → the wall runs along Z at a fixed X (`at`)
 *  from/to: extent along the run axis
 *  opening.kind: key into OPENING
 */
export const WALLS = [
  // ── Exterior shell ──────────────────────────────────────────
  {
    id: 'ext-front', dir: 'x', at: 0, from: 0, to: 12, exterior: true,
    openings: [
      { from: 1.4, to: 2.4, kind: 'door', door: 'front' },
      { from: 2.8, to: 3.8, kind: 'window' },
      { from: 5.6, to: 7.0, kind: 'window' },
      { from: 9.4, to: 10.8, kind: 'window' },
    ],
  },
  {
    id: 'ext-back', dir: 'x', at: 10, from: 0, to: 12, exterior: true,
    openings: [
      { from: 0.8, to: 2.4, kind: 'patio', door: 'patio' },
      { from: 5.6, to: 6.4, kind: 'highWindow' },
      { from: 9.2, to: 10.4, kind: 'window' },
    ],
  },
  {
    id: 'ext-left', dir: 'z', at: 0, from: 0, to: 10, exterior: true,
    openings: [
      { from: 1.4, to: 2.6, kind: 'window' },
      { from: 7.2, to: 8.2, kind: 'window' },
    ],
  },
  {
    id: 'ext-right', dir: 'z', at: 12, from: 0, to: 10, exterior: true,
    openings: [
      { from: 1.6, to: 2.8, kind: 'window' },
      { from: 7.2, to: 8.4, kind: 'window' },
    ],
  },

  // ── Front band dividers (open-plan living / dining / kitchen) ─
  {
    id: 'front-a', dir: 'z', at: 4, from: 0, to: 4, interior: true,
    // Squeezed toward the front so the living room keeps a solid wall
    // for the TV/console behind the sofa.
    openings: [{ from: 0.8, to: 2.4, kind: 'arch' }],
  },
  {
    id: 'front-b', dir: 'z', at: 8, from: 0, to: 4, interior: true,
    openings: [{ from: 0.9, to: 3.1, kind: 'arch' }],
  },

  // ── Back band dividers (private rooms) ────────────────────────
  { id: 'back-a', dir: 'z', at: 4, from: 6, to: 10, interior: true, openings: [] },
  { id: 'back-b', dir: 'z', at: 8, from: 6, to: 10, interior: true, openings: [] },

  // ── Long interior walls framing the hallway ───────────────────
  {
    id: 'hall-front', dir: 'x', at: 4, from: 0, to: 12, interior: true,
    openings: [
      { from: 1.6, to: 2.6, kind: 'door', door: 'swing' },
      { from: 5.6, to: 6.6, kind: 'door', door: 'swing' },
      { from: 9.4, to: 10.4, kind: 'door', door: 'swing' },
    ],
  },
  {
    id: 'hall-back', dir: 'x', at: 6, from: 0, to: 12, interior: true,
    openings: [
      { from: 1.6, to: 2.6, kind: 'door', door: 'swing' },
      { from: 5.5, to: 6.5, kind: 'door', door: 'swing' },
      { from: 9.4, to: 10.4, kind: 'door', door: 'swing' },
    ],
  },
];

/**
 * Ceiling-light positions, keyed by room id. **Every entry is one light.**
 *
 * There is no longer a "lanterns but one light" distinction: a room with three
 * spots gets three lights, each emitting a third of the room's budget, so the
 * room's total output is unchanged but the falloff across it is real. A single
 * centroid light in a 12 m hallway only ever lit the middle of it.
 *
 * Dining is deliberately absent — its pendant hangs over the table, and the old
 * ceiling light sat 30 cm from it, which was two sources fighting in the same
 * place rather than a room lit twice.
 */
export const CEILING_LAMPS = {
  living: [[1.9, 1.5], [2.6, 2.9]],
  kitchen: [[9.2, 1.2], [10.8, 2.8]],
  hall: [[1.6, 5], [6, 5], [10.4, 5]],
  bedroom: [[2, 8]],
  bath: [[6, 8.4]],
  office: [[10, 8]],
};

/**
 * Free-standing lamps, and the lights inside them.
 *
 * These are data rather than inline placements because each one has to exist
 * twice — as a fixture you can see, and as a light the bake can read. Writing
 * the coordinate once and deriving both from it is the only way the two stay in
 * agreement; hand-matching them across two files is exactly the kind of drift
 * that shows up as "the light is 20 cm to the left of the lamp".
 *
 * `intensity` is in three.js irradiance units, directly comparable to the
 * ceiling lights' `lightIntensity`. These are lower because a floor lamp is a
 * local pool of light, not a room's worth of it.
 *
 * `base` is the height of the surface the lamp stands on. `h`/`y`/`radius` are
 * passed through to the fixture builder.
 */
export const ACCENT_LAMPS = [
  // The dining pendant *is* the dining light — it hangs over the table, which
  // is where a dining room wants its light.
  {
    id: 'dining-pendant', kind: 'pendant', room: 'dining',
    x: 6.0, z: 2.3, y: 1.95, drop: 0.68, radius: 0.3,
    intensity: 15,
  },
  // Living: front corner, tucked behind the floor lamp's own shadow line from
  // the sofa, so it reads as a reading light rather than a second ceiling.
  {
    id: 'living-floor', kind: 'floorLamp', room: 'living',
    x: 3.5, z: 0.5, h: 1.55,
    intensity: 9,
  },
  // Bedroom: one on each nightstand. A pair, because a single bedside lamp
  // reads as an oversight and the symmetry is what sells it as a bedroom.
  {
    id: 'bedroom-lamp-a', kind: 'tableLamp', room: 'bedroom',
    x: 3.65, z: 9.6, base: 0.56, h: 0.36,
    intensity: 5.5,
  },
  {
    id: 'bedroom-lamp-b', kind: 'tableLamp', room: 'bedroom',
    x: 3.65, z: 7.2, base: 0.56, h: 0.36,
    intensity: 5.5,
  },
  // Study: standing lamp beside the armchair.
  {
    id: 'study-floor', kind: 'floorLamp', room: 'office',
    x: 8.5, z: 6.6, h: 1.5,
    intensity: 10,
  },
  // Hallway: on the console table, so the corridor gets a second pool of light
  // away from the three ceiling lamps.
  {
    id: 'hall-console', kind: 'tableLamp', room: 'hall',
    x: 3.85, z: 4.36, base: 0.78, h: 0.4,
    intensity: 6,
  },
];

/**
 * Re-rolls every light colour at once.
 *
 * The colours are seeded so a re-bake reproduces them exactly — an expensive
 * bake you cannot compare against the last one is close to useless. Change this
 * to get a different house.
 */
export const LIGHT_SEED = 20261002;

/**
 * Colour ranges for the two kinds of light, in HSL.
 *
 * Ceiling lights are constrained to a warm band: hue 34–56° is amber through to
 * pale gold, and the low saturation keeps them reading as "warm white" rather
 * than orange. That range *is* the "yellowish to whiteish" brief — expressed so
 * that blue is not something anyone has to remember not to pick.
 *
 * Accents get the whole wheel at high saturation, because the contrast between
 * a warm envelope and saturated pools of colour is the effect being asked for.
 * Lightness stays mid-range: too light desaturates them into white, too dark
 * leaves no headroom to actually tint the surfaces they reach.
 */
export const LIGHT_PALETTE = {
  ceiling: { hue: [34, 56], sat: [0.03, 0.28], light: [0.85, 0.99] },
  accent: { hue: [0, 360], sat: [0.72, 1.0], light: [0.5, 0.62] },
};

/** Camera presets. */
export const CAMERA = {
  home: { pos: [20, 15.5, -15.5], target: [6, 1.6, 5] },
  minDistance: 5,
  maxDistance: 46,
};
