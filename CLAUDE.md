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

## Keeping this useful

When you finish a feature, update this file and the relevant `context/` doc with
what the next agent would need: new invariants, gotchas that cost time, things that
were tried and failed, and known limitations. Leave out branch and PR status (git
has it) and step-by-step debugging history (the PR description has it).
