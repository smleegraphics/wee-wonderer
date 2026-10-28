// Character pictures for the Characters card: every character in characters.ts, standing in its
// idle pose, from the front three-quarters, on a transparent background. Not part of the app:
// scripts/character-thumbs.mjs opens this page (thumbs.html) and saves what it publishes as
// `window.__thumbs`, so the pictures are made again whenever a character changes.
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CHARACTERS, type ClipUse, clipOf } from '../figurine/characters';

const SIZE = 192;         // pixels square: three to a row in the card, sharp on a 2x screen
const TURN = 0.5;         // radians round from straight ahead: enough to show the face and the side
const FOV = 24;           // degrees: long enough a lens that the figure is not distorted
const MARGIN = 1.08;      // the figure's longest side fills this much less than the frame

const renderer = new WebGPURenderer({ antialias: true, alpha: true });
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x000000, 0);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f70, 2));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(1.5, 3, 2.5);
scene.add(key);
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);

async function picture(model: string, idle: ClipUse | undefined): Promise<string> {
  const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}${model}`);
  const root = gltf.scene;
  root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false; });
  // the idle pose, as the game shows it standing still
  const use = idle && clipOf(idle), clip = use && gltf.animations.find((c) => c.name === use.name);
  if (clip) { const mixer = new THREE.AnimationMixer(root); mixer.clipAction(clip).play(); mixer.setTime(use.hold ?? 0); }
  scene.add(root);
  root.updateMatrixWorld(true);
  // framed by its posed, skinned bounds (a skinned mesh's own bounds are its bind pose): its longest
  // side fills the square, since a bounding sphere leaves a tall figure small with empty sides
  const box = new THREE.Box3().setFromObject(root, true), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const distance = (Math.max(size.x, size.y, size.z) / 2) * MARGIN / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) + Math.max(size.x, size.z) / 2;
  camera.position.set(center.x + Math.sin(TURN) * distance, center.y, center.z + Math.cos(TURN) * distance);
  camera.lookAt(center);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/webp', 0.9);
  scene.remove(root);
  return url;
}

await renderer.init();
const thumbs: { thumb: string; dataUrl: string }[] = [];
for (const c of CHARACTERS) thumbs.push({ thumb: c.thumb, dataUrl: await picture(c.model, c.clips.idle) });
(window as unknown as { __thumbs: typeof thumbs }).__thumbs = thumbs;
