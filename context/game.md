# The game: themes a room is played as

What turns the toy into a game, how a room's theme is chosen, and what was measured and
tried. Read this before changing a theme, adding one, or changing what the game reads off
a room. Code: `src/game/` (`game.ts` runs it, `room-shape.ts` reads the room, `theme.ts`
is what a theme is, one file per theme) and `src/collision/reach-graph.ts` (the movement
model it shares with the collision health numbers).

## The idea

The room is the level and a theme is its rule. A theme says what a room needs for its rule
to work, measured from the room's shape, so it works on an imported scan as well as the
examples; nothing branches on a scan's name. One theme suits every room, so every room has
a game. The direction this is heading (a whimsical world where the "pretend" is really in
the room: lava that glows, gear lying about) and the ideas not built yet are at the end.

## The prototype's two themes

- **The floor is lava** (`lava.ts`). The ground glows and may not be stood on: touching
  it puts the figurine back where it last stood on a raised surface (no game over). The
  goal is a flag on the highest real surface of the room's lava route. It starts on the
  route's largest surface. Suits a room whose lava route has at least `LAVA.minTops` real
  surfaces.
- **The spilled pack** (`spilled-pack.ts`). The Wonderer's pack burst open on the way in;
  its gear (spyglass, lantern, compass, map, journal, rope) is on the room's landmarks.
  Walk into a piece to pick it up. Suits any room: it is the fallback.

The room gets the first theme in `THEMES` (game.ts) that suits it. The Debug card's Game
section turns lava off (the room is then the pack) and says which themes suit the room.
The goal card (bottom centre) holds the goal while playing; one-off lines go to the status note.

## The hint arrow: `hint.ts`

After `HINT.after` seconds (20, a first guess) without progress, an arrow floats over the
figurine's head pointing where to go; the next progress hides it and starts the count
again. The theme says what progress is (`ThemeRun.progress`, a count that goes up) and where
to point (`hintTarget`):

- **Pack:** progress is a piece found; the arrow points at the nearest piece not yet found,
  as the crow flies (up or down too).
