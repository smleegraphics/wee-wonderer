// Builds the sideways-climb ("shimmy") clip in code from the rig's own `climb` clip,
// so a figurine with only an up/down climb cycle still animates when it traverses a
// wall. Nothing here is keyed to bone axes or a particular pose: every motion is
// "swing this limb so its tip moves along the wall", worked out from where the bones
// actually are, and baked into ordinary quaternion tracks.
import * as THREE from 'three';

/** Limbs as root → tip bone names; which one leads is decided from where they sit. */
const LIMBS = [
  { root: 'RightArm', tip: 'RightHand', arm: true },
  { root: 'Left_Arm', tip: 'Left_Hand', arm: true },
  { root: 'RightUpLeg', tip: 'RightFoot', arm: false },
  { root: 'Left_UpLeg', tip: 'Left_Foot', arm: false },
] as const;
const BODY = 'Hips';

const SHAPE = {
  keys: 16,        // keyframes per cycle
  armSwing: 0.36,  // rad — how far each hand reaches / gathers along the wall
  legSwing: 0.28,  // rad — same for the feet
  lean: 0.10,      // rad — body tips toward the direction of travel
  sway: 0.06,      // rad — and rocks as the weight shifts
};

const trackNode = (t: THREE.KeyframeTrack) => THREE.PropertyBinding.parseTrackName(t.name);

/** The clip's pose averaged over its cycle — a neutral "on the wall" pose (both arms
 *  up, both legs tucked) to shimmy from, with no up/down stepping left in it. */
function meanPose(clip: THREE.AnimationClip): Map<string, Float32Array> {
  const pose = new Map<string, Float32Array>();
  for (const t of clip.tracks) {
    const size = t.getValueSize(), n = t.times.length, v = t.values, out = new Float32Array(size);
    const isQuat = t instanceof THREE.QuaternionKeyframeTrack;
    for (let k = 0; k < n; k++) {
      let sign = 1; // quaternions: keep every sample in the first one's hemisphere
      if (isQuat && v[k * 4] * v[0] + v[k * 4 + 1] * v[1] + v[k * 4 + 2] * v[2] + v[k * 4 + 3] * v[3] < 0) sign = -1;
      for (let c = 0; c < size; c++) out[c] += sign * v[k * size + c];
    }
    let len = n;
    if (isQuat) len = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
    for (let c = 0; c < size; c++) out[c] /= len;
    pose.set(t.name, out);
  }
  return pose;
}

/**
 * A looping clip of the figurine traversing a wall toward its own right (`dir` = 1)
 * or left (-1). The limbs go one at a time — leading hand reaches, leading foot
 * follows, trailing hand gathers, trailing foot gathers — while the body leans into
 * the direction of travel. Returns null if the rig doesn't have the bones for it.
 */
export function buildClimbSideClip(climb: THREE.AnimationClip, model: THREE.Object3D, dir: 1 | -1, name: string): THREE.AnimationClip | null {
  const pose = meanPose(climb);
  const bone = (n: string) => model.getObjectByName(n) ?? null;
  const body = bone(BODY);
  if (!body || !pose.has(`${BODY}.quaternion`)) return null;

  // Put the rig in the neutral pose to measure it (restored before returning).
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

  // The figurine faces +Z, so its right is forward × up; travel runs along the wall.
  const modelQ = model.getWorldQuaternion(new THREE.Quaternion());
  const travel = new THREE.Vector3(-dir, 0, 0).applyQuaternion(modelQ);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(modelQ);
  const bodyPos = body.getWorldPosition(new THREE.Vector3());

  /** A driven bone: rotating it about `axis` (world) by +angle moves its tip along `travel`. */
  interface Driven { node: THREE.Object3D; local: THREE.Quaternion; parentQ: THREE.Quaternion; axis: THREE.Vector3; angle: (phase: number) => number }
  const driven: Driven[] = [];
  const drive = (node: THREE.Object3D, reach: THREE.Vector3, angle: (phase: number) => number): void => {
    const axis = new THREE.Vector3().crossVectors(reach, travel);
    if (axis.lengthSq() < 1e-8 || !node.parent) return; // limb lies along the wall — swinging it wouldn't move it sideways
    driven.push({ node, local: node.quaternion.clone(), parentQ: node.parent.getWorldQuaternion(new THREE.Quaternion()), axis: axis.normalize(), angle });
  };

  // body: lean into the travel direction, rocking a little with each reach
  drive(body, up, (ph) => SHAPE.lean + SHAPE.sway * Math.sin(ph));
  // limbs: lead hand → lead foot → trail hand → trail foot, a quarter-cycle apart
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const limb of LIMBS) {
    const root = bone(limb.root), tip = bone(limb.tip);
    if (!root || !tip) continue;
    root.getWorldPosition(a); tip.getWorldPosition(b);
    const leads = a.clone().sub(bodyPos).dot(travel) > 0;
    const offset = (limb.arm ? 0 : Math.PI / 2) + (leads ? 0 : Math.PI);
    const swing = limb.arm ? SHAPE.armSwing : SHAPE.legSwing;
    drive(root, b.clone().sub(a), (ph) => swing * Math.sin(ph - offset));
  }
  for (const [o, p, r, s] of saved) { o.position.copy(p); o.quaternion.copy(r); o.scale.copy(s); }
  model.updateMatrixWorld(true);
  if (driven.length < 2) return null;

  // Bake. Undriven tracks hold the neutral pose; driven bones get the swing, applied
  // in world space and carried back into the bone's own frame: L' = P⁻¹ · R · P · L.
  const duration = climb.duration, times = new Float32Array(SHAPE.keys + 1);
  for (let k = 0; k <= SHAPE.keys; k++) times[k] = (k / SHAPE.keys) * duration;
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
    const values = new Float32Array((SHAPE.keys + 1) * 4);
    inv.copy(d.parentQ).invert();
    for (let k = 0; k <= SHAPE.keys; k++) {
      R.setFromAxisAngle(d.axis, d.angle((k / SHAPE.keys) * Math.PI * 2));
      out.copy(inv).multiply(R).multiply(d.parentQ).multiply(d.local).toArray(values, k * 4);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(t.name, times, values));
  }
  return new THREE.AnimationClip(name, duration, tracks);
}
