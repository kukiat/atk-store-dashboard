import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Mounts the smart-shelf retail scene (with walking humans) into `container`.
// Returns a cleanup function that fully tears the scene down.
export function createSmartShelfScene(container) {
  const ACCENT = 0x35c3ff;

  let width = container.clientWidth || window.innerWidth;
  let height = container.clientHeight || window.innerHeight;

  // ---------- renderer / scene / camera ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060b18);
  scene.fog = new THREE.Fog(0x060b18, 45, 110);

  const frustum = 18;
  let aspect = width / height;
  const camera = new THREE.OrthographicCamera(
    -frustum * aspect, frustum * aspect, frustum, -frustum, 0.1, 1000
  );
  camera.position.set(34, 28, 34);
  camera.lookAt(0, 2, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minZoom = 0.6;
  controls.maxZoom = 3;
  controls.maxPolarAngle = Math.PI / 2.2;
  controls.target.set(0, 2, 0);

  // ---------- lighting ----------
  scene.add(new THREE.AmbientLight(0x2a3f6b, 1.0));
  scene.add(new THREE.HemisphereLight(0x4a6bd0, 0x05070f, 0.5));
  const key = new THREE.DirectionalLight(0xbcd4ff, 1.15);
  key.position.set(20, 34, 16);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 120;
  const sh = 36;
  key.shadow.camera.left = -sh; key.shadow.camera.right = sh;
  key.shadow.camera.top = sh; key.shadow.camera.bottom = -sh;
  key.shadow.bias = -0.0004;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x2f6bff, 0.45);
  fill.position.set(-24, 18, -20);
  scene.add(fill);

  // ---------- materials ----------
  const mat = {
    floor: new THREE.MeshStandardMaterial({ color: 0x0c1730, roughness: 1 }),
    shelf: new THREE.MeshStandardMaterial({ color: 0x223256, roughness: 0.8, metalness: 0.2 }),
    shelfDk: new THREE.MeshStandardMaterial({ color: 0x16233f, roughness: 0.85, metalness: 0.25 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x44505f, roughness: 0.45, metalness: 0.6 }),
    label: new THREE.MeshStandardMaterial({ color: 0x0c1730, emissive: ACCENT, emissiveIntensity: 1.0, roughness: 0.4 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x0a0d14, roughness: 0.9 }),
    glow: new THREE.MeshBasicMaterial({ color: ACCENT }),
    skin: new THREE.MeshStandardMaterial({ color: 0xe0a87e, roughness: 0.7 }),
  };
  const productColors = [0xe2574c, 0x4caf72, 0xefb23a, 0x5b8def, 0xb07cdb, 0xe07baf, 0x37c2c9];

  function box(w, h, d, material, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y + h / 2, z);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  const world = new THREE.Group();
  scene.add(world);

  // ---------- floor with glowing grid ----------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), mat.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  world.add(floor);

  const grid = new THREE.GridHelper(70, 35, 0x1d3a72, 0x14264a);
  grid.position.y = 0.01;
  grid.material.transparent = true; grid.material.opacity = 0.5;
  world.add(grid);

  // ---------- SMART SHELVES ----------
  const allLabels = [];
  function gondola(x, z, length = 10) {
    const g = new THREE.Group();
    const depth = 1.6, gheight = 4.2;
    g.add(box(length, gheight, 0.2, mat.shelfDk, 0, 0, 0));
    g.add(box(length, 0.4, depth, mat.shelf, 0, 0, 0));
    const levels = [1.2, 2.4, 3.6];
    for (const ly of levels) {
      g.add(box(length, 0.12, depth, mat.shelf, 0, ly - 0.06, 0));
      for (let side = -1; side <= 1; side += 2) {
        const pz = side * (depth / 2 - 0.35);
        for (let i = 0; i < length - 1; i++) {
          if (Math.random() < 0.12) continue;
          const px = -length / 2 + 0.8 + i;
          const ph = 0.6 + Math.random() * 0.45;
          const col = productColors[(i + Math.round(ly)) % productColors.length];
          g.add(box(0.7, ph, 0.6, new THREE.MeshStandardMaterial({ color: col, roughness: 0.7 }), px, ly, pz));
        }
        const label = box(length, 0.18, 0.05, mat.label.clone(), 0, ly + 0.1, side * (depth / 2 + 0.02));
        label.material = mat.label.clone();
        label.userData.base = 0.9;
        g.add(label);
        allLabels.push(label);
      }
    }
    g.add(box(0.18, gheight, depth, mat.metal, -length / 2, 0, 0));
    g.add(box(0.18, gheight, depth, mat.metal, length / 2, 0, 0));
    g.position.set(x, 0, z);
    world.add(g);
    return g;
  }

  gondola(-9, -6, 12);
  gondola(-9, 6, 12);
  gondola(9, -6, 12);
  gondola(9, 6, 12);
  gondola(0, -13, 22);

  // ---------- CEILING SENSORS w/ scan cones ----------
  const sensors = [];
  function sensor(x, z) {
    const g = new THREE.Group();
    g.add(box(0.8, 0.4, 0.8, mat.metal, 0, 11, 0));
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), new THREE.MeshBasicMaterial({ color: 0x9fe6ff }));
    lens.position.set(0, 11.05, 0);
    g.add(lens);
    const coneMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(3.2, 11, 24, 1, true), coneMat);
    cone.position.set(0, 5.5, 0);
    cone.rotation.x = Math.PI;
    g.add(cone);
    g.position.set(x, 0, z);
    g.userData = { lens, t: Math.random() * 6 };
    world.add(g);
    sensors.push(g);
  }
  sensor(0, 0); sensor(-9, 0); sensor(9, 0); sensor(0, -6); sensor(0, 6);

  // ---------- WALKING HUMAN ----------
  function makeHuman(shirt = 0x4f86d6, pants = 0x2c3550) {
    const h = new THREE.Group();
    const shirtM = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.7 });
    const pantsM = new THREE.MeshStandardMaterial({ color: pants, roughness: 0.8 });

    const body = new THREE.Group();
    body.position.y = 1.6;
    h.add(body);

    body.add(box(0.7, 1.1, 0.42, shirtM, 0, 0.05, 0));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 18, 18), mat.skin);
    head.position.set(0, 1.05, 0); head.castShadow = true;
    body.add(head);
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 18, 18, 0, Math.PI * 2, 0, Math.PI / 1.8),
      new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.9 })
    );
    hair.position.set(0, 1.12, 0);
    body.add(hair);

    function limb(w, len, m, x, y) {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      pivot.add(box(w, len, w, m, 0, -len, 0));
      body.add(pivot);
      return pivot;
    }
    const armL = limb(0.18, 0.9, shirtM, -0.46, 0.5);
    const armR = limb(0.18, 0.9, shirtM, 0.46, 0.5);
    const legL = limb(0.22, 0.95, pantsM, -0.2, -0.55);
    const legR = limb(0.22, 0.95, pantsM, 0.2, -0.55);

    h.userData = { body, armL, armR, legL, legR };
    return h;
  }

  const walkCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 9.5),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -9.5),
    new THREE.Vector3(3.2, 0, -11),
    new THREE.Vector3(13, 0, -9.5),
    new THREE.Vector3(13, 0, 9.5),
    new THREE.Vector3(3.2, 0, 11),
  ], true, 'catmullrom', 0.3);

  const humans = [
    { h: makeHuman(0x4f86d6, 0x2c3550), t: 0.0, speed: 0.045, cart: true },
    { h: makeHuman(0xd66a4f, 0x394050), t: 0.45, speed: 0.038, cart: false },
    { h: makeHuman(0x5cc28e, 0x2c3550), t: 0.75, speed: 0.052, cart: false },
  ];
  humans.forEach((p) => world.add(p.h));

  function makeCart() {
    const g = new THREE.Group();
    g.add(box(0.9, 0.7, 1.2, new THREE.MeshStandardMaterial({ color: 0x6a7690, roughness: 0.5, metalness: 0.5 }), 0, 0.55, 0));
    g.add(box(0.06, 0.9, 0.06, mat.metal, 0.4, 0.55, 0.7));
    g.add(box(0.06, 0.9, 0.06, mat.metal, -0.4, 0.55, 0.7));
    g.add(box(0.5, 0.4, 0.5, new THREE.MeshStandardMaterial({ color: 0xefb23a, roughness: 0.7 }), 0, 0.9, 0));
    for (const [wx, wz] of [[-0.35, 0.45], [0.35, 0.45], [-0.35, -0.45], [0.35, -0.45]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 12), mat.tire);
      w.rotation.z = Math.PI / 2; w.position.set(wx, 0.12, wz);
      g.add(w);
    }
    return g;
  }
  const cart = makeCart();
  world.add(cart);

  // ---------- glowing path ribbon ----------
  const ribbonGeo = new THREE.TubeGeometry(walkCurve, 200, 0.12, 8, true);
  const ribbon = new THREE.Mesh(ribbonGeo, new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.5 }));
  ribbon.position.y = 0.05; ribbon.scale.y = 0.2;
  world.add(ribbon);

  // ---------- bloom ----------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.6, 0.55, 0.2));
  composer.addPass(new OutputPass());

  // ---------- animation ----------
  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();
  let rafId = 0;

  function walk(p, time) {
    p.t = (p.t + p.speed * (1 / 60)) % 1;
    const pos = walkCurve.getPointAt(p.t);
    p.h.position.copy(pos);
    const tan = walkCurve.getTangentAt(p.t).normalize();
    tmp.copy(pos).add(tan);
    p.h.lookAt(tmp);

    const u = p.h.userData;
    const phase = time * p.speed * 130 + p.t * 40;
    const swing = Math.sin(phase) * 0.7;
    u.legL.rotation.x = swing;
    u.legR.rotation.x = -swing;
    u.armL.rotation.x = -swing * 0.8;
    u.armR.rotation.x = swing * 0.8;
    u.body.position.y = 1.6 + Math.abs(Math.sin(phase)) * 0.06;
    return { pos, tan };
  }

  function animate() {
    rafId = requestAnimationFrame(animate);
    const time = clock.elapsedTime;
    clock.getDelta();

    let lead = null;
    humans.forEach((p, i) => {
      const r = walk(p, time);
      if (i === 0) lead = r;
    });

    if (lead) {
      cart.position.copy(lead.pos).addScaledVector(lead.tan, -1.3);
      tmp.copy(cart.position).add(lead.tan);
      cart.lookAt(tmp);
    }

    for (const label of allLabels) {
      label.getWorldPosition(tmp);
      let near = 0;
      for (const p of humans) {
        const d = tmp.distanceTo(p.h.position);
        if (d < 4) near = Math.max(near, 1 - d / 4);
      }
      label.material.emissiveIntensity = 0.55 + near * 2.2 + Math.sin(time * 6 + tmp.x) * 0.1;
    }

    for (const sn of sensors) {
      sn.userData.lens.scale.setScalar(1 + Math.sin(time * 4 + sn.userData.t) * 0.4);
    }

    controls.update();
    composer.render();
  }

  // ---------- resize ----------
  function resize() {
    width = container.clientWidth || window.innerWidth;
    height = container.clientHeight || window.innerHeight;
    aspect = width / height;
    camera.left = -frustum * aspect; camera.right = frustum * aspect;
    camera.top = frustum; camera.bottom = -frustum;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    composer.setSize(width, height);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  animate();

  // ---------- cleanup ----------
  return () => {
    cancelAnimationFrame(rafId);
    ro.disconnect();
    controls.dispose();
    composer.dispose();
    renderer.dispose();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const m = Array.isArray(o.material) ? o.material : [o.material];
        m.forEach((mm) => mm.dispose());
      }
    });
    if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
  };
}
