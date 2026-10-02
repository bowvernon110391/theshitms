import * as THREE from 'three';
import { MAT } from './materials.js';
import { boxC, sph, group } from './utils.js';

/**
 * Two low-poly "Sims" pottering around the house. Each follows a hand-authored
 * waypoint loop that only ever crosses the floor through real doorways.
 *
 * ## Low-poly, yes — boxy, no
 *
 * These were built out of axis-aligned boxes and read as blocky for two
 * reasons, and only one of them was the polycount.
 *
 * The first was shape. A box has hard edges at every corner, so a torso made of
 * three boxes has three sets of them and no silhouette to speak of. The parts
 * here are ellipsoids and capsules instead: same order of triangle count, but
 * with smooth analytic normals, so they shade as rounded volumes. Several of
 * them overlap deliberately — the waist and chest capsules are separate volumes
 * whose intersection reads as a tapered trunk, which is cheaper and rounder
 * than modelling one.
 *
 * The second was a genuine bug. The feet were built as children of the leg
 * *pivots*, which put them at hip height — and because the legs stopped short
 * of the floor, nothing was at y = 0 at all. Each sim floated 14 cm above the
 * ground with two black boxes resting on its hip.
 *
 * ## Scale is baked into the geometry, not the transform
 *
 * `ellipsoid` calls `geometry.scale()`. The dynamic-light shader reconstructs a
 * world normal as `mat3( modelMatrix ) * objectNormal`, which is only correct
 * while the model matrix carries no non-uniform scale. Baking the scale in
 * keeps that true; it also means these never need per-part matrix work.
 */

/* Proportions, in metres. A sim is ~1.75 m tall including hair. */
const HIP_Y = 0.86;
const THIGH = 0.42;
const SHIN = 0.40;
const SHOULDER_Y = 1.30;
const PLUMBOB_Y = 1.95;

const PLUMBOB = new THREE.MeshStandardMaterial({
  color: 0x6cf07a,
  emissive: 0x39d95a,
  emissiveIntensity: 2.4,
  roughness: 0.2,
  metalness: 0.1,
  transparent: true,
  opacity: 0.92,
});

/**
 * A smoothly shaded ellipsoid.
 *
 * Non-uniform radii are baked into the geometry — see the note at the top about
 * world normals.
 */
