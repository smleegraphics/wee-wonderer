# Filling a scan's gaps with approximate splats

How the see-through ground under the figurine is patched, what was measured, and what
was tried. Read this before changing the fill or adding another kind. Code:
`src/fill-scan-core.ts` (the work), `src/fill-scan.worker.ts`, and `WALK_FILL`,
`FILL_VIEW`, `installFillView`, `refillWalkable`, `showSplat` and the end of `showScan`
in `src/main.ts`.

## The problem, and its scope

Phone-quality scans have ground with few splats or none, so the backdrop shows through
where the figurine stands: dark speckle across Kitchen's tabletop, most of all near its
edge. The source photos are not available, so nothing can be re-optimised.

**Only ground the figurine can stand on is filled.** Holes elsewhere (a bare stretch of
floor with no collision, a missing wall) are accepted. That is the owner's call, and it
is what makes the problem tractable: every attempt to decide where an uncaptured
surface "should" continue filled open air somewhere.

## What it does

After collision is built, in a worker, before the splat object is made:

1. **Take the walkable cells** (`NavGrid.toField()`): where the figurine can stand, each
   with a height and the connected surface it belongs to.
2. **Look at each cell from straight above** at a few spots: the scan's splats within
   `band` of the cell's height are composited as the renderer draws them, giving how
   much each spot lets through. Splats lying flat also give the ground's colour and
   height; others (the side of a box on the floor) count for almost nothing there.
3. **Find the height to fill at**: just under the ground's own splats, so they sort in
   front and keep their detail. Collision's surface is up to half a voxel off the
   splats, so each cell carries an offset to them, and a bare cell takes its
   neighbours'.
4. **Spread colour into bare spots** (pull-push), one walkable surface at a time, so a
   floor's colour does not run onto a table.
5. **Lay flat splats** at spots less opaque than `under`, only on level
   ground of at least `patch` cells, and not in the ring of cells along its edge.

The added splats go in the same arrays as the scan's, after its own, and so in the same
`GaussianSplat`: sorted with it, moved by the reveal, shadowed, seen by the light probe.

Typical result: about 730 on Kitchen and Counter, 1,057 on Living Room, 1,912 on Playroom, about 0.1 s in the worker on the
small scans and 1.3 s on Playroom (1.9 M splats; nearly all of it is the pass over them).

## Rules

- **The fill follows the walkable cells, and nothing else decides where it goes.**
  `rebuildPlatformOverlay` calls `refillWalkable()` whenever the cells are rebuilt (the
  figurine loading, a Debug slider, a collision rebuild).
- **Order at load is collision, then fill, then the splat object.** `showScan` builds
  collision from the parsed arrays, hands them to the fill worker, and only then calls
  `showSplat`.
- **Each fill records which cells it was worked out from** (`navVersion`, kept in
  `currentScan.cellsUsed`), and `refillWalkable()` does nothing when that is current.
  So it is safe, and necessary, to call it after anything that might have left the
  fill behind: `showScan` calls it once the splat exists, because the figurine can
  arrive (and the cells be rebuilt with its real height) while the first fill is still
  being worked out, when there is no splat yet to refill. A slider of the fill itself
  passes `true`, since the cells have not changed.
- **A fill that cannot be worked out must not cost the room.** The worker answers with
  the scan unfilled and `failed` set; it does not reject, because the scan's arrays
  were transferred to it and a rejection would lose them. `showScan` shows the room
  without a fill and warns; a refill keeps what is being drawn.
- **Collision, orientation and the light-fill estimate use the scan's own splats only**:
  the first `own` of every array. Fill splats must never change where the figurine can
  stand, or the two would feed each other.
- **The scan's arrays are transferred to the fill worker.** Anything holding them from
  before holds nothing; read them from what comes back. A refill sends a copy, since
  the arrays being drawn must last until the new ones arrive (`currentScan`).
- **Sizes are in grains** (`GRAIN`: `collision.md`), which is the walkable cells' spacing.
- **Debug card, "Patch splat holes".** The toggles and "Fill opacity" are shader
  switches (`FILL_VIEW`): they act on splats by whether their index is past `own`.
  The other sliders change `WALK_FILL` and call `refillWalkable()`.
- **Judge a change by looking, fill off against fill on, in the scan's real colours.**
  Highlighting shows where the fill is, not whether it helps. `?tel=1` logs `WALKFILL`
  (splats added, time, how many walkable cells were over half see-through).
