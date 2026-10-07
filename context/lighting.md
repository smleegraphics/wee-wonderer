# Lighting the figurine from the scan

How the figurine picks up the scan's lighting, and what was tried. Read this before
changing lights, the environment map, or anything that renders the splats from a
second camera. The code is in `src/main.ts` (`SCAN_LIGHT`, `captureScanLight`,
`applyScanLight`, `updateScanLight`).

## The problem

A splat scan has its lighting baked into the splat colours. There are no light
sources to query. The figurine was lit by one fixed hemisphere light and one fixed
directional "sun", the same in every scan and every spot.

## What it does now

One light probe, captured at the figurine.

1. Hide the figurine and debug overlays; set the backdrop to the plain colour.
2. `PMREMGenerator.fromScene(scene, …, { position })` renders the splats into a
   cubemap from the figurine's head height and prefilters it (64 px).
3. The result becomes the scene's environment light. While it is in use, both fixed
   lights (the hemisphere fill and the sun) are switched off; they remain as the
   fallback when scan lighting is off, and for the `?meshonly=1` view.

It is captured a few frames after a scan loads and the figurine is placed. With
"Scan light: follow figurine" on, it is re-captured when the figurine has moved one
body-height from the last capture point, at most twice a second.

**Gap fill.** Where the scan has no splats (usually the ceiling, which phone scans
rarely capture), the probe would see the dark backdrop and read it as "no light from
there", leaving the figurine dark on top. During a capture the backdrop is instead
`scanFill`: the average colour of the scan's upper half, computed once at load by
`estimateScanFill` (splats above the median height, weighted by opacity × size). It
is an estimate, not a measurement. It only shows through where nothing was captured,
so a scan with a real ceiling is unaffected. This is the same idea as a game
engine's ambient-probe fallback; the research equivalent is inpainting the
environment map with a diffusion model (ComGS), which is far too heavy here.

**Debug view.** "Scan light: debug view" shows a panorama of the capture in the
bottom-left corner (up at the top, down at the bottom, all the way round left to
right) and three balls above the figurine lit by it: a mirror, a half-rough metal
and a matte white one. The panorama is the thing to look at first when lighting
seems wrong: a band of one flat colour is a gap being filled.

**Cross-fade.** There are two captures, not one. A new capture is rendered into
whichever is not showing, and `scanLightMix` fades over to it ("Scan light: blend",
0.4 s by default). The environment is a node, `mix(pmremTexture(a), pmremTexture(b),
scanLightMix)`, set as `scene.environmentNode`, so the fade is one uniform and never
rebuilds a shader. A new capture waits until the current fade has finished.

## What is known

- **The native `GaussianSplat` renders correctly into a cube camera.** This was the
  main risk.
- **A capture costs about 5 ms of main-thread time** on Counter (45 ms the first
  time). GPU time was not measured separately.
- **It only sees colours.** The scan is low dynamic range, so a window and a white
  wall can read as equally bright; strong sources are underestimated.
- **Where the scan has no splats the probe sees the dark backdrop**, so the figurine
  is under-lit near holes or in scans with no ceiling.
- **The cross-fade removes the pop.** On a fixed 4 s walk on Counter with two
  re-captures, the figurine's on-screen brightness jumped by 22.8 and 12.8 (of 255)
  in single frames without blending, and those two jumps were gone with it. Repeated
  twice with the same numbers.
- **Without the sun the figurine is darker and flatter** than under the fixed lights,
  because the scan's light is low dynamic range. "Scan light: strength" is still 1.
- **Tested on all four demo scans** (headless, one walk each). No errors on any.
  - *Playroom:* the figurine picks up the warm colour of the play mat and reads as
    well lit. This is the scan it suits best: enclosed, bright, colourful.
  - *Kitchen and Counter* (tabletop scans surrounded by empty space): the figurine
    is dark, because most directions see the black backdrop.
  - *Living Room:* dark and flat.
