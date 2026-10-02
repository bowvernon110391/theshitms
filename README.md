# Sims-Style House · Three.js

An interactive 3D house you can look inside, Sims-style. Walls drop away as you
orbit, the roof lifts off, and the whole scene runs through a full day/night
cycle with the interior lights coming on at dusk.

```bash
npm install
npm run bake     # offline light bake -> public/lightmap.png  (~9 min, once)
npm run dev      # http://localhost:5173
npm run build    # bakes, then bundles into dist/
```

`npm run bake` must be run once before `npm run dev`; `npm run build` does it
for you. The bake only needs re-running when you change lights, room layout or
wall geometry — moving the camera or the sun does not invalidate it.

`npm run build:fast` bundles without baking. It is fine for UI and shader work
but will happily ship a lightmap that no longer matches the geometry, which
shows up as lighting attached to the wrong surfaces rather than as an error.

## What's in it

**A seven-room house** — living room, dining room, kitchen, hallway, bedroom,
bathroom and study, laid out on a 12 × 10 m footprint with 2.7 m ceilings.

**A cast-iron day/night cycle.** Sky gradient, sun/moon position, fog, tone
mapping exposure, star field and interior lighting are all driven by a single
keyframe timeline (`src/environment.js`), so nothing drifts out of sync. Scrub
the slider, hit a preset, or let it run.

**Three view modes**

| Mode | What it does |
|---|---|
| Cutaway | Walls between the camera and the interior fade to a ghost, so you always see in |
| Walls Up | Everything solid, roof on — the house as a passer-by sees it |
| Floor Plan | Wall materials are clipped at 0.55 m and the camera goes top-down |

## Controls

| Input | Action |
|---|---|
| Left drag / Right drag / Wheel | Orbit / pan / zoom |
| `C` `P` | Cutaway · Floor plan |
| `R` `F` `H` | Roof · Furniture · hide panel |
| `O` `Space` | Auto orbit · auto time |
| `1` `2` `3` `4` | Dawn · Noon · Dusk · Night |

Clicking a room in the side panel flies the camera to it.

## How the interesting bits work

### The cutaway

Occlusion is decided per wall run, using the plainest test that works: a wall
fades when it sits on the camera's side of the point you're looking at, because
that is exactly the set of walls standing between the two.

```js
offset.copy(line.center).sub(focus);
line.state.target = offset.dot(cameraDir) > 0 ? 0.07 : 1;
```

Each wall run owns a **cloned material**, so runs fade independently without
touching each other. Hiding is instant and restoring eases back, which stops the
walls strobing while you spin the camera. Occluding walls fade to a faint ghost
rather than vanishing, so the floor plan stays readable.

Floor-plan mode doesn't hide walls — it slices them with a real clipping plane
(`renderer.localClippingEnabled`), which keeps the wall stubs and door reveals
visible from above.

### One light per room, not one per lamp

Each room contributes a single light at its centroid rather than one per
fixture: a light is an *area of influence*, and every extra one costs the bake
another set of shadow rays. The ceiling lamps are all real meshes sharing one
emissive material, so a single write lights the whole house at dusk.

### The lighting: two baked representations

The scene has **no real-time room lights at all**. Interior lamps are baked, and
the bake is stored twice, because static and moving surfaces need different
things:

| | Static geometry | Sims / dynamic objects |
|---|---|---|
| Storage | 2048² PNG atlas, 8-bit sRGB | SH L2 probe volume |
| Delivery | `uv1` + `material.lightMap` | per-frame uniform + shader patch |
| Resolution | **26.3 texels/m (~4 cm)** | 0.5 m probe grid |
| Why | Surfaces don't move, so a texture can carry per-texel detail | A texture is indexed by UVs, and a character's UVs travel with it — a probe grid is indexed by *world position*, which is the right question to ask about a body that moves |

Both feed the same term in three.js's pipeline, so they composite with the sun
under identical maths:

