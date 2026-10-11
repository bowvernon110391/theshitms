# Sims-Style House · Three.js

An interactive 3D house you can look inside, Sims-style. Walls drop away as you
orbit, the roof lifts off, and the whole scene runs through a full day/night
cycle with the interior lights coming on at dusk.

[![Cutaway view at noon — the walls between the camera and the rooms fade to a
ghost, so all seven rooms stay readable from one orbit position](screenshots/01-noon-cutaway.png)](screenshots/01-noon-cutaway.png)

*Cutaway view, noon. Each wall run decides for itself whether to ghost, based on
which side of the focus point it sits on — so the walls standing between you and
the room you're looking at drop out, and the ones behind it stay solid.*

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

**Walls Up, at dusk.** The same house as a passer-by sees it — roof on, nothing
ghosted, and the outdoor lamp post already lit. Sun, sky, fog and that lamp are
all real-time; only the interior lamps are baked, which is why the sun can keep
moving without invalidating the bake.

[![Walls-up exterior at dusk: solid walls and roof, warm sun low on the horizon,
the outdoor lamp post lit while the interior is still dark](screenshots/02-dusk-exterior.png)](screenshots/02-dusk-exterior.png)

**Floor Plan.** Not a hide-the-walls trick — the wall materials are sliced with a
real clipping plane at 0.55 m, so wall stubs and door reveals stay visible from
directly above.

[![Top-down floor plan: walls clipped at 0.55 m, showing the twelve-by-ten-metre
layout, furniture, room labels and the driveway and pool outside](screenshots/04-floor-plan.png)](screenshots/04-floor-plan.png)

**Night, cutaway, flown to the bedroom.** With the sun gone, everything you can
see is baked: the ceiling lamps and free-standing fixtures, resolved per-texel on
the floors and walls and per-vertex on the sims.

[![Night cutaway flown into the bedroom: warm pools from the ceiling lamps and a
beside lamp, cool moonlight through the window, a sim standing on the floor](screenshots/03-night-bedroom.png)](screenshots/03-night-bedroom.png)

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

### Sixteen lights, and where they came from

Interior lighting is **10 ceiling lamps plus 6 free-standing ones** — a pendant
over the dining table, a floor lamp each in the living room and study, two
bedside lamps, and a table lamp in the hallway. Baked, all of them.

Two things about how they are declared:

**One light per fixture, with the room's budget split between them.** An earlier
version gave each *room* a single light at the centroid, on the grounds that a
light is an *area of influence* and each extra one costs the bake another set of
shadow rays. That reasoning is sound but it was applied too bluntly: a centroid
light in a 12 m hallway only lights the middle of it. The hallway's three lamps
now each emit a third of what the one light did, so the room's total output is
unchanged while its falloff finally has a shape.

**The lamps are data, not placements.** Each free-standing lamp has to exist
twice — as a fixture you can see and as a light the bake can read — so they live
in an `ACCENT_LAMPS` table in `config.js` and both halves are derived from it.
The fixture records where its own emitter sits (`userData.lightOffsetY`, set by
the same function that draws the bulb) and the light spec is read back from
that. Two hand-maintained copies of one coordinate would eventually disagree,
and the symptom — a light twenty centimetres left of the lamp it belongs to — is
tedious to trace.

### Light colours are randomly generated, on purpose

Ceiling lights are drawn from a warm band (hue 34–56°, low saturation): amber
through to near-white, never blue. The free-standing lamps get the whole wheel at
high saturation. The ranges live in `LIGHT_PALETTE`; `LIGHT_SEED` in `config.js`
re-rolls the entire house.

That they are **seeded** rather than `Math.random()` matters more than it looks.
Light colours are inputs to a bake, and a bake is expensive and meant to be
comparable — with real randomness, every re-bake would differ for no visible
reason and you could never tell a colour change from a sampling change. The
colours look arbitrary and reproduce exactly. Change `LIGHT_SEED` to get a
different house.

