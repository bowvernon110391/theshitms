"""
Stage 2 of the Blender bake.

    blender --background --python tools/blender-bake.py -- [options]

Imports `bake/scene.glb`, unwraps it, bakes the artificial lights with Cycles,
and writes the results for `tools/import-lightmap.mjs` to pick up.

Options (after the `--` separator, which Blender requires):
    --samples=N      Cycles samples (default 64)
    --atlas=N        atlas edge in texels (default 2048)
    --margin=N       bake margin in pixels (default 16)
    --denoise=0|1    request Cycles denoising (see note below)
    --device=CPU|GPU compute device (default CPU)
    --glb=PATH       input GLB   (default bake/scene.glb)
    --lights=PATH    light specs (default bake/lights.json)
    --manifest=PATH  per-mesh manifest (default bake/manifest.json)
    --out-dir=PATH   output directory (default bake)

On sample count: 64 is the default because it was measured. Noise falls from
0.193 at 4 samples to 0.080 at 64, and the post-process denoiser in
`import-lightmap.mjs` then takes 64-sample output to 0.027 while keeping ~69% of
strong-edge gradient. Going to 4 samples and leaning on denoising instead gives
0.170 — a low-sample bake cannot be rescued by filtering, and the wider range
sigma it forces damages real detail (59% edge retention).

On `--denoise`: **it has no effect on a bake.** Blender's bake operator exposes
no denoising property, so `scene.cycles.use_denoising` is ignored here. The flag
and its reporting are kept so that fact stays visible rather than being
rediscovered, and because a future Blender may support it.

Two things about this script are worth stating up front, because everything else
follows from them:

**Only the lamps are baked.** The sun, sky and fog stay real-time in the web
app, so the world background is forced to black. If it were left as the default
grey, environment light would be baked in as well and the interior would glow at
midnight.

**Nothing is baked that the runtime does not use.** Diffuse baking with DIRECT
and INDIRECT but *without* COLOR gives irradiance with the albedo divided out —
which is exactly what three.js's `lightMap` expects, since it multiplies by
`BRDF_Lambert( diffuseColor )` at shade time. Including COLOR would apply the
albedo twice.
"""

import json
import math
import os
import sys
import time
import warnings

import bpy
import mathutils
import numpy as np

# Blender 5.2 deprecates the `use_nodes` pattern in favour of an always-on node
# tree. It still works, and using it keeps this script compatible with older
# releases, so the warnings are suppressed rather than worked around.
warnings.filterwarnings("ignore", category=DeprecationWarning)

# ── Argument parsing ──────────────────────────────────────────────

argv = sys.argv
args = {}
if "--" in argv:
    for raw in argv[argv.index("--") + 1 :]:
        if raw.startswith("--"):
            key, _, value = raw[2:].partition("=")
            args[key] = value if value else True


def arg(name, default):
    return args.get(name, default)


SAMPLES = int(arg("samples", 64))
ATLAS = int(arg("atlas", 2048))
MARGIN = int(arg("margin", 16))
DEVICE = str(arg("device", "CPU")).upper()
GLB = str(arg("glb", "bake/scene.glb"))
LIGHTS = str(arg("lights", "bake/lights.json"))
MANIFEST = str(arg("manifest", "bake/manifest.json"))
OUT_DIR = str(arg("out-dir", "bake"))

for path in (GLB, LIGHTS, MANIFEST):
    if not os.path.exists(path):
        sys.exit(f"blender-bake: missing input {path} — run `npm run bake:export` first")

os.makedirs(OUT_DIR, exist_ok=True)


def log(message):
    # Flush per line so the Node orchestrator can stream progress.
    print(message, flush=True)


started = time.time()
log("▲ blender bake")
log(f"  blender     {bpy.app.version_string}")


# ── Reset to an empty scene ───────────────────────────────────────

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# The web app renders its own sky, so the bake must not contain any. A black
# world means indirect light comes only from the lamps, which is what the
# lightmap is supposed to represent.
world = bpy.data.worlds.new("bakeWorld")
scene.world = world
world.use_nodes = True
background = world.node_tree.nodes.get("Background")
if background:
    background.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    background.inputs["Strength"].default_value = 0.0


# ── Import ────────────────────────────────────────────────────────

bpy.ops.import_scene.gltf(filepath=GLB)
scene = bpy.context.scene

imported = [o for o in scene.objects if o.type == "MESH"]
log(f"  imported    {len(imported)} mesh object(s)")

if not imported:
    sys.exit("blender-bake: the GLB contained no meshes")


# ── Verify the round-trip, then restore connectivity ──────────────

with open(MANIFEST) as handle:
    manifest = json.load(handle)

