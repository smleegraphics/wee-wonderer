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
| `src/main.ts` | App, controller (`updateController`, `navMove`), climb state machine, follow camera, Debug panel |
| `src/collision.ts` | `MeshCollision` (three-mesh-bvh over the collision mesh) and `NavGrid` (walkable cells) |
| `src/voxelize-core.ts` (+ `.worker.ts`, `voxelize.ts`) | Splat → density field → collision surface |
| `src/voxel-cache.ts` | IndexedDB cache of the built surface. **Bump `SCHEMA` when the surface algorithm changes.** |
| `src/orient-scan.ts` | Levels the floor and yaw-aligns walls to X/Z (seeded, deterministic) |
| `src/clean-scan-core.ts` (+ worker), `scripts/clean-scan.mjs` | Floater removal, in-browser and offline |
| `src/climb-side-anim.ts` | Sideways-climb animation generated from the `climb` clip |

## Testing without a human

Visual and behavioural checks run headless in real Chrome through Playwright.

- **Screenshot:** `node scripts/shot.mjs "<url>" out.png <waitMs>`. Playroom takes
  about 3 s to build collision; use a wait of 18000 or more.
- **See the collision mesh:** `?meshonly=1` hides the splat and draws the mesh solid
  and lit. `?voxel=1` (or `V`) overlays it as a wireframe.
- **Frame a region:** `?az=&el=&dist=&cx=&cy=&cz=` parks a fixed orbit camera
  (`dist` in `TARGET_RADIUS` units). Without it the camera follows the figurine.
- **Read internal state:** `window.__dbg` is refreshed every frame (state, position,
  climb facing, camera distances). `window.__wwReady` is set once the first frames
  have rendered.
- **Telemetry:** `?tel=1` logs `CLIMB-*` events to the console and adds
  `__dbg.probe`.
- **Drive it:** press keys with Playwright and poll `__dbg`. Do not judge movement
  from screenshots alone.
- **Blind walks rarely reach walls.** Holding one key from spawn usually ends at a
  walkable-area edge. Counter and Kitchen have climbable objects near spawn;
  Playroom and Living Room mostly need a human to aim at a wall.
- `scripts/climbtest.mjs` is stale (it polls `window.__ww`, which does not exist).

## Conventions

- **Debug tunables go in the on-screen Debug panel** (`addToggle` / `addSlider` in
  `setupDebugMenu`), not new URL params. Collision sliders set `VOXEL_OPTS` and call
  `rebuildCollision()`.
- **The controller talks to collision only through the `Collision` interface**, so
  backends stay swappable.
- **Standing on something means the NavGrid says so.** Movement is confined to
  validated walkable cells; the raw mesh is used for walls and probes, not for
  deciding where the figurine may stand.
- Scans are scaled to `TARGET_RADIUS`, so distances are in normalized scan units,
  not metres. Express sizes relative to `charH`.

## Code review

When reviewing a change here, look for these, in this order:

1. **Regressions.** There is no unit-test suite, so reading the diff is not enough.
   Drive the app (see "Testing without a human") and check the rules listed in the
   relevant `context/` doc still hold. For anything touching movement or climbing,
   the invariant is that `__dbg.probe` never shows a `B` while climbing.
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
   URL-param tunables that belong in the Debug panel.

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
