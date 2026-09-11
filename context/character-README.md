# Mini Figurine — Character Handoff

Rigged, animated character for the browser splat-explorer prototype.
Sam → Nima, July 2026. Sam is offline until ~July 24; everything Nima
needs to build the controller against should be in this folder.

## Files

- `character.glb` — the character. Rig + 2 skinned meshes (body, eye) + 6 clips.
- `character-test-harness.html` — three.js viewer + reference controller.
  Serve this folder (`npx serve` / `python -m http.server`) and open it; it
  auto-loads `character.glb`. Or open the file directly and drag the GLB on.
  The harness code demonstrates the intended AnimationMixer setup: crossfades,
  loop modes, the jump state machine, and edge-fall handling.

## Clip contract

| clip        | duration | playback | notes |
|-------------|---------:|----------|-------|
| idle        |   9.93 s | loop     | |
| walk        |   1.10 s | loop     | |
| run         |   0.53 s | loop     | |
| climb       |   0.77 s | loop     | hold while ascending/descending; controller owns vertical motion |
| jump_start  |   0.20 s | play once| crouch → liftoff; apply jump velocity when it finishes |
| jump_loop   |   0.03 s | loop     | held apex pose (~1 frame by design); repeats for arbitrary airtime; **also the falling animation** when walking off edges (skip jump_start in that case) |

- **No `jump_land` — intentional.** On touchdown, crossfade `jump_loop` →
  `idle`/`walk` over ~0.25 s. Landing is a blend, not a state.
- One-shots need `setLoop(THREE.LoopOnce, 1)` **and** `clampWhenFinished = true`
  (otherwise the pose snaps back to frame 0 on finish). Loop flags don't exist
  in glTF — this table is the source of truth.
- Clips animate **bones only**; the controller owns the object transform
  (position, facing). Never let animation and controller both write the root.

## Rig / conventions

- Skeleton: Mixamo-standard bone names **without** the `mixamorig:` prefix
  (`Hips`, `Spine`, `Neck`, `RightHand`, …). 31 joints.
- Keyframes are dense-sampled at 30 fps (deliberate — predictable data;
  compress with gltf-transform/gltfpack later if size ever matters).
- Scale: exported at Mixamo-ish scale. Measure the true height at load
  (the harness HUD shows it — note: never trust a skinned mesh's static
  bounding box; measure posed skinned vertices, see `measureSkinnedBounds`
  in the harness) and normalize in code:
  `model.scale.setScalar(TARGET_HEIGHT / measuredHeight)`.
  Game convention: 1 unit = 1 m, character ≈ 0.12 m tall.
- Walk was authored to read right at ~1.6 char-heights/s, run at ~4.0
  (see `TUNE` in the harness); match controller speed to cadence or feet slide.

## Things to verify / known state

- **climb orientation**: climb's source clip had an unusual authoring
  orientation; if it plays rotated relative to the wall, the fix is rotating
  the Hips keys in the source .blend — flag it for Sam rather than hacking
  around it in code.
- Run/idle may have minor limb clipping on the chibi proportions
  (Mixamo retarget artifacts) — known, polish scheduled post-trip.

## ⚠ Source .blend warning — read before re-exporting

`character.glb` was **cleaned after export**. The source .blend still contains
Mixamo import residue: each Action carries object-level transform channels
(a channel group named like `BaseMesh_Chibi.001` above the `Hips` group) that
animate the whole armature object, each to a different orientation. A raw
export from the .blend will reproduce per-clip tilting/drifting.

Before any future export, in the .blend, for each Action (NLA strip → Tab to
enter tweak mode): select **only** the `BaseMesh_Chibi.00x` channel group
header in the Action Editor and X → Delete Channels. Then set the armature
object to Rotation X=90°, Y=0, Z=0, Location (0,0,0), keep Scale 0.010, save.
Equivalent one-shot script (Scripting tab → Text Editor → Run):

```python
import bpy
for action in bpy.data.actions:
    for fc in list(action.fcurves):
        if not fc.data_path.startswith('pose.bones'):
            action.fcurves.remove(fc)
```

Verify: armature's transform fields turn gray (not yellow) = fixed.

## Attribution

Character base mesh: "Free Pack Chibi Base Mesh Rigged" by PolyOne Studio
(Sketchfab), CC Attribution. Animations retargeted via Mixamo.
