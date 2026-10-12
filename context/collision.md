# Collision mesh

How the room's collision is derived from the splat, and what has been learned
about its failure modes. Read this before changing the voxelizer, the floor, wall
handling, or scan cleanup.

## Pipeline

```
splat centres + opacity → density field (voxels) → cleanup → Surface Nets isosurface
  → Taubin smoothing → three-mesh-bvh → controller queries
```

- No physics engine. The character is kinematic and only needs collision detection.
- It is a full mesh, not a heightfield, so the figurine can walk under tables.
- Built in a Web Worker on first load of a scan, then cached in IndexedDB
  (`src/voxel-cache.ts`). The cache key includes `SCHEMA` and every `VOXEL_OPTS`
  value. Uploaded scans skip the cache.
- Real splat centres must be read from the loader geometry before `GaussianSplat`
  is constructed (it swaps its geometry for a billboard quad), then transformed by
  `splat.matrixWorld`.
- `new MeshBVH(geom, { indirect: true })` is required: without it the BVH reorders
  the index and face-index checks (such as "is this the backstop plane") break.

## Measuring it: `scripts/collisioncheck.mjs`

`node scripts/collisioncheck.mjs` loads the four demo rooms and prints how sound each
one's collision is as ground for a game, then fails if any guarded number is worse than
`scripts/collision-baseline.json`. Run it after any change to the voxelizer, its
settings, the NavGrid, or how the figurine moves. When a change is meant to improve a
number, check it did, then `--save` the new baseline in the same PR. The measuring is
`src/collision-health.ts`, loaded only under `?tel=1`. Collision is seeded, so the
numbers repeat exactly.

Baseline (SCHEMA g15, default settings):

| | Living Room | Counter | Kitchen | Playroom |
|---|---|---|---|---|
| Walkable cells | 8,247 | 4,584 | 4,657 | 15,290 |
| Platforms (of 40 cells or more) | 89 (28) | 65 (16) | 62 (12) | 104 (32) |
| Cells on scraps (smaller platforms) | 10.9% | 18.5% | 16.0% | 7.1% |
| Cells reached from spawn by walking | 30.3% | 43.9% | 58.2% | 56.8% |
| ...and jumping or dropping | 37.6% | 52.4% | 75.1% | 64.5% |
| ...and climbing (upper bound) | 99.6% | 55.5% | 75.1% | 100.0% |
| Real platforms out of reach | 0 | 12 | 4 | 0 |
| Holes in the spawn surface | 1.1% | 3.7% | 2.0% | 1.4% |
| Spawn surface cells on an edge | 13.6% | 16.9% | 11.6% | 9.4% |
| Spawn surface fills its convex outline | 75.5% | 87.2% | 83.1% | 85.9% |
| Spawn surface roughness (voxels) | 0.15 | 0.42 | 0.25 | 0.29 |
| Mesh pieces | 39 | 39 | 53 | 32 |
| Mesh to nearest opaque splat, median / 90th pct (voxels) | 0.58 / 0.89 | 0.59 / 0.96 | 0.61 / 1.16 | 0.50 / 0.86 |
| Opaque splats with no mesh within 2 voxels | 8.5% | 10.8% | 13.0% | 2.8% |

How far each number can be trusted:

- **The script checks its own arithmetic first.** It runs the measuring on a made-up
  room (a floor with a hole, a ledge too high to jump to, a floor too far to jump to)
  where all 19 numbers can be counted by hand, and measures nothing if one is wrong. Add
  a case there when adding a number.
- **Reach is a model of the movement, not the controller.** Its jump was checked against
  the game: a real jump rises 0.24 and carries about 1.3 at a run, the model's
  0.26 and 1.29. It ignores walls in the way of a jump. For climbing it counts a higher
  surface as reached when it comes within a mantle's step of a reached one seen from
  above, without checking that the face between is there and climbable: so "and
  climbing" is an upper bound, and "out of reach" is certain. It takes its speeds from
  `TUNE` and `CLIMB`, so it follows them when they change.
- **The mesh-to-splat distance is not an artefact of sparse splats**: opaque splats are
  a median 0.12 voxel from their nearest neighbour, against the 0.5 to 0.6 measured.
  It moves the right way with `iso` (Counter 0.71 / 0.59 / 0.53 at 0.15 / 0.35 / 0.6).
  It is measured to splat centres, so a large flat splat reads a little further off
  than it is.
- **"No mesh near" counts floaters too**, which are left out on purpose, and it is
  measured to mesh vertices, about a voxel apart. Watch it move; do not drive it to zero.
  Raising `iso` to 0.6 tightens the fit and loses scan (Counter 10.8% to 17.4%): the two
  have to be read together.
