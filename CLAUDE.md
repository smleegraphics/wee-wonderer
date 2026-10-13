# Wee Wonderer

Cozy browser toy: a tiny rigged figurine explores a Gaussian-splat scan of a real
room (walk, run, jump, climb). three.js on WebGPU. The current arc is reliable
movement on casual phone-quality scans, with collision derived automatically from
the splat.

Vision and build log live in `context/` (`project-charter.md`, `magic-test-plan.md`).
The two docs below are the ones to read before touching movement.

## Read before you work on...

- **Collision mesh, voxelizer, floor, walls, scan cleanup** → `context/collision.md`
- **Climbing, jumping onto walls, the follow camera, climb animation** → `context/climb.md`
- **Lights, the environment map, the contact shadow, rendering the splats from another camera** → `context/lighting.md`
- **Filling see-through ground with extra splats, or measuring how see-through a scan is** → `context/splat-fill.md`
- **Anything on screen that is not the 3D view: tiles, cards, the Debug card, title and loading screens, fonts, colours** → `context/ui.md`

## Commands

```bash
npm run dev        # Vite dev server, http://localhost:5173 (needs a WebGPU browser)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production bundle
```

Scans are not in the repo (`public/*.ply` is gitignored). `?scan=<file>` picks one;
the default is `room2.ply` (Playroom). Cleaned demo scans are `*-clean.ply`.

## Where things are

| File | What it holds |
|---|---|
| `src/main.ts` | App, controller (`updateController`, `navMove`), climb state machine, follow camera, the list of Debug tunables (`setupDebugMenu`) |
| `src/ui/` | The on-screen UI: `hud.ts` (tiles, cards, screens), `debug-panel.ts`, `paper.ts` (building blocks), `ui.css` (all styles and tokens) |
| `src/collision.ts` | `MeshCollision` (three-mesh-bvh over the collision mesh) and `NavGrid` (walkable cells) |
| `src/voxelize-core.ts` (+ `.worker.ts`, `voxelize.ts`) | Splat → density field → collision surface |
| `src/room-reveal.ts`, `src/loading-scene.ts`, `src/paper-bits.ts`, `src/paper-figurine.ts` | How a room arrives after loading (the scan's points start as a sheet of paper dots and rise to their places, in the scan's shader), the stand-in dots before it has loaded, the formulas both share, and the figurine's paper look meanwhile |
| `src/three-internals.ts` | Every private part of three.js the app touches (`GaussianSplat`'s fields, the renderer's material conversion); check it on a three.js upgrade |
| `src/load-scan.worker.ts` | Fetches and parses a scan's `.ply` off the main thread |
| `src/worker-call.ts` | `workerCaller`: promise-based request/response for all three workers (a failed job rejects) |
| `src/voxel-cache.ts` | IndexedDB cache of the built surface. **Bump `SCHEMA` when the surface algorithm changes.** |
| `src/fill-scan-core.ts` (+ `.worker.ts`) | Walkable gap fill: flat splats added where the ground the figurine can stand on lets the backdrop through |
| `src/orient-scan.ts` | Levels the floor and yaw-aligns walls to X/Z (seeded, deterministic) |
| `src/clean-scan-core.ts` (+ worker), `scripts/clean-scan.mjs` | Floater removal, in-browser and offline |
| `src/collision-health.ts` | The collision health numbers, for `scripts/collisioncheck.mjs` (loaded only under `?tel=1`) |
| `src/climb-side-anim.ts` | Sideways-climb animation generated from the `climb` clip |

## Testing without a human

Visual and behavioural checks run headless in real Chrome through Playwright.

- **Screenshot:** `node scripts/shot.mjs "<url>" out.png <waitMs>`. Playroom takes
  about 3 s to build collision; use a wait of 18000 or more.
- **See the collision mesh:** `?meshonly=1` hides the splat and draws the mesh solid
  and lit. `?voxel=1` (or `V`) overlays it as a wireframe.
- **Frame a region:** `?az=&el=&dist=&cx=&cy=&cz=` parks a fixed orbit camera
  (`dist` in `TARGET_RADIUS` units). Without it the camera follows the figurine.
- **Telemetry and internal state:** `?tel=1` logs `CLIMB-*` events to the console
  and publishes `window.__dbg` every frame (state, position, climb facing, camera
  distances, `probe`, and `reveal`: how much of the room is in place, 0 while
  waiting and 1 once it has arrived). Without `?tel=1` there is no `__dbg`. `window.__wwReady` is
  always set once the first frames have rendered.
- **UI regression check:** `node scripts/uicheck.mjs` runs 23 checks of the title,
  keys, tiles, Debug card, loading view, room switch and a failed load, and exits
  non-zero on a failure. Run it after any change under `src/ui/` or to loading.
- **Gap measurement:** `node scripts/holes.mjs <scan> [outDir]` counts the pixels the
  scan leaves see-through from 16 cameras inside the room, and what is behind them.
  Playroom must stay at 0. It drives `window.__matte` (`?tel=1`), which shows the scan
  or the solid collision mesh alone over a chosen backdrop, with the gap fill faded.
  It cannot judge the fill: for that, compare fill off and on by eye
  (`context/splat-fill.md`).
