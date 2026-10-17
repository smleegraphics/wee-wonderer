// The figurine's contact shadow, darkened into the splats where it touches them
// (context/lighting.md).

import * as THREE from 'three';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { splatInternals } from '../three-internals';
import { uniform, varying, Fn, instanceIndex, modelWorldMatrix, vec4, If, viewportUV, cameraProjectionMatrixInverse, cameraWorldMatrix, cameraPosition, smoothstep } from 'three/tsl';
import { CAPSULE_RADIUS, figurine, player, WORLD_UP } from '../app';
import { navGrid } from '../collision/room-collision';
import { charH } from '../figurine/character';
import { CLIMB, climbDir } from '../figurine/climb';

// The scan is not a surface a shadow can be cast onto: its splats are transparent
// blobs with no depth, so anything drawn as a separate layer is either hidden under
// them or shows through whatever stands in front. So the shadow is put INTO the
// splats: a splat lying at the surface the figurine touches is darkened where it falls
// inside a soft disc around the contact point (the same idea as Spark's SplatEdit). The
// shadow then sits exactly on the visible surface and is hidden by whatever is in front.
export const CONTACT_SHADOW = { on: true, darkness: 0.55, size: 0.6 }; // size: radius in body heights
const SHADOW_THICKNESS = 0.5;  // body heights: how far above/below the feet still counts as the surface. Generous, because the
                               // visible floor is not where the feet are: measured medians of +0.18 (Playroom), -0.17 (Living Room), -0.25 (Counter)
const SHADOW_FADE_HEIGHT = 2;  // body heights off the surface at which the shadow has faded out
const SHADOW_EASE = 20;        // per second: how fast the shadow follows a change of surface (most of the way in a tenth of a second)
const SHADOW_GRAZE = 1e-3;     // a view ray this close to parallel with the surface (the sine of ~0.06°) doesn't meet it anywhere useful
const shadowCentre = uniform(new THREE.Vector3());          // where the figurine touches (or hangs over) a surface
const shadowNormal = uniform(new THREE.Vector3(0, 1, 0));   // that surface's facing: up on the ground, out of the wall when climbing
export const shadowRadius = uniform(1), shadowThick = uniform(1), shadowDark = uniform(0);

/** Make a splat object darken itself inside the contact-shadow region. Two questions,
 *  answered at different rates:
 *    - Is this splat at the contact surface? Once per splat, from its centre: how far
 *      it is off the surface (`lift`). Everything further than the shadow's thickness
 *      is left alone — that is nearly every splat, and what keeps this cheap.
 *    - Which of its pixels are in the disc? Per pixel: where the view ray through the
 *      pixel meets the plane the figurine stands on. Floors are often a few very
 *      large, flat splats (a rug in Playroom is ~500 splats per body-width), so
 *      darkening whole splats by their centre gives a faint smudge in the wrong place.
 *      It is the figurine's plane, not the splat's own level: the figurine is drawn
 *      where its feet are, which is not quite where the scan's floor is, and a disc
 *      placed at each splat's height lands visibly in front of it.
 *  It reads two things from the splat's internals (splatInternals), both already on
 *  the GPU for the splat's own drawing: its centres, and the draw order, which says
 *  which splat each drawn instance is. */
