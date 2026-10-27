# Wee Wonderer

Cozy browser toy: a tiny rigged figurine explores a Gaussian-splat scan of a real
room (walk, sprint, jump and double-jump, climb). three.js on WebGPU. The current arc is reliable
movement on casual phone-quality scans, with collision derived automatically from
the splat.

Vision and build log live in `context/` (`project-charter.md`, `magic-test-plan.md`).
The two docs below are the ones to read before touching movement.

## Read before you work on...

- **Collision mesh, voxelizer, floor, walls, scan cleanup** → `context/collision.md`
- **Walking, sprinting, jumping, abilities (the double jump), the movement settings, characters and their animation** → `context/movement.md`
- **Climbing, jumping onto walls, the follow camera, climb animation** → `context/climb.md`
- **Lights, the environment map, the contact shadow, rendering the splats from another camera** → `context/lighting.md`
- **Filling see-through ground with extra splats, or measuring how see-through a scan is** → `context/splat-fill.md`
- **Frame rate, or anything that changes how much the graphics card draws** → `context/frame-time.md`
- **Where scans are served from, the scan host, uploading scans, deploying** → `context/deploy.md`
- **Anything on screen that is not the 3D view: tiles, cards, the Debug card, title and loading screens, fonts, colours** → `context/ui.md`

## Commands

```bash
npm run dev        # Vite dev server, http://localhost:5173 (needs a WebGPU browser)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production bundle
```

After `npm install` (or any lockfile change), restart a running dev server: until then it
answers 504 "Outdated Optimize Dep" for three.js and the app does not start.

Scans are not in the repo: they live in the gitignored `scans/` folder, which the dev and
preview servers serve at `/scans/` (never `public/`: Vite copies it into every build).
`?scan=<file>` picks one;
the default is `kitchen-clean.spz` (Kitchen). Cleaned demo scans are `*-clean.ply`; the shipped
ones are those converted to SPZ (`*-clean.spz`, `context/deploy.md`, "Scan files").

**Which scans ship.** `SCANS` in `src/scan/scan-list.ts` lists every known scan; only the
`listed: true` ones appear in the Scans card, and the first of those is the default.
The shipped scans are Kitchen, Living Room and Counter (Mip-NeRF 360, CC BY 4.0, which
needs credit) and Curled Up Dog (`Marishka-clean.spz`, our own capture). **Playroom
(`room2.ply`) is a local test scan only:** it comes from the Deep Blending dataset, whose licence is unstated, so it
is unlisted and must not be uploaded or listed. It stays in `SCANS` because the checks
below measure on it by file name and it has its own collision setting. Before listing a
new scan, record where it came from and its licence.

## Where things are

Source is grouped by job; file names are unique across folders, so a bare name is
enough to find one.

