// TEMP room-scan inspector: loads a scan, auto-levels it with the shared
// orientScan() (RANSAC floor fit), and shows it against a y=0 grid so we can
// eyeball leveling. Logs the computed transform. URL: ?file= &ca/ce/cd.
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { GaussianSplatPLYLoader } from 'three/addons/loaders/GaussianSplatPLYLoader.js';
import { SPZLoader } from 'three/addons/loaders/SPZLoader.js';
import { orientScan } from './orient-scan';
import { LISTED_SCANS, scanURL } from './scans';

const app = document.getElementById('app')!;
const renderer = new WebGPURenderer({ antialias: true }); // unlike the game (context/frame-time.md): this page is for looking at the y = 0 grid's thin lines, and its frame rate does not matter
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1c22);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 1000);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
scene.add(new THREE.HemisphereLight(0x8899bb, 0x22201c, 1.0));
scene.add(new THREE.GridHelper(20, 20, 0x44ff44, 0x338833)); // y=0 level reference

const q = new URLSearchParams(location.search);
const room = new THREE.Group();
scene.add(room);
const file = q.get('file') ?? LISTED_SCANS[0].file; // the app's default scan

(/\.spz$/i.test(file) ? new SPZLoader() : new GaussianSplatPLYLoader()).load(scanURL(file), (geometry) => {
  const o = orientScan(geometry.getAttribute('position') as THREE.BufferAttribute);
  const splat = new GaussianSplat(geometry);
  splat.position.copy(o.center).multiplyScalar(-1);
  room.add(splat);
  room.quaternion.copy(o.quaternion);
  room.position.y = o.floorOffsetY;

  const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ');
  const deg = (x: number) => (x * 180 / Math.PI).toFixed(2);
  console.log(`AUTO-ORIENT euler(XYZ)=(${deg(e.x)}, ${deg(e.y)}, ${deg(e.z)}) floorOffsetY=${o.floorOffsetY.toFixed(3)} radius=${o.radius.toFixed(2)}`);

  const r = o.radius, eye = r * 0.12;
  const ca = THREE.MathUtils.degToRad(Number(q.get('ca') ?? 35));
  const ce = THREE.MathUtils.degToRad(Number(q.get('ce') ?? 12));
  const cd = Number(q.get('cd') ?? 1.4) * r;
  orbit.target.set(0, eye, 0);
  camera.position.set(cd * Math.cos(ce) * Math.sin(ca), eye + cd * Math.sin(ce), cd * Math.cos(ce) * Math.cos(ca));
  camera.near = r * 0.005;
  camera.far = r * 60;
  camera.updateProjectionMatrix();
  orbit.update();
  (window as unknown as { __wwReady?: boolean }).__wwReady = true;
});

renderer.setAnimationLoop(() => { orbit.update(); void renderer.renderAsync(scene, camera); });
