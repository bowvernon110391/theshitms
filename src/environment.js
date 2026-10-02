import * as THREE from 'three';
import { Sky } from './sky.js';
import { EMISSIVE_TARGETS } from './materials.js';
import { sampleKeys } from './utils.js';

/**
 * A single day, sampled as keyframes. Each key holds every value the
 * environment needs, so blending between two keys gives a fully coherent
 * look at any hour — sky, sun, fog, exposure and interior lighting all move
 * together instead of being tuned separately.
 */
const C = (hex) => new THREE.Color(hex);

export const TIME_KEYS = [
  {
    at: 0, label: 'Night',
    skyTop: C(0x04060f), skyBottom: C(0x080d18), sunColor: C(0x4b6a99),
    sunStrength: 0.10, sunSize: 0.012, sunIntensity: 0.06,
    hemiSky: C(0x16203c), hemiGround: C(0x0a0d14), hemiIntensity: 0.26,
    ambColor: C(0x1b2540), ambIntensity: 0.30,
    fogColor: C(0x070b14), fogNear: 18, fogFar: 78,
    starOpacity: 1.0, exposure: 0.92, interior: 1.0,
  },
  {
    at: 4.6, label: 'Dawn',
    skyTop: C(0x0e1830), skyBottom: C(0x33365a), sunColor: C(0x8a7fae),
    sunStrength: 0.30, sunSize: 0.016, sunIntensity: 0.22,
    hemiSky: C(0x3a4568), hemiGround: C(0x1c1a1c), hemiIntensity: 0.42,
    ambColor: C(0x40415e), ambIntensity: 0.34,
    fogColor: C(0x2a2c44), fogNear: 14, fogFar: 66,
    starOpacity: 0.5, exposure: 0.96, interior: 0.85,
  },
  {
    at: 6.4, label: 'Sunrise',
    skyTop: C(0x3d5f96), skyBottom: C(0xe08a56), sunColor: C(0xffb877),
    sunStrength: 1.0, sunSize: 0.026, sunIntensity: 1.05,
    hemiSky: C(0x8fa6cd), hemiGround: C(0x55402e), hemiIntensity: 0.62,
    ambColor: C(0x6d6678), ambIntensity: 0.34,
    fogColor: C(0xc08a68), fogNear: 16, fogFar: 80,
    starOpacity: 0.05, exposure: 1.0, interior: 0.35,
  },
  {
    at: 9.0, label: 'Morning',
    skyTop: C(0x3f7fd2), skyBottom: C(0xcfe4f5), sunColor: C(0xfff2d6),
    sunStrength: 1.0, sunSize: 0.02, sunIntensity: 2.7,
    hemiSky: C(0xa8c8f0), hemiGround: C(0x76805a), hemiIntensity: 0.92,
    ambColor: C(0xa3b8d2), ambIntensity: 0.36,
    fogColor: C(0xd8e7f4), fogNear: 26, fogFar: 110,
    starOpacity: 0, exposure: 1.0, interior: 0,
  },
  {
    at: 12.5, label: 'Midday',
    skyTop: C(0x2c6ccd), skyBottom: C(0xa9d4f5), sunColor: C(0xfffbf0),
    sunStrength: 1.0, sunSize: 0.019, sunIntensity: 3.0,
    hemiSky: C(0xbcd8f8), hemiGround: C(0x828a5e), hemiIntensity: 0.72,
    ambColor: C(0xb8cfe8), ambIntensity: 0.26,
    fogColor: C(0xcfe3f5), fogNear: 30, fogFar: 120,
    starOpacity: 0, exposure: 0.96, interior: 0,
  },
  {
    at: 16.5, label: 'Afternoon',
    skyTop: C(0x3a78cc), skyBottom: C(0xd6e3ec), sunColor: C(0xfff0cc),
    sunStrength: 1.0, sunSize: 0.021, sunIntensity: 2.4,
    hemiSky: C(0xb2cbe6), hemiGround: C(0x7d7f5c), hemiIntensity: 0.88,
    ambColor: C(0xaec1d6), ambIntensity: 0.37,
    fogColor: C(0xd6e2ee), fogNear: 26, fogFar: 108,
    starOpacity: 0, exposure: 1.0, interior: 0,
  },
  {
    at: 18.8, label: 'Sunset',
    skyTop: C(0x33406e), skyBottom: C(0xe2693c), sunColor: C(0xff9a52),
    sunStrength: 1.0, sunSize: 0.028, sunIntensity: 1.15,
    hemiSky: C(0x9a86a8), hemiGround: C(0x6a4a34), hemiIntensity: 0.56,
    ambColor: C(0x7a6588), ambIntensity: 0.36,
    fogColor: C(0xc0765a), fogNear: 16, fogFar: 78,
    starOpacity: 0.08, exposure: 1.02, interior: 0.5,
  },
  {
    at: 20.4, label: 'Dusk',
    skyTop: C(0x161e42), skyBottom: C(0x6a4a6a), sunColor: C(0x7a6a90),
    sunStrength: 0.34, sunSize: 0.016, sunIntensity: 0.24,
    hemiSky: C(0x4a4a6e), hemiGround: C(0x2a2028), hemiIntensity: 0.4,
    ambColor: C(0x3c3a54), ambIntensity: 0.34,
    fogColor: C(0x3a3350), fogNear: 14, fogFar: 70,
    starOpacity: 0.6, exposure: 0.98, interior: 0.95,
  },
  {
    at: 22.5, label: 'Night',
    skyTop: C(0x070b1c), skyBottom: C(0x101828), sunColor: C(0x48628f),
    sunStrength: 0.12, sunSize: 0.012, sunIntensity: 0.08,
    hemiSky: C(0x1a2440), hemiGround: C(0x0b0e16), hemiIntensity: 0.28,
    ambColor: C(0x1d2740), ambIntensity: 0.3,
    fogColor: C(0x0a0f1c), fogNear: 18, fogFar: 76,
    starOpacity: 1.0, exposure: 0.93, interior: 1.0,
  },
  {
    at: 24, label: 'Night',
    skyTop: C(0x04060f), skyBottom: C(0x080d18), sunColor: C(0x4b6a99),
    sunStrength: 0.10, sunSize: 0.012, sunIntensity: 0.06,
    hemiSky: C(0x16203c), hemiGround: C(0x0a0d14), hemiIntensity: 0.26,
    ambColor: C(0x1b2540), ambIntensity: 0.30,
    fogColor: C(0x070b14), fogNear: 18, fogFar: 78,
    starOpacity: 1.0, exposure: 0.92, interior: 1.0,
  },
];

