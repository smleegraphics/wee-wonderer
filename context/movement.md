# Movement

How the figurine walks, sprints, jumps and falls, what it can do beyond that (abilities), and
how a character is described so it can be swapped. Read this before changing the controller,
the movement settings, an ability, or how a character is animated. Climbing has its own doc,
`context/climb.md`. Code: `src/figurine/` (`controller.ts`, `movement.ts`, `abilities.ts`,
`characters.ts`, `character.ts`).

## How it moves

- **States:** `ground`, `air`, `climb` (`figurine.state`). There is no take-off or landing
  state: the jump lifts off the frame Space is pressed, and landing is a frame of `ground`.
- **Speed has momentum.** The keys set a wished speed; the figurine's speed moves toward it
  at the ground's rate (`accelTime` to reach walking pace, `stopTime` to stop) or a share of
  it in the air (`airControl`). It turns to face where it is going.
- **Shift builds into a sprint** over `sprintRamp`, and back down on letting go. A sprint
  that switched on at once was the most common complaint about running; this is the
  browser-game convention (hold Shift) made smooth.
- **The jump** rises `jumpHeight` held to the top; letting go of Space while rising keeps
  `jumpCut` of the upward speed (a tap is a hop). A jump still counts as from the ground for
  `coyoteTime` after walking off an edge, and a press up to `jumpBuffer` before landing is
  made on touching down.
- **Walking off an edge falls**, if there is somewhere below to land. An edge with nothing
  below (the scan's rim) or a body pushed into something there (a wall's foot) stops it, and
  it slides along the edge. A drop of up to `STEP_DOWN_MAX` is stepped down.
- **Walls stop a walk; jumping into one climbs it, and jumping at a ledge grabs it**
  (`context/climb.md`). A jump press waits `jumpBuffer` but not through a climb: grabbing a
  wall drops it.

## Rules that must hold

