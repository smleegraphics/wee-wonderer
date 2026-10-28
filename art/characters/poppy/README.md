# Poppy: source

`poppy.blend` holds her model and clips as imported from the game's `public/characters/mini.glb`,
plus the clips made here. Only those clips go back into the game file; her other clips are not
exported from here (Blender's import snaps Kenney's keys to its frame grid, so they come back a
frame longer).

- **Model and her other clips:** `character-female-f` from Kenney's
  [Mini Characters 1.0](https://kenney.nl/assets/mini-characters), CC0 1.0 (`CREDITS.md`).
- **`climb`:** keyed here, 20 frames at 24 fps, looping. Arms reach toward the wall in turn,
  legs step up against them, the torso turns 3° each way. Made for this project.
- **`land`:** keyed here, 8 frames at 24 fps, played once on a hard landing. Squash and stretch
  from the root, which is at her feet, so they stay on the ground: stretched at touchdown with her
  arms up, squashed (108% wide, 86% tall) with her head nodding at frame 2, a small rebound,
  her idle at frame 7. Her legs are rigid blocks: spreading them raises her body, not lowers
  it, so they stay straight. Made for this project.

- **`hang`** (the action `hang_poppy_forward`): 24 frames, looping, for hanging from a lip. Her
  arms point forward at chest height, gripping; her legs swing a little. Her head is wider than her
  rigid arms reach: every raised-arm pose put 35 to 120 arm vertices in her hair
  (`art/tools/pose_check.py`); this one leaves 12 under her hair line, which do not show.
- **`mantle`** (the action `mantle_poppy`): 8 frames, once, climbing over a lip, in the beats
  climb-over reference uses (press, push with a leg onto the lip, step up): hands planted on the
  ledge, then leaning well over with her arms pushing down and one leg swung up onto it, stepping
  through, her idle. 18 arm vertices under her hair line at frame 0 only (`art/tools/pose_check.py`).

## Putting a clip from here into the game

1. In Blender, put the clip on an NLA track of its own and export the armature and meshes as
   glTF **by NLA tracks** (exporting the active action alone merged the imported clips' tracks
   into one).
2. Copy that one clip into `public/characters/mini.glb` with gltf-transform, keyed onto her bones
   by name, so the rest of the file stays as it is; then compare the other clips with the file
   before (no change) and the new clip with the export (no change).
3. Map it in `src/figurine/characters.ts` and run the checks in `CLAUDE.md`.