export class Environment {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Vector3} focus centre of the house, for shadows
   */
  constructor(scene, renderer, focus = new THREE.Vector3(6, 1.5, 5)) {
    this.scene = scene;
    this.renderer = renderer;
    this.focus = focus;
    this.hour = 12.5;
    this.auto = false;
    this.dayLength = 150; // seconds per full 24 h cycle
    this.interiorMode = 'auto'; // 'auto' | 'on' | 'off'

    this.sky = new Sky();
    scene.add(this.sky.group);

    // ── Sun / moon ─────────────────────────────────────────────
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 90;
    this.sun.shadow.camera.left = -16;
    this.sun.shadow.camera.right = 16;
    this.sun.shadow.camera.top = 16;
    this.sun.shadow.camera.bottom = -16;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.028;
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;
    scene.add(this.sun);

    // ── Fill ───────────────────────────────────────────────────
    this.hemi = new THREE.HemisphereLight(0xbcd8f8, 0x828a5e, 1);
    scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xb8cfe8, 0.4);
    scene.add(this.ambient);

    scene.fog = new THREE.Fog(0xcfe3f5, 30, 120);

    /**
     * Real-time lamps that are NOT baked — currently just the lamp post.
     * It stays dynamic because its spill onto the lawn should be smooth, and
     * the interior lights are all baked so they cannot leak through walls.
     * @type {Array<{light: THREE.PointLight, base: number}>}
     */
    this.lamps = [];
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this._state = null;
    this._interior = 1;
  }

  /** Register outdoor lamps that stay real-time. */
  addExteriorLights(descriptors) {
    for (const d of descriptors) {
      const light = new THREE.PointLight(d.color, 0, d.distance ?? 12, 2);
      light.position.set(d.position[0], d.position[1], d.position[2]);
      light.name = d.name ?? 'exteriorLight';
      this.scene.add(light);
      this.lamps.push({ light, base: d.intensity ?? 12 });
    }
  }

  setHour(h) {
    this.hour = ((h % 24) + 24) % 24;
  }

  setAuto(on) {
    this.auto = on;
  }

  setInteriorMode(mode) {
    this.interiorMode = mode;
  }

  get phaseLabel() {
    return this._state ? this._state.label : '';
  }

  /** True once the sun has effectively set — used to tint UI, etc. */
  get isDark() {
    return this._interior > 0.5;
  }

  /**
   * How strongly the artificial lights are contributing right now, 0..1.
   * Drives the baked probe intensity and the lamp/window emissives together,
   * so the bake and the glowing fixtures can never disagree about whether
   * it is "night inside".
   */
  get interiorFactor() {
    return this._interior;
  }

  _interiorFactor(state) {
    if (this.interiorMode === 'on') return 1;
    if (this.interiorMode === 'off') return 0;
    return state.interior;
  }

  update(dt, camera) {
    if (this.auto) {
      this.setHour(this.hour + (dt * 24) / this.dayLength);
    }

    const s = sampleKeys(TIME_KEYS, this.hour);
    this._state = s;

    // ── Sun position on a tilted arc ───────────────────────────
    const angle = ((this.hour - 6) / 12) * Math.PI;
    let x = Math.cos(angle);
    let y = Math.sin(angle);
    let z = 0.34;
    if (y < 0.06) {
      // Below the horizon: flip to the moon's side of the sky.
      x = -x;
      y = 0.3 + (0.06 - y) * 0.3;
      z = -z;
    }
    this.sunDir.set(x, y, z).normalize();

    this.sun.position.copy(this.sunDir).multiplyScalar(42).add(this.focus);
    this.sunTarget.position.copy(this.focus);
    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity;

    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;

    this.ambient.color.copy(s.ambColor);
    this.ambient.intensity = s.ambIntensity;

    this.scene.fog.color.copy(s.fogColor);
    this.scene.fog.near = s.fogNear;
    this.scene.fog.far = s.fogFar;

    this.renderer.toneMappingExposure = s.exposure;

    this.sky.apply(s, this.sunDir, Math.min(this.renderer.getPixelRatio(), 2));
    this.sky.update(camera, performance.now() * 0.001);

    // ── Artificial light ───────────────────────────────────────
    const f = this._interiorFactor(s);
    this._interior = f;

    for (const entry of this.lamps) {
      // A whisper of flicker keeps the lamps from looking like flat sprites.
      const flicker = 1 + Math.sin(performance.now() * 0.0011 + entry.base) * 0.012;
      entry.light.intensity = entry.base * f * flicker;
    }

    for (const target of EMISSIVE_TARGETS) {
      target.material[target.key] = target.max * f;
    }

    return s;
  }
}
