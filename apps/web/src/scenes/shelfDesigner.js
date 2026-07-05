import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const ACCENT = 0x35c3ff;

// Product catalogue shared with the React palette UI.
export const PRODUCTS = [
  { id: 'box',    name: 'Box',    color: '#e2574c', w: 1.1, h: 1.1, d: 1.1, shape: 'box' },
  { id: 'crate',  name: 'Crate',  color: '#5b8def', w: 1.5, h: 0.95, d: 1.2, shape: 'box' },
  { id: 'bottle', name: 'Bottle', color: '#4caf72', w: 0.7, h: 1.7, d: 0.7, shape: 'cyl' },
  { id: 'can',    name: 'Can',    color: '#efb23a', w: 0.7, h: 1.0, d: 0.7, shape: 'cyl' },
  { id: 'jar',    name: 'Jar',    color: '#37c2c9', w: 0.85, h: 1.2, d: 0.85, shape: 'cyl' },
  { id: 'bag',    name: 'Bag',    color: '#b07cdb', w: 1.0, h: 1.3, d: 0.8, shape: 'box' },
];

// ---- shelf geometry / configuration limits ----
const SHELF_LEN = 12;     // width of one shelf unit
const DEFAULT_DEPTH = 2;  // depth of a freshly added shelf (depth is now per-shelf, editable)
const FRONT_MARGIN = 0.8; // how far a faced-forward product sits from the front edge
const DECK0 = 1.5;        // y of the lowest deck's top surface
const DECK_GAP = 1.8;     // vertical spacing between decks
const SHELF_GAP = 3;      // space between adjacent shelf units
const FILL_MARGIN = 0.9;  // products fill 90% of their slot box on every axis (small breathing room)
const SLOT_FILL_H = DECK_GAP * FILL_MARGIN; // vertical ceiling a product may grow into (~1.62)
const FLOOR = 64;                           // floor / grid extent (matches PlaneGeometry)
const X_LIMIT = FLOOR / 2 - SHELF_LEN / 2;  // clamp so a shelf stays fully on the floor
const MIN_X_GAP = SHELF_LEN + SHELF_GAP;    // min centre-to-centre X distance between shelves

export const LIMITS = {
  minCols: 2, maxCols: 10,
  minDecks: 1, maxDecks: 5,
  minDepth: 1.5, maxDepth: 4, depthStep: 0.5,
  maxShelves: 5,
  defaultCols: 6, defaultDecks: 3, defaultDepth: DEFAULT_DEPTH,
};

const deckTop = (i) => DECK0 + i * DECK_GAP;
const shelfHeight = (decks) => deckTop(decks.length - 1) + 1.7;
// a shelf stays fully on the floor when its centre Z is within this (depends on depth)
const zLimit = (depth) => FLOOR / 2 - depth / 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Interactive drag-and-drop shelf designer with configurable, multiple shelves.
 * Returns a controller:
 *   { dispose, hoverAt, clearHover, dropAt, clear, getState,
 *     addShelf, removeShelf, addDeck, removeDeck, setDeckCols }
 * `onChange(state)` is called whenever placements or the shelf layout change.
 */
