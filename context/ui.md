# UI

The on-screen UI is cut paper laid over the scan: off-white pieces with lopsided
hand-cut edges and a hard slate shadow, pixel lettering for labels and printed
capitals for text. The reference is the HUD of Messenger (messenger.abeto.co):
almost nothing on screen, a few small icon tiles at the window's edge, and cards
that unfold from them.

## What is on screen

- **Tiles.** Rooms (top-right); Back to the start and Debug (bottom-right).
- **Cards.** Rooms and Debug unfold beside the tile column. At most one is open;
  `Escape` folds it. `` ` `` toggles Debug.
- **Controls hint** (bottom-left), **status note** (top-centre).
- **Loading view** while a scan is fetched and its collision built, and until the
  figurine has loaded. There is no room yet: the figurine stands idle on a rippling
  sheet of hole-punch dots, itself drawn as paper dots, with a "Building the room…"
  note.
- **Room reveal** when the loading view ends: the scan's own points start out as the
  sheet's dots and lift off to where they belong, in 3D, nearest the figurine first,
  while the figurine's dots close up and it takes its colours. It lasts
  `REVEAL.seconds`.
- **The surround.** The space around a scan is the `--sky` token (paper-blue) while
  waiting and darkens to `--beyond` (near-black) as the room arrives, following the
  reveal's progress (`SURROUND` in `main.ts`), so a scan's gaps and edges recede.
- **Title screen**, the first time the game is opened on a device only
  (`localStorage['ww.titleSeen']`). To see it again, remove that key.

## Where things are

| File | What it holds |
|---|---|
| `src/ui/ui.css` | Every style. Tokens at the top, on `.ww-ui`. |
| `src/ui/paper.ts` | The building blocks: `piece` (shadow holder + cut face), `tile`, `el`, the icon paths |
| `src/ui/hud.ts` | `createHud`: builds all of it, owns what is open, returns the `Hud` handle |
| `src/ui/debug-panel.ts` | The Debug card: `section()` → `addToggle` / `addSlider` |
| `src/paper-bits.ts` | The sheet of paper dots: where they sit and what a dot looks like. One set of formulas, used by both files below |
| `src/loading-scene.ts` | The stand-in dots drawn before a scan has loaded (one instanced sprite) |
| `src/room-reveal.ts` | The room's arrival: per-splat journey in the scan's own shader |
| `src/paper-figurine.ts` | The figurine's paper-dots look while waiting, and how it becomes itself |
| `src/splat-internals.ts` | The private parts of three's `GaussianSplat` the app reaches into, in one place |

`main.ts` creates one `hud` and never touches UI DOM. It tells the HUD what happened
(`setCurrentRoom`, `addRoom`, `status`, `setLoading`) and is called back with what
the player asked for (`onPickRoom`, `onImport`, `onReset`).

## Rules

- **Restyle through tokens.** Colours, fonts, tile size, wonkiness and shadow offset
  are custom properties on `.ww-ui`. Components read tokens and never hold a colour
  or a font of their own. A different look should be a different token block.
- **A piece is two elements.** The holder casts the shadow (a `drop-shadow` filter)
  and the `.ww-face` inside is cut with `clip-path`. A `box-shadow`, border or
  outline on a clipped element is clipped away with it, which is why the shadow and
  the keyboard-focus ring are done the way they are.
- **Neighbours get different cuts.** Pass a running index to `piece` / `tile`.
- **The UI root does not take the mouse** (`pointer-events: none`); only its
  children do. Anything full-window that should let the orbit camera through must
  keep that.
- **Keys pressed on a UI control are not for the figurine.** `keyEvent` drops
  key-downs whose target the HUD owns, and all of them while the title is up.
  Key-ups always pass, so a held key cannot stick.
- **A control clicked with the mouse gives up focus** (one handler on the UI root),
  so Space stays "jump". Do not add per-button `blur()` calls. It also means no
  control may need to keep focus to work: a native `<select>` closes the moment it
  opens (measured: blurred 41 ms after the click). A pick-one control must be a row
  of buttons.
- **Debug tunables go in a section of the Debug card**, in `setupDebugMenu`. Give
  every control a help string: it shows in the strip pinned at the bottom of the card.
- **Status kinds:** `busy` stays until replaced, `done` clears itself, `error` stays
  until clicked. Errors must be `error` so they are readable over the loading screen.

## How the loading view and the reveal are drawn

Everything is in the 3D scene, so there is no hand-over between layers.

- **Before the scan has loaded** there are no splats, so `loading-scene.ts` draws
  stand-in dots (`BITS.count` of them) on the sheet's grid, coloured from the UI's
  `--paper` token (`hud.token`).
- **The reveal** (`room-reveal.ts`) is part of how the scan draws itself:
  `installReveal` wraps the splat's vertex stage and colour. Each splat starts as a
  paper dot of fixed size on screen, on the grid point straight below its place
  (`paper-bits.ts`), and travels up to its real place, growing into the splat it is
  and taking its colour on the way. Over the first `HANDOVER` of the reveal the
  stand-ins fade out as the scan's own dots fade in underneath, in the same places.
  `RISE.dense` is how many of the scan's points start as dots per stand-in dot; the
  rest stay unseen until they are nearly home.
- **The figurine** (`paper-figurine.ts`) is drawn in paper-coloured dots on a screen
  grid, the same size as a punch dot (`PUNCH_PX`). `show(arrived)` takes the reveal's
  progress: the dots grow until they close up, then its lit colours soak in. This
  hides the change of lighting: the scan's light is captured on the first frame of
  the reveal, while the figurine is still plain paper.

At rest (`progress = 1`) the reveal reduces to "draw the splat unchanged", and the
figurine's material to its normal output.

`loadingViewOn()` in `main.ts` is the one definition of "loading"; `updateLoading()`
applies it and starts the reveal when the view ends. Call `updateLoading()` after
changing anything it reads.

## Gotchas

- **A splat's vertex stage cannot be set on its material.** `GaussianSplat` puts its
  own vertex node back before every draw. `installReveal` replaces the two nodes it
  chooses from (`splat-internals.ts`); setting `material.vertexNode` directly is
  undone on the next frame and forces a recompile each time.
- **Anything that must see the whole scan mid-reveal pauses it.** The light probe
  does (`revealPaused()` in `captureScanLight`); without that, a probe taken as the
  room arrives lights the figurine from an empty room.
- **The reveal's front runs to infinity, on purpose.** It crosses the room in the
  first half of the time and then accelerates away, so far-off floaters cannot hold
  the end up and every splat is guaranteed drawn normally when it finishes.
- **A shader value used in several sibling `If` blocks must be its own variable
  (`.toVar()`) before them.** TSL computes a shared expression only inside the first
  block that uses it and leaves it unset in the others. Found when the reveal had
  several styles, one block each, sharing a clock: only the first block's style ever
  arrived.
- **The scan's light must be captured before the figurine's colours show.** It is
  today because `requestScanLight()` is called when the load ends and the capture is
  taken on the next frame, the first of the reveal; the figurine stays paper until
  `ARRIVE.colour[0]` of the way through. A room switch cross-fades the light over
  `SCAN_LIGHT.blend` (0.4 s), which must stay shorter than that part of
  `REVEAL.seconds`.
- **The figurine's materials are converted to node materials at load**
  (`renderer.library.fromMaterial`, the conversion the renderer would do itself on
  first draw), so the dots and paper colour have somewhere to go. Anything that
  swaps the figurine's materials later must go through `paper-figurine.ts`.
- **Splats do not composite onto a see-through canvas.** Tried for the first loading
  view: with `scene.background = null` and a scan visible, splats come out fainter
  (27.6 dB PSNR against the normal render on Kitchen, where two identical runs give
  57 dB). Keep the scene background opaque.
- **`--sky` and `--beyond` must stay plain colour values**, not `color-mix()`: the 3D scene reads
  it through `hud.token`, and three.js cannot parse a CSS colour function. `index.html`
  repeats the value for the first paint.
- **The page must stay responsive while a scan loads**, or the waiting figurine
  freezes. The `.ply` is fetched and parsed in `load-scan.worker.ts` for that reason.
  Before, parsing the 453 MB Playroom blocked the main thread for about 10 s and a
  click on Begin did nothing until it ended.

- **Headless scripts start with the title screen dismissed.** A fresh browser profile
  counts as a first visit, and the title takes the keyboard. `shot.mjs`,
  `climbfuzz.mjs` and `drive.mjs` set `ww.titleSeen` before the page loads;
  `drive.mjs title:1` skips that to test the title itself.
- **Find controls by name, not position.** `drive.mjs` has `tile:<name>`,
  `room:<name>` and `range:<label>=<value>`. A slider's accessible name is its label
  alone (`aria-label`), because its `<label>` also contains the readout.
- **`range:` sets the value directly** instead of dragging: the slider may be in a
  folded section of a closed card.
- **The help strip is as tall as the longest help text.** All help texts sit in one
  grid cell with one visible, so the strip never resizes or scrolls while the pointer
  moves. A very long help string makes the strip taller for every control.
- **The loading screen needs every load to finish or fail.** `loadFromURL` ends it
  through `finish`; the voxel worker now rejects on failure instead of going silent.
  A new async step in the load path must reject on failure too, or the cover stays up.
- **Slider readouts show as many decimals as the step has**, so an integer slider
  reads `6`, not `6.00`.

## Tried and rejected

- **An opaque paper cover with a bobbing doodle** as the loading screen, then **a
  flat backdrop behind the canvas** (a paper stage, and a doodled room in SVG) with
  the figurine in front. Both ended in a hard cut to the room, which felt abrupt.
- **Flat screen-space reveals** (a growing circle, falling tiles, a cross-fade),
  mocked up before the 3D versions. Passed over for reveals inside the scene.
- **A paper mat and drifting scraps as separate meshes**, replaced at the end by the
  room. Any waiting scene that is not what the room is made of needs a swap; the bits
  are the scan's own points for that reason.
- **Four other reveals**: paper snowfall (scraps fall and pile up into the room),
  turning pages (the room lies flat in slices that swing up), paper confetti (a
  drifting field of scraps flies home) and unfold (the room appears outward from the
  figurine with no journey). All worked; the sheet was preferred, and the others and
  their Debug switch were removed. Variants that differed only in the bit's look
  read as the same effect.
- **A native `<select>` in the Debug card.** See the focus rule above.
- **Paper-blue around the scan during play.** Every gap in a scan and everything past
  its edges showed light blue, which is a lot of blue on the tabletop scans.
- **Greying out Begin until loading finished.** It would have hidden the frozen page
  without unfreezing it.

- **Four other looks** (soft clay, stickers, storybook, toybox) and a restyled
  top-left bar were mocked up and passed over for paper tiles.
- **Help text at the end of the scrolling list.** It scrolled out of view for the
  upper controls. It is pinned now.
- **Help text in a fixed-height strip.** Long texts needed scrolling, which is
  impossible without moving the pointer off the control.
- **A `?play=1` flag to skip the title in tests.** Setting the storage key from the
  scripts does the same without a test-only path in the app.

## Known limitations

- Three shorter main-thread stalls remain near the end of a load (about 0.5 s
  levelling the scan and copying it to the collision worker, about 1.0 s building
  the NavGrid, about 0.4 s on the first frames with the room visible; headless
  numbers on Playroom). The waiting figurine hitches during them.
- Switching rooms removes the old room at once; only the new room's arrival is animated.
- Splats are sorted by where they belong, not where they are drawn, so a few may
  draw in the wrong order for a moment while they travel.
- The figurine's dots are fixed to the screen, so they slide over it as it or the
  camera moves during the fill-in.
- Checked headless by stills only (the room arrives and the figurine fills in on
  Kitchen). Smoothness of the motion needs a person.
- There is no Debug control to hold the loading view or replay the reveal; reload, or
  switch rooms, to see them again.

- No touch controls; the HUD is laid out for a desktop window.
- Drag-and-drop and file-picker import are not covered by a headless check.
- The scan-light debug view draws its panorama bottom-left, under the controls hint.
- A debug slider that rebuilds collision does not show the loading screen (by
  design: you want to watch the mesh change), so there is no progress cue for it.
