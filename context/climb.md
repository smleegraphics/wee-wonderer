# Climbing

How the climb works, the rules it depends on, and what is known to be missing.
Read this before changing climbing, airborne movement, or the follow camera. All
of it is in `src/main.ts` unless noted.

## Behaviour

- Walk into a tall near-vertical wall: the climb starts. No button.
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
| `climbWall` | The only way climb code probes for a wall. Rejects surfaces seen from behind. |
| `climbGround` | Walkable ground a climber would come down onto: beneath it, or one step back from the wall. |
| `tryStartClimb` | Shared start check for ground and air: near-vertical face at chest and head height. |
| `tryStartClimbDown` | Lip grab when walking off a ledge. |
| `climbUpdate` | Movement on the wall, wall following, edges, corners, top-out, stepping off. |
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
5. **A descent has a floor.** The cell hard against a wall's foot is often not
   walkable, so also look one step back, and stop on solid geometry.
6. **A sideways step needs the same face to continue.** A hit that jumps by more
   than a body radius is a different surface beyond the wall's edge.
7. **A held key keeps the meaning it was pressed with.** After a lip grab the held
   walk keys mean "carry on down" until released. During an automatic camera swing,
   held keys keep steering by the camera frame they were pressed in.
8. **Airborne wall contact, not a forward ray, triggers the grab.** The air path
   pushes the capsule out of walls sideways; the push direction gives the wall.

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

- `?tel=1` logs `CLIMB-START`, `CLIMB-AIR`, `CLIMBDOWN-START`, `CLIMB-MANTLE`,
  `CLIMB-CLING`, `CLIMB-EDGE`, `CLIMB-CORNER` and `CLIMB-NO` refusals.
- `__dbg.probe` (with `?tel=1`, while climbing) reports the nearest surface ahead,
  behind, above and below the chest, each tagged `F` or `B`. **Any `B` means the
  climber is inside a solid.** That is the invariant to check.
- The most useful test so far: random walk, jump and climb on Counter for 90 s
  across several seeds, sampling that invariant. It found three of the rules above.
  20 violations in about 135 samples before the fixes, 2 in 160 after.
- Counter (the plant, the clutter) and Kitchen (the Lego bulldozer) reach climbs
  from spawn. Playroom and Living Room walls need a human.

## Known limitations

- **No body collision while climbing.** The wall is followed with one probe near
  the feet, so in clutter the body can pass into objects beside or above the wall.
  The remaining invariant violations are this. Adding a capsule check risks
  blocking climbs on lumpy walls that work today.
- **A gap in a lumpy face reads as the top.** On the Counter plant, pressing W
  partway up can cling as if topped out.
- **Small tops are not standable.** Jumping onto something with no walkable cells
  (a can) falls through or is pushed out.
- **No ceiling collision in the air.** The airborne push-out is horizontal only, on
  purpose, to avoid wedging.
- **No wrapping around outside corners.**
- **Steering on small round objects swings a lot.** The rate is `TUNE.climbTurn`.
- The "is it a wall" cutoff is `|normal.y| <= 0.5`. Grabs on things that look like
  slopes come from surfaces just inside it.
