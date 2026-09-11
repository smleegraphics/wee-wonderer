# Wee Wonderer

A cozy browser toy where a tiny figurine explores a Gaussian splat scan of your
real space. three.js (WebGPU backend) app; splat rendering + relight via
[splatlight](../splatlight).

**The plan and all project context live in [`context/`](./context/)** — start
with `magic-test-plan.md` (build sequence) and `project-charter.md` (vision).

## Stack

- **App / host:** three.js on `WebGPURenderer` — owns device, canvas, loop,
  camera, lights, character, controller, collision seam.
- **Renderer:** `splatlight` integrated as `SplatlightRenderer`, sharing three's
  WebGPU device + depth buffer (arrives at M3).
- Vite + TypeScript.

## Develop

```bash
npm install
npm run dev        # Vite dev server (needs a WebGPU-capable browser)
npm run typecheck  # tsc --noEmit
```

## Status

- **M0 ✓** — repo scaffold: WebGPU renderer clears a canvas with a reference grid.
- M1 — refactor splatlight into `SplatlightRenderer` (in the splatlight repo).
- M2 — port the character + controller onto this shell.
- M3 — integrate `SplatlightRenderer` (shared depth, occlusion) — the real spike.
- M4 — hand-authored collision on one demo scan → **the magic question.**

## Missing asset

`public/character.glb` is **not** in the repo yet — copy it in from the
character handoff folder (see `context/character-README.md` for the clip
contract). M2 loads it from `public/`.
