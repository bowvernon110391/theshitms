import * as THREE from 'three';
import { MAT, LAMP_MATERIAL } from './materials.js';
import { box, boxC, cyl, sph, plane, group, markEmitter } from './utils.js';

/**
 * Every piece below is built with **y = 0 at floor level**, so a piece can be
 * positioned with `piece.position.set(x, 0, z)` and rotated with `rotation.y`.
 * All pieces face **+Z** unless noted.
 */

const V = (x, z) => [x, 0, z];

/**
 * `THREE.Object3D.add()` returns the PARENT, not the child, so
 * `g.add(mesh).rotation.z = x` would rotate the whole group. This helper
 * keeps the child in hand when it also needs a rotation.
 */
function addRot(parent, child, rx = 0, ry = 0, rz = 0) {
  child.rotation.set(rx, ry, rz);
  parent.add(child);
  return child;
}

/* ── Seating ──────────────────────────────────────────────────── */

export function makeSofa({ length = 2.2, depth = 0.92, fabric = MAT.sofa } = {}) {
  const g = group('sofa');
  const seatH = 0.36;
  const legR = 0.05;

  // Legs
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(cyl(legR, legR * 0.8, 0.14, MAT.woodDark, [sx * (length / 2 - 0.18), 0, sz * (depth / 2 - 0.16)], 7));
    }
  }

  // Base + seat cushions
  g.add(box(length - 0.3, seatH, depth - 0.24, fabric, [0, 0.14, 0]));
  const cushionCount = length > 1.9 ? 3 : 2;
  const cw = (length - 0.34) / cushionCount;
  for (let i = 0; i < cushionCount; i++) {
    const x = -length / 2 + 0.17 + cw * (i + 0.5);
    g.add(box(cw - 0.035, 0.16, depth - 0.32, MAT.sofaCushion, [x, 0.5, 0.02]));
  }

  // Back + back cushions
  g.add(box(length - 0.3, 0.62, 0.2, fabric, [0, 0.3, -depth / 2 + 0.11]));
  for (let i = 0; i < cushionCount; i++) {
    const x = -length / 2 + 0.17 + cw * (i + 0.5);
    g.add(box(cw - 0.05, 0.42, 0.16, MAT.sofaCushion, [x, 0.5, -depth / 2 + 0.26]));
  }

  // Arms
  for (const s of [-1, 1]) {
    g.add(box(0.18, 0.5, depth - 0.16, fabric, [s * (length / 2 - 0.09), 0.14, 0]));
  }

  // Throw pillows
  g.add(box(0.34, 0.34, 0.12, MAT.cushionWarm, [-length / 2 + 0.45, 0.62, -0.06], 0.32));
  g.add(box(0.34, 0.34, 0.12, MAT.cushionWarm, [length / 2 - 0.45, 0.62, -0.06], -0.32));

  return g;
}

export function makeArmchair({ fabric = MAT.sofa } = {}) {
  const g = group('armchair');
  const w = 0.85;
  const d = 0.85;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(cyl(0.045, 0.035, 0.14, MAT.woodDark, [sx * (w / 2 - 0.12), 0, sz * (d / 2 - 0.12)], 7));
    }
  }
  g.add(box(w - 0.14, 0.34, d - 0.16, fabric, [0, 0.14, 0]));
  g.add(box(w - 0.16, 0.14, d - 0.24, MAT.sofaCushion, [0, 0.48, 0.02]));
  g.add(box(w - 0.14, 0.56, 0.18, fabric, [0, 0.28, -d / 2 + 0.1]));
  g.add(box(w - 0.2, 0.36, 0.13, MAT.sofaCushion, [0, 0.48, -d / 2 + 0.23]));
  for (const s of [-1, 1]) g.add(box(0.14, 0.42, d - 0.14, fabric, [s * (w / 2 - 0.07), 0.14, 0]));
  return g;
}

export function makeDiningChair({ wood = MAT.woodMid } = {}) {
  const g = group('chair');
  const s = 0.44;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(box(0.045, 0.44, 0.045, wood, [sx * (s / 2 - 0.04), 0, sz * (s / 2 - 0.04)]));
    }
  }
  g.add(box(s, 0.05, s, wood, [0, 0.44, 0]));
  g.add(box(s, 0.05, s, MAT.cushionWarm, [0, 0.49, 0]));
  // Backrest: two uprights + slats
  for (const sx of [-1, 1]) g.add(box(0.045, 0.48, 0.045, wood, [sx * (s / 2 - 0.04), 0.49, -s / 2 + 0.04]));
  for (const y of [0.72, 0.86]) g.add(box(s - 0.05, 0.06, 0.03, wood, [0, y, -s / 2 + 0.04]));
  return g;
}

