// The parts of three.js this app reaches into that it does not make public. All of
// them are named here, so a three.js upgrade has one place to check.

import type { Material } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';

// --- GaussianSplat

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

// --- WebGPURenderer
/** The node material the renderer would itself make from a classic `material` the first
 *  time it drew it (renderer.library.fromMaterial), or null if it has none for that kind. */
export function nodeMaterialFor(renderer: WebGPURenderer, material: Material): Material | null {
  return (renderer as unknown as { library: { fromMaterial(m: Material): Material | null } }).library.fromMaterial(material);
}
