# Wee Wonderer

A cozy browser toy where a tiny figurine explores a Gaussian-splat scan of a real
space — walking, running, jumping, and climbing around your actual furniture.

Built on **three.js (WebGPU)**. The scan is rendered with three's native
`GaussianSplat`, so the figurine shares the scan's depth buffer and is occluded
by real geometry. Scans are **auto-leveled at load** — drop in any `.ply` and it
orients itself.

**Project context lives in [`context/`](./context/)** — start with
`project-charter.md` (vision) and `magic-test-plan.md` (build log & decisions).
Working notes for agents are in [`CLAUDE.md`](./CLAUDE.md), with `context/collision.md`
and `context/climb.md` for the movement systems.

## Controls

- **WASD** move · **Shift** run · **Space** jump
- **Climb:** walk (or jump) into a wall. **W/S** up/down, **A/D** sideways, **Space** jumps off
- **Mouse drag** orbit the camera · **scroll** zoom (camera follows the figurine)

## Develop

```bash
npm install
npm run dev        # Vite dev server — needs a WebGPU browser (Chrome/Edge/Safari 2024+)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production bundle
```

### You need a scan

Scans are **not** in the repo (they are tens to hundreds of MB), so `scans/` is
gitignored. To run locally:

1. Put a Gaussian-splat `.ply` in `scans/` (standard 3DGS format — a Scaniverse
   or Luma export, or a pretrained scene). The dev server serves it at `/scans/`.
2. Open `http://localhost:5173/?scan=yourscan.ply`, or add it to `SCANS` in `src/scan/scan-list.ts`.
   The default is `kitchen-clean.spz`.

Which scans ship publicly, and why, is in [`CLAUDE.md`](./CLAUDE.md) ("Which scans
ship"); how they are hosted is in [`context/deploy.md`](./context/deploy.md).

The character asset **`public/character.glb`** _is_ committed (rigged chibi, 6
clips; contract in `context/character-README.md`).

## How it works

- **`src/scan/orient-scan.ts`** — `orientScan(positions)` levels any scan: robust
  recenter + a RANSAC floor-plane fit (largest near-horizontal surface, robust to
  floaters / furniture / stairwells) → floor normal to +Y, floor dropped to y=0.
  No per-scan constants; the same code levels a demo scan or your own.
- **`src/main.ts`** — puts the app together and runs the frame loop. The parts are
  in folders by job (`scan/`, `collision/`, `figurine/`, `lighting/`, `loading/`,
  `ui/`); CLAUDE.md ("Where things are") lists what each file holds.

### Tooling

- **`inspect.html`** (`src/dev-pages/inspect-room.ts`) — a scan inspector: loads a scan (`.ply` or `.spz`),
  auto-levels it, and shows it against a y=0 grid. `?file=…&ca=&ce=&cd=`.
- **`scripts/shot.mjs`** / **`scripts/drive.mjs`** — headless Chrome (Playwright)
  screenshotting and keyboard/mouse driving, for verifying the 3D app from the
  command line.

## Status

**v1.0**, live at **https://wee.samanthamlee.com**.

- Four example scans: Kitchen, Living Room and Counter (Mip-NeRF 360) and Curled Up
  Dog (Samantha Lee's own capture), served as SPZ from a scan host (`context/deploy.md`).
- Walk, run, jump and climb, on collision built automatically from the splats
  (`context/collision.md`, `context/climb.md`).
- The figurine is lit from the scan itself and casts a contact shadow into it
  (`context/lighting.md`).
- Import your own scan (`.ply` or `.spz`): it is cleaned in your browser and never uploaded.

Known limits: keyboard only (no touch controls yet); best in a WebGPU browser
(elsewhere three.js falls back to WebGL2); a casual phone scan with heavy floaters
gives rougher collision than the example scans.
