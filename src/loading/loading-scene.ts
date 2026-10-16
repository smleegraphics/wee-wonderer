// What the figurine waits in while a scan loads: the sheet of paper dots (paper-bits.ts).
// When the scan arrives its own points start out as the same dots in the same places
// (room-reveal.ts), so these stand-ins only have to fade away underneath.

import * as THREE from 'three';
import { SpriteNodeMaterial } from 'three/webgpu';
import { cameraProjectionMatrix, float, instanceIndex, screenSize, uniform, uv, vec4 } from 'three/tsl';
import { BITS, dotShape, rimFade, sheetPosition } from './paper-bits';

export interface LoadingScene {
  object: THREE.Object3D;
  /** Move the sheet to where the figurine is standing. */
  place(at: THREE.Vector3): void;
  /** `presence`: 1 while waiting, falling to 0 as the scan's own dots take over. */
  show(presence: number): void;
}

export function createLoadingScene(charH: number, paperColour: string): LoadingScene {
  const bodyHeight = uniform(charH), presence = uniform(1);
  const paper = uniform(new THREE.Color(paperColour));
  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false, sizeAttenuation: false });
  const at = sheetPosition(float(instanceIndex), bodyHeight);
  material.positionNode = at;
  // sizeAttenuation off: a sprite's scale is its height at one unit from the camera, so
  // this is the scale that makes its square quadPx from middle to side at any distance
  // (typed loosely: the types do not describe matrix element access)
  material.scaleNode = float(4 * BITS.quadPx).div((cameraProjectionMatrix as any).element(1).element(1).mul(screenSize.y));
  const q = uv().sub(0.5).mul(4); // the sprite's square in a splat quad's coordinates, so the dot is the same one
  material.colorNode = vec4(paper, dotShape(q).mul(rimFade(at, bodyHeight)).mul(presence));
  const dots = new THREE.Sprite(material as never);
  (dots as unknown as { count: number }).count = BITS.count;
  dots.frustumCulled = false; // the dots are placed in the shader, far from the one sprite the bounds describe

  return {
    object: dots,
    place(to) { dots.position.copy(to); },
    show(amount) { presence.value = amount; dots.visible = amount > 0; },
  };
}