export function makeStool({ height = 0.66, seatR = 0.18, wood = MAT.woodMid } = {}) {
  const g = group('stool');
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = cyl(0.026, 0.032, height, wood, [Math.cos(a) * seatR * 0.8, 0, Math.sin(a) * seatR * 0.8], 6);
    leg.rotation.z = Math.cos(a) * 0.05;
    leg.rotation.x = -Math.sin(a) * 0.05;
    g.add(leg);
  }
  addRot(g, cyl(0.03, 0.03, 0.05, wood, [0, height * 0.35, 0], 6), 0, 0, Math.PI / 2);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(seatR * 0.62, 0.014, 6, 14), wood);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = height * 0.32;
  ring.castShadow = true;
  g.add(ring);
  g.add(cyl(seatR, seatR, 0.05, MAT.cushionWarm, [0, height, 0], 16));
  return g;
}

export function makeOfficeChair() {
  const g = group('officeChair');
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    g.add(box(0.26, 0.05, 0.06, MAT.steelDark, [Math.cos(a) * 0.16, 0.03, Math.sin(a) * 0.16], -a));
  }
  g.add(cyl(0.04, 0.05, 0.34, MAT.steelDark, [0, 0.06, 0], 10));
  g.add(box(0.46, 0.08, 0.46, MAT.charcoal, [0, 0.4, 0]));
  g.add(box(0.44, 0.5, 0.1, MAT.charcoal, [0, 0.48, -0.18]));
  g.add(box(0.42, 0.1, 0.42, MAT.black, [0, 0.42, 0]));
  return g;
}

/* ── Tables ───────────────────────────────────────────────────── */

export function makeCoffeeTable({ w = 0.94, d = 0.5, wood = MAT.woodMid } = {}) {
  const g = group('coffeeTable');
  g.add(box(w, 0.06, d, wood, [0, 0.4, 0]));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(box(0.06, 0.4, 0.06, wood, [sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06)]));
    }
  }
  g.add(box(w - 0.16, 0.03, d - 0.12, wood, [0, 0.16, 0]));
  // A book and a bowl on top
  g.add(box(0.24, 0.03, 0.17, MAT.rugCool, [-0.18, 0.46, 0.02], 0.2));
  g.add(cyl(0.09, 0.06, 0.05, MAT.stone, [0.22, 0.46, 0], 14));
  return g;
}

export function makeDiningTable({ w = 1.9, d = 1.0, wood = MAT.woodMid, h = 0.75 } = {}) {
  const g = group('diningTable');
  g.add(box(w, 0.06, d, wood, [0, h, 0]));
  g.add(box(w - 0.4, 0.03, d - 0.3, MAT.woodDark, [0, h - 0.06, 0]));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = box(0.08, h, 0.08, wood, [sx * (w / 2 - 0.1), 0, sz * (d / 2 - 0.1)]);
      g.add(leg);
    }
  }
  g.add(box(w - 0.24, 0.06, 0.08, wood, [0, h - 0.16, 0]));
  // Centrepiece
  g.add(cyl(0.13, 0.1, 0.1, MAT.stone, [0, h + 0.06, 0], 16));
  const bloom = sph(0.055, MAT.flowerYellow, [0, h + 0.19, 0], 10);
  g.add(bloom);
  return g;
}

export function makeConsoleTable({ w = 1.2, d = 0.36, wood = MAT.woodMid, h = 0.78 } = {}) {
  const g = group('console');
  g.add(box(w, 0.05, d, wood, [0, h, 0]));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(box(0.05, h, 0.05, wood, [sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05)]));
    }
  }
  g.add(box(w - 0.1, 0.05, d - 0.05, wood, [0, 0.12, 0]));
  // A bowl and a photo frame
  g.add(cyl(0.11, 0.07, 0.06, MAT.stone, [-0.28, h + 0.05, 0], 14));
  g.add(boxC(0.16, 0.2, 0.02, MAT.woodDark, [0.3, h + 0.13, 0], 0.18));
  return g;
}

