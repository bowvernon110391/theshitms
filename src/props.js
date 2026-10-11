import * as THREE from 'three';
import { MAT, LAMP_MATERIAL } from './materials.js';
import { box, boxC, cyl, sph, plane, group, randFor } from './utils.js';

/**
 * The yard: boundary fence, front path, back deck, pool, planting and a
 * letterbox. Returns the visual group plus light *descriptors* — the caller
 * turns those into real lights, so this subtree stays mergeable.
 */

const YARD = { x0: -5, x1: 17, z0: -6, z1: 16 };
const DECK_Y = 0.22;

/** `group.add(x)` returns the PARENT — keep the child when rotating it. */
function addRot(parent, child, rx = 0, ry = 0, rz = 0) {
  child.rotation.set(rx, ry, rz);
  parent.add(child);
  return child;
}

/** `group.add(x)` returns the PARENT — keep the child when scaling it. */
function addScaled(parent, child, sx, sy, sz) {
  child.scale.set(sx, sy, sz);
  parent.add(child);
  return child;
}

/* ── Fence ────────────────────────────────────────────────────── */

function fenceRun(g, from, to, fixed, axis) {
  const postEvery = 2.0;
  const height = 1.05;
  const picketW = 0.075;
  const gap = 0.24;
  const step = picketW + gap;
  const len = to - from;

  // Posts first so pickets can be laid between them.
  for (let t = from; t <= to + 0.001; t += postEvery) {
    const post = box(0.13, height + 0.16, 0.13, MAT.fence, [0, 0, 0]);
    post.position.y = (height + 0.16) / 2;
    post.position.x = axis === 'x' ? Math.min(t, to) : fixed;
    post.position.z = axis === 'x' ? fixed : Math.min(t, to);
    g.add(post);
  }

  // Top and bottom rails.
  for (const y of [height - 0.3, height - 0.72]) {
    const rail = box(axis === 'x' ? len : 0.06, 0.07, axis === 'x' ? 0.06 : len, MAT.fence, [0, 0, 0]);
    rail.position.y = y;
    rail.position.x = axis === 'x' ? (from + to) / 2 : fixed;
    rail.position.z = axis === 'x' ? fixed : (from + to) / 2;
    g.add(rail);
  }

  // Pickets.
  for (let t = from + 0.2; t < to - 0.1; t += step) {
    const picket = box(picketW, height, picketW, MAT.fence, [0, 0, 0]);
    picket.position.y = height / 2;
    picket.position.x = axis === 'x' ? t : fixed;
    picket.position.z = axis === 'x' ? fixed : t;
    g.add(picket);
  }
}

function buildFence() {
  const g = group('fence');
  // Front boundary, with a gap for the gate and the path.
  fenceRun(g, YARD.x0, 0.9, YARD.z0, 'x');
  fenceRun(g, 3.0, YARD.x1, YARD.z0, 'x');
  fenceRun(g, YARD.x0, YARD.x1, YARD.z1, 'x');
  fenceRun(g, YARD.z0, YARD.z1, YARD.x0, 'z');
  fenceRun(g, YARD.z0, 5.4, YARD.x1, 'z');
  fenceRun(g, 7.0, YARD.z1, YARD.x1, 'z');

  // Gate: two leaves standing open either side of the path.
  for (const [x, ry] of [[0.9, -0.55], [3.0, 0.55]]) {
    const leaf = group('gateLeaf', [
      box(2.0, 0.06, 0.05, MAT.fence, [0, 0.95, 0]),
      box(2.0, 0.06, 0.05, MAT.fence, [0, 0.35, 0]),
      box(2.0, 0.06, 0.05, MAT.fence, [0, 0.65, 0]),
      box(0.1, 1.0, 0.06, MAT.fence, [0, 0.05, 0]),
      box(0.1, 1.0, 0.06, MAT.fence, [1.9, 0.05, 0]),
    ]);
    leaf.position.set(x, 0, YARD.z0);
    leaf.rotation.y = ry + (x < 2 ? 0 : Math.PI);
    g.add(leaf);
  }
  return g;
}

