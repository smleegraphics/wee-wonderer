# Climbing

How the climb works, the rules it depends on, and what is known to be missing.
Read this before changing climbing, airborne movement, or the follow camera. All
of it is in `src/main.ts` unless noted.

## Behaviour

- Walk into a tall wall: the climb starts. No button. A wall is any surface steeper
  than the "Climb threshold" slider (70° by default).
- On the wall, W/S go up and down, A/D go along the face. A/D are the figurine's own
  left and right, never camera-relative. Diagonals combine at the same speed.
- At the top: mantle onto a walkable surface if there is one, otherwise cling.
- Walk off a ledge with a sheer face: grab the lip, hang facing the wall.
- Jump into a wall: grab it at that height.
- Space jumps off, away from the face.

## Structure

One state (`state === 'climb'`) with `climbDir` as the horizontal direction into
the wall. `updateLocomotion` must early-return while climbing, or it flips the
state back to `air` on the frame the climb starts.

| Function | Job |
|---|---|
| `CLIMB` | Every climb distance (probe heights, reaches, wall gap, mantle tolerances), named once with its reason. |
| `isWall` / `wallSlopeMax` | The one definition of a wall, from the "Climb threshold" slider. Also the NavGrid's `slopeMin`. |
| `climbWall` | The only way climb code probes for a surface. Rejects surfaces seen from behind. |
| `climbGround` | Walkable ground a climber would come down onto: beneath it, or one step back from the wall. |
| `tryStartClimb` | Shared start check for ground and air: a wall at chest and head height. |
| `tryStartClimbDown` | Lip grab when walking off a ledge. |
| `climbUpdate` | Movement on the wall, wall following, edges, corners, top-out, stepping off. Returns true on the frame it ends standing. |
| `pushOutOfWalls` | Sideways capsule push-out shared by walking and airborne movement. |
| `climbJumpOff` | Launch up and away. |
| `updateClimbBlend` | Mixes the up/down clip with the generated sideways clips. |

## Rules that must hold

These were each found by a bug. Breaking one brings the bug back.

1. **A climbable wall is seen from its outer side.** `wallAhead` raycasts
   double-sided and reports `front`. A back-face hit means the probe began inside
   something solid. Before this rule the figurine climbed objects from the inside.
   Always go through `climbWall`.
2. **A mid-air grab needs ground to drop back to.** Nothing confines the figurine to
   the walkable area while airborne, so it can pass the edge and reach faces that
   hang over nothing.
3. **A lip grab finds the face by probing back at the ledge from past the edge.**
   The walk direction points away from that face; using it as "into the wall" left
   the figurine facing outward and stuck.
4. **A descent only lands on ground at or below the feet.** Otherwise pressing S
   just under a lip snaps up onto the ledge.
5. **A descent has a bottom.** The cell hard against a wall's foot is often not
   walkable, so also look one step back; stop on solid geometry; and do not descend
   at all where there is no ground to come down onto.
6. **A sideways step needs the same face to continue.** A hit that jumps by more
   than a body radius is a different surface beyond the wall's edge.
7. **A held key keeps the meaning it was pressed with.** After a lip grab the held
   walk keys mean "carry on down" until released. During an automatic camera swing,
   held keys keep steering by the camera frame they were pressed in.
8. **Airborne wall contact, not a forward ray, triggers the grab.** The air path
   pushes the capsule out of walls sideways; the push direction gives the wall.
9. **Walkable or climbable, never two cutoffs.** The climb probes once used a fixed
   60° while the slider fed only the NavGrid, so some slopes were both and, with the
   slider lowered, some were neither.
10. **`climbUpdate` says when it ended on the ground.** The controller once assumed
    "not grounded" after every climb update, which flipped the state to `air` for a
    frame on every mantle and step-off.
11. **A failed climb attempt must not write `climbDir`.** The camera reads it. Use
    `climbTry` until the climb actually starts.

## Follow camera