export function makeDesk({ w = 1.4, d = 0.62, wood = MAT.woodLight, facing = 1 } = {}) {
  const g = group('desk');
  const h = 0.74;
  g.add(box(w, 0.05, d, wood, [0, h, 0]));
  const knee = 0.52;
  g.add(box(knee, h - 0.1, d - 0.06, wood, [-w / 2 + knee / 2 + 0.02, 0.06, 0]));
  g.add(box(w - knee - 0.06, h - 0.1, d - 0.06, wood, [w / 2 - (w - knee - 0.06) / 2 - 0.02, 0.06, 0]));
  g.add(box(w - knee - 0.1, 0.32, d - 0.12, MAT.woodMid, [w / 2 - 0.3, h + 0.34, 0]));

  // Monitor, keyboard, mug
  g.add(boxC(0.06, 0.18, 0.06, MAT.steelDark, [-0.2, h + 0.14, -0.02]));
  g.add(boxC(0.46, 0.28, 0.02, MAT.screenOff, [-0.2, h + 0.36, -0.02]));
  g.add(box(0.34, 0.015, 0.12, MAT.charcoal, [-0.2, h + 0.06, 0.2]));
  g.add(cyl(0.04, 0.035, 0.09, MAT.porcelain, [0.22, h + 0.06, 0.16], 12));
  g.add(boxC(0.14, 0.19, 0.1, MAT.rugWarm, [0.44, h + 0.1, -0.12], 0.4));
  return g;
}

/* ── Storage ──────────────────────────────────────────────────── */

export function makeBookshelf({ w = 1.1, h = 1.9, d = 0.32, wood = MAT.woodMid, books = true } = {}) {
  const g = group('bookshelf');
  g.add(box(0.05, h, d, wood, [-w / 2 + 0.025, 0, 0]));
  g.add(box(0.05, h, d, wood, [w / 2 - 0.025, 0, 0]));
  g.add(box(w, 0.04, d, wood, [0, h, 0]));
  g.add(box(w, 0.04, d, wood, [0, 0, 0]));
  g.add(box(w, 0.02, d - 0.04, MAT.woodDark, [0, 0, -d / 2 + 0.02]));

  const shelves = 4;
  const palette = [MAT.rugWarm, MAT.rugCool, MAT.rugSoft, MAT.flowerRed, MAT.foliage];
  for (let s = 0; s < shelves; s++) {
    const y = 0.2 + (s * (h - 0.3)) / shelves;
    g.add(box(w - 0.1, 0.035, d - 0.04, wood, [0, y, 0]));
    if (!books) continue;
    let x = -w / 2 + 0.12;
    let i = s * 3;
    while (x < w / 2 - 0.14) {
      const bw = 0.05 + ((i * 7) % 5) * 0.012;
      const bh = 0.2 + ((i * 3) % 4) * 0.022;
      const mat = palette[i % palette.length];
      g.add(box(bw, bh, 0.2, mat, [x, y + 0.035, 0]));
      x += bw + 0.012;
      i++;
    }
  }
  return g;
}

export function makeWardrobe({ w = 1.5, h = 2.2, d = 0.62 } = {}) {
  const g = group('wardrobe');
  g.add(box(w, h, d, MAT.woodLight, [0, 0, 0]));
  for (const s of [-1, 1]) {
    g.add(box(w / 2 - 0.03, h - 0.1, 0.02, MAT.woodWhite, [s * (w / 4), 0.05, d / 2 + 0.005]));
    g.add(cyl(0.014, 0.014, 0.14, MAT.chrome, [s * (w / 4 - 0.07), h * 0.5, d / 2 + 0.03], 8));
  }
  g.add(box(w + 0.06, 0.09, d + 0.04, MAT.woodDark, [0, h, 0]));
  g.add(box(w + 0.06, 0.06, d + 0.04, MAT.woodDark, [0, 0, 0]));
  return g;
}

export function makeNightstand({ w = 0.5, h = 0.56, d = 0.42 } = {}) {
  const g = group('nightstand');
  g.add(box(w, h, d, MAT.woodMid, [0, 0, 0]));
  g.add(box(w - 0.04, 0.18, 0.02, MAT.woodLight, [0, h - 0.24, d / 2 + 0.005]));
  g.add(box(w - 0.04, 0.18, 0.02, MAT.woodLight, [0, h - 0.05, d / 2 + 0.005]));
  addRot(g, cyl(0.012, 0.012, 0.1, MAT.chrome, [0, h - 0.15, d / 2 + 0.03], 8), 0, 0, Math.PI / 2);
  return g;
}

