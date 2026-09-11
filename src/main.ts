// Wee Wonderer — app shell.
//
// three.js on WebGPU owns everything: device, canvas, camera, lights, loop, AND
// the splat scan (via three's native GaussianSplat object). Because the splats
// are a real three.js object sharing three's depth buffer, opaque geometry (the
// test box, later the character + collision proxies) occludes them correctly
// with no manual depth work.

import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { GaussianSplatPLYLoader } from 'three/addons/loaders/GaussianSplatPLYLoader.js';

const app = document.getElementById('app')!;

const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1c22);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(1.2, 0.9, 1.8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.1, 0);
controls.enableDamping = true;

// world convention (context/magic-test-plan.md): Y-up, meters, floor at y=0
scene.add(new THREE.HemisphereLight(0x8899bb, 0x22201c, 0.9));
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
sun.position.set(2, 4, 3);
scene.add(sun);
scene.add(new THREE.GridHelper(4, 40, 0x33343c, 0x24252b));

let ready = false; // set once the splat has loaded + a few frames rendered

function loadSplat(): void {
  new GaussianSplatPLYLoader().load(
    `${import.meta.env.BASE_URL}luigi.ply`,
    (geometry) => {
      geometry.computeBoundingSphere();
      const bs = geometry.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 1);
      const { center, radius: r } = bs;

      const splat = new GaussianSplat(geometry);
      scene.add(splat);

      // frame the orbit camera on the cloud (URL ?az=&el=&dist= overrides)
      controls.target.copy(center);
      const q = new URLSearchParams(location.search);
      const az = Number(q.get('az') ?? 0.3);
      const el = Number(q.get('el') ?? 0.25);
      const dist = Number(q.get('dist') ?? 2.6) * r;
      camera.position.set(
        center.x + dist * Math.cos(el) * Math.sin(az),
        center.y + dist * Math.sin(el),
        center.z + dist * Math.cos(el) * Math.cos(az),
      );
      camera.near = Math.max(0.001, r * 0.01);
      camera.far = r * 50;
      camera.updateProjectionMatrix();
      controls.update();

      ready = true;
      console.log(`splat: ${geometry.getAttribute('position')?.count ?? '?'} splats, radius ${r.toFixed(3)}`);
    },
    undefined,
    (err) => showBanner(`luigi.ply load failed: ${String(err)}`),
  );
}

async function main(): Promise<void> {
  await renderer.init();
  loadSplat();

  let frames = 0;
  renderer.setAnimationLoop(() => {
    controls.update();
    void renderer.renderAsync(scene, camera).then(() => {
      if (ready && ++frames === 3) (window as unknown as { __wwReady?: boolean }).__wwReady = true;
    });
  });
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function showBanner(msg: string): void {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;top:0;left:0;right:0;margin:0;padding:12px;color:#f88;background:#1a1c22;font:12px ui-monospace;white-space:pre-wrap;z-index:9">${msg}</pre>`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  showBanner(err instanceof Error ? err.message : String(err));
});