- **Playroom must look the same with the fill on.** It is well captured; anything the
  fill changes there is the fill being wrong.
- The mesh-only view skips the fill.

## Tried and rejected

Three designs came before this one. All are gone from the code.

- **A sheet at the floor, found near y = 0.** y = 0 is the 6th percentile of the scan's
  heights (`orientScan`), not the main surface: Counter's worktop is at 0.95, Kitchen's
  table at 0.20. The sheet went under Counter's worktop, out into the room.
- **Flat surfaces found from the splats, each filled inside its own outline** (captured,
  stood on, open, unknown; gaps closed up to a width). It could not tell Living Room's
  floor running out to a missing wall from the open space round Kitchen's table: every
  setting that filled one filled the other.
- **Either of those, judged by `holes.mjs`.** A sheet in mid-air hides the backdrop as
  well as one on the surface, so the wrong fill scored best.
- **Filling every see-through walkable cell.** On tops the figurine can stand on but
  that are not flat (an onion, a bowl's rim, a toy) the sheet floats beside the curve as
  a smear. Hence `patch` and `level`.
- **Filling the ring of cells along a surface's edge**, in any form: a margin past it,
  all of the ring, or the ring's spots that have something drawn. Collision is about
  half a voxel fatter than the splats, so the ring straddles the real edge, where the
  splats thin out as they should. Filled, it left an evenly spaced row of fill splats
  hanging off Counter's worktop.
- **Leaving out everything within two cells of an edge.** Safe, and it left out the
  speckle near Kitchen's table edge, which is the thing to fix.
- **Colour and height from every splat at the cell's height.** Beside a box on the
  floor the fill took the box's colour and rose up its side.
- **`under` 0.9**: fills the ordinary thin places in Playroom's rug, visibly.
  **0.5**: leaves Kitchen's speckle.
- **Running the fill before collision**, as the first designs did: there are no
  walkable cells yet.
- **`opacity = 1 − (1 − sheet)^(1/overlap)` for each splat.** It assumes equal weights
  and left the sheet 92–94% opaque.
- **A second `GaussianSplat` for the fill** was not tried: two splat objects sort
  separately, so one would always draw over the other.

## Known limitations and open questions

- **It only reaches ground that has collision.** The worst gaps have none, so they stay.
  Making one walkable is a collision change (its hole bridging); the fill would follow.
- **Small or uneven walkable tops are not filled**, by `patch` and `level`, nor the
  outermost cell of any surface, so speckle right at an edge stays.
- **Climbable faces are not filled.** A measurement put 7 to 15% of their area under
  half opaque, but the same measurement over-counted on Playroom, so it is not trusted.
- **Slopes get a stepped sheet**: each cell's splats are level, at that cell's height.
- **The fill is a smooth blur of colour**, with no texture.
- **Playroom's fill takes 1.3 s**, during which the room is not yet shown.
- **Not verified:** frame time (the first design, with ten times the splats, showed no
  change), uploaded scans, a refill landing while the room is still arriving, and the
  light probe's strength table in `lighting.md`.

## Measuring: `scripts/holes.mjs`

`node scripts/holes.mjs <scan.ply> [outDir]` counts see-through pixels from 16 cameras
inside the room, fill off and on, by what is behind them (collision mesh, backstop plane,
nothing). It measures the whole view, most of which the fill now leaves alone on
purpose, so expect it to barely move; it is kept for the question of walls and as a
check that Playroom has no holes. `window.__matte` (`?tel=1`) is what it drives: the
scan or the solid mesh alone, over a chosen backdrop, from a fixed camera, with the fill
faded by `fill`.

## Outside work

Nobody was found doing this at load time from a finished `.ply`. The nearest:

- **Post-process fill**: Nodeconnector's Houdini cleanup HDA transfers neighbours'
  colour and SH onto new splats. How it finds holes is not published.
- **Flat Gaussians bound to a surface** (SuGaR, Gaussian Frosting, GaMeS): the
  placement recipe used here, minus their optimisation against photos.
- **Geometry-guided densification** (GaussianPro, GeoGaussian, PlanarGS): needs the
  photos. Confirms that textureless surfaces come out sparse.
- **Generative completion** (G4Splat, GSComplete, SplatFill): diffusion inpainting, far
  too heavy for the browser.
