# Splats from USD (spike)

A Gaussian splat stored in USD can be brought into the app: `scripts/usd-to-ply.py`
writes a standard 3DGS PLY, and from there it is a scan like any other (convert to SPZ,
put it in `scans/`, load with `?scan=`). Nothing in the app is USD-aware.

Tried once, on RenderMan's Houdini example scene (`pixar-lamp-and-ball.usdc`, the
Luxo Jr. lamp and ball statue). **That scan is not ours to ship**: see "Licensing".

## Steps

```bash
python3 -m venv .usd-venv && .usd-venv/bin/pip install usd-core==26.8 numpy==2.3.4
.usd-venv/bin/python -I scripts/usd-to-ply.py <in.usdc> scans/<name>.ply
npx -y @playcanvas/splat-transform@3.8.0 scans/<name>.ply scans/<name>.spz
# then http://localhost:5173/?scan=<name>.spz
```

`.usd-venv/` is gitignored. OpenUSD 26.8 has macOS wheels for Python 3.9 to 3.14.
Treat a downloaded `.usd*` as untrusted data: run the script from the repo with `-I`
and pass the file as an argument; never run code that came with it.

## What the file holds, and how it maps

One prim, `/scan`, of type `ParticleField3DGaussianSplat` (OpenUSD's own splat schema),
Y-up. Per splat:

| USD attribute | PLY property | Conversion |
|---|---|---|
| `positions` | `x y z` | as is |
| `scales` (linear) | `scale_0..2` | natural log |
| `opacities` (0 to 1) | `opacity` | logit, clamped to keep 0 and 1 finite |
| `orientations` (quatf) | `rot_0..3` (w, x, y, z) | numpy reads a `VtQuatfArray` as (x, y, z, w): reordered |
| `radiance:sphericalHarmonicsCoefficients`, degree 0 | `f_dc_0..2` | as is |

The colour mapping was checked, not assumed: the file also stores
`primvars:capturedBaseColor`, and 0.5 + SH_C0 × coefficient reproduces it (0.9755 from
1.685629 on the first splat). Other attributes (`estimatedNormal`, the `*h` half-float
variants, which were empty) are not used.

Gotcha: `Usd.Stage.Open(path).GetPrimAtPath(...)` without keeping the stage in a
variable fails with "Accessed invalid expired prim": the stage is freed at once.

## Measured (the Pixar scan)

| | Kitchen (for comparison) | Pixar lamp and ball |
|---|---|---|
| Splats | 162k | 1.26 million |
| `.usdc` / `.ply` / `.spz` | – / 40.3 / 3.1 MB | 100.5 / 70.4 / 20.3 MB |
| Export (`usd-to-ply.py`) | | 0.8 s (a per-splat Python loop over the quaternions took 44 s) |
| Collision build | under 1 s | 3.7 s, 655,914 triangles at detail 2 |
| Walkable area (grains²) | 4,677 | 23,354 |
| Walkable from spawn / with jumps and drops | 54.8% / 74.1% | 3.3% / 78.0% |
| Mesh to splats, median (grains) | 0.60 | 0.42 |

It levels itself correctly (the courtyard flat) and the figurine starts on the lamp's
round base, which is why only 3.3% is reachable on foot from spawn: the courtyard is a
jump down. `climbfuzz` seeds 1 to 3, 60 s: 0 violations, but only 0 to 2 climb samples,
so the climbing on its round shapes is barely tested.

## Licensing

The example folder states no licence for the scan; its README credits "Kosmo" for the
capture hardware. Permission from whoever made the scan would cover the scan, but the
lamp and ball are Pixar's designs and trademarks, and a scan of a sculpture is a copy
of it (the US has no general freedom-of-panorama exception for sculpture). Shipping it
publicly would likely need Pixar's permission as well. Until then it is a local test
scan only: not in `SCANS` as listed, never uploaded.

## Not done

- SH degrees above 0 (would map to `f_rest_*`, whose ordering differs between
  conventions: check against a file that has them).
- `.usda` / `.usd` inputs and files with several splat prims (`--prim` picks one).
- Importing USD in the app.
