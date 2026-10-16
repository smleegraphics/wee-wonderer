# Collision mesh

How the room's collision is derived from the splat, and what has been learned
about its failure modes. Read this before changing the voxelizer, the floor, wall
handling, or scan cleanup.

## Pipeline

```
splat centres + opacity → density field (voxels) → cleanup, ground gaps → Surface Nets isosurface
  → Taubin smoothing → three-mesh-bvh → controller queries
```

- No physics engine. The character is kinematic and only needs collision detection.
- It is a full mesh, not a heightfield, so the figurine can walk under tables.
- Built in a Web Worker on first load of a scan, then cached in IndexedDB
  (`src/collision/voxel-cache.ts`). The cache key includes `SCHEMA` and every `VOXEL_OPTS`
  value. Uploaded scans skip the cache.
- Real splat centres must be read from the loader geometry before `GaussianSplat`
  is constructed (it swaps its geometry for a billboard quad), then transformed by
  `splat.matrixWorld`.
- `new MeshBVH(geom, { indirect: true })` is required: without it the BVH reorders
  the index and face-index checks (such as "is this the backstop plane") break.

## Measuring it: `scripts/collisioncheck.mjs`

`node scripts/collisioncheck.mjs` loads the four demo rooms and Marishka (a dog on a
blanket: nothing in it is flat or hard-edged, which is what the rooms cannot test) and prints how sound each
one's collision is as ground for a game, then fails if any guarded number is worse than
`scripts/collision-baseline.json`. Run it after any change to the voxelizer, its
settings, the NavGrid, or how the figurine moves. When a change is meant to improve a
number, check it did, then `--save` the new baseline in the same PR. The measuring is
`src/collision/collision-health.ts`, loaded only under `?tel=1`. Collision is seeded, so the
numbers repeat exactly. `--with key=value` tries a setting without saving it (any
`VOXEL_OPTS` key, or `vox`): `node scripts/collisioncheck.mjs --with refine=1`.

Lengths and areas are in grains (see "Sizes are in grains" below), not cells of whatever
grid is in use, so numbers compare across grid sizes.

Baseline (SCHEMA g31, default settings; Playroom is built at mesh detail 2, the rest at 1):

| | Living Room | Counter | Kitchen | Playroom | Marishka |
|---|---|---|---|---|---|
| Walkable area (grains²) | 9,672 | 4,458 | 4,586 | 16,614 | 10,964 |
| Platforms (of 40 grains² or more) | 85 (25) | 72 (15) | 67 (16) | 121 (38) | 19 (8) |
| Cells on small perches | 9.3% | 19.8% | 15.9% | 7.6% | 1.5% |
| Cells reached from spawn by walking | 46.6% | 44.2% | 55.9% | 54.8% | 81.3% |
| ...and jumping or dropping | 46.8% | 52.5% | 75.8% | 65.1% | 82.5% |
| ...and climbing the mesh's faces | 99.4% | 55.3% | 75.8% | 99.2% | 99.9% |
| ...if every meeting of surfaces had a face | 99.6% | 55.3% | 75.8% | 100.0% | 99.9% |
| Real platforms no face could join | 0 | 12 | 5 | 0 | 0 |
| Area a climb can start from (grains²) | 1,085 | 448 | 222 | 2,253 | 358 |
| Holes in the spawn surface | 1.1% | 4.5% | 4.4% | 3.3% | 0.4% |
| Spawn surface cells on an edge | 12.8% | 20.3% | 14.6% | 11.1% | 5.9% |
| Spawn surface fills its convex outline | 67.5% | 86.1% | 81.2% | 82.7% | 90.4% |
| Spawn surface roughness (slope) | 0.05 | 0.34 | 0.18 | 0.04 | 0.60 |
| Triangles | 107,692 | 50,480 | 42,796 | 744,456 | 102,900 |
| Mesh pieces | 34 | 39 | 53 | 32 | 13 |
| Mesh bumpiness | 0.091 | 0.130 | 0.098 | 0.090 | 0.101 |
| Mesh to nearest opaque splat, median / 90th pct (grains) | 0.60 / 1.05 | 0.56 / 0.95 | 0.60 / 1.33 | 0.42 / 0.84 | 0.54 / 0.81 |
| Opaque splats with no mesh within 2 grains | 8.1% | 10.8% | 13.6% | 2.5% | 12.4% |
| Sight lines that meet no collision | 32.0% | 42.2% | 43.7% | 21.7% | 43.5% |

