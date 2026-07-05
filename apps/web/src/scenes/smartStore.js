import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// V4 — isometric "smart store" interior that sits inside the dashboard's
// center stage. Renders a dark retail room: perimeter shelving, free-standing
// gondolas, a checkout counter, walking shoppers, glowing floor paths and
// floating numbered zone badges (01–06).
export function createSmartStoreScene(container, { onSelectShelf } = {}) {
  const ACCENT = 0x35c3ff;

  let width = container.clientWidth || window.innerWidth;
  let height = container.clientHeight || window.innerHeight;

  // ---------- renderer / scene / camera ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(width, height);
  // cap at 1.5: on HiDPI screens the bloom passes make 2x pixel density very
  // costly during orbit; 1.5 keeps it sharp while cutting fragment work a lot.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = null; // let the dashboard backdrop show through

  const frustum = 17;
  let aspect = width / height;
  const camera = new THREE.OrthographicCamera(
    -frustum * aspect, frustum * aspect, frustum, -frustum, 0.1, 1000
  );
  camera.position.set(30, 26, 30);
  camera.lookAt(0, 3, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.15;
  controls.minZoom = 0.7;
  controls.maxZoom = 2.6;
  controls.maxPolarAngle = Math.PI / 2.3;
  controls.minPolarAngle = Math.PI / 6;
  controls.target.set(0, 3, 0);

  // ---------- lighting ----------
  scene.add(new THREE.AmbientLight(0x2a3f6b, 1.1));
  scene.add(new THREE.HemisphereLight(0x4a6bd0, 0x05070f, 0.6));
  const key = new THREE.DirectionalLight(0xcfe0ff, 1.2);
  key.position.set(18, 32, 14);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 110;
  const sh = 32;
  key.shadow.camera.left = -sh; key.shadow.camera.right = sh;
  key.shadow.camera.top = sh; key.shadow.camera.bottom = -sh;
  key.shadow.bias = -0.0004;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x2f6bff, 0.4);
  fill.position.set(-22, 16, -18);
  scene.add(fill);

  // ---------- materials ----------
  const mat = {
    floor: new THREE.MeshStandardMaterial({ color: 0x10192f, roughness: 0.95, metalness: 0.1 }),
    wall: new THREE.MeshStandardMaterial({ color: 0x0c1426, roughness: 0.9, metalness: 0.15 }),
    shelf: new THREE.MeshStandardMaterial({ color: 0x1c2c4e, roughness: 0.8, metalness: 0.2 }),
    shelfDk: new THREE.MeshStandardMaterial({ color: 0x121f39, roughness: 0.85, metalness: 0.25 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x3c4858, roughness: 0.45, metalness: 0.65 }),
    counter: new THREE.MeshStandardMaterial({ color: 0x1a2745, roughness: 0.6, metalness: 0.3 }),
    label: new THREE.MeshStandardMaterial({ color: 0x0c1730, emissive: ACCENT, emissiveIntensity: 1.0, roughness: 0.4 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x0a0d14, roughness: 0.9 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xe0a87e, roughness: 0.7 }),
    screen: new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.32 }),
  };
  const productColors = [0xe2574c, 0x4caf72, 0xefb23a, 0x5b8def, 0xb07cdb, 0xe07baf, 0x37c2c9, 0xf08a3c];

  function box(w, h, d, material, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y + h / 2, z);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  const world = new THREE.Group();
  scene.add(world);

  // ---------- floor + glowing grid ----------
  const ROOM = 30;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM, ROOM), mat.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  world.add(floor);

  const grid = new THREE.GridHelper(ROOM, 30, 0x1d3a72, 0x14264a);
  grid.position.y = 0.02;
  grid.material.transparent = true; grid.material.opacity = 0.35;
  world.add(grid);

  // soft glowing border strip on the floor edges
  const edgeGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(ROOM - 0.5, ROOM - 0.5));
  const edge = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.4 }));
  edge.rotation.x = -Math.PI / 2; edge.position.y = 0.04;
  world.add(edge);

  // ---------- back walls (the two far sides of the room) ----------
  const WALL_H = 9;
  function wall(len, rotY, x, z) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, 0.4), mat.wall);
    w.position.set(x, WALL_H / 2, z);
    w.rotation.y = rotY;
    w.receiveShadow = true; w.castShadow = true;
    world.add(w);
    return w;
  }
  const half = ROOM / 2;
  wall(ROOM, 0, 0, -half);             // back wall (along -Z)
  wall(ROOM, Math.PI / 2, -half, 0);   // left wall (along -X)

  // glowing header band on each wall (like the lit signage in the image)
  function wallBand(len, rotY, x, z) {
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.5, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x0c1730, emissive: ACCENT, emissiveIntensity: 1.4, roughness: 0.4 })
    );
    b.position.set(x, WALL_H - 1.4, z);
    b.rotation.y = rotY;
    world.add(b);
  }
  wallBand(ROOM - 2, 0, 0, -half + 0.3);
  wallBand(ROOM - 2, Math.PI / 2, -half + 0.3, 0);

  // ---------- shelving units ----------
  // face = world-space normal of the shelf's front (the side the camera flies to)
  const FACE = {
    px: new THREE.Vector3(1, 0, 0), nx: new THREE.Vector3(-1, 0, 0),
    pz: new THREE.Vector3(0, 0, 1), nz: new THREE.Vector3(0, 0, -1),
  };
  const zones = []; // { pos, unit, face, dist, height, focusZoom }

  // A gondola = double-sided free-standing shelf full of colorful products.
  function gondola(x, z, length, rotY = 0) {
    const g = new THREE.Group();
    const depth = 1.5, gheight = 3.6;
    g.add(box(length, gheight, 0.18, mat.shelfDk, 0, 0, 0));
    g.add(box(length, 0.35, depth, mat.shelf, 0, 0, 0));
    const levels = [1.0, 2.0, 3.0];
    for (const ly of levels) {
      g.add(box(length, 0.1, depth, mat.shelf, 0, ly - 0.05, 0));
      for (let side = -1; side <= 1; side += 2) {
        const pz = side * (depth / 2 - 0.32);
        for (let i = 0; i < length - 1; i++) {
          if (Math.random() < 0.1) continue;
          const px = -length / 2 + 0.75 + i;
          const ph = 0.5 + Math.random() * 0.4;
          const col = productColors[(i + Math.round(ly * 2)) % productColors.length];
          g.add(box(0.62, ph, 0.55, new THREE.MeshStandardMaterial({ color: col, roughness: 0.7 }), px, ly, pz));
        }
        const label = box(length, 0.16, 0.04, mat.label.clone(), 0, ly + 0.08, side * (depth / 2 + 0.02));
        g.add(label);
      }
    }
    g.add(box(0.16, gheight, depth, mat.metal, -length / 2, 0, 0));
    g.add(box(0.16, gheight, depth, mat.metal, length / 2, 0, 0));
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    world.add(g);
    return g;
  }

  // Wall-mounted shelving that hugs a back wall, products facing the room.
  function wallShelf(length, rotY, x, z) {
    const g = new THREE.Group();
    const depth = 1.3, gheight = 6.5;
    g.add(box(length, gheight, 0.15, mat.shelfDk, 0, 0, -depth / 2));
    const levels = [1.0, 2.3, 3.6, 4.9];
    for (const ly of levels) {
      g.add(box(length, 0.1, depth, mat.shelf, 0, ly - 0.05, 0));
      for (let i = 0; i < length - 1; i++) {
        if (Math.random() < 0.08) continue;
        const px = -length / 2 + 0.7 + i;
        const ph = 0.55 + Math.random() * 0.45;
        const col = productColors[(i * 2 + Math.round(ly)) % productColors.length];
        g.add(box(0.6, ph, 0.5, new THREE.MeshStandardMaterial({ color: col, roughness: 0.7 }), px, ly, 0.1));
      }
      const label = box(length, 0.16, 0.04, mat.label.clone(), 0, ly + 0.08, depth / 2 - 0.02);
      g.add(label);
    }
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    world.add(g);
    return g;
  }

  // back-wall beverage shelf (zone 01) + center gondolas (02) + snacks (03)
  // each carries the camera-framing it flies to: front normal, stand-off distance,
  // height above the shelf center, and the ortho zoom to settle at.
  zones.push({ pos: new THREE.Vector3(-2, 8, -half + 1.6), unit: wallShelf(16, 0, -3, -half + 1.6), face: FACE.pz, dist: 15, height: 4, focusZoom: 2.0 });          // 01 beverages
  zones.push({ pos: new THREE.Vector3(2.5, 5.5, 1), unit: gondola(2.5, 1, 11), face: FACE.pz, dist: 14, height: 4, focusZoom: 2.2 });                                // 02 center shelf
  zones.push({ pos: new THREE.Vector3(half - 1.6, 8, 0), unit: wallShelf(16, Math.PI / 2, half - 1.6, 1), face: FACE.px, dist: 14, height: 4, focusZoom: 2.0 });       // 03 snacks (right wall) — products face +X (the open side)
  zones.push({ pos: new THREE.Vector3(-8.5, 5.5, 4), unit: gondola(-8.5, 4, 9), face: FACE.pz, dist: 14, height: 4, focusZoom: 2.2 });                               // 04 dairy & juice
  zones.push({ pos: new THREE.Vector3(-6, 5.5, 10), unit: gondola(-6, 10, 7, Math.PI / 2), face: FACE.px, dist: 14, height: 4, focusZoom: 2.2 });                    // 05 fresh & ready

  // ---------- checkout counter (zone 06) ----------
  function checkout(x, z) {
    const g = new THREE.Group();
    g.add(box(5.5, 1.1, 2.4, mat.counter, 0, 0, 0));
    g.add(box(5.5, 0.18, 2.6, mat.metal, 0, 1.1, 0));
    // POS terminal
    g.add(box(0.9, 0.7, 0.6, mat.metal, -1.8, 1.28, 0));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), mat.screen);
    screen.position.set(-1.8, 1.95, 0.31);
    g.add(screen);
    // glowing front strip
    const strip = box(5.5, 0.12, 0.05, new THREE.MeshStandardMaterial({ color: 0x0c1730, emissive: ACCENT, emissiveIntensity: 1.6, roughness: 0.4 }), 0, 0.45, 1.22);
    g.add(strip);
    g.position.set(x, 0, z);
    world.add(g);
    return g;
  }
  const co = checkout(7, 9);
  zones.push({ pos: new THREE.Vector3(7, 3.2, 9), unit: co, face: FACE.pz, dist: 13, height: 4, focusZoom: 2.3 });

  // ---------- floating numbered zone badges (01–06) ----------
  function makeBadge(num) {
    // 256px (power-of-two so mipmaps stay sharp); all draw values scale with
    // `size` so the ring edge reads smooth even when the camera zooms in close.
    const size = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    // outer glow ring
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
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(2.2, 2.2, 1);
    return sprite;
  }

  const badges = [];
  zones.forEach((zn, i) => {
    const b = makeBadge(String(i + 1).padStart(2, '0'));
    b.position.copy(zn.pos);
    b.userData = { base: zn.pos.y, t: i * 0.9, shelfId: i + 1 };
    world.add(b);
    badges.push(b);
    // thin connector line down to the unit
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      zn.pos.clone(), new THREE.Vector3(zn.pos.x, 0.1, zn.pos.z),
    ]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.25 }));
    world.add(line);
  });

  // ---------- shelf selection (click a unit → dashboard filters its stock) ----------
  // tag every mesh of each unit with its 1-based shelf id so raycast hits resolve.
  zones.forEach((zn, i) => {
    const sid = i + 1;
    zn.unit.traverse((o) => { o.userData.shelfId = sid; });
  });

  // outline boxes wrapping a unit (sized from its bounds): a bright pulsing one
  // for the current selection, a dim static one that follows the hovered shelf.
  function makeOutline(opacity) {
    const o = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity })
    );
    o.visible = false;
    world.add(o);
    return o;
  }
  const selOutline = makeOutline(0.9);

  // hover feedback: a soft glowing shell wrapping the unit (BackSide + additive
  // so it reads as a halo and lights up via the existing bloom pass). Fades and
  // scales in/out — driven from the render loop, not toggled instantly.
  function makeGlowShell() {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: ACCENT, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
      })
    );
    m.visible = false;
    m.userData = { sx: 1, sy: 1, sz: 1, cx: 0, cy: 0, cz: 0 };
    world.add(m);
    return m;
  }
  const hoverGlow = makeGlowShell();

  const _box = new THREE.Box3();
  const _size = new THREE.Vector3();
  const _ctr = new THREE.Vector3();
  function frameOutline(outline, unit, pad) {
    _box.setFromObject(unit);
    _box.getSize(_size);
    _box.getCenter(_ctr);
    outline.scale.set(_size.x + pad, _size.y + pad, _size.z + pad);
    outline.position.copy(_ctr);
    outline.visible = true;
  }

  // ---------- camera fly-to (zoom into a shelf's front) ----------
  // A hand-rolled tween driven from the render loop: every trigger snapshots the
  // CURRENT pose as `from` so rapid clicks / mid-flight switches curve smoothly
  // instead of snapping. While flying, OrbitControls is disabled and we skip its
  // update() so damping doesn't fight the tween; on landing we re-enable it with
  // the target parked on the shelf center, so the user can keep orbiting.
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const FLY_DUR = 0.9; // seconds
  const fly = {
    active: false, t: 0,
    fromPos: new THREE.Vector3(), toPos: new THREE.Vector3(),
    fromTgt: new THREE.Vector3(), toTgt: new THREE.Vector3(),
    fromZoom: 1, toZoom: 1,
  };

  // the overview pose to return to: captured from wherever the user left the
  // camera when they first focus a shelf, so deselect restores their own angle.
  let homePose = null;

  const _ctr2 = new THREE.Vector3();
  function landingPoseFor(id) {
    const zn = zones[id - 1];
    _box.setFromObject(zn.unit);
    _box.getCenter(_ctr2);
    const pos = _ctr2.clone()
      .addScaledVector(zn.face, zn.dist)
      .addScaledVector(WORLD_UP, zn.height);
    return { pos, target: _ctr2.clone(), zoom: zn.focusZoom ?? 1.8 };
  }

  function flyTo(pos, target, zoom) {
    fly.fromPos.copy(camera.position);
    fly.fromTgt.copy(controls.target);
    fly.fromZoom = camera.zoom;
    fly.toPos.copy(pos);
    fly.toTgt.copy(target);
    fly.toZoom = zoom;
    fly.t = 0;
    fly.active = true;
    controls.enabled = false; // we own the camera until the tween lands
  }

  let selectedId = null;
  let hoverId = null;        // shelf currently under the cursor (null = none/selected)
  let hoverProgress = 0;     // 0..1 fade state for the glow shell
  function selectShelf(id) {
    const prev = selectedId;
    selectedId = id || null;
    if (!selectedId) {
      selOutline.visible = false;
      setDim(null);                         // ease the rest of the scene back to normal
      if (homePose) {                       // fly back to the user's own overview
        flyTo(homePose.pos, homePose.target, homePose.zoom);
        homePose = null;
      }
      return;
    }
    // first focus from a clear state → remember where to return to
    if (!prev && !homePose) {
      homePose = {
        pos: camera.position.clone(),
        target: controls.target.clone(),
        zoom: camera.zoom,
      };
    }
    frameOutline(selOutline, zones[selectedId - 1].unit, 0.5);
    setDim(selectedId);                     // fade everything except this shelf + its badge
    const lp = landingPoseFor(selectedId);
    flyTo(lp.pos, lp.target, lp.zoom);      // snapshots current pose as `from`
    // selection supersedes hover; the render loop fades the glow out on its own.
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downPos = null;
  const CLICK_SLOP = 6; // px of movement still counted as a click, not an orbit drag

  function pickShelfId(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(zones.map((z) => z.unit), true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && o.userData.shelfId === undefined) o = o.parent;
    return o ? o.userData.shelfId : null;
  }

  function onPointerDown(e) { downPos = { x: e.clientX, y: e.clientY }; }
  function onPointerUp(e) {
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_SLOP;
    downPos = null;
    if (moved) return;                       // orbit gesture, not a selection
    onSelectShelf?.(pickShelfId(e.clientX, e.clientY)); // null → clicked empty space
  }
  // hover: outline the shelf under the cursor (skip the selected one, which
  // already glows) and switch to a pointer cursor to signal it's clickable.
  // size the glow shell to a unit's bounds; the loop animates scale/opacity.
  function setHoverGlow(id) {
    hoverId = id;
    _box.setFromObject(zones[id - 1].unit);
    _box.getSize(_size);
    _box.getCenter(_ctr);
    const pad = 0.35;
    const ud = hoverGlow.userData;
    ud.sx = _size.x + pad; ud.sy = _size.y + pad; ud.sz = _size.z + pad;
    ud.cx = _ctr.x; ud.cy = _ctr.y; ud.cz = _ctr.z;
  }
  function onPointerMove(e) {
    if (downPos) return;                     // mid orbit-drag → no hover feedback
    const id = pickShelfId(e.clientX, e.clientY);
    if (id && id !== selectedId) {
      if (id !== hoverId) setHoverGlow(id);  // recompute bounds only when it changes
      renderer.domElement.style.cursor = 'pointer';
    } else {
      hoverId = null;                        // fades out in the render loop
      renderer.domElement.style.cursor = id ? 'pointer' : '';
    }
  }
  function onPointerLeave() { hoverId = null; renderer.domElement.style.cursor = ''; }
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);

  // ---------- ceiling sensors with scan cones ----------
  const sensors = [];
  function sensor(x, z) {
    const g = new THREE.Group();
    g.add(box(0.6, 0.3, 0.6, mat.metal, 0, 8.4, 0));
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), new THREE.MeshBasicMaterial({ color: 0x9fe6ff }));
    lens.position.set(0, 8.4, 0);
    g.add(lens);
    g.position.set(x, 0, z);
    g.userData = { lens, t: Math.random() * 6 };
    world.add(g);
    sensors.push(g);
  }
  sensor(-3, -8); sensor(6, -3); sensor(-8, 4); sensor(4, 6);

  // ---------- shoppers ----------
  function makeHuman(shirt = 0x4f86d6, pants = 0x2c3550) {
    const h = new THREE.Group();
    const shirtM = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.7 });
    const pantsM = new THREE.MeshStandardMaterial({ color: pants, roughness: 0.8 });

    const body = new THREE.Group();
    body.position.y = 1.5;
    h.add(body);

    body.add(box(0.62, 1.0, 0.38, shirtM, 0, 0.05, 0));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 18, 18), mat.skin);
    head.position.set(0, 0.95, 0); head.castShadow = true;
    body.add(head);
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.27, 18, 18, 0, Math.PI * 2, 0, Math.PI / 1.8),
      new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.9 })
    );
    hair.position.set(0, 1.02, 0);
    body.add(hair);

    function limb(w, len, m, x, y) {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      pivot.add(box(w, len, w, m, 0, -len, 0));
      body.add(pivot);
      return pivot;
    }
    const armL = limb(0.16, 0.82, shirtM, -0.42, 0.45);
    const armR = limb(0.16, 0.82, shirtM, 0.42, 0.45);
    const legL = limb(0.2, 0.85, pantsM, -0.18, -0.5);
    const legR = limb(0.2, 0.85, pantsM, 0.18, -0.5);

    h.userData = { body, armL, armR, legL, legR };
    return h;
  }

  // walking shoppers follow loops through the aisles
  const walkCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 11),
    new THREE.Vector3(-6, 0, 7),
    new THREE.Vector3(-9, 0, 0),
    new THREE.Vector3(-3, 0, -6),
    new THREE.Vector3(4, 0, -7),
    new THREE.Vector3(9, 0, -2),
    new THREE.Vector3(8, 0, 6),
    new THREE.Vector3(4, 0, 11),
  ], true, 'catmullrom', 0.4);

  const walkers = [
    { h: makeHuman(0x4f86d6, 0x2c3550), t: 0.0, speed: 0.04 },
    { h: makeHuman(0xd66a4f, 0x394050), t: 0.4, speed: 0.033 },
    { h: makeHuman(0x5cc28e, 0x2c3550), t: 0.72, speed: 0.046 },
  ];
  walkers.forEach((p) => world.add(p.h));

  // a couple of stationary browsers near shelves
  const idlers = [
    Object.assign(makeHuman(0xc9c9d2, 0x394050), {}),
    makeHuman(0x8e7cc3, 0x2c3550),
  ];
  idlers[0].position.set(-3, 0, -half + 4.2); idlers[0].rotation.y = Math.PI;
  idlers[1].position.set(half - 4, 0, -2); idlers[1].rotation.y = -Math.PI / 2;
  idlers.forEach((h) => world.add(h));

  // ---------- service robot ----------
  function makeRobot() {
    const g = new THREE.Group();
    const shell = new THREE.MeshStandardMaterial({ color: 0xdfe7f2, roughness: 0.35, metalness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x223150, roughness: 0.5, metalness: 0.5 });
    const glow = new THREE.MeshBasicMaterial({ color: ACCENT });

    // wheeled base
    g.add(box(1.1, 0.35, 1.4, dark, 0, 0, 0));
    const wheels = [];
    for (const [wx, wz] of [[-0.5, 0.45], [0.5, 0.45], [-0.5, -0.45], [0.5, -0.45]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 16), mat.tire);
      w.rotation.z = Math.PI / 2; w.position.set(wx, 0.22, wz);
      g.add(w); wheels.push(w);
    }
    // rounded body
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 0.9, 6, 16), shell);
    torso.position.set(0, 1.25, 0); torso.castShadow = true;
    g.add(torso);
    // glowing chest screen
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.5),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.85 }));
    screen.position.set(0, 1.35, 0.5);
    g.add(screen);
    // head
    const headPivot = new THREE.Group();
    headPivot.position.set(0, 1.95, 0);
    g.add(headPivot);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.6), shell);
    head.position.y = 0.2; head.castShadow = true;
    headPivot.add(head);
    // visor + two eye lights
    const visor = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.28),
      new THREE.MeshBasicMaterial({ color: 0x0a1830 }));
    visor.position.set(0, 0.22, 0.31); headPivot.add(visor);
    const eyes = [];
    for (const ex of [-0.13, 0.13]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), glow);
      e.position.set(ex, 0.22, 0.33); headPivot.add(e); eyes.push(e);
    }
    // antenna with beacon
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), dark);
    ant.position.set(0, 0.55, 0); headPivot.add(ant);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), glow);
    beacon.position.set(0, 0.72, 0); headPivot.add(beacon);

    g.userData = { wheels, headPivot, eyes, beacon, screen };
    return g;
  }

  // ---------- robot navigation network (graph of aisle waypoints) ----------
  // Hand-authored nodes sit in the aisles around every shelf; edges connect them
  // into one network with loops around the free-standing gondolas. The service
  // robot walks this graph live, choosing the least-recently-used edge at each
  // junction so it eventually covers every aisle.
  const NODES = [
    [-10, -11.5], //  0  shelf 01 front-left
    [  4, -11.5], //  1  shelf 01 front-right
    [  9, -11.5], //  2  NE corner
    [ 11.2, -6 ], //  3  shelf 03 top
    [ 11.2,  1 ], //  4  shelf 03 mid
    [ 11.2, 6.5], //  5  shelf 03 bottom
    [-3.3, -1.2], //  6  gondola 02 front-left
    [  4, -1.2 ], //  7  gondola 02 front-mid
    [  9, -1.2 ], //  8  gondola 02 front-right
    [-3.3,  2.7], //  9  gondola 02 back-left
    [  9,  2.7 ], // 10  gondola 02 back-right
    [-3.7,  2.7], // 11  gondola 04 front-right
    [-13.5, 2.7], // 12  gondola 04 front-left
    [-13.5, 6  ], // 13  gondola 04 back-left
    [-3.7,  6  ], // 14  gondola 04 back-right
    [  4,  7   ], // 15  checkout hub
    [-4.3, 6   ], // 16  gondola 05 bottom-right
    [ -8,  6   ], // 17  gondola 05 bottom-left
    [ -8, 14   ], // 18  gondola 05 top-left
    [-4.3,14   ], // 19  gondola 05 top-right
  ];
  const EDGES = [
    [0, 1], [1, 2], [1, 7], [2, 3], [3, 4], [4, 5], [4, 8],
    [6, 7], [7, 8], [6, 9], [8, 10], [9, 10], [9, 11], [11, 12],
    [12, 13], [13, 14], [14, 11], [5, 15], [15, 14], [14, 16],
    [16, 17], [17, 18], [18, 19], [19, 16],
  ];

  const EDGE_Y = 0.06;
  const EDGE_BASE_OPACITY = 0.28;

  // adjacency: node -> [{ to, edge }]
  const adj = NODES.map(() => []);
  EDGES.forEach(([a, b], ei) => {
    adj[a].push({ to: b, edge: ei });
    adj[b].push({ to: a, edge: ei });
  });
  function edgeBetween(a, b) {
    for (const e of adj[a]) if (e.to === b) return e.edge;
    return -1;
  }

  // draw every edge as a flat glowing strip (own material → per-edge visited glow)
  const edgeObjs = EDGES.map(([a, b]) => {
    const va = new THREE.Vector3(NODES[a][0], EDGE_Y, NODES[a][1]);
    const vb = new THREE.Vector3(NODES[b][0], EDGE_Y, NODES[b][1]);
    const geo = new THREE.TubeGeometry(new THREE.LineCurve3(va, vb), 1, 0.1, 6, false);
    const m = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: EDGE_BASE_OPACITY });
    const mesh = new THREE.Mesh(geo, m);
    mesh.scale.y = 0.28; // flatten onto the floor
    world.add(mesh);
    return { mesh, mat: m, lastVisited: -999 };
  });

  // pulsing dots mark the junctions so the network reads as connected
  const nodeDots = NODES.map(([x, z]) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x9fe6ff, transparent: true, opacity: 0.9 })
    );
    m.position.set(x, EDGE_Y + 0.06, z);
    m.userData.t = Math.random() * Math.PI * 2;
    world.add(m);
    return m;
  });

  // ---------- service robot: live graph traversal ----------
  const robot = { g: makeRobot(), speed: 3.4 };
  world.add(robot.g);

  const _na = new THREE.Vector3();
  const _nb = new THREE.Vector3();
  function nodeVec(i, out) { return out.set(NODES[i][0], 0, NODES[i][1]); }
  function headingYaw(from, to) {
    return Math.atan2(NODES[to][0] - NODES[from][0], NODES[to][1] - NODES[from][1]);
  }
  function shortestLerp(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }
  // at a junction take the least-recently-used edge; never reverse unless dead-end
  function chooseNext(at, cameFrom) {
    let cand = adj[at].filter((o) => o.to !== cameFrom);
    if (cand.length === 0) cand = adj[at];
    cand.sort((p, q) => edgeObjs[p.edge].lastVisited - edgeObjs[q.edge].lastVisited);
    return cand[0].to;
  }

  const TURN_TIME = 0.32;
  const nav = {
    from: 0, to: 1, u: 0, mode: 'travel', next: 1,
    yaw: headingYaw(0, 1), startYaw: 0, targetYaw: 0, turnT: 0,
  };
  robot.g.rotation.y = nav.yaw;

  // ---------- focus dimming: isolate the selected shelf ----------
  // Structural materials are shared across shelves, so first give every zone its
  // own material instances — only then can we fade everything *except* the
  // focused zone without dragging the focused shelf down with it.
  zones.forEach((zn) => {
    const cache = new Map();
    const swap = (m) => {
      let cl = cache.get(m);
      if (!cl) { cl = m.clone(); cache.set(m, cl); }
      return cl;
    };
    zn.unit.traverse((o) => {
      if (!o.material) return;
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
  });

  // registry of every fadeable material tagged with the shelf it belongs to
  // (0 = furniture / shoppers / paths — always fades once a shelf is focused).
  const DIM_FLOOR = 0.2;         // "others" darken to ~20% brightness (color + glow)
  const dimSkip = new Set([selOutline, hoverGlow]);
  const dimReg = [];
  scene.traverse((o) => {
    if (dimSkip.has(o) || !o.material) return;
    let zoneId = 0;
    for (let p = o; p; p = p.parent) {
      if (p.userData && p.userData.shelfId !== undefined) { zoneId = p.userData.shelfId; break; }
    }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    // remember each material's full-brightness color + glow so we can lerp it
    // toward black (and back) without ever touching opacity / transparency.
    for (const m of mats) {
      dimReg.push({
        m, zoneId,
        color: m.color ? m.color.clone() : null,
        emissive: m.emissive ? m.emissive.clone() : null,
      });
    }
  });

  // a 0.9s tween (matching the camera fly) drives dim.value 0→1 on focus and back
  // on release; dimFocus stays latched through the fade-out so the right shelf
  // keeps its brightness while everything else eases back to normal.
  const DIM_DUR = FLY_DUR;
  const dim = { active: false, t: 0, from: 0, to: 0, value: 0 };
  let dimFocus = null;
  function applyDim(v) {
    for (const e of dimReg) {
      const f = e.zoneId !== dimFocus ? 1 - (1 - DIM_FLOOR) * v : 1; // furniture (0) is always "other"
      if (e.color) e.m.color.copy(e.color).multiplyScalar(f);
      if (e.emissive) e.m.emissive.copy(e.emissive).multiplyScalar(f);
    }
  }
  function setDim(focusId) {
    if (focusId) dimFocus = focusId;              // keep the latch on release for a clean fade-out
    dim.from = dim.value;
    dim.to = focusId ? 1 : 0;
    dim.t = 0;
    dim.active = true;
  }

  // ---------- bloom ----------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.55, 0.5, 0.25));
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
    u.body.position.y = 1.5 + Math.abs(Math.sin(phase)) * 0.06;
  }

  function animate() {
    rafId = requestAnimationFrame(animate);
    const time = clock.elapsedTime;
    const dt = clock.getDelta();

    walkers.forEach((p) => walk(p, time));

    // drive the robot along the aisle network (live graph traversal)
    {
      const u = robot.g.userData;
      if (nav.mode === 'travel') {
        nodeVec(nav.from, _na); nodeVec(nav.to, _nb);
        const segLen = _na.distanceTo(_nb) || 1;
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
        _na.lerp(_nb, nav.u);
        robot.g.position.set(_na.x, 0, _na.z);
        robot.g.rotation.y = nav.yaw;
        u.wheels.forEach((w) => { w.rotation.x += robot.speed * dt * 2.4; });
      } else { // turn: stop at the junction, rotate toward the next edge, then go
        nav.turnT += dt;
        const t = Math.min(1, nav.turnT / TURN_TIME);
        nav.yaw = shortestLerp(nav.startYaw, nav.targetYaw, t);
        robot.g.rotation.y = nav.yaw;
        if (t >= 1) {
          nav.yaw = nav.targetYaw;
          nav.from = nav.to; nav.to = nav.next; nav.u = 0;
          nav.mode = 'travel';
        }
      }
      u.headPivot.rotation.y = Math.sin(time * 0.8) * 0.5;       // scanning the aisles
      const pulse = 0.6 + Math.abs(Math.sin(time * 3)) * 0.4;
      u.beacon.scale.setScalar(0.7 + pulse);
      u.eyes.forEach((e) => e.scale.setScalar(pulse));
      u.screen.material.opacity = 0.6 + Math.sin(time * 5) * 0.2;
    }

    // visited glow: edges the robot just used flare up, then fade back
    for (const e of edgeObjs) {
      const glow = Math.max(0, 1 - (time - e.lastVisited) / 3);
      e.mat.opacity = EDGE_BASE_OPACITY + glow * 0.6;
    }
    // pulse the junction dots
    for (const d of nodeDots) {
      d.scale.setScalar(1 + Math.sin(time * 3 + d.userData.t) * 0.3);
    }

    // gentle idle sway for browsers
    idlers.forEach((h, i) => {
      h.userData.body.rotation.z = Math.sin(time * 1.2 + i) * 0.03;
    });

    // bob the floating badges
    badges.forEach((b) => {
      b.position.y = b.userData.base + Math.sin(time * 1.5 + b.userData.t) * 0.18;
    });

    for (const sn of sensors) {
      sn.userData.lens.scale.setScalar(1 + Math.sin(time * 4 + sn.userData.t) * 0.4);
    }

    if (selOutline.visible) selOutline.material.opacity = 0.7 + Math.sin(time * 5) * 0.25;

    // hover glow shell: ease opacity + a subtle scale toward the hovered shelf
    {
      const target = (hoverId && hoverId !== selectedId) ? 1 : 0;
      hoverProgress += (target - hoverProgress) * Math.min(1, dt * 12);
      if (target === 0 && hoverProgress < 0.01) {
        hoverGlow.visible = false;
      } else {
        const ud = hoverGlow.userData;
        const s = 0.97 + 0.03 * hoverProgress;
        hoverGlow.visible = true;
        hoverGlow.scale.set(ud.sx * s, ud.sy * s, ud.sz * s);
        hoverGlow.position.set(ud.cx, ud.cy, ud.cz);
        hoverGlow.material.opacity = 0.26 * hoverProgress;
      }
    }

    // focus dimming tween: fade the rest of the scene in step with the fly.
    if (dim.active) {
      dim.t += dt / DIM_DUR;
      const e = easeInOutCubic(Math.min(1, dim.t));
      dim.value = dim.from + (dim.to - dim.from) * e;
      applyDim(dim.value);
      if (dim.t >= 1) {
        dim.active = false;
        if (dim.to === 0) dimFocus = null;  // fully restored — drop the latch
      }
    }

    // camera fly-to tween: drive pose ourselves, skip controls.update() so its
    // damping doesn't fight us; hand control back to OrbitControls on landing.
    if (fly.active) {
      fly.t += dt / FLY_DUR;
      const e = easeInOutCubic(Math.min(1, fly.t));
      camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
      controls.target.lerpVectors(fly.fromTgt, fly.toTgt, e);
      camera.zoom = fly.fromZoom + (fly.toZoom - fly.fromZoom) * e;
      camera.updateProjectionMatrix();
      camera.lookAt(controls.target);
      if (fly.t >= 1) { fly.active = false; controls.enabled = true; }
    } else {
      controls.update();
    }
    composer.render();
  }

  // ---------- resize ----------
  function resize() {
    width = container.clientWidth || window.innerWidth;
    height = container.clientHeight || window.innerHeight;
    if (width === 0 || height === 0) return;
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
  function dispose() {
    cancelAnimationFrame(rafId);
    ro.disconnect();
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
    controls.dispose();
    composer.dispose();
    renderer.dispose();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const m = Array.isArray(o.material) ? o.material : [o.material];
        m.forEach((mm) => { if (mm.map) mm.map.dispose(); mm.dispose(); });
      }
    });
    if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
  }

  const controller = { dispose, selectShelf };
  if (typeof window !== 'undefined') window.__store = controller; // debug handle
  return controller;
}
