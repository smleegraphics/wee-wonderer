// Wee Wonderer — app shell (M0).
// three.js on its WebGPU backend: this owns the device, canvas, render loop,
// camera, and lights. splatlight (as SplatlightRenderer) plugs in at M3;
// the character + controller land at M2. For now: a cleared canvas + a grid
// so we can see the real WebGPU renderer is alive.

import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const app = document.getElementById('app')!;

const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1c22);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.01, // near — small; character is ~0.12 m tall (world contract: 1 unit = 1 m)
  100,
);
camera.position.set(1.2, 0.9, 1.8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.1, 0);
controls.enableDamping = true;

// world convention (see context/magic-test-plan.md): Y-up, meters, floor at y=0
scene.add(new THREE.HemisphereLight(0x8899bb, 0x22201c, 0.9));
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
sun.position.set(2, 4, 3);
scene.add(sun);

// reference floor so the empty scene reads as a space, not a void
scene.add(new THREE.GridHelper(4, 40, 0x33343c, 0x24252b));

async function main() {
  await renderer.init();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

main();