if manifest.get("format") != "jjjs-manifest":
    sys.exit(f"blender-bake: unexpected manifest format {manifest.get('format')!r}")

expected_triangles = manifest["totalTriangles"]
ranges = manifest["ranges"]

# The export deliberately produces ONE object. UV coordinates live on a mesh and
# occupy that mesh's own 0..1 square, so separate objects would each be packed
# into their own overlapping square instead of sharing one atlas.
if len(imported) != 1:
    sys.exit(
        f"blender-bake: expected exactly 1 mesh object, got {len(imported)}. "
        "Multiple objects cannot share a UV atlas — each would be packed into "
        "its own 0..1 square and they would all overlap."
    )

house = imported[0]
mesh = house.data

if len(mesh.polygons) != expected_triangles:
    sys.exit(
        f"blender-bake: {len(mesh.polygons)} faces after import, "
        f"expected {expected_triangles}"
    )
if len(mesh.loops) != expected_triangles * 3:
    sys.exit(
        f"blender-bake: {len(mesh.loops)} loops, expected {expected_triangles * 3}"
    )
if any(len(p.vertices) != 3 for p in mesh.polygons):
    sys.exit("blender-bake: not every face is a triangle")

log(f"  verified    {expected_triangles} triangles, {len(ranges)} source meshes, face order intact")

material_slots = len(mesh.materials)
if material_slots != manifest["totalMaterials"]:
    log(
        f"    note: {material_slots} material slots, manifest expected "
        f"{manifest['totalMaterials']} — proceeding, but albedo may be off"
    )


# Note: no vertex welding here.
#
# The export arrives already welded, as an indexed mesh, precisely because
# Blender's `remove_doubles` also deletes faces that collapse when their
# vertices merge — and a missing face silently shifts every subsequent face in
# the list, which is exactly the mapping the UV read-back depends on.

# Flat shading. The exported normals are per-face already, but stating it
# explicitly means the bake uses geometric face normals regardless of how the
# importer resolved the custom normals — which is what three.js renders.
bpy.ops.object.select_all(action="DESELECT")
house.select_set(True)
bpy.context.view_layer.objects.active = house
bpy.ops.object.shade_flat()

log(f"  shading     flat, using geometric face normals")


# ── Lights ────────────────────────────────────────────────────────

with open(LIGHTS) as handle:
    light_data = json.load(handle)

if light_data.get("format") != "jjjs-lights":
    sys.exit(f"blender-bake: unexpected lights format {light_data.get('format')!r}")

bounds = light_data["bounds"]


def yup_to_blender(p):
    """glTF Y-up → Blender Z-up, matching what the glTF importer does."""
    return mathutils.Vector((p[0], -p[2], p[1]))


# Confirm the mapping before trusting it, by checking that the imported geometry
# occupies the space we expect. If this fails the lights would be placed in the
# wrong plane and the whole bake would be quietly wrong.
world_min = mathutils.Vector((1e9, 1e9, 1e9))
world_max = mathutils.Vector((-1e9, -1e9, -1e9))
for obj in imported:
    for corner in obj.bound_box:
        point = obj.matrix_world @ mathutils.Vector(corner)
        world_min = mathutils.Vector(
            (min(world_min[0], point[0]), min(world_min[1], point[1]), min(world_min[2], point[2]))
        )
        world_max = mathutils.Vector(
            (max(world_max[0], point[0]), max(world_max[1], point[1]), max(world_max[2], point[2]))
        )

expected_min = yup_to_blender(bounds["min"])
expected_max = yup_to_blender(bounds["max"])
expected_lo = mathutils.Vector(
    (min(expected_min[0], expected_max[0]), min(expected_min[1], expected_max[1]), min(expected_min[2], expected_max[2]))
)
expected_hi = mathutils.Vector(
    (max(expected_min[0], expected_max[0]), max(expected_min[1], expected_max[1]), max(expected_min[2], expected_max[2]))
)

# A loose tolerance: Blender's bounds are per-object boxes, which are slightly
# larger than the exact vertex extents.
tolerance = 0.5
if any(abs(world_min[i] - expected_lo[i]) > tolerance for i in range(3)):
    log(f"    imported bounds {tuple(round(v, 2) for v in world_min)} .. {tuple(round(v, 2) for v in world_max)}")
    log(f"    expected bounds {tuple(round(v, 2) for v in expected_lo)} .. {tuple(round(v, 2) for v in expected_hi)}")
    sys.exit("blender-bake: imported geometry does not sit where the axis mapping predicts")

log(
    f"  bounds      {tuple(round(v, 2) for v in world_min)} .. "
    f"{tuple(round(v, 2) for v in world_max)} (Z-up)"
)