export function makeSideboard({ w = 1.3, h = 0.8, d = 0.44, wood = MAT.woodMid } = {}) {
  const g = group('sideboard');
  g.add(box(w, h - 0.12, d, wood, [0, 0.12, 0]));
  for (const s of [-1, 1]) {
    g.add(box(0.05, 0.12, 0.05, MAT.woodDark, [s * (w / 2 - 0.1), 0, d / 2 - 0.08]));
    g.add(box(0.05, 0.12, 0.05, MAT.woodDark, [s * (w / 2 - 0.1), 0, -d / 2 + 0.08]));
  }
  for (const s of [-1, 1]) {
    g.add(box(w / 2 - 0.04, h - 0.24, 0.02, MAT.woodLight, [s * (w / 4), 0.16, d / 2 + 0.005]));
  }
  g.add(box(w + 0.04, 0.04, d + 0.03, MAT.counterTop, [0, h, 0]));
  return g;
}

/* ── Beds ─────────────────────────────────────────────────────── */

export function makeBed({ w = 1.7, len = 2.05, headboard = true } = {}) {
  const g = group('bed');
  const frameH = 0.3;

  // Frame + legs
  g.add(box(w, frameH, len, MAT.bedFrame, [0, 0.12, 0]));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(box(0.08, 0.12, 0.08, MAT.woodDark, [sx * (w / 2 - 0.1), 0, sz * (len / 2 - 0.1)]));
    }
  }

  // Mattress, sheet, duvet
  g.add(box(w - 0.06, 0.24, len - 0.08, MAT.bedding, [0, frameH + 0.12, 0]));
  g.add(box(w - 0.04, 0.1, len * 0.62, MAT.beddingAccent, [0, frameH + 0.36, len * 0.16]));
  g.add(box(w - 0.1, 0.05, 0.5, MAT.pillow, [0, frameH + 0.38, len * 0.3]));

  // Pillows
  for (const s of [-1, 1]) {
    const p = box(w * 0.4, 0.14, 0.3, MAT.pillow, [s * w * 0.23, frameH + 0.36, -len / 2 + 0.28], s * 0.06);
    g.add(p);
  }

  if (headboard) {
    g.add(box(w + 0.12, 0.86, 0.09, MAT.woodMid, [0, 0, -len / 2 - 0.045]));
    g.add(box(w + 0.02, 0.5, 0.04, MAT.beddingAccent, [0, 0.28, -len / 2 + 0.005]));
  }
  return g;
}

/* ── Kitchen ──────────────────────────────────────────────────── */

/**
 * A run of base cabinets with a counter top.
 * `len` runs along X; `facing` flips which side the doors are on (+Z by default).
 */
export function makeCounterRun({ len = 2.0, facing = 1, sink = null, stove = null, cooktop = false } = {}) {
  const g = group('counterRun');
  const h = 0.9;
  const d = 0.62;

  g.add(box(len, h - 0.1, d, MAT.woodWhite, [0, 0.1, 0]));
  g.add(box(len, 0.1, d - 0.12, MAT.charcoal, [0, 0, 0]));
  g.add(box(len + 0.04, 0.06, d + 0.03, MAT.counterTop, [0, h, 0]));

  // Door fronts with handles.
  const doors = Math.max(2, Math.round(len / 0.6));
  const dw = len / doors;
  for (let i = 0; i < doors; i++) {
    const x = -len / 2 + dw * (i + 0.5);
    g.add(box(dw - 0.03, h - 0.26, 0.02, MAT.woodWhite, [x, 0.16, facing * (d / 2 + 0.005)]));
    addRot(
      g,
      cyl(0.01, 0.01, 0.12, MAT.chrome, [x + dw / 2 - 0.09, h - 0.32, facing * (d / 2 + 0.03)], 8),
      0, 0, Math.PI / 2
    );
  }

  // Toe kick shadow line
  g.add(box(len - 0.04, 0.1, 0.04, MAT.black, [0, 0, facing * (d / 2 - 0.02)]));

  if (sink) {
    const sx = sink * (len / 2) * 0.72;
    g.add(box(0.62, 0.08, 0.44, MAT.chrome, [sx, h - 0.02, 0]));
    g.add(box(0.52, 0.16, 0.34, MAT.steelDark, [sx, h - 0.16, 0]));
    const tap = cyl(0.018, 0.018, 0.28, MAT.chrome, [sx, h + 0.04, -0.2], 10);
    g.add(tap);
    const spout = boxC(0.02, 0.02, 0.16, MAT.chrome, [sx, h + 0.32, -0.12]);
    g.add(spout);
  }

  if (cooktop) {
    const cx = stove * (len / 2) * 0.72;
    g.add(box(0.58, 0.02, 0.5, MAT.black, [cx, h + 0.06, 0]));
    for (const ox of [-0.14, 0.14]) {
      for (const oz of [-0.13, 0.13]) {
        g.add(cyl(0.075, 0.075, 0.012, MAT.steelDark, [cx + ox, h + 0.07, oz], 14));
      }
    }
    // Oven front
    g.add(box(0.56, 0.5, 0.02, MAT.steelDark, [cx, 0.26, facing * (d / 2 + 0.005)]));
    g.add(box(0.46, 0.24, 0.02, MAT.black, [cx, 0.36, facing * (d / 2 + 0.02)]));
    g.add(box(0.5, 0.03, 0.05, MAT.chrome, [cx, 0.72, facing * (d / 2 + 0.04)]));
  }

  return g;
}

