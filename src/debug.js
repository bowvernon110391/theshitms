import * as THREE from 'three';
import { shBasis, PROBE_FLAG } from './lightprobe.js';
import { clamp } from './utils.js';
/**
 * Debug views for baked lighting.
 *
 * Three independent views, answering three different questions:
 *
 *  1. **On surfaces** — the lightmap as actually used. Swaps every material for
 *     a flat display of what reaches the surface. This is the view that tells
 *     you whether the lighting *looks right*.
 *  2. **Probe grid** — the 3D SH volume that lights the sims, drawn as spheres.
 *  3. **Atlas texture** — the real 2D lightmap image Blender produced. Shows
 *     whether the *packing* is sane: wasted space, distorted density, and any
 *     region the unwrapper made a poor job of.
 */

/* ── Colour mapping ───────────────────────────────────────────── */

/**
 * Reinhard tone map with an exposure gain.
 *
 * Irradiance near a lamp runs into the tens while much of the atlas sits near
 * zero, so a linear ramp both crushes the mid-tones and — worse — returns
 * values above 1.0, which an untone-mapped material clips to flat white.
 * Reinhard is bounded to [0,1) for any non-negative input, so no channel can
 * exceed the displayable range regardless of the gain.
 */
function toneMap(value, gain) {
  const x = Math.max(value, 0) * gain;
  return x / (1 + x);
}

/**
 * Reinhard, injected into the debug material's shader.
 *
 * Swapped in where `<tonemapping_fragment>` would run — on the linear colour,
 * just before the output colour space conversion. That is the same place the
 * renderer applies its own curve, and it is deliberate that this view does not
 * reuse that curve: the global exposure is driven by the day/night timeline, so
 * borrowing it would make the lightmap appear to change with the hour. A debug
 * view that moves on its own is worse than no debug view.
 */
const REINHARD = /* glsl */ `
  gl_FragColor.rgb = gl_FragColor.rgb / ( 1.0 + gl_FragColor.rgb );
`;

/**
 * The sRGB transfer function, inverted.
 *
 * The lightmap PNG is stored gamma-encoded so that 8 bits are spent where the
 * eye is, and the GPU reverses this on sample. Reading the raw bytes back for
 * the panel means reversing it here too, or the values shown — and anything
 * derived from them — would be the encoded ones, which are not physical.
 */