/* ── Path & driveway ──────────────────────────────────────────── */

function buildPath() {
  const g = group('path');

  // Flagstones from the gate to the front door, which sits at x ≈ 1.9.
  let z = -0.4;
  let i = 0;
  while (z > YARD.z0 + 0.4) {
    const slab = box(1.15 + (i % 2) * 0.12, 0.05, 0.62, MAT.path, [1.9 + (i % 3) * 0.03, 0.01, z]);
    g.add(slab);
    z -= 0.78;
    i++;
  }

  // Driveway slab along the right-hand side.
  const drive = box(3.6, 0.06, 11.0, MAT.concrete, [14.6, 0.0, 1.0]);
  drive.receiveShadow = true;
  g.add(drive);

  // Stepping stones from the driveway to the gate.
  for (let k = 0; k < 5; k++) {
    g.add(box(0.7, 0.04, 0.55, MAT.path, [12.4 - k * 1.7, 0.01, -2.2 - k * 0.55]));
  }

  // Apron: a small paved area in front of the door.
  g.add(box(2.4, 0.05, 0.5, MAT.path, [1.9, 0.01, -0.1]));

  return g;
}

/* ── Back deck & pool ─────────────────────────────────────────── */

function buildDeck() {
  const g = group('deck');

  // Plank deck outside the bedroom patio door (x 0.8–2.4 on z = 10).
  const x0 = -1.0;
  const x1 = 4.6;
  const z0 = 10.2;
  const z1 = 13.4;

  const frameH = DECK_Y;
  g.add(box(x1 - x0, frameH, z1 - z0, MAT.woodDark, [(x0 + x1) / 2, 0, (z0 + z1) / 2]));

  const plankW = 0.26;
  const gap = 0.03;
  let x = x0 + 0.1;
  let tint = 0;
  while (x < x1 - 0.1) {
    const plank = box(plankW, 0.06, z1 - z0 - 0.1, tint % 2 ? MAT.woodMid : MAT.woodLight, [
      x + plankW / 2, frameH, (z0 + z1) / 2,
    ]);
    g.add(plank);
    x += plankW + gap;
    tint++;
  }

  // Step down to the lawn.
  g.add(box(1.6, 0.11, 0.4, MAT.woodDark, [1.8, 0, z1 + 0.2]));

  // Deck chairs + side table.
  const chair = (cx, cz, ry) => {
    const c = group('deckChair');
    c.add(box(0.62, 0.06, 0.62, MAT.woodLight, [0, 0.34, 0]));
    c.add(box(0.62, 0.06, 0.7, MAT.woodLight, [0, 0.72, -0.32], 0));
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      c.add(box(0.06, 0.34, 0.06, MAT.woodDark, [sx * 0.26, 0, sz * 0.26]));
    }
    c.position.set(cx, DECK_Y + 0.06, cz);
    c.rotation.y = ry;
    return c;
  };
  g.add(chair(0.3, 11.4, 0.15));
  g.add(chair(1.5, 11.4, -0.1));
  g.add(box(0.42, 0.44, 0.42, MAT.woodMid, [0.9, DECK_Y + 0.06, 12.2]));

  return g;
}