export function makeUpperCabinets({ len = 1.2, facing = 1, y = 1.72 } = {}) {
  const g = group('upperCabinets');
  const d = 0.36;
  const h = 0.72;
  g.add(box(len, h, d, MAT.woodWhite, [0, y, 0]));
  const doors = Math.max(2, Math.round(len / 0.6));
  const dw = len / doors;
  for (let i = 0; i < doors; i++) {
    const x = -len / 2 + dw * (i + 0.5);
    g.add(box(dw - 0.03, h - 0.04, 0.02, MAT.woodWhite, [x, y + 0.02, facing * (d / 2 + 0.005)]));
    addRot(
      g,
      cyl(0.009, 0.009, 0.1, MAT.chrome, [x + dw / 2 - 0.08, y + 0.1, facing * (d / 2 + 0.03)], 8),
      0, 0, Math.PI / 2
    );
  }
  g.add(box(len + 0.04, 0.05, d + 0.04, MAT.woodDark, [0, y + h, 0]));
  return g;
}

export function makeFridge() {
  const g = group('fridge');
  const w = 0.72;
  const h = 1.92;
  const d = 0.7;
  g.add(box(w, h, d, MAT.chrome, [0, 0, 0]));
  g.add(box(w - 0.03, h * 0.62, 0.02, MAT.porcelain, [0, 0, d / 2 + 0.005]));
  g.add(box(w - 0.03, h * 0.32, 0.02, MAT.porcelain, [0, h * 0.66, d / 2 + 0.005]));
  g.add(cyl(0.014, 0.014, 0.5, MAT.steelDark, [w / 2 - 0.1, 0.9, d / 2 + 0.04], 8));
  g.add(cyl(0.014, 0.014, 0.36, MAT.steelDark, [w / 2 - 0.1, h - 0.42, d / 2 + 0.04], 8));
  // Magnets
  g.add(box(0.09, 0.12, 0.01, MAT.cushionWarm, [-0.2, 1.35, d / 2 + 0.02], 0.2));
  g.add(box(0.08, 0.08, 0.01, MAT.rugCool, [-0.02, 1.52, d / 2 + 0.02], -0.3));
  return g;
}

export function makeIsland({ w = 1.7, d = 0.92, h = 0.92 } = {}) {
  const g = group('island');
  g.add(box(w - 0.1, h - 0.1, d - 0.1, MAT.woodWhite, [0, 0.05, 0]));
  g.add(box(w + 0.14, 0.07, d + 0.14, MAT.counterTop, [0, h - 0.02, 0]));
  g.add(box(w - 0.04, 0.1, 0.04, MAT.black, [0, 0, d / 2 - 0.06]));
  g.add(box(w - 0.04, 0.1, 0.04, MAT.black, [0, 0, -d / 2 + 0.06]));

  // Fruit bowl + chopping board
  g.add(cyl(0.15, 0.1, 0.07, MAT.stone, [-0.35, h + 0.05, 0], 16));
  g.add(sph(0.05, MAT.flowerRed, [-0.4, h + 0.14, 0.03], 10));
  g.add(sph(0.05, MAT.foliageLight, [-0.3, h + 0.14, -0.04], 10));
  g.add(box(0.4, 0.02, 0.26, MAT.woodLight, [0.4, h + 0.05, 0]));
  return g;
}

