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
3. The result is `scene.environment`. The hemisphere fill is switched off while it
   is in use. The fixed sun is still on.

It is captured a few frames after a scan loads and the figurine is placed. With
"Scan light: follow figurine" on, it is re-captured when the figurine has moved one
body-height from the last capture point, at most twice a second.

## What is known

- **The native `GaussianSplat` renders correctly into a cube camera.** This was the
  main risk.
- **A capture costs about 5 ms of main-thread time** on Counter (45 ms the first
  time). GPU time was not measured separately.
- **It only sees colours.** The scan is low dynamic range, so a window and a white
  wall can read as equally bright; strong sources are underestimated.
- **Where the scan has no splats the probe sees the dark backdrop**, so the figurine
  is under-lit near holes or in scans with no ceiling.
- Only tested on Counter.

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

- **Re-captures swap instantly.** If follow mode pops, cross-fade between the old
  and new capture.
- **The thresholds are first guesses** (one body-height, half a second).
- **The fixed sun points the same way in every scan** and probably fights the scan
  lighting. There is a "Sun strength" slider to judge it.
- **A possible one-frame flash on capture**, from the splats being re-sorted for the
  probe's views. A headless measurement on Counter was at noise level, and
  re-sorting for the main camera straight after the capture made no clear
  difference, so nothing was changed.
- No contact shadow. The collision mesh could act as a shadow receiver.
