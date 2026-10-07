// The parts of three's GaussianSplat this app reaches into that it does not make
// public. All of them are named here, so a three.js upgrade has one place to check.

import type { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';

/**   _buffers.centerRead — the splats' centres, as a GPU storage buffer
 *    _sort.orderRead     — the draw order: which splat each drawn instance is
 *    _sortInitialized    — false makes the next render sort again, whatever the view
 *    _precomputedSphericalHarmonicsVertexNode, _sphericalHarmonicsVertexNode — the
 *        vertex stages the splat puts on its material before every draw (it picks
 *        one per backend), so replacing these is the only way to change where a
 *        splat is drawn: anything set on material.vertexNode directly is overwritten */
export type SplatInternals = {
  _buffers?: { centerRead?: any };
  _sort?: { orderRead?: any };
  _sortInitialized: boolean;
  _precomputedSphericalHarmonicsVertexNode: any;
  _sphericalHarmonicsVertexNode: any;
};
export function splatInternals(splat: GaussianSplat): SplatInternals { return splat as unknown as SplatInternals; }
