import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { HOUSE, OPENING, ROOMS, WALLS, CEILING_LAMPS, LIGHT_PALETTE, LIGHT_SEED } from './config.js';
import { MAT, makeLampMaterial, WINDOW_GLOW_MATERIAL } from './materials.js';
import { box, boxC, cyl, sph, plane, group, markEmitter } from './utils.js';
import { lightColor } from './lightcolors.js';

const H = HOUSE.wallHeight;
const T = HOUSE.wallThickness;

/**
 * Finished floor level above the structural slab's top face.
 *
 * The slab's top and the room floor planes both used to land near y = 0 — 5 mm
 * apart, which is inside one depth-buffer step at normal viewing distance, so
 * they z-fought along every floor edge. The floor planes and the baseboards
 * that stand on them are lifted by this instead.
 */
export const FLOOR_OFFSET = 0.03;
/**
 * How far the plinth's TOP face sits BELOW the structural datum (y = 0).
 *
 * Both the plinth top and the slab top used to land on exactly y = 0, i.e. the
 * same world plane, and they overlap over the whole footprint (the plinth is
 * `width + 0.36`, the slab `width + 0.5`), so the two large horizontal faces
 * never resolved and shimmered along the whole building perimeter. The wall
 * bottoms also landed on that same plane. Dropping the plinth's top clearly
 * below the (sunk) slab top puts each of the three surfaces on its own depth.
 *
 * MUST be strictly greater than `SLAB_SINK`, or the plinth top collides with
 * the slab top again from below.
 */
const PLINTH_OFFSET = 0.05;

/** How far the plinth is inset from the slab's edge, per side. */
const PLINTH_INSET = 0.04;

/** How far the lawn sits below the plinth's bottom face, to break their coplanarity. */
const GROUND_DROP = 0.015;

/** Height of the frame head band above an opening's top edge. */
const HEAD_H = 0.09;

/** How far the roof is sunk into the wall tops, to clear their coplanar faces. */
const ROOF_SINK = 0.02;

/**
 * How far the structural slab's top face sits BELOW the structural datum
 * (y = 0), so it no longer shares a plane with every wall's bottom face.
 */
const SLAB_SINK = 0.02;

/* ────────────────────────────────────────────────────────────────
   Wall runs
   ──────────────────────────────────────────────────────────────── */

/**
 * Break one wall run into solid boxes around its openings, then decorate
 * every opening with a frame, glazing or a leaf.
 *
 * The per-run material is cloned so the cutaway system can fade this wall
 * without touching any other.
 */