function buildPool() {
  const g = group('pool');
  const px0 = 6.6;
  const px1 = 10.6;
  const pz0 = 11.6;
  const pz1 = 14.6;
  const w = px1 - px0;
  const d = pz1 - pz0;
  const cx = (px0 + px1) / 2;
  const cz = (pz0 + pz1) / 2;

  // `box()` anchors Y by its BASE but X/Z by its CENTRE, so every piece below
  // is placed on (cx, cz) and sized outward. An earlier version subtracted half
  // an extent from X/Z as well — treating the position as a min-corner — which
  // shifted the surround, basin floor and three of the four rim pieces 2–2.8 m
  // toward -X while the water stayed put, leaving the frame off its own basin.
  const rimH = 0.2;
  const rimT = 0.34;
  const innerW = w + rimT * 2; // rim outer footprint, X
  const innerD = d + rimT * 2; // rim outer footprint, Z
  const rimBase = 0.06; // rim sits on the paving slab
  const rimTop = rimBase + rimH;

  // Paved surround, then a raised stone rim built as a frame so the basin
  // is genuinely open in the middle.
  g.add(box(w + 1.6, 0.06, d + 1.6, MAT.path, [cx, 0, cz]));

  g.add(box(innerW, rimH, rimT, MAT.stone, [cx, rimBase, cz - d / 2 - rimT / 2]));
  g.add(box(innerW, rimH, rimT, MAT.stone, [cx, rimBase, cz + d / 2 + rimT / 2]));
  g.add(box(rimT, rimH, d, MAT.stone, [cx - w / 2 - rimT / 2, rimBase, cz]));
  g.add(box(rimT, rimH, d, MAT.stone, [cx + w / 2 + rimT / 2, rimBase, cz]));

  // Basin, then the water surface.
  //
  // There is no liner and no modelled basin floor. A liner exists to stop the
  // surrounding GROUND planes (`lawn` at y=-0.01 and `patch` at 0.005, neither
  // of which has a hole cut for the pool) showing through the basin walls. But
  // the water is 88% opaque, so it hides them by itself — and a liner has to
  // rise past the waterline to do the job, which is what put a pale band above
  // the water all the way round. Removing it deletes five boxes, the grey edge
  // and the `poolLiner` material, at no visible cost.
  //
  // The water deliberately OVERSHOOTS the basin edges and runs under the coping
  // (`rimT` = 0.34 m thick). Sizing it to the basin exactly left a hairline of
  // surrounding ground visible round the inside of the rim; the coping is a
  // solid box 20 cm tall sitting well above the water, so it hides the overlap
  // rather than fighting it for depth.
  const waterY = rimBase + 0.02; // above `patch` (0.005), just under rimTop
  const waterOverlap = 0.12; // each side, well under the 0.34 m rim

  const water = plane(w + waterOverlap * 2, d + waterOverlap * 2, MAT.water, [cx, waterY, cz]);
  water.userData.noMerge = true;
  water.name = 'poolWater';
  g.add(water);

  return g;
}

/* ── Planting ─────────────────────────────────────────────────── */

const TREE_SHAPES = [
  [[0, 1.9, 0, 1.5], [0.5, 2.5, 0.2, 1.05], [-0.5, 2.6, -0.2, 1.0], [0.1, 3.2, 0.1, 0.8]],
  [[0, 2.2, 0, 1.3], [0.7, 2.0, -0.3, 0.95], [-0.6, 2.3, 0.4, 0.9], [0, 2.9, 0, 0.85]],
  [[0, 1.7, 0, 1.6], [0.4, 2.4, 0.5, 1.0], [-0.6, 2.5, -0.4, 1.1]],
];

function buildTree(variant, trunkH = 1.6) {
  const g = group('tree');
  g.add(cyl(0.16, 0.26, trunkH, MAT.trunk, [0, 0, 0], 10));
  addRot(g, cyl(0.1, 0.13, 0.7, MAT.trunk, [0.12, trunkH - 0.3, 0.05], 8), 0, 0, -0.35);

  const blobs = TREE_SHAPES[variant % TREE_SHAPES.length];
  for (let i = 0; i < blobs.length; i++) {
    const [x, y, z, r] = blobs[i];
    const leaf = sph(r, i % 2 ? MAT.foliage : MAT.foliageLight, [x, y + trunkH * 0.3, z], 12);
    leaf.scale.set(1, 0.86, 1);
    g.add(leaf);
  }
  return g;
}

function buildShrub(r = 0.45) {
  const g = group('shrub');
  g.add(sph(r, MAT.bush, [0, r * 0.9, 0], 12));
  g.add(sph(r * 0.72, MAT.foliage, [r * 0.5, r * 1.15, r * 0.3], 10));
  g.add(sph(r * 0.6, MAT.foliageLight, [-r * 0.45, r * 1.0, -r * 0.35], 10));
  return g;
}