- **Collision health check:** `node scripts/collisioncheck.mjs` measures each demo
  room's collision as ground for a game (how much of the walkable area the figurine can
  reach, how ragged it is, how closely the mesh fits the splats) and fails if a number is worse than
  `scripts/collision-baseline.json`. Run it after any change to the voxelizer, its
  settings or the NavGrid; `--save` a new baseline when a change is meant to move one,
  and `--with key=value` tries a setting without saving.
- **Climb regression check:** `node scripts/climbfuzz.mjs <scan> <seconds> <seed>`
  walks, jumps and climbs at random and reports any frame where the climber is
  inside a solid. Run a few seeds, at most three browsers at a time.
- **Drive it:** press keys with Playwright and poll `__dbg`. Do not judge movement
  from screenshots alone. `scripts/drive.mjs` also clicks UI by name: `tile:Debug`,
  `room:Kitchen`, `range:Isovalue (fill)=0.4`.
- **The title screen** shows on a first visit and takes the keyboard. The scripts
  dismiss it up front; a Playwright script of your own must set
  `localStorage['ww.titleSeen'] = '1'` before load (see `context/ui.md`).
- **Blind walks rarely reach walls.** Holding one key from spawn usually ends at a
  walkable-area edge. Counter and Kitchen have climbable objects near spawn;
  Playroom and Living Room mostly need a human to aim at a wall.

## Conventions

- **Debug tunables go in the on-screen Debug card** (`addToggle` / `addSlider` on a
  section in `setupDebugMenu`), not new URL params. Collision sliders set `VOXEL_OPTS`
  and call `rebuildCollision()`; gap-fill sliders set `WALK_FILL` and call
  `refillWalkable()`.
- **`main.ts` does not build UI.** It talks to the `hud` handle; DOM and styles live
  in `src/ui/`, and every colour, font and size is a token in `ui.css`.
- **The controller talks to collision only through the `Collision` interface**, so
  backends stay swappable.
- **Standing on something means the NavGrid says so.** Movement is confined to
  validated walkable cells; the raw mesh is used for walls and probes, not for
  deciding where the figurine may stand.
- **A scan's splat arrays hold more than the scan.** Fill splats follow the scan's
  own. Collision, orientation and anything else that reasons about the room use the
  first `own` only (see `showSplat`).
- **The gap fill follows the walkable cells.** It runs after collision and again
  whenever `rebuildPlatformOverlay` rebuilds them; nothing else decides where it goes.
- Scans are scaled to `TARGET_RADIUS`, so distances are in normalized scan units,
  not metres. Express sizes relative to `charH`. Collision's own settings are in
  grains (`GRAIN`, the voxel size they were tuned at), never in cells of the grid in
  use: see `context/collision.md`.
- **Bump `SCHEMA` on any change to how the collision mesh is built**, not only to its
  settings: a browser that has cached a room keeps showing the old mesh, and the
  headless checks, which start with an empty cache, will not notice.

## Code review

When reviewing a change here, look for these, in this order:

1. **Regressions.** There is no unit-test suite, so reading the diff is not enough.
   Drive the app (see "Testing without a human") and check the rules listed in the
   relevant `context/` doc still hold. For anything touching movement or climbing,
   run `scripts/climbfuzz.mjs`; it must report no violations.
2. **Bandaids.** A fix must address why the bug happens. Flag special cases,
   tolerances and early-returns that hide a symptom, and any fix whose comment
   cannot state the root cause.
3. **Hard-coding.** Sizes and distances should be relative to `charH`, the capsule
   radius or the nav step, with a reason. Flag bare numbers, per-scan or per-object
   special cases, and thresholds repeated in more than one place.
4. **Architecture and cleanliness.** One place for each decision (for example, all
   climb wall probes go through `climbWall`). Flag duplicated logic, state that two
   systems both write, functions doing several jobs, and comments that no longer
   match the code.
5. **Debug leftovers.** Console output and measurement code must be gated behind
   `?tel=1` and worth keeping. Remove temporary instrumentation, stale scripts and
   URL-param tunables that belong in the Debug card.

Project-specific checks:

- No allocations in per-frame paths (`updateController`, `climbUpdate`,
  `updateCamera`, the render loop). Reuse module-level scratch vectors.
- `SCHEMA` in `src/voxel-cache.ts` is bumped if the collision surface changes.
- The controller still reaches collision only through the `Collision` interface.
- `npm run typecheck` and `npm run build` pass.

Report findings before changing anything, most severe first, each with the file
and line, what goes wrong, and the root cause.

## Keeping this useful

When you finish a feature, update this file and the relevant `context/` doc with
what the next agent would need: new invariants, gotchas that cost time, things that
were tried and failed, and known limitations. Leave out branch and PR status (git
has it) and step-by-step debugging history (the PR description has it).
