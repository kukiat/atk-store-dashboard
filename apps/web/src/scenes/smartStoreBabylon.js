// V5 — Babylon.js port of the V4 "smart store" center-stage scene.
//
// This is a faithful port of src/scenes/smartStore.js (Three.js). It keeps the
// exact same world coordinates, layout, animation math and the same controller
// contract — `createSmartStoreBabylonScene(container, { onSelectShelf, onSelectPerson })`
// returns `{ dispose, selectShelf }` — so it drops straight into the shared
// Dashboard chrome as a sibling of V4. On top of V4 parity, V5 adds clickable
// shoppers: each person carries a mock identity and an invisible pick capsule,
// and the render loop drags a React-rendered detail card along their projected
// screen position (see the "person identity + selection" section).
//
// Port notes:
//  • scene.useRightHandedSystem = true so all the hand-authored Three coords,
//    curves, the robot node graph and rotation.y signs carry over unchanged.
//  • OrbitControls + OrthographicCamera  → ArcRotateCamera in ORTHOGRAPHIC mode
//    (orbit/zoom emulated; fly-to drives alpha/beta/radius/target + ortho zoom).
//  • MeshStandardMaterial → PBRMaterial (metallic workflow); MeshBasicMaterial
//    (unlit) → StandardMaterial with disableLighting.
//  • UnrealBloomPass + ACES tone mapping → DefaultRenderingPipeline (HDR) bloom
//    + imageProcessing ACES.
//  • Sprites (badges) → billboarded planes with a DynamicTexture.
//  • Raycaster picking → scene.pick with metadata.shelfId.

