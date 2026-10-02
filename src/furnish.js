import * as THREE from 'three';
import { MAT } from './materials.js';
import * as F from './furniture.js';

/**
 * Hand-placed furnishings. Coordinates are in tile space, matching the room
 * rectangles in `config.js`, with y = 0 at finished floor level.
 *
 * Placements were chosen against the wall runs so nothing intersects a
 * doorway, a window reveal or a neighbouring piece.
 */

/** Place a piece on the floor and face it. */
function at(piece, x, z, ry = 0) {
  piece.position.set(x, 0, z);
  piece.rotation.y = ry;
  return piece;
}

const HALF = Math.PI / 2;

function livingRoom() {
  const g = new THREE.Group();
  g.name = 'room:living';

  // Sofa sits against the left wall, looking across at the TV wall (x = 4).
  g.add(at(F.makeSofa({ length: 2.0, depth: 0.92 }), 1.1, 3.0, HALF));
  g.add(at(F.makeCoffeeTable({ w: 0.94, d: 0.5 }), 2.4, 3.0, HALF));
  g.add(at(F.makeRug({ w: 2.4, d: 1.9, color: MAT.rugWarm }), 2.1, 3.0, HALF));

  g.add(at(F.makeTVStand({ w: 1.5 }), 3.72, 3.2, -HALF));
  g.add(at(F.makeTV({ w: 1.15 }), 3.68, 3.2, -HALF));

  // Shelving under the front window, kept below the 0.95 sill.
  g.add(at(F.makeBookshelf({ w: 1.1, h: 1.35 }), 0.72, 0.26, 0));
  g.add(at(F.makeFloorLamp({ h: 1.55 }), 3.5, 0.5, 0));
  g.add(at(F.makePlant({ h: 1.0 }), 0.55, 3.5, 0));

  // Canvas on the solid part of the left wall.
  g.add(at(F.makeWallArt({ w: 0.85, h: 0.62, y: 1.6, art: 0 }), 0.14, 3.3, HALF));

  return g;
}

function diningRoom() {
  const g = new THREE.Group();
  g.name = 'room:dining';

  g.add(at(F.makeRug({ w: 2.9, d: 2.2, color: MAT.rugCool }), 6.0, 2.3, 0));
  g.add(at(F.makeDiningTable({ w: 1.9, d: 1.0 }), 6.0, 2.3, 0));

  // Three chairs per long side.
  for (const x of [5.4, 6.0, 6.6]) {
    g.add(at(F.makeDiningChair(), x, 1.48, 0));
    g.add(at(F.makeDiningChair(), x, 3.12, Math.PI));
  }

  g.add(at(F.makePendantLamp({ y: 1.95, drop: 0.68, radius: 0.3 }), 6.0, 2.3, 0));
  g.add(at(F.makeSideboard({ w: 1.3 }), 4.9, 3.74, Math.PI));
  g.add(at(F.makeWallArt({ w: 1.0, h: 0.5, y: 1.65, art: 1 }), 4.9, 3.88, Math.PI));
  g.add(at(F.makePlant({ h: 1.15 }), 7.5, 0.55, 0));

  return g;
}

function kitchen() {
  const g = new THREE.Group();
  g.name = 'room:kitchen';

  // Back-of-house run against the front wall; the sink lands under the window.
  g.add(at(F.makeCounterRun({ len: 2.7, facing: 1, sink: 0.26, stove: -0.93, cooktop: true }), 9.65, 0.26 + 0.31, 0));
  g.add(at(F.makeUpperCabinets({ len: 1.0, facing: 1, y: 1.72 }), 8.8, 0.26, 0));
  g.add(at(F.makeFridge(), 11.56, 0.51, 0));

  g.add(at(F.makeIsland({ w: 1.7, d: 0.92 }), 9.9, 2.5, 0));
  g.add(at(F.makeStool({ height: 0.66 }), 9.5, 3.25, 0));
  g.add(at(F.makeStool({ height: 0.66 }), 10.3, 3.25, 0));

  g.add(at(F.makePantry({ w: 0.7, h: 2.1 }), 11.62, 3.4, -HALF));
  g.add(at(F.makePlant({ h: 0.95 }), 8.55, 3.55, 0));
  g.add(at(F.makeWallArt({ w: 0.7, h: 0.55, y: 1.6, art: 2 }), 10.9, 3.88, Math.PI));

  return g;
}