for spec in light_data["lights"]:
    light = bpy.data.lights.new(spec["name"], type="POINT")
    light.color = tuple(spec["color"])

    # Convert three.js intensity into Blender radiant power.
    #
    # The two disagree by a factor of 4*pi, and getting this wrong is not a
    # cosmetic brightness issue — it makes the two halves of the lighting system
    # contradict each other:
    #
    #   three.js   irradiance = intensity / d^2
    #   Blender    irradiance = power / (4 * pi * d^2)      (isotropic point)
    #
    # so `power = 4 * pi * intensity` makes them agree exactly.
    #
    # That matters because the sims are lit from the probe volume, which uses
    # three.js's maths, while the room around them is lit from this atlas. Leave
    # the factor out and characters come out ~12.6x brighter than the floor they
    # are standing on.
    light.energy = spec["intensity"] * 4.0 * math.pi

    # Blender's own falloff is inverse-square with no cutoff. three.js's
    # `distance` is a smooth window that reaches zero at the cutoff; there is no
    # direct equivalent, and omitting it only extends the light's reach slightly
    # (the room's walls block it anyway). The value is recorded so it is not
    # silently lost.
    light.shadow_soft_size = 0.08

    obj = bpy.data.objects.new(spec["name"], light)
    obj.location = yup_to_blender(spec["position"])
    scene.collection.objects.link(obj)

log(f"  lights      {len(light_data['lights'])} placed (intensity x 4pi for Blender units)")


# ── Bake image and materials ──────────────────────────────────────

image = bpy.data.images.new("lightmap", width=ATLAS, height=ATLAS, alpha=False, float_buffer=True)
# Linear data, not colour. Marking it sRGB would make every value get an sRGB
# encode applied on save and read back wrong.
image.colorspace_settings.name = "Non-Color"
image.generated_color = (0.0, 0.0, 0.0, 1.0)

# Every material needs an Image Texture node pointing at the bake target, and
# that node must be the *active and selected* one — Blender bakes into whichever
# node holds both flags, and silently refuses the material otherwise.
#
# Order matters here. `nodes.active` must be assigned after the node is
# selected, and every other node must be deselected first; assigning active
# first leaves the flags inconsistent and produces "No active and selected image
# texture node found" for every material.
targets = 0
for material in bpy.data.materials:
    if not material.use_nodes:
        material.use_nodes = True
    tree = material.node_tree

    node = tree.nodes.new("ShaderNodeTexImage")
    node.image = image
    node.label = "bake-target"
    node.location = (-600, 400)

    for other in tree.nodes:
        other.select = False
    node.select = True
    tree.nodes.active = node
    targets += 1

# Sanity-check the flags before spending minutes on a bake that would produce a
# mostly-empty texture.
missing = [
    m.name
    for m in bpy.data.materials
    if not m.use_nodes
    or m.node_tree.nodes.active is None
    or not m.node_tree.nodes.active.select
    or not isinstance(m.node_tree.nodes.active, bpy.types.ShaderNodeTexImage)
]
if missing:
    log(f"    ! {len(missing)} materials have no active image node: {missing[:5]}")
    sys.exit("blender-bake: bake targets not set up correctly; refusing to bake")

log(f"  materials   {targets} given an active bake target")


# ── Unwrap ────────────────────────────────────────────────────────
#
# Three separate concerns, handled in this order because each depends on the
# previous one:
#
#   1. ISLANDS      — group faces into charts that can share texture space.
#   2. TEXEL SCALE  — make every island the same real-world resolution.
#   3. PACKING      — fit them into the atlas without overlap or bleed.
#
# Getting (2) wrong is the subtle one. If islands are scaled so each fills
# whatever space it is given, a large wall and a small picture frame end up at
# wildly different resolutions: the wall is starved of texels and the frame is
# lavished with them, and the lighting looks inconsistent for reasons that are
# hard to see directly. `average_islands_scale` is the operator that normalises
# UV-area-per-surface-area across all islands, and it must run *before* packing,
# because packing is free to scale everything uniformly afterwards without
# disturbing the ratios.

uv_margin = MARGIN / float(ATLAS)

bpy.ops.object.select_all(action="DESELECT")
for obj in imported:
    obj.select_set(True)
bpy.context.view_layer.objects.active = imported[0]

bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")

# 1. Islands, split at 66 degrees. A box face is planar, so this yields one
#    island per face and keeps each island a clean rectangle — the best case for
#    packing. `island_margin=0` because spacing is applied at the packing step
#    instead; adding it here would inflate every island before we even know how
#    much room there is.
try:
    bpy.ops.uv.smart_project(
        angle_limit=math.radians(66.0),
        island_margin=0.0,
        correct_aspect=True,
        scale_to_bounds=False,
    )
