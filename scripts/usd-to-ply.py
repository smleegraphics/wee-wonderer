# Export a Gaussian splat stored in USD (a ParticleField3DGaussianSplat prim, as RenderMan
# and Houdini write) to a standard 3DGS binary PLY that the app and splat-transform read.
# A spike: see context/usd-splats.md for what was measured and what is still open.
#
#   python3 -m venv .usd-venv && .usd-venv/bin/pip install usd-core==26.8 numpy==2.3.4
#   .usd-venv/bin/python -I scripts/usd-to-ply.py <in.usdc> scans/<name>.ply [--prim /scan]
#
# Then, as for any scan: npx -y @playcanvas/splat-transform@3.8.0 scans/<name>.ply scans/<name>.spz
#
# USD and the PLY layout store three things differently, converted here:
#   - scales: USD linear, PLY natural log
#   - opacities: USD 0..1, PLY logit (clamped so 0 and 1 stay finite)
#   - orientations: USD quatf, which numpy reads as (x, y, z, w); PLY rot_0..3 is (w, x, y, z)
# Colour is degree-0 spherical harmonics in both: USD's coefficient is PLY's f_dc as it is
# (checked against the file's primvars:capturedBaseColor = 0.5 + SH_C0 * coefficient).
# Higher SH degrees are not handled yet: the one file tried had degree 0.

import sys
import numpy as np
from pxr import Usd

args = sys.argv[1:]
prim_path = '/scan'
if '--prim' in args:
    i = args.index('--prim'); prim_path = args[i + 1]; del args[i:i + 2]
if len(args) != 2:
    sys.exit('usage: usd-to-ply.py <in.usd*> <out.ply> [--prim /scan]')
src, dst = args

stage = Usd.Stage.Open(src)  # keep the stage alive: its prims expire with it
prim = stage.GetPrimAtPath(prim_path)
if not prim or prim.GetTypeName() != 'ParticleField3DGaussianSplat':
    sys.exit(f'{prim_path} is not a ParticleField3DGaussianSplat in {src}')

def attr(name):
    value = prim.GetAttribute(name).Get()
    if value is None: sys.exit(f'{prim_path} has no {name}')
    return np.array(value)

degree = prim.GetAttribute('radiance:sphericalHarmonicsDegree').Get()
if degree != 0:
    sys.exit(f'spherical harmonics degree {degree}: only degree 0 is handled (see the header)')

pos = attr('positions').astype(np.float32)
sh = attr('radiance:sphericalHarmonicsCoefficients').astype(np.float32)
opa = attr('opacities').astype(np.float64)
scl = attr('scales').astype(np.float64)
rot = attr('orientations').astype(np.float64)[:, [3, 0, 1, 2]]  # (x, y, z, w) → (w, x, y, z)
rot /= np.linalg.norm(rot, axis=1, keepdims=True)
n = len(pos)
if not all(len(a) == n for a in (sh, opa, scl, rot)):
    sys.exit('per-splat arrays differ in length')

eps = 1e-6
opa = np.clip(opa, eps, 1 - eps)
cols = np.concatenate([pos, sh, np.log(opa / (1 - opa))[:, None], np.log(np.maximum(scl, 1e-12)), rot], axis=1).astype('<f4')
names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
header = ('ply\nformat binary_little_endian 1.0\ncomment exported from USD ParticleField3DGaussianSplat\n'
          f'element vertex {n}\n' + ''.join(f'property float {p}\n' for p in names) + 'end_header\n')
with open(dst, 'wb') as f:
    f.write(header.encode())
    f.write(cols.tobytes())
print(f'{n} splats → {dst}')