How far each number can be trusted:

- **The script checks its own arithmetic first.** It runs the measuring on a made-up
  room (a floor with a hole, a ledge too high to jump to, a floor too far to jump to)
  where all 23 numbers can be counted by hand, and measures nothing if one is wrong. Add
  a case there when adding a number.
- **Reach is a model of the movement, not the controller.** Its jump was checked against
  the game: a real jump rises 0.24 and carries about 1.3 at a run, the model's
  0.26 and 1.29. It ignores walls in the way of a jump. For climbing, a higher surface
  is reached from a cell within a mantle's step of it, seen from above, if the mesh has
  a wall between the two at every height from the feet to where a mantle takes over
  (`climbableFace` in `main.ts`, through the climb's own `climbWall` and `isWall`). The
  row below it drops that test: it is the most that better faces could reach, and what
  it leaves out no change to faces will join. No predicted climb has been played out in
  the game to confirm it. The model takes its speeds from `TUNE` and `CLIMB`, so it
  follows them when they change.
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
- **"Fills its convex outline" is shown but not guarded.** It is a share of the
  surface's own outline, so it falls when the surface grows into a less regular shape:
  filling Living Room's bare floor took walkable cells from 8,247 to 9,626 and walking
  reach from 30% to 46%, and this number from 75.5% to 66.2%. Judge floor changes by
  walkable cells and reach.
- **Mesh-to-splat distance rises when ground is filled in**, since filled ground has
  no splats by it (Living Room's 90th percentile 0.89 to 1.13). That is the fill's cost
  showing, not the mesh loosening: read the median for looseness.
- **"Mesh bumpiness"** is how far the mesh is from flat inside each grain-sized box of
  space (the share of the triangles' orientation that is not along the box's main
  direction, by area). It must be measured over a fixed size. The first version
  measured it per vertex, and a finer mesh reads smoother that way only for being
  finer: it said mesh detail 2 halved the bumpiness when detail 2 is 40 to 70% bumpier
  on every scan, and it was believed for a day.
- **"Area a climb can start from"** runs the game's own start test (`climbStartsHere`,
  which `tryStartClimb` acts on) from every walkable cell in eight directions. It is the
  number for "is climbing harder to start".
- **"Sight lines that meet no collision"** looks out in 400 directions from cells of
  the start surface 6 grains apart, on a lattice fixed in the world, and counts the
  lines that hit nothing. It is what notices a wall with holes in it, which nothing else
  here did: a trim that ate through Playroom's walls read 8 points up, with every other
  number fine. The same solid meshed two ways still reads up to 2 points apart, so its
  guard has 3 points of slack. Open-sided scans score high; only the change matters.
- **Shares of a total mislead when the total moves.** "Reached by walking" rose on
  every room when a change shrank the walkable area. Read it beside the area.
- **No small floating mesh pieces** on any room (`despeckle` works), so that guard only
  matters if it starts failing.

What the baseline says:

- **Walking alone reaches about half of what is walkable.** Jumping adds little; the
  rest depends on climbing.
- **Where surfaces meet, the mesh nearly always has a face to climb**: missing faces
  cost about 1% of reach on Counter, Living Room and Playroom, and nothing on Kitchen.
- **Counter and Kitchen have real platforms nothing reaches** (12 and 4): other
  furniture across gaps the scan never covered. That, not faces, is what keeps their
  reach at 54% and 75%.
- **A tenth to a fifth of walkable cells are small perches**, which is not a fault: see
  the next section.
- **The mesh sits 0.5 to 0.6 voxel off the splats**, the looseness described below.

Not measured:

- **Thin or blank surfaces** (hollow cabinet doors) as such: only where one leaves no
  face between two surfaces does it show, in reach.
- **Whether the mesh is right where it is**, only how far it is from splats.
- **Headroom and narrow passages**, beyond what the NavGrid already requires to stand.

## Sizes are in grains, not voxels

`GRAIN` (`main.ts`, `TARGET_RADIUS / 72`, about a fifth of the figurine's height) is the
length collision's settings are counted in: the voxel size they were tuned at. The
voxelizer takes it as `unit` beside `voxelSize` and turns each setting into voxels
itself (`per`), so a setting means the same thing on any grid. The walkable cells are a
grain apart whatever the grid (`navStep`), and the hole patching and health check count
in grains too. At the default grid a grain is a voxel, and nothing changed when this
went in (every health number identical).

- **About the scan, so in grains**: `despeckle` and `minCells` (areas), `close`,
  `fillFloor`, `floorFlat`, `STAND_ROOM`, how far a splat is spread, the NavGrid's
  `bridge` and `fill`.
- **About the grid, so in voxels**: `MIN_VAR`, Taubin passes.
- **The density thresholds are per unit of area** (`iso`, and what counts as "strong"):
  a sheet's opacity is so much to an area, so a voxel's share goes with its face.

## Mesh detail: what is solid, and where its surface is, on two grids

The mesh stands off the splats because a voxel is solid all the way across: any voxel
a sheet of splats passes through is solid, and the mesh goes round the outside. Measured,
a vertex is 0.3 to 1.8 voxels from where the density peaks (median 0.9), and a toy five
voxels across comes out as a dome.

`refine` ("Mesh detail" in the Debug card, default 2) builds the mesh on a grid that many
times finer than the one that decides what is solid (`refineSolid`):

1. Everything above runs as before on the coarse grid. That decides WHETHER there is
   surface, where pooling over a large voxel is what a sparse scan needs.
2. The solid is copied to the finer grid and trimmed toward the splats, reading the fine
   density evened out between neighbours.
3. The surface is placed within its voxel: where nothing was trimmed, by the coarse
   density (exactly the detail-1 surface, on a finer mesh); where something was, by the
   trimmed solid's own shape, evened out.

Rules the trim keeps, each there because its absence broke something measured:

- **A voxel goes only if the solid stays the same in kind** (a simple-point test, with
  solid joined across faces only). Without it Playroom's walls were eaten through.
  Joined across edges and corners too, walls thinned to a lattice the mesh draws gaps in.
- **Which way is thickness is settled once**, before trimming. Asked afresh each pass
  it flips as scraps are left standing, and they can no longer be taken off: the floor
  was dotted with them.
- **A sheet (thin one way, long the other two) is walked in to its density peak, across
  itself only, and keeps 2 fine voxels.** Thinner, its faces touch or cross: a tabletop
  loses its headroom to its own underside and a wall is met from behind (Counter lost a
  third of its walkable area, Playroom a sixth of its climbing).
- **A lump (thin no way) loses one layer at most, and only what the fine grid does not
  call solid.** Walked to its "peak", a toy is eaten to a core: evened out, a small
  thing's density is greatest in its middle.
- **What is thin more than one way is left alone** (a strip of wall between two gaps, a
  rail). Taken as a lump it loses its sides, and every gap a sparse wall has widens.
- **The ground is left alone**: `floorFlat` already puts it on its splats, and trimmed
  as well it steps about the edge of the flattened band and leaves bumps over it.

**Each scan gets the detail it has the splats for**, up to the `refine` setting (the
slider's "up to"): the finer grid is used only while there are at least 3 splats to each
of its solid voxels (`SPLATS_PER_FINE_VOXEL`). Its density is only worth reading with
several splats to a voxel; with fewer it is noise, and a mesh trimmed to noise is pitted.

| | Splats per solid voxel | Per voxel twice as fine | Gets |
|---|---|---|---|
| Playroom | 36.7 | 4.6 | 2 |
| Kitchen | 16.7 | 2.1 | 1 |
| Counter | 10.0 | 1.3 | 1 |
| Living Room | 4.9 | 0.6 | 1 |
| Marishka | 4.5 | 0.6 | 1 |

What detail 2 does, measured with the floor flatten below in place (detail 1 / 2):
Playroom's floor roughness 0.14 / 0.04 and fit 0.46 / 0.42, which is why it gets it;
bumpiness up 40 to 70% on every scan (Playroom 0.061 / 0.090, Marishka 0.101 / 0.170);
Marishka visibly pitted all over; Kitchen's floor rougher (0.18 / 0.27). Reach and sight
lines are the same at both. It costs four to five times the triangles and a slower first
build (Playroom 4.2 → 9.1 s, cached after); frame time while walking did not change.

The rule is drawn from five scans with one on the "yes" side: the threshold sits in the
gap between Playroom (4.6) and Kitchen (2.1), and a scan landing in that gap is untested.
Opaque splats per voxel and opacity per voxel were tried and do not separate the two.
(Detail 2 was the default for every scan for a day, on the strength of the bumpiness
number that turned out to be wrong.)

**Bump `SCHEMA` on every change to the trim.** The cache key holds the settings, not
the code: a browser that has built a room at detail 2 goes on showing that mesh. Headless
checks start with an empty cache and never see this.

Tried and rejected, for a closer fit:

- **Raising `iso`.** Tightens and drops faint surfaces (Counter 0.6: fit 0.59 → 0.53,
  scan with no collision 10.8% → 17.4%).
- **Moving each vertex along its normal to the splats over it** (after meshing, on the
  coarse grid). Fit 0.62 → 0.40, but the mesh tears at creases, where a vertex's normal
  is a compromise and its splats pull it somewhere neither face goes; walkable area fell
  10 to 30%. Not tried on the finer, smoother mesh, where it might behave.
- **A finer grid for everything** (`?vox=`, half the grain). Well-captured things come
  out close (Kitchen 0.61 → 0.42), and sparse surfaces fall apart: a wall that pools to
  solid in a coarse voxel does not in eight small ones. Living Room lost a quarter of
  its walkable area and a fifth of its climbing. Lowering `iso` to mend that brings the
  fatness back (0.54) at five times the triangles.
- **A trim with fewer rules.** Each rule above gave back closeness: with only "a denser
  voxel lies behind" the fit was 0.31 on Playroom and its walls had holes; with the
  simple-point test and nothing else, 0.33 and its toys were gone. The safe version is
  0.47. Closeness and safety pull against each other in a voxel trim, because voxels
  cannot tell a toy from a wall from a strip without a rule for each.
- **More Taubin passes** for a bumpy trim: no change at 2× or 4×. The bumps were the
  solid's, not the mesh's.

Open:

- **Closer fit is still wanted**, most of all on small objects.
- **A climb violation on Living Room, not traced.** `climbfuzz` used to give different
  results run to run (fixed in its own PR: it now drives in fixed steps and repeats
  exactly; see `context/climb.md`). Run that way on this work, Living Room seeds 1 and 5
  each report one violation, at the same place: the yellow footstool on the rug, around
  (1.1, 0.25, −2.9), climbing its leg from mid-air under the seat (`up` −0.07, an
  overhang) with a back face 0.10 ahead at chest height. On the code before this work,
  seeds 1 to 5 report none, but the figurine starts elsewhere and takes other paths, so
  that does not show this work caused it. Counter, Kitchen (seeds 1 to 3), Playroom and
  Marishka (seed 1) report none.
- A scan whose finer grid would pass the voxelizer's memory cap is built at detail 1.
  None of the four rooms is.

## The ground: its level, flattening it, and starting on it

"The ground" is the level the figurine plays on: a room's floor, a table's top. The
voxelizer finds its row once (`groundRow`: the commonest lowest-place-with-room-to-stand
near the scan's centre) and three things use it: the gap fill below, the flatten, and
where the figurine starts.

**Flattening (`floorFlat`, "Floor flatten" in the Debug card).** The mesh within 1.5
grains of the ground's splats (2 in Playroom: see below) is snapped onto their level,
which is where the scan's opacity peaks near the ground's row.

- **Playroom is given 2 grains, by hand** (its entry in `SCANS`; "Settings for one scan"
  below). Its rug is uneven, and ridges of it stood just above 1.5 grains as bumps on
  the floor, at mesh detail 1 and 2 alike. At 2 its floor's roughness goes from 0.04 to
  0 and its bumpiness from 0.090 to 0.077; the cost is that more low clutter becomes
  floor (the area a climb can start from 2,253 → 2,150, and the small toy car is mostly
  absorbed). 2 is not the default because the tabletop scans lose ground the figurine
  can walk to: Kitchen 55.9% → 50.6% from spawn, Counter 44.2% → 40.7%.

- **It used to be measured from y = 0 and from the mesh**: everything under 0.75 grains
  over y = 0 went to the median height of those vertices. y = 0 is a low percentile of
  the scan's heights and the floor's splats lie a little over it, so the cut ran through
  the floor's own top surface. Part was flattened, to a level the slab's underside
  dragged below the splats; the rest was left as it came, up to a grain and a half above
  them. Playroom had 2,390 floor cells at −0.5 grains and 6,350 spread over +0.75 to
  +1.75, with its splats at +0.25. Living Room the same. The ridges along Playroom's rug
  were the edge between the two layers.
- **It is not floaters.** Rebuilt from Playroom with 80% of its splats stripped, the two
  layers were still there, the same size. Having collision ignore splats under 20%
  opaque moved the floor's roughness from 0.36 to 0.34.
- **Only flat ground is flattened**: where at least 1.5% of the opacity near the ground
  is splats that themselves lie flat at one height (Playroom 15%, the other rooms and
  tables 4%, Marishka under 0.5%). Flattened regardless, Marishka's blanket was cut into
  terraces and its climbing reach fell from 99.9% to 81.9%.
- **The band reaches as far under the level as over it and no further.** Taking in
  everything below is right for a floor and pulls what is under a table up into it.
- **Under a raised ground the real floor near y = 0 is still flattened the old way**
  (`FLOOR_UNDER`). Left as it comes, its scraps are places to stand.
  Only there: this used to run as well whenever the flatten was off (at 0, or on ground
  that is not flat), so "0 = off" still snapped the lowest 0.75 grains to their median.
  Playroom at 0 read 0.35 roughness with that and 0.28 without. Marishka's numbers did
  not change either way.
- Result (floor roughness, before → after): Playroom 0.29 → 0.04, Living Room
  0.15 → 0.05, Kitchen 0.25 → 0.18, Counter 0.40 → 0.34, Marishka unchanged.
- Cost: anything lower than the band is floor. The puzzle board on Playroom's rug is.

**Starting (`resetToSpawn`).** The figurine starts at the spot nearest the scan's
centre that is at the ground's height (`VoxelSurface.groundY`, within a step) and where
its whole capsule fits: `findSpawn` with a level. Without a level, `findSpawn` takes the
"lowest place near the centre with room to stand"; that is the fallback, for when
nothing at the ground's height fits. On Counter that lowest place is the inside of a
glass bowl: it always was, and a bumpy worktop used to make a ramp out of it.

- **A walkable cell is not a place the figurine fits.** A cell only has room overhead at
  one point. Starting on the walkable cell nearest the centre put Kitchen's figurine on
  the table under the Lego bulldozer, between its tracks, boxed in. The health check did
  not see it: walking reach is counted over cells, which ignore the body's width, and that
  cell joined the table.

## Playroom cannot be cleaned by the floater cleaner

`scripts/clean-scan.mjs` was run on `room2.ply` with each of its rules alone. Every one
makes holes in a room that has none (see-through pixels, mesh behind / nothing):
standard settings 33% / 11% (keeping 19% of the splats); opacity floor 0.02, 16% / 9%;
opacity 0.1 with no size cap, 10% / 2.5%; density alone at its gentlest, removing 4% of
the splats, 8% / 2.5%. Playroom's plain walls, cabinets and floor are drawn by a few
large faint splats each, which is what every rule takes a floater to be. It is not
"80% floaters": 80% of its splats are faint, and most of those are the room. What made
its collision untidy was the flatten above.

## Small platforms are perches, not debris

Each room has 60 to 100 platforms and only 12 to 31 of 40 cells or more, which looks
like fragmentation to clean up. It is not. Measured against the surface the figurine
starts on, as a share of all walkable cells:

| Small platforms that are... | Living Room | Playroom | Counter | Kitchen |
|---|---|---|---|---|
| more than a figurine's height above it | 8.6% | 6.0% | 5.7% | 4.9% |
| up to a figurine's height above it | 0.8% | 0.6% | 2.0% | 4.5% |
| at its level (fragments of it) | 0.1% | 0.2% | 2.9% | 1.8% |
| below it | 0% | 0% | 7.9% | 4.5% |

- **In the rooms nearly all are small tops high on furniture**: real places to climb
  to. Removing them would take those away to improve a number.
- **Fragments of the floor are next to nothing**, now that `fillGround` joins its
  pieces. There is nothing to merge.
- **On Counter and Kitchen** the rest is the other furniture and real floor round the
  table, most of it out of reach whatever is done here.

So collision is left as it is, and "cells on small perches" is shown by the health
check but not guarded. When a game feature needs real platforms only (placing things,
paths for other characters), give the NavGrid a way to say which those are; do not
delete the small ones.

## Filling gaps in the ground: `fillGround`

The scan leaves bare stretches of floor with no splats, so no collision: holes and
ragged edges in the one surface everything else stands on. `fillGround`
(`src/collision/voxelize-core.ts`, the `fillFloor` setting, "Ground gap fill" in the Debug card)
fills them in the voxel grid before meshing. The hole patching (`splat-fill.md`) follows
by itself, since it tracks the walkable cells.

- **It works at the level the figurine starts on**: the commonest "lowest place with
  room to stand" near the scan's centre, the voxel-grid twin of `findSpawn`. In a room
  that is the floor; on Counter and Kitchen it is the worktop and the table.
- **Holes with the surface all round them are filled at any level** (as before).
- **On the ground only, bare stretches are filled when nothing `fillFloor` voxels wide
  can get into them from outside**, with the floor and anything within a figurine's
  height above it (walls, furniture) in its way. Never where the scan has something
  beneath the level.
- **"The ground" means almost nothing of the scan lies below the level** (`RAISED`,
  5% of solid voxels): rooms have none below their floor, Kitchen's table 13%,
  Counter's worktop 26%. Beside a raised surface there can be open air (the aisle
  between two worktops), and a wide flood would bridge it; beside the ground there
  cannot.

What it gained at the default of 20 voxels (the figurine is about 5 tall):

| | Walkable cells | Reached by walking |
|---|---|---|
| Living Room | 8,247 → 9,626 | 30.3% → 46.3% |
| Playroom | 15,290 → 15,991 | 56.8% → 59.9% |
| Counter, Kitchen | unchanged (raised) | unchanged |

Tried and rejected:

- **"The busiest row in the lower third of the grid" as the floor**, which is what the
  old `fillFloorHoles` used. On a worktop scan that row is the real floor under the
  furniture, where the figurine never stands. (The same wrong assumption as the first
  visual fill: that the surface that matters is near the bottom of the scan.)
- **The wide flood at that row on Counter.** It made 1,400 to 1,950 cells of real floor
  walkable, the spawn search then chose it (it takes the lowest standable surface), and
  the figurine started under the counter with no way up: walking reach 44% to 18–23%.
- **Widths of 8 and 12.** About 3% more walkable area on the rooms. Living Room's bare
  patch only closes at 20.
- **Filling the row below the level** instead of the one above it. Playroom's floor
  got rougher (0.29 to 0.31): where its surface is a voxel higher, that is the row
  with the holes in.

Known limits:

- **A floor open along a whole side stays open there** (Living Room toward its missing
  wall). No width tells that from the edge of the room.
- **Nothing here helps the furniture Counter and Kitchen cannot reach**: that needs
  their real floor to be walkable, which is a decision about walking on ground that
  was never scanned, not a setting.
- **Filled ground is flat floor with nothing drawn on it** until the hole patching
  covers it, and that is a smooth blur of the colour around.
- **`STAND_ROOM` is 5 voxels**, about the figurine's height, fixed in the voxelizer:
  collision is built before the figurine loads and is cached per scan, not per figurine.
- `climbfuzz` on Living Room (seeds 1, 2, 4) reports no violations with the fill on.
  Seed 1 has three samples with the climber's body more than half a radius into the
  mesh, which seeds 2 and 4 do not, and which Counter also shows without the fill. Not
  traced to a cause.

## Settings for one scan

`useScanSettings(id)` in `src/main.ts` decides the collision settings (`VOXEL_OPTS`) when
a scan starts loading, from three layers, later ones winning:

1. `VOXEL_DEFAULTS`: what every scan starts from.
2. The scan's own, set by hand in its `SCANS` entry (`collision: { floorFlat: 2 }`). Only
   the example scans have entries, so an uploaded scan gets the defaults. An entry applies
   whether or not the scan is `listed` in the Scans card: Playroom is unlisted (a local
   test scan) but still loads with its own setting through `?scan=room2.ply`.
3. What has been set for the session (`voxelSet`): in the address, or by a Debug slider.
   These hold across rooms, so a slider moved in one room stays where it was put in the
   next, and `collisioncheck.mjs --with` overrides a scan's own value.

The Debug sliders are moved to show the loaded scan's values. The cache key already
includes every setting, so a scan's own value needs no `SCHEMA` bump.

A hand-set value is for an example scan the defaults do not suit, with the reason and
the measured cost written beside it. It does nothing for an uploaded scan. Settings an
uploaded scan needs should be measured from the scan, the way mesh detail and whether
the ground is flat already are (both inside the voxelizer, where the splats are); a
measured layer would sit between 1 and 2.

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
   reconstructs the floor slightly below it. Then it flattened to the median of the low
   vertices, which left most of the floor a grain above its splats. Now it flattens
   onto the ground's splats: see "The ground".
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

**A loose "bubble" between mesh and splat** (see also "Mesh detail" above) came from `close` (dilate then erode).
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
(offline) and `src/scan/clean-scan-core.ts` (in-browser, on import) drop splats failing
on opacity, size, or local density, then level and crop to the room.

- Production parameters: `alphaMin 0.35`, `minMass 4`, `scaleCapMul 4` (about half
  the splats kept).
- Playroom (`room2.ply`) is not pre-cleaned and cannot be: see "Playroom cannot be
  cleaned by the floater cleaner".
- Kitchen and Counter are tabletop scans, not walk-around rooms. Living Room and
  Playroom are the real rooms.
- The cleanup's occupancy grid and leveling are the same infrastructure collision
  uses. Build on it; do not duplicate the filter pass.
- Phone captures with bright windows, glass, or soft surfaces are heavy with
  floaters. The pipeline copes, but capture quality is the limit.

## SPZ moves Kitchen's collision

Converting the scans from `.ply` to `.spz` (`context/deploy.md`, "Scan files") changed
Kitchen's numbers slightly and the other rooms' not at all: reach from spawn 75.8% →
74.1%, walkable from spawn 55.9% → 54.8%. Accepted, and the baseline re-saved.

- **The cause is SPZ's position rounding.** Applying its opacity, scale, rotation and
  colour changes alone leaves the numbers as they were. The largest move is 1.22e-4 scan
  units.
- **Ruled out, each alone leaving the numbers as they were:** random jitter of the same
  size, a translation of the whole scan, and the 0.006° change in orientation the
  rounding causes.
- **How so small a move changes reach is not known.** It is far below a voxel, so
  something downstream must sit on a threshold (an isovalue crossing, a nav cell's
  headroom, a platform join). Not investigated further.
- A different mesh also sends `climbfuzz` down a different path, which is how it exposed
  the climb snap bug (`context/climb.md`, rule 12).

## Ideas parked for later

- Measuring more settings from the scan, for uploaded scans: the flatten band from how
  uneven the ground is (the width of the peak the ground's level is read from; not yet
  measured whether it tells Playroom from Kitchen and Counter), and the isovalue from how
  faint a scan's plain surfaces are (Playroom's beanbag is a ring with open sides at
  0.35 and nearly closed at 0.1, where the mesh is also fatter: median fit 0.42 → 0.67).
- A cleaner continuous render of the nav surface as a debug mode (the `P` overlay
  already shows NavGrid tiles).
- Letting the user paint a region as "one continuous surface" to bridge gaps the
  automatic hole fill misses.
- Slope limit and step offset for stairs and ramps.
