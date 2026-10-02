import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

import { CAMERA, HOUSE, ROOMS } from './config.js';
import { buildWorld, collectLightmapMeshes } from './world.js';
import { Cutaway } from './cutaway.js';
import { Environment } from './environment.js';
import { UI } from './ui.js';
import { mergeByMaterial } from './utils.js';
import {
  loadProbeVolume,
  setDynamicIntensity,
  patchForDynamicLight,
  refreshDynamicLight,
} from './bakedlight.js';
import {
  loadLightmap,
  applyLightmap,
  applyLightmapUvs,
  ensureUv1ForUnbaked,
  setLightmapIntensity,
} from './lightmapfile.js';
import { LightmapDebug } from './debug.js';

/* ── Renderer / scene / camera ────────────────────────────────── */

const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// PCFSoftShadowMap was removed in three r186; PCFShadowMap is the soft-ish
// option that remains.
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
// Floor-plan mode slices walls with a clipping plane.
renderer.localClippingEnabled = true;
app.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer({ element: document.getElementById('labels') });
labelRenderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1400);
camera.position.set(...CAMERA.home.pos);

const focus = new THREE.Vector3(...CAMERA.home.target);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(focus);
controls.enableDamping = true;
controls.dampingFactor = 0.065;
controls.rotateSpeed = 0.65;
controls.panSpeed = 0.7;
controls.zoomSpeed = 0.85;
controls.minDistance = CAMERA.minDistance;
controls.maxDistance = CAMERA.maxDistance;
controls.minPolarAngle = 0.02;
controls.maxPolarAngle = Math.PI / 2 + 0.3;
controls.autoRotateSpeed = 0.55;
controls.update();

/* ── Build the world ──────────────────────────────────────────── */

// The same builder the offline bake uses, so the lighting can never drift
// from the geometry it was baked for.
const world = buildWorld({ sims: true, labels: true });
const { house } = world;
const furniture = world.furniture;
const yardMerged = world.yardMerged;
const simsGroup = world.simsGroup;

scene.add(house.group);
scene.add(yardMerged);

/* ── Systems ──────────────────────────────────────────────────── */

const environment = new Environment(scene, renderer, new THREE.Vector3(6, 1.5, 5));
environment.addExteriorLights(world.exteriorLightSpecs);
environment.setHour(12.5);

const cutaway = new Cutaway(house.wallLines, house.roof);
cutaway.setMode('cutaway');

/* ── Baked lighting ───────────────────────────────────────────── */

/**
 * Two baked representations, doing two different jobs:
 *
 *  - **The atlas** lights static geometry. It was baked by Blender with Cycles,
 *    so it carries real GI and proper denoising. It ships as an ordinary PNG,
 *    which is why nothing here unrolls or decodes a custom container.
 *  - **The probe volume** lights the sims. A texture cannot track a moving
 *    object, so they sample a 3D grid by world position instead.
 *
 * The runtime does no unrolling or unwrapping of its own: Blender authoring the
 * UVs means there is no second implementation to disagree with the bake.
 */
let probeVolume = null;
let lightmapDebug = null;
let lightmapMaterials = null;
/** Baked light scale, folded from the 8-bit normalisation and the day/night curve. */
let lightmapPeak = 1;
const simLightUniforms = [];

/**
 * The meshes the bake covers, in the order it recorded them.
 *
 * Taken from the same `collectLightmapMeshes` the exporter used, so the two
 * agree on which mesh is index 0 without either reimplementing the traversal.
 * That agreement is the whole contract: the sidecar holds one face-range table,
 * and a reordering here would paint each surface with another's light.
 */
const lightmapMeshes = collectLightmapMeshes(world);

async function initBakedLighting() {
  /* ── Static: the texture atlas ───────────────────────────── */

  // `BASE_URL` rather than a leading slash, so this still resolves when the app
  // is hosted under a subpath (a GitHub Pages project site, say).
  const base = import.meta.env.BASE_URL;

  const baked = await loadLightmap(base);

  // Both checks below throw rather than warn: a mismatch would put light on the
  // wrong faces with nothing visible to indicate it had happened.
  const totalTriangles = baked.meta.meshes.reduce((n, [, count]) => n + count, 0);
  if (totalTriangles !== baked.meta.triangles) {
    throw new Error(
      `lightmap: the face table covers ${totalTriangles} triangles but the bake ` +
        `records ${baked.meta.triangles}. The sidecar is corrupt.`
    );
  }

  const uvStats = applyLightmapUvs(baked.uv, lightmapMeshes, baked.meta.meshes);

  lightmapMaterials = applyLightmap(scene, baked.texture);

  // Meshes outside the bake still need a `uv1`, because three.js keys the
  // requirement off the material and materials are shared indoors/outdoors.
  // The coordinate is the one the importer cleared to black.
  const added = ensureUv1ForUnbaked(scene, new Set(lightmapMeshes), baked.meta.blackUv);

  lightmapPeak = baked.meta.peak;

  /* ── Dynamic: the probe volume, for the sims ─────────────── */

  probeVolume = await loadProbeVolume(`${base}lightmap.bin`);
  for (const sim of world.simList) {
    simLightUniforms.push(...sim.attachDynamicLight(patchForDynamicLight));
  }

  lightmapDebug = new LightmapDebug(probeVolume, baked, scene);
  ui.setDebugSlices(probeVolume.count[1]);
  ui.setDebugEnabled(true);
  refreshDebugStats();

  return {
    ...uvStats,
    added,
    texels: baked.meta.atlasSize,
    texelsPerMetre: baked.meta.texelsPerMetre,
    materials: lightmapMaterials.size,
  };
}