function buildFlowers(seed = 0) {
  const g = group('flowers');
  const cols = [MAT.flowerRed, MAT.flowerYellow, MAT.rugSoft];
  for (let i = 0; i < 7; i++) {
    const a = i * 1.9 + seed;
    const r = 0.5 + ((i * 3) % 4) * 0.22;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    g.add(cyl(0.012, 0.012, 0.3, MAT.foliage, [x, 0, z], 5));
    g.add(sph(0.075, cols[(i + seed) % cols.length], [x, 0.3, z], 8));
  }
  addScaled(g, sph(0.34, MAT.bush, [0, 0.12, 0], 10), 1, 0.55, 1);
  return g;
}

function buildPlanting() {
  const g = group('planting');

  const trees = [
    [-3.4, 2.2, 0, 1.9],
    [-3.0, 12.5, 1, 1.6],
    // There was a tree at (15.0, 3.0) here. The car is parked at (14.6, 3.0),
    // so the two overlapped by about 0.8 m — the trunk stood inside the
    // bodywork and the canopy clipped through the roof. Removed rather than
    // nudged: the driveway wants the space, and the remaining four trees
    // already frame the plot at the corners.
    [14.2, 12.8, 0, 1.7],
    [-3.6, -3.4, 1, 1.5],
  ];
  for (const [x, z, variant, trunk] of trees) {
    const t = buildTree(variant, trunk);
    t.position.set(x, 0, z);
    // Yaw keyed on the tree's own position, so each one faces a different way
    // but the whole layout stays reproducible across reloads and re-bakes. The
    // old `x * 0.7 + z * 0.3` was a fixed linear ramp in the coordinates, which
    // is why evenly-spaced trees read as uniform.
    t.rotation.y = randFor(`tree:${x},${z}`)() * Math.PI * 2;
    g.add(t);
  }

  // Foundation planting along the front of the house.
  for (let x = -0.6; x < 12.6; x += 1.35) {
    const s = buildShrub(0.34 + ((x * 7) % 3) * 0.05);
    s.position.set(x, 0, -0.75);
    s.rotation.y = randFor(`shrub-front:${x.toFixed(2)}`)() * Math.PI * 2;
    g.add(s);
  }
  // A few along the back wall too, avoiding the patio doors and pool.
  for (const x of [-1.4, 4.9, 5.6, 11.8]) {
    const s = buildShrub(0.4);
    s.position.set(x, 0, 10.85);
    s.rotation.y = randFor(`shrub-back:${x}`)() * Math.PI * 2;
    g.add(s);
  }

  // Flower beds either side of the path and around the pool.
  for (const [seed, x, z] of [[0, 0.55, -2.6], [1, 3.3, -2.6], [2, 0.4, -4.6], [3, 12.2, 12.0]]) {
    const bed = buildFlowers(seed);
    bed.position.set(x, 0, z);
    bed.rotation.y = randFor(`flowerbed:${x},${z}`)() * Math.PI * 2;
    g.add(bed);
  }

  // Hedge blocks screening the pool from the drive.
  for (let i = 0; i < 6; i++) {
    const h = buildShrub(0.5);
    h.position.set(13.0, 0, 8.0 + i * 1.1);
    h.scale.set(1, 0.9, 1);
    h.rotation.y = randFor(`hedge:${i}`)() * Math.PI * 2;
    g.add(h);
  }

  return g;
}

/* ── Garden kit ───────────────────────────────────────────────── */

function buildMailbox() {
  const g = group('mailbox');
  g.add(cyl(0.055, 0.07, 1.05, MAT.woodDark, [0, 0, 0], 10));
  g.add(box(0.3, 0.24, 0.44, MAT.steelDark, [-0.15, 1.05, -0.22]));
  g.add(box(0.06, 0.06, 0.3, MAT.black, [-0.15, 1.28, 0.06]));
  // Post-mounted number plate.
  g.add(box(0.02, 0.16, 0.22, MAT.porcelain, [0.04, 0.72, -0.11]));
  return g;
}