1. **Standing means the NavGrid says so.** Walking moves only onto walkable cells, and
   landing is on them. Everything after a move (standing, landing, a grab's "ground to drop
   back to") asks the cells under the figurine. A "gap narrower than the body" rule that let
   it walk past the last cell left it over nothing: jumps floated and grabs were refused.
   The NavGrid already fills small holes in a surface.
2. **A frame's fall is exact.** Gravity is the same all through a frame, so the move is
   speed × dt − ½ × gravity × dt². Adding the pull to the speed first lost half a frame's
   rise each jump (0.05 body heights at 30 frames a second), so a jump's height depended on
   the frame rate and the movement model overestimated it.
3. **The movement model is what the game does.** `collision-health.ts`'s `jumpArc` works out
   from the settings and the loadout how high a jump rises and how far it carries: the jump,
   then each air jump at the top of the one before, rising at `gravity`, falling at
   `gravity × fallGravity`, at sprint speed across. `scripts/jumpcheck.mjs` checks it against
   real running jumps (0 to 3% off), importing `jumpArc` itself rather than a copy of its
   arithmetic, so the two cannot drift. Change one, run the other.
4. **Nothing asks which character it is.** Code asks for a move (`play('fall')`), whether
   the character climbs, and what its loadout can do.
5. **Everything is in body heights** (speeds a second, heights, accelerations), so a
   character of another size moves the same relative to itself.
6. **No allocations per frame** in `updateController` and what it calls.
7. **The walkable cells know headroom, not width; the body's width is checked where it
   stands.** A step is taken onto any walkable cell and the body pushed clear of walls, but a
   push that leaves no cell underfoot refuses the step (the body does not fit there beside
   the wall); recovery onto the cells (`NavGrid.nearest` with `bodyFits`) takes the nearest
   cell of the same platform where the body fits. Before, the push left the cells and the
   recovery put a wide body straight back into the wall. Checking width live, not storing it
   per cell, means any width works with no rebuild (a pass over every cell costs 50 to 180
   ms headless, per width). Measured on Counter's tops at widths 0.1 to 0.35 and heights 0.3
   to 0.6: no standing sample over half a radius deep but the short body's (limitations),
   against 4.3% at width 0.35 and 7.2% at height 0.6 before.

## Settings: `MOVE` (`movement.ts`)

All are Debug-card sliders (Movement). The defaults keep the old jump's rise (0.57) and
run's speed (4.0); everything else was a first guess, meant to be tuned by playing.

| Setting | Default | What |
|---|---|---|
| `walkSpeed` / `sprintSpeed` | 1.6 / 4.0 | body heights a second |
| `sprintRamp` | 0.6 s | walk to full sprint with Shift held, and back |
| `accelTime` / `stopTime` | 0.12 / 0.1 s | standing to walking pace, and back |
| `airControl` | 0.35 | steering in the air, as a share of on the ground |
| `jumpHeight` / `airJumpHeight` | 0.57 / 0.5 | body heights |
| `gravity` / `fallGravity` | 9 / 1 | body heights a second², and falling's multiple of it |
| `jumpCut` | 0.45 | the upward speed kept on letting go of Space while rising |
| `coyoteTime` / `jumpBuffer` | 0.1 / 0.12 s | late and early jump grace |
| `turnRate` | 12 | how fast it turns to face where it goes |
| `paceScale` | 1 | the walk and run clips play as if made for this times their measured pace (animation only): for legs that never plant, set by eye in a character's `tune` |

`MOVE` is the defaults, then the character's `tune`, then the session's slider changes
(`useMoveSettings`).

## Abilities (`abilities.ts`)

Moves beyond walking, jumping and climbing, made from ids in a list (the loadout): the
character's own `abilities`, later an accessory's. Each hooks into the controller through
the same few calls (`airJump`, `landed`, `airJumps` for the movement model). The double
jump (`doubleJump`: one more jump in the air) is the first. Gliding and flying would be the
next: they would add a hook for the air's gravity.

## Characters (`characters.ts`)

A character is data: its model (under `public/characters/`), its height (the model is
scaled to it, measured in its idle pose with skinning applied), its collision capsule's
width (`radius`, which `BODY.radius` takes), which of its clips shows each move, whether it
climbs, its abilities, and its `tune`. Three, all the same height so the rooms play the
same whichever is chosen:

| Character | Licence | Notes |
|---|---|---|
| Chibi (default) | CC BY 4.0 (PolyOne), Mixamo animations | `context/character-README.md`; a real climb clip; Mixamo bone names |
| Skeleton | CC0 (Kay Lousberg, KayKit Skeletons 1.0) | KayKit's rig, shared by every KayKit character; in-place take-off, in-air and landing clips; climbs on a held frame of its Cheer; radius 0.14 |
| Mini | CC0 (Kenney, Mini Characters 1.0, `character-female-f`) | A rig of rigid parts (7 bones); climbs on a held frame of `holding-both`; radius 0.25 |

The Robot (RobotExpressive) and Human (Quaternius) they replaced rose, fell and climbed on held
frames of one Jump clip that lifts its own hips, which drew the body 0.3 and 0.5 body heights
above where it collides. A held frame must come from a clip that stays in place.

A radius is the chibi's 0.22 scaled by the body's width at mid height (the skinned vertices
between 40% and 70% of the height, 5th to 95th percentile across): chibi 0.58, skeleton 0.36,
mini 0.65 of the height.

The Characters tile picks one (`loadCharacter`): the model is swapped in place, with no
reload, and the choice is kept in `localStorage['ww.character']`. `character` in
`character.ts` is the one in play. Of loads asked for in a row only the last is put in play
(a slower earlier one, or its failure, is dropped), and picking the one in play does nothing.
The new body takes the old one's place with `refitBody` (for any change of the body's size):
on the ground (back where it last stood, if it was in the air or on a wall, whose fit was for
the old body) and pushed clear of walls at its width; where that leaves the cells it falls
from there if there is ground below, or goes to the nearest cell it fits (rule 7). The NavGrid is rebuilt only for a character of another height.