export function makePantry({ w = 0.7, h = 2.1, d = 0.6 } = {}) {
  const g = group('pantry');
  g.add(box(w, h, d, MAT.woodWhite, [0, 0, 0]));
  g.add(box(w - 0.06, h - 0.08, 0.02, MAT.woodLight, [0, 0.04, d / 2 + 0.005]));
  g.add(cyl(0.012, 0.012, 0.16, MAT.chrome, [w / 2 - 0.12, h * 0.52, d / 2 + 0.03], 8));
  return g;
}

/* ── Bathroom ─────────────────────────────────────────────────── */

export function makeBathtub({ len = 1.7, w = 0.78, h = 0.56 } = {}) {
  const g = group('bathtub');
  g.add(box(w, h, len, MAT.porcelain, [0, 0, 0]));
  // Inner basin
  g.add(box(w - 0.16, 0.06, len - 0.18, MAT.tileDark, [0, h - 0.06, 0]));
  // Rim highlight
  g.add(box(w + 0.02, 0.05, len + 0.02, MAT.porcelain, [0, h, 0]));
  // Tap at one end
  g.add(cyl(0.02, 0.02, 0.24, MAT.chrome, [0, h + 0.02, -len / 2 + 0.16], 10));
  g.add(boxC(0.02, 0.02, 0.14, MAT.chrome, [0, h + 0.26, -len / 2 + 0.22]));
  // Water surface
  const water = plane(w - 0.18, len - 0.24, MAT.water, [0, h - 0.02, 0]);
  water.userData.noMerge = true;
  g.add(water);
  return g;
}

export function makeToilet() {
  const g = group('toilet');
  g.add(box(0.38, 0.2, 0.5, MAT.porcelain, [0, 0.22, 0.04]));
  g.add(cyl(0.19, 0.15, 0.16, MAT.porcelain, [0, 0.06, 0.04], 18));
  g.add(cyl(0.22, 0.22, 0.03, MAT.porcelain, [0, 0.42, 0.04], 20));
  g.add(cyl(0.16, 0.16, 0.05, MAT.tileDark, [0, 0.44, 0.04], 18));
  // Cistern
  g.add(box(0.42, 0.62, 0.18, MAT.porcelain, [0, 0.18, -0.24]));
  g.add(box(0.42, 0.04, 0.2, MAT.porcelain, [0, 0.8, -0.24]));
  g.add(cyl(0.03, 0.03, 0.03, MAT.chrome, [0.14, 0.8, -0.24], 12));
  return g;
}

export function makeVanity({ w = 1.1, h = 0.84, d = 0.5 } = {}) {
  const g = group('vanity');
  g.add(box(w, h - 0.12, d, MAT.woodWhite, [0, 0.12, 0]));
  g.add(box(w, 0.12, d - 0.1, MAT.charcoal, [0, 0, 0]));
  g.add(box(w + 0.04, 0.06, d + 0.03, MAT.stone, [0, h, 0]));
  for (const s of [-1, 1]) {
    g.add(box(w / 2 - 0.03, h - 0.26, 0.02, MAT.woodWhite, [s * (w / 4), 0.16, d / 2 + 0.005]));
    addRot(
      g,
      cyl(0.009, 0.009, 0.1, MAT.chrome, [s * (w / 4 - 0.06), h - 0.2, d / 2 + 0.03], 8),
      0, 0, Math.PI / 2
    );
  }
  // Basin + tap
  g.add(cyl(0.19, 0.15, 0.12, MAT.porcelain, [0, h - 0.06, 0], 20));
  g.add(cyl(0.16, 0.16, 0.04, MAT.tileDark, [0, h + 0.03, 0], 20));
  const tap = cyl(0.016, 0.016, 0.2, MAT.chrome, [0, h + 0.05, -d / 2 + 0.14], 10);
  g.add(tap);
  g.add(boxC(0.018, 0.018, 0.12, MAT.chrome, [0, h + 0.23, -d / 2 + 0.2]));
  // Accessories
  g.add(cyl(0.035, 0.035, 0.16, MAT.rugSoft, [0.36, h + 0.06, 0.02], 12));
  g.add(box(0.14, 0.05, 0.03, MAT.steelDark, [-0.34, h + 0.06, 0.04], 0.1));
  return g;
}

export function makeMirror({ w = 0.7, h = 0.9, y = 1.25 }) {
  const g = group('mirror');
  g.add(boxC(w, h, 0.05, MAT.woodWhite, [0, y, 0]));
  g.add(boxC(w - 0.07, h - 0.07, 0.02, MAT.chrome, [0, y, 0.03]));
  return g;
}

