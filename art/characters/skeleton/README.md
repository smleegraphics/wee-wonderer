# Skeleton: source

`skeleton.blend` holds its model and clips as imported from the game's
`public/characters/skeleton.glb`, plus the clips made here. Only those clips go back into the game
file (the same steps as `art/characters/poppy/README.md`: export by NLA tracks, copy the one clip
in by bone name, compare).

- **Model and its other clips:** `Skeleton_Minion` from
  [KayKit: Skeletons Character Pack 1.0](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0)
  by Kay Lousberg, CC0 1.0 (`CREDITS.md`).
- **`climb`:** keyed here, 20 frames at 24 fps, looping, posed by where each bone points rather
  than by axis angles. Its skull is a ball about 0.88 across above shoulders at 1.11, so an arm
  cannot reach overhead without going into it: it reaches up and out past the skull, the other arm
  pulling with its elbow bent, legs stepping against them, the spine turning 3 degrees each way.
  Checked every frame: no hand past the wall the game holds the body from (1.1 radii), no forearm
  or hand inside the skull. Made for this project.
- **`hang`** (the action `hang_skeleton`): 24 frames, looping. Both arms up and out past the skull,
  legs hanging with a little bend and swing. No arm vertex inside the skull; its upper arms rise
  from under its cloak (`art/tools/pose_check.py` counts those as inside the body).
- **`mantle`** (the action `mantle_skeleton`): 8 frames, once: press (hands planted on the ledge at
  waist height, elbows bent, leaning over them), push (arms straightening, a knee driven high with
  its foot forward onto the lip, leaning further), step up (onto that foot, the back leg following),
  its idle. Hands and feet are placed by target with `art/tools/pose_tools.py`'s two-bone solve,
  within its leg reach (0.38 from hip to ankle). Nothing in its skull on any frame.

The skull itself reaches about 0.12 past that wall line (its collision radius is 0.14 of its
height); that is its proportions, not the animation.