function buildWallRun(spec) {
  const material = (spec.exterior ? MAT.wallExterior : MAT.wallInterior).clone();
  const g = new THREE.Group();
  g.name = `wall:${spec.id}`;

  const openings = [...spec.openings].sort((a, b) => a.from - b.from);

  /** A slab of wall spanning [a,b] from height y0 to y1. */
  const slab = (a, b, y0, y1, mat = material, inflate = 0) => {
    const len = b - a;
    const hgt = y1 - y0;
    if (len <= 0.0005 || hgt <= 0.0005) return null;
    const th = T + inflate;
    const geo =
      spec.dir === 'x'
        ? new THREE.BoxGeometry(len, hgt, th)
        : new THREE.BoxGeometry(th, hgt, len);
    const m = new THREE.Mesh(geo, mat);
    if (spec.dir === 'x') {
      m.position.set((a + b) / 2, (y0 + y1) / 2, spec.at);
    } else {
      m.position.set(spec.at, (y0 + y1) / 2, (a + b) / 2);
    }
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  let cursor = spec.from;
  for (const o of openings) {
    const preset = OPENING[o.kind] ?? OPENING.door;
    const isDoor = preset.bottom === 0;
    // The sill occupies the 7 cm band below a window's bottom edge. The wall
    // filler must stop at the sill's BOTTOM, not at `preset.bottom`, or the two
    // boxes overlap and their top faces coincide exactly at `preset.bottom` —
    // two coplanar faces, which z-fight. That is what shimmered along every
    // window sill (and, the same way, where the baseboard meets the wall).
    const sillT = isDoor ? 0 : 0.07;
    if (o.from > cursor) slab(cursor, o.from, 0, H);
    if (preset.bottom > 0) slab(o.from, o.to, 0, preset.bottom - sillT);
    // Filler above the opening. It starts slightly ABOVE the head's top, so the
    // head's top face lies just below the filler's bottom face rather than on
    // it. Running the filler from the head's top exactly (`preset.top + HEAD_H`)
    // is what a first pass did — and it simply relocated the coincidence: the
    // filler's bottom face then landed on the head's top face. A real overlap
    // (head poking up into the filler) has no shared plane at all.
    if (preset.top < H) slab(o.from, o.to, preset.top + HEAD_H + 0.004, H);
    cursor = o.to;
  }
  if (cursor < spec.to) slab(cursor, spec.to, 0, H);

  // Baseboard skirting, broken only where a door reaches the floor. It stands
  // ON the finished floor (`FLOOR_OFFSET`), not on the structural slab: sitting
  // it at y = 0 put its bottom face exactly on the wall slab's bottom face and
  // the slab top at once — three coincident planes, and a z-fight along the
  // skirting line.
  if (!spec.exterior) {
    const baseTop = FLOOR_OFFSET + 0.11;
    let baseCursor = spec.from;
    const floorBreaks = openings.filter((o) => (OPENING[o.kind] ?? OPENING.door).bottom === 0);
    for (const o of floorBreaks) {
      if (o.from > baseCursor) slab(baseCursor, o.from, FLOOR_OFFSET, baseTop, MAT.floorTrim, 0.035);
      baseCursor = o.to;
    }
    if (baseCursor < spec.to) slab(baseCursor, spec.to, FLOOR_OFFSET, baseTop, MAT.floorTrim, 0.035);
  }

  // Decorate the openings.
  for (const o of openings) {
    const preset = OPENING[o.kind] ?? OPENING.door;
    const isDoor = preset.bottom === 0;
    addFrame(g, spec, o, preset, isDoor);

    if (o.kind === 'window' || o.kind === 'highWindow') addGlazing(g, spec, o, preset);
    if (o.door === 'patio') addPatioDoor(g, spec, o, preset);
    else if (o.door) addDoorLeaf(g, spec, o, preset, o.door);
  }

  const mid = (spec.from + spec.to) / 2;
  const center = new THREE.Vector3(
    spec.dir === 'x' ? mid : spec.at,
    H / 2,
    spec.dir === 'x' ? spec.at : mid
  );

  return { group: g, material, center, spec, length: spec.to - spec.from };
}

/** Jambs, head and sill around an opening. */
function addFrame(parent, spec, o, preset, isDoor) {
  const th = T + 0.05;
  const jamb = 0.075;
  const at = spec.at;
  const along = (a, b, y0, y1, thk = th) => {
    const len = b - a;
    const hgt = y1 - y0;
    const geo =
      spec.dir === 'x' ? new THREE.BoxGeometry(len, hgt, thk) : new THREE.BoxGeometry(thk, hgt, len);
    const m = new THREE.Mesh(geo, MAT.frame);
    if (spec.dir === 'x') m.position.set((a + b) / 2, (y0 + y1) / 2, at);
    else m.position.set(at, (y0 + y1) / 2, (a + b) / 2);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // Jambs stop 5 mm short of `preset.top` and the head begins exactly there:
  // running the jambs all the way to `preset.top` made their TOP faces coincide
  // with the head's BOTTOM face (same y, same z, overlapping x over each jamb's
  // 7.5 cm) — coplanar faces, which z-fight along the entire head. This mirrors
  // the sill fix below.
  along(o.from - jamb, o.from, preset.bottom, preset.top - 0.005); // left jamb
  along(o.to, o.to + jamb, preset.bottom, preset.top - 0.005); // right jamb
  along(o.from - jamb, o.to + jamb, preset.top, preset.top + HEAD_H); // head
  if (!isDoor) {
    // The sill tucks under the jambs and fills the 7 cm band below the opening.
    // It stops 5 mm short of `preset.bottom` at the top, and starts 5 mm BELOW
    // the wall filler's top edge, so it shares no plane with either: running it
    // to exactly `preset.bottom` put its top face on each jamb's bottom face,
    // and running its bottom to exactly the filler top put the sill's bottom
    // face on the filler's top face. Either way: coplanar faces, z-fighting
    // along the whole sill line. Now it overlaps both by a hair instead.
    along(o.from - jamb, o.to + jamb, preset.bottom - 0.07 - 0.005, preset.bottom - 0.005);
  }
}

/** Glass plus a warm glow card for evening. */
function addGlazing(parent, spec, o, preset) {
  const w = o.to - o.from;
  const h = preset.top - preset.bottom;
  const midAlong = (o.from + o.to) / 2;
  const midY = (preset.bottom + preset.top) / 2;

  const x = spec.dir === 'x' ? midAlong : spec.at;
  const z = spec.dir === 'x' ? spec.at : midAlong;

  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), MAT.glass);
  glass.position.set(x, midY, z);
  if (spec.dir === 'z') glass.rotation.y = Math.PI / 2;
  parent.add(glass);

  // Mullion: a single vertical divider for wide windows.
  if (w > 1.1) {
    const bar = new THREE.Mesh(
      spec.dir === 'x' ? new THREE.BoxGeometry(0.05, h, T + 0.03) : new THREE.BoxGeometry(T + 0.03, h, 0.05),
      MAT.frame
    );
    bar.position.set(x, midY, z);
    parent.add(bar);
  }

  // Outward-facing glow card, visible as dusk falls.
  const outward = outwardNormal(spec);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.06, h - 0.06), WINDOW_GLOW_MATERIAL);
  glow.position.set(x + outward.x * 0.1, midY, z + outward.z * 0.1);
  if (spec.dir === 'z') glow.rotation.y = Math.PI / 2;
  glow.userData.noMerge = true;
  parent.add(glow);
}