export function createShelfDesigner(container, { onChange, onSelect } = {}) {
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
  scene.fog = new THREE.Fog(0x060b18, 38, 95);

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 500);
  camera.position.set(7.5, 9, 22);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 9;
  controls.maxDistance = 60;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.target.set(0, 3, 0);

  // ---------- lighting ----------
  scene.add(new THREE.AmbientLight(0x2a3f6b, 1.0));
  scene.add(new THREE.HemisphereLight(0x4a6bd0, 0x05070f, 0.5));
  const keyL = new THREE.DirectionalLight(0xbcd4ff, 1.2);
  keyL.position.set(10, 18, 14);
  keyL.castShadow = true;
  keyL.shadow.mapSize.set(2048, 2048);
  keyL.shadow.camera.near = 1; keyL.shadow.camera.far = 80;
  const sh = 30;
  keyL.shadow.camera.left = -sh; keyL.shadow.camera.right = sh;
  keyL.shadow.camera.top = sh; keyL.shadow.camera.bottom = -sh;
  keyL.shadow.bias = -0.0004;
  scene.add(keyL);
  const fillL = new THREE.DirectionalLight(0x2f6bff, 0.5);
  fillL.position.set(-12, 8, -6);
  scene.add(fillL);

  // ---------- materials (shared across all shelves) ----------
  const mat = {
    floor: new THREE.MeshStandardMaterial({ color: 0x0c1730, roughness: 1 }),
    shelf: new THREE.MeshStandardMaterial({ color: 0x3a557f, roughness: 0.7, metalness: 0.2 }),
    shelfDk: new THREE.MeshStandardMaterial({ color: 0x223a5e, roughness: 0.82, metalness: 0.28 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x44505f, roughness: 0.4, metalness: 0.65 }),
    divider: new THREE.MeshStandardMaterial({ color: 0x35507c, roughness: 0.5, metalness: 0.4 }),
    label: new THREE.MeshStandardMaterial({ color: 0x0c1730, emissive: ACCENT, emissiveIntensity: 0.5, roughness: 0.4 }),
    wall: new THREE.MeshStandardMaterial({ color: 0x101d36, roughness: 0.95, metalness: 0.05 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xe0a87e, roughness: 0.7 }),
    robot: new THREE.MeshStandardMaterial({ color: 0xc7d2e0, roughness: 0.4, metalness: 0.5 }),
    robotDk: new THREE.MeshStandardMaterial({ color: 0x3a4a6a, roughness: 0.5, metalness: 0.4 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x0a0d14, roughness: 0.9 }),
  };

  function box(w, h, d, material, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y + h / 2, z);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  const world = new THREE.Group();
  scene.add(world);

  // floor + grid
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR, FLOOR), mat.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  world.add(floor);
  const grid = new THREE.GridHelper(FLOOR, FLOOR / 2, 0x1d3a72, 0x14264a);
  grid.position.y = 0.01;
  grid.material.transparent = true; grid.material.opacity = 0.45;
  world.add(grid);

  // ---------- perimeter walls (frame the room) ----------
  (function walls() {
    const half = FLOOR / 2;
    const wallH = 5, t = 0.4;
    const rim = new THREE.MeshStandardMaterial({ color: 0x0c1730, emissive: ACCENT, emissiveIntensity: 0.6, roughness: 0.5 });
    const specs = [
      [FLOOR, half, 0, 0],          // back  (north, -z)
      [FLOOR, -half, 0, 0],         // front (south, +z)
      [FLOOR, 0, -half, Math.PI / 2], // left  (-x)
      [FLOOR, 0, half, Math.PI / 2],  // right (+x)
    ];
    for (const [len, z, x, ry] of specs) {
      const w = box(len, wallH, t, mat.wall, x, 0, z);
      w.rotation.y = ry;
      world.add(w);
      // glowing accent strip along the top edge
      const strip = box(len, 0.12, t + 0.02, rim, x, wallH, z);
      strip.rotation.y = ry;
      world.add(strip);
    }
  })();

  // ---------- walking people & robots (ambient circulation) ----------
  const agents = [];

  function makeHuman(shirt, pants) {
    const h = new THREE.Group();
    const shirtM = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.7 });
    const pantsM = new THREE.MeshStandardMaterial({ color: pants, roughness: 0.8 });
    const body = new THREE.Group();
    body.position.y = 1.6;
    h.add(body);
    body.add(box(0.7, 1.1, 0.42, shirtM, 0, 0.05, 0));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), mat.skin);
    head.position.set(0, 1.05, 0); head.castShadow = true;
    body.add(head);
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 16, 16, 0, Math.PI * 2, 0, Math.PI / 1.8),
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
    const parts = {
      body,
      armL: limb(0.18, 0.9, shirtM, -0.46, 0.5),
      armR: limb(0.18, 0.9, shirtM, 0.46, 0.5),
      legL: limb(0.22, 0.95, pantsM, -0.2, -0.55),
      legR: limb(0.22, 0.95, pantsM, 0.2, -0.55),
    };
    h.userData.parts = parts;
    return h;
  }

  function makeRobot(accent) {
    const r = new THREE.Group();
    const body = new THREE.Group();
    body.position.y = 0.55;
    r.add(body);
    // chassis + head
    body.add(box(1.0, 0.5, 1.2, mat.robotDk, 0, 0, 0));
    body.add(box(0.9, 1.0, 0.9, mat.robot, 0, 0.4, 0));
    const head = box(0.7, 0.5, 0.7, mat.robotDk, 0, 1.5, 0);
    body.add(head);
    // glowing eye visor
    const eye = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.16, 0.06),
      new THREE.MeshBasicMaterial({ color: accent })
    );
    eye.position.set(0, 1.72, 0.36);
    body.add(eye);
    // antenna with a glowing tip
    body.add(box(0.05, 0.5, 0.05, mat.metal, 0.2, 1.8, 0));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 12), new THREE.MeshBasicMaterial({ color: accent }));
    tip.position.set(0.2, 2.35, 0);
    body.add(tip);
    // wheels
    const wheels = [];
    for (const [wx, wz] of [[-0.55, 0.45], [0.55, 0.45], [-0.55, -0.45], [0.55, -0.45]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.18, 14), mat.tire);
      w.rotation.z = Math.PI / 2;
      w.position.set(wx, 0.3, wz);
      w.castShadow = true;
      r.add(w);
      wheels.push(w);
    }
    r.userData.parts = { body, wheels, eye };
    return r;
  }

  // looping walk path tucked just inside the walls (away from the central shelves)
  const RW = FLOOR / 2 - 5;
  const walkCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-RW, 0, -RW),
    new THREE.Vector3(RW, 0, -RW),
    new THREE.Vector3(RW, 0, RW),
    new THREE.Vector3(-RW, 0, RW),
  ], true, 'catmullrom', 0.08);

  function addAgent(obj, kind, t, speed) {
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    world.add(obj);
    agents.push({ obj, kind, t, speed });
  }
  addAgent(makeHuman(0x4f86d6, 0x2c3550), 'human', 0.0, 0.05);
  addAgent(makeHuman(0xd66a4f, 0x394050), 'human', 0.4, 0.042);
  addAgent(makeHuman(0x5cc28e, 0x2c3550), 'human', 0.72, 0.058);
  addAgent(makeRobot(0x35c3ff), 'robot', 0.22, 0.064);
  addAgent(makeRobot(0xffb74d), 'robot', 0.6, 0.048);

  // glowing ribbon tracing the walk loop
  const ribbon = new THREE.Mesh(
    new THREE.TubeGeometry(walkCurve, 160, 0.1, 8, true),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.4 })
  );
  ribbon.position.y = 0.06; ribbon.scale.y = 0.2;
  world.add(ribbon);

  // ---------- shelf state ----------
  // Each shelf: { id, x, decks: [{ cols }], frame: THREE.Group }
  // Slots are derived from the shelves into a flat `slots` array.
  const shelvesGroup = new THREE.Group();
  world.add(shelvesGroup);
  let shelves = [];
  let slots = [];
  let nextShelfId = 1;

  const getShelf = (id) => shelves.find((s) => s.id === id);

  // dispose only geometries of a frame group; materials are shared and kept
  function clearFrame(g) {
    while (g.children.length) {
      const c = g.children.pop();
      c.geometry?.dispose();
    }
  }

  // (re)build the structural meshes for one shelf, including column dividers
  function buildShelfFrame(shelf) {
    const f = shelf.frame;
    clearFrame(f);
    const H = shelfHeight(shelf.decks);
    const D = shelf.depth;
    f.add(box(SHELF_LEN, H, 0.2, mat.shelfDk, 0, 0, -D / 2));         // back panel
    f.add(box(SHELF_LEN, 0.4, D, mat.shelf, 0, 0, 0));               // base
    f.add(box(0.2, H, D, mat.metal, -SHELF_LEN / 2, 0, 0));          // left upright
    f.add(box(0.2, H, D, mat.metal, SHELF_LEN / 2, 0, 0));           // right upright
    shelf.decks.forEach((deck, i) => {
      const dt = deckTop(i);
      f.add(box(SHELF_LEN, 0.12, D, mat.shelf, 0, dt - 0.12, 0));    // deck plank
      // glowing electronic shelf-label strip on the front edge
      f.add(box(SHELF_LEN, 0.16, 0.04, mat.label, 0, dt - 0.02, D / 2 + 0.01));
      // column dividers visualise the custom slot widths
      const slotW = SHELF_LEN / deck.cols;
      for (let c = 1; c < deck.cols; c++) {
        const x = -SHELF_LEN / 2 + c * slotW;
        f.add(box(0.05, SLOT_FILL_H, D * 0.9, mat.divider, x, dt, 0)); // tall enough to flank full-size products
      }
    });
  }

  // position is per-shelf state now; relayout just syncs each frame to its stored x/z.
  function relayout() {
    for (const s of shelves) {
      s.frame.position.set(s.x, 0, s.z);
      s.frame.rotation.y = s.rot;
    }
  }

  // rebuild the flat slot list from the current shelf configuration
  function rebuildSlots() {
    slots = [];
    for (const shelf of shelves) {
      // rotate each slot's local (x,z) offset by the shelf's yaw so world slot
      // positions line up with the rotated frame meshes (Three.js Ry convention)
      const cos = Math.cos(shelf.rot), sin = Math.sin(shelf.rot);
      shelf.decks.forEach((deck, di) => {
        const slotW = SHELF_LEN / deck.cols;
        const dt = deckTop(di);
        const lz = shelf.depth / 2 - FRONT_MARGIN;   // single row, faced to the front edge
        for (let c = 0; c < deck.cols; c++) {
          const lx = -SHELF_LEN / 2 + (c + 0.5) * slotW;
          const x = shelf.x + lx * cos + lz * sin;
          const z = shelf.z - lx * sin + lz * cos;
          slots.push({
            shelfId: shelf.id, deck: di, col: c,
            x, y: dt, z, w: slotW, depth: shelf.depth,
            occupied: false, product: null,
            center: new THREE.Vector3(x, dt + 0.6, z),
          });
        }
      });
    }
  }

  // after a structural change, re-seat existing products into matching slots
  // (same shelf / deck / column); anything without a home is removed.
  function reflowProducts() {
    for (const prod of [...productsGroup.children]) {
      const p = prod.userData.placement;
      const slot = p && slots.find(
        (s) => s.shelfId === p.shelfId && s.deck === p.deck && s.col === p.col && !s.occupied
      );
      if (slot) {
        bind(prod, slot);
        const fit = fitScale(prod.userData.def, slot);
        prod.userData.fit = fit;
        animateTo(prod, new THREE.Vector3(slot.x, slot.y, slot.z), { scale: fit });
      } else {
        removeProduct(prod);
      }
    }
  }

  // re-link every product to its matching slot object without animating it.
  // used after a shelf move rebuilds the slot list — positions are handled by
  // the frame animation (products stay glued), so we only refresh the binding.
  function rebindAll() {
    for (const prod of [...productsGroup.children]) {
      const p = prod.userData.placement;
      const slot = p && slots.find(
        (s) => s.shelfId === p.shelfId && s.deck === p.deck && s.col === p.col && !s.occupied
      );
      if (slot) bind(prod, slot);
      else removeProduct(prod);
    }
  }

  // full rebuild after any layout/structure edit
  function rebuildAll() {
    relayout();
    rebuildSlots();
    reflowProducts();
    emitChange();
  }

  // slot highlight box (shown while hovering / dragging) — scaled to slot width
  const hi = new THREE.Mesh(
    new THREE.BoxGeometry(1, SLOT_FILL_H, 1.4),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.16, depthWrite: false })
  );
  const hiEdge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, SLOT_FILL_H, 1.4)),
    new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9 })
  );
  hi.add(hiEdge);
  hi.visible = false;
  world.add(hi);

  // shelf outline highlight (shown in move mode) — unit box scaled per shelf, glows via bloom
  const shelfHi = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9 })
  );
  shelfHi.visible = false;
  world.add(shelfHi);

  // ---------- rotation gizmo: a flat glowing ring around a shelf's base ----------
  // footprint is SHELF_LEN × shelf.depth regardless of decks; the ring geometry
  // is built at the default depth and scaled per shelf in showRotRing.
  const ringRadius = (depth) => Math.hypot(SHELF_LEN / 2, depth / 2) + 0.8;
  const RING_R = ringRadius(DEFAULT_DEPTH);          // base geometry radius; scaled per shelf
  const rotRing = new THREE.Mesh(
    new THREE.TorusGeometry(RING_R, 0.12, 10, 72),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.85, depthWrite: false })
  );
  rotRing.rotation.x = Math.PI / 2;                 // lay the ring flat on the floor
  rotRing.visible = false;
  // wider invisible tube makes the thin ring easy to grab with the pointer
  const rotRingHit = new THREE.Mesh(
    new THREE.TorusGeometry(RING_R, 0.7, 6, 48),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  rotRing.add(rotRingHit);
  world.add(rotRing);

  // show / move the ring to a shelf's base (null hides it)
  function showRotRing(shelf) {
    if (!shelf) { rotRing.visible = false; rotRing.userData.shelf = null; return; }
    rotRing.visible = true;
    rotRing.userData.shelf = shelf;
    const s = ringRadius(shelf.depth) / RING_R;       // match this shelf's footprint depth
    rotRing.scale.set(s, s, 1);
    rotRing.position.set(shelf.frame.position.x, 0.4, shelf.frame.position.z);
  }

  // ---------- products ----------
  const productsGroup = new THREE.Group();
  world.add(productsGroup);

  function buildProductMesh(def) {
    const g = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(def.color), roughness: 0.55, metalness: 0.15,
      emissive: new THREE.Color(def.color), emissiveIntensity: 0.08,
    });
    let body;
    if (def.shape === 'cyl') {
      body = new THREE.Mesh(new THREE.CylinderGeometry(def.w / 2, def.w / 2, def.h, 20), m);
      body.position.y = def.h / 2;
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(def.w / 2 * 0.6, def.w / 2 * 0.6, def.h * 0.12, 20),
        mat.metal
      );
      cap.position.y = def.h * 0.94;
      g.add(cap);
    } else {
      body = new THREE.Mesh(new THREE.BoxGeometry(def.w, def.h, def.d), m);
      body.position.y = def.h / 2;
    }
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    g.userData = { isProduct: true, def, slot: null, placement: null, anim: null, fit: 1, h: def.h, bodyMat: m };
    return g;
  }

  // uniform scale so a product fills its slot box (width × deck height × depth),
  // touching the tightest axis first. Can scale UP past 1 — small items grow to
  // fill the slot too, so every faced product reads as "full size" on the shelf.
  function fitScale(def, slot) {
    return Math.min(
      (slot.w * FILL_MARGIN) / def.w,
      SLOT_FILL_H / def.h,
      (slot.depth * FILL_MARGIN) / def.d,
    );
  }

  function removeProduct(prod) {
    const s = prod.userData.slot;
    if (s) { s.occupied = false; s.product = null; }
    productsGroup.remove(prod);
    prod.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose?.(); });
  }

  // ---------- animation helpers ----------
  function animateTo(prod, pos, { scale = 1, bounce = false } = {}) {
    prod.userData.anim = { tp: pos.clone(), ts: scale, bounce, bt: 0, done: false };
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function toNDC(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    return ndc;
  }

  // nearest slot to a screen point, measured in screen space
  const _v = new THREE.Vector3();
  function nearestSlot(clientX, clientY, { emptyOnly = true, allowSlot = null } = {}) {
    const rect = renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    let best = null, bestD = Infinity;
    for (const s of slots) {
      if (emptyOnly && s.occupied && s !== allowSlot) continue;
      _v.copy(s.center).project(camera);
      const sx = (_v.x * 0.5 + 0.5) * rect.width;
      const sy = (-_v.y * 0.5 + 0.5) * rect.height;
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    const maxR = Math.max(rect.width, rect.height) * 0.18;
    return bestD < maxR * maxR ? best : null;
  }

  function showHighlight(slot) {
    if (!slot) { hi.visible = false; return; }
    hi.visible = true;
    hi.scale.x = slot.w * 0.92;
    hi.position.set(slot.x, slot.y + SLOT_FILL_H / 2, slot.z);
  }

  // link a product to a slot (both directions) without animating
  function bind(prod, slot) {
    prod.userData.slot = slot;
    prod.userData.placement = { shelfId: slot.shelfId, deck: slot.deck, col: slot.col };
    slot.occupied = true;
    slot.product = prod;
  }

  function place(prod, slot, { bounce = true } = {}) {
    bind(prod, slot);
    const fit = fitScale(prod.userData.def, slot);
    prod.userData.fit = fit;
    const shelf = getShelf(slot.shelfId);
    if (shelf) prod.rotation.y = shelf.rot;        // face the same way as its shelf
    animateTo(prod, new THREE.Vector3(slot.x, slot.y, slot.z), { scale: fit, bounce });
  }

  function emitChange() {
    if (onChange) onChange(getState());
  }

  // ---------- selection / detail tooltip ----------
  let selectionActive = false;
  function emitSelect(payload) {
    if (payload == null && !selectionActive) return; // nothing to dismiss
    // the shelf outline tracks a live shelf selection; clear it for products / nothing
    if (!payload || payload.kind !== 'shelf') shelfHi.visible = false;
    selectionActive = payload != null;
    onSelect?.(payload);
  }

  function selectProduct(prod, x, y) {
    const d = prod.userData.def;
    const p = prod.userData.placement;
    let location = null;
    if (p) {
      const idx = shelves.findIndex((s) => s.id === p.shelfId);
      location = { shelf: idx + 1, deck: p.deck + 1, col: p.col + 1 };
    }
    emitSelect({
      kind: 'product', x, y,
      name: d.name, color: d.color,
      shape: d.shape === 'cyl' ? 'Cylinder' : 'Box',
      dims: { w: d.w, h: d.h, d: d.d },
      location,
    });
  }

  function selectShelf(shelf, x, y) {
    const idx = shelves.findIndex((s) => s.id === shelf.id);
    const mine = slots.filter((s) => s.shelfId === shelf.id);
    showShelfHighlight(shelf);               // outline the inspected shelf in the 3D view
    emitSelect({
      kind: 'shelf', x, y,
      id: shelf.id,                          // lets the React list mark the active card
      index: idx + 1,
      depth: +shelf.depth.toFixed(1),
      decks: shelf.decks.map((dk) => dk.cols),
      filled: mine.filter((s) => s.occupied).length,
      total: mine.length,
      pos: { x: +shelf.x.toFixed(1), z: +shelf.z.toFixed(1) },
      rot: Math.round((((shelf.rot * 180 / Math.PI) % 360) + 360) % 360),
    });
  }

  function getState() {
    return {
      placed: slots.filter((s) => s.occupied).length,
      total: slots.length,
      shelves: shelves.map((s) => ({ id: s.id, depth: s.depth, decks: s.decks.map((d) => ({ cols: d.cols })) })),
      limits: LIMITS,
    };
  }

  // ---------- public: shelf layout editing ----------
  function addShelf() {
    if (shelves.length >= LIMITS.maxShelves) return false;
    // new shelves are appended to the right end of the current row
    const x = shelves.length
      ? Math.min(X_LIMIT, Math.max(...shelves.map((s) => s.x)) + MIN_X_GAP)
      : 0;
    const shelf = {
      id: nextShelfId++,
      x, z: 0, rot: 0, depth: LIMITS.defaultDepth,
      decks: Array.from({ length: LIMITS.defaultDecks }, () => ({ cols: LIMITS.defaultCols })),
      frame: new THREE.Group(),
      anim: null,
    };
    shelf.frame.userData.shelfId = shelf.id;
    shelvesGroup.add(shelf.frame);
    shelves.push(shelf);
    buildShelfFrame(shelf);
    rebuildAll();
    return true;
  }

  function removeShelf(id) {
    const idx = shelves.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const [shelf] = shelves.splice(idx, 1);
    for (const prod of [...productsGroup.children]) {
      if (prod.userData.placement?.shelfId === id) removeProduct(prod);
    }
    clearFrame(shelf.frame);
    shelvesGroup.remove(shelf.frame);
    if (rotRing.userData.shelf === shelf) showRotRing(null);
    emitSelect(null);
    rebuildAll();
  }

  function addDeck(id) {
    const shelf = getShelf(id);
    if (!shelf || shelf.decks.length >= LIMITS.maxDecks) return;
    shelf.decks.push({ cols: LIMITS.defaultCols });
    buildShelfFrame(shelf);
    rebuildAll();
  }

  function removeDeck(id) {
    const shelf = getShelf(id);
    if (!shelf || shelf.decks.length <= LIMITS.minDecks) return;
    shelf.decks.pop(); // products on the removed top deck get dropped by reflow
    buildShelfFrame(shelf);
    rebuildAll();
  }

  // set the column count (slot width) of one deck on one shelf
  function setDeckCols(id, deckIndex, cols) {
    const shelf = getShelf(id);
    if (!shelf || !shelf.decks[deckIndex]) return;
    const next = clamp(Math.round(cols), LIMITS.minCols, LIMITS.maxCols);
    if (next === shelf.decks[deckIndex].cols) return;
    shelf.decks[deckIndex].cols = next; // products beyond the new column count get dropped
    buildShelfFrame(shelf);
    rebuildAll();
  }

  // set one shelf's depth (front-to-back size). Growing is blocked if it would
  // overlap a neighbour or push the shelf off the floor (same rule as move/rotate);
  // shrinking always fits, so it just re-seats the faced-forward product row.
  function setShelfDepth(id, depth) {
    const shelf = getShelf(id);
    if (!shelf) return false;
    const next = clamp(
      Math.round(depth / LIMITS.depthStep) * LIMITS.depthStep,
      LIMITS.minDepth, LIMITS.maxDepth
    );
    if (next === shelf.depth) return false;
    if (next > shelf.depth) {                              // growing can collide / overflow
      if (Math.abs(shelf.z) > zLimit(next)) return false;
      if (obbOverlap(shelf, shelf.x, shelf.z, shelf.rot, next)) return false;
    }
    shelf.depth = next;
    buildShelfFrame(shelf);
    rebuildAll();
    if (rotRing.userData.shelf === shelf) showRotRing(shelf);
    return true;
  }

  // ---------- public: drop a new product from the palette ----------
  function dropAt(clientX, clientY, def) {
    if (moveMode) return false;              // products are locked while moving shelves
    const slot = nearestSlot(clientX, clientY, { emptyOnly: true });
    hi.visible = false;
    if (!slot) return false;
    const prod = buildProductMesh(def);
    productsGroup.add(prod);
    prod.position.set(slot.x, slot.y + 4.5, slot.z);
    prod.scale.setScalar(0.05);
    place(prod, slot, { bounce: true });
    emitChange();
    return true;
  }

  // ---------- public: hover preview during palette drag ----------
  function hoverAt(clientX, clientY) {
    if (moveMode) return;
    showHighlight(nearestSlot(clientX, clientY, { emptyOnly: true }));
  }
  function clearHover() { hi.visible = false; }

  function clear() {
    for (const s of slots) { s.occupied = false; s.product = null; }
    while (productsGroup.children.length) {
      const c = productsGroup.children.pop();
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose?.(); });
    }
    emitSelect(null);
    emitChange();
  }

  // ---------- public: inspect a shelf from the React sidebar list ----------
  // mirrors a 3D shelf click: opens the detail card (positioned at the cursor)
  // and outlines the shelf in the scene.
  function inspectShelf(id, clientX, clientY) {
    const shelf = getShelf(id);
    if (shelf) selectShelf(shelf, clientX, clientY);
  }

  // dismiss the current selection (closes the detail card, clears the outline)
  function deselect() { emitSelect(null); }

  // ---------- internal: pointer interactions ----------
  const dragPlane = new THREE.Plane();                            // vertical plane for product drag
  const planeHit = new THREE.Vector3();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);  // y = 0 plane for shelf drag
  const groundHit = new THREE.Vector3();
  let dragging = null;   // dragging a product:  { prod, fromSlot }
  let shelfDrag = null;  // dragging a shelf:    { shelf, offX, offZ, x0, z0 }
  let rotDrag = null;    // rotating a shelf:    { shelf, startAngle, rot0 }
  let moveMode = false;  // true → pointer drags shelves instead of products
  let downPos = null;    // pointer-down screen position (to tell a click from a drag)
  let downShelf = null;  // shelf under the cursor at pointer-down (for click-to-inspect)
  const CLICK_SLOP = 6;  // px of movement still counted as a click, not a drag

  function movedFar(e) {
    return !downPos || Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP;
  }

  function pickProduct(clientX, clientY) {
    raycaster.setFromCamera(toNDC(clientX, clientY), camera);
    const hits = raycaster.intersectObjects(productsGroup.children, true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && !o.userData?.isProduct) o = o.parent;
    return o || null;
  }

  function pickShelf(clientX, clientY) {
    raycaster.setFromCamera(toNDC(clientX, clientY), camera);
    const hits = raycaster.intersectObjects(shelvesGroup.children, true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && o.userData.shelfId === undefined) o = o.parent;
    return o ? getShelf(o.userData.shelfId) : null;
  }

  // ---- oriented-footprint collision (2D separating-axis test on the floor) ----
  // every shelf footprint is a SHELF_LEN × shelf.depth rectangle centred on its frame.
  const HALF_LEN = SHELF_LEN / 2;
  const CLEARANCE = 0.15;          // hair of space so flush shelves don't z-fight/flicker

  // would `shelf` overlap any other shelf if placed at (x, z) with yaw `rot`?
  // `depth` lets callers test a hypothetical depth (e.g. before committing a resize).
  function obbOverlap(shelf, x, z, rot, depth = shelf.depth) {
    const halfDep1 = depth / 2;
    const c1 = Math.cos(rot), s1 = Math.sin(rot);
    const ax1 = [c1, -s1], az1 = [s1, c1];                 // this shelf's world axes
    for (const o of shelves) {
      if (o === shelf) continue;
      const halfDep2 = o.depth / 2;
      const c2 = Math.cos(o.rot), s2 = Math.sin(o.rot);
      const ax2 = [c2, -s2], az2 = [s2, c2];               // other shelf's world axes
      const dx = o.x - x, dz = o.z - z;
      let separated = false;
      // a rectangle pair is disjoint iff some candidate axis separates them
      for (const [ux, uz] of [ax1, az1, ax2, az2]) {
        const r1 = HALF_LEN * Math.abs(ax1[0] * ux + ax1[1] * uz)
                 + halfDep1 * Math.abs(az1[0] * ux + az1[1] * uz);
        const r2 = HALF_LEN * Math.abs(ax2[0] * ux + ax2[1] * uz)
                 + halfDep2 * Math.abs(az2[0] * ux + az2[1] * uz);
        if (Math.abs(dx * ux + dz * uz) > r1 + r2 + CLEARANCE) { separated = true; break; }
      }
      if (!separated) return true;
    }
    return false;
  }

  // soft-snap a yaw to the nearest right angle when within a few degrees of it
  const SNAP_RAD = 5 * Math.PI / 180;
  function softSnap(angle) {
    const q = Math.PI / 2;
    const nearest = Math.round(angle / q) * q;
    return Math.abs(angle - nearest) < SNAP_RAD ? nearest : angle;
  }

  function showShelfHighlight(shelf, warn = false) {
    if (!shelf) { shelfHi.visible = false; return; }
    const H = shelfHeight(shelf.decks);
    shelfHi.visible = true;
    shelfHi.scale.set(SHELF_LEN + 0.4, H + 0.3, shelf.depth + 0.4);
    shelfHi.position.set(shelf.frame.position.x, H / 2, shelf.frame.position.z);
    shelfHi.rotation.y = shelf.frame.rotation.y;     // track the shelf's live yaw
    shelfHi.material.color.setHex(warn ? 0xff5a6a : ACCENT);
  }

  // re-seat a shelf's products onto their slots using the frame's *live* transform
  // (position + yaw), so they stay glued and rotated while moving or rotating —
  // works mid-drag, before shelf.x/z/rot are committed.
  function syncShelfProducts(shelf) {
    const fx = shelf.frame.position.x, fz = shelf.frame.position.z;
    const ry = shelf.frame.rotation.y;
    const cos = Math.cos(ry), sin = Math.sin(ry);
    for (const prod of productsGroup.children) {
      const p = prod.userData.placement;
      if (!p || p.shelfId !== shelf.id) continue;
      const deck = shelf.decks[p.deck];
      if (!deck) continue;
      const slotW = SHELF_LEN / deck.cols;
      const lx = -SHELF_LEN / 2 + (p.col + 0.5) * slotW;
      const lz = shelf.depth / 2 - FRONT_MARGIN;   // match the faced-forward slot row
      prod.position.x = fx + lx * cos + lz * sin;
      prod.position.z = fz - lx * sin + lz * cos;
      prod.rotation.y = ry;
    }
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    downPos = { x: e.clientX, y: e.clientY };
    downShelf = null;
    emitSelect(null);                        // any open detail card is dismissed on press

    if (moveMode) {
      raycaster.setFromCamera(toNDC(e.clientX, e.clientY), camera);
      // 1) grabbing the rotation ring → start a rotate drag for its shelf
      if (rotRing.visible && raycaster.intersectObject(rotRing, true).length) {
        const shelf = rotRing.userData.shelf;
        if (shelf) {
          controls.enabled = false;
          raycaster.ray.intersectPlane(ground, groundHit);
          const a0 = Math.atan2(groundHit.z - shelf.frame.position.z, groundHit.x - shelf.frame.position.x);
          shelf.anim = null;
          rotDrag = { shelf, startAngle: a0, rot0: shelf.rot };
          el.style.cursor = 'grabbing';
          el.setPointerCapture?.(e.pointerId);
          return;
        }
      }
      // 2) otherwise grab the shelf body → move it
      const shelf = pickShelf(e.clientX, e.clientY);
      if (!shelf) return;                    // empty space → let OrbitControls orbit
      controls.enabled = false;
      raycaster.ray.intersectPlane(ground, groundHit);
      shelf.anim = null;                     // take manual control of the frame
      const fp = shelf.frame.position;
      shelfDrag = {
        shelf,
        offX: fp.x - groundHit.x, offZ: fp.z - groundHit.z, // grab offset (no jump)
        x0: fp.x, z0: fp.z,
      };
      el.style.cursor = 'grabbing';
      el.setPointerCapture?.(e.pointerId);
      return;
    }

    const prod = pickProduct(e.clientX, e.clientY);
    if (!prod) {
      // no product → remember any shelf here so a plain click can inspect it
      downShelf = pickShelf(e.clientX, e.clientY);
      return;                                // let OrbitControls orbit
    }
    controls.enabled = false;
    const fromSlot = prod.userData.slot;
    if (fromSlot) { fromSlot.occupied = false; fromSlot.product = null; }
    dragging = { prod, fromSlot };
    prod.userData.anim = null;               // take manual control
    el.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e) {
    if (rotDrag) {
      raycaster.setFromCamera(toNDC(e.clientX, e.clientY), camera);
      if (raycaster.ray.intersectPlane(ground, groundHit)) {
        const { shelf } = rotDrag;
        const a = Math.atan2(groundHit.z - shelf.frame.position.z, groundHit.x - shelf.frame.position.x);
        // minus: world pointer-angle increases as the shelf's yaw decreases (Ry)
        let next = softSnap(rotDrag.rot0 - (a - rotDrag.startAngle));
        const blocked = obbOverlap(shelf, shelf.x, shelf.z, next);
        if (!blocked) {                        // commit only collision-free angles
          shelf.rot = next;
          shelf.frame.rotation.y = next;
          syncShelfProducts(shelf);
        }
        showRotRing(shelf);
        showShelfHighlight(shelf, blocked);
      }
      return;
    }

    if (shelfDrag) {
      raycaster.setFromCamera(toNDC(e.clientX, e.clientY), camera);
      if (raycaster.ray.intersectPlane(ground, groundHit)) {
        const zl = zLimit(shelfDrag.shelf.depth);
        const nx = clamp(groundHit.x + shelfDrag.offX, -X_LIMIT, X_LIMIT);
        const nz = clamp(groundHit.z + shelfDrag.offZ, -zl, zl);
        const blocked = obbOverlap(shelfDrag.shelf, nx, nz, shelfDrag.shelf.rot);
        if (!blocked) {                        // block: keep last valid spot on overlap
          shelfDrag.shelf.frame.position.x = nx;
          shelfDrag.shelf.frame.position.z = nz;
          syncShelfProducts(shelfDrag.shelf);
        }
        showShelfHighlight(shelfDrag.shelf, blocked);
        showRotRing(shelfDrag.shelf);
      }
      return;
    }

    if (dragging) {
      camera.getWorldDirection(dragPlane.normal);
      dragPlane.setFromNormalAndCoplanarPoint(dragPlane.normal, new THREE.Vector3(0, 3, 0));
      raycaster.setFromCamera(toNDC(e.clientX, e.clientY), camera);
      if (raycaster.ray.intersectPlane(dragPlane, planeHit)) {
        dragging.prod.position.copy(planeHit);
        dragging.prod.scale.setScalar(1.08);
      }
      showHighlight(nearestSlot(e.clientX, e.clientY, { emptyOnly: true, allowSlot: dragging.fromSlot }));
      return;
    }

    if (moveMode) {
      let shelf = pickShelf(e.clientX, e.clientY);
      // keep the ring up while hovering over the ring itself (it sits off the shelf)
      if (!shelf && rotRing.visible) {
        raycaster.setFromCamera(toNDC(e.clientX, e.clientY), camera);
        if (raycaster.intersectObject(rotRing, true).length) shelf = rotRing.userData.shelf;
      }
      showShelfHighlight(shelf);
      showRotRing(shelf);
    }
  }

  function onPointerUp(e) {
    const click = !movedFar(e);

    if (rotDrag) {
      const { shelf } = rotDrag;
      // yaw was committed live during the drag (block model) — just resettle slots
      rebuildSlots();
      rebindAll();
      syncShelfProducts(shelf);
      rotDrag = null;
      controls.enabled = true;
      el.style.cursor = moveMode ? 'grab' : '';
      if (click) selectShelf(shelf, e.clientX, e.clientY); // a tap on the ring inspects
      showRotRing(shelf);
      emitChange();
      return;
    }

    if (shelfDrag) {
      const { shelf, x0, z0 } = shelfDrag;
      if (click) {
        // a tap on a shelf inspects it; revert any tiny nudge back to start
        shelf.frame.position.set(x0, 0, z0);
        syncShelfProducts(shelf);
        selectShelf(shelf, e.clientX, e.clientY);
      } else {
        // the dragged spot is already collision-free (block model) → commit it
        const zl = zLimit(shelf.depth);
        shelf.x = clamp(shelf.frame.position.x, -X_LIMIT, X_LIMIT);
        shelf.z = clamp(shelf.frame.position.z, -zl, zl);
        rebuildSlots();
        rebindAll();
      }
      shelfDrag = null;
      controls.enabled = true;
      el.style.cursor = moveMode ? 'grab' : '';
      showRotRing(shelf);
      emitChange();
      return;
    }

    if (dragging) {
      const { prod, fromSlot } = dragging;
      hi.visible = false;
      if (click) {
        // a tap on a product inspects it; settle it back into its slot
        if (fromSlot) place(prod, fromSlot, { bounce: false });
        selectProduct(prod, e.clientX, e.clientY);
        dragging = null; controls.enabled = true; emitChange();
        return;
      }
      // dropped low (below the shelves) → delete
      if (planeHit.y < 0.6 && e.type !== 'pointercancel') {
        removeProduct(prod);
        dragging = null; controls.enabled = true; emitChange();
        return;
      }
      const target = nearestSlot(e.clientX, e.clientY, { emptyOnly: true, allowSlot: fromSlot }) || fromSlot;
      if (target) place(prod, target, { bounce: true });
      dragging = null;
      controls.enabled = true;
      emitChange();
      return;
    }

    // not dragging: an orbit gesture, or a plain click on a shelf / empty space
    controls.enabled = true;
    if (click && downShelf) selectShelf(downShelf, e.clientX, e.clientY);
    downShelf = null;
  }

  // double-click to remove a product (disabled while moving shelves)
  function onDblClick(e) {
    if (moveMode) return;
    const prod = pickProduct(e.clientX, e.clientY);
    if (!prod) return;
    removeProduct(prod);
    emitSelect(null);
    emitChange();
  }

  // toggle shelf-move mode; dims products to signal they're locked
  function setMoveMode(on) {
    moveMode = !!on;
    emitSelect(null);                        // close any detail card on mode change
    el.style.cursor = moveMode ? 'grab' : '';
    if (!moveMode) { shelfHi.visible = false; showRotRing(null); }
    for (const prod of productsGroup.children) {
      const m = prod.userData.bodyMat;
      if (m) { m.transparent = true; m.opacity = moveMode ? 0.32 : 1; }
    }
  }

  const el = renderer.domElement;
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
  el.addEventListener('dblclick', onDblClick);

  // ---------- post-processing ----------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.38, 0.55, 0.3));
  composer.addPass(new OutputPass());

  // ---------- animation loop ----------
  const clock = new THREE.Clock();
  let rafId = 0;
  const _tmp = new THREE.Vector3();

  function tickAnim(prod, dt) {
    const a = prod.userData.anim;
    if (!a) return;
    prod.position.lerp(a.tp, 1 - Math.pow(0.001, dt)); // smooth, frame-rate independent
    const sNow = prod.scale.x;
    let sTarget = a.ts;
    if (a.bounce) {
      a.bt += dt;
      const k = Math.min(a.bt / 0.45, 1);
      sTarget = a.ts * (1 + Math.sin(k * Math.PI) * 0.12);
      if (k >= 1) a.bounce = false;
    }
    const sn = THREE.MathUtils.lerp(sNow, sTarget, 1 - Math.pow(0.0015, dt));
    prod.scale.setScalar(sn);
    if (_tmp.copy(prod.position).distanceTo(a.tp) < 0.01 && !a.bounce) {
      prod.position.copy(a.tp);
      prod.scale.setScalar(a.ts);
      prod.userData.anim = null;
    }
  }

  // animate a shelf frame to its resolved position, dragging its products along
  function tickShelfAnim(shelf, dt) {
    const a = shelf.anim;
    if (!a) return;
    shelf.frame.position.lerp(a.tp, 1 - Math.pow(0.001, dt));
    syncShelfProducts(shelf);                 // keep products glued (position + yaw)
    if (shelf.frame.position.distanceTo(a.tp) < 0.01) {
      shelf.frame.position.copy(a.tp);
      syncShelfProducts(shelf);
      shelf.anim = null;
    }
  }

  // move one walking agent along the loop and animate its legs / wheels
  function tickAgent(ag, dt, time) {
    ag.t = (ag.t + ag.speed * dt) % 1;
    const pos = walkCurve.getPointAt(ag.t);
    ag.obj.position.copy(pos);
    const tan = walkCurve.getTangentAt(ag.t).normalize();
    _tmp.copy(pos).add(tan);
    ag.obj.lookAt(_tmp);

    const p = ag.obj.userData.parts;
    const phase = time * ag.speed * 130 + ag.t * 40;
    if (ag.kind === 'human') {
      const swing = Math.sin(phase) * 0.7;
      p.legL.rotation.x = swing;
      p.legR.rotation.x = -swing;
      p.armL.rotation.x = -swing * 0.8;
      p.armR.rotation.x = swing * 0.8;
      p.body.position.y = 1.6 + Math.abs(Math.sin(phase)) * 0.06;
    } else {
      for (const w of p.wheels) w.rotation.x += ag.speed * dt * 60;
      p.body.position.y = 0.55 + Math.sin(phase) * 0.04;
      p.eye.scale.y = 1 + Math.sin(time * 5 + ag.t * 10) * 0.35; // gentle "blink"
    }
  }

  function animate() {
    rafId = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    for (const prod of productsGroup.children) tickAnim(prod, dt);
    for (const shelf of shelves) tickShelfAnim(shelf, dt);
    for (const ag of agents) tickAgent(ag, dt, t);

    if (hi.visible) hi.material.opacity = 0.12 + Math.sin(t * 6) * 0.06;
    if (shelfHi.visible) shelfHi.material.opacity = 0.7 + Math.sin(t * 5) * 0.22;
    mat.label.emissiveIntensity = 0.45 + Math.sin(t * 3) * 0.15;

    controls.update();
    composer.render();
  }

  function resize() {
    width = container.clientWidth || window.innerWidth;
    height = container.clientHeight || window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    composer.setSize(width, height);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // start with a single shelf
  addShelf();
  animate();

  const controller = {
    dispose, hoverAt, clearHover, dropAt, clear, getState,
    addShelf, removeShelf, addDeck, removeDeck, setDeckCols, setShelfDepth, setMoveMode,
    inspectShelf, deselect,
  };
  if (typeof window !== 'undefined') window.__shelf = controller; // debug handle

  // ---------- cleanup ----------
  function dispose() {
    cancelAnimationFrame(rafId);
    ro.disconnect();
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerUp);
    el.removeEventListener('dblclick', onDblClick);
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
    if (el.parentNode === container) container.removeChild(el);
  }

  return controller;
}
