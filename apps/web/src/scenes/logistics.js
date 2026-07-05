import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Mounts the isometric logistics-network scene into `container`.
// Returns a cleanup function that fully tears the scene down.
export function createLogisticsScene(container) {
  // ---------- palette ----------
  const COL = { bg: 0x060b18, ground: 0x0c1730, tile: 0x12203f, tileEdge: 0x21407a };
  const ACCENT = 0x35c3ff;
  const WARM = 0xffb74d;
  const ROAD = 0x2bb7ff;

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
  scene.background = new THREE.Color(COL.bg);
  scene.fog = new THREE.Fog(COL.bg, 60, 140);

  const frustum = 26;
  let aspect = width / height;
  const camera = new THREE.OrthographicCamera(
    -frustum * aspect, frustum * aspect, frustum, -frustum, 0.1, 1000
  );
  camera.position.set(40, 34, 40);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minZoom = 0.6;
  controls.maxZoom = 2.5;
  controls.maxPolarAngle = Math.PI / 2.2;
  controls.target.set(0, 1, 0);

  // ---------- lighting ----------
  scene.add(new THREE.AmbientLight(0x2a3f6b, 1.1));
  scene.add(new THREE.HemisphereLight(0x4a6bd0, 0x05070f, 0.55));

  const key = new THREE.DirectionalLight(0xbcd4ff, 1.25);
  key.position.set(28, 44, 18);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 150;
  const sh = 50;
  key.shadow.camera.left = -sh; key.shadow.camera.right = sh;
  key.shadow.camera.top = sh; key.shadow.camera.bottom = -sh;
  key.shadow.bias = -0.0004;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x2f6bff, 0.5);
  fill.position.set(-30, 20, -25);
  scene.add(fill);

  // ---------- shared materials ----------
  const mat = {
    ground: new THREE.MeshStandardMaterial({ color: COL.ground, roughness: 1, metalness: 0 }),
    tile: new THREE.MeshStandardMaterial({ color: COL.tile, roughness: 0.9, metalness: 0.1 }),
    bldgDark: new THREE.MeshStandardMaterial({ color: 0x16233f, roughness: 0.8, metalness: 0.2 }),
    bldgMid: new THREE.MeshStandardMaterial({ color: 0x223256, roughness: 0.85, metalness: 0.15 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x0f1a30, roughness: 0.9, metalness: 0.2 }),
    window: new THREE.MeshStandardMaterial({ color: WARM, emissive: WARM, emissiveIntensity: 1.4, roughness: 0.4 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x66ccff, emissive: 0x2299dd, emissiveIntensity: 0.6, roughness: 0.2, metalness: 0.4 }),
    box: new THREE.MeshStandardMaterial({ color: 0xc59b63, roughness: 0.85 }),
    boxDark: new THREE.MeshStandardMaterial({ color: 0x8a6a3c, roughness: 0.9 }),
    truck: new THREE.MeshStandardMaterial({ color: 0xe8eef7, roughness: 0.5, metalness: 0.3 }),
    truckCab: new THREE.MeshStandardMaterial({ color: 0x3a4a6a, roughness: 0.6, metalness: 0.3 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x0a0d14, roughness: 0.9 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x1f7a4d, roughness: 1 }),
    leafDk: new THREE.MeshStandardMaterial({ color: 0x155c3a, roughness: 1 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 1 }),
    glow: new THREE.MeshBasicMaterial({ color: ACCENT }),
    metal: new THREE.MeshStandardMaterial({ color: 0x44505f, roughness: 0.5, metalness: 0.6 }),
  };

  // ---------- helpers ----------
  function box(w, h, d, material, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y + h / 2, z);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  function platform(group, w, d, x, z) {
    const p = box(w, 0.6, d, mat.tile, x, 0, z);
    group.add(p);
    const rimGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.6, d));
    const rim = new THREE.LineSegments(rimGeo, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.55 }));
    rim.position.set(x, 0.3, z);
    group.add(rim);
    return p;
  }

  const world = new THREE.Group();
  scene.add(world);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), mat.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.2;
  ground.receiveShadow = true;
  world.add(ground);

  // faint world-map-ish dot grid backdrop
  (function dotField() {
    const g = new THREE.BufferGeometry();
    const pts = [], N = 1400;
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * 200;
      const z = (Math.random() - 0.5) * 200;
      if (Math.abs(x) < 32 && Math.abs(z) < 32) continue;
      pts.push(x, -0.15, z);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.PointsMaterial({ color: 0x1c356b, size: 0.5, transparent: true, opacity: 0.5 });
    world.add(new THREE.Points(g, m));
  })();

  // ================= BUILDINGS =================
  function hub(x, z) {
    const g = new THREE.Group();
    platform(g, 22, 16, x, z);
    const baseY = 0.6;
    g.add(box(20, 3.2, 14, mat.bldgMid, x, baseY, z));
    g.add(box(20.4, 0.5, 14.4, mat.roof, x, baseY + 3.2, z));
    for (let i = -2; i <= 2; i++) g.add(box(1.4, 0.2, 7, mat.glass, x + i * 3.2, baseY + 3.45, z));
    for (let i = -3; i <= 3; i++) g.add(box(1.6, 1.8, 0.2, mat.window, x + i * 2.4, baseY, z + 7.05));
    world.add(g);
    return g;
  }

  const stores = [];
  function store(x, z, rot = 0) {
    const g = new THREE.Group();
    platform(g, 11, 11, 0, 0);
    const baseY = 0.6;
    g.add(box(8, 4.4, 8, mat.bldgMid, 0, baseY, 0));
    g.add(box(8.3, 0.5, 8.3, mat.roof, 0, baseY + 4.4, 0));
    for (let row = 0; row < 3; row++) {
      for (let c = -2; c <= 2; c++) {
        if (Math.random() < 0.18) continue;
        g.add(box(0.9, 0.9, 0.12, mat.window, c * 1.5, baseY + 0.9 + row * 1.25, 4.05));
        g.add(box(0.12, 0.9, 0.9, mat.window, 4.05, baseY + 0.9 + row * 1.25, c * 1.5));
      }
    }
    const signGroup = new THREE.Group();
    const sign = box(2.2, 1.6, 0.25, new THREE.MeshStandardMaterial({
      color: 0x0c1730, emissive: ACCENT, emissiveIntensity: 0.9, roughness: 0.4,
    }), 0, 0, 0);
    signGroup.add(sign);
    signGroup.position.set(0, baseY + 7.4, 0);
    signGroup.userData.bob = Math.random() * Math.PI * 2;
    g.add(signGroup);
    g.userData.sign = signGroup;
    scatterTrees(g, 4.5, 6);
    g.position.set(x, 0, z);
    g.rotation.y = rot;
    world.add(g);
    stores.push(g);
    return g;
  }

  function scatterTrees(group, r, count) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const rr = r + Math.random() * 1.2;
      tree(group, Math.cos(a) * rr, Math.sin(a) * rr, 0.6 + Math.random() * 0.5);
    }
  }

  function tree(group, x, z, scale = 1) {
    const t = new THREE.Group();
    t.add(box(0.3, 0.9, 0.3, mat.trunk, 0, 0, 0));
    const m = Math.random() > 0.5 ? mat.leaf : mat.leafDk;
    const c1 = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.6, 7), m);
    c1.position.y = 1.5; c1.castShadow = true; t.add(c1);
    const c2 = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.3, 7), m);
    c2.position.y = 2.2; c2.castShadow = true; t.add(c2);
    t.position.set(x, 0, z);
    t.scale.setScalar(scale);
    group.add(t);
  }

  function pallet(x, z, rows = 2) {
    const g = new THREE.Group();
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < 4; i++) {
        const bx = (i % 2 - 0.5) * 1.05;
        const bz = (Math.floor(i / 2) - 0.5) * 1.05;
        g.add(box(0.95, 0.85, 0.95, Math.random() > 0.5 ? mat.box : mat.boxDark, bx, r * 0.9, bz));
      }
    }
    g.position.set(x, 0.6, z);
    world.add(g);
    return g;
  }

  hub(0, 0);
  store(-26, -16, 0.3);
  store(26, -16, -0.3);
  store(-26, 16, 0.5);
  store(26, 16, -0.5);

  pallet(-13, -11, 3);
  pallet(13, -11, 2);
  pallet(-13, 11, 2);
  pallet(13, 11, 3);
  pallet(0, 11, 2);

  // robotic arms
  const arms = [];
  function robotArm(x, z) {
    const g = new THREE.Group();
    g.add(box(1.6, 0.4, 1.6, mat.metal, 0, 0, 0));
    const a1 = new THREE.Group();
    a1.position.y = 0.4;
    a1.add(box(0.4, 2.4, 0.4, mat.metal, 0, 0, 0));
    const a2 = new THREE.Group();
    a2.position.y = 2.4;
    a2.add(box(0.35, 1.8, 0.35, new THREE.MeshStandardMaterial({ color: 0xffa733, roughness: 0.5, metalness: 0.4 }), 0, 0, 0));
    a1.add(a2);
    g.add(a1);
    g.position.set(x, 0.6, z);
    g.userData = { a1, a2, t: Math.random() * 10 };
    world.add(g);
    arms.push(g);
  }
  robotArm(-7, 9);
  robotArm(7, 9);

  // ================= GLOWING ROADS =================
  const roadY = 0.62;
  const roadMat = new THREE.MeshBasicMaterial({ color: ROAD, transparent: true, opacity: 0.9 });

  function roadPath(points, width2 = 0.7) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], roadY, p[1])), true);
    const geo = new THREE.TubeGeometry(curve, 240, width2, 8, true);
    const mesh = new THREE.Mesh(geo, roadMat);
    mesh.scale.y = 0.12;
    mesh.position.y = 0.02;
    world.add(mesh);
    return curve;
  }

  const loop = roadPath([
    [-16, -10], [0, -12], [16, -10],
    [18, 0], [16, 10], [0, 12], [-16, 10], [-18, 0],
  ], 0.55);

  const spokes = [
    roadPath([[-16, -10], [-22, -13], [-26, -12]], 0.4),
    roadPath([[16, -10], [22, -13], [26, -12]], 0.4),
    roadPath([[-16, 10], [-22, 13], [-26, 13]], 0.4),
    roadPath([[16, 10], [22, 13], [26, 13]], 0.4),
  ];

  const nodes = [];
  function node(x, z) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 16), new THREE.MeshBasicMaterial({ color: 0x9fe6ff, transparent: true }));
    m.position.set(x, roadY + 0.1, z);
    m.userData.t = Math.random() * Math.PI * 2;
    world.add(m);
    nodes.push(m);
  }
  [[-16, -10], [16, -10], [16, 10], [-16, 10], [0, -12], [0, 12], [18, 0], [-18, 0], [-26, -12], [26, -12], [-26, 13], [26, 13]]
    .forEach((p) => node(p[0], p[1]));

  // ================= TRUCKS =================
  function makeTruck(color = mat.truck) {
    const g = new THREE.Group();
    g.add(box(1.5, 1.5, 3, color, 0, 0.55, -0.2));
    g.add(box(1.4, 1.1, 1.1, mat.truckCab, 0, 0.45, 1.9));
    g.add(box(1.2, 0.5, 0.1, mat.glass, 0, 0.7, 2.46));
    const wpos = [[-0.78, 1.1], [0.78, 1.1], [-0.78, -1], [0.78, -1]];
    for (const [wx, wz] of wpos) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.25, 14), mat.tire);
      w.rotation.z = Math.PI / 2;
      w.position.set(wx, 0.32, wz);
      w.castShadow = true;
      g.add(w);
    }
    const hl = new THREE.PointLight(0xfff0c0, 6, 8, 2);
    hl.position.set(0, 0.6, 2.8);
    g.add(hl);
    g.scale.setScalar(0.85);
    return g;
  }

  const trucks = [];
  function addTruck(curve, offset, speed, color) {
    const g = makeTruck(color);
    world.add(g);
    trucks.push({ g, curve, t: offset, speed });
  }
  addTruck(loop, 0.0, 0.035, mat.truck);
  addTruck(loop, 0.34, 0.03, new THREE.MeshStandardMaterial({ color: 0x6fa8ff, roughness: 0.5, metalness: 0.3 }));
  addTruck(loop, 0.67, 0.04, mat.truck);
  spokes.forEach((sp, i) => addTruck(sp, (i * 0.2) % 1, 0.05, mat.truck));

  // traveling light pulses
  const pulses = [];
  function addPulse(curve, offset, speed) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), new THREE.MeshBasicMaterial({ color: 0xbfefff }));
    world.add(m);
    pulses.push({ m, curve, t: offset, speed });
  }
  for (let i = 0; i < 6; i++) addPulse(loop, i / 6, 0.08);
  spokes.forEach((sp) => { addPulse(sp, 0, 0.12); addPulse(sp, 0.5, 0.12); });

  // ================= post-processing =================
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.65, 0.6, 0.2));
  composer.addPass(new OutputPass());

  // ================= animation =================
  const tmp = new THREE.Vector3();
  const clock = new THREE.Clock();
  let rafId = 0;

  function moveAlong(obj, curve, t) {
    const p = curve.getPointAt(t % 1);
    obj.position.copy(p);
    const tan = curve.getTangentAt(t % 1).normalize();
    tmp.copy(p).add(tan);
    obj.lookAt(tmp);
  }

  function animate() {
    rafId = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    for (const tr of trucks) {
      tr.t = (tr.t + tr.speed * dt) % 1;
      moveAlong(tr.g, tr.curve, tr.t);
    }
    for (const p of pulses) {
      p.t = (p.t + p.speed * dt) % 1;
      p.m.position.copy(p.curve.getPointAt(p.t));
      p.m.position.y = roadY + 0.15;
    }
    for (const n of nodes) {
      n.scale.setScalar(1 + Math.sin(time * 3 + n.userData.t) * 0.35);
      n.material.opacity = 0.7;
    }
    for (const st of stores) {
      const sg = st.userData.sign;
      sg.children[0].material.emissiveIntensity = 0.7 + Math.sin(time * 2 + sg.userData.bob) * 0.4;
      sg.rotation.y += dt * 0.6;
    }
    for (const a of arms) {
      a.userData.t += dt;
      a.userData.a1.rotation.z = Math.sin(a.userData.t * 0.9) * 0.4;
      a.userData.a2.rotation.z = Math.sin(a.userData.t * 1.3 + 1) * 0.7;
      a.userData.a1.rotation.y = a.userData.t * 0.3;
    }

    controls.update();
    composer.render();
  }

  // ================= resize =================
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

  // ================= cleanup =================
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