function hallway() {
  const g = new THREE.Group();
  g.name = 'room:hall';

  g.add(at(F.makeRug({ w: 2.6, d: 0.85, color: MAT.rugSoft, border: false }), 6.0, 5.0, 0));

  // Console on the stretch of wall between the living-room and dining doors.
  g.add(at(F.makeConsoleTable({ w: 1.2 }), 3.85, 4.36, 0));
  g.add(at(F.makeWallArt({ w: 0.9, h: 0.62, y: 1.6, art: 3 }), 3.85, 4.16, 0));
  g.add(at(F.makeBench({ w: 1.3 }), 3.9, 5.6, Math.PI));

  g.add(at(F.makeCoatRack(), 7.6, 4.5, 0));
  g.add(at(F.makeMirror({ w: 0.7, h: 0.95, y: 1.3 }), 7.5, 5.87, Math.PI));
  g.add(at(F.makeConsoleTable({ w: 1.0, h: 0.74 }), 11.1, 4.36, 0));
  g.add(at(F.makePlant({ h: 1.2 }), 0.7, 5.5, 0));

  return g;
}

function bedroom() {
  const g = new THREE.Group();
  g.name = 'room:bedroom';

  // Headboard against the solid wall (x = 4); rotating -90° sends the
  // bed's local "head" end to +X.
  g.add(at(F.makeBed({ w: 1.7, len: 2.05 }), 2.895, 8.4, -HALF));

  g.add(at(F.makeNightstand(), 3.65, 7.2, 0));
  g.add(at(F.makeNightstand(), 3.65, 9.6, 0));
  g.add(at(F.makeTableLamp({ h: 0.36 }), 3.65, 9.6, 0));

  g.add(at(F.makeRug({ w: 1.9, d: 2.4, color: MAT.rugSoft }), 1.15, 8.4, 0));

  g.add(at(F.makeWardrobe({ w: 1.5, h: 2.2 }), 0.8, 6.36, 0));
  g.add(at(F.makeDesk({ w: 1.2, d: 0.6 }), 3.3, 6.36, 0));
  g.add(at(F.makeOfficeChair(), 3.3, 7.15, Math.PI));
  // Dresser tucked under the side window (sill is at 0.95).
  g.add(at(F.makeDresser({ w: 1.2 }), 0.34, 7.7, HALF));

  g.add(at(F.makePlant({ h: 1.05 }), 0.6, 9.6, 0));
  g.add(at(F.makeWallArt({ w: 0.6, h: 0.45, y: 1.75, art: 4 }), 3.3, 6.14, 0));

  return g;
}

function bathroom() {
  const g = new THREE.Group();
  g.name = 'room:bath';

  g.add(at(F.makeBathtub({ len: 1.7, w: 0.78 }), 7.5, 9.0, 0));
  g.add(at(F.makeToilet(), 7.55, 6.9, -HALF));
  g.add(at(F.makeVanity({ w: 1.1 }), 4.33, 8.3, HALF));
  g.add(at(F.makeMirror({ w: 0.6, h: 0.85, y: 1.32 }), 4.14, 8.3, HALF));
  g.add(at(F.makeTowelRack({ len: 0.7, y: 1.2 }), 7.88, 7.4, -HALF));
  g.add(at(F.makePotShelf({ w: 0.8, y: 1.95 }), 4.14, 6.6, HALF));

  const bathMat = F.makeRug({ w: 0.85, d: 0.55, color: MAT.rugCool, border: false });
  g.add(at(bathMat, 6.0, 7.1, 0));
  g.add(at(F.makePlant({ h: 0.8 }), 4.5, 9.5, 0));

  return g;
}

function study() {
  const g = new THREE.Group();
  g.name = 'room:study';

  g.add(at(F.makeRug({ w: 2.2, d: 1.8, color: MAT.rugWarm }), 9.9, 8.1, 0));
  g.add(at(F.makeDesk({ w: 1.4, d: 0.62 }), 8.39, 8.5, HALF));
  g.add(at(F.makeOfficeChair(), 9.25, 8.5, -HALF));

  g.add(at(F.makeBookshelf({ w: 1.1, h: 1.9 }), 11.35, 9.68, Math.PI));
  g.add(at(F.makeArmchair({ fabric: MAT.sofaCushion }), 11.3, 6.5, 0));
  g.add(at(F.makeFloorLamp({ h: 1.5 }), 8.5, 6.6, 0));
  g.add(at(F.makePlant({ h: 1.1 }), 9.0, 9.5, 0));
  g.add(at(F.makeWallArt({ w: 0.8, h: 0.6, y: 1.65, art: 2 }), 8.14, 7.0, HALF));

  return g;
}

export function buildFurnishings() {
  const root = new THREE.Group();
  root.name = 'furniture';
  root.add(livingRoom(), diningRoom(), kitchen(), hallway(), bedroom(), bathroom(), study());
  return root;
}