/** Hinged interior/front door, standing ajar. */
function addDoorLeaf(parent, spec, o, preset, kind) {
  const w = o.to - o.from;
  const h = preset.top;
  const hingeAt = o.from;
  const intoRoom = spec.exterior ? 1 : 1;
  const sign = spec.dir === 'x' ? 1 : -1;

  const pivot = new THREE.Group();
  if (spec.dir === 'x') pivot.position.set(hingeAt, 0, spec.at);
  else pivot.position.set(spec.at, 0, hingeAt);

  const leaf = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, 0.06),
    kind === 'front' ? MAT.doorDark : MAT.door
  );
  leaf.position.set(w / 2, h / 2, 0);
  leaf.castShadow = true;
  leaf.receiveShadow = true;
  pivot.add(leaf);

  // Knob on the free edge.
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), MAT.chrome);
  knob.position.set(w - 0.14, h * 0.47, 0.06);
  pivot.add(knob);

  // Panel detail.
  const inset = new THREE.Mesh(new THREE.BoxGeometry(w - 0.24, h * 0.34, 0.02), MAT.woodDark);
  inset.position.set(w / 2, h * 0.3, 0.04);
  pivot.add(inset);

  pivot.rotation.y = (spec.dir === 'x' ? 1 : 1) * sign * (0.62 * intoRoom);
  pivot.userData.noMerge = true;
  parent.add(pivot);
}

/** Sliding glass patio door. */
function addPatioDoor(parent, spec, o, preset) {
  const w = o.to - o.from;
  const h = preset.top;
  const midAlong = (o.from + o.to) / 2;
  const x = spec.dir === 'x' ? midAlong : spec.at;
  const z = spec.dir === 'x' ? spec.at : midAlong;

  const makePane = (offset, along) => {
    const frame = new THREE.Group();
    const leaf = new THREE.Mesh(
      spec.dir === 'x' ? new THREE.BoxGeometry(along, h, 0.05) : new THREE.BoxGeometry(0.05, h, along),
      MAT.glass
    );
    leaf.position.set(x + (spec.dir === 'x' ? offset : 0), h / 2, z + (spec.dir === 'z' ? offset : 0));
    frame.add(leaf);

    const rail = new THREE.Mesh(
      spec.dir === 'x' ? new THREE.BoxGeometry(along, 0.1, 0.07) : new THREE.BoxGeometry(0.07, 0.1, along),
      MAT.frame
    );
    rail.position.set(x + (spec.dir === 'x' ? offset : 0), 0.05, z + (spec.dir === 'z' ? offset : 0));
    frame.add(rail);

    const rail2 = rail.clone();
    rail2.position.y = h - 0.05;
    frame.add(rail2);

    frame.userData.noMerge = true;
    parent.add(frame);
  };

  makePane(-0.03, w * 0.52);
  makePane(0.04, w * 0.52);
}