- **"Holes" is low because the NavGrid already fills enclosed ones.** A bare stretch
  open to the outside (Living Room's floor) shows in "fills its convex outline"
  instead, which furniture standing on the floor also lowers.
- **No small floating mesh pieces** on any room (`despeckle` works), so that guard only
  matters if it starts failing.

What the baseline says:

- **Walking alone reaches a third to a half of what is walkable.** Jumping adds little;
  the rest depends on climbing.
- **Counter and Kitchen have real platforms nothing reaches** (12 and 4): other
  furniture across gaps the scan never covered.
- **A tenth to a fifth of walkable cells are scraps** on clutter.
- **The mesh sits 0.5 to 0.6 voxel off the splats**, the looseness described below.

Not measured:

- **Thin or blank surfaces** (hollow cabinet doors), and whether a face that looks
  climbable is: reach assumes it.
- **Whether the mesh is right where it is**, only how far it is from splats.
- **Headroom and narrow passages**, beyond what the NavGrid already requires to stand.

## Rebuilding from the Debug sliders

- **`rebuildCollision()` does nothing while a room is loading.** There is no settled
  room then: the saved splats (`lastCenters` and the rest) are still the last room's
  while `currentFile` is already the new one, and bumping `loadToken` tells the load it
  was replaced, so the loading view never ends. A slider moved mid-load used to do all
  of that, and cached the old room's collision under the new room's name (hence
  `SCHEMA` g15). The load builds collision itself; when it ends, `loadFromURL` compares
  `collisionKey` with the current settings and rebuilds if a slider moved meanwhile.
- **`buildCollision` copies `VOXEL_OPTS` on entry** and uses the copy for both the cache
  key and the build, so a slider moved while it waits cannot store one setting's
  surface under another's key.

## Walking uses the NavGrid, not the mesh

A capsule simulated directly on the mesh got wedged on bumpy furniture and fell
through gaps. Ground movement now runs on a `NavGrid`: a grid of down-raycasts,
keeping up-facing hits with headroom, grouped into platforms, with enclosed holes
filled where a capsule fits.

- Horizontal motion is confined to walkable cells, with axis-separated edge sliding.
- Walls still push the capsule out horizontally (feet lifted so floor bumps don't).
- Surfaces steeper than the "Climb threshold" slider are not walkable; their tops
  become separate platforms.
- Cells below the leveled floor are rejected, so sub-floor floaters are not ground.
- Recovery snaps to the last good position if the figurine leaves the surface.

## Things that look like one bug but are several

**Figurine hovering above the floor has had three separate causes.**
1. Perpendicular puff from the splat variance floor. Fixed by `MIN_VAR` 0.25 → 0.05.
2. `floorFlat` snapped floor vertices up to a hard-coded y=0, but the isosurface
   reconstructs the floor slightly below it. Fixed by flattening to the detected
   floor level. Fixing leveling instead does nothing; the gap is datum versus
   isosurface.
3. Slab-top offset: on unflattened surfaces (furniture) the mesh top sits about half
   a voxel above the real surface. Inherent to voxelizing a surface; not fixed.

**Blank panels (cabinet doors, plain walls) are hollow because they are faint, not
absent.** A featureless surface reconstructs as sparse, low-opacity splats. The
density threshold drops them, and the floater cleaner deletes them too.
- Lowering `iso` to 0.05 still left the door empty.
- Peak-coverage voxelization filled it but turned everything into haze.
- A "solid behind it" discriminator failed, because the cabinet interior is also
  uncaptured.
- What ships: `panelFill` floods enclosed holes in dense vertical slices and fills
  those under an area cap. It cannot tell a door from a window or doorway. That is
  acceptable for a single confined room. A gentler cleaner that keeps faint coherent
  surfaces would be the real fix.

**A loose "bubble" between mesh and splat** came from `close` (dilate then erode).
At 3 it welded objects to the floor with a fillet and webbed surfaces together. The
default is now 1; large holes are handled by the floor and panel fills, which do not
weld. The remaining uniform half-voxel offset is the `iso` threshold. Raising `iso`
to about 0.6 tightens Playroom a lot but thins faint surfaces on cleaner scans
(Living Room, Kitchen), so a global bump is not safe. This is unfinished.

## Scan orientation

`orientScan` levels the floor with a seeded RANSAC fit and yaw-aligns walls to X/Z.
Both matter: unseeded, the mesh differed every load; without yaw alignment the
axis-sliced panel fill broke.

## Scan cleanup

Every real-capture 3DGS scan has a shell of floaters. `scripts/clean-scan.mjs`
(offline) and `src/clean-scan-core.ts` (in-browser, on import) drop splats failing
on opacity, size, or local density, then level and crop to the room.

- Production parameters: `alphaMin 0.35`, `minMass 4`, `scaleCapMul 4` (about half
  the splats kept).
- Playroom (`room2.ply`) is about 80% floaters even though it is not pre-cleaned.
- Kitchen and Counter are tabletop scans, not walk-around rooms. Living Room and
  Playroom are the real rooms.
- The cleanup's occupancy grid and leveling are the same infrastructure collision
  uses. Build on it; do not duplicate the filter pass.
- Phone captures with bright windows, glass, or soft surfaces are heavy with
  floaters. The pipeline copes, but capture quality is the limit.

## Ideas parked for later

- A cleaner continuous render of the nav surface as a debug mode (the `P` overlay
  already shows NavGrid tiles).
- Letting the user paint a region as "one continuous surface" to bridge gaps the
  automatic hole fill misses.
- Slope limit and step offset for stairs and ramps.