function srgbToLinear(byte) {
  const v = byte / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * The decoded pixel bytes of a texture, cached per texture.
 *
 * Two of the three debug views need to read the lightmap back off the GPU-side
 * image, and decoding it is a `<canvas>` draw — not something to do twice, and
 * not something to do at all until a view that needs it is opened.
 *
 * `drawImage` is what decodes, so these are the same sRGB bytes the shader
 * receives. Pair with `srgbToLinear` to get back to radiance.
 *
 * @param {THREE.Texture} texture
 * @returns {Uint8ClampedArray} RGBA, `width`² pixels, **top row first**
 */
const pixelCache = new WeakMap();

function readPixels(texture) {
  const hit = pixelCache.get(texture);
  if (hit) return hit;

  const size = texture.image.width;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(texture.image, 0, 0, size, size);

  const data = ctx.getImageData(0, 0, size, size).data;
  pixelCache.set(texture, data);
  return data;
}

const DIRS = {
  px: [1, 0, 0],
  nx: [-1, 0, 0],
  py: [0, 1, 0],
  ny: [0, -1, 0],
  pz: [0, 0, 1],
  nz: [0, 0, -1],
};

const BANDS = { l0: 1, l1: 4, l2: 9 };

/** How much of the probe's actual hue is mixed into the display. */
const TINT = 0.6;

/* ── 1 + 2: the probe field ───────────────────────────────────── */

const PROBE_SPHERE = new THREE.SphereGeometry(1, 8, 6);

class ProbeField {
  constructor(volume) {
    this.volume = volume;
    this.count = volume.probeCount();

    const [nx, ny, nz] = volume.count;
    this.dims = [nx, ny, nz];

    this.material = new THREE.MeshBasicMaterial({
      toneMapped: false,
      transparent: true,
      opacity: 0.92,
    });

    this.mesh = new THREE.InstancedMesh(PROBE_SPHERE, this.material, this.count);
    this.mesh.name = 'probeField';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.count * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;

    // Positions never change, so write them once.
    this.positions = new Float32Array(this.count * 3);
    const span = [
      volume.max.x - volume.min.x,
      volume.max.y - volume.min.y,
      volume.max.z - volume.min.z,
    ];
    let i = 0;
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++, i++) {
          this.positions[i * 3] = volume.min.x + (nx === 1 ? 0 : (ix / (nx - 1)) * span[0]);
          this.positions[i * 3 + 1] = volume.min.y + (ny === 1 ? 0 : (iy / (ny - 1)) * span[1]);
          this.positions[i * 3 + 2] = volume.min.z + (nz === 1 ? 0 : (iz / (nz - 1)) * span[2]);
        }
      }
    }

    this._matrix = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._pos = new THREE.Vector3();

    this.settings = {
      size: 0.075,
      gain: 0.08,
      direction: 'py',
      bands: 'l2',
      slice: -1,
      onlyBuried: false,
    };

    this.stats = { visible: 0, buried: 0, mean: 0, max: 0 };
  }

  refresh() {
    const { size, gain, direction, bands, slice, onlyBuried } = this.settings;
    const vol = this.volume;
    const coeffs = vol.coeffs;
    const flags = vol.flags;
    const bandCount = BANDS[bands];
    const dir = DIRS[direction];

    const acc = new Float32Array(27);
    const [nx, ny, nz] = this.dims;

    let visible = 0;
    let buried = 0;
    let sum = 0;
    let max = 0;
    let i = 0;

    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++, i++) {
          const isBuried = flags.length ? (flags[i] & PROBE_FLAG.BURIED) !== 0 : false;
          if (isBuried) buried++;

          if ((slice >= 0 && iy !== slice) || (onlyBuried && !isBuried)) {
            this._matrix.makeScale(0, 0, 0);
            this.mesh.setMatrixAt(i, this._matrix);
            continue;
          }

          this._pos.set(
            this.positions[i * 3],
            this.positions[i * 3 + 1],
            this.positions[i * 3 + 2]
          );
          this._matrix.compose(this._pos, this._quat, this._scale.setScalar(size));
          this.mesh.setMatrixAt(i, this._matrix);

          const base = i * 27;
          for (let k = 0; k < 27; k++) acc[k] = coeffs[base + k];
          if (bandCount < 9) {
            for (let b = bandCount; b < 9; b++) {
              acc[b * 3] = 0;
              acc[b * 3 + 1] = 0;
              acc[b * 3 + 2] = 0;
            }
          }

          const b = shBasis(dir[0], dir[1], dir[2], _basis);
          let r = 0;
          let g = 0;
          let bl = 0;
          for (let k = 0; k < 9; k++) {
            r += acc[k * 3] * b[k];
            g += acc[k * 3 + 1] * b[k];
            bl += acc[k * 3 + 2] * b[k];
          }

          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
          const grey = toneMap(lum, gain) * (1 - TINT);
          this.mesh.instanceColor.setXYZ(
            i,
            grey + toneMap(r, gain) * TINT,
            grey + toneMap(g, gain) * TINT,
            grey + toneMap(bl, gain) * TINT
          );

          visible++;
          sum += Math.max(lum, 0);
          if (lum > max) max = lum;
        }
      }
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;

    this.stats = { visible, buried, mean: visible ? sum / visible : 0, max };
  }

  setXray(on) {
    this.material.depthTest = !on;
    this.material.depthWrite = !on;
    this.mesh.renderOrder = on ? 999 : 0;
    this.material.needsUpdate = true;
  }

  dispose() {
    this.mesh.dispose();
    this.material.dispose();
  }
}

const _basis = new Float32Array(9);

/* ── 3: the atlas texture ─────────────────────────────────────── */

/**
 * Draws the real lightmap atlas Blender produced.
 *
 * This is the genuine article — the same PNG the GPU samples, drawn here from
 * the same bytes. Everything visible is a fact about the bake: dark regions are
 * islands no lamp reaches, and bright ones are surfaces close to a light.
 *
 * The image is shown the way an image viewer would show it, top row first, and
 * the UVs are mapped to match. That costs one `1 - v` here and buys the ability
 * to compare the panel against `public/lightmap.png` opened directly, which is
 * most of the value of having it in a standard format at all.
 */