import {
  Engine, Scene, ArcRotateCamera, Camera, Vector3, Color3, Color4,
  HemisphericLight, DirectionalLight, ShadowGenerator, MeshBuilder, TransformNode,
  PBRMaterial, StandardMaterial, DynamicTexture, Curve3, PointerEventTypes,
  DefaultRenderingPipeline, ImageProcessingConfiguration, Scalar, SceneLoader, Matrix,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';

export function createSmartStoreBabylonScene(container, { onSelectShelf, onSelectPerson, onReady } = {}) {
  const ACCENT_HEX = '#35c3ff';
  const ACCENT = Color3.FromHexString(ACCENT_HEX);
  const C3 = (hex) => Color3.FromHexString('#' + hex.toString(16).padStart(6, '0'));
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  let elapsed = 0; // scene clock (s) — advanced by the render loop; also stamps person spawn times

  let width = container.clientWidth || window.innerWidth;
  let height = container.clientHeight || window.innerHeight;

  // ---------- engine / canvas (playground scaffolding pattern) ----------
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.outline = 'none';
  canvas.style.touchAction = 'none';
  container.appendChild(canvas);

  let engine;
  try {
    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true }, true);
  } catch (e) {
    container.removeChild(canvas);
    const msg = document.createElement('div');
    msg.className = 'loading';
    msg.textContent = 'WebGL not supported';
    container.appendChild(msg);
    onReady?.(); // nothing will ever render — release the boot overlay
    return { dispose() { if (msg.parentNode === container) container.removeChild(msg); }, selectShelf() {} };
  }

  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;           // keep Three's coordinate math 1:1
  scene.clearColor = new Color4(0, 0, 0, 0);   // transparent — dashboard backdrop shows through

  // ---------- camera (ortho ArcRotate ≈ V4 OrbitControls + OrthographicCamera) ----------
  // V4 sat at (30,26,30) looking at (0,3,0). Convert that offset to alpha/beta/radius.
  const TARGET0 = new Vector3(0, 3, 0);
  const frustum = 17;
  let zoom = 1, zoomTarget = 1;                // ortho zoom factor (V4 camera.zoom)
  const ZOOM_MIN = 0.7, ZOOM_MAX = 2.6;

  function poseFromOffset(offset) {
    const radius = offset.length();
    const beta = Math.acos(Scalar.Clamp(offset.y / radius, -1, 1));
    const alpha = Math.atan2(offset.z, offset.x);
    return { alpha, beta, radius };
  }
  const start = poseFromOffset(new Vector3(30, 23, 30)); // (30,26,30) - (0,3,0)

  const camera = new ArcRotateCamera('cam', start.alpha, start.beta, start.radius, TARGET0.clone(), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.1;
  camera.maxZ = 1000;
  camera.lowerBetaLimit = Math.PI / 6;         // V4 minPolarAngle
  camera.upperBetaLimit = Math.PI / 2.3;       // V4 maxPolarAngle
  camera.lowerRadiusLimit = camera.upperRadiusLimit = start.radius; // ortho: lock radius, zoom via bounds
  camera.inertia = 0.85;                        // ≈ OrbitControls damping 0.15
  camera.panningSensibility = 0;                // no pan — keep the store framed
  camera.attachControl(canvas, true);
  camera.inputs.removeByType('ArcRotateCameraMouseWheelInput'); // we drive zoom ourselves

  function applyOrtho() {
    const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
    const fz = frustum / zoom;
    camera.orthoLeft = -fz * aspect;
    camera.orthoRight = fz * aspect;
    camera.orthoTop = fz;
    camera.orthoBottom = -fz;
  }
  applyOrtho();

  const onWheel = (e) => {
    e.preventDefault();
    zoomTarget = Scalar.Clamp(zoomTarget * (1 - e.deltaY * 0.0012), ZOOM_MIN, ZOOM_MAX);
  };
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // ---------- lighting ----------
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.diffuse = C3(0x4a6bd0);
  hemi.groundColor = C3(0x05070f);
  hemi.intensity = 0.85;
  scene.ambientColor = C3(0x2a3f6b).scale(0.45); // ≈ V4 AmbientLight fill

  const key = new DirectionalLight('key', new Vector3(-18, -32, -14).normalize(), scene);
  key.position = new Vector3(18, 32, 14);
  key.diffuse = C3(0xcfe0ff);
  key.intensity = 1.9;

  const fill = new DirectionalLight('fill', new Vector3(22, -16, 18).normalize(), scene);
  fill.position = new Vector3(-22, 16, -18);
  fill.diffuse = C3(0x2f6bff);
  fill.intensity = 0.45;

  const shadowGen = new ShadowGenerator(2048, key);
  shadowGen.usePercentageCloserFiltering = true;
  shadowGen.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadowGen.bias = 0.0008;
  shadowGen.normalBias = 0.02;
  key.shadowMinZ = 1;
  key.shadowMaxZ = 110;

  // ---------- material factories ----------
  // lit PBR ≈ MeshStandardMaterial({color, roughness, metalness, emissive, emissiveIntensity})
  function pbr(name, o) {
    const m = new PBRMaterial(name, scene);
    m.albedoColor = C3(o.color);
    m.metallic = o.metalness ?? 0;
    m.roughness = o.roughness ?? 1;
    m.ambientColor = Color3.White();
    if (o.emissive !== undefined) m.emissiveColor = C3(o.emissive).scale(o.emissiveIntensity ?? 1);
    if (o.alpha !== undefined && o.alpha < 1) { m.alpha = o.alpha; }
    m.environmentIntensity = 0.35;
    return m;
  }
  // unlit ≈ MeshBasicMaterial({color, transparent, opacity})
  function basic(name, o) {
    const m = new StandardMaterial(name, scene);
    m.disableLighting = true;
    m.emissiveColor = C3(o.color);
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    if (o.alpha !== undefined && o.alpha < 1) m.alpha = o.alpha;
    m.backFaceCulling = false;
    return m;
  }

  const mat = {
    floor: pbr('floor', { color: 0x10192f, roughness: 0.95, metalness: 0.1 }),
    wall: pbr('wall', { color: 0x0c1426, roughness: 0.9, metalness: 0.15 }),
    shelf: pbr('shelf', { color: 0x1c2c4e, roughness: 0.8, metalness: 0.2 }),
    shelfDk: pbr('shelfDk', { color: 0x121f39, roughness: 0.85, metalness: 0.25 }),
    metal: pbr('metal', { color: 0x3c4858, roughness: 0.45, metalness: 0.65 }),
    counter: pbr('counter', { color: 0x1a2745, roughness: 0.6, metalness: 0.3 }),
    label: pbr('label', { color: 0x0c1730, emissive: 0x35c3ff, emissiveIntensity: 1.0, roughness: 0.4 }),
    tire: pbr('tire', { color: 0x0a0d14, roughness: 0.9 }),
    skin: pbr('skin', { color: 0xe0a87e, roughness: 0.7 }),
    screen: basic('screen', { color: 0x35c3ff, alpha: 0.32 }),
  };
  const productColors = [0xe2574c, 0x4caf72, 0xefb23a, 0x5b8def, 0xb07cdb, 0xe07baf, 0x37c2c9, 0xf08a3c];

  // ---------- mesh helpers ----------
  let _id = 0;
  function box(w, h, d, material, x = 0, y = 0, z = 0) {
    const m = MeshBuilder.CreateBox('b' + _id++, { width: w, height: h, depth: d }, scene);
    m.position.set(x, y + h / 2, z);
    m.material = material;
    m.receiveShadows = true;
    m.isPickable = false;
    shadowGen.addShadowCaster(m);
    return m;
  }
  function group(name) { return new TransformNode(name, scene); }

  const world = group('world');

  // ---------- floor + glowing grid ----------
  const ROOM = 30;
  const floor = MeshBuilder.CreatePlane('floor', { width: ROOM, height: ROOM }, scene);
  floor.rotation.x = Math.PI / 2;
  floor.material = mat.floor;
  floor.receiveShadows = true;
  floor.isPickable = false;
  floor.parent = world;

  // grid of faint glowing lines (≈ Three GridHelper)
  (function grid() {
    const lines = [];
    const n = 30, half = ROOM / 2, step = ROOM / n;
    for (let i = 0; i <= n; i++) {
      const p = -half + i * step;
      lines.push([new Vector3(-half, 0.02, p), new Vector3(half, 0.02, p)]);
      lines.push([new Vector3(p, 0.02, -half), new Vector3(p, 0.02, half)]);
    }
    const g = MeshBuilder.CreateLineSystem('grid', { lines }, scene);
    g.color = C3(0x244b8f);
    g.alpha = 0.45;
    g.isPickable = false;
    g.parent = world;
  })();

  // soft glowing border strip on the floor edges
  (function floorEdge() {
    const e = (ROOM - 0.5) / 2;
    const ring = MeshBuilder.CreateLines('floorEdge', {
      points: [
        new Vector3(-e, 0.04, -e), new Vector3(e, 0.04, -e),
        new Vector3(e, 0.04, e), new Vector3(-e, 0.04, e), new Vector3(-e, 0.04, -e),
      ],
    }, scene);
    ring.color = ACCENT;
    ring.alpha = 0.4;
    ring.isPickable = false;
    ring.parent = world;
  })();

  // ---------- back walls ----------
  const WALL_H = 9;
  function wall(len, rotY, x, z) {
    const w = box(len, WALL_H, 0.4, mat.wall, 0, 0, 0);
    w.position.set(x, WALL_H / 2, z);
    w.rotation.y = rotY;
    w.parent = world;
    return w;
  }
  const half = ROOM / 2;
  wall(ROOM, 0, 0, -half);
  wall(ROOM, Math.PI / 2, -half, 0);

  const bandMat = pbr('band', { color: 0x0c1730, emissive: 0x35c3ff, emissiveIntensity: 1.4, roughness: 0.4 });
  function wallBand(len, rotY, x, z) {
    const b = box(len, 0.5, 0.1, bandMat, 0, 0, 0);
    b.position.set(x, WALL_H - 1.4, z);
    b.rotation.y = rotY;
    b.parent = world;
  }
  wallBand(ROOM - 2, 0, 0, -half + 0.3);
  wallBand(ROOM - 2, Math.PI / 2, -half + 0.3, 0);

  // ---------- shelving units ----------
  const FACE = {
    px: new Vector3(1, 0, 0), nx: new Vector3(-1, 0, 0),
    pz: new Vector3(0, 0, 1), nz: new Vector3(0, 0, -1),
  };
  const zones = []; // { pos, unit, face, dist, height, focusZoom }

  function gondola(x, z, length, rotY = 0) {
    const g = group('gondola');
    const depth = 1.5, gheight = 3.6;
    box(length, gheight, 0.18, mat.shelfDk, 0, 0, 0).parent = g;
    box(length, 0.35, depth, mat.shelf, 0, 0, 0).parent = g;
    const levels = [1.0, 2.0, 3.0];
    for (const ly of levels) {
      box(length, 0.1, depth, mat.shelf, 0, ly - 0.05, 0).parent = g;
      for (let side = -1; side <= 1; side += 2) {
        const pz = side * (depth / 2 - 0.32);
        for (let i = 0; i < length - 1; i++) {
          if (Math.random() < 0.1) continue;
          const px = -length / 2 + 0.75 + i;
          const ph = 0.5 + Math.random() * 0.4;
          const col = productColors[(i + Math.round(ly * 2)) % productColors.length];
          box(0.62, ph, 0.55, pbr('prod', { color: col, roughness: 0.7 }), px, ly, pz).parent = g;
        }
        box(length, 0.16, 0.04, mat.label.clone(), 0, ly + 0.08, side * (depth / 2 + 0.02)).parent = g;
      }
    }
    box(0.16, gheight, depth, mat.metal, -length / 2, 0, 0).parent = g;
    box(0.16, gheight, depth, mat.metal, length / 2, 0, 0).parent = g;
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    g.parent = world;
    return g;
  }

  function wallShelf(length, rotY, x, z) {
    const g = group('wallShelf');
    const depth = 1.3, gheight = 6.5;
    box(length, gheight, 0.15, mat.shelfDk, 0, 0, -depth / 2).parent = g;
    const levels = [1.0, 2.3, 3.6, 4.9];
    for (const ly of levels) {
      box(length, 0.1, depth, mat.shelf, 0, ly - 0.05, 0).parent = g;
      for (let i = 0; i < length - 1; i++) {
        if (Math.random() < 0.08) continue;
        const px = -length / 2 + 0.7 + i;
        const ph = 0.55 + Math.random() * 0.45;
        const col = productColors[(i * 2 + Math.round(ly)) % productColors.length];
        box(0.6, ph, 0.5, pbr('prod', { color: col, roughness: 0.7 }), px, ly, 0.1).parent = g;
      }
      box(length, 0.16, 0.04, mat.label.clone(), 0, ly + 0.08, depth / 2 - 0.02).parent = g;
    }
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    g.parent = world;
    return g;
  }

  zones.push({ pos: new Vector3(-2, 8, -half + 1.6), unit: wallShelf(16, 0, -3, -half + 1.6), face: FACE.pz, dist: 15, height: 4, focusZoom: 2.0 });
  zones.push({ pos: new Vector3(2.5, 5.5, 1), unit: gondola(2.5, 1, 11), face: FACE.pz, dist: 14, height: 4, focusZoom: 2.2 });
  zones.push({ pos: new Vector3(half - 1.6, 8, 0), unit: wallShelf(16, Math.PI / 2, half - 1.6, 1), face: FACE.px, dist: 14, height: 4, focusZoom: 2.0 });
  zones.push({ pos: new Vector3(-8.5, 5.5, 4), unit: gondola(-8.5, 4, 9), face: FACE.pz, dist: 14, height: 4, focusZoom: 2.2 });
  zones.push({ pos: new Vector3(-6, 5.5, 10), unit: gondola(-6, 10, 7, Math.PI / 2), face: FACE.px, dist: 14, height: 4, focusZoom: 2.2 });

  // ---------- checkout counter (zone 06) ----------
  function checkout(x, z) {
    const g = group('checkout');
    box(5.5, 1.1, 2.4, mat.counter, 0, 0, 0).parent = g;
    box(5.5, 0.18, 2.6, mat.metal, 0, 1.1, 0).parent = g;
    box(0.9, 0.7, 0.6, mat.metal, -1.8, 1.28, 0).parent = g;
    const screen = MeshBuilder.CreatePlane('pos', { width: 0.8, height: 0.5 }, scene);
    screen.material = mat.screen;
    screen.position.set(-1.8, 1.95, 0.31);
    screen.isPickable = false;
    screen.parent = g;
    box(5.5, 0.12, 0.05, pbr('costrip', { color: 0x0c1730, emissive: 0x35c3ff, emissiveIntensity: 1.6, roughness: 0.4 }), 0, 0.45, 1.22).parent = g;
    g.position.set(x, 0, z);
    g.parent = world;
    return g;
  }
  const co = checkout(7, 9);
  zones.push({ pos: new Vector3(7, 3.2, 9), unit: co, face: FACE.pz, dist: 13, height: 4, focusZoom: 2.3 });

  // ---------- floating numbered zone badges (01–06) ----------
  function makeBadge(num) {
    const size = 256;
    const tex = new DynamicTexture('badge' + num, { width: size, height: size }, scene, true);
    tex.hasAlpha = true;
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 16, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(11,22,44,0.92)';
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#35c3ff';
    ctx.shadowColor = '#35c3ff';
    ctx.shadowBlur = 44;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#eaf6ff';
    ctx.font = 'bold 116px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(num, size / 2, size / 2 + 4);
    tex.update();
    tex.hasAlpha = true;
    tex.uScale = -1; tex.uOffset = 1; // un-mirror text under right-handed billboard

    // Unlit textured badge: diffuseTexture carries the base color + circular
    // alpha (disableLighting forces it full-bright), emissiveTexture adds the
    // neon glow on the bright ring/number so they bloom while the navy disc
    // stays dark. (emissiveTexture alone renders the disc blown-out white.)
    const m = new StandardMaterial('badgeMat' + num, scene);
    m.disableLighting = true;
    m.diffuseTexture = tex;
    m.useAlphaFromDiffuseTexture = true;
    m.emissiveTexture = tex;
    m.emissiveColor = Color3.White();
    m.diffuseColor = Color3.White();
    m.specularColor = Color3.Black();
    m.disableDepthWrite = true;
    m.backFaceCulling = false;

    const plane = MeshBuilder.CreatePlane('badge', { size: 2.2 }, scene);
    plane.material = m;
    plane.billboardMode = TransformNode.BILLBOARDMODE_ALL;
    plane.renderingGroupId = 1;
    plane.isPickable = false;
    return plane;
  }

  const badges = [];
  zones.forEach((zn, i) => {
    const b = makeBadge(String(i + 1).padStart(2, '0'));
    b.position.copyFrom(zn.pos);
    b.metadata = { shelfId: i + 1, base: zn.pos.y, t: i * 0.9 };
    b.parent = world;
    badges.push(b);
    const line = MeshBuilder.CreateLines('badgeLine', {
      points: [zn.pos.clone(), new Vector3(zn.pos.x, 0.1, zn.pos.z)],
    }, scene);
    line.color = ACCENT;
    line.alpha = 0.25;
    line.isPickable = false;
    line.parent = world;
  });

  // ---------- shelf selection: tag every mesh of each unit with its shelf id ----------
  zones.forEach((zn, i) => {
    const sid = i + 1;
    zn.unit.getChildMeshes().forEach((o) => { o.metadata = { ...(o.metadata || {}), shelfId: sid }; o.isPickable = true; });
  });

  // ---------- selection outline + hover glow ----------
  function unitBounds(node) {
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    node.getChildMeshes().forEach((m) => {
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, bb.minimumWorld);
      max = Vector3.Maximize(max, bb.maximumWorld);
    });
    return { min, max, center: min.add(max).scale(0.5), size: max.subtract(min) };
  }

  // 12-edge wireframe of a unit cube as a reusable scalable line box
  function makeLineBox(name, color, alpha) {
    const s = 0.5;
    const corners = [
      [-s, -s, -s], [s, -s, -s], [s, -s, s], [-s, -s, s],
      [-s, s, -s], [s, s, -s], [s, s, s], [-s, s, s],
    ].map((c) => new Vector3(c[0], c[1], c[2]));
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const lines = E.map(([a, b]) => [corners[a], corners[b]]);
    const m = MeshBuilder.CreateLineSystem(name, { lines }, scene);
    m.color = color;
    m.alpha = alpha;
    m.isPickable = false;
    m.isVisible = false;
    m.parent = world;
    return m;
  }
  const selOutline = makeLineBox('selOutline', ACCENT, 0.9);

  const hoverGlow = MeshBuilder.CreateBox('hoverGlow', { size: 1 }, scene);
  const hoverMat = new StandardMaterial('hoverMat', scene);
  hoverMat.disableLighting = true;
  hoverMat.emissiveColor = ACCENT;
  hoverMat.alpha = 0;
  hoverMat.alphaMode = Engine.ALPHA_ADD;
  hoverMat.backFaceCulling = false;
  hoverMat.disableDepthWrite = true;
  hoverGlow.material = hoverMat;
  hoverGlow.isPickable = false;
  hoverGlow.isVisible = false;
  hoverGlow.parent = world;
  hoverGlow.metadata = { sx: 1, sy: 1, sz: 1, cx: 0, cy: 0, cz: 0 };

  function frameOutline(outline, unit, pad) {
    const b = unitBounds(unit);
    outline.scaling.set(b.size.x + pad, b.size.y + pad, b.size.z + pad);
    outline.position.copyFrom(b.center);
    outline.isVisible = true;
  }

  // ---------- camera fly-to ----------
  const FLY_DUR = 0.9;
  const fly = {
    active: false, t: 0,
    fromAlpha: 0, toAlpha: 0, fromBeta: 0, toBeta: 0, fromRadius: 0, toRadius: 0,
    fromTarget: new Vector3(), toTarget: new Vector3(), fromZoom: 1, toZoom: 1,
  };
  let homePose = null;

  function landingPoseFor(id) {
    const zn = zones[id - 1];
    const b = unitBounds(zn.unit);
    const center = b.center;
    const pos = center.add(zn.face.scale(zn.dist)).add(new Vector3(0, zn.height, 0));
    const pose = poseFromOffset(pos.subtract(center));
    return { ...pose, target: center.clone(), zoom: zn.focusZoom ?? 1.8 };
  }

  function shortestAngle(from, to) {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return from + d;
  }

  function flyTo(pose) {
    fly.fromAlpha = camera.alpha;
    fly.toAlpha = shortestAngle(camera.alpha, pose.alpha);
    fly.fromBeta = camera.beta;
    fly.toBeta = pose.beta;
    fly.fromRadius = camera.radius;
    fly.toRadius = pose.radius;
    fly.fromTarget.copyFrom(camera.target);
    fly.toTarget.copyFrom(pose.target);
    fly.fromZoom = zoom;
    fly.toZoom = pose.zoom;
    fly.t = 0;
    fly.active = true;
    camera.detachControl();
    // radius is locked for orbit; relax the lock so the tween can move it
    camera.lowerRadiusLimit = camera.upperRadiusLimit = null;
  }

  // ---------- focus dimming ----------
  // give each zone its own material instances so we can fade everything *except*
  // the focused shelf without dragging the focused shelf down with it.
  zones.forEach((zn) => {
    const cache = new Map();
    zn.unit.getChildMeshes().forEach((o) => {
      if (!o.material) return;
      let cl = cache.get(o.material);
      if (!cl) { cl = o.material.clone(o.material.name + '_z'); cache.set(o.material, cl); }
      o.material = cl;
    });
  });

  const DIM_FLOOR = 0.2;
  const dimSkip = new Set(['selOutline', 'hoverMat']);
  const dimReg = [];
  const seenMat = new Set();
  function zoneIdOf(mesh) {
    for (let p = mesh; p; p = p.parent) {
      if (p.metadata && p.metadata.shelfId !== undefined) return p.metadata.shelfId;
    }
    return 0;
  }
  scene.meshes.forEach((o) => {
    if (!o.material || dimSkip.has(o.material.name)) return;
    const mats = o.material.subMaterials ? o.material.subMaterials : [o.material];
    const zoneId = zoneIdOf(o);
    for (const m of mats) {
      if (!m || seenMat.has(m.uniqueId)) continue;
      seenMat.add(m.uniqueId);
      dimReg.push({
        m, zoneId,
        albedo: m.albedoColor ? m.albedoColor.clone() : null,
        emissive: m.emissiveColor ? m.emissiveColor.clone() : null,
      });
    }
  });

  const DIM_DUR = FLY_DUR;
  const dim = { active: false, t: 0, from: 0, to: 0, value: 0 };
  let dimFocus = null;
  function applyDim(v) {
    for (const e of dimReg) {
      const f = e.zoneId !== dimFocus ? 1 - (1 - DIM_FLOOR) * v : 1;
      if (e.albedo) e.m.albedoColor.copyFrom(e.albedo).scaleInPlace(f);
      if (e.emissive) e.m.emissiveColor.copyFrom(e.emissive).scaleInPlace(f);
    }
  }
  function setDim(focusId) {
    if (focusId) dimFocus = focusId;
    dim.from = dim.value;
    dim.to = focusId ? 1 : 0;
    dim.t = 0;
    dim.active = true;
  }

  // ---------- selection API (React <-> scene) ----------
  let selectedId = null;
  let hoverId = null;
  let hoverProgress = 0;
  function selectShelf(id) {
    const prev = selectedId;
    selectedId = id || null;
    if (!selectedId) {
      selOutline.isVisible = false;
      setDim(null);
      if (homePose) { flyTo(homePose); homePose = null; }
      return;
    }
    if (!prev && !homePose) {
      homePose = { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone(), zoom };
    }
    frameOutline(selOutline, zones[selectedId - 1].unit, 0.5);
    setDim(selectedId);
    flyTo(landingPoseFor(selectedId));
  }

  // ---------- picking (shelves + people share one nearest-hit ray) ----------
  function pickTarget() {
    const allowPerson = selectedId == null; // design rule: shelf focus locks people out
    const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => {
      if (!m.isPickable || !m.metadata) return false;
      if (m.metadata.shelfId !== undefined) return true;
      // person capsules become pickable once the async model is actually visible
      return allowPerson && m.metadata.personId !== undefined && !!m.parent?.metadata?.ready;
    });
    if (!hit || !hit.hit || !hit.pickedMesh) return null;
    const md = hit.pickedMesh.metadata;
    return md.personId !== undefined
      ? { type: 'person', id: md.personId }
      : { type: 'shelf', id: md.shelfId };
  }
  function setHoverGlow(id) {
    hoverId = id;
    const b = unitBounds(zones[id - 1].unit);
    const pad = 0.35;
    const ud = hoverGlow.metadata;
    ud.sx = b.size.x + pad; ud.sy = b.size.y + pad; ud.sz = b.size.z + pad;
    ud.cx = b.center.x; ud.cy = b.center.y; ud.cz = b.center.z;
  }

  const CLICK_SLOP = 6;
  let downPos = null;
  const pointerObs = scene.onPointerObservable.add((pi) => {
    const e = pi.event;
    if (pi.type === PointerEventTypes.POINTERDOWN) {
      downPos = { x: e.clientX, y: e.clientY };
    } else if (pi.type === PointerEventTypes.POINTERUP) {
      if (!downPos) return;
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP;
      downPos = null;
      if (moved) return;
      const t = pickTarget();
      if (t && t.type === 'person') onSelectPerson?.(t.id);      // React toggles / clears shelf
      else if (t && t.type === 'shelf') onSelectShelf?.(t.id);   // React toggles / clears person
      else { onSelectShelf?.(null); onSelectPerson?.(null); }    // empty floor clears either focus
    } else if (pi.type === PointerEventTypes.POINTERMOVE) {
      if (downPos) return;
      const t = pickTarget();
      hoverPersonId = null;
      if (t && t.type === 'person') {
        hoverId = null;
        if (t.id !== selectedPersonId) hoverPersonId = t.id;
        canvas.style.cursor = 'pointer';
      } else if (t && t.id !== selectedId) {
        if (t.id !== hoverId) setHoverGlow(t.id);
        canvas.style.cursor = 'pointer';
      } else {
        hoverId = null;
        canvas.style.cursor = t ? 'pointer' : '';
      }
    }
  });
  const onPointerLeave = () => { hoverId = null; hoverPersonId = null; canvas.style.cursor = ''; };
  canvas.addEventListener('pointerleave', onPointerLeave);

  // ---------- ceiling sensors ----------
  const sensors = [];
  function sensor(x, z) {
    const g = group('sensor');
    box(0.6, 0.3, 0.6, mat.metal, 0, 8.4, 0).parent = g;
    const lens = MeshBuilder.CreateSphere('lens', { diameter: 0.36, segments: 16 }, scene);
    lens.material = basic('lensMat', { color: 0x9fe6ff });
    lens.position.set(0, 8.4, 0);
    lens.isPickable = false;
    lens.parent = g;
    g.position.set(x, 0, z);
    g.parent = world;
    g.metadata = { lens, t: Math.random() * 6 };
    sensors.push(g);
  }
  sensor(-3, -8); sensor(6, -3); sensor(-8, 4); sensor(4, 6);

  // ---------- shoppers (Quaternius CC0 rigged characters, public/models/) ----------
  // each .gltf embeds its buffers plus the clips we use: Idle / Walk / PickUp.
  // files load once into an AssetContainer, then every person is a clone that
  // owns its materials (per-person tints). appears async; check metadata.ready.
  const CHAR_SCALE = 0.8; // raw models are ~3.3 units tall, scene humans ~2.6
  const CHAR_FILES = [
    'Casual_Male', 'Casual_Female', 'Casual2_Female', 'Casual3_Male', 'Suit_Male',
    'Casual2_Male', 'Casual3_Female', 'OldClassy_Female', 'Worker_Male',
  ];
  const charCache = new Map(); // file -> Promise<AssetContainer>
  function loadCharContainer(file) {
    if (!charCache.has(file)) {
      charCache.set(file, SceneLoader.LoadAssetContainerAsync('/models/', file + '.gltf', scene));
    }
    return charCache.get(file);
  }
  // ---------- per-person look (hair / skin / clothes tints) ----------
  // Quaternius materials are flat baseColorFactors with stable names ('Hair',
  // 'Face', 'Shirt', 'Pants', …), so a look is just material name -> sRGB hex,
  // applied to the per-clone materials. Looks come from a monotonic counter
  // walking each palette with a stride coprime to its length: consecutive
  // spawns never share a color and every run casts the same crowd.
  // NB the models' 'Face' material is the visible skin; 'Skin' is the dark
  // eyes/brows material — leave that one alone.
  // the scene's light rig is almost pure blue (see "lighting"), which crushes
  // warm hair/skin tones to black — so people get an emissive lift (below) and
  // these palettes keep wide brightness gaps so tones still read at crowd zoom
  const HAIR_NATURAL = ['#26262a', '#5f4130', '#8a4b2f', '#a8763e', '#d1a95e', '#8a8378'];
  const HAIR_FASHION = ['#d96fa8', '#4fb8c9']; // ~1 in 7 spawns goes dyed
  const HAIR_GREY = ['#9b9b9b', '#cfcbc2', '#6e6e6e', '#e9e5db']; // OldClassy only
  const SKIN_TONES = ['#ffeedd', '#f0c08e', '#c98d55', '#8a5730'];
  const SHIRTS = ['#6b8fc9', '#c96b5a', '#55a87a', '#c9a25a', '#8a7ac9', '#52b0b8', '#c97a9e', '#7a8899', '#4a5d7a', '#b8bdc4'];
  const PANTS = ['#2e3a52', '#3d3d45', '#6a6152', '#4c503a', '#6b4a36', '#2f4c44'];
  const SUITS = ['#232a3d', '#2f2f33', '#3a2f28', '#20302a']; // suits stay sober
  const DRESS_SHIRTS = ['#e8e8e8', '#dbe4f0', '#f0e4e4'];
  let lookSeq = 0;
  function buildLook(file) {
    const i = ++lookSeq;
    const pick = (arr, stride) => arr[(i * stride) % arr.length];
    const look = { Face: pick(SKIN_TONES, 3) };
    if (file === 'Suit_Male') {
      look.Black = pick(SUITS, 3); // 'Black' is the jacket+trousers material
      look.Shirt = pick(DRESS_SHIRTS, 2);
    } else {
      look.Shirt = pick(SHIRTS, 7);
      look.Pants = pick(PANTS, 5);
    }
    if (file === 'OldClassy_Female') look.Hair = pick(HAIR_GREY, 3);
    else if (i % 7 === 5) look.Hair = HAIR_FASHION[i % HAIR_FASHION.length];
    else look.Hair = pick(HAIR_NATURAL, 5); // stride 5: coprime with 6
    // card avatar echoes the torso garment so the UI ties back to the 3D body
    look.torso = look.Black || look.Shirt;
    return look;
  }

  function makeHuman(file) {
    const h = group('human');
    const u = { ready: false, groups: {}, fist: null, entries: null, look: buildLook(file), mats: null };
    h.metadata = u;
    loadCharContainer(file).then((container) => {
      if (h.isDisposed()) return; // removed while still loading
      // cloneMaterials + doNotInstantiate: instanced meshes silently keep the
      // shared material (assetContainer skips the swap on InstancedMesh), so
      // real clones are required for the per-person tints
      const entries = container.instantiateModelsToScene((n) => n, true, { doNotInstantiate: true });
      const root = entries.rootNodes[0];
      root.parent = h;
      root.scaling.setAll(CHAR_SCALE);
      const mats = new Set();
      root.getChildMeshes().forEach((m) => {
        m.isPickable = false;
        shadowGen.addShadowCaster(m);
        if (m.material) {
          mats.add(m.material);
          const hex = u.look[m.material.name];
          if (hex) m.material.albedoColor = Color3.FromHexString(hex).toLinearSpace();
          // emissive lift: the blue light rig reflects nothing off warm tones,
          // so let every body part glow its own albedo a little. 'Skin' is the
          // eyes/brows material — it must stay dead black to read as a face.
          if (m.material.name !== 'Skin') {
            m.material.emissiveColor = m.material.albedoColor.scale(0.3);
          }
        }
      });
      u.mats = [...mats];
      entries.animationGroups.forEach((g) => { g.stop(); u.groups[g.name] = g; });
      u.fist = root.getDescendants().find((n) => n.name === 'Fist.R') || null;
      u.entries = entries;
      u.ready = true;
    }).catch((e) => console.error('character load failed:', file, e));
    return h;
  }
  function disposeHuman(h) {
    unregisterPerson(h); // closes the detail card if this was the followed shopper
    const u = h.metadata || {};
    if (u.entries) {
      u.entries.animationGroups.forEach((g) => g.dispose());
      u.entries.skeletons.forEach((s) => s.dispose());
    }
    if (u.mats) u.mats.forEach((m) => m.dispose()); // per-person tint clones
    h.dispose(false, false); // recursively disposes the clone's meshes
  }

  // ---------- person identity + selection (click a shopper → floating card) ----------
  // Every walker/picker gets a mock Thai identity, gender-matched to its GLTF
  // file, plus an invisible pick capsule (picking the skinned meshes directly
  // is both costly and wrong — Babylon tests the bind pose, not the animated
  // pose). React renders the card; the render loop writes its screen-space
  // transform every frame so it follows the shopper without re-rendering.
  const THAI_FIRST_M = ['สมชาย', 'อนุชา', 'ธนกร', 'วีระพล', 'กิตติ', 'ณัฐพล', 'ประเสริฐ', 'ศุภกร'];
  const THAI_FIRST_F = ['พิมพ์ชนก', 'สุดารัตน์', 'กมลวรรณ', 'อรทัย', 'นภัสสร', 'ชลธิชา', 'มณีรัตน์', 'วรรณิภา'];
  const THAI_LAST = ['วงศ์สว่าง', 'ใจดี', 'ศรีสุข', 'ทองดี', 'บุญมาก', 'แก้วใส', 'พงษ์พันธ์', 'รุ่งเรือง', 'สุขสันต์', 'จันทร์เพ็ญ'];

  // avatar chip = the shopper's torso tint, lifted toward mid-brightness so
  // the white initials stay readable (suits are near-black otherwise)
  function cardColor(hex) {
    const c = Color3.FromHexString(hex);
    const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    const w = lum < 0.35 ? 0.35 : 0.1;
    const f = (v) => Math.round((v + (1 - v) * w) * 255).toString(16).padStart(2, '0');
    return '#' + f(c.r) + f(c.g) + f(c.b);
  }

  const persons = new Map(); // personId -> entry
  let personSeq = 0;
  let selectedPersonId = null;
  let hoverPersonId = null;
  let cardEl = null; // React-owned card wrapper — the scene only writes its transform

  function registerPerson(h, kind, file, ref) {
    const id = ++personSeq;
    const female = file.includes('Female');
    const firsts = female ? THAI_FIRST_F : THAI_FIRST_M;
    const first = firsts[(id * 3 + (female ? 1 : 0)) % firsts.length];
    const last = THAI_LAST[(id * 7 + 3) % THAI_LAST.length]; // stride coprime with 10 → all 10 surnames cycle
    const cap = MeshBuilder.CreateCapsule('personCap' + id, { radius: 0.5, height: 2.6, tessellation: 8 }, scene);
    cap.position.y = 1.3;
    cap.visibility = 0;
    cap.isPickable = true;
    cap.metadata = { personId: id };
    cap.parent = h; // rides along and is disposed with the person
    const entry = {
      id, h, kind, ref, // ref: walker or picker sim object (mode/exit/picks live there)
      custNo: String(id).padStart(2, '0'),
      name: `${first} ${last}`,
      initials: first.charAt(0) + last.charAt(0),
      color: cardColor(h.metadata.look.torso),
      spawnT: elapsed,
      picks: 0,
      nearShelf: 1, // pickers: fixed at spawn; walkers: computed live in getPersonData
    };
    persons.set(id, entry);
    return entry;
  }

  function unregisterPerson(h) {
    for (const [id, e] of persons) {
      if (e.h !== h) continue;
      persons.delete(id);
      if (hoverPersonId === id) hoverPersonId = null;
      if (selectedPersonId === id) { selectedPersonId = null; onSelectPerson?.(null); }
      break;
    }
  }

  // React <-> scene sync (mirror of selectShelf, for people)
  function selectPerson(id) {
    if (id && !persons.has(id)) { onSelectPerson?.(null); return; } // despawned between click and sync
    selectedPersonId = id || null;
    if (hoverPersonId === selectedPersonId) hoverPersonId = null;
  }

  function getPersonData(id) {
    const e = persons.get(id);
    if (!e) return null;
    let status, near, picks = null;
    const nearestZone = () => {
      let best = Infinity, nz = 1;
      zones.forEach((zn, i) => {
        const d = (zn.pos.x - e.h.position.x) ** 2 + (zn.pos.z - e.h.position.z) ** 2;
        if (d < best) { best = d; nz = i + 1; }
      });
      return nz;
    };
    if (e.kind === 'picker') {
      status = e.ref.moving ? 'walking' : 'browsing';
      near = e.ref.moving ? nearestZone() : e.nearShelf;
      picks = e.picks;
    } else {
      status = (e.ref.exit || e.ref.mode === 'exitwalk') ? 'leaving' : 'walking';
      near = nearestZone();
    }
    return {
      id, custNo: e.custNo, name: e.name, initials: e.initials, color: e.color,
      kind: e.kind, status, near, picks,
      inStoreSec: Math.max(0, Math.floor(elapsed - e.spawnT)),
    };
  }

  function bindCard(el) {
    cardEl = el;
    if (cardEl) cardEl.style.visibility = 'hidden'; // revealed on the first tracked frame
  }

  // selection / hover rings under the feet (RTS style). Shared meshes that
  // chase the current target each frame — parenting them to the person would
  // get them disposed together with the human on despawn.
  function personRing(name, alpha) {
    const r = MeshBuilder.CreateTorus(name, { diameter: 1.5, thickness: 0.07, tessellation: 40 }, scene);
    const m = new StandardMaterial(name + 'Mat', scene);
    m.disableLighting = true;
    m.emissiveColor = ACCENT.scale(1.2);
    m.alpha = alpha;
    m.alphaMode = Engine.ALPHA_ADD;
    m.disableDepthWrite = true;
    m.backFaceCulling = false;
    r.material = m;
    r.isPickable = false;
    r.isVisible = false;
    r.parent = world;
    return r;
  }
  const selRing = personRing('personSelRing', 0.8);
  const hoverRing = personRing('personHoverRing', 0.3);

  // arc-length sampled path (≈ Three CatmullRomCurve3 getPointAt/getTangentAt)
  function makePath(points, closed) {
    const curve = Curve3.CreateCatmullRomSpline(points, 16, closed);
    const pts = curve.getPoints();
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Vector3.Distance(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1] || 1;
    function pointAt(t) {
      const d = ((t % 1) + 1) % 1 * total;
      let i = 1;
      while (i < cum.length && cum[i] < d) i++;
      const i0 = i - 1, i1 = Math.min(i, pts.length - 1);
      const seg = (cum[i1] - cum[i0]) || 1;
      return Vector3.Lerp(pts[i0], pts[i1], (d - cum[i0]) / seg);
    }
    function tangentAt(t) { return pointAt(t + 0.002).subtract(pointAt(t - 0.002)).normalize(); }
    return { pointAt, tangentAt, length: total };
  }

  // waypoints verified against every obstacle footprint (spline min clearance
  // 0.68 units incl. the curve's bow) — the old V4 loop cut through two
  // gondolas and the checkout counter
  const walkPath = makePath([
    new Vector3(0, 0, 12.2), new Vector3(-4.4, 0, 9.2), new Vector3(-3.5, 0, 5.6),
    new Vector3(-3.5, 0, 2.6), new Vector3(-9.3, 0, 0.6), new Vector3(-3, 0, -6),
    new Vector3(4, 0, -7), new Vector3(9, 0, -2), new Vector3(10.4, 0, 4.0),
    new Vector3(11.7, 0, 9.6), new Vector3(6.8, 0, 12.5),
  ], true);

  // ---------- entrance: low glass storefront + auto sliding doors ----------
  // sits on the open camera-side edge (z = +half) right above the walk loop's
  // top stretch, so people can visibly come and go through it
  const DOOR = { x: 3.4, zDoor: half, zOut: half + 1.9, zIn: 13.0 };
  const glassMat = basic('storeGlass', { color: 0x35c3ff, alpha: 0.09 });
  const doorGlassMat = basic('doorGlass', { color: 0x35c3ff, alpha: 0.2 });
  const trimMat = basic('doorTrim', { color: 0x35c3ff, alpha: 0.85 });
  (function entrance() {
    const H = 2.5;
    // frame posts flanking the 2.4-wide doorway + side panes + header
    box(0.16, H, 0.16, mat.metal, DOOR.x - 1.28, 0, DOOR.zDoor);
    box(0.16, H, 0.16, mat.metal, DOOR.x + 1.28, 0, DOOR.zDoor);
    const paneL = box(3.6, H - 0.1, 0.06, glassMat, DOOR.x - 3.16, 0, DOOR.zDoor);
    const paneR = box(3.6, H - 0.1, 0.06, glassMat, DOOR.x + 3.16, 0, DOOR.zDoor);
    const header = box(9.9, 0.22, 0.2, mat.metal, DOOR.x, H, DOOR.zDoor);
    box(9.9, 0.06, 0.22, trimMat, DOOR.x, H + 0.22, DOOR.zDoor); // cyan trim
    [paneL, paneR, header].forEach((m) => { m.parent = world; });
    // welcome pad outside so arrivals aren't standing on the void
    const pad = box(3.4, 0.04, 2.6, mat.counter, DOOR.x, 0, DOOR.zDoor + 1.35);
    box(3.4, 0.02, 0.14, trimMat, DOOR.x, 0.04, DOOR.zDoor + 0.35).parent = world;
    pad.parent = world;
  })();
  const doorPanels = [-1, 1].map((side) => {
    const panel = box(1.24, 2.34, 0.07, doorGlassMat, 0, 0, 0);
    box(0.1, 2.34, 0.08, trimMat, 0, -1.17, 0).parent = panel; // bright leading edge
    panel.position.set(DOOR.x + side * 0.62, 1.17 + 0.02, DOOR.zDoor + 0.14);
    panel.parent = world;
    return { mesh: panel, side, closedX: DOOR.x + side * 0.62 };
  });
  let doorOpenAmt = 0;

  // ---------- crowd control (React steppers drive these) ----------
  // cycle through the character files — 9 files vs the 8-person cap means no
  // two people on the floor ever share a model (tints differ regardless)
  let charSeq = 0;
  const nextCharFile = () => CHAR_FILES[charSeq++ % CHAR_FILES.length];
  const MAX_PEOPLE = 8; // shared cap across walkers + pickers
  const walkers = [];
  // everyone currently on the walk loop this frame (walkers + relocating
  // pickers via their shims) — rebuilt by the render loop, read by the
  // follow-the-leader braking in walk() and pickerMove()
  let loopTraffic = [];
  let pendingEntries = 0; // people queued to walk in through the door
  const logicalWalkers = () =>
    walkers.length + pendingEntries - walkers.filter((w) => w.exit).length;
  // `pickers` is declared further down; only the dashboard steppers call this,
  // well after init, so the forward reference never hits the TDZ
  const totalPeople = () => logicalWalkers() + pickers.length;

  // where the entrance spur meets the walk loop
  let tMerge = 0;
  {
    let best = Infinity;
    for (let i = 0; i < 400; i++) {
      const pt = walkPath.pointAt(i / 400);
      const d = Math.hypot(pt.x - DOOR.x, pt.z - DOOR.zIn);
      if (d < best) { best = d; tMerge = i / 400; }
    }
  }
  const mergePoint = walkPath.pointAt(tMerge);

  function makeWalker(mode, t) {
    const file = nextCharFile();
    const p = {
      h: makeHuman(file),
      mode, // 'enter' | 'loop' | 'exitwalk'
      t: t ?? tMerge,
      wp: 0,
      exit: false,
      speed: 0.03 + Math.random() * 0.018,
      // personal walking line: a lane preference plus a slow weave, applied
      // perpendicular to the spline so nobody treads the exact same rail
      lat: (Math.random() * 2 - 1) * 0.22,
      wobPhase: Math.random() * Math.PI * 2,
      wobFreq: 0.25 + Math.random() * 0.3,
      latEase: mode === 'loop' ? 1 : 0, // door entries fade the offset in after the merge
    };
    p.h.parent = world;
    p.person = registerPerson(p.h, 'walker', file, p);
    walkers.push(p);
    return p;
  }
  // initial shoppers only: they were "already in the store" when the
  // dashboard opened, so they spawn directly on the loop
  function spawnOnLoop() {
    let t = Math.random();
    for (let tries = 0; tries < 12; tries++) {
      const clear = walkers.every((q) => {
        const d = (((q.t - t) % 1) + 1) % 1;
        return Math.min(d, 1 - d) * walkPath.length > 2.0;
      });
      if (clear) break;
      t = Math.random();
    }
    makeWalker('loop', t);
  }
  function addWalker() {
    if (totalPeople() < MAX_PEOPLE) pendingEntries++;
    return logicalWalkers();
  }
  // soonest to reach the door junction walks out first
  function flagExit() {
    let pick = null, best = 2;
    for (const w of walkers) {
      if (w.exit) continue;
      const d = w.mode === 'loop' ? (((tMerge - w.t) % 1) + 1) % 1 : 1.5;
      if (d < best) { best = d; pick = w; }
    }
    if (pick) pick.exit = true;
    return !!pick;
  }
  function removeWalker() {
    if (pendingEntries > 0) pendingEntries--;
    else flagExit();
    return logicalWalkers();
  }

  // browsing spots sit within arm's reach of the two wall shelves, clear of
  // the robot lanes at z=-11.5 and x=11.2 (people face the shelf products)
  const PICK_SLOTS = [
    [-3, -12.35, Math.PI], [14.2, -1, -Math.PI / 2],
    [-7, -12.35, Math.PI], [14.2, -4.5, -Math.PI / 2],
    [1, -12.35, Math.PI], [14.2, 2.5, -Math.PI / 2],
    [-9.5, -12.35, Math.PI], [14.2, 5.5, -Math.PI / 2],
  ];
  // a fresh stand point every time a slot is taken: slide along the shelf,
  // lean in or out a touch, and face it slightly off-square — nobody stands
  // on the exact same mark twice
  function jitterSlot(i) {
    const [bx, bz, bry] = PICK_SLOTS[i];
    const along = (Math.random() * 2 - 1) * 0.5;   // parallel to the shelf (slots are ≥2 apart)
    const depth = (Math.random() * 2 - 1) * 0.08;  // still within picking reach
    return {
      x: bx + Math.cos(bry) * along + Math.sin(bry) * depth,
      z: bz - Math.sin(bry) * along + Math.cos(bry) * depth,
      ry: bry + (Math.random() * 2 - 1) * 0.16,
    };
  }
  const freePickSlots = () => PICK_SLOTS.map((_, i) => i)
    .filter((i) => !pickers.some((p) => p.slot === i || p.targetSlot === i));

  // shopper pick cycle: PickUp clip plays while the product flies from the
  // bottom shelf into the right fist, rides the hand, then flies back
  const pickers = [];
  function addPicker() {
    if (totalPeople() >= MAX_PEOPLE) return pickers.length;
    const free = freePickSlots();
    if (free.length) {
      const slot = free[Math.floor(Math.random() * free.length)];
      const { x, z, ry } = jitterSlot(slot);
      const file = nextCharFile();
      const h = makeHuman(file);
      h.position.set(x, 0, z);
      h.rotation.y = ry;
      h.parent = world;
      const item = MeshBuilder.CreateBox('pickItem', { width: 0.4, height: 0.45, depth: 0.36 }, scene);
      item.material = pbr('pickItemM', { color: productColors[(slot * 3 + 1) % productColors.length], roughness: 0.7 });
      item.isPickable = false;
      item.rotation.y = ry;
      item.setEnabled(false);
      shadowGen.addShadowCaster(item);
      item.parent = world;
      // facing + sideways unit vectors — recomputed whenever a relocation ends
      const f = new Vector3(Math.sin(ry), 0, Math.cos(ry));
      const s = new Vector3(Math.cos(ry), 0, -Math.sin(ry));
      const pk = { h, item, f, s, slot, targetSlot: -1, moving: false, mv: null, t: slot * 4.6, lat: 0, started: false, idling: false };
      pk.person = registerPerson(h, 'picker', file, pk);
      pk.person.nearShelf = z < -10 ? 1 : 3; // slots face wall shelf 01 (back) or 03 (right)
      pickers.push(pk);
    }
    return pickers.length;
  }
  function removePicker() {
    const p = pickers.pop();
    if (p) { p.item.dispose(); disposeHuman(p.h); }
    return pickers.length;
  }

  // ---------- picker relocation: walk to another shelf via the loop ----------
  // each slot joins the walk loop at a junction. Back-wall slots take a
  // straight spur north (the strip between shelf 01 and the loop's south
  // stretch is free of fixtures). Right-wall slots sit in the narrow corridor
  // behind shelf 03 (x 14.05–15), so they thread it at x=14.72 — squeezing
  // past any occupied slots — and round the shelf's south end at z=-8.8.
  function nearestT(x, z) {
    let best = Infinity, bt = 0;
    for (let i = 0; i < 400; i++) {
      const pt = walkPath.pointAt(i / 400);
      const d = (pt.x - x) ** 2 + (pt.z - z) ** 2;
      if (d < best) { best = d; bt = i / 400; }
    }
    return bt;
  }
  const CORRIDOR_X = 14.72;
  const SLOT_ROUTES = PICK_SLOTS.map(([bx, bz]) => {
    if (bz < -10) return { t: nearestT(bx, bz), wps: [] };
    return {
      t: nearestT(11.5, -8.8),
      wps: [new Vector3(11.5, 0, -8.8), new Vector3(CORRIDOR_X, 0, -8.8), new Vector3(CORRIDOR_X, 0, bz)],
    };
  });

  function startRelocate(p, target) {
    const u = p.h.metadata;
    if (u.groups.Idle) u.groups.Idle.stop();
    if (u.groups.PickUp) u.groups.PickUp.stop();
    u.movingState = undefined; // let applyGait start the Walk clip cleanly
    p.item.setEnabled(false);
    const g = jitterSlot(target);
    const route = SLOT_ROUTES[p.slot];
    const out = [...route.wps].reverse();
    out.push(walkPath.pointAt(route.t)); // merge exactly on the loop
    const dest = SLOT_ROUTES[target];
    const inn = [...dest.wps, new Vector3(g.x, 0, g.z)];
    p.targetSlot = target; // reserves the destination; p.slot frees at the merge
    p.speed = 0.03 + Math.random() * 0.018;
    p.cur = 0;
    p.moving = true;
    p.mv = {
      phase: 'out', wi: 0, out, inn,
      exitT: route.t, enterT: dest.t, t: 0,
      targetRy: g.ry, settleT: 0,
      shim: { t: 0, cur: 0, speed: p.speed }, // stands in for us in loopTraffic
    };
  }

  function finishRelocate(p) {
    const ry = p.mv.targetRy;
    p.h.rotation.y = ry;
    p.f.set(Math.sin(ry), 0, Math.cos(ry));
    p.s.set(Math.cos(ry), 0, -Math.sin(ry));
    p.item.rotation.y = ry;
    p.slot = p.targetSlot;
    p.targetSlot = -1;
    p.moving = false;
    p.mv = null;
    p.t = 2.0; // rejoin the pick cycle mid-idle, next pick a few seconds out
    p.idling = true;
    if (p.person) p.person.nearShelf = p.h.position.z < -10 ? 1 : 3;
  }

  function pickerMove(p, dt) {
    const m = p.mv;
    if (m.phase === 'loop') {
      let target = p.speed;
      let gap = Infinity, leader = null;
      for (const q of loopTraffic) {
        if (q === m.shim) continue;
        const d = (((q.t - m.t) % 1) + 1) % 1 * walkPath.length;
        if (d > 0.001 && d < gap) { gap = d; leader = q; }
      }
      if (leader && gap < MIN_GAP) target = 0;
      else if (leader && gap < FOLLOW_GAP) target = Math.min(target, leader.cur ?? leader.speed);
      if (robotAhead(p.h)) target = 0;
      p.cur += (target - p.cur) * Math.min(1, dt * 6);
      const remain = (((m.enterT - m.t) % 1) + 1) % 1;
      const stepT = p.cur * dt;
      if (remain <= Math.max(0.002, stepT)) { m.t = m.enterT; m.phase = 'in'; m.wi = 0; }
      else m.t = (m.t + stepT) % 1;
      p.h.position.copyFrom(walkPath.pointAt(m.t));
      const tan = walkPath.tangentAt(m.t);
      p.h.rotation.y = Math.atan2(tan.x, tan.z);
      m.shim.t = m.t;
      m.shim.cur = p.cur;
    } else if (m.phase === 'settle') {
      p.cur += (0 - p.cur) * Math.min(1, dt * 6);
      m.settleT += dt;
      p.h.rotation.y = shortestLerp(p.h.rotation.y, m.targetRy, Math.min(1, dt * 8));
      if (m.settleT > 0.45) { applyGait(p); finishRelocate(p); return; }
    } else { // 'out' / 'in': straight waypoint legs, verified clear of fixtures
      const wps = m.phase === 'out' ? m.out : m.inn;
      const tgt = wps[m.wi];
      const dx = tgt.x - p.h.position.x, dz = tgt.z - p.h.position.z;
      const dist = Math.hypot(dx, dz);
      let target = p.speed;
      if (robotAhead(p.h)) target = 0;
      p.cur += (target - p.cur) * Math.min(1, dt * 6);
      const step = p.cur * walkPath.length * dt;
      if (dist > 0.001) {
        const k = Math.min(1, step / dist);
        p.h.position.x += dx * k;
        p.h.position.z += dz * k;
        if (p.cur > p.speed * 0.2) p.h.rotation.y = Math.atan2(dx, dz);
      }
      if (dist <= Math.max(0.12, step)) {
        m.wi++;
        if (m.wi >= wps.length) {
          if (m.phase === 'out') { m.phase = 'loop'; m.t = m.exitT; p.slot = -1; }
          else { m.phase = 'settle'; m.settleT = 0; }
        }
      }
    }
    applyGait(p);
  }

  // starting crowd: 3 already on the walk loop, 2 browsing the shelves
  spawnOnLoop(); spawnOnLoop(); spawnOnLoop();
  addPicker(); addPicker();

  const PICK_PERIOD = 9;
  const PICK_CLIP = 1.79; // PickUp is 1.25s, played at 0.7 speed
  const _shelfPt = new Vector3(), _handPt = new Vector3();
  function pickCycle(p, dt) {
    const u = p.h.metadata;
    if (!u.ready) return;
    if (!p.started) { // first frame after load → settle into Idle
      p.started = true; p.idling = true;
      const gi = u.groups.Idle;
      if (gi) gi.start(true, 1.0, gi.from, gi.to);
    }
    p.t += dt;
    const t = p.t % PICK_PERIOD;
    if (t < dt) { // new cycle → new spot on the shelf, play the pick clip
      p.lat = (Math.random() - 0.5) * 1.2;
      if (p.person) p.person.picks++; // feeds "Items picked" on the detail card
      const g = u.groups.PickUp;
      if (g) { if (u.groups.Idle) u.groups.Idle.stop(); p.idling = false; g.start(false, 0.7, g.from, g.to); }
    }
    if (!p.idling && t >= PICK_CLIP) { // pick clip done → back to Idle
      p.idling = true;
      const gi = u.groups.Idle;
      if (gi) gi.start(true, 1.0, gi.from, gi.to);
    }

    // product spawn point on the bottom shelf in front of the shopper
    _shelfPt.copyFrom(p.f).scaleInPlace(0.95).addInPlace(p.h.position)
      .addInPlace(_handPt.copyFrom(p.s).scaleInPlace(p.lat));
    _shelfPt.y = 1.3;

    if (t >= 0.55 && t < 4.9 && u.fist) {
      p.item.setEnabled(true);
      _handPt.copyFrom(u.fist.getAbsolutePosition());
      if (t < 1.15) Vector3.LerpToRef(_shelfPt, _handPt, easeInOutCubic((t - 0.55) / 0.6), p.item.position);
      else if (t < 4.2) p.item.position.copyFrom(_handPt);
      else Vector3.LerpToRef(_handPt, _shelfPt, easeInOutCubic((t - 4.2) / 0.7), p.item.position);
    } else {
      p.item.setEnabled(false);
    }
  }

  // ---------- service robot ----------
  function makeRobot() {
    const g = group('robot');
    const shell = pbr('robotShell', { color: 0xdfe7f2, roughness: 0.35, metalness: 0.4 });
    const dark = pbr('robotDark', { color: 0x223150, roughness: 0.5, metalness: 0.5 });
    const glow = basic('robotGlow', { color: 0x35c3ff });

    box(1.1, 0.35, 1.4, dark, 0, 0, 0).parent = g;
    const wheels = [];
    for (const [wx, wz] of [[-0.5, 0.45], [0.5, 0.45], [-0.5, -0.45], [0.5, -0.45]]) {
      const w = MeshBuilder.CreateCylinder('rwheel', { diameter: 0.44, height: 0.12, tessellation: 16 }, scene);
      w.material = mat.tire;
      w.rotation.z = Math.PI / 2;
      w.position.set(wx, 0.22, wz);
      w.isPickable = false;
      shadowGen.addShadowCaster(w);
      w.parent = g;
      wheels.push(w);
    }
    const torso = MeshBuilder.CreateCapsule('torso', { radius: 0.5, height: 1.9, tessellation: 16 }, scene);
    torso.material = shell;
    torso.position.set(0, 1.25, 0);
    torso.isPickable = false;
    shadowGen.addShadowCaster(torso);
    torso.parent = g;
    const screen = MeshBuilder.CreatePlane('rscreen', { width: 0.6, height: 0.5 }, scene);
    const screenMat = basic('rscreenMat', { color: 0x35c3ff, alpha: 0.85 });
    screen.material = screenMat;
    screen.position.set(0, 1.35, 0.5);
    screen.isPickable = false;
    screen.parent = g;

    const headPivot = group('headPivot');
    headPivot.position.set(0, 1.95, 0);
    headPivot.parent = g;
    const head = box(0.7, 0.45, 0.6, shell, 0, 0, 0);
    head.position.set(0, 0.2 + 0.225, 0);
    head.parent = headPivot;
    const visor = MeshBuilder.CreatePlane('visor', { width: 0.6, height: 0.28 }, scene);
    visor.material = basic('visorMat', { color: 0x0a1830 });
    visor.position.set(0, 0.22, 0.31);
    visor.isPickable = false;
    visor.parent = headPivot;
    const eyes = [];
    for (const ex of [-0.13, 0.13]) {
      const e = MeshBuilder.CreateSphere('eye', { diameter: 0.12, segments: 10 }, scene);
      e.material = glow;
      e.position.set(ex, 0.22, 0.33);
      e.isPickable = false;
      e.parent = headPivot;
      eyes.push(e);
    }
    const ant = MeshBuilder.CreateCylinder('ant', { diameter: 0.04, height: 0.3, tessellation: 8 }, scene);
    ant.material = dark;
    ant.position.set(0, 0.55, 0);
    ant.isPickable = false;
    ant.parent = headPivot;
    const beacon = MeshBuilder.CreateSphere('beacon', { diameter: 0.14, segments: 10 }, scene);
    beacon.material = glow;
    beacon.position.set(0, 0.72, 0);
    beacon.isPickable = false;
    beacon.parent = headPivot;

    g.metadata = { wheels, headPivot, eyes, beacon, screenMat };
    return g;
  }

  // ---------- robot navigation network ----------
  const NODES = [
    [-10, -11.5], [4, -11.5], [9, -11.5], [11.2, -6], [11.2, 1], [11.2, 6.5],
    [-3.3, -1.2], [4, -1.2], [9, -1.2], [-3.3, 2.7], [9, 2.7], [-3.7, 2.7],
    [-13.5, 2.7], [-13.5, 6], [-3.7, 6], [4, 7], [-4.3, 6], [-8, 6], [-8, 14], [-4.3, 14],
  ];
  const EDGES = [
    [0, 1], [1, 2], [1, 7], [2, 3], [3, 4], [4, 5], [4, 8],
    [6, 7], [7, 8], [6, 9], [8, 10], [9, 10], [9, 11], [11, 12],
    [12, 13], [13, 14], [14, 11], [5, 15], [15, 14], [14, 16],
    [16, 17], [17, 18], [18, 19], [19, 16],
  ];
  const EDGE_Y = 0.06;
  const EDGE_BASE_OPACITY = 0.28;

  const adj = NODES.map(() => []);
  EDGES.forEach(([a, b], ei) => { adj[a].push({ to: b, edge: ei }); adj[b].push({ to: a, edge: ei }); });
  function edgeBetween(a, b) { for (const e of adj[a]) if (e.to === b) return e.edge; return -1; }

  const edgeObjs = EDGES.map(([a, b]) => {
    const va = new Vector3(NODES[a][0], EDGE_Y, NODES[a][1]);
    const vb = new Vector3(NODES[b][0], EDGE_Y, NODES[b][1]);
    const len = Vector3.Distance(va, vb);
    const m = MeshBuilder.CreateBox('edge', { width: 0.2, height: 0.03, depth: len }, scene);
    const mid = va.add(vb).scale(0.5);
    m.position.copyFrom(mid);
    m.rotation.y = Math.atan2(vb.x - va.x, vb.z - va.z);
    const em = basic('edgeMat', { color: 0x35c3ff, alpha: EDGE_BASE_OPACITY });
    m.material = em;
    m.isPickable = false;
    m.parent = world;
    return { mesh: m, mat: em, lastVisited: -999 };
  });

  const nodeDots = NODES.map(([x, z]) => {
    const m = MeshBuilder.CreateSphere('nodeDot', { diameter: 0.32, segments: 12 }, scene);
    const ndm = basic('nodeDotMat', { color: 0x9fe6ff, alpha: 0.9 });
    ndm.emissiveColor.scaleInPlace(1.4); // push above bloom threshold so junctions glow
    m.material = ndm;
    m.position.set(x, EDGE_Y + 0.06, z);
    m.isPickable = false;
    m.parent = world;
    m.metadata = { t: Math.random() * Math.PI * 2 };
    return m;
  });

  const robot = { g: makeRobot(), speed: 3.4 };
  robot.g.parent = world;

  // cyan scan cone parented to the head pivot, so the existing head-scan
  // sweep (rotation.y) carries the beam across the shelves for free
  const scanBeam = MeshBuilder.CreateCylinder('scanBeam', {
    diameterTop: 2.8, diameterBottom: 0.08, height: 4.2, tessellation: 24,
  }, scene);
  const scanBeamMat = new StandardMaterial('scanBeamMat', scene);
  scanBeamMat.disableLighting = true;
  scanBeamMat.emissiveColor = C3(0x35c3ff).scale(1.3);
  scanBeamMat.alpha = 0.22;
  scanBeamMat.alphaMode = Engine.ALPHA_ADD;
  scanBeamMat.backFaceCulling = false;
  scanBeamMat.disableDepthWrite = true;
  scanBeam.material = scanBeamMat;
  scanBeam.isPickable = false;
  scanBeam.rotation.x = Math.PI / 2 + 0.28; // forward, tilted down at the shelves
  scanBeam.position.set(0, 0.22 - 0.55, 2.0); // apex at the head, cone opening outward
  scanBeam.parent = robot.g.metadata.headPivot;

  function nodeVec(i, out) { return out.set(NODES[i][0], 0, NODES[i][1]); }
  function headingYaw(from, to) { return Math.atan2(NODES[to][0] - NODES[from][0], NODES[to][1] - NODES[from][1]); }
  function shortestLerp(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }
  function chooseNext(at, cameFrom) {
    let cand = adj[at].filter((o) => o.to !== cameFrom);
    if (cand.length === 0) cand = adj[at];
    cand.sort((p, q) => edgeObjs[p.edge].lastVisited - edgeObjs[q.edge].lastVisited);
    return cand[0].to;
  }

  const TURN_TIME = 0.32;
  const nav = { from: 0, to: 1, u: 0, mode: 'travel', next: 1, yaw: headingYaw(0, 1), startYaw: 0, targetYaw: 0, turnT: 0 };
  robot.g.rotation.y = nav.yaw;

  const _na = new Vector3();
  const _nb = new Vector3();

  // ---------- bloom / tone mapping ----------
  const pipeline = new DefaultRenderingPipeline('default', true, scene, [camera]);
  // the HDR pipeline bypasses canvas MSAA, and FXAA alone smears fine edges —
  // real MSAA on the render target keeps the image crisp
  pipeline.samples = 4;
  pipeline.fxaaEnabled = false;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.7;   // lower cutoff → the cyan neon blooms like V4's UnrealBloom
  pipeline.bloomWeight = 0.55;     // ≈ UnrealBloomPass strength 0.55
  pipeline.bloomKernel = 56;
  pipeline.bloomScale = 0.5;
  pipeline.imageProcessingEnabled = true;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.exposure = 1.12;
  pipeline.imageProcessing.contrast = 1.0;

  // ---------- animation ----------
  const _tmp = new Vector3();
  const _cardAnchor = new Vector3();
  const _cardScreen = new Vector3();

  // traffic rules: follow the walker ahead instead of clipping through them,
  // and brake for the robot when it is crossing in front (the robot yields
  // too — see the nav block — so a standoff always resolves)
  const FOLLOW_GAP = 2.0;   // start matching the leader's speed (path units)
  const MIN_GAP = 1.0;      // full stop this close to the leader
  const ROBOT_BRAKE = 2.4;  // person stops when the robot is this close ahead

  // shared brake: stop when the robot is close and roughly ahead, even a
  // waiting one — a mutual standoff is broken by the robot reversing out
  // after 2.5s, never by walking through
  function robotAhead(h) {
    const rx = robot.g.position.x - h.position.x;
    const rz = robot.g.position.z - h.position.z;
    const rd = Math.hypot(rx, rz);
    return rd < ROBOT_BRAKE &&
      (rx * Math.sin(h.rotation.y) + rz * Math.cos(h.rotation.y)) / (rd || 1) > 0.15;
  }

  // stride comes from the GLB Walk clip; swap to Idle while held up
  function applyGait(p) {
    const u = p.h.metadata;
    if (!u.ready) return;
    const moving = p.cur > p.speed * 0.25;
    if (u.movingState !== moving) {
      u.movingState = moving;
      const on = moving ? u.groups.Walk : u.groups.Idle;
      const off = moving ? u.groups.Idle : u.groups.Walk;
      if (off) off.stop();
      if (on) on.start(true, 1.0, on.from, on.to);
    }
    if (moving && u.groups.Walk) u.groups.Walk.speedRatio = p.cur * 45;
  }

  // entrance spur: straight walk between the outside pad and the loop junction
  const _spurTgt = new Vector3();
  function spurMove(p, dt) {
    if (p.mode === 'enter') _spurTgt.copyFrom(mergePoint);
    else _spurTgt.set(DOOR.x, 0, p.wp === 0 ? DOOR.zDoor : DOOR.zOut + 0.5);
    const dx = _spurTgt.x - p.h.position.x, dz = _spurTgt.z - p.h.position.z;
    const dist = Math.hypot(dx, dz);
    let target = p.speed;
    // arriving: wait by the junction if the loop is congested right there
    if (p.mode === 'enter' && dist < 1.6) {
      const busy = walkers.some((q) => q !== p && q.mode === 'loop' &&
        Math.hypot(q.h.position.x - mergePoint.x, q.h.position.z - mergePoint.z) < 1.3);
      if (busy) target = 0;
    }
    p.cur = (p.cur ?? p.speed) + (target - (p.cur ?? p.speed)) * Math.min(1, dt * 6);
    const step = p.cur * walkPath.length * dt;
    if (dist > 0.001) {
      const k = Math.min(1, step / dist);
      p.h.position.x += dx * k;
      p.h.position.z += dz * k;
      if (p.cur > p.speed * 0.2) p.h.rotation.y = Math.atan2(dx, dz);
    }
    if (dist <= Math.max(0.12, step)) {
      if (p.mode === 'enter') { p.mode = 'loop'; p.t = tMerge; }
      else if (p.wp === 0) p.wp = 1;
      else p.done = true; // out the door and gone — collected after the update
    }
    applyGait(p);
  }

  function walk(p, dt) {
    if (p.mode !== 'loop') { spurMove(p, dt); return; }

    // pick a target speed, then ease the current speed toward it
    let target = p.speed;
    let gap = Infinity, leader = null;
    for (const q of loopTraffic) {
      if (q === p) continue;
      const d = (((q.t - p.t) % 1) + 1) % 1 * walkPath.length;
      if (d > 0.001 && d < gap) { gap = d; leader = q; }
    }
    if (leader && gap < MIN_GAP) target = 0;
    else if (leader && gap < FOLLOW_GAP) target = Math.min(target, leader.cur ?? leader.speed);
    if (robotAhead(p.h)) target = 0;
    p.cur = (p.cur ?? p.speed) + (target - (p.cur ?? p.speed)) * Math.min(1, dt * 6);

    p.t = (p.t + p.cur * dt) % 1;
    p.h.position.copyFrom(walkPath.pointAt(p.t));
    const tan = walkPath.tangentAt(p.t);
    p.h.rotation.y = Math.atan2(tan.x, tan.z);
    // the ±0.3 clamp keeps the worst case inside the spline's verified 0.68
    // obstacle clearance with a body half-width to spare
    p.latEase = Math.min(1, p.latEase + dt * 0.5);
    const off = Math.max(-0.3, Math.min(0.3,
      p.lat + Math.sin(elapsed * p.wobFreq + p.wobPhase) * 0.08)) * p.latEase;
    p.h.position.x += tan.z * off;
    p.h.position.z -= tan.x * off;

    // flagged to leave → turn onto the entrance spur at the junction
    if (p.exit) {
      const d = (((tMerge - p.t) % 1) + 1) % 1 * walkPath.length;
      if (d < 0.6) { p.mode = 'exitwalk'; p.wp = 0; }
    }
    applyGait(p);
  }

  // "ready" = first real frame on screen (shaders/textures compiled), not just
  // factory return — the dashboard keeps its boot overlay up until this fires.
  scene.executeWhenReady(() => {
    scene.onAfterRenderObservable.addOnce(() => onReady?.());
  });

  let nextSwap = 18; // ambient door traffic: one leaves, another arrives
  let nextRelocate = 24 + Math.random() * 16; // shoppers drift between shelves
  // per-frame update. forcedDt lets the debug handle fast-forward the sim
  // (controller._step) in a throttled background tab without real frames
  const frame = (forcedDt) => {
    const dt = forcedDt ?? Math.min(engine.getDeltaTime() / 1000, 0.05);
    elapsed += dt;
    const time = elapsed;

    // door queue: spawn the next queued arrival once the pad is clear
    if (pendingEntries > 0) {
      const padBusy = walkers.some((w) =>
        Math.hypot(w.h.position.x - DOOR.x, w.h.position.z - DOOR.zOut) < 1.6);
      if (!padBusy) {
        pendingEntries--;
        const p = makeWalker('enter');
        p.h.position.set(DOOR.x, 0, DOOR.zOut);
        p.h.rotation.y = Math.PI; // facing into the store
        p.cur = 0;
      }
    }
    // every so often a shopper heads home and a new one shows up (count stays)
    if (time > nextSwap) {
      nextSwap = time + 14 + Math.random() * 10;
      if (walkers.some((w) => w.mode === 'loop' && !w.exit) && flagExit()) pendingEntries++;
    }
    // ... and a browsing shopper wanders off to a different shelf
    if (time > nextRelocate) {
      nextRelocate = time + 30 + Math.random() * 30;
      const idle = pickers.filter((pk) => !pk.moving && pk.idling);
      const free = freePickSlots();
      if (idle.length && free.length) {
        startRelocate(idle[Math.floor(Math.random() * idle.length)],
          free[Math.floor(Math.random() * free.length)]);
      }
    }

    loopTraffic = walkers.filter((w) => w.mode === 'loop');
    for (const pk of pickers) if (pk.moving && pk.mv.phase === 'loop') loopTraffic.push(pk.mv.shim);
    walkers.forEach((p) => walk(p, dt));
    for (let i = walkers.length - 1; i >= 0; i--) {
      if (walkers[i].done) { disposeHuman(walkers[i].h); walkers.splice(i, 1); }
    }

    // auto sliding doors: glide open for anyone near the threshold
    {
      const near = walkers.some((w) =>
        Math.hypot(w.h.position.x - DOOR.x, w.h.position.z - DOOR.zDoor) < 2.6);
      doorOpenAmt += ((near ? 1 : 0) - doorOpenAmt) * Math.min(1, dt * 5);
      for (const pnl of doorPanels) {
        pnl.mesh.position.x = pnl.closedX + pnl.side * doorOpenAmt * 1.18;
      }
    }

    // robot graph traversal
    {
      const u = robot.g.metadata;
      if (nav.mode === 'travel') {
        // yield to shoppers directly ahead; after 2.5s give up and take the
        // edge back the other way (breaks any person/robot standoff)
        let blocked = false;
        for (const w of [...walkers, ...pickers.filter((pk) => pk.moving)]) {
          const dx = w.h.position.x - robot.g.position.x;
          const dz = w.h.position.z - robot.g.position.z;
          const d = Math.hypot(dx, dz);
          if (d < 2.0 && (dx * Math.sin(nav.yaw) + dz * Math.cos(nav.yaw)) / (d || 1) > 0.2) {
            blocked = true;
            break;
          }
        }
        if (blocked) {
          nav.waitT = (nav.waitT || 0) + dt;
          if (nav.waitT > 2.5) {
            nav.waitT = 0;
            const back = nav.from; nav.from = nav.to; nav.to = back;
            nav.u = 1 - nav.u;
            nav.startYaw = nav.yaw;
            nav.targetYaw = headingYaw(nav.from, nav.to);
            nav.turnT = 0;
            nav.reversing = true;
            nav.mode = 'turn';
          }
        } else {
          nav.waitT = 0;
          nodeVec(nav.from, _na); nodeVec(nav.to, _nb);
          const segLen = Vector3.Distance(_na, _nb) || 1;
          nav.u += (robot.speed / segLen) * dt;
          if (nav.u >= 1) {
            nav.u = 1;
            edgeObjs[edgeBetween(nav.from, nav.to)].lastVisited = time;
            nav.next = chooseNext(nav.to, nav.from);
            nav.startYaw = nav.yaw;
            nav.targetYaw = headingYaw(nav.to, nav.next);
            nav.turnT = 0;
            nav.mode = 'turn';
          }
          Vector3.LerpToRef(_na, _nb, nav.u, _tmp);
          robot.g.position.set(_tmp.x, 0, _tmp.z);
          robot.g.rotation.y = nav.yaw;
          u.wheels.forEach((w) => { w.rotation.x += robot.speed * dt * 2.4; });
        }
      } else {
        nav.turnT += dt;
        const t = Math.min(1, nav.turnT / TURN_TIME);
        nav.yaw = shortestLerp(nav.startYaw, nav.targetYaw, t);
        robot.g.rotation.y = nav.yaw;
        if (t >= 1) {
          nav.yaw = nav.targetYaw;
          if (nav.reversing) nav.reversing = false; // from/to already swapped mid-edge
          else { nav.from = nav.to; nav.to = nav.next; nav.u = 0; }
          nav.mode = 'travel';
        }
      }
      u.headPivot.rotation.y = Math.sin(time * 0.8) * 0.5;
      scanBeamMat.alpha = 0.16 + Math.abs(Math.sin(time * 2.2)) * 0.12;
      const pulse = 0.6 + Math.abs(Math.sin(time * 3)) * 0.4;
      u.beacon.scaling.setAll(0.7 + pulse);
      u.eyes.forEach((e) => e.scaling.setAll(pulse));
      u.screenMat.alpha = 0.6 + Math.sin(time * 5) * 0.2;
    }

    // visited edge glow
    for (const e of edgeObjs) {
      const glow = Math.max(0, 1 - (time - e.lastVisited) / 3);
      e.mat.alpha = EDGE_BASE_OPACITY + glow * 0.6;
    }
    for (const d of nodeDots) d.scaling.setAll(1 + Math.sin(time * 3 + d.metadata.t) * 0.3);

    pickers.forEach((p) => (p.moving ? pickerMove(p, dt) : pickCycle(p, dt))); // idle sway comes from the GLB Idle clip

    badges.forEach((b) => { b.position.y = b.metadata.base + Math.sin(time * 1.5 + b.metadata.t) * 0.4; });

    for (const sn of sensors) sn.metadata.lens.scaling.setAll(1 + Math.sin(time * 4 + sn.metadata.t) * 0.4);

    if (selOutline.isVisible) selOutline.alpha = 0.7 + Math.sin(time * 5) * 0.25;

    // hover glow shell
    {
      const target = (hoverId && hoverId !== selectedId) ? 1 : 0;
      hoverProgress += (target - hoverProgress) * Math.min(1, dt * 12);
      if (target === 0 && hoverProgress < 0.01) {
        hoverGlow.isVisible = false;
      } else {
        const ud = hoverGlow.metadata;
        const s = 0.97 + 0.03 * hoverProgress;
        hoverGlow.isVisible = true;
        hoverGlow.scaling.set(ud.sx * s, ud.sy * s, ud.sz * s);
        hoverGlow.position.set(ud.cx, ud.cy, ud.cz);
        hoverMat.alpha = 0.26 * hoverProgress;
      }
    }

    // person selection ring / hover ring / floating card follow
    {
      const selE = selectedPersonId ? persons.get(selectedPersonId) : null;
      if (selE) {
        const pu = 1 + Math.sin(time * 5) * 0.08;
        selRing.isVisible = true;
        selRing.position.set(selE.h.position.x, 0.07, selE.h.position.z);
        selRing.scaling.set(pu, 1, pu);
        selRing.material.alpha = 0.65 + Math.sin(time * 5) * 0.2;
      } else {
        selRing.isVisible = false;
      }
      const hovE = hoverPersonId && hoverPersonId !== selectedPersonId ? persons.get(hoverPersonId) : null;
      if (hovE) {
        hoverRing.isVisible = true;
        hoverRing.position.set(hovE.h.position.x, 0.07, hovE.h.position.z);
      } else {
        hoverRing.isVisible = false;
      }
      if (selE && cardEl) {
        // project a point above the head → CSS px → clamp inside the stage
        _cardAnchor.set(selE.h.position.x, selE.h.position.y + 2.5, selE.h.position.z);
        Vector3.ProjectToRef(
          _cardAnchor, Matrix.IdentityReadOnly, scene.getTransformMatrix(),
          camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()), _cardScreen,
        );
        const hw = engine.getHardwareScalingLevel(); // render px → CSS px (adaptToDeviceRatio)
        const W = canvas.clientWidth || 1, H = canvas.clientHeight || 1;
        const cw = cardEl.offsetWidth || 200, ch = cardEl.offsetHeight || 150;
        const x = Scalar.Clamp(_cardScreen.x * hw, cw / 2 + 8, Math.max(cw / 2 + 8, W - cw / 2 - 8));
        const y = Scalar.Clamp(_cardScreen.y * hw, ch + 18, Math.max(ch + 18, H - 10));
        cardEl.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) translateY(-10px)`;
        cardEl.style.visibility = 'visible';
      } else if (cardEl) {
        cardEl.style.visibility = 'hidden';
      }
    }

    // focus dimming tween
    if (dim.active) {
      dim.t += dt / DIM_DUR;
      const e = easeInOutCubic(Math.min(1, dim.t));
      dim.value = dim.from + (dim.to - dim.from) * e;
      applyDim(dim.value);
      if (dim.t >= 1) { dim.active = false; if (dim.to === 0) dimFocus = null; }
    }

    // camera fly-to tween
    if (fly.active) {
      fly.t += dt / FLY_DUR;
      const e = easeInOutCubic(Math.min(1, fly.t));
      camera.alpha = fly.fromAlpha + (fly.toAlpha - fly.fromAlpha) * e;
      camera.beta = fly.fromBeta + (fly.toBeta - fly.fromBeta) * e;
      camera.radius = fly.fromRadius + (fly.toRadius - fly.fromRadius) * e;
      Vector3.LerpToRef(fly.fromTarget, fly.toTarget, e, camera.target);
      zoom = fly.fromZoom + (fly.toZoom - fly.fromZoom) * e;
      if (fly.t >= 1) {
        fly.active = false;
        zoomTarget = zoom;
        camera.lowerRadiusLimit = camera.upperRadiusLimit = camera.radius;
        camera.attachControl(canvas, true);
      }
    } else {
      zoom += (zoomTarget - zoom) * Math.min(1, dt * 9);
    }

    applyOrtho();
    if (forcedDt === undefined) scene.render();
  };
  engine.runRenderLoop(frame);

  // ---------- resize ----------
  const onResize = () => {
    width = container.clientWidth || window.innerWidth;
    height = container.clientHeight || window.innerHeight;
    if (width === 0 || height === 0) return;
    engine.resize();
  };
  window.addEventListener('resize', onResize);
  const ro = new ResizeObserver(onResize);
  ro.observe(container);

  // ---------- cleanup ----------
  function dispose() {
    engine.stopRenderLoop();
    ro.disconnect();
    window.removeEventListener('resize', onResize);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    scene.onPointerObservable.remove(pointerObs);
    scene.dispose();
    engine.dispose();
    if (canvas.parentNode === container) container.removeChild(canvas);
  }

  const controller = {
    dispose, selectShelf, scene,
    _step: (dt = 0.05, n = 1) => { for (let i = 0; i < n; i++) frame(dt); }, // debug fast-forward

    // crowd steppers in the dashboard; counts() feeds the initial UI state
    people: {
      addWalker, removeWalker, addPicker, removePicker,
      maxTotal: MAX_PEOPLE,
      counts: () => ({ walkers: logicalWalkers(), pickers: pickers.length }),
      // person selection: React pushes the id in, polls live card data out,
      // and hands over the card element for the per-frame follow transform.
      select: selectPerson,
      get: getPersonData,
      list: () => [...persons.keys()].map(getPersonData),
      bindCard,
    },
  };
  if (typeof window !== 'undefined') window.__storeBabylon = controller; // debug handle
  return controller;
}