except TypeError:
    bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.0)

bpy.ops.uv.select_all(action="SELECT")

# 2. Uniform texel density. This is the step that makes lighting resolution
#    consistent across the whole house.
bpy.ops.uv.average_islands_scale()

# 3. Pack. `rotate` lets islands turn to fit; combined with the alignment step
#    below it is what gets the fill ratio up.
try:
    bpy.ops.uv.pack_islands(
        rotate=True,
        margin_method="ADD",
        margin=uv_margin,
        shape_method="CONCAVE",
    )
except TypeError:
    try:
        bpy.ops.uv.pack_islands(rotate=True, margin=uv_margin)
    except TypeError:
        bpy.ops.uv.pack_islands(margin=uv_margin)

bpy.ops.object.mode_set(mode="OBJECT")


# ── Measure the packing ───────────────────────────────────────────

def norm_uv(uv):
    """Wrap into 0..1. Smart Project can place islands outside the unit square."""
    return max(0.0, min(1.0, uv))


def measure_packing():
    """
    Report texel density per mesh and overall atlas coverage.

    Density is UV area divided by surface area, so a uniform value means every
    surface receives the same number of texels per square metre. The spread
    between the lowest and highest mesh is the number to watch: if it is much
    above one, `average_islands_scale` did not take effect.
    """
    densities = []
    total_uv = 0.0
    total_area = 0.0

    for obj in imported:
        mesh = obj.data
        layer = mesh.uv_layers.active
        if layer is None:
            continue

        area_3d = 0.0
        area_uv = 0.0
        for poly in mesh.polygons:
            area_3d += poly.area
            corners = [layer.data[li].uv for li in poly.loop_indices]
            # Shoelace formula for the polygon's UV area.
            twice = 0.0
            for i in range(len(corners)):
                x1, y1 = norm_uv(corners[i][0]), norm_uv(corners[i][1])
                x2, y2 = norm_uv(corners[(i + 1) % len(corners)][0]), norm_uv(
                    corners[(i + 1) % len(corners)][1]
                )
                twice += x1 * y2 - x2 * y1
            area_uv += abs(twice) * 0.5

        total_uv += area_uv
        total_area += area_3d
        if area_3d > 1e-6:
            densities.append(area_uv / area_3d)

    densities.sort()
    if not densities:
        return None

    lo = densities[0]
    hi = densities[-1]
    mean = sum(densities) / len(densities)

    # texels per metre = atlas_size * sqrt( uv_area / surface_area )
    as_texels = lambda d: ATLAS * math.sqrt(max(d, 0.0))
    spread = hi / lo if lo > 1e-12 else float("inf")

    return {
        "fill": total_uv,
        "area": total_area,
        "texels_min": as_texels(lo),
        "texels_mean": as_texels(mean),
        "texels_max": as_texels(hi),
        "spread": spread,
    }


packing = measure_packing()
if packing is None:
    sys.exit("blender-bake: no UV data after unwrapping")

log(
    f"  unwrapped   {ATLAS}px atlas, margin {MARGIN}px ({uv_margin:.5f} uv), "
    f"fill {packing['fill'] * 100:.1f}%"
)
log(
    f"  density     {packing['texels_mean']:.1f} texels/m mean "
    f"({packing['texels_min']:.1f}..{packing['texels_max']:.1f}, "
    f"spread {packing['spread']:.2f}x)"
)

# Density spread above this means the islands were scaled inconsistently and
# lighting resolution varies noticeably around the house.
if packing["spread"] > 2.0:
    log(
        "    ! texel density varies by more than 2x between meshes — "
        "average_islands_scale may not have applied to every object"
    )


# ── Bake settings ─────────────────────────────────────────────────

scene.render.engine = "CYCLES"
scene.cycles.device = DEVICE
scene.cycles.samples = SAMPLES

# Denoising is the main reason for using Blender at all: a path-traced interior
# bake at a workable sample count is noisy, and denoising removes that far more
# effectively than any amount of blurring afterwards.
#
# Status is reported rather than assumed. These settings are set behind
# try/except because names move between versions, and a silently failed
# assignment would leave the bake un-denoised with nothing to indicate it — the
# kind of thing that is then misdiagnosed as a UV bug.
DENOISE = str(arg("denoise", "1")) not in ("0", "false", "False", "off")

if DENOISE:
    try:
        scene.cycles.use_denoising = True
        scene.cycles.denoiser = "OPENIMAGEDENOISE"
    except Exception as exc:  # noqa: BLE001
        log(f"    ! could not set the Cycles denoiser: {exc}")