class AtlasView {
  /**
   * @param {{meta: import('./lightmapfile.js').LightmapMeta,
   *          uv: Float32Array, texture: THREE.Texture}} baked
   */
  constructor(baked) {
    this.baked = baked;

    this.el = document.getElementById('atlasView');
    this.canvas = document.getElementById('atlasCanvas');
    this.meta = document.getElementById('atlasMeta');
    this.ctx = this.canvas.getContext('2d');

    // The panel `<details>` and this overlay are two views of one piece of
    // state, so they have to be kept in step. Closing here must collapse the
    // disclosure too, or the panel keeps reading "open" and the user has to
    // toggle it twice to get the atlas back.
    this.disclosure = document.getElementById('dbgAtlasBox');

    document.getElementById('atlasClose').addEventListener('click', () => this.hide());

    // Escape closes it, which is what a floating panel should do. Bound on the
    // window so it works without the overlay holding focus.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible) this.hide();
    });

    this.settings = {
      gain: 0.3,
      channel: 'rgb',
      charts: false,
      grid: true,
    };

    this._image = null;

    this._makeDraggable();
  }

  /* ── Dragging ─────────────────────────────────────────────── */

  /**
   * Let the overlay be dragged by its header.
   *
   * The element is anchored with `bottom`, which makes it awkward to move
   * directly — a drag would have to translate every pointer delta into an
   * inverted vertical offset, and the element's own height would shift the
   * result as it resized. So on the first drag the anchor is converted to
   * `top`/`left` from the measured rect, and movement becomes 1:1 from there.
   *
   * Pointer capture is what makes this robust: once the drag starts, every
   * move and up event retargets to the header even if the pointer leaves it,
   * so a fast drag across the canvas cannot strand the overlay mid-move.
   */
  _makeDraggable() {
    const handle = this.el.querySelector('header');
    if (!handle) return;

    /** Pointer offset from the element's top-left corner, or null when idle. */
    let grab = null;

    const EDGE = 8;

    const clampToViewport = () => {
      // Keep the whole panel on screen, but never inverted: if the viewport is
      // smaller than the panel, `max` would fall below `min` and clamp() would
      // return the wrong bound, so floor it.
      const w = this.el.offsetWidth;
      const h = this.el.offsetHeight;
      const maxX = Math.max(EDGE, window.innerWidth - w - EDGE);
      const maxY = Math.max(EDGE, window.innerHeight - h - EDGE);

      const x = clamp(parseFloat(this.el.style.left || EDGE), EDGE, maxX);
      const y = clamp(parseFloat(this.el.style.top || EDGE), EDGE, maxY);
      this.el.style.left = `${x}px`;
      this.el.style.top = `${y}px`;
    };

    handle.addEventListener('pointerdown', (e) => {
      // Don't hijack the close button, or any future control in the header.
      if (e.target.closest('button')) return;
      if (e.button !== 0) return;

      const rect = this.el.getBoundingClientRect();
      this.el.style.left = `${rect.left}px`;
      this.el.style.top = `${rect.top}px`;
      this.el.style.bottom = 'auto';

      grab = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };

      handle.setPointerCapture(e.pointerId);
      this.el.classList.add('dragging');
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!grab) return;

      const x = e.clientX - grab.dx;
      const y = e.clientY - grab.dy;

      this.el.style.left = `${x}px`;
      this.el.style.top = `${y}px`;
      clampToViewport();
    });

    const release = (e) => {
      if (!grab) return;
      grab = null;
      this.el.classList.remove('dragging');
      if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    };

    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);

    // Double-clicking the header restores the docked position. Without this a
    // panel dragged into a corner has no way back short of a reload.
    handle.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      this.el.style.left = '';
      this.el.style.top = '';
      this.el.style.bottom = '';
    });

    // A window resize can leave a dragged panel hanging off the edge.
    window.addEventListener('resize', () => {
      if (this.el.style.left) clampToViewport();
    });
  }

  get visible() {
    return !this.el.hidden;
  }

  show() {
    this.el.hidden = false;
    this.render();
  }

  hide() {
    this.el.hidden = true;
    // Collapsing the disclosure fires its `toggle` event, which calls back into
    // `hide()` through the UI handler. That is harmless — hide() is idempotent
    // and setting `open` to its existing value fires nothing.
    if (this.disclosure) this.disclosure.open = false;
  }

  set(patch) {
    Object.assign(this.settings, patch);
    if (this.visible) this.render();
  }

  /**
   * Pull the PNG's pixels back out.
   *
   * Deferred to the first open: the GPU already has the decoded image, but
   * reading it back needs a `<canvas>`, and there is no reason to run that on
   * the boot path for a panel most sessions never open.
   */
  _pixels() {
    return readPixels(this.baked.texture);
  }

  render() {
    const { atlasSize, peak, margin, texelsPerMetre, triangles } = this.baked.meta;
    const meshCount = this.baked.meta.meshes.length;

    // `charts` was referenced below without being destructured, which is a
    // ReferenceError in a module — so this view crashed on open rather than
    // merely drawing nothing.
    const { gain, channel, charts, grid } = this.settings;

    const src = this._pixels();

    this.canvas.width = atlasSize;
    this.canvas.height = atlasSize;

    if (!this._image) this._image = this.ctx.createImageData(atlasSize, atlasSize);
    const data = this._image.data;

    for (let i = 0; i < atlasSize * atlasSize; i++) {
      // The image holds 0..1 of the bake's own peak, so scaling by the peak
      // puts it back on the same footing the old float atlas was on — which is
      // what keeps the default gain below meaningful.
      const o = i * 4;
      const r = srgbToLinear(src[o]) * peak;
      const g = srgbToLinear(src[o + 1]) * peak;
      const b = srgbToLinear(src[o + 2]) * peak;

      let cr;
      let cg;
      let cb;
      if (channel === 'rgb') {
        cr = toneMap(r, gain);
        cg = toneMap(g, gain);
        cb = toneMap(b, gain);
      } else {
        // Isolate one channel as greyscale, to inspect colour balance — a lamp
        // that is too warm shows up as R far above B.
        const v = channel === 'r' ? r : channel === 'g' ? g : b;
        cr = cg = cb = toneMap(v, gain);
      }

      data[o] = cr * 255;
      data[o + 1] = cg * 255;
      data[o + 2] = cb * 255;
      data[o + 3] = 255;
    }

    this.ctx.putImageData(this._image, 0, 0);

    if (grid) {
      this.ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      for (let p = 0; p <= atlasSize; p += 128) {
        this.ctx.moveTo(p + 0.5, 0);
        this.ctx.lineTo(p + 0.5, atlasSize);
        this.ctx.moveTo(0, p + 0.5);
        this.ctx.lineTo(atlasSize, p + 0.5);
      }
      this.ctx.stroke();
    }

    if (charts) {
      // Draw the real island outlines.
      //
      // The runtime does not receive Blender's island list, but it does receive
      // the **UVs** — and since the packer maps each island to a disjoint
      // rectangle of the atlas, drawing every triangle's UV outline traces the
      // islands exactly. At 29k triangles this is dense but cheap, and it is
      // the same information the old chart list used to provide.
      const uv = this.baked.uv;

      this.ctx.strokeStyle = 'rgba(120,220,255,0.35)';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();

      for (let t = 0; t < triangles; t++) {
        const a = t * 6;
        // UV -> pixel. V counts up from the bottom of the image, the canvas
        // counts down from the top, hence the flip.
        const x0 = uv[a] * atlasSize;
        const y0 = (1 - uv[a + 1]) * atlasSize;
        const x1 = uv[a + 2] * atlasSize;
        const y1 = (1 - uv[a + 3]) * atlasSize;
        const x2 = uv[a + 4] * atlasSize;
        const y2 = (1 - uv[a + 5]) * atlasSize;

        this.ctx.moveTo(x0, y0);
        this.ctx.lineTo(x1, y1);
        this.ctx.lineTo(x2, y2);
        this.ctx.closePath();
      }

      this.ctx.stroke();
    }

    const bytes = atlasSize * atlasSize * 3;
    const kb = bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
    const marginNote = margin ? ` · ${margin}px margin` : '';
    this.meta.textContent =
      `${atlasSize}×${atlasSize} RGB8 sRGB · ${kb} · ` +
      `${meshCount} meshes · ${triangles} tris · ` +
      `${texelsPerMetre.toFixed(1)} texels/m${marginNote}`;
  }
}