```glsl
irradiance += lightMapTexel.rgb * lightMapIntensity;   // atlas  (built in)
irradiance += vBakedLight * uBakedIntensity;           // probes (injected)
```

Sun, sky, fog and the outdoor lamp post stay **real-time**. That split is what
makes the whole thing affordable: because the bake only covers lamps that are
simply on or off, the sun can keep moving without ever invalidating it.

**This replaced vertex lighting, and that was the point.** The previous version
carried baked light on vertices, so it could only resolve at the geometry's own
tessellation (~0.45 m) — which is why the interior looked blobby. Per-texel
direct light fixed that.

### Why the interior light stays interior

The original build used seven real `THREE.PointLight`s, and they poured straight
through the walls: warm pools on the lawn, glowing exterior walls. Point lights
in three.js do not cast shadows unless you enable shadow maps, and one shadow map
per lamp was coarse and expensive.

Light is now **traced with real occlusion**, so a wall actually stops it. Three
specific problems had to be solved:

| Problem | Fix |
|---|---|
| A wall's inner and outer faces are 16 cm apart, so one probe serves both and lights the outside too | Sample at `position + normal * 0.12`, stepping off the surface into the side that face looks at. The whole probe volume also lies inside the building envelope, so no exterior probe exists to leak back in. |
| A uniform probe grid drops probes *inside* interior walls, where they read black and smear a dark band down both faces | Choose grid counts whose spacing steps over the wall bands by construction (`PROBE_COUNT`) |
| Probes inside worktops and wardrobes read black and darken everything near them | `fillBuriedProbes` finds probes boxed in on all six axes *and* receiving no light, then rebuilds them from open-air neighbours |

Measured on the exterior walls: **inward-facing vertices average 2.37
luminance, outward-facing vertices average exactly 0.**

### The unwrap and the bake are Blender's job now

The atlas is produced by **headless Blender**, in three stages that can each be
run separately:

```bash
npm run bake:export    # GLB + lamp specs, from the same builder the runtime uses
npm run bake:blender   # unwrap (smart project + uniform scale + pack), Cycles bake
npm run bake:import    # verify, denoise, encode -> public/lightmap.{png,json}
npm run bake           # all three, plus the probe volume for the sims
```

An earlier version did all of that by hand — a dominant-axis projection unwrapper
and a bespoke BVH ray tracer. That was the wrong call: Cycles gives real global
illumination, real soft shadows and a proper packer, and hand-rolling them meant
reimplementing, worse, three things that already exist.

**One object, one atlas.** UV coordinates live on a mesh and occupy that mesh's
own 0..1 square, so the export merges everything into a single object with
material slots. Three hundred separate objects would each be packed into their
own square and every one of them would overlap — which is exactly what the first
attempt did, producing a 31.6% fill of mutually-overlapping islands.

**Unwrap order matters.** Smart Project splits at 66° to get one island per box
face, then `average_islands_scale` normalises texel density across every island,
then `pack_islands` fits them. The middle step is the one that is easy to miss:
without it a wall and a picture frame get wildly different resolutions, and the
lighting looks inconsistent for reasons that are hard to see directly. Measured
spread after scaling: **1.00×**.

**Face order is the contract.** Blender hands back UVs indexed by face, and
`import-lightmap.mjs` routes them to the right runtime geometry by triangle
index. Two things follow: the export welds vertices *itself* rather than letting
Blender's `remove_doubles` do it (which also deletes faces that collapse — it
removed 22,002 of 51,196 here, destroying the ordering), and the runtime asserts
the face counts match before accepting a build.

**Lamp intensity is converted.** three.js irradiance is `intensity / d²` while an
isotropic Blender point light is `power / (4πd²)`, so `power = 4π · intensity`
makes them agree. Without that factor the sims — lit from the probe volume, using
three.js maths — come out ~12.6× brighter than the floor they stand on.

### Denoising, and why more of it is not the answer