export function installContactShadow(splat: GaussianSplat): void {
  // (typed loosely: three's types don't describe the material's colour hook)
  const material = splat.material as unknown as { colorNode: any; needsUpdate: boolean };
  const internals = splatInternals(splat);
  const order = internals._sort?.orderRead, centreRead = internals._buffers?.centerRead;
  if (!order || !centreRead || !material.colorNode) { console.warn('contact shadow: this GaussianSplat does not expose its centres and draw order — shadow disabled'); return; }
  // per splat: how far its centre is off the contact surface, along the surface's normal
  const lift = varying(Fn(() => {
    const centre = centreRead.element(order.element(instanceIndex)).xyz;
    return modelWorldMatrix.mul(vec4(centre, 1)).xyz.sub(shadowCentre).dot(shadowNormal);
  })());
  const base = material.colorNode; // vec4: the splat's colour and coverage
  material.colorNode = Fn(() => {
    const c = vec4(base).toVar();
    If(lift.abs().lessThan(shadowThick).and(shadowDark.greaterThan(0)), () => {
      // per pixel: the view ray through this pixel, met with the plane the figurine stands on
      const ndc = vec4(viewportUV.x.mul(2).sub(1), viewportUV.y.oneMinus().mul(2).sub(1), 1, 1);
      const far = cameraProjectionMatrixInverse.mul(ndc);
      const ray = cameraWorldMatrix.mul(vec4(far.xyz.div(far.w), 0)).xyz.normalize();
      const from = cameraPosition.sub(shadowCentre);
      const toward = ray.dot(shadowNormal), off = from.dot(shadowNormal);       // the ray's and the camera's components along the normal
      // the ray meets the plane only if it isn't running alongside it, and only ahead of
      // the camera if it is heading toward the plane from the side the camera is on
      If(toward.abs().greaterThan(SHADOW_GRAZE).and(toward.mul(off).lessThan(0)), () => {
        const along = from.add(ray.mul(off.negate().div(toward)));               // offset from the contact point, in that plane
        const inside = smoothstep(shadowRadius, shadowRadius.mul(0.15), along.length())
          .mul(smoothstep(shadowThick, shadowThick.mul(0.6), lift.abs()));
        c.rgb.mulAssign(inside.mul(shadowDark).oneMinus());
      });
    });
    return c;
  })();
  material.needsUpdate = true;
}

/** Per frame: where the shadow falls, and how strong it is. */
const shadowAt = new THREE.Vector3(), shadowFacing = new THREE.Vector3();
export function updateContactShadow(dt: number): void {
  const p = player.position, radius = CAPSULE_RADIUS * charH;
  let height = 0; // how far the figurine is off the surface it would shadow
  if (figurine.state === 'climb') {
    // on a wall: the shadow is on the face it's hanging from, behind its body
    shadowAt.set(p.x, p.y + charH * CLIMB.chest, p.z).addScaledVector(climbDir, radius * CLIMB.gap);
    shadowFacing.copy(climbDir).negate();
  } else if (figurine.state === 'air') {
    // in the air: onto the ground it would land on, straight below
    const ground = navGrid ? navGrid.surfaceBelow(p.x, p.z, p.y + radius * 0.5) : null;
    height = ground === null ? Infinity : Math.max(0, p.y - ground);
    shadowAt.set(p.x, ground ?? p.y, p.z);
    shadowFacing.copy(WORLD_UP);
  } else {
    // standing: right where the feet are
    shadowAt.copy(p);
    shadowFacing.copy(WORLD_UP);
  }
  // ease, so stepping onto a wall or off a ledge moves the shadow instead of jumping it
  const t = Math.min(1, SHADOW_EASE * dt), normal = shadowNormal.value;
  shadowCentre.value.lerp(shadowAt, t);
  // The normal turns toward the new facing. Blending two unit vectors only does that
  // while they aren't opposed: straight across (one wall to the wall facing it) the
  // blend passes through zero, and short of halfway it normalises back to where it
  // started. There is no shorter way round to ease along, so past a right angle it jumps.
  if (normal.dot(shadowFacing) < 0) normal.copy(shadowFacing);
  else normal.lerp(shadowFacing, t).normalize();
  const fade = 1 - Math.min(1, height / (charH * SHADOW_FADE_HEIGHT)); // higher → fainter and wider
  shadowRadius.value = charH * CONTACT_SHADOW.size * (2 - fade);
  shadowThick.value = charH * SHADOW_THICKNESS;
  shadowDark.value = CONTACT_SHADOW.on ? CONTACT_SHADOW.darkness * fade : 0;
}