/* ── 1: the lightmap on surfaces ──────────────────────────────── */

/**
 * Draws the atlas as it lands on the geometry — the same texture, through the
 * same `uv1` channel, sampled per texel by the GPU.
 *
 * This used to resample the atlas into a vertex-colour attribute, which made it
 * useless for its purpose in a way that was easy to miss. The geometry is
 * tessellated at ~0.45 m and the atlas carries ~3.8 cm per texel, so a
 * per-vertex read discarded a 12×12 block of texels at every vertex and
 * reproduced exactly the smooth, ambient-looking lighting this whole pipeline
 * was built to get rid of. It looked like probe lighting because in resolution
 * terms it *was* — both are ~0.5 m data presented as if it were surface detail.
 *
 * Binding the atlas as `map` hands the sampling to the hardware instead. The
 * texture's `channel` is 1, so three derives `MAP_UV = uv1` for this material
 * exactly as it does for the real `material.lightMap`, and both sample the same
 * coordinates. That is what makes this a view of the real thing rather than an
 * impression of it.
 */
class SurfaceView {
  /**
   * @param {{meta: import('./lightmapfile.js').LightmapMeta,
   *          texture: THREE.Texture}} baked
   */
  constructor(baked) {
    this.baked = baked;
    this.enabled = false;
    this.gain = 0.35;
    /** @type {Map<THREE.Mesh, THREE.Material|THREE.Material[]>} */
    this.original = new Map();
    /** @type {WeakMap<THREE.Material, THREE.MeshBasicMaterial>} */
    this.replacement = new WeakMap();
    /** Every stand-in built so far, so a gain change can reach them all. */
    this.standIns = new Set();
  }