Each lamp's shade material is tinted to match its light (`makeLampMaterial`),
because a lamp casting green while its own shade glows orange reads as two
unrelated objects. Cloning a material is how that is done, and a clone of a
tracked material is **not itself tracked** — so the clones register themselves
in `EMISSIVE_TARGETS`. Forgetting that produces exactly one lamp that never
comes on at dusk, which is a slow thing to notice.

### The lighting: two baked representations

The scene has **no real-time room lights at all**. Interior lamps are baked, and
the bake is stored twice, because static and moving surfaces need different
things:

| | Static geometry | Sims / dynamic objects |
|---|---|---|
| Storage | 2048² PNG atlas, 8-bit sRGB | SH L2 probe volume |
| Delivery | per-texel, via `uv1` + `material.lightMap` | per-vertex, via injected SH evaluation |
| Resolution | **17.6 texels/m (~6 cm)** at `--atlas=1024` | 1.16 × 1.20 m grid, 3 layers, resolved per vertex || Why | Surfaces don't move, so a texture can carry per-texel detail | A texture is indexed by UVs, and a character's UVs travel with it — a probe grid is indexed by *world position*, which is the right question to ask about a body that moves |

Both feed the same term in three.js's pipeline, so they composite with the sun
under identical maths:

```glsl
irradiance += lightMapTexel.rgb * lightMapIntensity;   // atlas  (built in)
irradiance += vBakedLight * uBakedIntensity;           // probes (injected)
```

### The probe light is evaluated per vertex, not per object

`vBakedLight` looks like a plain interpolated varying in that snippet, and for a
long time it was nothing of the sort: the CPU sampled the volume **once** at
chest height and wrote the result into a uniform, so every vertex of a sim got
the same value and the varying had nothing to interpolate. Combined with a
normal hardcoded to `+Y`, that made the sims read as flat cut-outs — they were
effectively lit by one light, from one direction, uniformly.

The measured cost of the hardcoded normal is the interesting part. Evaluating an
L2 basis at `+Y` zeroes $b_2, b_3, b_4, b_5, b_7$ — five of the nine basis
functions, 15 of the 27 floats stored per probe. Worse, `+Y` is often the *dim*
direction: sampled across the house it is between 1× and **26×** darker than the
brightest axis at the same point, so in the worst spots the sims were receiving
about 4% of the light already sitting in the buffer.

So the interpolation stayed on the CPU — it is 8 probes × 27 floats, once per
object per frame — but the evaluation moved into the vertex shader, where the
real normal is free. Two coefficient sets are sampled, at the object's base and
above its head, and mixed by each vertex's world height. That is what gives a
body a vertical gradient as well as directional shading.

One caveat worth knowing: the shader reconstructs a world normal as
`mat3( modelMatrix ) * objectNormal`, which is only valid while the model matrix
carries no non-uniform scale. Every sim part bakes its scaling into the geometry
(`ellipsoid` in `sims.js`) specifically to keep that true.

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

### The probe volume is 297 probes, in 3 layers

Two deliberate reductions from the 3360 the pipeline started with:

**Vertical: 5 layers → 3.** The volume's only vertical job is to interpolate
between the two heights a sim is sampled at (`DYNAMIC_SAMPLE`), and the top
layer now lands exactly on `.head`. Three is the fewest that still gives a
gradient at all — with two, the feet and head samples *would be* the only two
rows and the shader's height blend would have nothing to interpolate between.
The old extent ran to y = 2.84 to cover the wall tops, a leftover from when the
probes lit static geometry; that is the atlas's job now.

**Horizontal: deliberately below what the field wants**, for a cheaper bake and a
31 KB file. This is the part with a visible cost: pooled light under a lamp is
smeared across its neighbours, so a sim walking past one brightens gradually and
globally rather than in a distinct pool.

The two reductions are not equivalent, and the numbers say which is which:

| Probes | Layers | X/Z spacing | Correlation | Samples lit in truth, dark in render |
|---|---|---|---|---|
| 2400 | 5 | 0.50 m | ~1.000 | 0 |
| 297 | 3 | 1.16 m | ~0.55 (est.) | — |
| 210 | 7 | 2.32 m | 0.391 | 873 |