| Where | What it holds |
|---|---|
| `src/main.ts` | Puts the app together (`hudActions`), loads the default scan and the figurine, and runs the frame loop (with `__step`, the fixed-step clock for repeatable runs) |
| `src/app.ts` | What every part shares: page options (`q`, `TEL`, `MESHONLY`, `FREECAM`), `TARGET_RADIUS` and `GRAIN`, renderer, scene, `camera` (shown) and `orbitCamera` (OrbitControls' own, never drawn from; context/climb.md, "Follow camera"), orbit, `hud`, the `room` and `player` objects, `TUNE` (the climb's and camera's tunables), `move` (the keys held), `velocity`, and `figurine` (how it is moving: `state`, `supportY`) |
| `src/debug-menu.ts` | The Debug card's tunables (`setupDebugMenu`) |
| `src/telemetry.ts` | `?tel=1` only: `__dbg`, `__collisionHealth`, the matte view |
| `src/three-internals.ts` | Every private part of three.js the app touches (`GaussianSplat`'s fields, the renderer's material conversion); check it on a three.js upgrade |
| `src/worker-call.ts` | `workerCaller`: promise-based request/response for all the workers (a failed job rejects) |
| **`src/scan/`** | **Getting a scan in:** |
| `room.ts` | The room on screen: loading a scan, from the scan host (`loadScan`) or already in memory (`loadScanData`, an import), through `loadRoom` and `showScan`; the loading view and the arrival (`updateArrival`) |
| `walk-fill.ts` | Running the walkable gap fill and its view switches |
| `import.ts` | Importing a visitor's scan (`.ply` or `.spz`): cleaned in a worker started on the first import, kept by id for the Scans card and re-cleans |
| `scan-list.ts`, `scans.ts` | The example scans (`SCANS`, which are listed, `SCAN_DIR`) as plain data the Vite config and scripts also read; and `scanURL`, the one place a scan's address is decided (`VITE_SCAN_BASE`) |
| `load-scan.worker.ts`, `parse-scan.ts` | Fetches and parses a scan off the main thread; `parseScan` picks PLY or SPZ by the file's bytes, and every scan becomes one form, `ParsedScan` |
| `orient-scan.ts` | Levels the floor and yaw-aligns walls to X/Z (seeded, deterministic) |
| `clean-scan-core.ts` (+ worker), `scripts/clean-scan.mjs` | Floater removal, in-browser and offline |
| `fill-scan-core.ts` (+ worker) | Walkable gap fill: flat splats added where the ground the figurine can stand on lets the backdrop through |
| **`src/collision/`** | **Collision from the splats:** |
| `collision.ts` | `MeshCollision` (three-mesh-bvh over the collision mesh) and `NavGrid` (walkable cells) |
| `room-collision.ts` | The current room's collision: settings (`VOXEL_OPTS`, `useScanSettings`), building and rebuilding it, the walkable cells, the overlays |
| `voxelize-core.ts` (+ `.worker.ts`, `voxelize.ts`) | Splat → density field → collision surface |
| `voxel-cache.ts` | IndexedDB cache of the built surface. **Bump `SCHEMA` when the surface algorithm changes.** |
| `collision-health.ts` | The collision health numbers, for `scripts/collisioncheck.mjs` (loaded only under `?tel=1`) |
| **`src/loading/`** | **While a room loads and arrives:** `room-reveal.ts` (the scan's points start as a sheet of paper dots and rise to their places, in the scan's shader), `loading-scene.ts` (the stand-in dots before it has loaded), `paper-bits.ts` (the formulas both share), `paper-figurine.ts` (the figurine's paper look meanwhile) |
| **`src/figurine/`** | **The figurine:** |
| `character.ts` | The character's model and its moves (`play`), spawn (`resetToSpawn`, `placeFigurine`), keys |
| `characters.ts` | The characters as data: model, height, capsule width, which clip shows each move, abilities, settings (context/movement.md); `character.ts`'s `loadCharacter` swaps one in |
| `clip-pace.ts` | The speed a walk or run clip carries a character at, measured from the clip |
| `controller.ts` | Per-frame movement (`updateController`): momentum, the jump and its grace, walking off edges, the fall, wall push-out (`bodyOverlap`) |
| `movement.ts`, `abilities.ts` | The movement settings (`MOVE`, the Movement section of the Debug card) and the abilities a loadout is made of (the double jump) |
| `climb.ts` | The climb state machine (`climbUpdate`, `climbWall`, `fitClimbBody`), context/climb.md |
| `camera.ts` | The follow camera (`updateCamera`), the opening shot, the fixed debug camera |
| **`src/lighting/`** | `scan-light.ts` (the light probe and its debug view) and `contact-shadow.ts`, context/lighting.md |
| **`src/ui/`** | The on-screen UI: `hud.ts` (tiles, cards, screens), `debug-panel.ts`, `paper.ts` (building blocks), `ui.css` (all styles and tokens) |
| **`src/dev-pages/`** | Pages not part of the app: `inspect-room.ts`, the scan inspector (`inspect.html`); `character-thumbs.ts` (`thumbs.html`), which renders the Characters card's pictures for `scripts/character-thumbs.mjs` |
| `deploy/scans-worker/`, `scripts/upload-scans.mjs` | The scan host (a Worker over R2, with its own `package.json` for wrangler) and the upload of the listed scans to it |

## Testing without a human

Visual and behavioural checks run headless in real Chrome through Playwright. The scripts
test the dev server on 5173; `WW_URL=http://localhost:5174 node scripts/...` points them at
another (`scripts/app-url.mjs`). A dev server runs the code of the folder it was started in, so
from a second checkout, start its own server on another port and pass its address.

- **Screenshot:** `node scripts/shot.mjs "<url>" out.png <waitMs>`. Playroom takes
  about 3 s to build collision; use a wait of 18000 or more.
- **See the collision mesh:** `?meshonly=1` hides the splat and draws the mesh solid
  and lit. `?voxel=1` (or `V`) overlays it as a wireframe.
- **Frame a region:** `?az=&el=&dist=&cx=&cy=&cz=` parks a fixed orbit camera
  (`dist` in `TARGET_RADIUS` units). Without it the camera follows the figurine.
- **Telemetry and internal state:** `?tel=1` logs `CLIMB-*` events to the console
  and publishes `window.__dbg` every frame (state, position, climb facing, camera
  distances, `probe`, `reveal`: how much of the room is in place, 0 while
  waiting and 1 once it has arrived, and `lightView`: where the scan light's debug
  panorama is on screen while that view is on). Without `?tel=1` there is no `__dbg`. `window.__wwReady` is
  always set once the first frames have rendered.
- **UI regression check:** `node scripts/uicheck.mjs` runs 32 checks of the title,
  keys, tiles, Credits and Controls cards, Debug card, loading view, the scan light's capture at load, room switch,
  importing a scan and a failed load, and exits non-zero on a failure. Run it after any change under
  `src/ui/`, to loading, or to the scan light.
- **Gap measurement:** `node scripts/holes.mjs <scan> [outDir]` counts the pixels the
  scan leaves see-through from 16 cameras inside the room, and what is behind them.
  Playroom must stay at 0. It drives `window.__matte` (`?tel=1`), which shows the scan
  or the solid collision mesh alone over a chosen backdrop, with the gap fill faded.
  It cannot judge the fill: for that, compare fill off and on by eye
  (`context/splat-fill.md`).
- **Collision health check:** `node scripts/collisioncheck.mjs` measures each demo
  room's collision (and Marishka's, a soft scan with no flat ground) as ground for a game (how much of the walkable area the figurine can
  reach, how ragged it is, how closely the mesh fits the splats) and fails if a number is worse than
  `scripts/collision-baseline.json`. Run it after any change to the voxelizer, its
  settings or the NavGrid; `--save` a new baseline when a change is meant to move one,
  and `--with key=value` tries a setting without saving.
- **Frame time:** `node scripts/frametime.mjs [scan ...]` prints how long a frame takes
  while walking, on the real graphics card. The numbers move between runs; compare a
  change with what it replaced in the same sitting (`context/frame-time.md`).
- **Climb regression check:** `node scripts/climbfuzz.mjs <scan> <seconds> <seed>`
  walks, jumps and climbs at random and reports any frame where the climber is
  inside a solid. Run a few seeds, at most three browsers at a time. A run repeats
  exactly (same scan, seed and code, same result): it drives the figurine through
  `window.__step` (`?tel=1`), which moves it in fixed frames instead of by the clock.
  `seconds` is game time. A script that needs a repeatable run should do the same.
  `__step(keys, seconds, jump, draw)` with `draw` false works the frames out without
  drawing them, about 11 times faster: use it for anything that reads only positions.
- **Jump check:** `node scripts/jumpcheck.mjs [scan]` makes real running jumps (plain, and
  with the double jump) and fails if their height or reach is more than 10% off the
  movement model's. Run it after changing jumping, the movement defaults or the model.
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
  section in `setupDebugMenu`), not new URL params. Collision sliders (`voxelSlider`) set `VOXEL_OPTS`
  for the session and call `rebuildCollision()`; gap-fill sliders set `WALK_FILL` and call
  `refillWalkable()`.