export function makeTowelRack({ len = 0.7, y = 1.2 }) {
  const g = group('towelRack');
  g.add(boxC(len, 0.03, 0.03, MAT.chrome, [0, y, 0]));
  g.add(boxC(len, 0.5, 0.05, MAT.rugSoft, [0, y - 0.28, 0.05]));
  for (const s of [-1, 1]) g.add(boxC(0.03, 0.06, 0.08, MAT.chrome, [s * len * 0.45, y, -0.03]));
  return g;
}

/* ── Lighting fixtures ────────────────────────────────────────── */

export function makeFloorLamp({ h = 1.55, shade = MAT.rugWarm } = {}) {
  const g = group('floorLamp');
  g.add(cyl(0.17, 0.19, 0.04, MAT.steelDark, [0, 0, 0], 16));
  g.add(cyl(0.018, 0.018, h, MAT.steelDark, [0, 0.04, 0], 10));
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.26, 18, 1, true), LAMP_MATERIAL);
  cone.position.set(0, h - 0.1, 0);
  cone.castShadow = true;
  g.add(cone);
  const bulb = sph(0.06, LAMP_MATERIAL, [0, h - 0.16, 0], 12);
  bulb.userData.noMerge = true;
  cone.userData.noMerge = true;
  g.add(bulb);
  return g;
}

export function makeTableLamp({ h = 0.36 } = {}) {
  const g = group('tableLamp');
  g.add(cyl(0.09, 0.11, 0.03, MAT.woodDark, [0, 0, 0], 14));
  g.add(cyl(0.014, 0.014, h * 0.6, MAT.steelDark, [0, 0.03, 0], 8));
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 0.17, 16, 1, true), LAMP_MATERIAL);
  cone.position.set(0, h * 0.75, 0);
  cone.userData.noMerge = true;
  g.add(cone);
  return g;
}

export function makePendantLamp({ y = 2.0, drop = 0.5, radius = 0.26 } = {}) {
  const g = group('pendant');
  g.add(cyl(0.012, 0.012, drop, MAT.steelDark, [0, y + 0.3, 0], 6));
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    LAMP_MATERIAL
  );
  dome.position.set(0, y, 0);
  dome.rotation.x = Math.PI;
  g.add(dome);
  g.add(cyl(0.02, 0.02, 0.05, MAT.steelDark, [0, y + 0.02, 0], 8));
  // The dining room's light sits inside this dome, so the same self-shadowing
  // problem as the ceiling lamps applies here.
  return markEmitter(g);
}

/* ── Decor ────────────────────────────────────────────────────── */

export function makePlant({ h = 1.1, spread = 0.42 } = {}) {
  const g = group('plant');
  g.add(cyl(0.2, 0.15, 0.34, MAT.woodLight, [0, 0, 0], 16));
  g.add(cyl(0.205, 0.205, 0.05, MAT.woodDark, [0, 0.34, 0], 16));
  g.add(cyl(0.03, 0.04, h * 0.5, MAT.trunk, [0, 0.38, 0], 8));
  const leaves = 9;
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2;
    const r = spread * (0.5 + (i % 3) * 0.25);
    const leaf = sph(0.17 + (i % 3) * 0.03, i % 2 ? MAT.foliage : MAT.foliageLight, [
      Math.cos(a) * r,
      0.62 + (i % 4) * 0.15,
      Math.sin(a) * r,
    ], 10);
    leaf.scale.set(1, 0.7, 1.25);
    g.add(leaf);
  }
  g.add(sph(0.2, MAT.foliage, [0, 1.02, 0], 12));
  return g;
}

export function makeRug({ w = 2.4, d = 1.8, color = MAT.rugWarm, border = true } = {}) {
  const g = group('rug');
  const base = plane(w, d, color, [0, 0.018, 0]);
  base.userData.noMerge = true;
  g.add(base);
  if (border) {
    const bmat = new THREE.MeshStandardMaterial({ color: 0xf0e6d4, roughness: 1 });
    const b = plane(w - 0.22, d - 0.22, bmat, [0, 0.024, 0]);
    b.userData.noMerge = true;
    g.add(b);
    const inner = plane(w - 0.42, d - 0.42, color, [0, 0.03, 0]);
    inner.userData.noMerge = true;
    g.add(inner);
  }
  return g;
}