  /**
   * The stand-in for one original material.
   *
   * Built per original rather than as a single shared instance, because the
   * cutaway works by assigning `clippingPlanes` to the wall materials. One
   * shared material would either ignore that and show every wall at once, or
   * clip everything — copying the planes keeps this view showing what is
   * actually on screen.
   *
   * @param {THREE.Material} source
   */
  _standIn(source) {
    let stand = this.replacement.get(source);
    if (stand) return stand;

    stand = new THREE.MeshBasicMaterial({
      map: this.baked.texture,
      toneMapped: false,
      side: source.side,
      name: `lightmapDebug:${source.name || source.type}`,
    });
    stand.clippingPlanes = source.clippingPlanes;
    stand.clipIntersection = source.clipIntersection;

    // `toneMapped` is off so the curve below is the only one applied; the
    // include is still present in the shader, so it can be swapped out.
    stand.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <tonemapping_fragment>',
        REINHARD
      );
    };

    this.replacement.set(source, stand);
    this.standIns.add(stand);
    return stand;
  }

  /**
   * Exposure, folded in where the peak lives.
   *
   * The atlas holds 0..1 of the bake's own peak, so `color` carries the peak
   * restore and the gain together: the map fragment multiplies the sampled
   * texel into `diffuseColor`, which starts out as `color`.
   */
  _applyGain() {
    const scale = this.baked.meta.peak * this.gain;
    for (const material of this.standIns) material.color.setScalar(scale);
  }

  setGain(gain) {
    this.gain = gain;
    this._applyGain();
  }

  toggle(root, on, gain) {
    if (gain !== undefined) this.gain = gain;

    if (on === this.enabled) {
      // Already in the requested state. Only the gain can have moved, and that
      // needs no re-traversal — it used to set a `gainDirty` flag that nothing
      // ever read, which is why the exposure slider did nothing once the view
      // was on.
      this._applyGain();
      return;
    }
    this.enabled = on;

    if (!on) {
      for (const [mesh, material] of this.original) mesh.material = material;
      this.original.clear();
      return;
    }

    this._applyGain();

    root.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      // Only standard materials ever receive the lightmap, so only those can
      // show it. Swapping anything else would invent light the real materials
      // do not have.
      const list = Array.isArray(obj.material) ? obj.material : [obj.material];
      if (!list.every((m) => m && m.isMeshStandardMaterial)) return;
      // Without `uv1` there is no coordinate to sample, and the shader would
      // read whatever the missing attribute defaults to.
      if (!obj.geometry.getAttribute('uv1')) return;

      this.original.set(obj, obj.material);
      obj.material = Array.isArray(obj.material)
        ? obj.material.map((m) => this._standIn(m))
        : this._standIn(obj.material);
    });
  }
}