/** Unit vector pointing away from the house centre for a perimeter run. */
function outwardNormal(spec) {
  const cx = HOUSE.width / 2;
  const cz = HOUSE.depth / 2;
  if (spec.dir === 'x') return new THREE.Vector3(0, 0, spec.at < cz ? -1 : 1);
  return new THREE.Vector3(spec.at < cx ? -1 : 1, 0, 0);
}

/* ────────────────────────────────────────────────────────────────
   Floors
   ──────────────────────────────────────────────────────────────── */

function buildFloors() {
  const g = new THREE.Group();
  g.name = 'floors';

  // Structural slab under everything. Its TOP face lands at `-SLAB_SINK` below
  // the structural datum (y = 0 local = `foundationLift` world), NOT on it:
  // every exterior and interior wall bottom sits on y = 0, so a slab top at
  // exactly y = 0 was coplanar with all of them and shimmered wherever a wall
  // met the base. Sinking the slab by this much hands the wall bottoms their own
  // depth. The finished floor is lifted clear by `FLOOR_OFFSET` regardless.
  const slab = box(
    HOUSE.width + 0.5, HOUSE.floorThickness, HOUSE.depth + 0.5,
    MAT.concrete,
    [HOUSE.width / 2, -HOUSE.floorThickness - SLAB_SINK, HOUSE.depth / 2]
  );
  slab.userData.noMerge = true;
  g.add(slab);

  const floorMat = {
    oak: MAT.oak,
    tile: MAT.tile,
    tileDark: MAT.tileDark,
    carpet: MAT.carpet,
  };

  for (const room of ROOMS) {
    const w = room.x1 - room.x0;
    const d = room.z1 - room.z0;
    // Tessellated: the floor is the surface where a lamp's falloff is most
    // visible, and a single quad could not show it at all.
    //
    // Lifted clear of the slab's top face by FLOOR_OFFSET. At the old 5 mm the
    // floor plane and the slab top fought in the depth buffer; `FLOOR_OFFSET`
    // also fixes the finished floor level, which the baseboards sit on.
    const mesh = plane(w - 0.02, d - 0.02, floorMat[room.floor] ?? MAT.oak, [
      (room.x0 + room.x1) / 2,
      FLOOR_OFFSET,
      (room.z0 + room.z1) / 2,
    ], 0, true);
    mesh.receiveShadow = true;
    g.add(mesh);
  }

  // A shadow-catcher outside so the house reads as grounded. Too large to
  // tessellate, and deliberately excluded from the bake — sunlight and the
  // lamp post light it, interior lamps must not.
  //
  // Sits just BELOW the plinth's bottom face (which is at world y = 0) rather
  // than exactly on it: two coplanar horizontal surfaces at y = 0 z-fought along
  // the whole plinth perimeter, which read as a crawling edge where the base
  // meets the lawn.
  const ground = plane(120, 120, MAT.grass, [
    HOUSE.width / 2,
    -HOUSE.foundationLift - GROUND_DROP,
    HOUSE.depth / 2,
  ]);
  ground.userData.noMerge = true;
  ground.userData.noBake = true;
  ground.name = 'ground';
  g.add(ground);

  return g;
}

/* ────────────────────────────────────────────────────────────────
   Roof
   ──────────────────────────────────────────────────────────────── */