else:
    scene.cycles.use_denoising = False

bake = scene.render.bake
bake.use_pass_direct = True
bake.use_pass_indirect = True
# COLOR off is what keeps the albedo out of the result.
bake.use_pass_color = False
bake.margin = MARGIN
bake.use_clear = True

# Expose the margin as an extension of the island edges. This replaces the
# manual dilation the old baker needed, and does it properly.
try:
    bake.margin_type = "EXTEND"
except Exception:  # noqa: BLE001
    pass

# Bake-time denoising is a separate switch from the render one on some builds,
# and a few builds have no such property at all.
bake_denoise_supported = hasattr(bake, "use_denoising")
if bake_denoise_supported:
    try:
        bake.use_denoising = DENOISE
    except Exception:  # noqa: BLE001
        bake_denoise_supported = False

# Report what is actually in effect, so the log is the source of truth.
resolve = lambda obj, name: getattr(obj, name, "<absent>")
log(
    f"  denoise     cycles={resolve(scene.cycles, 'use_denoising')} "
    f"denoiser={resolve(scene.cycles, 'denoiser')} "
    f"bake={resolve(bake, 'use_denoising') if bake_denoise_supported else '<unsupported>'} "
    f"requested={DENOISE}"
)


# ── Bake ──────────────────────────────────────────────────────────

log(f"  baking      {SAMPLES} samples on {DEVICE}, {ATLAS}x{ATLAS}")

bake_started = time.time()
bpy.ops.object.select_all(action="DESELECT")
for obj in imported:
    obj.select_set(True)
bpy.context.view_layer.objects.active = imported[0]

bpy.ops.object.bake(
    type="DIFFUSE",
    pass_filter={"DIRECT", "INDIRECT"},
    margin=MARGIN,
    use_clear=True,
)

log(f"  baked       in {time.time() - bake_started:.1f} s")


# ── Write outputs ─────────────────────────────────────────────────

# A PNG purely so the result can be looked at; the authoritative data is the
# raw float dump below, which avoids any question of sRGB encoding or bit depth.
preview_path = os.path.join(OUT_DIR, "bake-preview.png")
image.filepath_raw = os.path.abspath(preview_path)
image.file_format = "PNG"
image.save()
log(f"  wrote       {preview_path}")

# numpy rather than `list( image.pixels )`: at 2048x2048x4 that is 16.7 million
# floats, and materialising them as a Python list takes minutes and gigabytes.
pixels = np.empty(ATLAS * ATLAS * 4, dtype=np.float32)
image.pixels.foreach_get(pixels)

pixels_path = os.path.join(OUT_DIR, "bake-pixels.f32")
pixels.tofile(pixels_path)
log(f"  wrote       {pixels_path} ({pixels.nbytes // 1024} KB)")

# ── UV read-back ──────────────────────────────────────────────────
#
# One object means one flat array, indexed by face corner. `import-lightmap.mjs`
# splits it up using the face ranges in the manifest.
#
# Reading per LOOP rather than per vertex is essential. `layer.data` holds one
# entry per face corner, not per vertex; for the de-indexed soup we exported
# those coincide, but after welding they do not — and indexing by vertex would
# hand each vertex an unrelated face's coordinate, scrambling the lightmap
# silently. Walking polygons in order reproduces exactly the vertex order the
# runtime holds: triangle t, corner k, is vertex t*3 + k.

layer = mesh.uv_layers.active
if layer is None:
    sys.exit("blender-bake: no UV layer after unwrapping")

uv_flat = np.empty(len(mesh.loops) * 2, dtype=np.float32)
layer.data.foreach_get("uv", uv_flat)

if len(uv_flat) != expected_triangles * 6:
    sys.exit(
        f"blender-bake: read {len(uv_flat)} uv floats, "
        f"expected {expected_triangles * 6}"
    )

uv_path = os.path.join(OUT_DIR, "uv.f32")
uv_flat.tofile(uv_path)

with open(os.path.join(OUT_DIR, "uv-index.json"), "w") as handle:
    json.dump(
        {
            "format": "jjjs-uv",
            "version": 1,
            "atlasSize": ATLAS,
            "margin": MARGIN,
            "triangles": expected_triangles,
            "packing": packing,
            "bounds": {
                "min": list(world_min),
                "max": list(world_max),
            },
        },
        handle,
        indent=2,
    )

log(f"  wrote       {uv_path} ({uv_flat.nbytes // 1024} KB) + uv-index.json")
log(f"✓ blender bake finished in {time.time() - started:.1f} s")
