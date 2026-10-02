import * as THREE from 'three';
import { MAT } from './materials.js';
import { box, cyl, sph, group } from './utils.js';

/**
 * Two blocky "Sims" pottering around the house. Each follows a hand-authored
 * waypoint loop that only ever crosses the floor through real doorways.
 */

const PLUMBOB = new THREE.MeshStandardMaterial({
  color: 0x6cf07a,
  emissive: 0x39d95a,
  emissiveIntensity: 2.4,
  roughness: 0.2,
  metalness: 0.1,
  transparent: true,
  opacity: 0.92,
});

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

    // Everything above the hips bobs as one unit.
    this.body = new THREE.Group();
    this.root.add(this.body);

    // Hips / pelvis
    this.body.add(box(0.34, 0.2, 0.22, trouserMat, [0, 0.74, 0]));

    // Torso tapering to shoulders
    this.body.add(box(0.36, 0.44, 0.24, shirtMat, [0, 0.94, 0]));
    this.body.add(box(0.4, 0.16, 0.26, shirtMat, [0, 1.24, 0]));
    // Collar
    this.body.add(box(0.17, 0.07, 0.18, skinMat, [0, 1.38, 0]));

    // Neck + head
    this.body.add(cyl(0.055, 0.06, 0.1, skinMat, [0, 1.4, 0], 10));
    this.head = new THREE.Group();
    this.head.position.set(0, 1.5, 0);
    this.body.add(this.head);
    this.head.add(sph(0.15, skinMat, [0, 0.12, 0], 16));
    // Hair: a cap plus a fringe box
    const cap = sph(0.155, hairMat, [0, 0.14, -0.01], 16);
    cap.scale.set(1, 0.85, 1);
    this.head.add(cap);
    this.head.add(box(0.3, 0.09, 0.3, hairMat, [-0.15, 0.15, -0.15]));
    // Eyes
    for (const s of [-1, 1]) {
      this.head.add(sph(0.027, MAT.black, [s * 0.055, 0.13, 0.135], 8));
    }

    // Arms with shoulder pivots
    this.armL = new THREE.Group();
    this.armR = new THREE.Group();
    for (const [pivot, s] of [[this.armL, -1], [this.armR, 1]]) {
      pivot.position.set(s * 0.235, 1.3, 0);
      pivot.add(sph(0.075, shirtMat, [0, 0, 0], 10));
      pivot.add(cyl(0.055, 0.05, 0.44, shirtMat, [0, -0.44, 0], 10));
      pivot.add(cyl(0.05, 0.045, 0.16, skinMat, [0, -0.6, 0], 10));
      this.body.add(pivot);
    }

    // Legs with hip pivots
    this.legL = new THREE.Group();
    this.legR = new THREE.Group();
    for (const [pivot, s] of [[this.legL, -1], [this.legR, 1]]) {
      pivot.position.set(s * 0.1, 0.76, 0);
      pivot.add(cyl(0.075, 0.065, 0.62, trouserMat, [0, -0.62, 0], 10));
      pivot.add(box(0.13, 0.09, 0.24, MAT.black, [-0.065, 0, -0.06]));
      this.root.add(pivot);
    }

    // Plumbob, the little green diamond. Never merged: it spins.
    this.plumbob = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), PLUMBOB);
    this.plumbob.position.set(0, 1.92, 0);
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
     * Baked-light uniforms, one per sim. Filled per frame from the probe
     * volume by `refreshDynamicLight`, because a character's vertices cannot
     * carry lighting baked for a position it has since walked away from.
     * @type {Array<{value: import('three').Vector3}>}
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

    // Limb swing + a slight bob and sway.
    const swing = Math.sin(this.legPhase) * 0.55;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.8;
    this.armR.rotation.x = swing * 0.8;
    this.armL.rotation.z = 0.08;
    this.armR.rotation.z = -0.08;

    const idle = this.pauseFor > 0 ? 0.4 : 1;
    this.body.position.y = Math.abs(Math.sin(this.legPhase)) * 0.035 * idle;
    this.body.rotation.z = Math.sin(this.legPhase) * 0.025;
    this.head.rotation.y = Math.sin(elapsed * 0.7 + this.speed * 9) * 0.28;

    // Plumbob bobs and spins.
    this.plumbob.rotation.y = elapsed * 2.2;
    this.plumbob.position.y = 1.92 + Math.sin(elapsed * 2.6) * 0.045;
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
