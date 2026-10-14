# Frame time

What a frame costs and what has been measured about it. Read this before changing the
renderer's setup, the resolution, or how many splats a scan has.

## It is the graphics card, and it is the splats

While walking in Playroom the main thread is 96% idle (a CPU profile over 6 s). The game
code, the collision mesh (743k triangles in Playroom) and the walkable grid are not what
a slow frame is waiting for. The frame is waiting for the splats to be drawn.

Playroom has 1.92 million splats (a 475 MB file). The cleaned demo scans have about a
tenth of that (Kitchen 162 thousand, 40 MB).

## Measuring it: `scripts/frametime.mjs`

`node scripts/frametime.mjs [scan.ply ...] [--ratio 2] [--seconds 8]` walks and turns the
figurine for 8 s at 1440 × 900 in headless Chrome on the machine's own graphics card
(`--enable-gpu --use-angle=metal`), and prints the average time a frame took. With no
scans named, Kitchen and Playroom.

- **The numbers move between runs.** Playroom, three runs of the same code in a row:
  47.8, 46.6 and 36.7 ms. Run it several times, and compare a change with what it
  replaced in the same sitting, not with numbers from another day.
- A real browser window gives different numbers again. Kitchen at 60 fps is the cap, not
  its cost.
- The rows below that switch off one thing (re-sorting, the colour pass) were measured by
  patching the page for the run; the script does not do that.

## What was measured

All in one sitting, walking and turning for 8 s, 1440 × 900 at pixel ratio 2, Apple GPU
(Metal). Compare the rows with each other, not with a later run.

| Setup | ms a frame |
|---|---|
| Kitchen, MSAA on | 39.1 |
| Kitchen, MSAA off | 16.6 (the 60 fps cap) |
| Playroom, MSAA on | 89.7 |
| Playroom, MSAA off | 66.8 |
| Playroom, MSAA on, pixel ratio 1.5 | 73.6 |
| Playroom, MSAA on, pixel ratio 1 | 49.1 |
| Playroom, MSAA off, pixel ratio 1.5 | 46.4 |
| Playroom, MSAA on, re-sorting off | 82.7 |
| Playroom, MSAA on, the per-frame colour pass off | 89.6 |

## MSAA is off

`WebGPURenderer` is made with `antialias: false`. With it on, every splat is blended at
several samples a pixel, and a splat is a soft blob with no edge for that to smooth. The
cost of having it off is that the figurine's outline and the paper pieces in the 3D view
are not smoothed; at pixel ratio 2 that was looked at and accepted. If it ever shows, an
edge-smoothing pass over the finished frame gives it back without the per-splat cost.

## Not done

- **Lower resolution.** It is the next largest gain for Playroom (see the table) and it
  softens everything, the figurine included. Decided against for now.
- **Fewer splats in Playroom.** With MSAA off and a lower pixel ratio Playroom is still
  near 40 ms, which is the splats themselves. A thinned file would lower that and the
  download. Not measured: how many splats can go before it shows. The floater cleaner
  cannot be used on this scan (`context/collision.md`).
- **Drawing only the splats at a lower resolution**, with the figurine and UI sharp. Not
  measured; a large change to how a frame is drawn.
- **Sorting and the per-frame colour pass** are not worth working on: 8% and 0%.