Grain was visible on surfaces. Two explanations were plausible — Monte Carlo
noise, or a UV mapping bug — and they have completely different fixes, so
guessing would have wasted a long bake. A controlled A/B varying only the sample
count settled it:

| Samples | Atlas noise |
|---|---|
| 4 | 0.19300 |
| 64 | 0.08008 |

Noise falls cleanly with samples, so it is Cycles noise. But the obvious fix
turned out not to be available:

**Blender's denoiser does not apply to bakes.** `scene.render.bake` exposes no
denoising property — the bake log reports `bake=<unsupported>` and lists every
attribute it does have. Setting `scene.cycles.use_denoising` is silently ignored.
Three routes were checked before giving up on it:

| Route | Result |
|---|---|
| Bake-time denoise property | Does not exist on the bake operator |
| `bpy.ops.cycles.denoise_animation` | Needs render-layer denoising passes and motion vectors; rejects a standalone image |
| Compositor Denoise node | Exists (`CompositorNodeDenoise`), but the compositor API moved to `scene.compositing_node_group` in 5.x and would need a further bake cycle to evaluate |

So denoising happens in `import-lightmap.mjs`, on the float buffer, as a
**bilateral** filter — not a gaussian, because a plain blur softens contact
shadows and lamp falloff exactly as much as it softens grain, whereas a
bilateral filter weights neighbours by similarity as well as distance.

It is masked to the islands, derived by rasterising the UV triangles (the atlas
alone cannot distinguish an unlit texel from an empty one), using the same
normalised convolution the old charts-blur used, so nothing bleeds across a seam.

| Denoise | Noise before → after | Removed | Strong-edge detail kept |
|---|---|---|---|
| off | 0.09250 | — | 100% |
| **r=3** (default) | 0.09250 → **0.02053** | **77.8%** | 61.3% |
| r=6 | 0.09806 → 0.02501 | 74.5% | 65.6% |

**Samples and denoising are not interchangeable**, which is the useful
conclusion:

| Bake | Denoise | Final noise | Edge detail kept |
|---|---|---|---|
| 4 samples | r=3 | 0.17006 | 59.2% |
| 64 samples | r=3 | **0.02661** | **68.6%** |

64 samples is 6.4× cleaner *and* keeps more detail. The reason is mechanistic: a
noisy bake forces a wider range-sigma (0.559 versus 0.458), and a wider filter
crosses more genuine edges. A low-sample bake cannot be rescued by filtering
harder — it just gets blurrier.

`npm run bake` prints the noise before/after and edge retention on every run.

**On removing it entirely:** Monte Carlo converges as 1/√N, so some residual is
always present. What remains here is 0.0205 against a peak of ~22 — about 0.09%
of peak, or ~4% of a mid-tone — and the rendered frame measures ~0.15%
high-frequency energy. Halving it again would need 256 samples, roughly four
times the 9-minute bake.

### Mipmaps for a minified lightmap

At 26 texels/m the atlas is *minified* on screen — a 895px viewport across ~15 m
is ~60 px/m — and `LinearFilter` minification samples a single texel rather than
averaging, so residual bake noise aliases into shimmer.

Letting three.js generate mipmaps is not the answer: coarse levels average
across the bake margin and bleed one surface's light onto its neighbour. So the
chain is built by hand in `createAtlasTexture`, box-filtered, and **stopped at
the deepest level whose footprint still fits inside the margin** (level 4 for a
16px margin). Trilinear then blends between levels that are safe.

An attempt to measure the improvement by swapping `minFilter` at runtime gave an
identical result, which means the change did not re-upload — so that was not a
valid A/B, and the benefit here is reasoned rather than demonstrated.

### Three defects the measurements turned up

Chasing visible blockiness in the atlas surfaced three genuine bugs, each of
which had been quietly degrading the bake:

**Lamps were shadowing themselves.** A ceiling lamp's shade and bulb straddle
the point its light is defined at, so shadow rays converging on that point
passed *through the fixture* and reported themselves occluded. Every lamp was
painting dark bands onto the nearby walls and ceiling. Meshes under an emitter
are now flagged `markEmitter` and excluded from the bake BVH outright — they are
thin decorative shells, and the only objects that can enclose a light source.