function buildLampPost() {
  const g = group('lampPost');
  const h = 2.6;
  g.add(cyl(0.16, 0.2, 0.14, MAT.charcoal, [0, 0, 0], 12));
  g.add(cyl(0.055, 0.075, h, MAT.charcoal, [0, 0.14, 0], 10));
  g.add(boxC(0.3, 0.06, 0.3, MAT.charcoal, [0, h + 0.2, 0]));

  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.2, 0.34, 14, 1, true), LAMP_MATERIAL);
  shade.position.set(0, h + 0.36, 0);
  shade.userData.noMerge = true;
  g.add(shade);

  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.16, 14), MAT.charcoal);
  cap.position.set(0, h + 0.6, 0);
  g.add(cap);
  return g;
}

function buildCar() {
  const g = group('car');
  const body = MAT.rugCool;

  g.add(boxC(1.86, 0.6, 4.1, body, [0, 0.66, 0]));
  g.add(boxC(1.72, 0.52, 2.1, body, [0, 1.18, -0.15]));
  // Windscreen and rear glass, then dark side glazing.
  g.add(boxC(1.6, 0.4, 0.06, MAT.screenOff, [0, 1.2, 0.92]));
  g.add(boxC(1.6, 0.4, 0.06, MAT.screenOff, [0, 1.2, -1.22]));
  for (const s of [-1, 1]) g.add(boxC(0.05, 0.34, 1.7, MAT.charcoal, [s * 0.86, 1.18, -0.15]));

  // Wheels: cylinders laid on their side, sitting on the ground plane.
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.26, 16), MAT.black);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(sx * 0.86, 0.4, sz * 1.38);
    wheel.castShadow = true;
    wheel.receiveShadow = true;
    g.add(wheel);
  }

  // Headlights and grille.
  for (const s of [-1, 1]) g.add(boxC(0.36, 0.16, 0.06, MAT.porcelain, [s * 0.58, 0.72, 2.06]));
  g.add(boxC(1.2, 0.14, 0.05, MAT.charcoal, [0, 0.5, 2.06]));
  g.add(boxC(0.5, 0.1, 0.04, MAT.porcelain, [0, 0.72, -2.06]));

  return g;
}

/* ── Assembly ─────────────────────────────────────────────────── */

export function buildYard() {
  const root = group('yard');

  // Lawn larger than the fence so the horizon reads as open ground. Left
  // un-tessellated and un-baked on purpose: it is the surface the interior
  // light was leaking onto, and it is far too big to subdivide.
  const lawn = plane(140, 140, MAT.grass, [6, -0.01, 5]);
  lawn.userData.noMerge = true;
  lawn.userData.noBake = true;
  lawn.name = 'lawn';
  root.add(lawn);

  // A slightly different green patch under the fence line, for variation.
  const patch = plane(24, 24, MAT.grassPatch, [6, 0.005, 5]);
  patch.userData.noBake = true;
  root.add(patch);

  root.add(buildFence());
  root.add(buildPath());
  root.add(buildDeck());
  root.add(buildPool());
  root.add(buildPlanting());

  const mailbox = buildMailbox();
  mailbox.position.set(0.75, 0, -5.0);
  mailbox.rotation.y = 0.25;
  root.add(mailbox);

  const lamp = buildLampPost();
  lamp.position.set(-1.4, 0, -3.2);
  root.add(lamp);

  const car = buildCar();
  car.position.set(14.6, 0.0, 3.0);
  car.rotation.y = 0.02;
  root.add(car);

  return {
    group: root,
    lawn,
    // Descriptors, turned into real lights by the environment so this
    // subtree stays free of non-mesh objects and can be merged.
    lights: [
      { position: [-1.4, 2.95, -3.2], color: 0xffd9a0, intensity: 14, distance: 12, name: 'lampPost' },
    ],
  };
}