A spring arm from the figurine to the camera (`updateCamera`).

- The arm's full length (`camWant`) is the user's zoom and belongs to OrbitControls.
  Obstruction shortens the rendered arm by `camPull`. OrbitControls reads zoom off
  the camera position, so the arm is restored to full length before
  `orbit.update()` each frame. Writing a shortened position without that loses the
  zoom.
- It shortens fast and lengthens slowly, so a flickering blocker holds it still.
- It never comes closer than the distance at which the figurine fits in frame.
- While climbing, if the wall blocks the view and the view from behind the figurine
  is clearer, it swings round. Any user drag or zoom cancels that for the rest of
  the climb (`camHandsOff`).
- Occlusion is tested against the collision mesh, not the splats. Faint splats that
  are not in the mesh can still sit in front of the camera.
- The camera does not translate with the figurine; it re-aims and is leashed by
  OrbitControls' min and max distance.

## Sideways animation

`character.glb` has one `climb` clip. `src/climb-side-anim.ts` builds a shimmy for
each direction at load time from that clip's cycle-averaged pose. Each limb is
rotated about `reach × travel` so its tip moves along the wall, and the world-space
rotation is carried into the bone's frame. No bone axes are hard-coded. The look is
set by `SHAPE` at the top of the file.

A Spider-Man-style crawl (splayed pose, head-first turning) was tried and rejected:
the upright climb read better. It is in history as a commit and its revert.

## Testing

- `?tel=1` logs `CLIMB-START`, `CLIMBDOWN-START`, `CLIMB-MANTLE`, `CLIMB-CLING`,
  `CLIMB-EDGE`, `CLIMB-CORNER` and the mid-air `CLIMB-NO` refusal.
- `__dbg.probe` (while climbing) reports the nearest surface ahead, behind, above
  and below the chest, each tagged `F` or `B`. **A `B` ahead, behind or above means
  the climber is inside a solid.** `below` is not reliable: flattening the floor
  leaves its top and underside coincident, so a ray straight down can report either.
- `scripts/climbfuzz.mjs` checks that invariant over random walking, jumping and
  climbing. It found most of the rules above. Counter has been clean since the
  review fixes (0 in 113 samples); Living Room showed 1 in 27.
- Counter (the plant, the clutter) and Kitchen (the Lego bulldozer) reach climbs
  from spawn. Playroom and Living Room get only a handful of climb samples per run,
  so walls there still need a human.

## Known limitations

- **No body collision while climbing.** The wall is followed with one probe near
  the feet, so the body can pass into objects beside or above the wall. The
  remaining invariant violations are this. Adding a capsule check risks blocking
  climbs on lumpy walls that work today.
- **A gap in a lumpy face reads as the top.** On the Counter plant, pressing W
  partway up can cling as if topped out.
- **Small tops are not standable.** Jumping onto something with no walkable cells
  (a can) falls through or is pushed out.
- **No ceiling collision in the air.** The airborne push-out is horizontal only, on
  purpose, to avoid wedging.
- **No wrapping around outside corners.**
- **Steering on small round objects swings a lot.** The rate is `TUNE.climbTurn`.
- **A climb can start during a landing animation.** `tryStartClimb` runs in the
  `land` state, and the `jump_land` finish event would then reset the state to
  `ground`. Latent: `character.glb` has no `jump_land` clip. Fix it when one is added.
- **The walkable grid assumes the floor is at y=0.** `buildNavGrid` is passed
  `minY = -charH` to reject sub-floor floaters, so a sunken area or stairs down more
  than one body-height below the leveled floor would not be walkable.
- **Falling out of the world recovers silently.** With the NavGrid on, it snaps back
  to the last good position with no log, so fall-throughs are invisible in
  telemetry. Add a `?tel=1` log before relying on "no fall-throughs" as a result.
- **Grabs are stricter since the single cutoff.** Surfaces between 60° and 70° used
  to be grabbable and are now ground. If climbs feel rare, lower the slider.