- **A scan that changes gets a new file name.** Uploaded scans are cached as immutable
  for a year, and the collision cache is keyed by name (`context/deploy.md`).
- **A collision setting for one scan goes in that scan's `SCANS` entry**, with the reason
  and the measured cost beside it (`context/collision.md`, "Settings for one scan").
  Example scans only; never a branch on a scan's name in the pipeline. An uploaded scan
  gets the defaults, so what it needs must be measured from the scan.
- **Nothing outside `src/ui/` builds UI.** The rest talks to the `hud` handle (made in
  `app.ts`); DOM and styles live in `src/ui/`, and every colour, font and size is a
  token in `ui.css`.
- **`app.ts` imports nothing that imports it back.** It holds what every part shares, so
  it must load first: of the app's own files it imports only `ui/hud`, `scan/scans`,
  `figurine/characters` (plain data, for the Characters card) and `loading/room-reveal`, and what the HUD's controls do is filled in by `main.ts`
  (`hudActions`). A value another file reassigns lives in a shared object (`figurine`,
  `camLatch`, `MOVE`) or behind a function, since an import cannot be assigned to.
- **The controller talks to collision only through the `Collision` interface**, so
  backends stay swappable.
- **Standing on something means the NavGrid says so.** Walking moves only onto
  validated walkable cells, and a fall lands only on them; walking off their edge falls
  (onto cells below). The raw mesh is used for walls and probes, not for deciding where
  the figurine may stand.
- **Code asks for a move, never a character.** `play('fall')`, `character.climbs`, the
  loadout's abilities: nothing branches on which character is in play (context/movement.md).
- **The movement model matches the game.** What `collision-health.ts` says a jump reaches
  is checked against real jumps by `scripts/jumpcheck.mjs`; change one, run the other.
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
   run `scripts/climbfuzz.mjs`; it must report no violations. For jumping or the
   movement settings, run `scripts/jumpcheck.mjs` too.
2. **Bandaids.** A fix must address why the bug happens. Flag special cases,
   tolerances and early-returns that hide a symptom, and any fix whose comment
   cannot state the root cause.
3. **Hard-coding.** Sizes and distances should be relative to `charH`, the capsule
   radius or the nav step, with a reason. Flag bare numbers, per-scan or per-object
   special cases (other than a reasoned setting in `SCANS`), and thresholds repeated in more than one place.
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
- `SCHEMA` in `src/collision/voxel-cache.ts` is bumped if the collision surface changes.
- The controller still reaches collision only through the `Collision` interface (`collision` is typed by it, so a method missing from the interface fails the typecheck).
- `npm run typecheck` and `npm run build` pass.

Report findings before changing anything, most severe first, each with the file
and line, what goes wrong, and the root cause.

## Keeping this useful

When you finish a feature, update this file and the relevant `context/` doc with
what the next agent would need: new invariants, gotchas that cost time, things that
were tried and failed, and known limitations. Leave out branch and PR status (git
has it) and step-by-step debugging history (the PR description has it).