/** Push the debug view's numbers into the panel. */
function refreshDebugStats() {
  if (!lightmapDebug) return;
  const r = lightmapDebug.report();
  ui.setDebugStats(r.text);
  const [l0, l1, l2] = lightmapDebug.bandSummary();
  ui.setDebugBands(`band energy · L0 ${l0}% · L1 ${l1}% · L2 ${l2}%`);
}

/* ── Camera moves ─────────────────────────────────────────────── */

const view = {
  from: new THREE.Vector3(),
  to: new THREE.Vector3(),
  fromTarget: new THREE.Vector3(),
  toTarget: new THREE.Vector3(),
  t: 1,
  dur: 1,
};

const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

function flyTo(position, target, dur = 1) {
  view.from.copy(camera.position);
  view.to.set(...position);
  view.fromTarget.copy(controls.target);
  view.toTarget.set(...target);
  view.t = 0;
  view.dur = dur;
}

const PLAN_VIEW = { pos: [7.3, 26, 6.2], target: [7.3, 0, 5] };

function focusRoom(id) {
  const room = ROOMS.find((r) => r.id === id);
  if (!room) return;
  const cx = (room.x0 + room.x1) / 2;
  const cz = (room.z0 + room.z1) / 2;
  // Same viewing diagonal for every room, so the cutaway always drops the
  // same set of walls and the room is never entered from behind.
  flyTo([cx + 6.5, 6.2, cz - 7.2], [cx, HOUSE.foundationLift + 1.1, cz], 0.95);
}

/* ── UI ───────────────────────────────────────────────────────── */

let currentMode = 'cutaway';

/** Single entry point for view changes, shared by the panel and the keyboard. */
function applyView(mode) {
  const wasPlan = currentMode === 'plan';
  currentMode = mode;
  ui.setView(mode);
  cutaway.setMode(mode);

  // The roof only belongs on the sealed-up view; the other two need to
  // look down into the rooms.
  cutaway.setRoofVisible(mode === 'full');

  if (mode === 'plan') {
    // Offset right of the house so the control panel, which overlays the
    // right-hand side of the viewport, does not sit on top of the plan.
    flyTo(PLAN_VIEW.pos, PLAN_VIEW.target, 1.15);
  } else if (wasPlan) {
    // A bird's-eye camera showing only the roof is useless, so come back
    // out to the default three-quarter view.
    flyTo(CAMERA.home.pos, CAMERA.home.target, 1.0);
  }

  // Screen-space labels would sit on top of the roof, so hide them there.
  setLabelVisibility(mode !== 'full');
}

const ui = new UI({
  onView: applyView,

  onRoof(on) {
    cutaway.setRoofVisible(on);
  },

  onFurniture(on) {
    furniture.visible = on;
  },

  onLamps(on) {
    // The room lights are baked, so "off" means zeroing the baked term
    // rather than hiding any real light.
    environment.setInteriorMode(on ? 'auto' : 'off');
  },

  onSims(on) {
    simsGroup.visible = on;
  },

  onYard(on) {
    yardMerged.visible = on;
  },

  onHour(hour) {
    environment.setHour(hour);
  },

  onAuto(on) {
    environment.setAuto(on);
  },

  onSpin(on) {
    controls.autoRotate = on;
  },

  onReset() {
    cutaway.setRoofVisible(false);
    setLabelVisibility(true);
    applyView('cutaway');
    flyTo(CAMERA.home.pos, CAMERA.home.target, 1.1);
  },

  onFocusRoom: focusRoom,

  // ── Lightmap debug ───────────────────────────────────────────
  onDebugProbes(on) {
    if (!lightmapDebug) return;
    lightmapDebug.setVisible(on);
    refreshDebugStats();
  },
  onDebugXray(on) {
    lightmapDebug?.setXray(on);
  },
  onDebugBuried(on) {
    lightmapDebug?.setOnlyBuried(on);
    refreshDebugStats();
  },
  onDebugOverlay(on, gain = 0.35) {
    lightmapDebug?.setOverlay(on, gain);
  },
  onDebugAtlasVisible(on) {
    lightmapDebug?.setAtlasVisible(on);
  },
  onDebugAtlas(patch) {
    lightmapDebug?.setAtlas(patch);
  },
  onDebugDirection(dir) {
    lightmapDebug?.setDirection(dir);
    refreshDebugStats();
  },
  onDebugBands(bands) {
    lightmapDebug?.setBands(bands);
    refreshDebugStats();
  },
  onDebugSlice(index) {
    lightmapDebug?.setSlice(index);
    refreshDebugStats();
  },
  onDebugSize(size) {
    lightmapDebug?.setSize(size);
  },
  onDebugGain(gain) {
    lightmapDebug?.setGain(gain);
    refreshDebugStats();
  },
});

