import * as THREE from 'three';
import { damp, clamp } from './utils.js';

/**
 * The Sims-style "see inside" behaviour.
 *
 * Three view modes:
 *   cutaway — walls between the camera and the house's centre fade away
 *   full    — everything opaque, roof on
 *   plan    — walls sliced low by a clipping plane, roof off, top-down
 *
 * The occlusion test used for `cutaway` is deliberately simple: a wall fades
 * when it lies on the camera's side of the focus point, because that is
 * exactly the set of walls standing between the two.
 */
export class Cutaway {
  /**
   * @param {Array<{group: THREE.Group, material: THREE.Material, center: THREE.Vector3}>} wallLines
   * @param {THREE.Object3D} roof
   */
  constructor(wallLines, roof) {
    this.wallLines = wallLines;
    this.roof = roof;
    this.mode = 'cutaway';

    // Each wall run owns a private material clone, so we can animate them
    // independently. `state.opacity` is the animated value.
    for (const line of wallLines) {
      line.material.transparent = true;
      line.material.depthWrite = true;
      line.state = { opacity: 1, target: 1 };
    }

    this.plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0.55);
    this.planHeight = 0.55;
    this._dir = new THREE.Vector3();
    this._offset = new THREE.Vector3();
  }

  get planMode() {
    return this.mode === 'plan';
  }

  setMode(mode) {
    this.mode = mode;

    for (const line of this.wallLines) {
      if (mode === 'plan') {
        line.material.clippingPlanes = [this.plane];
        line.material.clipShadows = true;
      } else {
        line.material.clippingPlanes = null;
      }
      line.material.needsUpdate = true;
    }

    this.roof.visible = mode !== 'cutaway';
    if (mode === 'plan') this.roof.visible = false;
  }

  setRoofVisible(v) {
    this.roof.visible = v && this.mode !== 'plan';
  }

  /**
   * @param {THREE.Vector3} camPos
   * @param {THREE.Vector3} focus  point the camera is looking at
   */
  update(camPos, focus, dt) {
    if (this.mode !== 'cutaway') {
      for (const line of this.wallLines) {
        line.state.target = 1;
        this._apply(line, dt);
      }
      return;
    }

    this._dir.copy(camPos).sub(focus);
    this._dir.y *= 0.6; // damp the vertical term so steep views don't over-cull
    if (this._dir.lengthSq() > 1e-6) this._dir.normalize();
    else this._dir.set(0, 1, 0);

    for (const line of this.wallLines) {
      this._offset.copy(line.center).sub(focus);
      const facing = this._offset.dot(this._dir);

      // Occluding walls become a faint ghost rather than vanishing outright,
      // which keeps the floor plan legible from any angle.
      line.state.target = facing > 0 ? 0.07 : 1;
      this._apply(line, dt);
    }
  }

  _apply(line, dt) {
    const s = line.state;
    // Hiding is instant; restoring eases back, so spinning the camera does
    // not strobe the walls.
    const k = damp(s.target < s.opacity ? 22 : 9, dt);
    s.opacity += (s.target - s.opacity) * k;

    const mat = line.material;
    mat.opacity = clamp(s.opacity, 0, 1);
    mat.depthWrite = mat.opacity > 0.96;
    line.group.visible = mat.opacity > 0.03;
  }
}