function buildRoof() {
  const g = new THREE.Group();
  g.name = 'roof';

  const w = HOUSE.width + HOUSE.roofOverhang * 2;
  const d = HOUSE.depth + HOUSE.roofOverhang * 2;
  const rise = HOUSE.roofRise;

  // Gable profile drawn in the shape's XY plane, then extruded across.
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2, 0);
  shape.lineTo(0, rise);
  shape.lineTo(d / 2, 0);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
  geo.translate(0, 0, -w / 2);
  geo.rotateY(-Math.PI / 2);

  const roof = new THREE.Mesh(geo, MAT.roof);
  roof.castShadow = true;
  roof.receiveShadow = true;
  // Sunk by `ROOF_SINK` into the wall tops. At exactly H the roof's flat bottom
  // face was coplanar with the top face of EVERY wall (same y, overlapping over
  // the whole eaves line — up to 0.8 m² per run), which z-fought along the
  // roof/wall junction. Overlapping the roof into the walls by a couple of
  // centimetres removes the shared plane entirely; the eaves hide the overlap.
  roof.position.set(HOUSE.width / 2, H - ROOF_SINK, HOUSE.depth / 2);
  // Above every interior lamp, so a bake would give it nothing but would
  // still cost vertices.
  roof.userData.noBake = true;
  g.add(roof);

  // Ridge cap.
  const ridge = boxC(w + 0.1, 0.16, 0.3, MAT.roofRidge, [HOUSE.width / 2, H + rise + 0.02, HOUSE.depth / 2]);
  g.add(ridge);

  // Fascia along both eaves.
  for (const z of [-d / 2, d / 2]) {
    const fascia = boxC(w, 0.18, 0.1, MAT.gutter, [HOUSE.width / 2, H - 0.02, HOUSE.depth / 2 + z]);
    g.add(fascia);
  }

  // Chimney. The stack boxes are OVERLAPPED by a few centimetres rather than
  // butted: butting them put each upper box's bottom face exactly on the box
  // below's top face (coplanar, same footprint) — the same z-fight class as the
  // base. A small overlap means no two faces share a plane.
  const chimney = group('chimney', [
    box(0.9, 0.9, 0.9, MAT.bricks, [3.4, H + 0.4, 7.4]),
    box(1.06, 0.16, 1.06, MAT.stone, [3.4, H + 0.4 + 0.9 - 0.02, 7.4]),
    box(0.42, 0.22, 0.42, MAT.black, [3.4, H + 0.4 + 0.9 + 0.16 - 0.03, 7.4]),
  ]);
  g.add(chimney);

  return g;
}

/* ────────────────────────────────────────────────────────────────
   Ceiling lights
   ──────────────────────────────────────────────────────────────── */

function buildCeilingLamp(x, z, color) {
  const g = new THREE.Group();
  const y = H - 0.34;
  const glass = makeLampMaterial(color);

  g.add(cyl(0.014, 0.014, 0.24, MAT.steelDark, [x, y + 0.34, z], 6));

  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.3, 0.24, 20, 1, true),
    glass
  );
  shade.position.set(x, y, z);
  shade.rotation.x = Math.PI;
  g.add(shade);

  g.add(sph(0.085, glass, [x, y - 0.06, z], 12));

  // The room's light is defined at H - 0.5, which sits just under this bulb and
  // shade — so without this the fixture shadows its own lamp.
  markEmitter(g);
  return g;
}

/** Every ceiling fixture, flattened, so the mesh and its light are made together. */
function ceilingFixtures() {
  const out = [];

  for (const room of ROOMS) {
    const spots = CEILING_LAMPS[room.id];
    if (!spots) continue;

    spots.forEach(([x, z], index) => {
      out.push({ room, x, z, index, count: spots.length });
    });
  }

  return out;
}

/**
 * The ceiling lamp meshes, and the *description* of each light rather than a
 * `THREE.PointLight`.
 *
 * The lights are not part of the scene: they are baked offline into the atlas
 * and the probe volume, which is what gives them shadows and stops them pouring
 * through the walls. Keeping them as plain numbers here lets the bake read them
 * without touching the scene graph.
 *
 * One light per fixture. A room with three spots used to get a single light at
 * their centroid, which is why a long room read as lit from nowhere in
 * particular — a centroid light in a 12 m hallway only lights the middle of it.
 */
