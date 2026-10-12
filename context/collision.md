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
