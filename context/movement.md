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
| Chibi (default) | CC BY 4.0 (PolyOne), Mixamo animations | `context/character-README.md`; a real climb clip |
| Robot | CC0 (Tomás Laulhé / Quaternius) | From the three.js examples; rises, falls and climbs on held frames of its Jump |
| Human | CC0 (Quaternius) | Converted from its FBX in Blender (below); radius 0.16, as it measures slimmer |

The Characters tile picks one (`loadCharacter`): the model is swapped in place, with no
reload, and the choice is kept in `localStorage['ww.character']`. `character` in
`character.ts` is the one in play. Of loads asked for in a row only the last is put in play
(a slower earlier one, or its failure, is dropped), and picking the one in play does nothing.
The new body takes the old one's place with `refitBody`: on the ground (back where it last
stood, if it was in the air or on a wall, whose fit was for the old body) and pushed clear of
walls at its width. The NavGrid is rebuilt only for a character of another height.

**Pacing is measured, not typed in** (`clip-pace.ts`): the speed at which a walk or run
clip keeps a planted foot still, from how far the lowest bone each side travels back over
a cycle, relative to the skeleton's root bone, so root motion does not count (no bone
names). The clip then plays at the figurine's speed over that, within `PACE_RANGE` (half to
twice); a clip that cannot be measured (no feet found) is taken to be made for the game's
walk or sprint speed. Measured: robot 0.69 / 0.91, chibi 0.41 / 1.09, human 1.18 / 2.17
body heights a second (walk / run), all under the game's 1.6 and 4.0.

**Adding a character:** put its GLB in `public/characters/`, add an entry, credit it in
`CREDITS.md` and the Credits card. An FBX with its actions as separate takes can be
converted headless in Blender (`--factory-startup --disable-autoexec`, never a `.blend`
someone else made: it can carry scripts): import it, put each action on its own NLA track,
and export a GLB by tracks. Exporting by actions kept only one clip. An FBX whose colour
texture is a separate file needs it wired to the material before export.

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

- **Feet slide at speed.** Every character's clips keep their feet planted under the
  game's speeds (above); at twice their authored speed only the human's walk keeps up.
- **`airControl` is low for a jump made from a standstill**: it drifts forward slowly.
- **The movement model ignores walls in the way of a jump** and assumes every air jump is
  made at the top of the last, so what it says can be reached is an upper bound.
- **No ceiling collision in the air** (`context/climb.md`).
- **The walkable cells know headroom, not width.** Where a wider body cannot stand clear (a
  narrow top), pushing it out of the wall takes it off the cells and the walk's recovery puts
  it back in: up to 0.45 radii deep, measured switching to the chibi on Counter. Walking there
  does the same.
