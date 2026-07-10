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

export function createSmartStoreBabylonScene(container, { onSelectShelf, onSelectPerson, onReady, onShelfEvent } = {}) {
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
  // one shared material per product color (same params as the old per-box
  // pbr('prod') clones) — hundreds of unique materials made the initial
  // shader-compile wait dominate first load
  const prodMats = new Map();
  const prodMat = (col) => {
    if (!prodMats.has(col)) prodMats.set(col, pbr('prod', { color: col, roughness: 0.7 }));
    return prodMats.get(col);
  };

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
          box(0.62, ph, 0.55, prodMat(col), px, ly, pz).parent = g;
        }
        box(length, 0.16, 0.04, mat.label, 0, ly + 0.08, side * (depth / 2 + 0.02)).parent = g;
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
        box(0.6, ph, 0.5, prodMat(col), px, ly, 0.1).parent = g;
      }
      box(length, 0.16, 0.04, mat.label, 0, ly + 0.08, depth / 2 - 0.02).parent = g;
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

  // ---------- shelf locks: sliding glass doors + status LEDs on every zone ----------
  // shoppers must phone-scan a QR pedestal (built next to the pick slots) to
  // open a shelf — and a scan only parts the glass at the scanner's own seam
  // (~1.5m), never the whole shelf; a seam in use is exclusive to its holder
  // (slot reservation guarantees that). The dashboard's manual override is the
  // one master switch that opens every seam at once. The scene owns the lock
  // state machine and reports shelf-level transitions up through
  // onShelfEvent({ shelfId, type }); the dashboard only mirrors it. Zone 5 is
  // the offline shelf — amber LED, never unlocks — and zone 6 (checkout
  // counter) has nothing to enclose, so it gets the status strip only. Doors
  // slide toward their segment center (openings appear at the segment seams),
  // so no pane ever overhangs the shelf ends.
  const LOCK_RED = C3(0xe04848);
  const LOCK_GREEN = C3(0x4caf72);
  const LOCK_AMBER = C3(0xefb23a);
  const _ledCol = new Color3();
  const lockGlassMat = basic('lockGlass', { color: 0x35c3ff, alpha: 0.13 });
  const lockTrimMat = basic('lockTrim', { color: 0x35c3ff, alpha: 0.55 });

  // "UNLOCKED" hologram — one texture, one billboard per shelf
  const unlockTex = new DynamicTexture('unlockTag', { width: 512, height: 128 }, scene, true);
  unlockTex.hasAlpha = true;
  unlockTex.uScale = -1; unlockTex.uOffset = 1; // un-mirror text under right-handed billboard
  {
    const ctx = unlockTex.getContext();
    ctx.clearRect(0, 0, 512, 128);
    ctx.font = 'bold 64px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#4caf72';
    ctx.fillText('UNLOCKED', 256, 66);
    unlockTex.update();
  }

  const shelfLocks = zones.map((zn, i) => {
    const tagMat = new StandardMaterial('unlockTagMat' + (i + 1), scene);
    tagMat.disableLighting = true;
    tagMat.emissiveTexture = unlockTex;
    tagMat.opacityTexture = unlockTex;
    tagMat.backFaceCulling = false;
    const tag = MeshBuilder.CreatePlane('unlockTag' + (i + 1), { width: 2.4, height: 0.6 }, scene);
    tag.material = tagMat;
    tag.billboardMode = TransformNode.BILLBOARDMODE_ALL;
    tag.isPickable = false;
    tag.isVisible = false;
    tag.parent = world;
    return {
      id: i + 1, locked: true, offline: i + 1 === 5,
      masterOpen: false, masterAmt: 0, heldSeams: 0, seams: [],
      flash: 0, scanStamp: -9, panels: [], ledMats: [],
      tag, tagMat, tagT: Infinity,
    };
  });
  const emitShelfEvent = (shelfId, type) => onShelfEvent?.({ shelfId, type });

  function buildShelfLockRig(lk, unit, { length, zFront, faces, hBase, hTop, nseg: nsegOpt }) {
    const led = basic('lockLed' + lk.id, { color: 0xe04848 });
    lk.ledMats.push(led);
    const H = hTop - hBase;
    const nseg = nsegOpt ?? Math.max(2, Math.round(length / 4));
    const segW = length / nseg;
    // interior seams: openable units — each owns the two panes flanking it
    // (their glide toward segment centers parts the glass at the seam). The
    // anchor is the seam's world position, used to pair pick slots to seams.
    for (let si = 0; si < nseg - 1; si++) {
      const sx = -length / 2 + segW * (si + 1);
      const anchor = Vector3.TransformCoordinates(
        new Vector3(sx, 0, zFront * faces[0]), unit.computeWorldMatrix(true));
      lk.seams.push({ openAmt: 0, holders: 0, anchor });
    }
    for (const face of faces) { // 1 / -1 → the unit's local ±z front
      for (let si = 0; si < nseg; si++) {
        const cx = -length / 2 + segW * (si + 0.5);
        for (const dir of [-1, 1]) {
          // the two panes of a segment ride separate tracks so they can stack
          const zo = (zFront + (dir > 0 ? 0.05 : 0)) * face;
          const panel = box(segW / 2 - 0.03, H, 0.05, lockGlassMat, cx + dir * (segW / 4), hBase, zo);
          shadowGen.removeShadowCaster(panel);
          const trim = box(0.06, H, 0.07, lockTrimMat, dir * (segW / 4 - 0.04), -H / 2, 0);
          shadowGen.removeShadowCaster(trim); // bright leading edge
          trim.parent = panel;
          panel.parent = unit;
          panel.metadata = { shelfId: lk.id };
          panel.isPickable = true;
          // a dir=+1 pane retreats from the seam on its right (index si), a
          // dir=-1 pane from the seam on its left (si-1); end panes at the
          // shelf edges have no seam and only move on a master unlock
          const seam = lk.seams[dir > 0 ? si : si - 1] ?? null;
          lk.panels.push({ mesh: panel, closedX: cx + dir * (segW / 4), dir, slide: (segW / 4) * 0.94, seam });
        }
      }
      const strip = box(length, 0.1, 0.08, led, 0, hTop + 0.02, (zFront + 0.03) * face);
      shadowGen.removeShadowCaster(strip);
      strip.parent = unit;
      strip.metadata = { shelfId: lk.id };
    }
  }
  // shelves 01/03 take nseg 5: their 4 interior seams sit 1:1 on the pick
  // slots, so each shopper's scan parts the glass exactly where they stand
  buildShelfLockRig(shelfLocks[0], zones[0].unit, { length: 16, zFront: 0.76, faces: [1], hBase: 0.25, hTop: 5.85, nseg: 5 });
  buildShelfLockRig(shelfLocks[1], zones[1].unit, { length: 11, zFront: 0.86, faces: [1, -1], hBase: 0.12, hTop: 3.95 });
  buildShelfLockRig(shelfLocks[2], zones[2].unit, { length: 16, zFront: 0.76, faces: [1], hBase: 0.25, hTop: 5.85, nseg: 5 });
  buildShelfLockRig(shelfLocks[3], zones[3].unit, { length: 9, zFront: 0.86, faces: [1, -1], hBase: 0.12, hTop: 3.95 });
  buildShelfLockRig(shelfLocks[4], zones[4].unit, { length: 7, zFront: 0.86, faces: [1, -1], hBase: 0.12, hTop: 3.95 });
  { // checkout (06): status strip only
    const led = basic('lockLed6', { color: 0xe04848 });
    shelfLocks[5].ledMats.push(led);
    const strip = box(5.5, 0.08, 0.06, led, 0, 1.32, 1.28);
    shadowGen.removeShadowCaster(strip);
    strip.parent = zones[5].unit;
    strip.metadata = { shelfId: 6 };
  }

  // scan-kit shared materials — the per-shopper meshes are built in makeShopper
  const phoneBodyMat = pbr('phoneBody', { color: 0x101724, roughness: 0.35, metalness: 0.5 });
  // phone screen = the store app's QR pass, drawn once and shared by every
  // phone — the retrieve gesture holds it up long enough to be read
  const phoneScreenMat = basic('phoneScreen', { color: 0xffffff, alpha: 0.95 });
  {
    const qr = new DynamicTexture('phoneQrTex', { width: 128, height: 224 }, scene, true);
    const ctx = qr.getContext();
    ctx.fillStyle = '#eaf6ff'; // app card
    ctx.fillRect(0, 0, 128, 224);
    ctx.fillStyle = '#35c3ff'; // header bar + scan button
    ctx.fillRect(0, 0, 128, 30);
    ctx.fillRect(24, 192, 80, 16);
    ctx.fillStyle = '#101724';
    // QR block: deterministic module noise, then the three finder squares
    const M = 8, X = 16, Y = 48, N = 12; // module px, origin, grid size
    const finder = (r, c) => (r < 3 && c < 3) || (r < 3 && c >= N - 3) || (r >= N - 3 && c < 3);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (finder(r, c)) continue;
        const h = Math.abs(Math.sin(r * 12.9898 + c * 78.233) * 43758.5453) % 1;
        if (h > 0.5) ctx.fillRect(X + c * M, Y + r * M, M - 1, M - 1);
      }
    }
    for (const [fr, fc] of [[0, 0], [0, N - 3], [N - 3, 0]]) {
      ctx.fillRect(X + fc * M, Y + fr * M, 3 * M - 1, 3 * M - 1);
      ctx.fillStyle = '#eaf6ff';
      ctx.fillRect(X + fc * M + 5, Y + fr * M + 5, 3 * M - 11, 3 * M - 11);
      ctx.fillStyle = '#101724';
      ctx.fillRect(X + fc * M + 9, Y + fr * M + 9, 3 * M - 19, 3 * M - 19);
    }
    ctx.fillRect(40, 156, 48, 5); // caption lines under the code
    ctx.fillRect(32, 168, 64, 4);
    qr.update();
    phoneScreenMat.emissiveTexture = qr;
  }
  const phoneBeamMat = new StandardMaterial('phoneBeamMat', scene);
  phoneBeamMat.disableLighting = true;
  phoneBeamMat.emissiveColor = ACCENT.scale(1.6);
  phoneBeamMat.alpha = 0.65;
  phoneBeamMat.alphaMode = Engine.ALPHA_ADD;
  phoneBeamMat.disableDepthWrite = true;
  phoneBeamMat.backFaceCulling = false;
  function makeScanRingMat() {
    const m = new StandardMaterial('scanRingMat', scene);
    m.disableLighting = true;
    m.emissiveColor = LOCK_GREEN.scale(1.4);
    m.alpha = 0;
    m.alphaMode = Engine.ALPHA_ADD;
    m.disableDepthWrite = true;
    m.backFaceCulling = false;
    return m;
  }

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
      // lock LEDs keep their shared per-shelf material — the frame loop drives
      // their emissive by lock state, so cloning would orphan lk.ledMats
      if (!o.material || o.material.name.startsWith('lockLed')) return;
      let cl = cache.get(o.material);
      if (!cl) { cl = o.material.clone(o.material.name + '_z'); cache.set(o.material, cl); }
      o.material = cl;
    });
  });

  const DIM_FLOOR = 0.2;
  const dimSkip = new Set(['selOutline', 'hoverMat', ...shelfLocks.map((lk) => 'lockLed' + lk.id)]);
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
  // each .glb packs its buffers plus the clips we use: Idle / Walk / PickUp
  // (repacked from the original embedded-base64 .gltf — ~40% smaller and much
  // cheaper to parse). files load once into an AssetContainer, then every
  // person is a clone that owns its materials (per-person tints). appears
  // async; check metadata.ready.
  const CHAR_SCALE = 0.8; // raw models are ~3.3 units tall, scene humans ~2.6
  const CHAR_FILES = [
    'Casual_Male', 'Casual_Female', 'Casual2_Female', 'Casual3_Male', 'Suit_Male',
    'Casual2_Male', 'Casual3_Female', 'OldClassy_Female', 'Worker_Male',
  ];
  const charCache = new Map(); // file -> Promise<AssetContainer>
  function loadCharContainer(file) {
    if (!charCache.has(file)) {
      charCache.set(file, SceneLoader.LoadAssetContainerAsync('/models/', file + '.glb', scene));
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
  // Every shopper gets a mock Thai identity, gender-matched to its GLTF
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
      id, h, kind, ref, // ref: the shopper sim object (mode/exit/slot live there)
      custNo: String(id).padStart(2, '0'),
      name: `${first} ${last}`,
      initials: first.charAt(0) + last.charAt(0),
      color: cardColor(h.metadata.look.torso),
      spawnT: elapsed,
      picks: 0,
      nearShelf: 1, // set when a browse session starts; walking: computed live in getPersonData
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
    if (e.ref.mode === 'browse') {
      status = e.ref.shelfScan ? 'scanning' : 'browsing';
      near = e.nearShelf;
    } else {
      status = e.ref.verifying ? 'verifying'
        : e.ref.paying ? 'paying'
        : (e.ref.exit || e.ref.mode === 'exitwalk') ? 'leaving' : 'walking';
      near = nearestZone();
    }
    picks = e.picks; // cumulative across every browse session this visit
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
  // coarse arc samples for "is the robot parked astride the walk line" checks
  const walkPathPts = [];
  for (let i = 0; i < 200; i++) walkPathPts.push(walkPath.pointAt(i / 200));
  function nearWalkPath(x, z, r) {
    for (const q of walkPathPts) {
      const dx = q.x - x, dz = q.z - z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

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

  // ---------- exit: second storefront door + scan-to-pay gate ----------
  // one-way flow (diverges from V4): everyone enters at DOOR, walks the loop,
  // and leaves here — past the checkout stretch — after an auto-payment scan
  // at a fare gate on the exit spur. zIn anchors the loop junction search.
  const EXIT = { x: 11, zDoor: half, zOut: half + 1.9, zIn: 11.6 };
  const GATE = { z: 13.1, secs: 2.2, spacing: 1.25 }; // scan spot + queue slots behind it
  (function exitDoor() {
    const H = 2.5;
    box(0.16, H, 0.16, mat.metal, EXIT.x - 1.28, 0, EXIT.zDoor).parent = world;
    box(0.16, H, 0.16, mat.metal, EXIT.x + 1.28, 0, EXIT.zDoor).parent = world;
    // fill panes tie the exit into the entrance glass and the right corner so
    // the storefront reads as one continuous facade
    const paneL = box(1.36, H - 0.1, 0.06, glassMat, 9.04, 0, EXIT.zDoor);
    const paneR = box(2.72, H - 0.1, 0.06, glassMat, 13.64, 0, EXIT.zDoor);
    const header = box(6.7, 0.22, 0.2, mat.metal, 11.68, H, EXIT.zDoor);
    box(6.7, 0.06, 0.22, trimMat, 11.68, H + 0.22, EXIT.zDoor).parent = world;
    [paneL, paneR, header].forEach((m) => { m.parent = world; });
    // farewell pad outside, mirror of the entrance one
    const pad = box(3.4, 0.04, 2.6, mat.counter, EXIT.x, 0, EXIT.zDoor + 1.35);
    box(3.4, 0.02, 0.14, trimMat, EXIT.x, 0.04, EXIT.zDoor + 0.35).parent = world;
    pad.parent = world;
  })();
  const exitDoorPanels = [-1, 1].map((side) => {
    const panel = box(1.24, 2.34, 0.07, doorGlassMat, 0, 0, 0);
    box(0.1, 2.34, 0.08, trimMat, 0, -1.17, 0).parent = panel; // bright leading edge
    panel.position.set(EXIT.x + side * 0.62, 1.17 + 0.02, EXIT.zDoor + 0.14);
    panel.parent = world;
    return { mesh: panel, side, closedX: EXIT.x + side * 0.62 };
  });
  let exitDoorOpenAmt = 0;

  // fare-gate posts with camera heads + status lamps flanking the scan spot
  const gateLampMats = [];
  for (const side of [-1, 1]) {
    box(0.18, 1.18, 0.18, mat.metal, EXIT.x + side * 0.8, 0, GATE.z).parent = world;
    const cam = box(0.13, 0.13, 0.3, mat.shelfDk, EXIT.x + side * 0.8, 1.18, GATE.z);
    cam.rotation.x = 0.35; // pitched down at the person being scanned
    cam.parent = world;
    const lampMat = basic('gateLamp' + side, { color: 0x35c3ff, alpha: 0.95 });
    gateLampMats.push(lampMat);
    box(0.2, 0.05, 0.2, lampMat, EXIT.x + side * 0.8, 1.33, GATE.z).parent = world;
  }
  const LAMP_GREEN = C3(0x4caf72).scale(1.5);
  const LAMP_RED = C3(0xe04848).scale(1.5);

  // gate beam: an additive slab that sweeps up and down through the shopper
  // ("scanBeam" is taken by the robot's shelf-scanning cone)
  const gateBeamMat = new StandardMaterial('gateBeamMat', scene);
  gateBeamMat.disableLighting = true;
  gateBeamMat.emissiveColor = ACCENT.scale(1.5);
  gateBeamMat.alpha = 0.7;
  gateBeamMat.alphaMode = Engine.ALPHA_ADD;
  gateBeamMat.disableDepthWrite = true;
  gateBeamMat.backFaceCulling = false;
  const gateBeam = MeshBuilder.CreateBox('gateBeam', { width: 1.42, height: 0.05, depth: 0.7 }, scene);
  gateBeam.material = gateBeamMat;
  gateBeam.isPickable = false;
  gateBeam.isVisible = false;
  gateBeam.position.set(EXIT.x, 1, GATE.z);
  gateBeam.parent = world;

  // floating "฿xxx ✓" receipt that pops over the gate on payment success
  const paidTex = new DynamicTexture('paidTag', { width: 256, height: 96 }, scene, true);
  paidTex.update(); // never-updated DynamicTextures stay !isReady and stall scene.executeWhenReady — the boot overlay would spin forever
  paidTex.hasAlpha = true;
  paidTex.uScale = -1; paidTex.uOffset = 1; // un-mirror text under right-handed billboard
  const paidMat = new StandardMaterial('paidTagMat', scene);
  paidMat.disableLighting = true;
  paidMat.emissiveTexture = paidTex;
  paidMat.opacityTexture = paidTex;
  paidMat.backFaceCulling = false;
  const paidTag = MeshBuilder.CreatePlane('paidTagPlane', { width: 1.9, height: 0.71 }, scene);
  paidTag.material = paidMat;
  paidTag.billboardMode = TransformNode.BILLBOARDMODE_ALL;
  paidTag.isPickable = false;
  paidTag.isVisible = false;
  paidTag.position.set(EXIT.x, 2.1, GATE.z);
  paidTag.parent = world;
  let paidTagT = Infinity;
  function showPaidTag() {
    // shoppers carry no real basket (picked items fly back to the shelf), so
    // the charged amount is decorative
    const amt = 60 + Math.floor(Math.random() * 560);
    const ctx = paidTex.getContext();
    ctx.clearRect(0, 0, 256, 96);
    ctx.font = 'bold 54px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#4caf72';
    ctx.fillText(`฿${amt} ✓`, 128, 50);
    paidTex.update();
    paidTagT = 0;
    paidTag.isVisible = true;
  }

  // ---------- entry verification gate: scan-to-enter on the entrance spur ----------
  // arrivals stop between the posts for an identity sweep before merging onto
  // the loop; ~1 in 7 fails the first pass (red lamps) and rescans, everyone
  // passes eventually. Queue slots stretch back through the door (spurMove).
  const ENTRY_GATE = { z: 14.0, secs: 1.6, spacing: 1.25 };
  const entryLampMats = [];
  for (const side of [-1, 1]) {
    box(0.18, 1.18, 0.18, mat.metal, DOOR.x + side * 0.8, 0, ENTRY_GATE.z).parent = world;
    const cam = box(0.13, 0.13, 0.3, mat.shelfDk, DOOR.x + side * 0.8, 1.18, ENTRY_GATE.z);
    cam.rotation.x = -0.35; // pitched down at the person walking in from the door
    cam.parent = world;
    const lampMat = basic('entryGateLamp' + side, { color: 0x35c3ff, alpha: 0.95 });
    entryLampMats.push(lampMat);
    box(0.2, 0.05, 0.2, lampMat, DOOR.x + side * 0.8, 1.33, ENTRY_GATE.z).parent = world;
  }
  const entryBeam = MeshBuilder.CreateBox('entryGateBeam', { width: 1.42, height: 0.05, depth: 0.7 }, scene);
  entryBeam.material = gateBeamMat; // same additive sweep look as the exit gate
  entryBeam.isPickable = false;
  entryBeam.isVisible = false;
  entryBeam.position.set(DOOR.x, 1, ENTRY_GATE.z);
  entryBeam.parent = world;

  // floating "ID ✓" tag over the entry gate on a successful verification —
  // static text, so it's drawn once here (the update() also keeps
  // scene.executeWhenReady from stalling, same as paidTex above)
  const idTex = new DynamicTexture('idTag', { width: 256, height: 96 }, scene, true);
  idTex.hasAlpha = true;
  idTex.uScale = -1; idTex.uOffset = 1; // un-mirror text under right-handed billboard
  {
    const ctx = idTex.getContext();
    ctx.font = 'bold 54px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#4caf72';
    ctx.fillText('ID ✓', 128, 50);
    idTex.update();
  }
  const idMat = new StandardMaterial('idTagMat', scene);
  idMat.disableLighting = true;
  idMat.emissiveTexture = idTex;
  idMat.opacityTexture = idTex;
  idMat.backFaceCulling = false;
  const idTag = MeshBuilder.CreatePlane('idTagPlane', { width: 1.9, height: 0.71 }, scene);
  idTag.material = idMat;
  idTag.billboardMode = TransformNode.BILLBOARDMODE_ALL;
  idTag.isPickable = false;
  idTag.isVisible = false;
  idTag.position.set(DOOR.x, 2.1, ENTRY_GATE.z);
  idTag.parent = world;
  let idTagT = Infinity;
  function showIdTag() {
    idTagT = 0;
    idTag.isVisible = true;
  }

  // entry gate state: deny > 0 while the red "rescan" flash runs
  const entryGate = { user: null, flash: 0, deny: 0 };
  let enterSeq = 0; // queue order = spawn order at the outside pad

  // ---------- face-detection reticle: Face-ID corner brackets over the head ----------
  // one per gate, attached to whoever owns the scanner right now. Pure
  // visuals — walk/queue/scan logic is untouched. Brackets are drawn once in
  // white and tinted per state through the material's emissiveColor.
  const reticleTex = new DynamicTexture('faceReticle', { width: 256, height: 256 }, scene, true);
  reticleTex.hasAlpha = true;
  {
    const ctx = reticleTex.getContext();
    ctx.clearRect(0, 0, 256, 256);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    const m = 30, len = 56, e = 256 - m;
    for (const [cx, cy, dx, dy] of [[m, m, 1, 1], [e, m, -1, 1], [m, e, 1, -1], [e, e, -1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * len, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * len);
      ctx.stroke();
    }
    reticleTex.update();
  }
  const _headPos = new Vector3();
  function makeFaceReticle(name) {
    const rMat = new StandardMaterial(name + 'Mat', scene);
    rMat.disableLighting = true;
    rMat.emissiveColor = ACCENT.clone();
    rMat.emissiveTexture = reticleTex;
    rMat.opacityTexture = reticleTex;
    rMat.backFaceCulling = false;
    const plane = MeshBuilder.CreatePlane(name, { size: 0.55 }, scene);
    plane.material = rMat;
    plane.billboardMode = TransformNode.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    plane.isVisible = false;
    plane.parent = world;
    const r = { target: null, t: 0, hold: 0, seed: Math.random() * 10 };
    r.start = (p) => { r.target = p; r.t = 0; r.hold = 0; rMat.alpha = 1; plane.isVisible = true; };
    r.succeed = () => { r.hold = 0.6; }; // green hold, then fade out
    r.step = (dt, denied) => {
      const p = r.target;
      if (!p) return;
      if (p.h.isDisposed()) { r.target = null; plane.isVisible = false; return; }
      r.t += dt;
      // follow the rig's head node when it has one (rides the idle bob);
      // fixed height above the root otherwise
      if (!p.headNode && p.h.metadata?.ready) {
        p.headNode = p.h.getDescendants(false).find((n) => /head/i.test(n.name)) || 'none';
      }
      if (p.headNode && p.headNode !== 'none') {
        _headPos.copyFrom(p.headNode.getAbsolutePosition());
      } else {
        _headPos.copyFrom(p.h.getAbsolutePosition());
        _headPos.y += 1.55;
      }
      if (r.t > 0.25 && r.hold <= 0) { // tracking jitter once locked
        _headPos.x += Math.sin(elapsed * 21 + r.seed) * 0.008;
        _headPos.y += Math.cos(elapsed * 17 + r.seed) * 0.008;
      }
      plane.setAbsolutePosition(_headPos);
      // lock-on: open at 1.8× and snap down onto the face
      plane.scaling.setAll(1 + Math.max(0, (0.25 - r.t) / 0.25) * 0.8);
      if (r.hold > 0) { // verified — green, hold, fade out while they walk on
        r.hold -= dt;
        rMat.emissiveColor.copyFrom(LAMP_GREEN);
        rMat.alpha = Math.min(1, r.hold / 0.35);
        if (r.hold <= 0) { r.target = null; plane.isVisible = false; rMat.alpha = 1; }
      } else if (denied) { // entry rescan — blink red with the post lamps
        const blink = Math.sin(elapsed * 16) > 0 ? 1 : 0.3;
        rMat.emissiveColor.copyFrom(LAMP_RED).scaleInPlace(blink);
      } else {
        rMat.emissiveColor.copyFrom(ACCENT);
      }
    };
    return r;
  }
  const entryReticle = makeFaceReticle('entryFaceReticle');
  const exitReticle = makeFaceReticle('exitFaceReticle');

  // gate state: one shopper scans at a time (single-file queue behind —
  // see gateRank/spurMove); flash keeps the lamps green just after a payment
  const gate = { user: null, flash: 0 };
  let exitSeq = 0; // queue order = order of turning onto the exit spur

  // ---------- crowd control (React steppers drive these) ----------
  // cycle through the character files — 9 files vs the 8-person cap means no
  // two people on the floor ever share a model (tints differ regardless)
  let charSeq = 0;
  const nextCharFile = () => CHAR_FILES[charSeq++ % CHAR_FILES.length];
  const MAX_PEOPLE = 8; // one cap for the whole crowd
  // every person in the store is a shopper: one agent that walks the loop and
  // sometimes turns off at a shelf for a browse session (mode machine:
  // enter → loop ⇄ toshelf → browse → fromshelf, exit via exitwalk)
  const shoppers = [];
  // everyone currently on the walk loop this frame — rebuilt by the render
  // loop, read by the follow-the-leader braking in walk()
  let loopTraffic = [];
  let pendingEntries = 0; // people queued to walk in through the door
  let pendingRemovals = 0; // − presses that must wait for a browse session to end
  const browsingCount = () =>
    shoppers.filter((s) => s.mode === 'browse' || s.mode === 'toshelf').length;
  const totalPeople = () =>
    shoppers.length + pendingEntries - pendingRemovals
    - shoppers.filter((s) => s.exit).length;

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

  // where the exit spur leaves the loop — just past the checkout stretch,
  // pointing at the scan gate
  let tExit = 0;
  {
    let best = Infinity;
    for (let i = 0; i < 400; i++) {
      const pt = walkPath.pointAt(i / 400);
      const d = Math.hypot(pt.x - EXIT.x, pt.z - EXIT.zIn);
      if (d < best) { best = d; tExit = i / 400; }
    }
  }

  function makeShopper(mode, t) {
    const file = nextCharFile();
    const h = makeHuman(file);
    // browse kit, disabled until a shelf visit: product box that rides the
    // hand, phone + beam for the QR scan, green access ring for the feet
    const itemMat = pbr('pickItemM', { color: productColors[0], roughness: 0.7 });
    const item = MeshBuilder.CreateBox('pickItem', { width: 0.4, height: 0.45, depth: 0.36 }, scene);
    item.material = itemMat;
    item.isPickable = false;
    item.setEnabled(false);
    shadowGen.addShadowCaster(item);
    item.parent = world;
    const phone = MeshBuilder.CreateBox('phone', { width: 0.1, height: 0.18, depth: 0.026 }, scene);
    phone.material = phoneBodyMat;
    const scr = MeshBuilder.CreateBox('phoneScr', { width: 0.084, height: 0.15, depth: 0.006 }, scene);
    scr.material = phoneScreenMat;
    scr.position.z = 0.014;
    scr.isPickable = false;
    scr.parent = phone;
    phone.isPickable = false;
    phone.setEnabled(false);
    phone.parent = world;
    const beam = MeshBuilder.CreateBox('phoneBeam', { width: 0.05, height: 0.05, depth: 1 }, scene);
    beam.material = phoneBeamMat;
    beam.isPickable = false;
    beam.setEnabled(false);
    beam.parent = world;
    const ringMat = makeScanRingMat();
    const ring = MeshBuilder.CreateTorus('scanRing', { diameter: 1.5, thickness: 0.06, tessellation: 48 }, scene);
    ring.material = ringMat;
    ring.isPickable = false;
    ring.setEnabled(false);
    ring.parent = world;
    const p = {
      h,
      mode, // 'enter' | 'loop' | 'exitwalk' | 'toshelf' | 'browse' | 'fromshelf'
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
      // shelf-visit state (slot >= 0 reserves the browse spot from the moment
      // the junction dice lands until the shopper merges back onto the loop)
      slot: -1, mv: null,
      cooldown: elapsed + 3 + Math.random() * 9, // no diving at a shelf right away
      item, itemMat, phone, beam, ring, ringMat, ringT: Infinity,
      shelfScan: null, access: null, accessSeam: null, idling: false, started: false,
      picksLeft: 0, pickT: 0, pickLat: 0, reach: 1,
      f: new Vector3(0, 0, 1), s: new Vector3(1, 0, 0),
    };
    if (mode === 'enter') p.enterSeq = ++enterSeq;
    p.h.parent = world;
    p.person = registerPerson(p.h, 'shopper', file, p);
    shoppers.push(p);
    return p;
  }
  function disposeShopper(p) {
    releaseShelfAccess(p); // last one out re-locks the shelf
    p.item.dispose(); p.itemMat.dispose();
    p.phone.dispose(); p.beam.dispose(); p.ring.dispose(); p.ringMat.dispose();
    disposeHuman(p.h);
  }
  // initial shoppers only: they were "already in the store" when the
  // dashboard opened, so they spawn directly on the loop
  function spawnOnLoop() {
    let t = Math.random();
    for (let tries = 0; tries < 12; tries++) {
      const clear = shoppers.every((q) => {
        if (q.mode !== 'loop') return true;
        const d = (((q.t - t) % 1) + 1) % 1;
        return Math.min(d, 1 - d) * walkPath.length > 2.0;
      });
      if (clear) break;
      t = Math.random();
    }
    makeShopper('loop', t);
  }
  function addPerson() {
    if (totalPeople() < MAX_PEOPLE) pendingEntries++;
    return totalPeople();
  }
  // gate queue cap: beyond 3 the tail slots stretch back over the robot
  // lane (node 5) and the loop's checkout stretch, so hold further exits
  // until it drains. Flagged shoppers still walking the loop count too —
  // they are queue members already in flight.
  function exitQueueLoad() {
    let n = 0;
    for (const w of shoppers) if (w.exit && (w.mode !== 'exitwalk' || w.wp === 0)) n++;
    return n;
  }
  // soonest to reach the exit junction walks out first. Only people actually
  // walking are candidates — browsers are never yanked out of a session; a
  // pending removal waits in pendingRemovals until someone rejoins the loop.
  function flagExit() {
    if (exitQueueLoad() >= 3) return false;
    let pick = null, best = 2;
    for (const w of shoppers) {
      if (w.exit || w.slot >= 0) continue;
      if (w.mode !== 'loop' && w.mode !== 'enter') continue;
      const d = w.mode === 'loop' ? (((tExit - w.t) % 1) + 1) % 1 : 1.5;
      if (d < best) { best = d; pick = w; }
    }
    if (pick) pick.exit = true;
    return !!pick;
  }
  function removePerson() {
    if (pendingEntries > 0) pendingEntries--;
    else if (!flagExit()) pendingRemovals++; // everyone busy → leave when free
    return totalPeople();
  }

  // browsing spots sit within arm's reach of the two wall shelves, clear of
  // the robot lanes at z=-11.5 and x=11.2 (people face the shelf products)
  // every slot stands exactly on a door seam of its shelf (01 back wall:
  // x = unit −3 ± {1.6, 4.8}; 03 right wall: z = unit 1 ± {1.6, 4.8}) so the
  // glass parts right in front of the shopper — see buildShelfLockRig
  const PICK_SLOTS = [
    [-1.4, -12.35, Math.PI], [14.55, -0.6, -Math.PI / 2],
    [-4.6, -12.35, Math.PI], [14.55, -3.8, -Math.PI / 2],
    [1.8, -12.35, Math.PI], [14.55, 2.6, -Math.PI / 2],
    [-7.8, -12.35, Math.PI], [14.55, 5.8, -Math.PI / 2],
  ];
  // QR scan pedestals: a card-reader post per pick slot, offset half a step
  // along the shelf so the flying pick items never thread through it.
  // PLATE_POS doubles as the beam target for the phone scan.
  const qrTex = new DynamicTexture('qrTex', { width: 128, height: 128 }, scene, true);
  {
    const ctx = qrTex.getContext();
    ctx.fillStyle = '#eaf6ff';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#0b1a33';
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if ((x * 7 + y * 13 + ((x * y) % 5)) % 3 === 0) ctx.fillRect(x * 8, y * 8, 8, 8);
      }
    }
    for (const [fx, fy] of [[4, 4], [92, 4], [4, 92]]) { // finder squares
      ctx.fillStyle = '#0b1a33'; ctx.fillRect(fx, fy, 32, 32);
      ctx.fillStyle = '#eaf6ff'; ctx.fillRect(fx + 6, fy + 6, 20, 20);
      ctx.fillStyle = '#0b1a33'; ctx.fillRect(fx + 11, fy + 11, 10, 10);
    }
    qrTex.update();
  }
  const qrMat = new StandardMaterial('qrPlate', scene);
  qrMat.disableLighting = true;
  qrMat.emissiveTexture = qrTex;
  qrMat.specularColor = Color3.Black();
  const PLATE_POS = PICK_SLOTS.map(([bx, bz]) => (bz < -10
    ? new Vector3(bx + 0.85, 1.42, -12.62)
    : new Vector3(14.2, 1.42, bz + 0.85)));
  PLATE_POS.forEach((pp, i) => {
    const back = PICK_SLOTS[i][1] < -10; // faces +z (back wall) or +x (right wall)
    box(0.07, 1.2, 0.07, mat.metal, pp.x, 0, pp.z).parent = world;
    const plate = back
      ? box(0.36, 0.36, 0.045, qrMat, pp.x, 1.24, pp.z)
      : box(0.045, 0.36, 0.36, qrMat, pp.x, 1.24, pp.z);
    plate.parent = world;
  });

  // a fresh stand point every time a slot is taken: slide along the shelf,
  // lean in or out a touch, and face it slightly off-square — nobody stands
  // on the exact same mark twice
  function jitterSlot(i) {
    const [bx, bz, bry] = PICK_SLOTS[i];
    // parallel to the shelf — tight enough that hands stay inside the
    // shopper's own ~1.5m seam gap (±jitter ±pickLat must be < ~0.75)
    const along = (Math.random() * 2 - 1) * 0.25;
    const depth = (Math.random() * 2 - 1) * 0.08;  // still within picking reach
    return {
      x: bx + Math.cos(bry) * along + Math.sin(bry) * depth,
      z: bz - Math.sin(bry) * along + Math.cos(bry) * depth,
      ry: bry + (Math.random() * 2 - 1) * 0.16,
    };
  }
  const freePickSlots = () => PICK_SLOTS.map((_, i) => i)
    .filter((i) => !shoppers.some((p) => p.slot === i));

  // slot → its door seam (nearest anchor on the shelf the slot faces); 1:1 by
  // construction, so slot reservation doubles as seam exclusivity
  const SLOT_SEAM = PICK_SLOTS.map(([bx, bz]) => {
    const lk = bz < -10 ? shelfLocks[0] : shelfLocks[2];
    let best = null, bd = Infinity;
    for (const sm of lk.seams) {
      const d = (sm.anchor.x - bx) ** 2 + (sm.anchor.z - bz) ** 2;
      if (d < bd) { bd = d; best = sm; }
    }
    return best;
  });

  // ---------- shelf visit: turn off the loop, browse, walk back ----------
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

  // shared session setup: reserve the slot, size the basket, tint the item,
  // aim the facing/sideways vectors the pick cycle animates along
  function beginSession(p, slot, ry) {
    p.slot = slot;
    p.picksLeft = 1 + Math.floor(Math.random() * 3); // 1–3 items this visit
    p.itemMat.albedoColor = C3(productColors[(slot * 3 + 1) % productColors.length]);
    p.f.set(Math.sin(ry), 0, Math.cos(ry));
    p.s.set(Math.cos(ry), 0, -Math.sin(ry));
    p.item.rotation.y = ry;
    const back = PICK_SLOTS[slot][1] < -10;
    p.reach = back ? 0.95 : 1.3; // right-wall slots stand farther back
    if (p.person) p.person.nearShelf = back ? 1 : 3; // slots face wall shelf 01 (back) or 03 (right)
    p.started = false;
    p.idling = false;
    p.pickT = 0;
  }

  // junction dice landed: reserve the slot and turn off the loop
  function startBrowse(p, slot) {
    const g = jitterSlot(slot);
    beginSession(p, slot, g.ry);
    p.mode = 'toshelf';
    p.cur = p.cur ?? p.speed;
    p.mv = {
      wps: [...SLOT_ROUTES[slot].wps, new Vector3(g.x, 0, g.z)],
      wi: 0, targetRy: g.ry, settleT: -1, // -1: still walking the leg
    };
  }

  // session over — walk the spur back and merge onto the loop. The slot stays
  // reserved until the merge so nobody dives into the spot they're leaving.
  function leaveSlot(p) {
    const u = p.h.metadata;
    releaseShelfAccess(p); // walking away — the door may close behind them
    if (u.groups.Idle) u.groups.Idle.stop();
    if (u.groups.PickUp) u.groups.PickUp.stop();
    u.movingState = undefined; // let applyGait start the Walk clip cleanly
    p.item.setEnabled(false);
    const route = SLOT_ROUTES[p.slot];
    p.mode = 'fromshelf';
    p.cur = 0;
    p.mv = {
      wps: [...[...route.wps].reverse(), walkPath.pointAt(route.t)], // merge exactly on the loop
      wi: 0, mergeT: route.t,
    };
  }

  // straight waypoint legs between the loop and a slot ('toshelf'/'fromshelf'),
  // verified clear of fixtures. Arrival settles into facing the shelf; the
  // merge back waits short of the junction while the loop is congested there.
  function shelfLegMove(p, dt) {
    const m = p.mv;
    if (p.mode === 'toshelf' && m.settleT >= 0) { // arrived: turn to the shelf
      p.cur += (0 - p.cur) * Math.min(1, dt * 6);
      m.settleT += dt;
      p.h.rotation.y = shortestLerp(p.h.rotation.y, m.targetRy, Math.min(1, dt * 8));
      applyGait(p);
      if (m.settleT > 0.45) {
        p.h.rotation.y = m.targetRy;
        p.mode = 'browse';
        p.mv = null; // pickCycle takes over: scan in, then pick
      }
      return;
    }
    const tgt = m.wps[m.wi];
    const dx = tgt.x - p.h.position.x, dz = tgt.z - p.h.position.z;
    const dist = Math.hypot(dx, dz);
    let target = p.speed;
    if (robotAhead(p.h)) target = 0;
    if (p.mode === 'fromshelf' && m.wi === m.wps.length - 1 && dist < 1.6) {
      const jp = m.wps[m.wps.length - 1];
      const busy = shoppers.some((q) => q !== p && q.mode === 'loop' &&
        Math.hypot(q.h.position.x - jp.x, q.h.position.z - jp.z) < 1.3);
      if (busy) target = 0;
    }
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
      if (m.wi >= m.wps.length) {
        if (p.mode === 'toshelf') m.settleT = 0;
        else { // merged — back on the loop; the dice rests through a cooldown
          p.mode = 'loop';
          p.t = m.mergeT;
          p.slot = -1;
          p.mv = null;
          p.cooldown = elapsed + 12 + Math.random() * 14;
        }
      }
    }
    applyGait(p);
  }

  // starting crowd spawns after the first ready frame (see executeWhenReady):
  // their ~2MB character files would otherwise sit on the boot overlay's
  // critical path — the store reveals first, people stream in right after

  const PICK_PERIOD = 9;
  const PICK_CLIP = 1.79; // PickUp is 1.25s, played at 0.7 speed

  // ---------- phone-scan unlock flow ----------
  // a shopper arriving at a slot scans in before anything else: the PickUp
  // clip doubles as the "hold the phone up" pose, a beam links the phone to
  // the QR pedestal, then access is granted — the glass parts only at this
  // shopper's own seam and glides shut again when they walk off (see
  // releaseShelfAccess). All fx run world-space so nothing fights the rig.
  // gesture timeline: pull the phone out of the hip pocket, hold it to the
  // reader while the beam runs, then pocket it again — access lands mid-beam
  // so the door is already gliding open while the phone goes away
  const SCAN_RAISE = 0.5, SCAN_BEAM = 1.1, SCAN_LOWER = 0.5;
  const SCAN_SECS = SCAN_RAISE + SCAN_BEAM + SCAN_LOWER;
  const SCAN_UNLOCK_AT = SCAN_RAISE + SCAN_BEAM * 0.5;
  const _beamTo = new Vector3();
  const _hipPt = new Vector3(), _fistPt = new Vector3();
  function shelfLockOf(p) { return shelfLocks[(p.person?.nearShelf ?? 1) - 1]; }
  // hip-pocket anchor, tracked per frame so the idle bob doesn't detach it
  function hipAnchor(p, out) {
    out.copyFrom(p.s).scaleInPlace(0.24).addInPlace(p.h.position);
    out.y = 0.82;
    return out;
  }

  function startShelfScan(p) {
    const u = p.h.metadata;
    p.shelfScan = { t: 0, done: false };
    p.idling = false;
    if (u.groups.Idle) u.groups.Idle.stop();
    const g = u.groups.PickUp; // arm reach ≈ raising the phone to the reader
    if (g) g.start(false, 0.6, g.from, g.to); // 1.25s clip stretched ≈ the 2.1s gesture
  }

  function updateShelfScan(p, dt) {
    const s = p.shelfScan;
    s.t += dt;
    const u = p.h.metadata;
    const lk = shelfLockOf(p);
    const plate = PLATE_POS[p.slot];
    if (u.fist) {
      p.phone.setEnabled(true);
      p.phone.rotation.y = p.h.rotation.y;
      hipAnchor(p, _hipPt);
      _fistPt.copyFrom(u.fist.getAbsolutePosition());
      if (s.t < SCAN_RAISE) { // out of the pocket, up to the reader
        const k = easeInOutCubic(s.t / SCAN_RAISE);
        Vector3.LerpToRef(_hipPt, _fistPt, k, p.phone.position);
        p.phone.rotation.x = 0.7 * (1 - k); // screen tips up as it rises
      } else if (s.t < SCAN_RAISE + SCAN_BEAM) { // held to the reader
        p.phone.position.copyFrom(_fistPt);
        p.phone.rotation.x = 0;
      } else { // back into the pocket
        const k = easeInOutCubic((s.t - SCAN_RAISE - SCAN_BEAM) / SCAN_LOWER);
        Vector3.LerpToRef(_fistPt, _hipPt, k, p.phone.position);
        p.phone.rotation.x = 0.7 * k;
      }
    }
    const beamOn = s.t >= SCAN_RAISE && s.t < SCAN_RAISE + SCAN_BEAM && plate && u.fist;
    p.beam.setEnabled(!!beamOn);
    if (beamOn) {
      lk.scanStamp = elapsed; // LED shows the cyan "scanning" pulse this frame
      _beamTo.copyFrom(plate);
      const d = Vector3.Distance(p.phone.position, _beamTo);
      Vector3.LerpToRef(p.phone.position, _beamTo, 0.5, p.beam.position);
      p.beam.scaling.set(1, 1, Math.max(0.1, d));
      p.beam.lookAt(_beamTo);
      phoneBeamMat.alpha = 0.4 + 0.3 * Math.abs(Math.sin(elapsed * 16));
    }
    if (!s.done && s.t >= SCAN_UNLOCK_AT) { // scan reads → ring pops, access lands
      s.done = true;
      p.ringT = 0;
      p.ring.position.set(p.h.position.x, 0.07, p.h.position.z);
      p.ring.setEnabled(true);
      takeAccess(p);
    }
    if (s.t < SCAN_SECS) return;
    // phone pocketed → settle into Idle and let the pick cycle take over
    p.shelfScan = null;
    p.phone.setEnabled(false);
    if (u.groups.PickUp) u.groups.PickUp.stop();
    p.idling = true;
    const gi = u.groups.Idle;
    if (gi) gi.start(true, 1.0, gi.from, gi.to);
    p.pickT = PICK_PERIOD - 0.8 - Math.random() * 1.4; // first pick lands shortly after the door opens
  }

  // take the seam: every scan opens the scanner's own door pair. Shelf-level
  // events stay coarse for the dashboard — 'unlocked' only when the shelf goes
  // from fully shut to its first open seam, 'scan_ok' for every scan after.
  function takeAccess(p) {
    const lk = shelfLockOf(p);
    const sm = SLOT_SEAM[p.slot];
    p.access = lk.id;
    p.accessSeam = sm;
    const wasOpen = lk.masterOpen || lk.heldSeams > 0;
    if (sm && ++sm.holders === 1) lk.heldSeams++;
    lk.flash = 1.3;
    lk.tagT = 0; // "UNLOCKED" hologram pops over every successful scanner
    lk.tag.position.set(p.h.position.x, 3.1, p.h.position.z);
    lk.tag.isVisible = true;
    lk.tagMat.alpha = 1;
    if (!wasOpen && !lk.offline) {
      lk.locked = false;
      emitShelfEvent(lk.id, 'unlocked');
    } else {
      emitShelfEvent(lk.id, 'scan_ok');
    }
  }

  function releaseShelfAccess(p) {
    if (p.shelfScan) { // pulled away mid-scan — drop the fx, no access was held
      p.shelfScan = null;
      p.phone?.setEnabled(false);
      p.beam?.setEnabled(false);
    }
    if (p.access) {
      const lk = shelfLocks[p.access - 1];
      const sm = p.accessSeam;
      // their door glides shut behind them (unless the dashboard master holds it)
      if (sm && sm.holders > 0 && --sm.holders === 0) lk.heldSeams = Math.max(0, lk.heldSeams - 1);
      if (lk.heldSeams === 0 && !lk.masterOpen && !lk.locked) {
        lk.locked = true;
        emitShelfEvent(lk.id, 'relocked');
      }
      p.access = null;
      p.accessSeam = null;
    }
  }

  const _shelfPt = new Vector3(), _handPt = new Vector3();
  function pickCycle(p, dt) {
    const u = p.h.metadata;
    if (!u.ready) return;
    if (!p.started) { // first frame at the shelf — everyone scans, no freebies
      p.started = true;
      startShelfScan(p);
    }
    if (p.shelfScan) { updateShelfScan(p, dt); return; }
    // access granted but their own door still gliding open → hold Idle, no picking
    if (Math.max(shelfLockOf(p).masterAmt, p.accessSeam?.openAmt ?? 0) < 0.7) return;
    p.pickT += dt;
    const t = p.pickT % PICK_PERIOD;
    if (t < dt) { // new cycle → new spot on the shelf, play the pick clip
      p.picksLeft--;
      p.pickLat = (Math.random() - 0.5) * 0.8; // stay inside the shopper's own seam gap
      if (p.person) p.person.picks++; // feeds "Items picked" on the detail card
      const g = u.groups.PickUp;
      if (g) { if (u.groups.Idle) u.groups.Idle.stop(); p.idling = false; g.start(false, 0.7, g.from, g.to); }
    }
    if (!p.idling && t >= PICK_CLIP) { // pick clip done → back to Idle
      p.idling = true;
      const gi = u.groups.Idle;
      if (gi) gi.start(true, 1.0, gi.from, gi.to);
    }
    // basket done and the last item is back on the shelf → walk off
    if (p.picksLeft <= 0 && t >= 5.2) { leaveSlot(p); return; }

    // product spawn point on the bottom shelf in front of the shopper
    _shelfPt.copyFrom(p.f).scaleInPlace(p.reach).addInPlace(p.h.position)
      .addInPlace(_handPt.copyFrom(p.s).scaleInPlace(p.pickLat));
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

  const robot = { g: makeRobot(), speed: 3.4, advancing: true };
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
  const nav = { from: 0, to: 1, u: 0, mode: 'travel', next: 1, yaw: headingYaw(0, 1), startYaw: 0, targetYaw: 0, turnT: 0, lastFastRev: -99 };
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
  // and brake for the robot when it is driving across in front
  const FOLLOW_GAP = 2.0;   // start matching the leader's speed (path units)
  const MIN_GAP = 1.0;      // full stop this close to the leader
  const ROBOT_BRAKE = 2.4;  // person stops when the robot is this close ahead

  // shared brake: only an actively driving robot holds people up — one that
  // is itself yielding (waiting or turning) is passable. People then never
  // wait on a robot that is waiting on people, so no wait cycle can form;
  // a crowd pinning the robot from both sides used to freeze the whole loop
  function robotAhead(h) {
    if (!robot.advancing) return false;
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

  // exit-queue rank: 0 owns the scanner next, n waits n slots behind the gate
  function gateRank(p) {
    let r = 0;
    for (const q of shoppers) {
      if (q !== p && q.mode === 'exitwalk' && q.wp === 0 && q.exitSeq < p.exitSeq) r++;
    }
    return r;
  }
  // entry-queue rank: mirror of gateRank; slots stretch back toward the door
  function entryRank(p) {
    let r = 0;
    for (const q of shoppers) {
      if (q !== p && q.mode === 'enter' && q.wp === 0 && q.enterSeq < p.enterSeq) r++;
    }
    return r;
  }

  // spurs: straight walks between the loop junctions and the two doors.
  // enter waypoints: 0 = entry gate (queue single-file behind it, back out
  // the door), 1 = merge point → loop. exitwalk waypoints: 0 = scan gate
  // (queue single-file behind it), 1 = exit door, 2 = outside → despawn.
  const _spurTgt = new Vector3();
  function spurMove(p, dt) {
    if (p.mode === 'enter') {
      if (p.wp === 0) _spurTgt.set(DOOR.x, 0, ENTRY_GATE.z + ENTRY_GATE.spacing * entryRank(p));
      else _spurTgt.copyFrom(mergePoint);
    }
    else if (p.wp === 0) _spurTgt.set(EXIT.x, 0, GATE.z - GATE.spacing * gateRank(p));
    else _spurTgt.set(EXIT.x, 0, p.wp === 1 ? EXIT.zDoor : EXIT.zOut + 0.5);
    const dx = _spurTgt.x - p.h.position.x, dz = _spurTgt.z - p.h.position.z;
    const dist = Math.hypot(dx, dz);
    let target = p.speed;
    // arriving: wait by the junction if the loop is congested right there
    if (p.mode === 'enter' && p.wp === 1 && dist < 1.6) {
      const busy = shoppers.some((q) => q !== p && q.mode === 'loop' &&
        Math.hypot(q.h.position.x - mergePoint.x, q.h.position.z - mergePoint.z) < 1.3);
      if (busy) target = 0;
    }
    if (p.scan !== undefined) target = 0; // held between the gate posts mid-scan
    p.cur = (p.cur ?? p.speed) + (target - (p.cur ?? p.speed)) * Math.min(1, dt * 6);
    const step = p.cur * walkPath.length * dt;
    if (dist > 0.001) {
      const k = Math.min(1, step / dist);
      p.h.position.x += dx * k;
      p.h.position.z += dz * k;
      if (p.cur > p.speed * 0.2) p.h.rotation.y = Math.atan2(dx, dz);
    }
    if (dist <= Math.max(0.12, step)) {
      if (p.mode === 'enter') {
        if (p.wp === 0) {
          // head of the entry queue claims the scanner; the sweep runs in the
          // frame loop and advances wp to 1 (→ merge point) once verified
          if (!entryGate.user && p.scan === undefined && entryRank(p) === 0) {
            entryGate.user = p; p.scan = 0; p.verifying = true;
            p.verifyFail = Math.random() < 0.15; // first sweep rejected → rescan
          }
        } else { p.mode = 'loop'; p.t = tMerge; }
      }
      else if (p.wp === 0) {
        // head of the queue claims the scanner as soon as it frees up; the
        // scan itself runs in the frame loop and advances wp when paid
        if (!gate.user && p.scan === undefined && gateRank(p) === 0) {
          gate.user = p; p.scan = 0; p.paying = true;
        }
      } else if (p.wp === 1) p.wp = 2;
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

    const prevT = p.t;
    p.t = (p.t + p.cur * dt) % 1;

    // junction dice: crossing a free slot's loop junction may pull the shopper
    // in for a browse session. Odds shrink as the shelves fill (soft cap: at
    // most half the crowd browsing) and rest through a post-session cooldown.
    // The four right-wall slots share one junction — one roll covers them all.
    if (!p.exit && p.slot < 0 && elapsed > p.cooldown) {
      const stepFrac = (((p.t - prevT) % 1) + 1) % 1;
      let cand = null, nc = 0;
      for (const i of freePickSlots()) {
        const d = (((SLOT_ROUTES[i].t - prevT) % 1) + 1) % 1;
        if (d > stepFrac) continue; // junction not crossed this frame
        if (Math.random() * ++nc < 1) cand = i; // reservoir pick among crossed slots
      }
      if (cand !== null) {
        const cap = Math.max(1, Math.floor(shoppers.length / 2));
        const busy = browsingCount();
        if (busy < cap && Math.random() < 0.55 * (1 - busy / cap)) {
          startBrowse(p, cand);
          return; // shelfLegMove owns the gait from the next frame
        }
        p.cooldown = elapsed + 2; // passed — don't re-roll while astride the junction
      }
    }

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

    // flagged to leave → turn onto the exit spur at the junction
    if (p.exit) {
      const d = (((tExit - p.t) % 1) + 1) % 1 * walkPath.length;
      if (d < 0.6) { p.mode = 'exitwalk'; p.wp = 0; p.exitSeq = ++exitSeq; }
    }
    applyGait(p);
  }

  // "ready" = first real frame on screen (shaders/textures compiled), not just
  // factory return — the dashboard keeps its boot overlay up until this fires.
  // The starting crowd (5, all on the loop) spawns right after the reveal so
  // its async character loads never delay the overlay. Nobody spawns
  // pre-scanned at a shelf: every open door traces back to a visible scan.
  scene.executeWhenReady(() => {
    scene.onAfterRenderObservable.addOnce(() => {
      onReady?.();
      for (let i = 0; i < 5; i++) spawnOnLoop();
    });
  });

  let nextSwap = 18; // ambient door traffic: one leaves, another arrives
  // per-frame update. forcedDt lets the debug handle fast-forward the sim
  // (controller._step) in a throttled background tab without real frames
  const frame = (forcedDt) => {
    const dt = forcedDt ?? Math.min(engine.getDeltaTime() / 1000, 0.05);
    elapsed += dt;
    const time = elapsed;

    // door queue: spawn the next queued arrival once the pad is clear
    if (pendingEntries > 0) {
      const padBusy = shoppers.some((w) =>
        Math.hypot(w.h.position.x - DOOR.x, w.h.position.z - DOOR.zOut) < 1.6);
      if (!padBusy) {
        pendingEntries--;
        const p = makeShopper('enter');
        p.h.position.set(DOOR.x, 0, DOOR.zOut);
        p.h.rotation.y = Math.PI; // facing into the store
        p.cur = 0;
      }
    }
    // every so often a shopper heads home and a new one shows up (count stays)
    if (time > nextSwap) {
      nextSwap = time + 14 + Math.random() * 10;
      if (shoppers.some((w) => w.mode === 'loop' && !w.exit) && flagExit()) pendingEntries++;
    }
    // − presses that found nobody flaggable (all browsing, or the exit queue
    // full) wait here until a walking shopper frees up
    if (pendingRemovals > 0 && flagExit()) pendingRemovals--;

    loopTraffic = shoppers.filter((w) => w.mode === 'loop');
    shoppers.forEach((p) => {
      if (p.mode === 'browse') pickCycle(p, dt); // idle sway comes from the GLB Idle clip
      else if (p.mode === 'toshelf' || p.mode === 'fromshelf') shelfLegMove(p, dt);
      else walk(p, dt);
    });
    for (let i = shoppers.length - 1; i >= 0; i--) {
      if (shoppers[i].done) { disposeShopper(shoppers[i]); shoppers.splice(i, 1); }
    }

    // auto sliding doors: glide open for anyone near the threshold
    {
      const near = shoppers.some((w) =>
        Math.hypot(w.h.position.x - DOOR.x, w.h.position.z - DOOR.zDoor) < 2.6);
      doorOpenAmt += ((near ? 1 : 0) - doorOpenAmt) * Math.min(1, dt * 5);
      for (const pnl of doorPanels) {
        pnl.mesh.position.x = pnl.closedX + pnl.side * doorOpenAmt * 1.18;
      }
    }
    // exit door: only paid shoppers (wp >= 1) open it — the gate sits inside
    // the proximity radius, so gate traffic alone must not trigger it
    {
      const near = shoppers.some((w) => w.mode === 'exitwalk' && w.wp >= 1 &&
        Math.hypot(w.h.position.x - EXIT.x, w.h.position.z - EXIT.zDoor) < 2.6);
      exitDoorOpenAmt += ((near ? 1 : 0) - exitDoorOpenAmt) * Math.min(1, dt * 5);
      for (const pnl of exitDoorPanels) {
        pnl.mesh.position.x = pnl.closedX + pnl.side * exitDoorOpenAmt * 1.18;
      }
    }

    // scan-to-pay gate: sweep the beam, flash green on success, release
    {
      const u = gate.user;
      if (u && u.scan !== undefined) {
        if (exitReticle.target !== u) exitReticle.start(u); // face lock-on
        u.scan += dt / GATE.secs;
        gateBeam.isVisible = true;
        // two full sweeps through the body over the scan
        gateBeam.position.y = 0.35 + 1.15 * (0.5 - 0.5 * Math.cos(Math.min(u.scan, 1) * Math.PI * 4));
        const pulse = 1.0 + 0.4 * Math.sin(elapsed * 14);
        for (const m of gateLampMats) m.emissiveColor.copyFrom(ACCENT).scaleInPlace(pulse);
        if (u.scan >= 1) { // paid — green light, receipt pop, walk on out
          u.scan = undefined; u.paying = false; u.wp = 1;
          gate.flash = 1.4;
          showPaidTag();
          exitReticle.succeed();
        }
      } else {
        gateBeam.isVisible = false;
        if (gate.flash > 0) {
          gate.flash -= dt;
          for (const m of gateLampMats) m.emissiveColor.copyFrom(LAMP_GREEN);
        } else {
          for (const m of gateLampMats) m.emissiveColor.copyFrom(ACCENT);
        }
        // keep the gate owned until the payer clears it, so the next in
        // line doesn't walk into their back
        if (u && u.h.position.z > GATE.z + 0.9) gate.user = null;
      }
      if (paidTagT < 1.5) { // receipt pop: drift up, hold, fade
        paidTagT += dt;
        paidTag.position.y = 2.1 + paidTagT * 0.45;
        paidMat.alpha = paidTagT < 0.9 ? 1 : Math.max(0, 1 - (paidTagT - 0.9) / 0.6);
        if (paidTagT >= 1.5) paidTag.isVisible = false;
      }
    }

    // entry verification gate: sweep the beam; a failed first pass blinks the
    // lamps red (deny) and rescans, success flashes green and pops the ID tag
    {
      const u = entryGate.user;
      if (u && u.scan !== undefined && entryReticle.target !== u) entryReticle.start(u); // face lock-on
      if (u && u.scan !== undefined && entryGate.deny <= 0) {
        u.scan += dt / ENTRY_GATE.secs;
        entryBeam.isVisible = true;
        // two full sweeps through the body over the scan
        entryBeam.position.y = 0.35 + 1.15 * (0.5 - 0.5 * Math.cos(Math.min(u.scan, 1) * Math.PI * 4));
        const pulse = 1.0 + 0.4 * Math.sin(elapsed * 14);
        for (const m of entryLampMats) m.emissiveColor.copyFrom(ACCENT).scaleInPlace(pulse);
        if (u.scan >= 1) {
          if (u.verifyFail) { // rejected — red blink, then a second sweep
            u.verifyFail = false;
            u.scan = 0;
            entryGate.deny = 0.9;
          } else { // verified — green light, ID tag pop, walk on in
            u.scan = undefined; u.verifying = false; u.wp = 1;
            entryGate.flash = 1.4;
            showIdTag();
            entryReticle.succeed();
          }
        }
      } else {
        entryBeam.isVisible = false;
        if (entryGate.deny > 0) {
          entryGate.deny -= dt;
          const blink = Math.sin(elapsed * 16) > 0 ? 1 : 0.25;
          for (const m of entryLampMats) m.emissiveColor.copyFrom(LAMP_RED).scaleInPlace(blink);
        } else if (entryGate.flash > 0) {
          entryGate.flash -= dt;
          for (const m of entryLampMats) m.emissiveColor.copyFrom(LAMP_GREEN);
        } else {
          for (const m of entryLampMats) m.emissiveColor.copyFrom(ACCENT);
        }
        // keep the gate owned until the newcomer clears it store-side, so the
        // next in line doesn't walk into their back
        if (u && u.h.position.z < ENTRY_GATE.z - 0.9) entryGate.user = null;
      }
      if (idTagT < 1.5) { // ID tag pop: drift up, hold, fade
        idTagT += dt;
        idTag.position.y = 2.1 + idTagT * 0.45;
        idMat.alpha = idTagT < 0.9 ? 1 : Math.max(0, 1 - (idTagT - 0.9) / 0.6);
        if (idTagT >= 1.5) idTag.isVisible = false;
      }
    }

    // face reticles track their gate owners (red blink rides the entry deny)
    entryReticle.step(dt, entryGate.deny > 0);
    exitReticle.step(dt, false);

    // robot graph traversal
    {
      const u = robot.g.metadata;
      if (nav.mode === 'travel') {
        // yield to shoppers directly ahead; after 2.5s give up and take the
        // edge back the other way. A waiting robot reads as not advancing,
        // so robotAhead lets held-up shoppers stream past it meanwhile
        let blocked = false;
        // browsers stand off the robot lanes; everyone else can be in the way
        for (const w of shoppers) {
          if (w.mode === 'browse') continue;
          const dx = w.h.position.x - robot.g.position.x;
          const dz = w.h.position.z - robot.g.position.z;
          const d = Math.hypot(dx, dz);
          if (d < 2.0 && (dx * Math.sin(nav.yaw) + dz * Math.cos(nav.yaw)) / (d || 1) > 0.2) {
            blocked = true;
            break;
          }
        }
        robot.advancing = !blocked;
        if (blocked) {
          nav.waitT = (nav.waitT || 0) + dt;
          // never idle astride the shoppers' walk line — back out at once.
          // Rate-limited so a robot pinned from both sides degrades to the
          // plain (passable) wait instead of a turn-in-place livelock
          const fastOut = nav.waitT <= 2.5 && time - nav.lastFastRev > 4 &&
            nearWalkPath(robot.g.position.x, robot.g.position.z, 1.2);
          if (fastOut) nav.lastFastRev = time;
          if (nav.waitT > 2.5 || fastOut) {
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
        robot.advancing = false; // turning in place — passable
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

    // shelf locks: door glide, status LEDs, unlock hologram, scan rings
    for (const lk of shelfLocks) {
      // two open drivers: the dashboard master (all seams) and each held seam
      const mTgt = !lk.offline && lk.masterOpen ? 1 : 0;
      lk.masterAmt += (mTgt - lk.masterAmt) * Math.min(1, dt * 3.2);
      for (const sm of lk.seams) {
        sm.openAmt += ((sm.holders > 0 ? 1 : 0) - sm.openAmt) * Math.min(1, dt * 3.2);
      }
      for (const pnl of lk.panels) {
        // panes slide toward their segment center — openings at the seams
        const amt = Math.max(lk.masterAmt, pnl.seam ? pnl.seam.openAmt : 0);
        pnl.mesh.position.x = pnl.closedX - pnl.dir * pnl.slide * amt;
      }
      let led;
      if (lk.offline) led = _ledCol.copyFrom(LOCK_AMBER).scaleInPlace(0.5 + 0.5 * Math.abs(Math.sin(time * 1.7)));
      else if (lk.flash > 0) { lk.flash -= dt; led = _ledCol.copyFrom(LOCK_GREEN).scaleInPlace(1.25 + 0.45 * Math.sin(time * 12)); }
      else if (time - lk.scanStamp < 0.12) led = _ledCol.copyFrom(ACCENT).scaleInPlace(1 + 0.4 * Math.sin(time * 14));
      else if (lk.locked) led = _ledCol.copyFrom(LOCK_RED).scaleInPlace(0.9);
      else led = _ledCol.copyFrom(LOCK_GREEN);
      for (const m of lk.ledMats) m.emissiveColor.copyFrom(led);
      if (lk.tagT < 1.6) { // "UNLOCKED" pop: drift up, hold, fade
        lk.tagT += dt;
        lk.tag.position.y = 3.1 + lk.tagT * 0.5;
        lk.tagMat.alpha = lk.tagT < 1.0 ? 1 : Math.max(0, 1 - (lk.tagT - 1.0) / 0.6);
        if (lk.tagT >= 1.6) lk.tag.isVisible = false;
      }
    }
    for (const pk of shoppers) {
      if (pk.ringT < 0.9) { // access ring bursting at the scanner's feet
        pk.ringT += dt;
        const k = Math.min(1, pk.ringT / 0.9);
        pk.ring.scaling.setAll(0.5 + k * 2.3);
        pk.ringMat.alpha = 0.8 * (1 - k);
        if (k >= 1) pk.ring.setEnabled(false);
      }
    }

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

    // crowd stepper in the dashboard; counts() feeds the UI (walking/browsing
    // are read-only outcomes of the shoppers' own decisions, not targets)
    people: {
      add: addPerson, remove: removePerson,
      maxTotal: MAX_PEOPLE,
      // total is the stepper's logical head-count (includes queued entries and
      // pending removals); walking/browsing are who is physically doing what
      // right now, so they can transiently disagree with total
      counts: () => {
        const browsing = shoppers.filter((s) => s.mode === 'browse').length;
        return { total: totalPeople(), browsing, walking: shoppers.length - browsing };
      },
      // person selection: React pushes the id in, polls live card data out,
      // and hands over the card element for the per-frame follow transform.
      select: selectPerson,
      get: getPersonData,
      list: () => [...persons.keys()].map(getPersonData),
      bindCard,
    },

    // shelf locks: the scene owns the state, React mirrors it. set() is the
    // manual-override hook the future backend will drive — events still flow
    // out through onShelfEvent so the dashboard stays in sync either way.
    locks: {
      states: () => shelfLocks.map((lk) => ({
        id: lk.id,
        state: lk.offline ? 'offline' : lk.locked ? 'locked' : 'open',
      })),
      // master override: opens/closes every seam of the shelf at once. On
      // re-lock, seams still held by a shopper stay open until they leave —
      // releaseShelfAccess emits the final 'relocked' then.
      set: (id, locked) => {
        const lk = shelfLocks[id - 1];
        if (!lk || lk.offline) return false;
        lk.masterOpen = !locked;
        const open = lk.masterOpen || lk.heldSeams > 0;
        if (lk.locked === open) { // shelf-level state actually flips
          lk.locked = !open;
          if (open) lk.flash = 1.3;
          emitShelfEvent(lk.id, open ? 'unlocked' : 'relocked');
        }
        return true;
      },
    },
  };
  if (typeof window !== 'undefined') window.__storeBabylon = controller; // debug handle
  return controller;
}
