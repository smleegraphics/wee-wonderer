# Magic-Test Plan — splatlight → Wee Wonderer

*Written 2026-09-11. The plan to reach the MAGIC QUESTION: does a tiny figurine
on ONE real scanned scene actually feel magical? Everything here serves that
gate; the two long poles (auto-collision, arbitrary user splats) stay off the
critical path.*

---

## Resolved architecture decision

Build the magic test on the **real production framework**, not a throwaway
scaffold. The only thing we skip is **collision generation** (hand-authored for
the demo scan instead).

- **App / host:** three.js on its **WebGPU backend** (`WebGPURenderer`, current
  three — not the harness's r160). Owns the GPUDevice, canvas, render loop,
  camera + controls, lights, the glTF character, the AnimationMixer, and the
  collision seam.
- **Renderer:** **splatlight** integrated as a **render layer inside that same
  WebGPU frame** — shared device, shared depth buffer, one camera. It
  contributes the splat pipeline + relight; three.js keeps the animation stack
  the contract is written against (`LoopOnce`+`clampWhenFinished`, crossfades).
- **Why not splatlight-native (no three.js):** it would force rebuilding glTF
  loading, skinning, and the AnimationMixer state machine in raw WebGPU — i.e.
  skipping far more than collision. Rejected.
- **Why not composite two canvases:** WebGL2 and WebGPU can't share a depth
  buffer, so occlusion ("figurine behind the chair leg") breaks. That's
  throwaway scaffolding on the real pipeline. Rejected.

**The harness is throwaway; the framework is not.** The harness's controller
logic gets *re-homed* onto the real renderer, not discarded.

---

## Scope guardrails

**In scope (MVP-ready):** load one chosen splat, render it embedded in the real
shell, hold framerate with the character on top, correct occlusion, one shared
light on both, hand-authored collision for one curated demo scan.

**Explicitly OUT:** automatic collision (heightfield / WebGPU voxelizer),
arbitrary user splats, import cap, floor detection, scale slider, relighting
polish, multiple scans, GPU radix sort. Anything that isn't the magic question.

---

## Milestones (the magic question is the gate)

### M0 — New `wee-wonderer` repo (the real shell's home)
- Create `wee-wonderer` alongside `splatlight` in `~/Documents/repos/`.
- Vite + TS. Add **current three.js** with `WebGPURenderer`.
- Depend on splatlight's render module via local path (`file:../splatlight`),
  so splatlight stays its own repo with its standalone dev harness intact.
- Seed a `context/` dir with the project docs (charter, technical-notes,
  character README, ideas-doc, this plan). Drop `character.glb` in `public/`.
- `git init`, first commit.
- **Done:** blank `WebGPURenderer` canvas clears on screen; splatlight resolves
  as a dependency.

### M1 — splatlight: app → embeddable module *(in the splatlight repo)*
- Strip the RAF loop, canvas/context ownership, orbit camera, and Tweakpane out
  of the *render path*. Expose a `SplatlightRenderer`:
  `init(device, format)` · `setCamera(viewProj, camPos)` ·
  `setLight(dir, color)` · `render(pass)`.
- Keep today's `main.ts` as a **dev harness that drives the same module**, so
  splats stay iterable in isolation.
- Cherry-pick `scene-support`'s auto-orient + perf commits; leave the
  drag-drop / arbitrary-splat commit out (post-MVP).
- **Done:** splats still render in the standalone dev harness through the new
  API; nothing in the API reaches back for a canvas or clock.

### M2 — Stand up the real shell *(replaces the throwaway harness)*
- In `wee-wonderer`: `WebGPURenderer`, PerspectiveCamera + controls, one
  DirectionalLight + hemi. Load `character.glb`; wire AnimationMixer to the clip
  contract (jump_start `LoopOnce`+clamp, jump_loop as held apex, crossfade
  landing, edge-fall → jump_loop).
- **Port** the harness's controller state machine + `groundHeightAt()` /
  `resolveWallCollision()` seam verbatim onto the real renderer.
- **Done:** character idle/walk/run/jump/climb on a flat test box+plane, on
  WebGPU, framerate fine. (Re-homing proven logic, not inventing behavior.)

### M3 — Integrate `SplatlightRenderer` into the shell *(the real spike)*
- Splats + character in one view, one camera, three's **shared depth buffer**.
- Nail the **world contract** (below): fold splatlight's auto-orient + a
  scale/offset into Y-up / meters / floor-at-y=0 so a 0.12 m figurine stands on
  the scanned floor.
- Decide the integration mechanism (TSL/NodeMaterial object vs. a custom pass on
  three's backend device) — the spike picks it.
- **Done:** co-rendered, **correct occlusion** (figurine passes behind a scanned
  object), framerate holds on the demo scan.
- ⚠️ **Load-bearing risk.** Transparent splats don't write clean depth →
  occlusion needs a depth-write policy (front-surface depth). **Timebox it.** If
  three's WebGPU maturity fights this >~a few days, *narrow* M3 (splats as
  backdrop + invisible proxy-box depth occluders, still inside the real WebGPU
  shell) — do **not** revert to WebGL compositing.

### M4 — Hand-authored collision → answer the magic question
- Author floor + a couple furniture-height boxes to match the demo scan, into
  the existing seam.
- Wire **one** shared light dir+color into both the character material and the
  splat relight ("same sun on both" — the coziness payoff, and the only
  relighting work in scope).
- **Done — THE MAGIC QUESTION:** the figurine runs / hops / climbs on the real
  scanned scene, co-lit, correctly occluded. *Does it feel magical?*

---

## World contract (nail in M3)

The single coordinate agreement between renderer and controller:

- **Up:** Y-up. **Units:** 1 unit = 1 m. **Origin:** scanned floor at y = 0.
- **Character:** ≈ 0.12 m tall; measure at load (posed skinned bounds — never the
  static bounding box), normalize `scale = TARGET_H / measuredH`.
- **Scan:** auto-orient (flip-up / COLMAP) + scale + offset resolve *into* this
  frame. Get it wrong → the figurine floats or sinks.

---

## Risks

1. **M3 shared-depth occlusion of a transparent splat field** — the thing that
   sells "he's *in* the room," and the least-proven piece. Pressure-test early.
2. **three.js WebGPU backend maturity** vs. injecting a raw splat pass. The M3
   spike is where this surfaces; the narrowed-M3 fallback covers it.
3. **Scale/metric drift** — capture apps are only roughly metric; the demo scan
   is curated, so fix its scale once by hand (no scale slider in MVP).

---

## Immediate next actions

1. Create the `wee-wonderer` repo (M0).
2. Refactor splatlight to the `SplatlightRenderer` module boundary (M1).
3. Pressure-test the M3 depth/occlusion approach before over-investing in M2
   polish — it's the risk that decides whether the architecture holds.