The reason horizontal density matters so much is the field itself: its structure
function — mean |L(p) − L(p+d)| as a fraction of mean luminance — runs **35% at
0.25 m, 75% at 0.5 m, 119% at 1 m**. With 16 lamps in a 12 × 10 m house, light
genuinely varies at the ~1 m scale. Vertical variation has no equivalent
argument, because nothing samples below the feet or above the head.

Worth noting how the budget was spent. Dropping two layers frees about 40% of
the probes, and that went back into X/Z rather than being banked: spacing
improved from 1.45 × 1.60 m to 1.16 × 1.20 m at the *same* probe count. Vertical
resolution was never the limiting factor, so that was where the free win was.

**2400 is what a faithful volume costs.** That is what to return to if the sims'
lighting matters more than the bake time — change `PROBE_LAYERS_Y` back to 5 and
`PROBE_COUNT` to `[24, 5, 20]`. One knock-on: with the top layer at `head`
rather than above it, the sims come out slightly dimmer overall, because the old
blend included a layer at 1.94 m that sits closer to the 2.2 m ceiling lamps
than any part of a 1.7 m body actually is.

The X and Z counts are chosen so the spacing steps over the interior wall bands
(3.92–4.08 and 7.92–8.08 in X; 3.92–4.08 and 5.92–6.08 in Z). That constraint is
free to satisfy at any density, and worth keeping: a probe inside a wall reads
black and smears a dark band down both of its faces.

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
times the bake.

The noise figures above were measured on a 7-light bake. More lights means more
shadow rays per sample, so the absolute numbers move with the lighting rig — the
*relationship* is the part that generalises: samples buy cleanliness and detail
together, and denoising buys neither.

### Mipmaps for a minified lightmap — **currently regressed**

At 17.6 texels/m the atlas is *minified* on screen — a 895px viewport across
~15 m is ~60 px/m — so minification samples several texels per pixel and residual
bake noise aliases into shimmer.

The old build handled this with a hand-built, box-filtered mip chain that
**stopped at the deepest level whose footprint still fits inside the margin**
(level 4 for a 16px margin), because three's automatic chain averages across the
margin and bleeds one island's light onto its neighbour. That code lived in
`createAtlasTexture`, which the move to a plain PNG deleted — `loadTexture` sets
`LinearMipmapLinearFilter` and lets three generate the chain.

So the margin-bleed problem is currently **back**, and it is worse at margin 4
than it was at 16: the safe depth is now `log2(margin)`, i.e. 2 levels. Worth
fixing by capping `texture.mipmaps` / limiting `minFilter`, but it is not fixed
yet and the section above should not be read as if it were.

The earlier attempt to measure this by swapping `minFilter` at runtime gave an
identical result, which means the change did not re-upload — so that was not a
valid A/B, and even the original benefit was reasoned rather than demonstrated.

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
  sims.js         two low-poly characters (ellipsoids + capsules) with plumbobs
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

Views 1 and 2 together, with both enabled. The house is showing the atlas
directly through `uv1` rather than the real materials, so the albedo is gone and
anything the bake left unlit goes black — the magenta dining room is one lamp's
own colour, not a decoration. The scattered dots are the 297 SH probes of view 2,
drawn in place; the dark ones are probes that receive no light at all.

[![Debug views: the lightmap shown raw on the surfaces through uv1, with the 297
SH probes drawn over the house as coloured spheres](screenshots/05-debug-surfaces.png)](screenshots/05-debug-surfaces.png)

Press `D` to toggle view 1. The atlas window (view 3) floats over the scene:
**drag its header** to move it, **double-click the header** to re-dock it, and
**Esc** or the **×** to close it. Its exposure slider matters — the atlas spans
a wide dynamic range, so a mid-range gain makes the lit charts readable.


`window.house3d` exposes the scene, camera and systems in dev builds.
