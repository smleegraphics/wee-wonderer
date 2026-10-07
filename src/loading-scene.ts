// What the figurine waits in while a scan loads: paper bits in one of the waiting
// arrangements (paper-bits.ts). When the scan arrives its own points start out in the
// same arrangement, looking the same (room-reveal.ts), so these stand-ins only have to
// fade away underneath.

import * as THREE from 'three';
import { SpriteNodeMaterial } from 'three/webgpu';
import { cameraProjectionMatrix, float, instanceIndex, screenSize, uniform, uv, vec2, vec4 } from 'three/tsl';
import { ARRANGE, BITS, LOOK, bitShape, fieldPosition, pagesPosition, rimFade, scrapColour, scrapTumble, sheetPosition, snowPosition } from './paper-bits';

export interface LoadingScene {
  object: THREE.Object3D;
  /** Move the bits to where the figurine is standing. */
  place(at: THREE.Vector3): void;
  /** `presence`: 1 while waiting, falling to 0 as the scan's own bits take over. `as`: how they look (LOOK) and are arranged (ARRANGE). */
  show(presence: number, as: { look: number; arrange: number }): void;
}

export function createLoadingScene(charH: number, colours: { paper: string; accent: string; ink: string }): LoadingScene {
  const bodyHeight = uniform(charH), presence = uniform(1), look = uniform(LOOK.scrap), arrange = uniform(ARRANGE.field);
  const paper = uniform(new THREE.Color(colours.paper)), accent = uniform(new THREE.Color(colours.accent)), ink = uniform(new THREE.Color(colours.ink));
  const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false, sizeAttenuation: false });
  const n = float(instanceIndex);
  const at = arrange.equal(ARRANGE.sheet).select(sheetPosition(n, bodyHeight),
    arrange.equal(ARRANGE.snow).select(snowPosition(instanceIndex, bodyHeight),
      arrange.equal(ARRANGE.pages).select(pagesPosition(n, instanceIndex, bodyHeight), fieldPosition(instanceIndex, bodyHeight))));
  const tumble = scrapTumble(instanceIndex);
  const isScrap = look.equal(LOOK.scrap);
  material.positionNode = at;
  // sizeAttenuation off: a sprite's scale is its height at one unit from the camera, so
  // this is the scale that makes its square quadPx from middle to side at any distance
  // (typed loosely: the types do not describe matrix element access)
  const side = float(4 * BITS.quadPx).div((cameraProjectionMatrix as any).element(1).element(1).mul(screenSize.y));
  material.scaleNode = vec2(side.mul(isScrap.select(tumble.width, float(1))), side);
  material.rotationNode = isScrap.select(tumble.angle, float(0));
  const q = uv().sub(0.5).mul(4); // the sprite's square in a splat quad's coordinates, so the shapes are the same ones
  material.colorNode = vec4(
    isScrap.select(scrapColour(instanceIndex, tumble.faceUp, paper, accent, ink), paper),
    bitShape(look, q, instanceIndex).mul(rimFade(at, bodyHeight)).mul(presence),
  );
  const bits = new THREE.Sprite(material as never);
  (bits as unknown as { count: number }).count = BITS.count;
  bits.frustumCulled = false; // the bits are placed in the shader, far from the one sprite the bounds describe

  return {
    object: bits,
    place(to) { bits.position.copy(to); },
    show(amount, as) { presence.value = amount; look.value = as.look; arrange.value = as.arrange; bits.visible = amount > 0; },
  };
}
