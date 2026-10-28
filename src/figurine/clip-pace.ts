// How fast a walk or run clip carries a character, measured from the clip itself: the speed
// at which its feet stay planted, in body heights a second. Played at that speed it does not
// slide (character.ts's setMovePace scales it to the figurine's real speed). Nothing here
// knows a bone's name or which side is which: the foot on the ground is the skin's lowest point,
// measured from the skeleton's root bone, so a clip that moves its root (root motion) reads the
// same as one that walks on the spot.
//
// A foot that plants moves back under the body while it carries the weight, so the pace is how
// fast the contact point moves back while it stays the same point. A leg that swings like a
// pendulum and never plants (a rigid block leg, the mini's) swings forward at the ground as often
// as back; it is paced by its backward moments only: how fast the foot sweeps back at the ground,
// which is what the eye compares with the body's speed.

import * as THREE from 'three';

const SAMPLES = 96;   // a cycle is sampled this many times (a 1 s clip: every 10 ms)
// First a few poses over every vertex find the few that can touch the ground: a foot is down for a
// third of a cycle or more, so 8 poses see each stance, and a heel or toe still lifted then is
// within NEAR of the ground. (24 poses and 0.02 found the same paces, three times slower.)
const SCOUT = 8;
const NEAR = 0.04;    // body heights
// The share of the contact point's travel that is backward. Planted feet measure 0.74 to 1
// (chibi, skeleton, the old human: walks and runs); a pendulum leg measures 0.5 (as far forward
// as back: the mini, the old robot).
const PLANTED = 0.6;

/** The speed, in body heights a second, at which `clip` carries `model` (posed and scaled as it
 *  stands in the game, `height` world units tall): measured along the model's forward (+Z),
 *  which is the way it faces. Null if it cannot be measured: no skin, or no foot that moves. */
export function clipPace(model: THREE.Object3D, clip: THREE.AnimationClip, height: number): number | null {
  const meshes: THREE.SkinnedMesh[] = [];
  model.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
  if (!meshes.length) return null;
  let root: THREE.Object3D = meshes[0].skeleton.bones[0];
  while ((root.parent as THREE.Bone | null)?.isBone) root = root.parent!;

  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.play();
  const at = new THREE.Vector3(), base = new THREE.Vector3();
  const pose = (t: number) => {
    mixer.setTime(t);
    model.updateMatrixWorld(true);
    for (const m of meshes) m.skeleton.update();
  };
  const place = (m: number, i: number) => { meshes[m].getVertexPosition(i, at); meshes[m].localToWorld(at); return model.worldToLocal(at); };
  const toBodyHeights = model.getWorldScale(new THREE.Vector3()).y / height; // the model's own units to body heights

  // the vertices that can touch the ground: near the lowest in any scouting pose
  const near = NEAR / toBodyHeights;
  const candidates: [number, number][] = [];
  const seen = new Set<number>();
  const ys = meshes.map((m) => new Float32Array(m.geometry.attributes.position.count));
  for (let s = 0; s < SCOUT; s++) {
    pose((s / SCOUT) * clip.duration);
    let low = Infinity;
    for (let m = 0; m < meshes.length; m++) for (let i = 0; i < ys[m].length; i++) low = Math.min(low, ys[m][i] = place(m, i).y);
    for (let m = 0; m < meshes.length; m++) for (let i = 0; i < ys[m].length; i++) {
      const key = m * 1e7 + i;
      if (ys[m][i] <= low + near && !seen.has(key)) { seen.add(key); candidates.push([m, i]); }
    }
  }

  // the contact point at each sample: which vertex, and how far forward of the root bone
  const ids: number[] = [], zs: number[] = [];
  for (let s = 0; s <= SAMPLES; s++) {
    pose((s / SAMPLES) * clip.duration);
    root.getWorldPosition(base); model.worldToLocal(base);
    let low = Infinity, id = -1, z = 0;
    for (const [m, i] of candidates) { const p = place(m, i); if (p.y < low) { low = p.y; id = m * 1e7 + i; z = p.z - base.z; } }
    ids.push(id); zs.push(z);
  }
  action.stop();
  mixer.uncacheRoot(model);

  // how the contact point moves while it stays the same point
  const moves: number[] = [];
  for (let s = 1; s <= SAMPLES; s++) if (ids[s] === ids[s - 1]) moves.push(zs[s] - zs[s - 1]);
  const back = moves.reduce((a, d) => a + Math.max(0, -d), 0), all = moves.reduce((a, d) => a + Math.abs(d), 0);
  if (all === 0) return null;
  const dt = clip.duration / SAMPLES;
  // the median: steadier than the mean where a heel rolls onto a toe, and a hand that is lowest for
  // a frame or two does not move it
  const sweep = back / all >= PLANTED ? moves : moves.filter((d) => d < 0);
  sweep.sort((a, b) => a - b);
  let pace = -sweep[Math.floor(sweep.length / 2)] / dt;
  pace *= toBodyHeights;
  return pace > 0 ? pace : null;
}
