# Climbing

How the climb works, the rules it depends on, and what is known to be missing.
Read this before changing climbing, airborne movement, or the follow camera. All
of it is in `src/figurine/` (`climb.ts`, `controller.ts`, `camera.ts`) unless noted.

## Behaviour

- Jump into a tall wall: grab it at that height. Walking into one just stops you (no
  accidental climbs). A face is climbable when it is steeper than the "Climb threshold"
  slider (70° by default) less "Grab below threshold" (10°): see rule 9.
- On the wall, W/S go up and down, A/D go along the face. A/D are the figurine's own
  left and right, never camera-relative. Diagonals combine at the same speed.
- Going up through a dent or gap in an uneven face: carry on, if the face picks up again
  within `CLIMB.gapAbove` (0.8 body heights) above the grip.
- At the top, over it whichever way there is (`overTheTop`), in this order: mantle onto the
  nearest walkable surface over the lip (out to `mantleOver` radii); step over a ledge too
  narrow to stand on to a face going on up behind it, and climb that (`setBack` radii; only
  where there is something solid to step over); climb over a thin top and drop onto ground on
  the far side (`dropOver` radii). Otherwise hang from the lip (the `ledgeHang` move, upright):
  W tries the same again, pulling up onto a surface up to `pullUp` (a body height) above the
  feet; A/D go along the lip, S climbs back down, Space jumps off. Every one of 36 hangs
  measured at the tops of objects had ground on the far side; hangs in the object test fell
  from 36 to 10 (Counter 9 -> 4, Living Room 26 -> 6, Kitchen 1 -> 0).
- **Every move over a top places the body at once and is shown over `overTime` (0.35 s).** A
  mantle (`tryMantle`), a step back to a face behind a narrow ledge (`stepToSetBack`) and a drop
  over a thin top (`dropOverTheTop`) each move the body in one frame, as before, so collision and
  every rule below see only where it is; each then calls `drawFrom`, and the drawn figure catches
  up: `figurine.drawn` eases from where the body was to nothing. The model is drawn there, and
  the camera aims there (`camera.ts`, across through `figurine.drawn`, up through `smoothFeetY`),
  so neither snaps. A mantle also holds the keys for that long (`figurine.mantleLeft`) and plays
  the `mantle` move; a jump press then ages as it would standing, so one in the last `jumpBuffer`
  is made on arriving and an earlier one is dropped (a press at the start used to jump at the
  end). Any placement (`resetMotion`) ends both. Measured: 0.37 s in 30 fps steps, the body still
  while keys wait, the model back on the body when it ends.
- Jump at a ledge (a face at chest height that ends below the head): grab it. Holding W tops
  out over it at once; with nothing to stand on it hangs.
- Walk off a ledge: fall (the lip grab is gone; jump back at the face to climb it).
- Space jumps off, away from the face.

## Structure

One state (`state === 'climb'`) with `climbDir` as the horizontal direction into
the wall. The controller's `animate` leaves the climb's move alone while climbing.
How the figurine walks, jumps and falls around this is `context/movement.md`.

