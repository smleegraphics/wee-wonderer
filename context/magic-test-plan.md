# Magic-Test Plan — Wee Wonderer

*Written 2026-09-11. The plan to reach the MAGIC QUESTION: does a tiny figurine
on ONE real scanned scene actually feel magical? Everything here serves that
gate; the two long poles (auto-collision, arbitrary user splats) stay off the
critical path.*

> **Pivot (2026-09-11).** Original plan built the magic test on **splatlight**
> (Sam's hand-rolled WebGPU splat renderer) integrated as a separate render pass
> so we'd keep its **dynamic relighting**. Two things changed that:
> 1. Making splats occlude / be occluded by three.js meshes from an *external*
>    pass proved unreliable — you can't cleanly share three's WebGPU depth buffer
>    from outside its pipeline (confirmed with a depth probe: the depth we could
>    reach was empty).
> 2. **Relighting was dropped** — it isn't needed for a traversal toy.
>
> With relighting gone, there's no reason to run a custom renderer at all. We now
> use **three.js's native `GaussianSplat`** (WebGPU/TSL, shipped in r186). Splats
> become a real three.js object that shares three's depth buffer, so mesh↔splat
> occlusion is **free and correct**. The whole occlusion problem was solved by
> deletion. splatlight stays as Sam's standalone learning project; it's no longer
> Wee Wonderer's renderer.

---

## Architecture (current)

Everything lives inside three.js on its WebGPU backend. No custom renderer, no
separate passes, no depth sharing tricks.

- **Host / renderer:** three.js `WebGPURenderer` (r186+). Owns device, canvas,
  loop, camera + controls, lights, the glTF character + AnimationMixer, the
  collision seam — **and** the splat scan.
- **Splat scan:** three's native **`GaussianSplat`** object (`three/addons/objects/GaussianSplat.js`),
  loaded via **`GaussianSplatPLYLoader`** (`.ply` works directly; `.spz`/`.splat`
  loaders also ship). It's a `Mesh` you `scene.add()`; it self-sorts via a TSL
  compute `CountingSort` and shares three's depth buffer.
- **Occlusion:** native. The splat material is `transparent`, `depthTest: true`,
  `depthWrite: false`; three draws opaque geometry first, so meshes occlude
  splats and splats-in-front draw over meshes — both directions correct, verified.
- **No relighting.** Flat SH0 splat color, as the native renderer provides.

---

## Scope guardrails

**In scope (MVP-ready):** load one chosen splat, render it in the real shell,
hold framerate with the character on top, correct occlusion (native), the
figurine traversing one curated demo scan via hand-authored collision.

**Explicitly OUT:** relighting, automatic collision (heightfield / WebGPU
voxelizer), arbitrary user splats, import cap, floor detection, scale slider,
multiple scans. Anything that isn't the magic question.

---

## Milestones (the magic question is the gate)

### M0 — `wee-wonderer` repo + WebGPU shell ✅ DONE
- Vite + TS + three.js on `WebGPURenderer`; orbit camera, lights, reference grid.
- Private GitHub repo `smleegraphics/wee-wonderer`; `context/` holds the project
  docs. Screenshot tooling (`scripts/shot.mjs`, headless Chrome via Playwright)
  for self-serve visual verification.

### M1 — Native splat rendering + occlusion ✅ DONE
- Upgraded three `0.169 → 0.186`; render the scan with native `GaussianSplat` +
  `GaussianSplatPLYLoader`. Single-three-instance Vite alias (`three` →
  `three/webgpu`) so lights/materials work.
- **Verified:** an opaque box occludes the splats correctly where it's in front,
  and the splats draw over it where they're in front — native shared depth, no
  hacks. *(Replaces the old splatlight-integration M1 + M3, now abandoned.)*

### M2 — Character + controller *(next)*
- Load `character.glb`; wire AnimationMixer to the clip contract (jump_start
  `LoopOnce`+clamp, jump_loop as held apex, crossfade landing, edge-fall →
  jump_loop). Bones use Mixamo names without the `mixamorig:` prefix.
- **Port** the harness's controller state machine + `groundHeightAt()` /
  `resolveWallCollision()` seam onto this shell.
- Nail the **world contract** (below) so the ~0.12 m figurine stands on the
  scanned floor at y=0.
- **Done:** figurine idle/walk/run/jump/climb on a flat test box+plane, on
  WebGPU, framerate fine, correctly occluded by/against the splat scan.
- **Blocker:** `public/character.glb` isn't in the repo yet — copy it from the
  character handoff folder.

### M3 — Hand-authored collision → answer the magic question
- Author floor + a couple furniture-height boxes to match one curated demo scan,
  plugged into the existing collision seam.
- **Done — THE MAGIC QUESTION:** the figurine runs / hops / climbs on the real
  scanned scene, correctly occluded. *Does it feel magical?*

---

## World contract (nail in M2)

The single coordinate agreement between the splat scan and the controller:

- **Up:** Y-up. **Units:** 1 unit = 1 m. **Origin:** scanned floor at y = 0.
- **Character:** ≈ 0.12 m tall; measure at load (posed skinned bounds — never the
  static bounding box), normalize `scale = TARGET_H / measuredH`.
- **Scan:** orientation (flip-up / COLMAP convention) + scale + offset resolve
  *into* this frame. Get it wrong → the figurine floats or sinks.

---

## Risks

1. ~~**Shared-depth occlusion of a transparent splat field**~~ — **RETIRED.**
   Native `GaussianSplat` shares three's depth buffer; occlusion verified.
2. **Scan orientation / metric scale** — capture apps are only roughly metric and
   disagree on up-axis; the demo scan is curated, so fix orientation + scale once
   by hand (no scale slider in MVP). This is the main M2 fiddle now.
3. **Framerate with a few-million-splat scan + character** — native `CountingSort`
   is GPU compute, should be fine; if a large real scan struggles, Spark
   (sparkjs.dev) is the drop-in upgrade with LOD/streaming.

---

## Immediate next actions

1. Get `public/character.glb` into the repo.
2. M2: load the character, wire the AnimationMixer + controller, port the
   collision seam, and lock the world contract on the demo scan.
3. Then M3: hand-author collision for one scan and answer the magic question.

---

## Reference

- Native splat renderer: `three/addons/objects/GaussianSplat.js`,
  `three/addons/loaders/GaussianSplatPLYLoader.js` (three r186+).
- Alternative if a big scan needs LOD/streaming: **Spark** (sparkjs.dev).
- Character animation contract + pipeline landmines: `context/character-README.md`,
  `context/technical-notes.md`.
