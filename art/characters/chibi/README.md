# Chibi: source

`chibi.blend` holds the Chibi's model and the clips made for this project, and nothing else: its
other clips are Mixamo's, whose terms do not allow their raw files to be passed on, so they are
left out (they ship only inside `public/characters/chibi.glb`, as before).

- **Model:** "Free Pack – Chibi Base Mesh (Rigged)" by PolyOne Studio, CC BY 4.0 (`CREDITS.md`,
  `context/character-README.md`).
- **`land`** (the action `land_chibi`, exported on an NLA track named `land`): 8 frames at 24 fps,
  played once on a hard landing. Its legs are kept exactly as in its idle, so its feet stay on the
  ground; the landing is in the upper body, with no rebound (one read as bouncy): arms a little
  forward and out at touchdown, a 10° lean and a 6° nod with the arms partly down at frame 3,
  easing into its idle at frame 7. Arms are
  posed by where their joints are (shoulder to elbow, elbow to wrist): on this imported rig the
  bones' own direction does not follow the limb. Made for this project.

Tried and dropped: squash from the hips (on this rig a scale on the hips made it taller, not
shorter) and a crouch with the knees bent by Blender's IK (it moved the feet off the ground even at
rest). To put a clip from here into the game, follow `art/characters/poppy/README.md`.