- **Lava:** progress is standing on a surface fewer hops from the flag than any so far
  (`hopsTo`: the fewest jumps and climbs over raised surfaces, searched back from the
  flag's surface). The arrow points one hop on: at the nearest cell of a neighbouring
  surface one hop nearer, which is where the jump or climb onto it is. On the flag's
  surface it points at the flag; off the route (a scrap with no way on), back at the start.
  Not the flag directly: from most of the route the flag is straight up through furniture,
  and the way there goes sideways or down first. Height and distance mislead the same way,
  which is why progress is hops. Being put back from the lava is not progress.

Followed to the end headless, the arrow takes Living Room from the couch to the flag in 7
hops, each one nearer, and Kitchen's pack through all 6 pieces.

## Reading the room: `room-shape.ts`

Worked out once the walkable cells are built (and again whenever they are rebuilt), from
the NavGrid's surfaces and the movement model:

- **Surfaces**: each with its median height above the ground in body heights, whether it
  is real (`realCells`, the same line the gap fill draws), and a spot near its middle.
- **Reachable**: what the figurine can get to from its start by walking, jumping, dropping
  and climbing faces.
- **Ground**: surfaces within `GROUND_BAND` (half a body height) of the ground's level.
- **The lava route**: from each raised real surface, what can be reached without setting
  foot on the ground (scraps count as stepping stones). The start reaching the most real
  surfaces wins; of equal ones the largest.
- **In the room**: cells over the surface the figurine starts on, seen from above, within
  `ROOM_MARGIN`. See "Placing things" below.
- **Covered**: reachable cells with collision within three body heights straight up.
  Worked out only when a theme asks.

### Measured (the shipped rooms and Playroom)

| Room | Ground share | Lava route (real tops) | Highest reachable | Covered floor | Theme |
|---|---|---|---|---|---|
| Living Room | 47% | 23 | 12.1 | 13% | lava |
| Curled Up Dog | 83% | 5 (the dog's back) | 7.9 | 2% | pack |
| Kitchen | 77% | 4 (top 1.8) | 2.0 | 2% | pack |
| Counter | 82% | 1 | 3.2 | 8% | pack |
| Playroom | 54% | 36 | 17.2 | 10% | lava |

Kitchen and Counter are tabletop scans: their ground is the table and what stands on it
is low or out of reach. Curled Up Dog is one mound. So lava suits the rooms, and the
tabletops need a rule about the ground itself.

## Rules

- **One movement model.** "Can it get from here to there" is `reach-graph.ts`, used by
  the collision health numbers and the room shape alike, fed by `reachModel` (climb.ts).
  It is a model, not the controller: walls in the way of a jump are not considered.
- **A theme only puts things where the model says the figurine can get to.**
- **The room's start is `roomSpawn`, not where the figurine is.** A theme may start it
  elsewhere (lava: on the couch). Anything measured "from the start" (the room shape, the
  collision health numbers) reads `roomSpawn`. Reading `player.position` instead made
  `collisioncheck` fail on Living Room and Playroom ("walkable from spawn" 47% → 13%):
  the collision had not changed, the figurine had moved.
- **Sizes are in body heights** (charH), as everywhere else.
- **No allocations per frame** in `updateGame` or a theme's `update`: the goal text is a
  field set when it changes, not built each frame.
- **The game is set up again whenever the walkable cells are rebuilt** (`navVersion`): a
  new room, the figurine's real height arriving, or a Debug slider. That restarts the
  room's game, progress included.
- **Things appear once the room has arrived** (`revealProgress` 1) and are hidden as it
  leaves; the goal card likewise.

## Placing things: shape is not enough

Placing the pack's gear as far apart as possible sent it to the scan's thin edge: Kitchen's
side table and chairs, the far side of Counter's worktop, Curled Up Dog's spyglass 18
body heights from the centre where 90% of the walkable cells are within 12.8. A scan is
captured looking in at what the figurine starts on, so out past that is the scan's thin
edge. `inRoom` keeps things over the start surface (plus a body height), and the pack uses
real surfaces only (a scrap is as often noise). That brought every piece inside the room.

**Still not solved:** within the room, shape cannot tell a well-captured landmark from
scan mush. In Kitchen the spyglass went to a blurry pile of clutter at the table's edge,
the compass to a chair's top rail and the lantern under something that is mostly loose
splats. How solid the scan looks at a spot (its splats' opacity there, as the gap fill and
`holes.mjs` measure it) is the likely next input.

## Known limitations

- **Setting up stalls the main thread** while the loading view is up: 80 to 210 ms on the
  tabletop rooms, 415 ms on Living Room, 1.7 s on Playroom. It is the movement model:
  Living Room's graph is 415 ms, 239 ms of it without the 38k face probes (Playroom 1681
  and 633, 169k probes). The cell-pair scan's span grows with how far a fall from a high
  cell carries. The collision health numbers pay the same cost.
- **Lava respawn is a cut**, with a note: no fade. Holding the key that walked off the
  edge walks off again.
- **The lava's outline is stepped**: a square per walkable cell.
- **Gear placement within the room** (above).
- **Placeholder art**: the flag, the gear and the hint arrow are primitives in the scan's
  light; the lava is a first-pass shader. The arrow (0.4 body heights) is small on screen.
- **The pack's arrow points as the crow flies**, so at a piece on a top it points at the
  top, not at the way up. The lava's way of pointing (one hop on) would carry over.
- **Nothing is saved**: a reload, or a rebuild from a Debug slider, starts the room's game again.
- **Not judged:** whether either theme is fun. That needs a person playing.

## Measuring

`window.__dbg.game` (`?tel=1`) has the theme, the goal text, why each theme does or does
not suit the room, and the theme's own state: for lava the start, the flag, the route's
size, respawns and whether the flag was reached; for the pack each piece's place and
whether it was found; `progress` and `hint` (whether the arrow shows, where it points, the
seconds without progress). The console logs `game: <theme> in <ms>` on every setup.

A headless check can walk off the lava start with `__step` and watch `respawns`, or put the
figurine on a piece with `placeFigurine` (from the live module) and watch `found`. To test
the hint, `__step([], 21)` stands still past it; putting the figurine at `hint.at` and
stepping a frame follows it.

## Where this is heading (decided, not built)

- **The world is whimsical and partly real**, not childlike pretend: a theme puts things
  in the room (lava that glows, the Wonderer's gear) rather than only describing it.
- **Themes change the rules**, not just the look: the flood (rising water), the long
  winter (slippery tops), the volcano (one big climb: Curled Up Dog), a kingdom on the
  table (for tabletop scans).
- **The spilled pack's gear can matter later**: the lantern for covered places, the rope
  for climbs.
- **Later:** a journal or stamp card per room, an atlas across rooms; an LLM naming a
  room's landmarks from its shape numbers (nothing private leaves the device).
- **Tried and rejected in discussion:** fireflies as the fallback (no reason to collect
  them); a kid's make-believe framing (too childlike); themes as decoration only (a
  diorama, not a game).