function ellipsoid(rx, ry, rz, material, pos = [0, 0, 0], segments = 10) {
  const geometry = new THREE.SphereGeometry(1, segments, Math.max(6, Math.round(segments * 0.6)));
  geometry.scale(rx, ry, rz);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A smoothly shaded capsule, `length` tall along Y and centred on `pos`.
 *
 * `capSegments = 3` is the low-poly end of what still reads as round; three
 * generates the normals analytically from the profile, so the caps shade
 * smoothly even at this resolution.
 */
function capsule(radius, length, material, pos = [0, 0, 0], segments = 10) {
  const geometry = new THREE.CapsuleGeometry(
    radius,
    Math.max(length - 2 * radius, 0.001),
    3,
    segments
  );

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

class Sim {
  constructor({ name, shirt, trousers, hair, skin, route, speed }) {
    this.name = name;
    this.route = route;
    this.speed = speed;
    this.legPhase = 0;
    this.index = 0;
    this.heading = 0;
    this.pauseFor = 0;

    this.root = new THREE.Group();
    this.root.name = `sim:${name}`;

    const shirtMat = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.85 });
    const trouserMat = new THREE.MeshStandardMaterial({ color: trousers, roughness: 0.9 });
    const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.82 });
    const hairMat = new THREE.MeshStandardMaterial({ color: hair, roughness: 0.95 });

    // Everything above the hips bobs and sways as one unit.
    this.body = new THREE.Group();
    this.root.add(this.body);

    // Trunk: pelvis, waist, chest. Three overlapping volumes rather than three
    // boxes — the overlaps produce the taper, and the rounded silhouette is
    // most of what stops these reading as blocky.
    this.body.add(ellipsoid(0.175, 0.125, 0.12, trouserMat, [0, HIP_Y, 0]));
    this.body.add(capsule(0.128, 0.30, shirtMat, [0, 1.02, 0]));
    this.body.add(capsule(0.145, 0.30, shirtMat, [0, 1.20, 0]));
    this.body.add(ellipsoid(0.205, 0.105, 0.13, shirtMat, [0, 1.325, 0]));

    // Neck, then the head as its own group so it can turn independently.
    this.body.add(capsule(0.052, 0.13, skinMat, [0, 1.42, 0]));
    this.head = new THREE.Group();
    this.head.position.set(0, 1.50, 0);
    this.body.add(this.head);

    this.head.add(ellipsoid(0.113, 0.138, 0.122, skinMat, [0, 0.09, 0]));
    // Hair: a shell barely larger than the skull, pushed up and back so the
    // face stays exposed. The old build used a box parked at (-0.15, 0.15,
    // -0.15) relative to the head — off-centre, which hung it off one corner.
    this.head.add(ellipsoid(0.126, 0.116, 0.131, hairMat, [0, 0.128, -0.012]));
    for (const s of [-1, 1]) {
      this.head.add(sph(0.021, MAT.black, [s * 0.048, 0.082, 0.113], 8));
    }

    // Arms: a shoulder and an elbow pivot each, so the swing has a joint in it.
    // The old single straight cylinder is a large part of why the walk read as
    // stiff.
    this.shoulderL = new THREE.Group();
    this.shoulderR = new THREE.Group();
    this.elbowL = new THREE.Group();
    this.elbowR = new THREE.Group();

    for (const [shoulder, elbow, s] of [
      [this.shoulderL, this.elbowL, -1],
      [this.shoulderR, this.elbowR, 1],
    ]) {
      shoulder.position.set(s * 0.195, SHOULDER_Y, 0);
      shoulder.add(ellipsoid(0.075, 0.072, 0.075, shirtMat, [0, 0, 0]));
      shoulder.add(capsule(0.056, 0.31, shirtMat, [0, -0.155, 0]));

      elbow.position.set(0, -0.30, 0);
      elbow.add(capsule(0.048, 0.28, skinMat, [0, -0.14, 0]));
      elbow.add(ellipsoid(0.05, 0.062, 0.042, skinMat, [0, -0.295, 0]));

      shoulder.add(elbow);
      this.body.add(shoulder);
    }

    // Legs: hip and knee pivots, sole landing exactly on y = 0.
    //
    // The foot is placed by its base at `-SHIN` from the knee, and
    // `HIP_Y - THIGH - SHIN = 0.04` is the ankle height — so the sole sits at
    // 0.04 - 0.04 = 0. Getting this wrong is what left the previous build's
    // feet floating at the hips with nothing touching the floor.
    this.hipL = new THREE.Group();
    this.hipR = new THREE.Group();
    this.kneeL = new THREE.Group();
    this.kneeR = new THREE.Group();

    for (const [hip, knee, s] of [
      [this.hipL, this.kneeL, -1],
      [this.hipR, this.kneeR, 1],
    ]) {
      hip.position.set(s * 0.095, HIP_Y, 0);
      hip.add(capsule(0.086, THIGH, trouserMat, [0, -THIGH / 2, 0]));

      knee.position.set(0, -THIGH, 0);
      knee.add(capsule(0.062, SHIN, trouserMat, [0, -SHIN / 2, 0]));
      knee.add(boxC(0.115, 0.08, 0.235, MAT.black, [0, -SHIN, 0.035]));

      hip.add(knee);
      // Parented to the root, not the body: the bob moves the trunk only, so
      // the planted leg does not sink through the floor with it.
      this.root.add(hip);
    }

    // Plumbob, the little green diamond. Never merged: it spins.
    this.plumbob = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), PLUMBOB);
    this.plumbob.position.set(0, PLUMBOB_Y, 0);
    this.plumbob.scale.set(0.7, 1.35, 0.7);
    this.plumbob.userData.noMerge = true;
    this.root.add(this.plumbob);

    this.root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        // Opt out of the static bake: a character's vertices cannot carry
        // lighting baked for a position it has since walked away from.
        o.userData.dynamicLight = true;
      }
    });

    /**
     * Baked-light uniform sets, one per material. Filled per frame from the
     * probe volume by `refreshDynamicLight`, because a character's vertices
     * cannot carry lighting baked for a position it has since walked away from.
     * @type {Array<object>}
     */
    this.lightUniforms = [];

    const start = route[0];
    this.root.position.set(start[0], 0, start[1]);
  }

  /**
   * Route this sim's unique materials through the dynamic-light shader path,
   * and return the uniforms the caller must refresh each frame.
   */
  attachDynamicLight(patch) {
    const materials = new Set();
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) materials.add(m);
    });

    for (const m of materials) this.lightUniforms.push(patch(m));
    return this.lightUniforms;
  }

  update(dt, elapsed) {
    // Gentle wandering: walk to the next waypoint, then linger a moment.
    if (this.pauseFor > 0) {
      this.pauseFor -= dt;
    } else {
      const target = this.route[this.index];
      const dx = target[0] - this.root.position.x;
      const dz = target[1] - this.root.position.z;
      const dist = Math.hypot(dx, dz);

      if (dist < 0.12) {
        this.index = (this.index + 1) % this.route.length;
        if (Math.random() < 0.25) this.pauseFor = 0.6 + Math.random() * 1.6;
      } else {
        const step = Math.min(this.speed * dt, dist);
        this.root.position.x += (dx / dist) * step;
        this.root.position.z += (dz / dist) * step;

        // Turn smoothly toward the direction of travel.
        const want = Math.atan2(dx, dz);
        let diff = ((want - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        this.heading += diff * Math.min(1, dt * 6);
        this.legPhase += dt * this.speed * 7.5;
      }
    }

    this.root.rotation.y = this.heading;

    // Limb swing: hips and shoulders in antiphase, knees and elbows bending on
    // the back half of the stroke only — a knee bends one way, so clamping at
    // zero is what stops the leg hinging forward like a puppet.
    const swing = Math.sin(this.legPhase) * 0.5;
    const swingB = Math.sin(this.legPhase + Math.PI) * 0.5;

    this.hipL.rotation.x = swing;
    this.hipR.rotation.x = swingB;
    this.kneeL.rotation.x = Math.max(0, swing) * 1.15;
    this.kneeR.rotation.x = Math.max(0, swingB) * 1.15;

    this.shoulderL.rotation.x = -swing * 0.75;
    this.shoulderR.rotation.x = -swingB * 0.75;
    this.shoulderL.rotation.z = 0.07;
    this.shoulderR.rotation.z = -0.07;
    this.elbowL.rotation.x = -0.18 - Math.max(0, -swing) * 0.5;
    this.elbowR.rotation.x = -0.18 - Math.max(0, -swingB) * 0.5;

    // Bob twice per stride; sway once. The bob is on the trunk only, so the
    // legs stay planted rather than sinking with it.
    const idle = this.pauseFor > 0 ? 0.35 : 1;
    this.body.position.y = Math.abs(Math.sin(this.legPhase)) * 0.025 * idle;
    this.body.rotation.z = Math.sin(this.legPhase) * 0.022;
    this.head.rotation.y = Math.sin(elapsed * 0.7 + this.speed * 9) * 0.28;

    // Plumbob bobs and spins.
    this.plumbob.rotation.y = elapsed * 2.2;
    this.plumbob.position.y = PLUMBOB_Y + Math.sin(elapsed * 2.6) * 0.045;
  }
}

const ROUTE_A = [
  [2.0, 1.3], [4.0, 1.6], [6.0, 1.1], [8.0, 2.0], [9.9, 3.6],
  [9.9, 4.0], [6.1, 4.0], [6.0, 5.0], [6.0, 6.0], [6.2, 7.4],
  [6.0, 6.0], [6.0, 5.0], [2.1, 4.0], [2.9, 2.0], [2.0, 1.3],
];

const ROUTE_B = [
  [1.2, 8.5], [2.1, 7.0], [2.1, 6.0], [2.1, 4.0], [2.9, 2.0],
  [4.0, 1.6], [6.0, 1.1], [6.1, 4.0], [9.9, 4.0], [9.9, 3.6],
  [9.9, 6.0], [9.8, 7.9], [9.9, 6.0], [9.9, 4.0], [6.1, 4.0],
  [6.0, 5.0], [2.1, 4.0], [2.1, 6.0], [2.1, 7.0], [1.2, 8.5],
];

export function buildSims() {
  const root = group('sims');
  const sims = [
    new Sim({
      name: 'Ada',
      shirt: 0x2f9fa8,
      trousers: 0x3c4350,
      hair: 0x2b1f16,
      skin: 0xe8b48c,
      route: ROUTE_A,
      speed: 1.05,
    }),
    new Sim({
      name: 'Miles',
      shirt: 0xb8617a,
      trousers: 0x4a4f5c,
      hair: 0x6b4a2a,
      skin: 0x8d5a3c,
      route: ROUTE_B,
      speed: 0.9,
    }),
  ];

  for (const s of sims) root.add(s.root);
  return { group: root, sims };
}