**Pacing is measured, not typed in** (`clip-pace.ts`): the speed at which a walk or run
clip keeps a planted foot still. The foot on the ground is the skin's lowest point (no bone
names, no left and right), measured from the skeleton's root bone so root motion does not
count; the pace is the median speed it moves back while it stays the same point. A leg that
never plants (a rigid block swinging like a pendulum: the mini's) swings forward at the ground as
often as back, and is paced by its backward moments only: how fast the foot sweeps back at the
ground. Neither that nor a stride a step (the foot's average) read right by eye: too slow and 2.2
times too fast. With no planted foot there is no right answer to measure, so her `tune` sets
`paceScale` 0.65, picked live with the Debug card's "Clip pace" slider. which kind a clip is, is told from the clip: a planted foot's travel is 0.74 to 1
backward, a pendulum's 0.5. The clip then plays at the figurine's speed over that, within
`PACE_RANGE` (half to twice); a clip that cannot be measured (no skin, or no foot that moves)
is taken to be made for the game's walk or sprint speed. Measured: chibi 0.36 / 1.57,
skeleton 0.35 / 1.76, mini 2.14 / 4.25 body heights a second (walk / run). The pace is a median, so a
part that is lowest for a frame or two (the mini's hands, swung below her feet in her run) does
not move it. It costs 10 to 35 ms a clip, once, as a character loads (most of it the
first pass over every vertex, skinned on the CPU, to find the few that can touch the ground).

Tried and replaced: the lowest *bone* each side, and a pace of twice its travel per cycle. Bone
origins picked the wrong things (the robot's root bone, the human's toe-tip marker, the mini's
hips, about which her rigid legs swing, so 0), and "twice the travel" assumes each foot is down
for half the cycle: true of neither a walk (longer, so it read 11 to 29% fast) nor a run (shorter:
26 to 40% slow). Checked against the least-slide pace (a body moved forward at a trial pace,
the slide of its contact point summed), the new measure is within 0 to 5% on every planted clip.

**The mini's hop.** Kenney's walk and run raise the whole body while the rigid legs are spread,
so it hopped: in the run her feet left the ground by 0.37 body heights and the body bobbed 0.34
(the chibi's and skeleton's: 0.02 to 0.07). Two things lift her: the clip's own rise of the top
joint, and the spread legs themselves (a pair of compasses opening lifts both feet). Taking the
top joint's rise out alone left her floating 0.11 when her legs spread; holding her lowest point
on the ground every frame (the top joint lowered by its height, at 60 samples a second) left
quick dips, 18 a second in the run. What she has is two thirds of that grounding, picked by eye
in Blender among none, a third, two thirds and all: run bob 0.049 with the feet up to 0.044,
walk 0.063 and 0.018. Only the top joint's height changed: nothing moves across, and her pace is
the same. Done with gltf-transform (only those keys rewritten), the heights worked out in a
page that poses her with the game's three.js.

**Adding a character:** put its GLB in `public/characters/`, add an entry, make its picture for
the Characters card (`node scripts/character-thumbs.mjs`, which writes the entry's `thumb`), and
credit it in `CREDITS.md` and the Credits card. An FBX with its actions as separate takes can be
converted headless in Blender (`--factory-startup --disable-autoexec`, never a `.blend`
someone else made: it can carry scripts): import it, put each action on its own NLA track,
and export a GLB by tracks. Exporting by actions kept only one clip. An FBX whose colour
texture is a separate file needs it wired to the material before export.

**Cutting a GLB down to the clips it uses** (the skeleton's came with 95, 4.7 MB; 542 KB with
7): do it with gltf-transform's library (`@gltf-transform/core` and `functions`), which edits
the file in place, not a Blender import and export, which rewrites all of it. Dispose each
dropped clip's channels and samplers as well as the clip: they outlive it otherwise, and
`prune` keeps their keys (the first cut left 10,013 unused accessors and 3.3 MB). Then
`resample` and `prune`, and clear each texture's URI so a texture kept beside the file (the
Kenney packs') is embedded in the GLB, which is the one file the game loads. Compare bone
positions over each clip with the original afterwards (both cuts: within 0.0002 body heights).
Props held in a hand (KayKit's hand-slot meshes) are separate meshes to remove.

### The moves a character animates

A model need not have a clip for every move: `clips` can hold a frame of another clip still
(`{ clip, hold }`), and a move with nothing falls back as `MOVE_FALLBACK` says.

| Move | Plays | Falls back to | The chibi |
|---|---|---|---|
| `idle` | loop | — | `idle` |
| `walk` | loop, sped up and slowed with the speed | — | `walk` |
| `sprint` | loop, likewise | `walk` | `run` |
| `jumpStart` | once, over the start of the rise | `rise` | `jump_start` |
| `rise` | once (held) | `fall` | (falls back) |
| `fall` | once (held) | `idle` | `jump_loop`, a one-frame pose |
| `land` | once, on a landing faster than `LAND_HARD` | `idle` | (falls back) |
| `airJump` | once, from its start again for each air jump | `jumpStart` | (falls back) |
| `climb` | loop, paused while not moving on the wall | — | `climb` |
| `ledgeHang` | loop, while hanging from a lip | `climb` | (falls back) |

A character for the game wants all of these, and could add a sideways climb (there is none:
the generated one was tied to the chibi's bones, `context/climb.md`).

## Testing

- **`__step(keys, seconds, jump, draw)`** (`?tel=1`) moves the figurine in fixed frames.
  `'Space'` among the keys holds the jump on; `jump` presses it at the first frame. With
  `draw` false the frames are worked out at once and not drawn, about 11 times faster
  (headless Chrome draws the splats on the CPU). `climbfuzz` runs that way.
- **`scripts/jumpcheck.mjs [scan]`** checks the movement model (rule 3). It runs along the
  clearest line from the start, clear from the floor to above the highest jump across the
  body's width: anything the jump touches on the way takes its speed (a Living Room line
  clear only at knee height came out 20% short).
- **`__dbg`** has `speed` and `vy` (body heights a second) and `move` (the move showing).

## Tried and dropped

- **A spin for the double jump** on the old figurine, which had no clip for it: it read as
  a trick, not a push. The take-off clip plays again instead.
- **A figure built from shapes in code** (squash and stretch, a procedural step): it looked
  like a placeholder. Characters are rigged models with clips.
- **Walking over gaps narrower than the body** (rule 1).
- **Starting a jump with walking speed in the direction held**, for jumps made pressed
  against something: no change measured (`context/climb.md`).

## Known limitations

- **Feet slide at speed.** The chibi's and skeleton's walks would need about 4.4 times their
  authored speed to keep up with the game's walk, so at the 2x cap their feet cover about 45% of
  the ground; the mini's walk and run play at 1.15x and 1.45x (her `paceScale`). The root cause is leg length: speeds are in body
  heights, and the hips stand at 0.15 (chibi), 0.17 (skeleton) and 0.26 (mini) body heights.
- **Walking is uneven from frame to frame.** In a straight walk `__dbg.speed` holds 1.6, but the
  position advances 0.66 to 1.67 body heights a second frame to frame (Playroom: 4 to 19 of 44
  frames short, every character). It reads as speeding up and slowing down. Not yet
  investigated; the clips are not the cause (the mini's walk moves her head 0.001 of her height
  forward and back). Her run's torso pitches about 30° a step; scaling it to a quarter made no
  visible difference, so it was left.
- **`airControl` is low for a jump made from a standstill**: it drifts forward slowly.
- **The movement model ignores walls in the way of a jump** and assumes every air jump is
  made at the top of the last, so what it says can be reached is an upper bound.
- **No ceiling collision in the air** (`context/climb.md`).
- **A switch into a corner can leave up to 0.27 radii of overlap** (measured on Counter, from
  the old Human to the Chibi, pressed into objects): `refitBody` pushes out once, and nothing pushes again until the
  figure moves.
- **A short body treats ground bumps as walls.** The body test skips the bottom `WALL_LIFT`
  (a quarter of the height) so lumps in the floor do not push; the mesh's lumps are about a
  voxel whatever the character's size, so on a body 0.3 tall they reach past that and it can
  stick against them (0.6% of standing samples over half a radius deep, Counter's tops; the
  same before and after the width fix). Not fixed: the skip would need to follow the mesh's
  roughness, not only the body.