**A chart overlapped the reserved black patch.** Charts began at `(2,2)` while
the patch occupied `(0,0)–(8,8)`, and the patch is zeroed *after* rasterising —
so that chart silently lost its corner and rendered with a hard dark notch. The
packer now reserves the patch by insetting its origin past it.

**The indirect pass missed some charts entirely.** It sampled a global lattice
at `x % stride, y % stride`, so a chart narrower than the stride could contain
no lattice point at all and receive *no* indirect light — a small face going
flat and dark while its neighbours glowed. Growing those sparse values across
the whole atlas also let one chart's light bleed into another's texels. Both are
fixed by sampling and inpainting **per chart**, anchored to its own origin, so
a chart is guaranteed a sample and cannot bleed outside its own mask.

That last change does cost bake time — the atlas pass went from ~45 s to ~155 s,
because many more samples are now taken. Lower `--gi-stride` to trade back.

### Draw-call merging

`mergeByMaterial()` flattens a subtree into one mesh per material, baking world
matrices into the geometry. Furniture and the yard go from several hundred meshes
to a few dozen.

It bails out if the subtree contains a light, label or points object, since
rebuilding from meshes alone would silently delete them — and a scene that
quietly loses its lights is far worse than one that renders slowly.

## Layout

```
src/
  main.js         bootstrap, camera moves, UI wiring, render loop
  world.js        headless-safe world builder, shared by the runtime and the bake
  config.js       the house data: rooms, wall runs, openings, lamp spots, tessellation
  house.js        walls with punched openings, doors, glazing, roof, floors
  furniture.js    ~30 furniture builders (sofa, bed, counters, bathtub…)
  furnish.js      hand-placed room layouts
  props.js        yard: fence, path, deck, pool, planting, car
  sims.js         two wanders-around characters with plumbobs
  lightmapfile.js atlas format, half-float, capped mip chain, material application
  lightprobe.js   SH L2 probe encoding, sampling and file format
  bakedlight.js   probe-volume lighting for dynamic objects only
  debug.js        the three debug views
  cutaway.js      the three view modes
  environment.js  day/night keyframes and real-time lighting
  sky.js          gradient sky dome + star field
  materials.js    the shared material palette
  ui.js           DOM bindings
  utils.js        math, mesh helpers, tessellation, geometry merging

tools/
  export-scene.mjs    stage 1: GLB + lamp specs + face-range manifest
  run-blender.mjs     locates Blender across platforms and runs stage 2
  blender-bake.py     stage 2: import, verify, unwrap, Cycles bake
  import-lightmap.mjs stage 3: verify, denoise, pack the runtime atlas
  denoise-atlas.mjs   coverage mask + island-masked bilateral filter
  bake-probes.mjs     the separate probe bake for dynamic objects
  bake-core.mjs       BVH tracer and shared lamp sampling
```

## Debugging the lightmap

The `Debug · Lightmap` panel has three views, answering three different
questions:

| | View | Answers |
|---|---|---|
| 1 | **On surfaces** | Does the lighting *look* right? Reads the atlas back through each mesh's `uv1` and shows it flat. |
| 2 | **Probe grid** | What is in the 3D volume that lights the sims? Spheres coloured by stored irradiance, optionally x-ray, sliced by Y, or filtered to only the repaired probes. |
| 3 | **Atlas texture** | Is the *packing* sane? The real atlas image with chart outlines drawn over it — wasted space, chart shapes, density variation. |

Press `D` to toggle view 1. The atlas window (view 3) floats over the scene:
**drag its header** to move it, **double-click the header** to re-dock it, and
**Esc** or the **×** to close it. Its exposure slider matters — the atlas spans
a wide dynamic range, so a mid-range gain makes the lit charts readable.


`window.house3d` exposes the scene, camera and systems in dev builds.