- **Do not let `PMREMGenerator` paint the backdrop.** Given a solid-colour
  `scene.background` it draws a unit box at the world origin, once, from wherever its
  cube camera was left by the *previous* capture. So the first two captures look
  right, and any capture after one taken more than half a unit from the origin gets
  black gaps. On Counter (spawn at y = 1.4) 38–47% of the panorama was near-black
  with the fill switched on. The probe now uses its own dome (`scanFillDome`),
  centred on the probe, with `scene.background` null; near-black dropped to 0–1%.
  Earlier brightness numbers for Counter and Kitchen were taken with this bug and
  are not repeated here.
- **Strength.** Face brightness at spawn (0–255) by "Scan light: strength", with the
  fill on:

  | Scan | 1 | 1.5 | 2 | 2.5 | 3 | Old fixed lights |
  |---|---|---|---|---|---|---|
  | Counter | 103 | 125 | 143 | 159 | 172 | 148 |
  | Kitchen | 111 | 134 | 153 | 169 | 184 | 144 |
  | Living Room | 86 | 105 | 119 | 132 | 143 | 137 |
  | Playroom | 131 | 157 | 177 | 196 | 212 | 150 |

  The default is 1.5. At 2 the figurine is washed out and pale on Playroom; at 1 it
  is dull on the other three. Living Room stays the dimmest: its scan is dim and has
  the most gaps, so it leans hardest on the fill estimate.
- **Follow mode hitches on Playroom.** The 5 ms figure is only the time to submit a
  capture. On Playroom (30 ms a frame to begin with) the worst frame during a walk
  went from 60 ms to 128 ms with follow on, and the mean from 30.6 to 33.6 ms. On
  Living Room there was no measurable change (16.6 ms either way).
- **The cross-fade also helped on Living Room** (biggest one-frame brightness jump
  6.8 → 1.2). On Playroom it made no measurable difference (4.0 either way), and on
  Kitchen the brightness measurement was swamped by the figurine moving against
  the background.

## Tried and rejected: a probe grid

three.js ships `LightProbeGrid` (`three/addons/lighting/LightProbeGrid.js`), which
works with the WebGPU renderer: it captures a cubemap at every point of a 3D grid,
reduces each to L2 spherical harmonics in a 3D texture, and blends per pixel. It was
built over the walkable volume and removed again (it is in history as two commits
and their reverts).

- **Bake cost is about 30 ms per probe**, because each probe re-sorts and redraws
  the whole scan six times. On Counter: 2,394 probes (two body-heights apart) took
  67–80 s; 440 probes (four apart) took 12.9 s.
- **Baking in one call froze the page for over 30 s.** `bake()` takes `start` and
  `count`, so it can be spread over frames.
- **No measurable per-frame cost once baked**, and at the spawn point it looked the
  same as the single probe.
- **The walkable area is much bigger than the visible scene** (about 19 × 17 units
  on Counter), so most probes sat in space the figurine never reaches.
- Not resolved: whether it looks better while moving, and whether probes inside
  furniture cause dark patches.

For one small figurine the single probe gives the same result where compared, with
reflections, no load-time wait, and almost no cost. Revisit the grid if many objects
need lighting, or if probes can be computed from splat colours without rendering.

## Open

- **The thresholds are first guesses** (one body-height, half a second).
- **One strength for every scan is a compromise.** Scaling it per scan to a target
  brightness would even the scans out, at the cost of the figurine no longer getting
  dimmer in a dim room.
- **The fill colour is a plain average**, so it is dimmer than a real ceiling usually
  is. A brighter estimate would help gap-heavy scans such as Living Room.
- **The fill is one colour per scan.** A per-capture fill, from what each probe
  actually sees around the gap, would adapt to bright and dark parts of a room.
- **No directional key light.** The environment gives soft light only, so the
  figurine has less shape than it did under the sun.
- **A possible one-frame flash on capture**, from the splats being re-sorted for the
  probe's views. A headless measurement on Counter was at noise level, and
  re-sorting for the main camera straight after the capture made no clear
  difference, so nothing was changed.
- No contact shadow. The collision mesh could act as a shadow receiver.