function setLabelVisibility(on) {
  for (const label of house.labels) label.el.classList.toggle('dim', !on);
}

/* ── Keyboard ─────────────────────────────────────────────────── */

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;

  switch (e.key.toLowerCase()) {
    case 'c':
      ui.setRoof(false);
      applyView('cutaway');
      break;
    case 'p':
      applyView('plan');
      break;
    case 'f':
      ui.furniture.checked = !ui.furniture.checked;
      furniture.visible = ui.furniture.checked;
      break;
    case 'r':
      ui.roof.checked = !ui.roof.checked;
      cutaway.setRoofVisible(ui.roof.checked);
      break;
    case 'h':
      ui.togglePanel();
      break;
    case 'd':
      ui.toggleLightmap();
      break;
    case ' ':
      e.preventDefault();
      ui.setAuto(!ui.auto.checked);
      environment.setAuto(ui.auto.checked);
      break;
    case 'o':
      ui.setSpin(!ui.spin.checked);
      controls.autoRotate = ui.spin.checked;
      break;
    case '1': applyPreset(6.4); break;
    case '2': applyPreset(12.5); break;
    case '3': applyPreset(18.8); break;
    case '4': applyPreset(23); break;
  }
});

function applyPreset(hour) {
  ui.setAuto(false);
  environment.setAuto(false);
  ui.setHour(hour);
  environment.setHour(hour);
}

/* ── Resize ───────────────────────────────────────────────────── */

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
}
window.addEventListener('resize', onResize);

/* ── Loop ─────────────────────────────────────────────────────── */

const clock = { last: performance.now() };
let elapsed = 0;

function animate(now) {
  const t = now ?? performance.now();
  const dt = Math.min((t - clock.last) / 1000, 0.05);
  clock.last = t;
  elapsed += dt;

  if (view.t < 1) {
    view.t = Math.min(1, view.t + dt / view.dur);
    const k = easeInOut(view.t);
    camera.position.lerpVectors(view.from, view.to, k);
    controls.target.lerpVectors(view.fromTarget, view.toTarget, k);
  }

  controls.update();

  const state = environment.update(dt, camera);

  // Drive both baked representations from the same curve that lights the lamps
  // and windows, so nothing can disagree with the fixtures about the hour.
  //
  // The peak factor restores the range the 8-bit PNG normalised away: the
  // texture stores 0..1 of the bake's own maximum, so multiplying by that
  // maximum is what turns it back into radiance. Folding it in here rather than
  // baking it into the image keeps one number to reason about.
  const interior = environment.interiorFactor * (ui.lamps.checked ? 1 : 0);
  if (lightmapMaterials) setLightmapIntensity(lightmapMaterials, interior * lightmapPeak);
  setDynamicIntensity(interior);

  if (simsGroup.visible && probeVolume) {
    for (const sim of world.simList) {
      for (const uniform of sim.lightUniforms) {
        refreshDynamicLight(probeVolume, sim.root.position, uniform);
      }
      sim.update(dt, elapsed);
    }
  }

  if (environment.auto) ui.setHour(environment.hour);
  ui.setClock(environment.hour, state.label);

  // Fade walls using the point the user is actually looking at, not the
  // house centre, so panning the view re-culls sensibly.
  cutaway.update(camera.position, controls.target, dt);

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);
// Prime the frame timer so the first delta is not the whole page load.
clock.last = performance.now();

/* ── Boot ─────────────────────────────────────────────────────── */

ui.setClock(environment.hour, environment.phaseLabel || 'Midday');
applyView('cutaway');
ui.setRoof(false);

initBakedLighting()
  .then((stats) => {
    // Field names must match what `initBakedLighting` returns; a stale one here
    // throws *after* the lightmap has applied, which reads as a failure in the
    // console when the lighting actually worked.
    console.info(
      `lightmap: ${stats.texels}px atlas at ${stats.texelsPerMetre.toFixed(1)} texels/m, ` +
        `${stats.materials} materials, ${stats.meshes} meshes from the bake`
    );
  })
  .catch((err) => {
    // A missing or stale bake should not blank the scene — the sun, sky and the
    // lamp post are all still real-time, so the house stays explorable.
    console.error('baked light unavailable:', err.message);
  })
  .finally(() => ui.hideLoader());

// Handy during development: poke at the scene from the console.
if (import.meta.env.DEV) {
  window.house3d = {
    THREE,
    scene,
    camera,
    controls,
    renderer,
    environment,
    cutaway,
    house,
    furniture,
    yardMerged,
    world,
    setLightmapIntensity,
    get lightmapMaterials() {
      return lightmapMaterials;
    },
    get probeVolume() {
      return probeVolume;
    },
    get lightmapDebug() {
      return lightmapDebug;
    },
  };
}