function buildInteriorLights() {
  const g = new THREE.Group();
  g.name = 'interiorLights';

  /** @type {Array<{position: number[], color: THREE.Color, intensity: number, distance: number, decay: number, name: string}>} */
  const lightSpecs = [];

  for (const { room, x, z, index, count } of ceilingFixtures()) {
    const name = `light:${room.id}-${index + 1}`;
    const color = lightColor(name, LIGHT_PALETTE.ceiling, LIGHT_SEED);

    g.add(buildCeilingLamp(x, z, color));

    lightSpecs.push({
      name,
      color,
      position: [x, H - 0.5, z],
      // Divided by the number of fixtures rather than repeated at full
      // strength: the room used to be lit by one light at this intensity, so
      // splitting it keeps the room's total output where it was while giving
      // the falloff a real shape across the floor.
      intensity: ((room.lightIntensity ?? 12) * 1.7) / count,
      distance: 12,
      decay: 2,
    });
  }

  return { group: g, lightSpecs };
}

/* ────────────────────────────────────────────────────────────────
   Room labels
   ──────────────────────────────────────────────────────────────── */

/**
 * Room labels are DOM elements, so they only exist in a browser. The offline
 * bake imports this module in Node, where `document` is undefined.
 */
function buildLabels() {
  const labels = [];
  if (typeof document === 'undefined') return labels;

  for (const room of ROOMS) {
    const el = document.createElement('div');
    el.className = 'room-label';
    el.textContent = room.name;
    const obj = new CSS2DObject(el);
    obj.position.set((room.x0 + room.x1) / 2, H + 0.42, (room.z0 + room.z1) / 2);
    obj.center.set(0.5, 0.5);
    labels.push({ room, obj, el });
  }
  return labels;
}

/* ────────────────────────────────────────────────────────────────
   Assembly
   ──────────────────────────────────────────────────────────────── */

/**
 * @returns {{
 *   group: THREE.Group,
 *   wallLines: Array<{group: THREE.Group, material: THREE.Material, center: THREE.Vector3}>,
 *   wallMaterials: THREE.Material[],
 *   roof: THREE.Group,
 *   lightSpecs: Array<{position: number[], color: THREE.Color, intensity: number}>,
 *   labels: Array<{room: object, obj: CSS2DObject, el: HTMLElement}>,
 *   ground: THREE.Object3D
 * }}
 */
export function buildHouse({ labels: withLabels = true } = {}) {
  const root = new THREE.Group();
  root.name = 'house';
  root.position.y = HOUSE.foundationLift;

  // Foundation plinth, visible as a lip around the building.
  //
  // Placed at the footprint's CENTRE: room and wall geometry is laid out from
  // 0..width rather than centred on the group origin, so a plinth at (0, 0)
  // would sit half a footprint off — protruding on the -X/-Z side and absent
  // under the rest of the house.
  const plinth = box(
    HOUSE.width + 0.36 - PLINTH_INSET * 2,
    HOUSE.foundationLift - PLINTH_OFFSET,
    HOUSE.depth + 0.36 - PLINTH_INSET * 2,
    MAT.foundation,
    [HOUSE.width / 2, -HOUSE.foundationLift, HOUSE.depth / 2]
  );
  plinth.userData.noMerge = true;
  // Below finished floor level and outside the walls, so no interior lamp can
  // reach it. Baking it would spend atlas texels on a surface that is almost
  // entirely hidden by the walls above it.
  plinth.userData.noBake = true;
  root.add(plinth);

  const floors = buildFloors();
  root.add(floors);

  const wallsGroup = new THREE.Group();
  wallsGroup.name = 'walls';
  const wallLines = [];
  for (const spec of WALLS) {
    const line = buildWallRun(spec);
    wallsGroup.add(line.group);
    wallLines.push({
      group: line.group,
      material: line.material,
      center: line.center.clone().add(new THREE.Vector3(0, HOUSE.foundationLift, 0)),
      spec,
      length: line.length,
    });
  }
  root.add(wallsGroup);

  const roof = buildRoof();
  root.add(roof);

  const { group: lightGroup, lightSpecs } = buildInteriorLights();
  root.add(lightGroup);

  const labels = withLabels ? buildLabels() : [];
  for (const l of labels) root.add(l.obj);

  return {
    group: root,
    wallLines,
    wallMaterials: wallLines.map((w) => w.material),
    roof,
    lightSpecs,
    labels,
    ground: floors.getObjectByName('ground'),
  };
}