/* ── Facade ───────────────────────────────────────────────────── */

export class LightmapDebug {
  /**
   * @param {import('./lightprobe.js').ProbeVolume} volume
   * @param {{meta: object, uv: Float32Array, texture: THREE.Texture}} baked
   *        result of `loadLightmap`
   * @param {THREE.Scene} scene
   */
  constructor(volume, baked, scene) {
    this.scene = scene;
    this.volume = volume;
    this.field = new ProbeField(volume);
    this.overlay = new SurfaceView(baked);
    this.atlas = new AtlasView(baked);
    this.group = new THREE.Group();
    this.group.name = 'lightmapDebug';
    this.group.add(this.field.mesh);
    this.group.visible = false;
    scene.add(this.group);

    this.field.settings.gain = 0.08;
    this.field.refresh();
    this.field.setXray(false);
  }

  get visible() {
    return this.group.visible;
  }

  setVisible(on) {
    this.group.visible = on;
    if (!on && this.overlay.enabled) this.overlay.toggle(this.scene, false);
  }

  /* ── Probe grid ───────────────────────────────────────────── */

  setXray(on) {
    this.field.setXray(on);
  }

  setSize(size) {
    this.field.settings.size = size;
    this.field.refresh();
  }

  setGain(gain) {
    this.field.settings.gain = gain;
    this.field.refresh();
  }

  setDirection(dir) {
    this.field.settings.direction = dir;
    this.field.refresh();
  }

  setBands(bands) {
    this.field.settings.bands = bands;
    this.field.refresh();
  }

  setSlice(index) {
    this.field.settings.slice = index;
    this.field.refresh();
  }

  setOnlyBuried(on) {
    this.field.settings.onlyBuried = on;
    this.field.refresh();
  }

  /* ── Surfaces ─────────────────────────────────────────────── */

  setOverlay(on, gain) {
    this.overlay.toggle(this.scene, on, gain);
  }

  /* ── Atlas ────────────────────────────────────────────────── */

  setAtlasVisible(on) {
    if (on) this.atlas.show();
    else this.atlas.hide();
  }

  setAtlas(patch) {
    this.atlas.set(patch);
  }

  get atlasVisible() {
    return this.atlas.visible;
  }

  /** A one-line summary for the panel. */
  report() {
    const { visible, buried, mean, max } = this.field.stats;
    const total = this.field.count;
    return {
      text: `${visible}/${total} probes · ${buried} repaired · mean ${mean.toFixed(2)} · max ${max.toFixed(1)}`,
      ...this.field.stats,
      total,
    };
  }

  /** Per-band energy, useful to sanity-check the SH projection. */
  bandSummary() {
    const c = this.volume.coeffs;
    const band = [0, 0, 0];
    for (let i = 0; i < this.field.count; i++) {
      const base = i * 27;
      band[0] += Math.abs(c[base]) + Math.abs(c[base + 1]) + Math.abs(c[base + 2]);
      for (let k = 1; k < 4; k++) {
        band[1] += Math.abs(c[base + k * 3]) + Math.abs(c[base + k * 3 + 1]) + Math.abs(c[base + k * 3 + 2]);
      }
      for (let k = 4; k < 9; k++) {
        band[2] += Math.abs(c[base + k * 3]) + Math.abs(c[base + k * 3 + 1]) + Math.abs(c[base + k * 3 + 2]);
      }
    }
    const total = band[0] + band[1] + band[2] || 1;
    return band.map((v) => +((v / total) * 100).toFixed(1));
  }
}