export function makeWallArt({ w = 0.8, h = 0.6, y = 1.55, art = 0 } = {}) {
  const g = group('wallArt');
  g.add(boxC(w, h, 0.04, MAT.woodDark, [0, y, 0]));
  const palette = [MAT.rugCool, MAT.rugWarm, MAT.foliage, MAT.rugSoft, MAT.flowerRed];
  const c1 = palette[art % palette.length];
  const c2 = palette[(art + 2) % palette.length];
  g.add(boxC(w - 0.1, h - 0.1, 0.02, c1, [0, y, 0.03]));
  g.add(boxC(w * 0.45, h * 0.5, 0.02, c2, [-w * 0.14, y + h * 0.1, 0.045]));
  return g;
}

export function makeCoatRack() {
  const g = group('coatRack');
  const h = 1.75;
  g.add(cyl(0.16, 0.19, 0.03, MAT.woodDark, [0, 0, 0], 12));
  g.add(cyl(0.025, 0.03, h, MAT.woodMid, [0, 0.03, 0], 8));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const peg = cyl(0.016, 0.016, 0.16, MAT.woodMid, [Math.cos(a) * 0.08, h - 0.16, Math.sin(a) * 0.08], 6);
    peg.rotation.z = Math.cos(a) * 0.9;
    peg.rotation.x = -Math.sin(a) * 0.9;
    g.add(peg);
  }
  // A hanging coat, for flavour
  g.add(boxC(0.22, 0.62, 0.14, MAT.rugCool, [0.12, h - 0.5, 0.04], 0.1));
  return g;
}

export function makeBench({ w = 1.3, h = 0.46, d = 0.42 } = {}) {
  const g = group('bench');
  g.add(box(w, 0.09, d, MAT.woodMid, [0, h, 0]));
  g.add(box(w - 0.1, 0.05, d - 0.06, MAT.cushionWarm, [0, h + 0.09, 0]));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(box(0.06, h, 0.06, MAT.woodDark, [sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08)]));
    }
  }
  g.add(box(w - 0.2, 0.04, 0.04, MAT.woodDark, [0, 0.16, 0]));
  return g;
}

export function makeTV({ w = 1.1, h = 0.64 } = {}) {
  const g = group('tv');
  const y = 0.62;
  g.add(cyl(0.16, 0.19, 0.03, MAT.black, [0, y, 0], 14));
  g.add(boxC(0.05, 0.22, 0.05, MAT.black, [0, y + 0.12, 0]));
  g.add(boxC(w, h, 0.05, MAT.black, [0, y + 0.44, 0]));
  g.add(boxC(w - 0.06, h - 0.06, 0.02, MAT.screen, [0, y + 0.44, 0.035]));
  return g;
}

export function makeTVStand({ w = 1.5, h = 0.46, d = 0.42 } = {}) {
  const g = group('tvStand');
  g.add(box(w, h - 0.12, d, MAT.woodDark, [0, 0.12, 0]));
  g.add(box(w, 0.12, d - 0.08, MAT.black, [0, 0, 0]));
  g.add(box(w - 0.06, 0.14, 0.02, MAT.woodMid, [0, 0.22, d / 2 + 0.005]));
  for (const s of [-1, 1]) {
    g.add(boxC(0.05, 0.05, 0.02, MAT.chrome, [s * 0.2, 0.29, d / 2 + 0.02]));
  }
  return g;
}

export function makeDresser({ w = 1.2, h = 0.82, d = 0.46 } = {}) {
  const g = group('dresser');
  g.add(box(w, h - 0.1, d, MAT.woodMid, [0, 0.1, 0]));
  g.add(box(w, 0.1, d - 0.06, MAT.woodDark, [0, 0, 0]));
  for (let i = 0; i < 3; i++) {
    const y = 0.18 + i * 0.21;
    g.add(box(w - 0.06, 0.18, 0.02, MAT.woodLight, [0, y, d / 2 + 0.005]));
    addRot(g, cyl(0.01, 0.01, 0.1, MAT.chrome, [0, y + 0.07, d / 2 + 0.03], 8), 0, 0, Math.PI / 2);
  }
  g.add(box(w + 0.04, 0.04, d + 0.03, MAT.woodDark, [0, h, 0]));
  return g;
}

export function makePotShelf({ w = 0.9, y = 1.9 } = {}) {
  const g = group('shelf');
  g.add(boxC(w, 0.04, 0.24, MAT.woodLight, [0, y, 0]));
  for (const s of [-1, 1]) {
    g.add(boxC(0.04, 0.16, 0.2, MAT.woodDark, [s * (w / 2 - 0.03), y - 0.1, 0]));
  }
  return g;
}
