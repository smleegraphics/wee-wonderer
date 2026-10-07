// How the figurine looks while it waits for a room: cut from the same paper as the bits
// around it, and drawn in the same hole-punch dots. As the room arrives its dots grow
// until they close up, and then its own colours soak in. The room's light reaches the
// figurine at the start of the arrival (main.ts, captureScanLight), while it is still
// plain paper, so that change is never seen. Once the arrival is over the figurine is
// drawn exactly as it would be without this file. See context/ui.md.

import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { mix, output, screenCoordinate, uniform, vec4 } from 'three/tsl';
import { PUNCH_PX } from './paper-bits';
import { HANDOVER } from './room-reveal';

const DOTS = { pitch: 2.6 }; // from one dot's middle to the next, in dot radii: close enough that the figurine's outline still reads
// parts of the room's arrival: the dots grow once the waiting bits have handed over, and the colours follow while the last gaps close
const ARRIVE = { grow: [HANDOVER, 0.5], colour: [0.35, 0.7] };

export interface PaperFigurine {
  /** `arrived`: how far the room's arrival has got. 0 = paper dots, 1 = the figurine itself. */
  show(arrived: number): void;
}

export function createPaperFigurine(model: THREE.Object3D, renderer: WebGPURenderer, paperColour: string): PaperFigurine {
  const grown = uniform(0);   // 0 = dots the size of the waiting bits', 1 = closed up, no gaps
  const soaked = uniform(0);  // 0 = paper, 1 = its own lit colours
  const paper = uniform(new THREE.Color(paperColour));

  // a grid of dots fixed to the screen, like the waiting bits (which are a fixed size on screen too)
  const pitch = PUNCH_PX * DOTS.pitch;
  const fromDot = screenCoordinate.xy.div(pitch).fract().sub(0.5).length().mul(pitch); // px from the middle of the nearest dot
  const closed = pitch * Math.SQRT1_2; // the radius at which neighbouring dots cover the corners between them
  const inDot = fromDot.lessThan(mix(PUNCH_PX, closed, grown)).or(grown.greaterThanEqual(1));
  const colour = vec4(mix(paper, output.rgb, soaked), output.a);

  // The loader's materials are the classic kind, which the renderer turns into node
  // materials when it first draws them. Do that here, the same way, to have somewhere to
  // put the dots; one per material, since meshes may share them.
  const library = (renderer as unknown as { library: { fromMaterial(m: THREE.Material): THREE.Material | null } }).library;
  const converted = new Map<THREE.Material, THREE.Material>();
  const paperVersion = (material: THREE.Material): THREE.Material => {
    let made = converted.get(material);
    if (!made) {
      made = library.fromMaterial(material) ?? material;
      const nodes = made as unknown as { isNodeMaterial?: boolean; maskNode: unknown; outputNode: unknown };
      if (nodes.isNodeMaterial) { nodes.maskNode = inDot; nodes.outputNode = colour; }
      else console.warn(`paper figurine: no node material for ${material.type}, so it is drawn as itself while waiting`);
      converted.set(material, made);
    }
    return made;
  };
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(paperVersion) : paperVersion(mesh.material);
  });

  return {
    show(arrived) {
      grown.value = THREE.MathUtils.smoothstep(arrived, ARRIVE.grow[0], ARRIVE.grow[1]);
      soaked.value = THREE.MathUtils.smoothstep(arrived, ARRIVE.colour[0], ARRIVE.colour[1]);
    },
  };
}
