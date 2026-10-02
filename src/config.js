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
 * `floor` selects a floor material, `accent` colours the UI chip,
 * `light` is the warm ceiling-light tint.
 */
export const ROOMS = [
  {
    id: 'living',
    name: 'Living Room',
    x0: 0, z0: 0, x1: 4, z1: 4,
    floor: 'oak',
    accent: 0xd9a066,
    light: 0xffd9a8,
    lightIntensity: 16,
  },
  {
    id: 'dining',
    name: 'Dining Room',
    x0: 4, z0: 0, x1: 8, z1: 4,
    floor: 'oak',
    accent: 0xc98b56,
    light: 0xffcf9a,
    lightIntensity: 14,
  },
  {
    id: 'kitchen',
    name: 'Kitchen',
    x0: 8, z0: 0, x1: 12, z1: 4,
    floor: 'tile',
    accent: 0x8fb8c9,
    light: 0xfff0d0,
    lightIntensity: 18,
  },
  {
    id: 'hall',
    name: 'Hallway',
    x0: 0, z0: 4, x1: 12, z1: 6,
    floor: 'oak',
    accent: 0xb9a17e,
    light: 0xffe3bd,
    lightIntensity: 12,
    ceilingLamps: 3,
  },
  {
    id: 'bedroom',
    name: 'Bedroom',
    x0: 0, z0: 6, x1: 4, z1: 10,
    floor: 'carpet',
    accent: 0xa88bc4,
    light: 0xffc9a3,
    lightIntensity: 10,
  },
  {
    id: 'bath',
    name: 'Bathroom',
    x0: 4, z0: 6, x1: 8, z1: 10,
    floor: 'tileDark',
    accent: 0x7fbfc9,
    light: 0xdcefff,
    lightIntensity: 12,
  },
  {
    id: 'office',
    name: 'Study',
    x0: 8, z0: 6, x1: 12, z1: 10,
    floor: 'oak',
    accent: 0x8aa87a,
    light: 0xffe0b0,
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

/** Ceiling-light positions, keyed by room id. */
export const CEILING_LAMPS = {
  living: [[2, 2], [2, 3.2]],
  dining: [[6, 2]],
  kitchen: [[9.2, 1.2], [10.8, 2.8]],
  hall: [[1.6, 5], [6, 5], [10.4, 5]],
  bedroom: [[2, 8]],
  bath: [[6, 8.4]],
  office: [[10, 8]],
};

/** Camera presets. */
export const CAMERA = {
  home: { pos: [20, 15.5, -15.5], target: [6, 1.6, 5] },
  minDistance: 5,
  maxDistance: 46,
};
