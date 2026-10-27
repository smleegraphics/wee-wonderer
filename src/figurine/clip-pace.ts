// How fast a walk or run clip carries a character, measured from the clip itself: the speed
// at which its feet stay planted, in body heights a second. Played at that speed it does not
// slide (character.ts's setMovePace scales it to the figurine's real speed). Nothing here
// knows a bone's name: the feet are the two lowest bones standing still, one each side, and
// they are measured from the skeleton's root bone, so a clip that moves its root (root motion)
// reads the same as one that walks on the spot.

import * as THREE from 'three';

const SAMPLES = 48; // a cycle is sampled this many times

/** The two lowest bones of `model` as it stands now, one each side of its middle (its feet,
 *  or their toes), or null if it has no bones. */
export function findFeet(model: THREE.Object3D): THREE.Bone[] | null {
  const bones: THREE.Bone[] = [];
  model.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone); });
  if (bones.length < 2) return null;
  const at = new THREE.Vector3(), local = new THREE.Vector3();
  model.updateMatrixWorld(true);
  const placed = bones.map((b) => { b.getWorldPosition(at); local.copy(at); model.worldToLocal(local); return { b, x: local.x, y: local.y }; });
  const lowest = (side: number) => placed.filter((p) => Math.sign(p.x) === side).sort((p, q) => p.y - q.y)[0]?.b;
  const left = lowest(-1), right = lowest(1);
  return left && right ? [left, right] : null;
}

/** The speed, in body heights a second, at which `clip` carries a character of height
 *  `height` (world units) whose feet are `feet`: a planted foot travels back the length of a
 *  step, relative to the body, in half a cycle. Measured along the model's forward (+Z), which
 *  is the way it faces. */
export function clipPace(model: THREE.Object3D, clip: THREE.AnimationClip, feet: THREE.Bone[], height: number): number {
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.play();
  let root: THREE.Object3D = feet[0];
  while ((root.parent as THREE.Bone | null)?.isBone) root = root.parent!;
  const at = new THREE.Vector3(), base = new THREE.Vector3();
  const min = feet.map(() => Infinity), max = feet.map(() => -Infinity);
  for (let i = 0; i < SAMPLES; i++) {
    mixer.setTime((i / SAMPLES) * clip.duration);
    model.updateMatrixWorld(true);
    root.getWorldPosition(base); model.worldToLocal(base);
    feet.forEach((foot, f) => {
      foot.getWorldPosition(at); model.worldToLocal(at);
      min[f] = Math.min(min[f], at.z - base.z); max[f] = Math.max(max[f], at.z - base.z);
    });
  }
  const step = Math.max(...feet.map((_, f) => max[f] - min[f]));
  action.stop();
  mixer.uncacheRoot(model);
  // the model's local units, scaled to the world, then to body heights
  const scale = model.getWorldScale(at).y;
  return (2 * step * scale) / clip.duration / height;
}
