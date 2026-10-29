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

Baseline (SCHEMA g36, default settings, the `*-crop` files, collision floater-filtered at load; Playroom is built at mesh detail 2, the rest at 1):

| | Living Room | Counter | Kitchen | Playroom | Marishka |
|---|---|---|---|---|---|
| Walkable area (grains²) | 11,487 | 5,186 | 4,796 | 16,655 | 11,125 |
| Platforms (of 40 grains² or more) | 68 (26) | 60 (20) | 64 (13) | 113 (34) | 17 (7) |
| Cells on small perches | 4.9% | 10.5% | 15.2% | 7.6% | 1.4% |
| Cells reached from spawn by walking | 52.5% | 33.0% | 52.8% | 53.8% | 80.2% |
| ...and jumping or dropping | 96.9% | 96.3% | 95.1% | 100.0% | 99.9% |
| ...and climbing the mesh's faces | 100.0% | 99.8% | 95.1% | 100.0% | 99.9% |
| ...if every meeting of surfaces had a face | 100.0% | 99.8% | 95.1% | 100.0% | 99.9% |
| Real platforms no face could join | 0 | 0 | 0 | 0 | 0 |
| Area a climb can start from (grains²) | 1,997 | 715 | 463 | 2,657 | 741 |
| Holes in the spawn surface | 2.5% | 10.6% | 1.4% | 3.8% | 1.1% |
| Spawn surface cells on an edge | 12.0% | 20.1% | 12.2% | 10.8% | 6.3% |
| Spawn surface fills its convex outline | 79.2% | 83.1% | 82.1% | 83.5% | 87.7% |
| Spawn surface roughness (slope) | 0.09 | 0.38 | 0.19 | 0.00 | 0.58 |
| Triangles | 123,172 | 61,296 | 185,472 | 731,156 | 102,996 |
| Mesh pieces | 11 | 33 | 47 | 32 | 14 |
| Mesh bumpiness | 0.084 | 0.112 | 0.135 | 0.084 | 0.100 |
| Mesh to nearest opaque splat, median / 90th pct (grains) | 0.56 / 0.94 | 0.54 / 0.90 | 0.53 / 0.96 | 0.41 / 0.84 | 0.53 / 0.81 |
| Opaque splats with no mesh within 2 grains | 9.8% | 14.5% | 18.5% | 2.5% | 12.7% |
| Sight lines that meet no collision | 28.6% | 39.0% | 42.9% | 22.2% | 43.5% |

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
  (`climbableFace` in `src/telemetry.ts`, through the climb's own `climbWall` and `isWall`). The
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
  Its cells know headroom, not the body's width (`context/movement.md`, rule 7), so "reach"
  counts cells a wide character cannot stand clear on. Per room, that is fine while the
  characters are close in size; for very different ones, measure per character.

## Sizes are in grains, not voxels

`GRAIN` (`src/app.ts`, `TARGET_RADIUS / 72`, about a fifth of the figurine's height) is the
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
voxelizer finds its row once (`groundRow`: the height with the most room to stand in the
whole scan, counting each column's lowest place with room to stand) and three things use
it: the gap fill below, the flatten, and where the figurine starts.

**Why the whole scan.** It used to count only within two figurine heights of the scan's
centre, so whatever stood over the centre decided it. Record Player Table's centre is under
its sideboard. Shrunk to its `size` (below), the gap under the sideboard was too low to
stand in, and the hollow inside the cabinet won: the ground was its bottom shelf, the
figurine started behind it at shelf height, and the gap fill worked at that level. Over the
whole scan the four rooms that were right stay on the same level (Kitchen's table, Living
Room's and Playroom's floor, Counter's worktop), and the most area still decides it on a
tabletop scan. It is counted by height, not by connected surface, so a floor cut up by rugs
and clutter still counts as one. Only places with room to stand count, so a wall never can,
unlike the levelling's rejected "biggest plane is the floor", which picked a wall. Curled Up
Dog's ground moved from 2.65 to 0.86 body heights (a soft blanket spreads over many heights)
and it now starts down in a fold of it; nothing in its collision check got worse.

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
its whole capsule fits: `findSpawn` with a level. A spot in the open, with nothing over it
up to the opening shot's camera (`CAM_START_HEIGHT`, 2.6 body heights), comes before a
nearer one under something, so the opening shot sees the figurine: Record Player Table's
nearest spot was under its sideboard. Of the spots in the open, one the opening shot can
see the figurine at past the splats (`openingSees`, context/climb.md, "Follow camera")
comes before one it cannot. Where nothing at that level is in the open, the
nearest covered spot is taken, as before; no other room's start moved. A start chosen
while the gap fill has the splat arrays (the figurine arrived during it) is chosen again
once they are back, before the room arrives (room.ts). Without a level, `findSpawn` takes the
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

- **It works at the ground's level** (`groundRow`, above: the height with the most room
  to stand in the scan). In a room
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

## Room size: rooms are scaled, what is added is not

Every scan is scaled at load so its spread (the 90th-percentile distance of its splats from
the centre) is `TARGET_RADIUS`, since a scan file says nothing of how big the real room was.
A scan's `size` in `SCANS` scales it from there: Record Player Table is 0.67, so the figurine
is 1.5× bigger beside its sideboard, enough for a jump to catch the sideboard's front and
climb it (at full size the front starts above where a jump reaches; at 1.3× and 1.4× no jump
caught it). The figurine, and anything else added to a room, stays one size in every room;
only the room changes. Everything collision does is counted in grains or body heights, so a
room drawn smaller is built with fewer, relatively bigger voxels: detail stays the same next
to the figurine. The size is part of the collision cache key (`TARGET_RADIUS × size`).
An uploaded scan has no `size`; a control to set one for an import is a later idea.

## Settings for one scan

`useScanSettings(id)` in `src/collision/room-collision.ts` decides the collision settings (`VOXEL_OPTS`) when
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
  `SCHEMA` g15). The load builds collision itself; when it ends, `loadRoom` compares
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
axis-sliced panel fill broke. The offline cleaner calls the same function (through Vite),
so a file cleaned offline and the same file imported are levelled the same way.

**The floor search must find the floor whatever splats it is given.** It tries planes
through three points and keeps the one most points lie on. Drawn from anywhere, all three
are on the floor (floor share)³ of the time: with the floor 7% of an AI-generated room's
splats (SpAItial's "Cozy room"), 500 tries missed it, and the room came in 25° tilted with
the figurine trapped on a strip of floor. Seeding made that repeatable, not safe: the same
file imported (cleaned in the browser) failed and cleaned offline worked, because the two
cleaners keep slightly different splats. Measured over 20 runs, each without a different
5% of the splats: the old search was off by over 1° in 13 (the cozy room, worst 30°), 10
(Living Room, worst 18.5°) and 10 (Kitchen) of them.

Now a try's second and third points come from near its first (`NEAR`), so it finds a
surface about as often as its first point lands on one; the number of tries follows from
the smallest floor it must not miss (`FLOOR_SHARE_MIN`, `MISS_ODDS`); the best few planes
are refitted to all of their points until they stop moving, and only then is the one most
points lie on chosen. Over the same 20 runs: no run off by more than 0.1° on the cozy room,
Living Room, Kitchen and Playroom. It costs 20 to 110 ms more per load (all main-thread,
during the loading view).

- **It moved every shipped room by 0.4 to 5°,** to floors closer to level (the floor layer
  left tilted by 0.01 to 0.15°, where the old search left 0.2 to 1.3°), and with it every
  collision number (SCHEMA g33, then g34 after review fixes; the baseline above). Counter's walkable-from-spawn fell
  44.7% → 40.9% (against the g32 baseline; the g31 table had 44.2%): its worktop is more level (0.99° → 0.59°) but part of it split off as its
  own surface. Not traced further.
- **Curled Up Dog has no floor** (a dog on a blanket): many nearly flat patches compete,
  and the result still varies by up to 6° from one set of splats to another (the old search
  varied by 3°).

**The collision is very sensitive to the room's exact placement.** Tipping Playroom's old
levelling 0.45° further cut its walkable-from-spawn from 54% to 28% (holes 4% → 19%): a
big floor a fraction of a degree off level crosses the voxel layers and breaks up. And
moving a room up by a quarter or half a grain, with no change of angle, moved "mesh
bumpiness" by up to 25% (Counter 0.130 → 0.099, Playroom 0.077 → 0.093) while walkable
area and holes did not move: bumpiness mostly measures how surfaces line up with the
voxel grid. A change that moves a room at all will move bumpiness; read it with that in
mind (open: a bumpiness that does not depend on the grid's alignment).

## Scan cleanup

**Two sets of splats, from one pass** (`cleanMasks` in `src/scan/clean-scan-core.ts`, on import
in a worker, and offline in `scripts/clean-scan.mjs`, which reads and cleans a `.ply` with the
same code through Vite):

- **The floater filters** pick the solid splats: opacity at least `alphaMin` (0.35), size
  under 4x the median, and in a voxel with at least `minMass` (4) of opacity among them.
- **The room box** is worked out once, from the solid splats' levelled positions: the
  1st-99th percentile across (98th up), plus 8% slack, from a little below the floor.
- **What is drawn:** every splat inside the box, solid or not. It keeps 94 to 98% of a scan.
- **What the collision is built from, and the room levelled by:** the drawn splats less the big
  floaters: those over the size cap, unless flat and solid (at most `FLAT_MAX` 0.1 as thick as
  wide, at least `SOLID_MIN` 0.5 opaque: a tile of a wall or floor). Not the opacity or density
  filters: the voxelizer already weighs each splat by its opacity and leaves thin space empty,
  and filtering first also took the faint and sparse splats walls are made of (below, "See it
  but cannot touch it"). `room.ts` builds from what is marked (`ScanSource.collision`, or the
  load worker's) and keeps it (`collisionSplats`) for a rebuild from a Debug slider, which
  otherwise rebuilt from every drawn splat. If the filters leave nothing, the box uses every
  splat.

**Why two:** measured, one filter at a time, raw against cleaned:

- **The floater filters made scans see-through** when they chose what was drawn
  (`scripts/holes.mjs`, share of the view): Living Room 0.2% raw, 25.1% cleaned; Counter
  0.2% and 8.5%. Each alone: size 10 to 15%, density 5 to 8%, faintness and the crop about
  2% each; together worse, as density was counted from what the others kept. Big splats are
  not floaters in general: in an AI-generated room 85% of those over the size cap are flat
  and solid, the tiles its walls and floors are made of (in the Mip-NeRF captures 25%).
- **But the collision is better built from what they keep.** From the crop alone, Kitchen
  was 27.4% walkable from spawn (cleaned 54.7%), 8.4% holes in its spawn surface (2.2%),
  5 surfaces nothing could reach (0); Counter 35.5% (40.9%). Living Room was as good (52.3%,
  47.7%). And in the cozy room, crop-only collision moved the ground level the game guesses
  (`groundY`) to 1.5 body heights above the floor, onto 30-cell patches, starting the
  figurine on one (0.1% walkable from spawn).
- **Without even the crop, collision fails:** raw Living Room's far-off spray stretches the
  collision's grid; it came out with 11k triangles instead of 107k and 0.5% walkable from
  spawn.
- **Speed:** the cozy room (4.7M splats) draws in 43 ms raw, 33 ms cropped to a box from every
  splat (what is drawn now crops to the solid splats' box, a little tighter), 17 ms with the old cleaning (60 fps cap; 1440 x 900 at ratio 2): the size filter
  bought that by deleting its walls. Counter and Living Room draw at the cap either way. A
  splat budget for heavy scans is a separate step (not done).

**Scans loaded by name get the two sets too.** The shipped files are the raw scans cropped to
the room (`*-crop.spz`, made with `scripts/clean-scan.mjs`), so every splat in them is drawn;
the load worker (`load-scan.worker.ts`) marks the floater-filtered ones with `cleanMasks`, and
the collision is built from those, as for an import. A scan's `floaterFilter: false` in `SCANS`
builds its collision from every splat instead:

- **Playroom:** its walls, cabinets and floor are a few large faint splats each, which the
  filters take for floaters (see "Playroom cannot be cleaned by the floater cleaner"). Its
  collision is unchanged.
- **Curled Up Dog:** its file is the old floater-stripped one, and filtering again is not a
  no-op: the size cap is a multiple of the median size, which the first pass lowered. Filtered
  again, holes in its spawn surface went from 1.1% to 5.8%.

Measured, the new files against the old floater-stripped ones (`*-clean.spz`):

| | Living Room | Counter | Kitchen |
|---|---|---|---|
| See-through, share of the view (`holes.mjs`) | 25.1% → 2.3% | 8.5% → 2.0% | 25.6% → 12.1% (raw 15.1%) |
| Visible splats with no collision near | 7.9% → 9.8% | 10.6% → 14.5% | 13.4% → 18.5% |
| Walkable from spawn | 47.7% → 52.5% | 40.5% → 33.0% | 54.4% → 52.8% |
| ...and by jumping or dropping | 99.7% → 96.9% | 72.6% → 96.3% | 95.0% → 95.1% |
| Holes in the spawn surface | 1.6% → 2.5% | 8.8% → 10.6% | 2.2% → 1.4% |
| Real platforms nothing reaches | 0 → 0 | 0 → 0 | 0 → 0 |

"Visible splats with no collision near" counts what is drawn, which is now far more (the old
files had dropped the faint and big splats from both), so it rises; against the same drawn
splats, the collision built from all three floater filters left 15.7%, 21.8% and 25.6% (see
below). Walkable from spawn falls on Counter and Kitchen because more of what is seen is solid:
objects now split the floor the figurine starts on.

**See it but cannot touch it.** With the floater filters choosing the collision, a quarter of
Kitchen's visible splats had no collision near them, mostly on walls. Of those uncovered splats,
left out as faint 24-28%, as sparse 25-31%, as too big 10-14%, and kept but given no surface by
the voxelizer 33-35%. One filter off at a time (Living Room / Counter / Kitchen, visible with no
collision near, then reach with jumps):

| | Uncovered | With jumps |
|---|---|---|
| All three filters | 15.7 / 21.8 / 25.6% | 100 / 97.3 / 89.9% |
| No opacity filter | 14.1 / 18.5 / 21.8% | 97.1 / 95.3 / 98.3% |
| No size filter | 14.6 / 19.0 / 24.1% | 99.8 / 75.2 / 80.7% (Kitchen: 6 surfaces nothing reaches) |
| No density filter | 11.0 / 17.4 / 23.2% | 98.9 / 96.6 / 98.0% |
| Size filter alone | 9.0 / 14.3 / 17.3% | 96.7 / 96.8 / 94.1% |
| Size filter alone, flat solid big splats kept (what is used) | 8.5 / 12.8 / 16.9% | 97.7 / 96.9 / 94.9% |

(Those runs also worked the room box out from the same filters; with the box from all three,
as used, it is 9.8 / 14.5 / 18.5%.) The size filter is what keeps the collision whole: big round
splats in the captures make solid lumps in mid-air. What is left uncovered (8 to 18%) is now
mostly the voxelizer's: 54 to 70% of it is splats in the collision set that made no surface (thin
surfaces under its density threshold). Not fixed yet.

In the cozy room (Record Player Table), nearly all its big splats are flat and solid, so its
collision takes almost every splat (4,222,712 of 4,250,407): its floor gained a fifth more
walkable cells, and the top of its ceiling, 22 body heights up, became one walkable surface of
5,623 cells, which "with jumps" counts (87.5% → 70.3%) though nothing in the room was lost
(climbing reaches 100%). Visible with no collision near: 7.2%.

**Costs:** loading (to the room arriving, headless): Kitchen 1.5-1.7 s → 1.8 s, Record Player
Table 8.5 s → 9.5 s. Files: about twice the size (Kitchen 3.1 → 5.6 MB; Record Player Table
39.4 → 63.9 MB). Drawing: Record Player Table 16.6 ms → 31.7 ms a frame (4.25 million splats
against 2.66); the others draw at the 60 fps cap either way. A splat budget for heavy scans is
a separate step (not done).

Notes:

- It levels with `orientScan`, the seeded fit the room itself is placed with, so the
  same file is always cleaned the same way (with its own unseeded copy of the fit, the
  same import kept a different number of splats each time).
- Playroom (`room2.ply`) is not pre-cleaned: see "Playroom cannot be cleaned by the
  floater cleaner" (about the floater filters; the crop alone was not tried on it).
- Kitchen and Counter are tabletop scans, not walk-around rooms. Living Room and
  Playroom are the real rooms.
- The ground level the game guesses (`groundY`) was fragile: counted near the scan's
  centre, it moved 1.5 body heights with the splats it was built from (above). It is now
  counted over the whole scan ("The ground", above).

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
