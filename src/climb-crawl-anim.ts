// EXPERIMENT — a Spider-Man-style wall crawl, generated in code from the rig's `climb`
// clip (same approach as climb-side-anim.ts). Splayed, low, limbs moving in diagonal
// pairs. Self-contained: delete this file and its hook in main.ts to remove it.
import * as THREE from 'three';
import { meanPose, trackNode } from './climb-side-anim';

const LIMBS = [
  { root: 'RightArm', tip: 'RightHand', arm: true },
  { root: 'Left_Arm', tip: 'Left_Hand', arm: true },
  { root: 'RightUpLeg', tip: 'RightFoot', arm: false },
  { root: 'Left_UpLeg', tip: 'Left_Foot', arm: false },
] as const;

/** The look of the crawl (radians). */
const CRAWL_SHAPE = {
  armSplay: 0.55,  // hands out wide of the shoulders
  armRaise: 0.25,  // ...and reaching up the wall
  legSplay: 0.7,   // knees out, frog-like
  legRaise: 0.55,  // ...and drawn up
  armSwing: 0.42,  // stride of each hand
  legSwing: 0.36,  // stride of each foot
  sway: 0.14,      // spine wiggle with the stride
  headBack: 0.3,   // head tipped back to look where it's going
};
const KEYS = 16;

/**
 * A looping crawl clip whose stride runs along the body (`along` = 'up': head-ward) or
 * across it ('side': toward the figurine's right). Play it backwards for the opposite
 * way. Returns null if the rig doesn't have the bones for it.
 */
export function buildCrawlClip(climb: THREE.AnimationClip, model: THREE.Object3D, along: 'up' | 'side', name: string): THREE.AnimationClip | null {
  const pose = meanPose(climb);
  const bone = (n: string) => model.getObjectByName(n) ?? null;
  const hips = bone('Hips');
  if (!hips) return null;

  // Put the rig in the neutral climb pose to measure it (restored before returning).
  const saved: Array<[THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3]> = [];
  for (const t of climb.tracks) {
    const p = trackNode(t), o = bone(p.nodeName), v = pose.get(t.name)!;
    if (!o) continue;
    if (!saved.some((s) => s[0] === o)) saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]);
    if (p.propertyName === 'quaternion') o.quaternion.fromArray(v);
    else if (p.propertyName === 'position') o.position.fromArray(v);
    else if (p.propertyName === 'scale') o.scale.fromArray(v);
  }
  model.updateMatrixWorld(true);

  // figurine frame (it faces +Z): right = forward × up
  const modelQ = model.getWorldQuaternion(new THREE.Quaternion());
  const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(modelQ);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(modelQ);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(modelQ);
  const stride = along === 'up' ? up : right;
  const hipsPos = hips.getWorldPosition(new THREE.Vector3());

  /** Rotation (world) that swings a limb pointing along `reach` so its tip moves toward `toward`. */
  const swing = (reach: THREE.Vector3, toward: THREE.Vector3, angle: number, out: THREE.Quaternion): boolean => {
    const axis = new THREE.Vector3().crossVectors(reach, toward);
    if (axis.lengthSq() < 1e-8) { out.identity(); return false; }
    out.setFromAxisAngle(axis.normalize(), angle);
    return true;
  };

  /** A driven bone: a fixed re-pose, then a per-phase swing about `axis`, both in world space. */
  interface Driven { node: THREE.Object3D; local: THREE.Quaternion; parentQ: THREE.Quaternion; fixed: THREE.Quaternion; axis: THREE.Vector3 | null; angle: (phase: number) => number }
  const driven: Driven[] = [];
  const add = (node: THREE.Object3D, fixed: THREE.Quaternion, axis: THREE.Vector3 | null, angle: (phase: number) => number): void => {
    if (!node.parent) return;
    driven.push({ node, local: node.quaternion.clone(), parentQ: node.parent.getWorldQuaternion(new THREE.Quaternion()), fixed, axis, angle });
  };

  const a = new THREE.Vector3(), b = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion();
  for (const limb of LIMBS) {
    const root = bone(limb.root), tip = bone(limb.tip);
    if (!root || !tip) continue;
    root.getWorldPosition(a); tip.getWorldPosition(b);
    const side = a.clone().sub(hipsPos).dot(right) > 0 ? 1 : -1; // +1 = the figurine's right
    const reach = b.clone().sub(a);
    // re-pose: splay the limb out to its own side, and lift it up the wall
    swing(reach, right.clone().multiplyScalar(side), limb.arm ? CRAWL_SHAPE.armSplay : CRAWL_SHAPE.legSplay, q1);
    reach.applyQuaternion(q1);
    swing(reach, up, limb.arm ? CRAWL_SHAPE.armRaise : CRAWL_SHAPE.legRaise, q2);
    reach.applyQuaternion(q2);
    const fixed = q2.clone().multiply(q1);
    // stride: diagonal pairs (right hand + left foot, then left hand + right foot)
    const axis = new THREE.Vector3().crossVectors(reach, stride);
    const pairA = limb.arm ? side > 0 : side < 0;
    const amp = limb.arm ? CRAWL_SHAPE.armSwing : CRAWL_SHAPE.legSwing;
    add(root, fixed, axis.lengthSq() < 1e-8 ? null : axis.normalize(), (ph) => amp * Math.sin(ph + (pairA ? 0 : Math.PI)));
  }
  // spine wiggles toward the reaching hand; head tips back to look ahead
  add(hips, new THREE.Quaternion(), new THREE.Vector3().crossVectors(up, right).normalize(), (ph) => CRAWL_SHAPE.sway * Math.sin(ph));
  const head = bone('Head');
  if (head) { swing(up, fwd.clone().negate(), CRAWL_SHAPE.headBack, q1); add(head, q1.clone(), null, () => 0); }

  for (const [o, p, r, s] of saved) { o.position.copy(p); o.quaternion.copy(r); o.scale.copy(s); }
  model.updateMatrixWorld(true);
  if (driven.length < 3) return null;

  // Bake: undriven tracks hold the neutral pose; driven bones get re-pose + stride,
  // carried from world space into the bone's own frame: L' = P⁻¹ · stride · fixed · P · L.
  const duration = climb.duration, times = new Float32Array(KEYS + 1);
  for (let k = 0; k <= KEYS; k++) times[k] = (k / KEYS) * duration;
  const tracks: THREE.KeyframeTrack[] = [];
  const R = new THREE.Quaternion(), out = new THREE.Quaternion(), inv = new THREE.Quaternion();
  for (const t of climb.tracks) {
    const p = trackNode(t), v = pose.get(t.name)!;
    const d = p.propertyName === 'quaternion' ? driven.find((x) => x.node.name === p.nodeName) : undefined;
    if (!d) {
      const hold = new Float32Array(v.length * 2); hold.set(v, 0); hold.set(v, v.length);
      const Track = t.constructor as new (n: string, times: ArrayLike<number>, values: ArrayLike<number>) => THREE.KeyframeTrack;
      tracks.push(new Track(t.name, [0, duration], hold));
      continue;
    }
    const values = new Float32Array((KEYS + 1) * 4);
    inv.copy(d.parentQ).invert();
    for (let k = 0; k <= KEYS; k++) {
      if (d.axis) R.setFromAxisAngle(d.axis, d.angle((k / KEYS) * Math.PI * 2)); else R.identity();
      out.copy(inv).multiply(R).multiply(d.fixed).multiply(d.parentQ).multiply(d.local).toArray(values, k * 4);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(t.name, times, values));
  }
  return new THREE.AnimationClip(name, duration, tracks);
}
