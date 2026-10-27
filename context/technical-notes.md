# Technical Notes & Hard-Won Lessons

Engineering context for the project. Compiled July 2026 after the character
pipeline build. Future sessions: read this before proposing pipeline changes.

## Stack

- **Character authoring:** Blender 4.0 + Mixamo retargeting on a PolyOne
  chibi base (CC-BY, attribution required). Source: `mini_figurine.blend`
  (on Sam's machine).
- **Delivery format:** GLB, clips baked from NLA tracks. Ship file:
  `character.glb`.
- **Runtime (prototype):** three.js r160, AnimationMixer. Long-term target
  is the Splotlight WebGPU renderer; three.js harness is reference behavior.
- **Splat rendering:** Splotlight (Sam + Nima's TypeScript/WebGPU Gaussian
  splat renderer with dynamic relighting) — separate codebase, not yet
  integrated with the character work.

## The animation contract (summary — full version in character README)

idle · walk · run · climb (loops), jump_start (once), jump_loop (1-frame
HOLD — freeze via LoopOnce+clampWhenFinished, do NOT cycle it), no
jump_land by design (land = crossfade jump_loop → idle/walk ~0.25s).
Clips animate bones only; the controller owns the object transform.
Bones use Mixamo names without the `mixamorig:` prefix.

## Pipeline landmines (each of these cost real hours)

1. **Mixamo FBX residue.** Every Mixamo import carries object-level
   animation channels on the armature (a channel group named like
   `BaseMesh_Chibi.001` in the Action) that fight the controller and
   differ per clip. The source .blend still contains these — strip them
   before any re-export (instructions + script in character README).
2. **Never trust a skinned mesh's bounding box** in three.js — bind-pose
   geometry space, ignores armature transforms and pose. Also
   `applyBoneTransform()` vertex sampling returned garbage for this rig.
   **Measure bone world positions instead** (see `measureSkinnedBounds`
   in the harness). Character truth: ~45 cm tall at export scale, feet
   at y≈0.
3. **glTF has no loop flags.** Loop/once/hold intent lives only in the
   contract doc; runtime must apply it (LoopOnce needs clampWhenFinished
   or the pose snaps back).
4. **Blender Action gotchas:** unassigned Actions with no fake user are
   silently purged on save; `[Action Stash]` NLA tracks export as garbage
   clips (delete them); exporter grouping should be NLA Tracks mode;
   check "Set all glTF Animation starting at 0".
5. **Verification habit:** every export goes through the test harness
   (checklist panel = contract validator + stray-clip detector) or
   gltf-viewer.donmccurdy.com before it ships anywhere.

## The collision problem (v1's hard problem — unsolved)

Splats have no surfaces. The character needs ground height + climbable
face detection. Candidate directions (unevaluated): mesh extraction from
splats, depth-render heightfield, SDF from Gaussian density, or a
user-authored collision proxy step. The harness's `groundHeightAt()` +
`resolveWallCollision()` (AABB pushout) mark the exact swap points.
First milestone: floor + one table + one climbable face in a real scan,
feels magical.

## Controller reference (implemented in the harness)

*The game's controller has since been rewritten (states ground / air / climb, an instant
jump, no jump_start or land state): see `context/movement.md`. What follows is the July
harness, kept as history.*

State machine: ground / jump_start / air / land / climb. Edge-fall goes
straight to jump_loop (no jump_start). Climb grabs the nearest wall face,
snaps flush, W/S to ascend, mantles over the top. Contextual UI prompt
("Press C to climb") when in range — pattern to keep for the real toy.
All tuning in char-heights so it's scale-independent (TUNE block).