| Function | Job |
|---|---|
| `CLIMB` | Every climb distance (probe heights, reaches, wall gap, mantle tolerances), named once with its reason. |
| `isWall` / `grabSlopeMax` | The one definition of a face to climb: steeper than the climb threshold less `grabBelow`. `grabSlopeMax` and `wallSlopeMax` (the walking cutoff, the NavGrid's `slopeMin`) are in `collision/room-collision.ts`, beside `PLATFORM_OPTS` they are read from. |
| `climbWall` | The only way climb code probes for a surface. Rejects surfaces seen from behind. |
| `climbGround` | Walkable ground a climber would come down onto: beneath it, or back from the wall up to a reach (a cell on the wall; the body's width plus a cell for a grab from the air). |
| `tryStartClimb` | The start check, made in the air on touching a wall: a face at chest and head height (a wall, `CLIMB-START`), or at chest height ending below the head (a ledge, `CLIMB-LEDGE`). A refusal logs why (`CLIMB-NO`). |
| `tryMantle` / `wallAbove` | Topping out onto a surface over the lip (within a reach up: `mantleUp` climbing, `pullUp` from a hang), and telling a gap in the face from its top. |
| `climbUpdate` | Movement on the wall, wall following, edges, corners, top-out, stepping off. Returns true on the frame it ends standing. |
| `pushOutOfWalls` | Sideways capsule push-out shared by walking and airborne movement. |
| `climbJumpOff` | Launch up and away. |

## Rules that must hold

These were each found by a bug. Breaking one brings the bug back.

1. **A climbable wall is seen from its outer side.** `wallAhead` raycasts
   double-sided and reports `front`. A back-face hit means the probe began inside
   something solid. Before this rule the figurine climbed objects from the inside.
   Always go through `climbWall`.
2. **A mid-air grab needs ground to drop back to.** Nothing confines the figurine to
   the walkable area while airborne, so it can pass the edge and reach faces that
   hang over nothing. It looks for that ground back from the wall as far as the body
   is wide plus a cell: a jump carries the body past the last walkable cell before it
   touches (Living Room's couch back stands 1.5 cells past the seat's last one), and
   one cell refused grabs that were fine.
3. *(Retired: the lip grab when walking off a ledge is gone. Walking off falls.)*
4. **A descent only lands on ground at or below the feet.** Otherwise pressing S
   just under a lip snaps up onto the ledge.
5. **A descent has a bottom.** The cell hard against a wall's foot is often not
   walkable, so also look one step back; stop on solid geometry; and do not descend
   at all where there is no ground to come down onto.
6. **A sideways step needs the same face to continue.** A hit that jumps by more
   than a body radius is a different surface beyond the wall's edge.
7. **A held key keeps the meaning it was pressed with.** During an automatic camera
   swing, held keys keep steering by the camera frame they were pressed in.
8. **Airborne wall contact, not a forward ray, triggers the grab.** The air path
   pushes the capsule out of walls sideways; the push direction gives the wall.
9. **Never a surface that is neither walkable nor climbable.** The climb probes once
   used a fixed 60° while the slider fed only the NavGrid, so with the slider lowered
   some slopes were neither. Then one cutoff did both, which could not suit every
   room: Curled Up Dog needs its 60°-70° flanks walkable (at a 60° or 65° cutoff its
   reach by climbing falls from 99.9% to 83%), and Kitchen's bulldozer has collision
   sides of 62°-68° that need to be grabbable (at 70°, 4 of 16 running jumps grab
   it). Now a face is grabbable from the climb threshold less `grabBelow`, which can
   only be at or below the walking cutoff: between the two a surface is both, never
   neither. Climbs start only by jumping, so "both" never turns a walk into a climb.
   With `grabBelow` 10: 9 of 16, and no room's reach lower. With the ledge grab too, 18 of 32
   jumps (standing and running) grab it.
10. **`climbUpdate` says when it ended on the ground.** The controller once assumed
    "not grounded" after every climb update, which flipped the state to `air` for a
    frame on every mantle and step-off.
11. **A failed climb attempt must not write `climbDir`.** The camera reads it. Use
    `climbTry` until the climb actually starts.
12. **Every move that places the climber goes through `fitClimbBody`, and a frame whose move
    still does not fit is not made.** It pushes the
    body out of an overlap up to a radius and refuses anything deeper (the way out is
    then ambiguous, and a push can go through a thin shell), so the caller undoes or
    refuses that move. Two moves used to skip it, for the same reason: each finds the
    face with one ray and places the whole body by it, so where the face is set back at
    that height (a recess, or under a lip) the rest of the body lands inside what sticks
    out.
    - The snap that holds the gap to the face, whose ray is near the feet, carried the
      body up to `followReach` (2.8 radii) forward. On Counter (`.spz`, seeds 1 and 5) it
      was left 1.2 radii inside. Now a snap that goes too deep is not made that frame;
      the sideways and vertical moves still apply. Clamping the snap to a radius was
      rejected: it pulls in and pushes out every frame, which jitters.
    - The lip grab (walking off a ledge; since removed) measured the face just below the lip and hung the body inside the
      lip (0.82 radii on Counter `.spz`, seed 6). It was pushed out only on the next
      frame with a key held: a resting frame returns before the push. Now the grab is
      pushed clear as it is made, or refused if it is too deep.
    - A move that still does not fit once the snap is undone is not made at all: the
      frame goes back to where it started (`climbFrame`). And `fitClimbBody` also refuses a
      chest inside something solid (`chestInside`), which the overlap test cannot see: a
      body wholly inside crosses no surface and reads 0.
    - **Inside is most of six rays meeting a surface from behind**, not one. The first
      version (and the climb fuzz) used one ray ahead, behind or up, and a scan's mesh has
      holes: a ray through a hole in the wall ahead meets the inside of the object's far side
      from behind. Living Room's fuzz seed 2 "violation" was that (only the ray ahead saw a
      back face), and the climb, made to refuse it, stuck at the foot of objects there (10
      stuck climbs in the object test, 1 with six rays). With six rays the fuzz flags none of
      what the one-ray rule did in 12 runs, and the climb fuzz uses the same function.

13. **The gap to the wall is held over the whole body.** The grip ray (just above the feet)
    still decides whether there is a wall, the top, gaps and corners; but the body is held
    `CLIMB.gap` from the nearest the wall comes to its axis, grip to head
    (`Collision.nearestAhead`: surfaces facing it, within 60° of the climbing direction, not
    below the grip). With the grip ray alone, a face that bulges out higher up (the side of
    Counter's bowl) pressed the chest and head into it, and the push out of it cancelled every
    step up: 12 of 112 jumps at Counter's objects ended stuck on the face, 1 now, and 45 reached
    a top instead of 36. It costs 0.18 ms a frame while climbing (0.38 ms before its search
    stopped at the axis's foot: the floor under the body was most of the triangles tested).
    Three rays (feet, chest, head) were the cheaper idea, rejected as still sampling: a bulge
    between them, or beside the body, would be missed.

## Follow camera

A spring arm from the figurine to the camera (`updateCamera`).

**The free camera** (Debug card → Overlays → Free camera, `setGodCam`) lets the camera off the
figurine for looking round a scan: drag to orbit, right-drag to pan, scroll as near or far as
you like, nothing in the way pulls it in. The figurine still walks, steered by where the
camera faces. The follow camera's zoom limits are set through `setFollowDistance` (the
character's size sets them, `character.ts`) and kept while the free camera is on, so a
character switched meanwhile does not clamp it; turning it off puts them back.

- **Two cameras: what the player asked for, and what is shown.** OrbitControls drives
  its own camera (`orbitCamera`, `app.ts`), which nothing else moves: its distance
  from the pivot is the user's zoom (`camWant`). The camera that is drawn (`camera`)
  is set from it each frame (`showView`): the same line and facing, shortened by
  `camPull` when something is in the way. The automatic swing turns `orbitCamera`,
  since it re-aims where the player looks from.
- **Never move `orbitCamera` to show something.** OrbitControls reads its camera's
  distance as the zoom whenever input arrives (a scroll calls its `update()` inside
  the event, `OrbitControls.js` `_handleMouseWheel`), not only when the frame asks.
  With one shared camera, a scroll made while the view was pulled in zoomed from the
  pulled-in distance, and the next frame put the old zoom back: near anything that
  blocked the view, scrolling did nothing. Measured in Kitchen, blocked: 17 scrolls,
  zoom unchanged before; every scroll counted after.
- It shortens fast and lengthens slowly, so a flickering blocker holds it still.
- It never comes closer than the distance at which the figurine fits in frame.
- **The opening shot is turned to a side that sees the figurine** (`frameOpeningShot`,
  `openingView`): the same framing (`CAM_START`) at every spawn and Reset, with the
  figurine turned along, tried at 16 sides nearest the unturned one first, taking the
  first whose arm meets no collision **and** sees at least three quarters of the figurine
  past the splats (`OPENING_SEES`; else, of the sides clear of the collision, the one that
  sees the most; else the one that sees furthest). From one fixed side, Living Room
  opened pulled in as close as the camera goes, on the figurine's face. Testing the
  collision alone, it then opened behind 56 floaters on a side the collision called clear:
  the mesh leaves floaters out (context/collision.md, "See it but cannot touch it").
- **What the camera sees is worked out from the splats** (`scan/splat-sight.ts`). When a
  room loads, its splats are sorted once into a grid of cells about a figurine high
  (`setSightSplats`). Each sight line, to the figurine's legs, body and head, walks exactly
  the cells it crosses and takes away each splat's opacity where it passes nearest the splat,
  measured in the splat's own shape, so a flat splat seen edge-on hides little; a splat the
  line passes further from than its widest reach is skipped before its shape is worked out.
  Median of five, on Sam's machine: the sort 35 ms (Living Room) to 0.9 s (Record Player
  Table, 4.25 million splats, on the main thread while the loading view is up); choosing the
  start, or Reset, 3 to 68 ms. An earlier version gathered the splats round each spot it
  looked at (0.25 s a spot on Record Player Table), so it had to cap how many spots it looked
  at; one sort removed the cap. Single timings here swing up to fivefold with whatever else
  the machine is doing: time several runs. A rough version that treated every splat as a ball
  the size of its widest axis said Living Room's new view was blocked; the picture says not.
- The follow camera still tests only the collision, so floaters can block it in play.
  Fading the splats between the camera and the figurine would cover that (not built).
- While climbing, if the wall blocks the view and the view from behind the figurine
  is clearer, it swings round. Any user drag or zoom cancels that for the rest of
  the climb (`camHandsOff`).
- Occlusion is tested against the collision mesh, not the splats. Faint splats that
  are not in the mesh can still sit in front of the camera.
- The camera does not translate with the figurine; it re-aims and is leashed by
  OrbitControls' min and max distance.

## Leaning with the wall

While climbing, the figure (not the body that collides, which stays upright) lies parallel to
the wall it touches: its up is the world's up made perpendicular to the way the touching faces
face, averaged by their area. The touching faces are those within `TILT_TOUCH` (half a radius)
past the climbing gap, found by the same pass as rule 13 (`Collision.nearestAhead`'s `facing`),
counting only faces steep enough to climb (`grabSlopeMax`): the tops of things, large and
turned to the sky, tipped every climb in Kitchen 30° to 39° forward. It is capped
(`CLIMB_TILT.max`, 15°) and eased slowly (`TILT_RATE`, 4 a second), about the chest; upright
while hanging at a top and off the wall. A Debug switch and slider (Climbing).

Tried and dropped, in order: the way from the nearest wall point to the body (it saw a leaf
over a plant's pot, never a face leaning away); the wall's distance at the grip against the
chest (a chest ray past the top or through a gap read another surface, and threw the figure
40° forward over the top of Kitchen's bulldozer; limited to the same face, it still wobbled
on lumpy faces 0.35 body heights apart). With touched faces the lean has no bias on Living
Room's furniture (medians -10° to +10°) but still leans forward on Kitchen's small, smoothed
objects, whose touching faces are their rounded edges; and within one object it swings, which
the 15° cap and slow easing keep small.

## Sideways animation

None of its own: a character's `climb` move plays while moving along a face as well as up
it. A generator that built a sideways shimmy from the old figurine's climb clip was
removed: it named that rig's bones (`RightArm`, `Left_Arm`, `Hips`), so it suited one
character only.

## Testing

- `?tel=1` logs `CLIMB-START`, `CLIMB-LEDGE`, `CLIMB-MANTLE`, `CLIMB-GAP`, `CLIMB-CLING`,
  `CLIMB-EDGE`, `CLIMB-CORNER` and the `CLIMB-NO` refusal, with why: no ground to drop back to, or
  which probe (chest, head) found nothing within reach or too shallow a face.
- `__dbg.probe` (while climbing) reports the nearest surface ahead, behind, above
  and below the chest, each tagged `F` or `B`. **A `B` ahead, behind or above means
  the climber is inside a solid.** `below` is not reliable: flattening the floor
  leaves its top and underside coincident, so a ray straight down can report either.
- `scripts/climbfuzz.mjs` checks that invariant over random walking, jumping and
  climbing. It found most of the rules above. Counter has been clean since the
  review fixes (0 in 113 samples); Living Room showed 1 in 27.
- Counter (the plant, the clutter) and Kitchen (the Lego bulldozer) reach climbs
  from spawn: with the grab cutoff, 11 to 20 climb samples a 90-second run on Counter,
  2 to 11 on Kitchen. Playroom and Living Room get only a handful of climb samples per run,
  so walls there still need a human.
- **A run repeats exactly.** It used to differ run to run, for two reasons: it started
  driving while the room was still arriving (keys do nothing then), and it held keys
  for real milliseconds while each frame's length came from the clock, so the same
  hold carried the figurine a different distance each time (Kitchen, seed 1: the two
  paths parted at the fourth sample). It now waits for the room (`reveal === 1`) and
  drives through `window.__step(keys, seconds, jump)`, which, once called, runs the
  controller, animation and camera only for the time asked for, in frames of
  `STEP_DT`, and holds everything still between calls. Two runs of a seed give the same
  path to the millimetre. A violation can now be rerun and looked at.
- **It does not draw.** `__step`'s fourth argument, `draw`, false, works the frames out at
  once without rendering them: a 60-second run on Counter took 67 s drawn and 6 s not, with
  the same result. Headless Chrome draws the splats on the CPU, which was nearly all of it.
- **Measuring grabs on one object** (the sweep behind rule 9) is a scratch script: stand
  the figurine at 16 points round it, walk or run at it, jump, and count `CLIMB-START`
  against each `CLIMB-NO` reason. Aim at what is actually there: from some sides the
  middle of an object's raised cells is not behind it, and the walk stops at another edge.

## Known limitations

- **The body is checked against the wall in front, not everything round it.** The gap is
  kept over the whole body (rule 13) and a move that ends inside something is undone (rule
  12), but nothing steers the body around an object beside the wall: it stops instead.
- **A crevice between two objects can still hold a climber** that falls into it and re-grabs
  (2 of 112 in the object test): no pushes or undone frames, no headway. Not investigated.
  Climbing over a thin top and dropping lands in such places more often: with W still held
  the falling climber grabs the far wall (3 of 5 stuck climbs in Living Room's object test).
- **A gap the probe cannot see past still reads as the top.** `wallAbove` looks within the
  following reach; where the face resumes further back than that, or more than `gapAbove`
  higher, the climber hangs. Measured with the cling detector (a scratch script: hold W on
  every climb, record the clings): 15 clings in 4 runs before the gap rule, 1 to 2 after.
- **Small tops are not standable.** Jumping onto something with no walkable cells
  (a can) falls through or is pushed out.
- **No ceiling collision in the air.** The airborne push-out is horizontal only, on
  purpose, to avoid wedging.
- **A climb can start with no room above it, and then hangs.** Starting a climb asks for
  a face at chest and head height, not for room to climb. Under an overhang at head height
  (Record Player Table's sideboard, from below, at its `size`), a jump grabs the overhang's
  slanted edge with the underside just over the head; the climb's moves are then all
  refused (the body would go into the underside) and it hangs until let go. A fix would ask
  for room for one climbing step up before starting, and let go when a climb can go neither
  up nor over. Left as minor.
- **No wrapping around outside corners.**
- **Steering on small round objects swings a lot.** The rate is `TUNE.climbTurn`.
- **The walkable grid assumes the floor is at y=0.** `buildNavGrid` is passed
  `minY = -charH` to reject sub-floor floaters, so a sunken area or stairs down more
  than one body-height below the leveled floor would not be walkable.
- **Falling out of the world recovers silently.** With the NavGrid on, it snaps back
  to the last good position with no log, so fall-throughs are invisible in
  telemetry. Add a `?tel=1` log before relying on "no fall-throughs" as a result.
- **Small objects have sloped collision sides.** The voxels are about a fifth of the
  figurine and the mesh is smoothed, so a box a couple of body heights tall comes out
  with 60°-70° sides (rule 9). Less smoothing (`taubin` 3 or 0) grabbed about as often as
  a 65° cutoff on the bulldozer; finer mesh detail (`refine` 3) changed nothing, as
  Kitchen's splats are too sparse for it. Neither was taken: both change every room's
  collision.
- **Tried and dropped:** judging a face by how far it leans back between the chest and
  head probes instead of by the triangle each hits (no change on the bulldozer: its
  faces really lean), and starting a jump with walking speed in the direction held
  (no change: pressed against something, its first frame in the air takes that speed
  away again).
