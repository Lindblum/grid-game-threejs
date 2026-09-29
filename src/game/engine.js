import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { STEP_FRACTION, World } from './world.js';
import { canStand, stepSquirmies, stepSight, stepNimbus, stepCrawlies, stepDirt, stepGroups, stepRain, stepWater, stepFog, stepFogForm, stepNimbusDrift, stepWood, updateBlockBundles, creatureEatNearby, SELECT_WAIT_TURNS } from './sim.js';
import { BLOCK, BLOCK_COLORS, TOOL, TOOLS, isCreature } from './tools.js';
import { getLogs, getLogVersion } from './debugLog.js';
import { BEHAVIOR, BUFF_TYPES, blockProps, canFly, canWalkOn, describeBuff, isSingleCreature } from './blocks.js';
import { SELECT_GREEN } from './icons.js';
import { faceFromNormal, isValidCell } from './lattice.js';
import { EDGE_SHADE, EDGE_WIDTH_CM, truncatedOctahedronFaces } from './geometry.js';
import {
  playPlace, playDelete, playTick, playResume, playLoad, playSave, playError, unlockAudio, setMuted,
  playReady, playGo, playBerryGrow, playSfx, playWait, playAssign, playCrawlyDone, playCrawlyTrapped, playCrawlyDeath,
} from './audio.js';
import { LeftHudPanel, RightHudPanel, MenuPanel, DebugTablet } from './xrPanels.js';
import { menuModel, displayName, PAGE_SIZE, SPEED } from './menu.js';
import { loadOptionsCookie, saveOptionsCookie } from './optionsCookie.js';
import { listSaves, readSave, writeSave, normalizeSaveName, timestampName } from './saves.js';

const CM = 0.01; // world units are metres; lattice units are cm
const FPS_WINDOW_MS = 500; // Debug → Performance: FPS is averaged over this long
const COUNTDOWN_SECONDS = 3; // the page, New and Load all start with a T -3 … 0 countdown before play
const BLOCK_VOLUME_CM3 = 4; // space per block: the lattice packs two blocks into every 2 cm cube
const XR_RAY_LENGTH = 1.0; // 1 m
const DESKTOP_RAY_LENGTH = 50;
const WHEEL_TOOL_REARM_MS = 200; // horizontal-scroll tool switching: quiet gap that ends one push
const BG = new THREE.Color('#1b2029');
const ORBIT_HEIGHT_CM = 100; // light 1 m above the scene
const ORBIT_RADIUS_CM = 300; // 3 m radius
const ORBIT_PERIOD_S = 60; // one revolution per minute
const GRAB_MIN_SCALE = 0.1; // two-hand zoom limits, relative to life size (1 lattice cm = 1 cm)
const GRAB_MAX_SCALE = 20;
// Browser camera vs blocks: closer than CAMERA_PUSH_WITHIN_CM to the nearest block centre, the
// camera is pushed straight away from it, at least CAMERA_PUSH_TO_CM and on into a clear cell.
const FLY_M_PER_WHEEL_PX = 0.00005; // zoomed all the way in, scrolling flies forward: ~0.5 cm per wheel notch
const FLY_M_PER_PAD_S = 0.08; // …and the gamepad's left stick flies up to 8 cm/s
// Select tool wireframes (selected / pointed-at creatures, the target cell and its pulses): tubes
// no thicker than the blocks' own face outlines.
const SELECT_WIRE_RADIUS = EDGE_WIDTH_CM / 2;
const CAMERA_PUSH_WITHIN_CM = 1.25;
const CAMERA_PUSH_TO_CM = 1.5;
/** The lattice cell containing point p (cm): the all-even or all-odd cell centre nearest to it. */
function nearestLatticeCell(p) {
  const even = [p.x, p.y, p.z].map((v) => 2 * Math.round(v / 2));
  const odd = [p.x, p.y, p.z].map((v) => 2 * Math.round((v - 1) / 2) + 1);
  const d2 = (c) => (c[0] - p.x) ** 2 + (c[1] - p.y) ** 2 + (c[2] - p.z) ** 2;
  return d2(even) <= d2(odd) ? even : odd;
}
const START_CAMERA = new THREE.Vector3(0.22, 0.26, 0.4).normalize().multiplyScalar(0.5); // 50 cm from origin

/** Thick wireframe of a truncated octahedron made from thin cylinders (visible in XR too). */
function makeWireframe(color, radiusCm) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
  group.userData.material = mat;
  const seen = new Set();
  const up = new THREE.Vector3(0, 1, 0);
  const cyl = new THREE.CylinderGeometry(radiusCm, radiusCm, 1, 6, 1, true);
  const ball = new THREE.SphereGeometry(radiusCm, 8, 6);
  const verts = new Map();
  for (const f of truncatedOctahedronFaces()) {
    for (let i = 0; i < f.verts.length; i++) {
      const a = f.verts[i], b = f.verts[(i + 1) % f.verts.length];
      const ka = a.toArray().join(','), kb = b.toArray().join(',');
      verts.set(ka, a);
      const k = [ka, kb].sort().join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      const m = new THREE.Mesh(cyl, mat);
      const d = b.clone().sub(a);
      m.position.copy(a).addScaledVector(d, 0.5);
      m.scale.set(1, d.length(), 1);
      m.quaternion.setFromUnitVectors(up, d.normalize());
      group.add(m);
    }
  }
  for (const v of verts.values()) {
    const s = new THREE.Mesh(ball, mat);
    s.position.copy(v);
    group.add(s);
  }
  group.visible = false;
  return group;
}

export class Engine {
  constructor(container) {
    this.container = container;
    this.listeners = new Set();
    this.state = {
      screen: 'playing',
      paused: false, // the game opens straight into a New scene, with a countdown
      menu: 'main', // 'main' | 'load' | 'save' | 'options'
      soundOn: true,
      gameTime: -COUNTDOWN_SECONDS, // whole seconds (turns) since New / Load; negative = countdown
      passthrough: true, // Options → Background: XR passthrough (true) or solid colour
      proceduralMaterials: true, // Options → Materials: procedural shaders (true) or solid colours
      outlines: true, // Options → Outlines: darkened face edges on blocks
      ambientOcclusion: true, // Options → Ambient Occlusion: darker corners between blocks
      speed: SPEED.default, // Options → Speed: turns per minute (sets the turn and animation length)
      rain: true, // Options → Rain: random raindrops appear 1 m out every 10th turn
      fog: true, // Options → Fog: Fog recipe steps in New scenes, and Fog forming far out
      debugMode: false, // Options → Debug: debug panel (HUD / XR tablet)
      smoothRendering: false, // Options → Rendering: Smooth (BlockBundles drawn as merged, smoothed bodies) or Blocky (default)
      saves: null,
      savesError: null,
      page: 0,
      toolIndex: 0,
      inXR: false,
      xrSupport: null, // truthy when this browser can start XR at all
      xrAR: false, // browser supports immersive-ar (passthrough), e.g. Quest Browser
      xrVR: false, // browser supports immersive-vr, e.g. PC Chrome with a headset over Link
      blockCount: 0,
      blockCounts: {}, // block type -> how many are in the world (tool labels: "Stone (x100)")
      toast: null,
      gamepadAim: false, // aiming with a gamepad (crosshair at screen centre)
      menuFocus: null, // id of the menu item focused with the gamepad
      selectPhase: 'select', // Select tool: 'select' (pick a Crawly) or 'target' (pick where it walks)
    };
    this._toastId = 0;
    this.turnSeconds = 60 / SPEED.default;
    this.mouse = null;
    this.target = null;
    this.hands = { left: null, right: null };
    this._stickArmed = true;
    this._leftMenuWas = false;
    this._menuHover = null;
    this._hudHover = null;
    this._xrFrames = 0;
    this._grab = null;
    this.selected = []; // Select tool: the selected Crawlies (currently at most one)
    this._pulses = []; // Select tool: shrinking copies of the target wireframe, one per turn

    this._initRenderer();
    this._initScene();
    this._initXR();
    this._bindEvents();
    this._detectXR();
    this._applyOptions(loadOptionsCookie()); // Options saved last time (cookie), if any

    this.world.generateNew();
    this._syncCount();
    this._clock = 0;
    playReady(); // T -3 (silent until the page has had a click or key press: browser audio policy)
    this.renderer.setAnimationLoop(this._tick);
  }

  // ---------------------------------------------------------------- state
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;
  setState(patch) {
    const inOptions = (s) => s.paused && (s.menu === 'options' || s.menu === 'controls');
    const wasInOptions = inOptions(this.state);
    this.state = { ...this.state, ...patch };
    if (wasInOptions && !inOptions(this.state)) this._saveOptions(); // left Options (Back, Esc, Resume, …)
    for (const fn of this.listeners) fn();
  }

  /** The settings the Options menu controls, as saved to the options cookie. */
  static OPTION_KEYS = ['soundOn', 'passthrough', 'proceduralMaterials', 'outlines', 'ambientOcclusion', 'speed', 'rain', 'fog', 'debugMode', 'smoothRendering'];

  _saveOptions() {
    saveOptionsCookie(Object.fromEntries(Engine.OPTION_KEYS.map((k) => [k, this.state[k]])));
  }

  /**
   * Applies saved Options settings (from the cookie): each one sets the state and does what
   * its menu item does (mutes audio, recompiles materials, sets shader uniforms, …). Unknown
   * or wrongly-typed values are ignored, so an old or damaged cookie can't break anything.
   */
  _applyOptions(saved) {
    if (!saved) return;
    const bool = (k) => typeof saved[k] === 'boolean';
    if (bool('soundOn')) {
      setMuted(!saved.soundOn);
      this.setState({ soundOn: saved.soundOn });
    }
    if (bool('passthrough')) {
      this.setState({ passthrough: saved.passthrough });
      this._applyBackground();
    }
    if (bool('proceduralMaterials')) {
      this.world.materials.setProcedural(saved.proceduralMaterials);
      this.setState({ proceduralMaterials: saved.proceduralMaterials });
    }
    if (bool('outlines')) {
      this.world.materials.uniforms.uOutlines.value = saved.outlines ? 1 : 0;
      this.setState({ outlines: saved.outlines });
    }
    if (bool('ambientOcclusion')) {
      this.world.materials.uniforms.uAO.value = saved.ambientOcclusion ? 1 : 0;
      this.setState({ ambientOcclusion: saved.ambientOcclusion });
    }
    if (typeof saved.speed === 'number') this.setSpeed(saved.speed);
    for (const k of ['rain', 'debugMode', 'smoothRendering']) if (bool(k)) this.setState({ [k]: saved[k] });
    if (bool('smoothRendering')) this.world.setSmoothRendering(saved.smoothRendering);
    if (bool('fog')) this.setFog(saved.fog);
  }
  toast(text, kind = 'info') {
    if (kind === 'error') playError();
    this.setState({ toast: { text, kind, id: ++this._toastId } });
    this._hudMessage = { text, until: performance.now() + 2200 };
  }
  /**
   * One line in the console (and so the debug panel's log) for a game event:
   * "[turn 42] consume | Crawly #17 | size 1 | ate Berry". The index is the block's instance
   * index, the size its BlockBundle's (a Squirmy's length, a tree's Wood count, …).
   */
  _logEvent(kind, block, detail) {
    const inWorld = this.world.get(block.x, block.y, block.z) === block;
    const size = inWorld ? this.world.bundleOf(block).length : 1;
    console.log(` | Turn ${this.world.turn} | ${blockProps(block.type).name} #${block.index} | size ${size} | ${kind} | ${detail}`);
  }

  /** Refreshes the HUD's block totals (overall, and per type for the tool labels). */
  _syncCount() {
    const counts = {};
    for (const b of this.world.blocks.values()) counts[b.type] = (counts[b.type] || 0) + 1;
    const prev = this.state.blockCounts;
    const same = this.state.blockCount === this.world.size &&
      Object.keys(counts).length === Object.keys(prev).length && Object.keys(counts).every((k) => prev[k] === counts[k]);
    if (!same) this.setState({ blockCount: this.world.size, blockCounts: counts });
  }

  // ---------------------------------------------------------------- setup
  _initRenderer() {
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setClearColor(0x000000, 0);
    r.xr.enabled = true;
    r.domElement.className = 'game-canvas';
    this.container.appendChild(r.domElement);
    this.renderer = r;
  }

  _initScene() {
    const scene = new THREE.Scene();
    scene.background = BG;
    this.scene = scene;

    const cam = new THREE.PerspectiveCamera(60, 1, 0.005, 100);
    cam.position.copy(START_CAMERA);
    this.camera = cam;
    scene.add(cam);

    const controls = new OrbitControls(cam, this.renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 0.04;
    controls.maxDistance = 4;
    controls.zoomSpeed = 0.8;
    controls.autoRotateSpeed = 0.8;
    controls.update();
    this.controls = controls;

    scene.add(new THREE.HemisphereLight(0xffff80, 0x404080, 0.25));
    const fill = new THREE.DirectionalLight(0xffff80, 1);
    fill.position.set(-1, -0.4, -0.6);
    scene.add(fill);

    // All lattice content lives in worldRoot (units: cm).
    const root = new THREE.Group();
    root.name = 'worldRoot';
    root.scale.setScalar(CM);
    scene.add(root);
    this.worldRoot = root;
    this.world = new World(root);
    // sounds for things the simulation does on its own
    this.world.on('berryGrow', () => playBerryGrow());
    this.world.on('crawlyArrived', () => playCrawlyDone());
    this.world.on('crawlyTrapped', () => playCrawlyTrapped());
    this.world.on('blockConsumed', ({ sound }) => playSfx(sound));
    this.world.on('blockExcreted', ({ sound }) => playSfx(sound));
    // event log (console, so it also shows in the debug panel): consume, excrete, buffs, behavior
    const nameOf = (type) => blockProps(type).name;
    this.world.on('blockConsumed', ({ by, block }) => this._logEvent('consume', by, `ate ${nameOf(block.type)}`));
    this.world.on('blockExcreted', ({ by, block }) => this._logEvent('excrete', by, `excreted ${nameOf(block.type)}`));
    this.world.on('buffAdded', ({ block, buff, refreshed }) => this._logEvent('buff', block, `${refreshed ? 'refreshed' : 'gained'} ${describeBuff(buff)}`));
    this.world.on('buffChargeUsed', ({ block, type, charges }) =>
      this._logEvent('buff', block, `used a ${BUFF_TYPES[type]?.name ?? type} charge (${charges} left)`));
    this.world.on('buffExpired', ({ block, type }) => this._logEvent('buff', block, `${BUFF_TYPES[type]?.name ?? type} wore off`));
    this.world.on('behaviorChanged', ({ block, from, to }) => this._logEvent('behavior', block, `${from} → ${to}`));
    this.world.on('blockBlown', ({ sound }) => playSfx(sound, 250)); // many clouds at once: one breeze
    this.world.on('blockVanished', () => this._syncCount());
    this.world.on('crawlyFreed', () => playCrawlyDone()); // same "made it" sound as arriving
    this.world.on('crawlyDied', () => {
      playCrawlyDeath();
      this._syncCount(); // its block is gone
    });

    // Revolving light: 1 m above the origin, 1 m radius, clockwise seen from above, 1 min per turn.
    // It lives in worldRoot (cm units), so it follows the build when it is moved in XR.
    this.orbitLight = new THREE.PointLight(0xfff4e0, 2.6, 0, 0); // decay 0: no distance falloff
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff4e0, toneMapped: false })
    );
    this.orbitLight.add(bulb);
    root.add(this.orbitLight);
    this._updateOrbitLight(0);

    this.placeHL = makeWireframe('#c9ccd1', 0.035);
    this.deleteHL = makeWireframe('#ff2b2b', 0.045);
    this.deleteHL.scale.setScalar(1.05);
    root.add(this.placeHL, this.deleteHL);
    // Select tool: green wireframes around selected Crawlies, a lighter one around a Crawly
    // you could select, and the target-cell indicator (plus its per-turn shrinking copies)
    this.selectHLs = [];
    this.hoverHLs = []; // light green, around every block of a creature you could select
    this._hoverCreature = null;
    this.targetHL = makeWireframe(SELECT_GREEN, SELECT_WIRE_RADIUS);
    root.add(this.targetHL);

    // Small origin marker so an empty world still has a reference point.
    const originDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 12, 8),
      new THREE.MeshBasicMaterial({ color: '#5b6577' })
    );
    root.add(originDot);

    this.raycaster = new THREE.Raycaster();
  }

  _initXR() {
    const r = this.renderer;
    const factory = new XRControllerModelFactory();

    // Pointer ray (gray line) for the right controller.
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    this.rayLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: '#b5b8bd', toneMapped: false }));
    this.rayLine.scale.z = XR_RAY_LENGTH;
    this.rayDot = new THREE.Mesh(new THREE.SphereGeometry(0.003, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    this.rayDot.visible = false;

    this.leftHud = new LeftHudPanel();
    this.rightHud = new RightHudPanel();
    this.menuPanel = new MenuPanel();
    this.menuPanel.mesh.visible = false;
    this.scene.add(this.menuPanel.mesh);
    this.debugTablet = new DebugTablet(); // Options → Debug, in XR
    this.scene.add(this.debugTablet.mesh);
    this._tabletGrab = null; // { slot, offset: Matrix4 } while a grip holds the tablet
    this._tabletHover = false; // right controller ray is on the tablet

    for (let i = 0; i < 2; i++) {
      const ctrl = r.xr.getController(i);
      const grip = r.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      const slot = { ctrl, grip, source: null, gripHeld: false };
      ctrl.addEventListener('connected', (e) => {
        if (e.data.hand) return; // ignore articulated hands
        slot.source = e.data;
        const hand = e.data.handedness === 'left' ? 'left' : 'right';
        this.hands[hand] = slot;
        if (hand === 'right') {
          ctrl.add(this.rayLine);
          grip.add(this.rightHud.mesh);
          this.scene.add(this.rayDot);
        } else {
          grip.add(this.leftHud.mesh);
        }
      });
      ctrl.addEventListener('disconnected', () => {
        for (const h of ['left', 'right']) if (this.hands[h] === slot) this.hands[h] = null;
        if (this.rayLine.parent === ctrl) ctrl.remove(this.rayLine);
        for (const hud of [this.leftHud, this.rightHud]) if (hud.mesh.parent === grip) grip.remove(hud.mesh);
        slot.source = null;
        slot.gripHeld = false;
        this._beginGrab();
      });
      ctrl.addEventListener('selectstart', () => {
        if (this.hands.right === slot) this._onRightTrigger();
      });
      ctrl.addEventListener('selectend', () => {
        if (this.hands.right === slot) this._sliderDrag = null;
      });
      // Grips: one hand drags the build, both hands rotate + scale it (Tilt Brush style).
      // A grip near the debug tablet (or the right grip while its ray is on it) moves the tablet instead.
      ctrl.addEventListener('squeezestart', () => {
        if (this._tryGrabTablet(slot)) return;
        slot.gripHeld = true;
        this._beginGrab();
      });
      ctrl.addEventListener('squeezeend', () => {
        if (this._tabletGrab?.slot === slot) this._tabletGrab = null;
        slot.gripHeld = false;
        this._beginGrab();
      });
      this.scene.add(ctrl, grip);
    }
  }

  async _detectXR() {
    if (!navigator.xr) return;
    const check = async (mode) => {
      try {
        return await navigator.xr.isSessionSupported(mode);
      } catch {
        return false;
      }
    };
    const [ar, vr] = await Promise.all([check('immersive-ar'), check('immersive-vr')]);
    this.setState({ xrAR: ar, xrVR: vr, xrSupport: ar || vr ? (ar ? 'immersive-ar' : 'immersive-vr') : null });
  }

  _bindEvents() {
    const el = this.renderer.domElement;
    this._onResize = () => {
      if (this.renderer.xr.isPresenting) return;
      const w = this.container.clientWidth || window.innerWidth;
      const h = this.container.clientHeight || window.innerHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    this._ro = new ResizeObserver(this._onResize);
    this._ro.observe(this.container);
    this._onResize();

    this._onPointerMove = (e) => {
      const rect = el.getBoundingClientRect();
      this.mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      if (this.state.gamepadAim || this.state.menuFocus) this.setState({ gamepadAim: false, menuFocus: null });
    };
    this._onPointerLeave = () => (this.mouse = null);
    this._onPointerDown = (e) => {
      unlockAudio();
      if (e.button !== 0) return;
      this._onPointerMove(e);
      // the dimmed backdrop lets clicks through to the canvas: a click beside the pause
      // panel resumes the game (without also using the tool)
      if (this.isMenuOpen() && !this.state.inXR) return this.resume();
      if (this.state.screen === 'playing' && !this.state.paused && !this.state.inXR) {
        this._updateTarget();
        this.useTool();
      }
    };
    this._onContextMenu = (e) => e.preventDefault();
    this._onKeyDown = (e) => this._handleKey(e);
    // Horizontal scroll switches tools. In the Quest Browser's window mode the Touch
    // thumbstick scrolls instead of appearing as a gamepad, so pushing it left/right
    // arrives here. One step per push: re-armed once no sideways scroll has come in for
    // WHEEL_TOOL_REARM_MS (the stick went back to centre).
    this._onWheel = (e) => {
      // scrolling in once the zoom limit is reached flies forward instead (see _flyForward)
      if (e.deltaY < 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX) && !this.state.inXR) {
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1; // lines / pages -> px
        this._flyForward(-e.deltaY * unit * FLY_M_PER_WHEEL_PX);
        return;
      }
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 1) return;
      e.preventDefault();
      const now = performance.now();
      const armed = now - (this._wheelToolLast ?? -Infinity) > WHEEL_TOOL_REARM_MS;
      this._wheelToolLast = now;
      if (armed && this.state.screen === 'playing' && !this.state.paused && !this.state.inXR) {
        this.cycleTool(e.deltaX > 0 ? 1 : -1);
      }
    };

    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('pointerleave', this._onPointerLeave);
    el.addEventListener('pointerdown', this._onPointerDown);
    el.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('keydown', this._onKeyDown);
  }

  _handleKey(e) {
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    if (typing && e.key !== 'Escape') return;
    const s = this.state;
    if (s.screen !== 'playing') return;
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      if (!s.paused) this.pause();
      else if (s.menu !== 'main') this.menuAction('back');
      else this.resume();
      return;
    }
    if (s.paused) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.cycleTool(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.cycleTool(-1);
    } else if (/^[0-9]$/.test(e.key)) {
      const i = e.key === '0' ? 9 : Number(e.key) - 1; // 1–9 = tools 1–9, 0 = tool 10
      if (i < TOOLS.length) this.selectTool(i);
    }
  }

  // ---------------------------------------------------------------- game actions
  isMenuOpen(s = this.state) {
    return s.screen === 'playing' && s.paused;
  }

  _startPlaying() {
    unlockAudio();
    this.setState({ screen: 'playing', paused: false, menu: 'main' });
  }

  /** The HUD Menu button: open the pause menu, or close it again. */
  toggleMenu() {
    if (this.state.screen !== 'playing') return;
    if (this.state.paused) this.resume();
    else this.pause();
  }

  pause() {
    if (this.state.screen !== 'playing') return;
    this.setState({ paused: true, menu: 'main', page: 0, menuFocus: this.state.gamepadAim ? 'resume' : null });
    if (this.renderer.xr.isPresenting) this._placeMenuPanel();
    playTick();
  }

  resume() {
    if (this.state.screen !== 'playing') return;
    this.setState({ paused: false, menu: 'main' });
    playResume();
  }

  cycleTool(dir) {
    const n = TOOLS.length;
    this.selectTool((this.state.toolIndex + dir + n) % n);
  }

  selectTool(i) {
    if (i === this.state.toolIndex) return;
    if (TOOLS[this.state.toolIndex].id === TOOL.SELECT) this._setSelected([]); // leaving Select drops the selection
    this.setState({ toolIndex: i });
    this._hudMessage = null;
    playTick();
  }

  /** Tools can be used once the opening countdown has finished (game time >= 0). */
  toolsReady(s = this.state) {
    return s.gameTime >= 0;
  }

  useTool() {
    if (!this.toolsReady()) return false;
    const tool = TOOLS[this.state.toolIndex];
    const t = this.target;
    if (tool.id === TOOL.SELECT) return this._useSelect(t);
    if (!t) return false;
    let ok = false;
    if (tool.block && t.place && t.placeFree) {
      ok = this.world.add(t.place[0], t.place[1], t.place[2], tool.block);
      if (ok) playPlace();
    } else if (tool.id === TOOL.DELETE && t.block) {
      ok = this.world.remove(t.block.x, t.block.y, t.block.z);
      if (ok) playDelete();
    }
    if (ok) {
      this._syncCount();
      this._pulse(0.35, 25);
    }
    return ok;
  }

  // ---------------------------------------------------------------- Select tool
  // Two phases: 'select' (click a Crawly to select it) and 'target' (click an empty cell on
  // a surface the creature can walk on: it Walks there and stays selected, so it can be sent
  // on again; clicking empty space or anything else deselects it).
  // Clicking anything else in 'target' (or empty space) just clears the selection.

  /** HUD label for the current tool (the Select tool shows its phase). */
  toolLabel(s = this.state) {
    const tool = TOOLS[s.toolIndex];
    if (tool.block) return `${tool.label} (x${s.blockCounts[tool.block] ?? 0})`; // e.g. "Stone (x100)"
    if (tool.id !== TOOL.SELECT) return tool.label;
    return s.selectPhase === 'target' ? 'Select: pick a target' : 'Select';
  }

  /**
   * Debug panel content: properties of the selected Crawly, or else of the block under the
   * pointer. Returns { title, rows: [[key, value]] }.
   */
  debugInfo() {
    const sel = this.selected[0];
    const b = sel ?? this.target?.block ?? null;
    if (!b) return { title: 'Nothing selected or targeted', rows: [] };
    const fmt = (v) => (Array.isArray(v) ? `[${v.join(', ')}]` : v && typeof v === 'object' ? `[${v.x}, ${v.y}, ${v.z}]` : String(v));
    const name = TOOLS.find((t) => t.block === b.type)?.label ?? b.type;
    const rows = [
      ['Type', `${name} ('${b.type}')`],
      ['Cell', fmt([b.x, b.y, b.z])],
      ['Index', b.index],
      ['Creature', isCreature(b.type) ? 'yes' : 'no'],
    ];
    const bundle = this.world.bundleOf(b); // its BlockBundle, right now
    rows.push(['Bundle size', `${bundle.length} block${bundle.length === 1 ? '' : 's'}`]);
    if (b.movedTurn != null) rows.push(['Last moved', `turn ${b.movedTurn}`]);
    rows.push(['Buffs', b.buffs?.length ? b.buffs.map(describeBuff).join(', ') : 'none']);
    if (isCreature(b.type)) rows.push(['Flies', blockProps(b.type).fly ? 'yes (its type)' : canFly(b) ? 'yes (Flight buff)' : 'no']);
    rows.push(['Inventory', b.inventory ? (TOOLS.find((t) => t.block === b.inventory)?.label ?? b.inventory) : 'empty']);
    if (b.type === BLOCK.WOOD || isCreature(b.type)) {
      rows.push(['Bundle slots', `${bundle.filter((x) => x.inventory).length} of ${bundle.length} full`]);
    }
    if (b.type === BLOCK.SQUIRMY) {
      const segs = this.world.squirmyOf.get(b)?.segments ?? [b];
      const i = segs.indexOf(b);
      rows.push(['Segment', `${i + 1} of ${segs.length}${b.isHead ? ' (head)' : b.isTail ? ' (tail)' : ''}`]);
      if (!b.isHead) rows.push(['Behavior', `${segs[0].behavior ?? '—'} (the head's)`]);
    }
    if (isCreature(b.type) && (b.type !== BLOCK.SQUIRMY || b.isHead)) {
      rows.push(['Behavior', b.behavior ?? '—']);
      rows.push(['Assigned', b.isAssignedBehavior ? 'yes (by the player)' : 'no (forages for Berries)']);
      if (b.sightRadius != null) rows.push(['Sight radius', `${b.sightRadius} blocks`]);
      rows.push(['Front', b.front ? fmt(b.front) : '—']);
      rows.push(['Floor', b.floor ? fmt(b.floor) : 'none']);
      if (b.walkTarget) rows.push(['Walk target', fmt(b.walkTarget)]);
      if (b.walkStuck) rows.push(['Walk stuck', `${b.walkStuck} turn(s)`]);
      if (b.trappedTurns) rows.push(['Trapped for', `${b.trappedTurns} turn(s)`]);
      if (b.waitTurns != null) rows.push(['Wait left', `${b.waitTurns} turn(s)`]);
    }
    return { title: `${sel ? 'Selected' : 'Targeted'}: ${name}`, rows };
  }

  /**
   * Sets the Select tool's selection. A newly selected creature waits (Wait behavior) for
   * SELECT_WAIT_TURNS turns, or until it is deselected, then goes back to what it was doing
   * (`heldBehavior`), unless its behavior changed meanwhile (sent somewhere → Walk, or Trapped).
   */
  _setSelected(list) {
    for (const c of this.selected) {
      c.isSelected = false;
      // deselected: no longer under orders, unless it is still on its way somewhere
      if (!list.includes(c) && c.behavior !== BEHAVIOR.WALK) c.isAssignedBehavior = false;
    }
    for (const c of list) {
      c.isSelected = true; // lets the sim hold it at the end of a walk (endWalk)
      c.isAssignedBehavior = true; // the Select tool put it in Wait: no foraging while selected
    }
    for (const c of this.selected) {
      if (list.includes(c)) continue;
      if (c.behavior === BEHAVIOR.WAIT && c.heldBehavior) c.behavior = c.heldBehavior;
      delete c.heldBehavior;
      delete c.waitTurns;
    }
    for (const c of list) {
      if (this.selected.includes(c) || c.heldBehavior) continue;
      c.heldBehavior = c.behavior;
      c.behavior = BEHAVIOR.WAIT;
      c.waitTurns = SELECT_WAIT_TURNS; // then it resumes heldBehavior (sim: tickWait)
    }
    this.selected = list;
    const phase = list.length ? 'target' : 'select';
    if (this.state.selectPhase !== phase) this.setState({ selectPhase: phase });
  }

  /**
   * Gamepad / Touch A: each selected creature eats the block in front of it (its `front`
   * side; for a Squirmy, its head's), or else any other edible block next to it, if its
   * bundle has an inventory slot free. If none of them can, "ineffective" plays.
   */
  selectedEat() {
    if (!this.selected.length || !this.toolsReady()) return false;
    let ate = false;
    for (const c of this.selected) {
      if (creatureEatNearby(this.world, c)) ate = true;
    }
    if (ate) this._syncCount();
    else playSfx('ineffective', 0);
    return ate;
  }

  /**
   * Gamepad / Touch Y (Wander) and X (Wait): sets the behavior of every selected creature
   * (a Squirmy's is its head's) while it stays selected. Wander drops any walk target, and
   * becomes what the creature keeps doing once deselected; Wait (as on selecting) holds it
   * still until it is deselected. Plays assign.wav for Wander and wait.wav for Wait, or
   * ineffective.wav with nothing selected.
   */
  selectedBehavior(behavior) {
    if (!this.selected.length || !this.toolsReady()) {
      playSfx('ineffective', 0);
      return false;
    }
    for (const c of this.selected) {
      if (c.behavior === BEHAVIOR.TRAPPED) continue; // can't wander off while walled in
      c.behavior = behavior;
      c.isAssignedBehavior = true;
      delete c.waitTurns; // X's Wait lasts until deselected
      if (behavior === BEHAVIOR.WANDER) {
        c.heldBehavior = BEHAVIOR.WANDER; // what it resumes if put back in Wait and deselected
        delete c.walkTarget;
        delete c.walkStuck;
      }
    }
    if (behavior === BEHAVIOR.WANDER) playAssign();
    else playWait();
    return true;
  }

  /**
   * Gamepad / Touch B: each selected creature excretes the item in its tail's inventory slot
   * (World.excrete on its BlockBundle). If none of them can, "ineffective" plays.
   */
  selectedExcrete() {
    if (!this.selected.length || !this.toolsReady()) return false;
    let did = false;
    for (const c of this.selected) {
      if (this.world.excrete(this.world.bundleOf(c), 'excrete')) did = true;
    }
    if (did) this._syncCount();
    else playSfx('ineffective', 0);
    return did;
  }

  /** A cell a selected Crawly can be sent to: empty, next to the pointed-at walking surface. */
  _isSelectTarget(t) {
    if (!t?.block || !t.place || !t.placeFree) return false;
    // a surface the selected creature walks on, with room for it beside it
    return this.selected.some((c) => (canWalkOn(c.type, t.block.type) || canFly(c)) && canStand(this.world, c, ...t.place));
  }

  /** The creature a block belongs to: a Crawly itself, or a Squirmy segment's head. Else null. */
  _creatureOf(b) {
    if (isSingleCreature(b?.type)) return b;
    if (b?.type === BLOCK.SQUIRMY) return this.world.squirmyOf.get(b)?.segments[0] ?? b;
    return null;
  }

  /** Every block of a creature: a Squirmy's whole chain, or just the Crawly. */
  _bodyOf(c) {
    return c.type === BLOCK.SQUIRMY ? this.world.squirmyOf.get(c)?.segments ?? [c] : [c];
  }

  _useSelect(t) {
    // clicking a creature (Crawly, or any segment of a Squirmy) selects it (in either phase:
    // in 'target' it swaps the selection)
    const creature = this._creatureOf(t?.block);
    if (creature) {
      if (this.selected.length === 1 && this.selected[0] === creature) return false;
      this._setSelected([creature]);
      playWait(); // selecting puts it in Wait
      return true;
    }
    if (!this.selected.length) return false;
    if (!this._isSelectTarget(t)) {
      // clicked something that is neither a Crawly nor a valid target (or empty space):
      // drop the selection and go back to the Select phase
      this._setSelected([]);
      playTick();
      return false;
    }
    const [x, y, z] = t.place;
    for (const c of this.selected) {
      if (!(canWalkOn(c.type, t.block.type) || canFly(c)) || !canStand(this.world, c, x, y, z)) continue;
      c.behavior = BEHAVIOR.WALK; // replaces the Wait it had while selected (a Squirmy: its head)
      c.isAssignedBehavior = true; // sent by the Select tool: it won't stop to forage on the way
      c.heldBehavior = BEHAVIOR.WALK; // X (Wait) then deselect: carries on walking there
      c.walkTarget = { x, y, z };
      delete c.walkStuck;
      delete c.waitTurns;
    }
    // it stays selected, so it can be re-targeted straight away
    playAssign();
    return true;
  }

  /** Starts a copy of the target wireframe that shrinks to nothing over one step animation. */
  _pulseTarget() {
    let p = this._pulses.find((q) => !q.obj.visible);
    if (!p) {
      p = { obj: makeWireframe(SELECT_GREEN, SELECT_WIRE_RADIUS), t0: 0 };
      this.worldRoot.add(p.obj);
      this._pulses.push(p);
    }
    p.obj.position.copy(this.targetHL.position);
    p.obj.scale.setScalar(1);
    p.obj.visible = true;
    p.t0 = performance.now();
  }

  /** Per frame: selection wireframes follow their (possibly sliding) Crawlies; pulses shrink. */
  _updateSelectionVisuals(now) {
    // a selected creature that was deleted, or changed type, drops out of the selection
    const alive = this.selected.filter((c) => this.world.get(c.x, c.y, c.z) === c && this._creatureOf(c));
    if (alive.length !== this.selected.length) this._setSelected(alive);
    // wireframes around every block of each selected creature (a Squirmy's whole chain),
    // and lighter ones around a creature you are pointing at
    const place = (pool, blocks, colour, radius, scale) => {
      while (pool.length < blocks.length) {
        const hl = makeWireframe(colour, radius);
        hl.scale.setScalar(scale);
        this.worldRoot.add(hl);
        pool.push(hl);
      }
      pool.forEach((hl, i) => {
        const b = blocks[i];
        hl.visible = !!b;
        if (b) this.world.renderedPosition(b, now, hl.position);
      });
    };
    place(this.selectHLs, this.selected.flatMap((c) => this._bodyOf(c)), SELECT_GREEN, SELECT_WIRE_RADIUS, 1.06);
    place(this.hoverHLs, this._hoverCreature ? this._bodyOf(this._hoverCreature) : [], '#9be8a8', SELECT_WIRE_RADIUS * 0.8, 1.04);
    for (const p of this._pulses) {
      if (!p.obj.visible) continue;
      const k = (now - p.t0) / (this.world.stepSeconds * 1000);
      if (k >= 1) p.obj.visible = false;
      else p.obj.scale.setScalar(1 - k);
    }
  }

  /**
   * Left HUD "Mean Diameter": the diameter of a solid ball holding `count` blocks. Each
   * block takes up BLOCK_VOLUME_CM3 of space, so the ball's volume is count * 4 cm³ and
   * d = 2 * (3 * V / 4π)^(1/3). Returns cm.
   */
  static meanDiameter(count) {
    return 2 * Math.cbrt((3 * BLOCK_VOLUME_CM3 * count) / (4 * Math.PI));
  }

  /** Formats a Mean Diameter for the HUD, e.g. "Ø 23.4 cm". */
  static formatDiameter(count) {
    return `Ø ${Engine.meanDiameter(count).toFixed(1)} cm`;
  }

  /** Formats seconds as HH:mm:ss. */
  static formatTime(sec) {
    if (sec < 0) return `T ${sec}`; // countdown: "T -3", "T -2", "T -1"
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec / 60) % 60)}:${p(sec % 60)}`;
  }

  /** New / Load: back to the T -3 … 0 countdown (tools and the simulation wait for it, like on page load). */
  _resetClock() {
    this._clock = 0;
    this.setState({ gameTime: -COUNTDOWN_SECONDS });
  }

  /** Game clock: runs only while playing (not while the menu is open). One turn per turnSeconds (Options → Speed). */
  /**
   * Options → Fog: on, New scenes include the recipe's Fog steps and new Fog forms far out
   * each few turns; off, neither happens (Fog already in the world stays).
   */
  setFog(on) {
    this.world.fogEnabled = on;
    this.setState({ fog: on });
  }

  /** Sets a menu slider's value (XR pointer, gamepad). */
  _setSlider(id, value) {
    if (value == null) return;
    if (id === 'speed') this.setSpeed(value);
  }

  /** Options → Speed: sets the turns per minute, and with it the turn and animation length. */
  setSpeed(turnsPerMinute) {
    const raw = THREE.MathUtils.clamp(Number(turnsPerMinute) || SPEED.default, SPEED.min, SPEED.max);
    const v = Math.round(raw / SPEED.step) * SPEED.step; // snap to the slider's steps
    this.turnSeconds = 60 / v;
    this.world.stepSeconds = STEP_FRACTION * this.turnSeconds;
    if (v !== this.state.speed) this.setState({ speed: v });
  }

  _advanceClock(dt) {
    const s = this.state;
    if (s.screen !== 'playing' || s.paused) return;
    this._clock = (this._clock || 0) + dt;
    while (this._clock >= this.turnSeconds) {
      this._clock -= this.turnSeconds;
      const turn = this.state.gameTime + 1;
      this.setState({ gameTime: turn });
      if (turn < 0) playReady(); // countdown…
      else if (turn === 0) playGo(); // …go: tools work from here, the simulation from turn 1
      else {
        const t0 = performance.now();
        this._turn(turn);
        this.turnMs = performance.now() - t0; // Debug → Performance
      }
    }
  }

  /** Everything that happens once per turn (`turn` = 1, 2, 3… since New / Load). */
  _turn(turn) {
    this.world.turn = turn; // moves this turn are stamped with it (Water settling)
    this.world.tickBuffs(); // buffs count down a turn (and wear off)
    const moved = stepGroups(this.world); // detached groups fall toward the origin first…
    for (const w of stepWater(this.world, moved)) moved.add(w); // …then Water flows…
    for (const f of stepFog(this.world, moved)) moved.add(f); // …Fog bundles settle down, whole…
    for (const n of stepNimbusDrift(this.world, moved)) moved.add(n); // …Nimbus clouds drift west…
    stepCrawlies(this.world, moved); // …then Crawlies (a Crawly that just fell with its group waits)…
    stepSquirmies(this.world, moved); // …and Squirmies crawl as chains, head first…
    stepSight(this.world); // …and every Crawly clears the Fog it can see (it shrinks away, then goes)…
    stepWood(this.world, turn); // …then watered trees grow Wood (or Berries)…
    stepDirt(this.world, turn); // …then Dirt soaks up leftover settled Water and turns to Moss…
    if (this.state.rain) stepRain(this.world, turn); // …a raindrop appears far out now and then (Options → Rain)…
    if (this.state.fog) stepFogForm(this.world, turn); // …and so does a wisp of Fog (Options → Fog)…
    stepNimbus(this.world, turn); // …and every 3rd turn each Nimbus may rain one Water below it
    updateBlockBundles(this.world); // finally, bucket non-creature blocks into same-type BlockBundles
    this._syncCount(); // rain, Nimbus and growth add blocks: keep the HUD's count (and diameter) current
    if (this.targetHL.visible) this._pulseTarget(); // Select tool: a turn tick on the pointed-at target
  }

  newScene() {
    this._resetClock();
    this._resetPlayerView();
    this.world.generateNew();
    this._syncCount();
    this._startPlaying();
    playLoad();
    this.toast('New scene created');
  }

  async refreshSaves() {
    this.setState({ saves: null, savesError: null });
    try {
      const saves = await listSaves();
      this.setState({ saves });
    } catch (e) {
      this.setState({ savesError: e.message || String(e) });
    }
  }

  async saveAs(rawName) {
    const name = rawName ? normalizeSaveName(rawName) : timestampName();
    if (!name) return this.toast('Please enter a file name', 'error');
    try {
      await writeSave(name, this.world.toJSON());
      this._startPlaying();
      playSave();
      this.toast(`Saved ${this.world.size} blocks as "${displayName(name)}"`);
    } catch (e) {
      this.toast(e.message || 'Save failed', 'error');
    }
  }

  async loadFile(name) {
    try {
      const data = await readSave(name);
      this.importJSON(data, name);
    } catch (e) {
      this.toast(e.message || 'Load failed', 'error');
    }
  }

  importJSON(data, name = 'file') {
    try {
      const { loaded, skipped } = this.world.fromJSON(data);
      this._resetClock();
      this._resetPlayerView();
      this._syncCount();
      this._startPlaying();
      playLoad();
      this.toast(`Loaded ${loaded} blocks from "${displayName(name)}"${skipped ? ` (${skipped} invalid skipped)` : ''}`);
    } catch (e) {
      this.toast(e.message || 'Invalid save file', 'error');
    }
  }

  exportJSON() {
    return this.world.toJSON();
  }

  setSound(on) {
    setMuted(!on);
    this.setState({ soundOn: on });
    if (on) playTick();
  }

  menuAction(id, arg) {
    const s = this.state;
    // Resume, New, Load-file and Save play their own sounds; everything else ticks.
    if (!/^(resume|new|savenew|save:|load:)/.test(id)) playTick();
    if (id === 'resume') return this.resume();
    if (id === 'new') return this.newScene();
    if (id === 'load' || id === 'save') {
      this.setState({ menu: id, page: 0 });
      return this.refreshSaves();
    }
    if (id === 'options') return this.setState({ menu: 'options' });
    if (id === 'sound') return this.setSound(!s.soundOn);
    if (id === 'background') {
      this.setState({ passthrough: !s.passthrough });
      if (s.inXR && !s.passthrough && this._xrMode !== 'immersive-ar') {
        this.toast('This XR session can’t show passthrough (it was started as VR)');
      }
      return this._applyBackground();
    }
    if (id === 'materials') {
      const on = !s.proceduralMaterials;
      this.world.materials.setProcedural(on);
      return this.setState({ proceduralMaterials: on });
    }
    if (id === 'outlines') {
      const on = !s.outlines;
      this.world.materials.uniforms.uOutlines.value = on ? 1 : 0;
      return this.setState({ outlines: on });
    }
    if (id === 'ao') {
      const on = !s.ambientOcclusion;
      this.world.materials.uniforms.uAO.value = on ? 1 : 0;
      return this.setState({ ambientOcclusion: on });
    }
    if (id === 'rain') return this.setState({ rain: !s.rain });
    if (id === 'fog') return this.setFog(!s.fog);
    if (id === 'debug') {
      const on = !s.debugMode;
      this.setState({ debugMode: on });
      if (on && this.renderer.xr.isPresenting) this._placeDebugTablet();
      console.info(`Debug mode ${on ? 'on' : 'off'}`);
      return;
    }
    if (id === 'rendering') {
      this.world.setSmoothRendering(!s.smoothRendering); // Smooth: BlockBundles drawn as merged, smoothed bodies
      return this.setState({ smoothRendering: !s.smoothRendering });
    }
    if (id === 'enterxr') return this.enterXR();
    if (id === 'exitxr') return this.renderer.xr.getSession()?.end();
    if (id === 'back') return this.setState({ menu: s.menu === 'controls' ? 'options' : 'main', page: 0 });
    if (id === 'controls') return this.setState({ menu: 'controls' });
    if (id === 'prev') return this.setState({ page: Math.max(0, s.page - 1) });
    if (id === 'next') {
      const pages = Math.ceil((s.saves?.length || 0) / PAGE_SIZE);
      return this.setState({ page: Math.min(pages - 1, s.page + 1) });
    }
    if (id === 'savenew') return this.saveAs(arg);
    if (id.startsWith('save:')) return this.saveAs(id.slice(5));
    if (id.startsWith('load:')) return this.loadFile(id.slice(5));
  }

  // ---------------------------------------------------------------- XR
  async enterXR() {
    const { xrAR, xrVR, passthrough } = this.state;
    // Passthrough needs an immersive-ar session (Quest Browser). PC browsers driving a headset
    // over Link only offer immersive-vr, which always has a solid background.
    const mode = (passthrough || !xrVR) && xrAR ? 'immersive-ar' : xrVR ? 'immersive-vr' : null;
    if (!mode || this.renderer.xr.isPresenting) return;
    if (passthrough && mode !== 'immersive-ar') {
      this.toast('Passthrough isn’t available in this browser — open the game in the Quest Browser for passthrough');
    }
    unlockAudio();
    try {
      const session = await navigator.xr.requestSession(mode, {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking'],
      });
      this._savedView = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
      this.renderer.xr.setReferenceSpaceType('local-floor');
      await this.renderer.xr.setSession(session);
      session.addEventListener('end', () => this._onXREnd());
      this._xrMode = mode;
      this._applyBackground();
      this._xrFrames = 0;
      this._needsXRPlacement = true;
      this._needsTabletPlacement = true; // debug tablet: re-place in front of the player each session
      this.controls.enabled = false;
      this.setState({ inXR: true, screen: 'playing', menu: 'main' });
    } catch (e) {
      console.error(e);
      this.toast(`Could not start XR: ${e.message || e}`, 'error');
    }
  }

  _onXREnd() {
    this.debugTablet.mesh.visible = false;
    this._tabletGrab = null;
    this._xrMode = null;
    this.scene.background = BG;
    if (this.menuPanel.mesh.parent !== this.scene) this.scene.add(this.menuPanel.mesh);
    this.worldRoot.position.set(0, 0, 0);
    this.worldRoot.quaternion.identity();
    this.worldRoot.scale.setScalar(CM);
    this.menuPanel.mesh.visible = false;
    this.rayDot.visible = false;
    this._grab = null;
    if (this._savedView) {
      this.camera.position.copy(this._savedView.pos);
      this.camera.quaternion.identity();
      this.controls.target.copy(this._savedView.target);
    }
    this.controls.enabled = true;
    this.controls.update();
    this._onResize();
    this.setState({ inXR: false, paused: true, menu: 'main' });
  }

  // ---------------------------------------------------------------- XR debug tablet

  /** Puts the debug tablet in front of the player, a little to the left and below eye level. */
  _placeDebugTablet() {
    const m = this.debugTablet.mesh;
    const { pos, dir } = this._headPose();
    const flat = new THREE.Vector3(dir.x, 0, dir.z);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
    flat.normalize();
    const left = new THREE.Vector3(flat.z, 0, -flat.x);
    m.position.copy(pos).addScaledVector(flat, 0.5).addScaledVector(left, 0.22);
    m.position.y -= 0.12;
    m.lookAt(pos);
    this._needsTabletPlacement = false;
  }

  /** Starts moving the tablet with this controller's grip if it is within reach (or pointed at). */
  _tryGrabTablet(slot) {
    const m = this.debugTablet.mesh;
    if (!m.visible) return false;
    const local = m.worldToLocal(this._gripPos(slot));
    const { width, height } = m.geometry.parameters;
    const near = Math.abs(local.z) < 0.12 && Math.abs(local.x) < width / 2 + 0.06 && Math.abs(local.y) < height / 2 + 0.06;
    const pointed = this.hands.right === slot && this._tabletHover;
    if (!near && !pointed) return false;
    slot.grip.updateMatrixWorld();
    m.updateMatrixWorld();
    this._tabletGrab = { slot, offset: slot.grip.matrixWorld.clone().invert().multiply(m.matrixWorld) };
    return true;
  }

  /** While grabbed, the tablet keeps its pose relative to the hand holding it. */
  _updateTabletGrab() {
    const g = this._tabletGrab;
    if (!g) return;
    const m = this.debugTablet.mesh;
    g.slot.grip.updateMatrixWorld();
    new THREE.Matrix4().multiplyMatrices(g.slot.grip.matrixWorld, g.offset).decompose(m.position, m.quaternion, m.scale);
  }

  // ---------------------------------------------------------------- XR grab (grips)
  _gripPos(slot) {
    return slot.grip.getWorldPosition(new THREE.Vector3());
  }

  /** (Re)start a grab whenever a grip is pressed or released, from the build's current pose. */
  _beginGrab() {
    const held = ['left', 'right'].map((h) => this.hands[h]).filter((sl) => sl && sl.gripHeld);
    const r = this.worldRoot;
    if (!held.length) {
      this._grab = null;
      return;
    }
    const base = { pos: r.position.clone(), quat: r.quaternion.clone(), scale: r.scale.x };
    if (held.length === 1) {
      this._grab = { ...base, hands: held, p0: this._gripPos(held[0]) };
    } else {
      const a = this._gripPos(held[0]), b = this._gripPos(held[1]);
      this._grab = { ...base, hands: held, mid0: a.clone().add(b).multiplyScalar(0.5), v0: b.clone().sub(a) };
    }
  }

  /**
   * One grip: translate the build with the hand.
   * Both grips: the midpoint between the hands translates it, the change in the hand-to-hand
   * direction rotates it, and the change in hand distance scales it — all about the midpoint.
   */
  _updateGrab() {
    const g = this._grab;
    if (!g) return;
    const r = this.worldRoot;
    if (g.hands.length === 1) {
      r.position.copy(g.pos).add(this._gripPos(g.hands[0]).sub(g.p0));
      return;
    }
    const a = this._gripPos(g.hands[0]), b = this._gripPos(g.hands[1]);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const v = b.clone().sub(a);
    const len0 = g.v0.length(), len = v.length();
    if (len0 < 1e-4 || len < 1e-4) return;
    const newScale = THREE.MathUtils.clamp((g.scale * len) / len0, CM * GRAB_MIN_SCALE, CM * GRAB_MAX_SCALE);
    const s = newScale / g.scale;
    const q = new THREE.Quaternion().setFromUnitVectors(g.v0.clone().normalize(), v.normalize());
    r.quaternion.copy(q).multiply(g.quat);
    r.scale.setScalar(newScale);
    r.position.copy(g.pos).sub(g.mid0).multiplyScalar(s).applyQuaternion(q).add(mid);
  }

  _headPose() {
    const pos = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    return { pos, dir };
  }

  /** Put the grid origin 50 cm in front of the player's eyes. */
  /**
   * Starting a game (New / Load): put the player 50 cm from the grid origin.
   * Browser: camera back to its start spot, looking at the origin.
   * XR: the build is reset to life size / upright and its origin placed 50 cm in front of the eyes.
   */
  _resetPlayerView() {
    if (this.renderer.xr.isPresenting) {
      this._grab = null;
      this.worldRoot.quaternion.identity();
      this.worldRoot.scale.setScalar(CM);
      this._placeWorldInFront();
    } else {
      this.worldRoot.position.set(0, 0, 0);
      this.controls.target.set(0, 0, 0);
      this.camera.position.copy(START_CAMERA);
      this.camera.lookAt(0, 0, 0);
      this.controls.update();
    }
  }

  _placeWorldInFront() {
    const { pos, dir } = this._headPose();
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    this.worldRoot.position.copy(pos).addScaledVector(dir, 0.5);
  }

  /** Pause panel 50 cm in front of the face, facing the player. */
  /**
   * Docks the menu above the Left HUD, in the HUD's plane. Without a left controller
   * it floats 50 cm in front of the face instead.
   */
  _placeMenuPanel() {
    const m = this.menuPanel.mesh;
    const hud = this.leftHud.mesh;
    if (hud.parent) {
      if (m.parent !== hud) hud.add(m);
      const hudH = hud.geometry.parameters.height;
      const menuH = m.geometry.parameters.height;
      m.position.set(0, hudH / 2 + 0.008 + menuH / 2, 0);
      m.rotation.set(0, 0, 0);
      this.menuPanel.anchorBottom = true;
    } else {
      if (m.parent !== this.scene) this.scene.add(m);
      const { pos, dir } = this._headPose();
      m.position.copy(pos).addScaledVector(dir, 0.5);
      m.lookAt(pos);
      this.menuPanel.anchorBottom = false;
    }
    m.visible = true;
    this._menuHover = null;
  }

  /** Applies Options → Background: passthrough (AR) or the solid colour. */
  _applyBackground() {
    const ar = this.renderer.xr.isPresenting && this._xrMode === 'immersive-ar';
    this.scene.background = ar && this.state.passthrough ? null : BG;
  }

  _pulse(intensity, ms) {
    const gp = this.hands.right?.source?.gamepad;
    const act = gp?.hapticActuators?.[0];
    try {
      if (act?.pulse) act.pulse(intensity, ms);
      else gp?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: intensity });
    } catch {
      /* ignore */
    }
  }

  _onRightTrigger() {
    if (this._hudHover === 'menu') return this.toggleMenu();
    if (this._tabletHover) return; // pointing at the debug tablet: the trigger does nothing
    if (this.isMenuOpen()) {
      const slider = this._menuHover && this.menuPanel.sliderValueAt(this._menuHoverUV, this._menuHover);
      if (slider != null) {
        this._sliderDrag = this._menuHover; // hold the trigger to drag
        this._setSlider(this._menuHover, slider);
      } else if (this._menuHover) this.menuAction(this._menuHover);
      else if (!this._menuPanelHover) this.resume(); // clicked outside the pause panel
      return;
    }
    if (this.state.screen === 'playing') this.useTool();
  }

  /**
   * Right Touch thumbstick flicked left/right cycles tools (XR, and window mode when the
   * browser exposes the Touch controllers as gamepads). Re-arms once the stick recentres.
   */
  _touchStickTools(gp) {
    if (this.state.screen !== 'playing' || this.state.paused) return;
    const x = (gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0]) || 0; // xr-standard: thumbstick = axes 2/3
    if (this._stickArmed && Math.abs(x) > 0.65) {
      this._stickArmed = false;
      this.cycleTool(x > 0 ? 1 : -1);
    } else if (Math.abs(x) < 0.3) {
      this._stickArmed = true;
    }
  }

  _pollGamepads() {
    const rgp = this.hands.right?.source?.gamepad;
    if (rgp) {
      this._touchStickTools(rgp);
      const playing = this.state.screen === 'playing' && !this.state.paused;
      const a = !!rgp.buttons[4]?.pressed; // A: eat
      if (a && !this._rightAWas && playing) this.selectedEat();
      this._rightAWas = a;
      const b = !!rgp.buttons[5]?.pressed; // B: excrete
      if (b && !this._rightBWas && playing) this.selectedExcrete();
      this._rightBWas = b;
    }
    // The Quest Browser uses the left Menu (≡) button as "Back", so the menu is opened
    // with the Menu button on the left HUD; the Y button is a shortcut for it.
    // Left Y: with a creature selected (while playing), puts it in Wander; otherwise it opens
    // the menu. Left X puts a selected creature back in Wait.
    const lgp = this.hands.left?.source?.gamepad;
    if (lgp) {
      const playing = this.state.screen === 'playing' && !this.state.paused;
      const y = !!lgp.buttons[5]?.pressed;
      if (y && !this._leftMenuWas) {
        if (playing && this.selected.length) this.selectedBehavior(BEHAVIOR.WANDER);
        else this.toggleMenu();
      }
      this._leftMenuWas = y;
      const x = !!lgp.buttons[4]?.pressed;
      if (x && !this._leftXWas && playing) this.selectedBehavior(BEHAVIOR.WAIT);
      this._leftXWas = x;
    }
  }

  // ---------------------------------------------------------------- per-frame
  _setRayFromController() {
    const ctrl = this.hands.right?.ctrl;
    if (!ctrl) return false;
    ctrl.updateMatrixWorld();
    const origin = new THREE.Vector3().setFromMatrixPosition(ctrl.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(ctrl.matrixWorld);
    this.raycaster.set(origin, dir);
    return true;
  }

  _updateTarget() {
    this.placeHL.visible = false;
    this.deleteHL.visible = false;
    this._hoverCreature = null;
    this.targetHL.visible = false;
    this.world.setDithered(null);
    this.target = null;
    const s = this.state;
    const xr = this.renderer.xr.isPresenting;
    let rayLen = XR_RAY_LENGTH;
    this.rayDot.visible = false;

    const menuOpen = this.isMenuOpen(s);
    this._menuHover = null;
    this._menuPanelHover = false; // ray is on the pause panel (button or not)
    this._tabletHover = false;
    this._hudHover = null;
    let uiHit = null;

    if (xr && this._setRayFromController()) {
      // UI first: the left HUD's Menu button and the start/pause panel.
      this.raycaster.far = 3;
      const targets = [];
      if (this.leftHud.mesh.visible && this.leftHud.mesh.parent) targets.push(this.leftHud.mesh);
      if (menuOpen) targets.push(this.menuPanel.mesh);
      if (this.debugTablet.mesh.visible) targets.push(this.debugTablet.mesh);
      for (const hit of this.raycaster.intersectObjects(targets, false)) {
        if (hit.object === this.debugTablet.mesh) {
          this._tabletHover = true; // grip now grabs it; the trigger does nothing here
          uiHit = hit;
          break;
        } else if (hit.object === this.leftHud.mesh) {
          if (this.leftHud.hitTest(hit.uv)) {
            this._hudHover = 'menu';
            uiHit = hit;
            break;
          }
        } else if (this.menuPanel.contains(hit.uv)) {
          // only the visible panel counts; its transparent margin is "outside"
          this._menuHover = this.menuPanel.hitTest(hit.uv);
          this._menuHoverUV = hit.uv;
          // dragging a slider: follow the ray along its track while the trigger is held
          if (this._sliderDrag && this._menuHover === this._sliderDrag) {
            this._setSlider(this._sliderDrag, this.menuPanel.sliderValueAt(hit.uv, this._sliderDrag));
          }
          this._menuPanelHover = true;
          uiHit = hit;
          break;
        }
      }
      if (uiHit) {
        rayLen = uiHit.distance;
        this.rayDot.position.copy(uiHit.point);
        this.rayDot.visible = true;
      }
    }
    if (xr && menuOpen) this.menuPanel.draw(menuModel(s), this._menuHover);

    if (s.screen === 'playing' && !s.paused && !uiHit && this.toolsReady(s)) {
      let ok = false;
      if (xr) {
        ok = this._setRayFromController();
        this.raycaster.far = XR_RAY_LENGTH;
      } else if (s.gamepadAim) {
        this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
        this.raycaster.far = DESKTOP_RAY_LENGTH;
        ok = true;
      } else if (this.mouse) {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        this.raycaster.far = DESKTOP_RAY_LENGTH;
        ok = true;
      }
      if (ok) {
        this.target = this._pick();
        if (this.target?.distance != null) {
          rayLen = Math.min(this.target.distance, XR_RAY_LENGTH);
          if (xr) {
            this.rayDot.position.copy(this.target.point);
            this.rayDot.visible = true;
          }
        }
        this._showHighlight();
      }
    }

    this.rayLine.scale.z = rayLen;
    this.rayLine.visible = xr && (s.screen === 'playing' || menuOpen);
  }

  _pick() {
    const hits = this.raycaster.intersectObject(this.world.mesh, false);
    const h = hits.find((x) => x.instanceId != null);
    if (!h) {
      // Empty world: allow placing the first block at the origin.
      if (this.world.size === 0) return { block: null, place: [0, 0, 0], placeFree: true, faceType: null };
      return null;
    }
    const block = this.world.blockAtIndex(h.instanceId);
    if (!block) return null;
    const face = faceFromNormal(h.face.normal);
    const place = [block.x + face.offset[0], block.y + face.offset[1], block.z + face.offset[2]];
    return {
      block,
      faceType: face.type,
      place,
      placeFree: isValidCell(...place) && !this.world.has(...place),
      distance: h.distance,
      point: h.point.clone(),
    };
  }

  _showHighlight() {
    const t = this.target;
    const tool = TOOLS[this.state.toolIndex];
    // Delete target: see-through (dithered) so you can tell what's behind it
    this.world.setDithered(t && tool.id === TOOL.DELETE ? t.block : null);
    if (!t) return;
    if (tool.id === TOOL.SELECT) {
      const creature = this._creatureOf(t.block);
      if (creature && !this.selected.includes(creature)) {
        this._hoverCreature = creature; // a creature you could select: drawn in _updateSelectionVisuals
      } else if (this.selected.length && this._isSelectTarget(t)) {
        this.targetHL.position.set(...t.place);
        this.targetHL.visible = true;
      }
    } else if (tool.block) {
      if (t.place && t.placeFree) {
        this.placeHL.position.set(...t.place);
        // same colour as the outlines of the block that would be placed
        this.placeHL.userData.material.color.set(BLOCK_COLORS[tool.block]).multiplyScalar(EDGE_SHADE);
        this.placeHL.visible = true;
      }
    } else if (t.block) {
      this.deleteHL.position.set(t.block.x, t.block.y, t.block.z);
      this.deleteHL.visible = true;
    }
  }

  /**
   * Browser only: keeps the camera out of blocks. If the nearest block centre is within
   * CAMERA_PUSH_WITHIN_CM, the camera is pushed straight away from that block: out to at
   * least CAMERA_PUSH_TO_CM, and further along the same direction until it sits in a clear
   * (empty) cell. The orbit target stays put, so orbiting and zooming carry on from there.
   */
  _pushCameraOutOfBlocks() {
    const p = this.worldRoot.worldToLocal(this.camera.position.clone()); // cm, lattice space
    // nearest block centre (cells within ±2 cm per axis cover the 1.25 cm radius)
    let nearest = null, best = CAMERA_PUSH_WITHIN_CM;
    const x0 = Math.floor(p.x) - 1, y0 = Math.floor(p.y) - 1, z0 = Math.floor(p.z) - 1;
    for (let x = x0; x <= x0 + 3; x++) for (let y = y0; y <= y0 + 3; y++) for (let z = z0; z <= z0 + 3; z++) {
      if (!this.world.has(x, y, z)) continue;
      const d = Math.hypot(p.x - x, p.y - y, p.z - z);
      if (d < best) {
        best = d;
        nearest = new THREE.Vector3(x, y, z);
      }
    }
    if (!nearest) return;
    const dir = p.clone().sub(nearest);
    if (dir.lengthSq() < 1e-12) dir.copy(this.camera.position).sub(this.controls.target); // dead centre: back off along the view line
    dir.normalize();
    // step outward from that block until the camera's cell is empty (give up after 30 cm)
    for (let dist = CAMERA_PUSH_TO_CM; dist <= 30; dist += 0.25) {
      p.copy(nearest).addScaledVector(dir, dist);
      if (!this.world.has(...nearestLatticeCell(p))) break;
    }
    this.camera.position.copy(this.worldRoot.localToWorld(p));
  }

  /**
   * Browser: once the camera is zoomed all the way in on its orbit target (minDistance),
   * further zooming in moves the camera and the target forward together, along the view
   * direction. So you can always fly on in the direction you face, e.g. out of a hollow
   * chamber through its entrance, instead of being stuck zooming at a target inside it.
   * `sph`: the gamepad's spherical offset, when called from _padCamera (then it applies there).
   */
  _flyForward(metres, sph = null) {
    const c = this.controls, cam = this.camera;
    const dist = sph ? sph.radius : cam.position.distanceTo(c.target);
    if (dist > c.minDistance * 1.05 || metres <= 0) return;
    const fwd = c.target.clone().sub(cam.position).normalize().multiplyScalar(metres);
    c.target.add(fwd);
    cam.position.add(fwd);
  }

  _updateOrbitLight(timeMs) {
    const a = (timeMs / 1000) * ((2 * Math.PI) / ORBIT_PERIOD_S);
    // x = R cos a, z = R sin a turns clockwise when viewed from above (looking down -Y)
    this.orbitLight.position.set(ORBIT_RADIUS_CM * Math.cos(a), ORBIT_HEIGHT_CM, ORBIT_RADIUS_CM * Math.sin(a));
  }

  // ---------------------------------------------------------------- browser gamepad
  _pollBrowserGamepad(dt) {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((p) => p && p.connected) : [];
    // Touch controllers (e.g. Quest Browser / Link in window mode) are not standard
    // gamepads: only the right stick is used, to switch tools, same as in XR.
    const isTouch = (p) => p.mapping === 'xr-standard' || !!p.hand || /oculus|touch|meta/i.test(p.id);
    const rightTouch = pads.find((p) => isTouch(p) && (p.hand === 'right' || /right/i.test(p.id)));
    if (rightTouch) this._touchStickTools(rightTouch);
    const others = pads.filter((p) => !isTouch(p));
    const gp = others.find((p) => p.mapping === 'standard') || others[0];
    if (!gp) return;
    const pressed = gp.buttons.map((b) => b.pressed || b.value > 0.5);
    const prev = this._padPrev || [];
    this._padPrev = pressed;
    const edge = (i) => pressed[i] && !prev[i];
    const ax = (i) => {
      const v = gp.axes[i] || 0;
      return Math.abs(v) < 0.18 ? 0 : v;
    };
    if (!pressed.some(Boolean) && ![0, 1, 2, 3].some((i) => ax(i))) {
      this._padStickArmed = true;
      return;
    }
    unlockAudio();
    const s = this.state;
    if (this.isMenuOpen(s)) return this._padMenu(edge, ax);
    if (s.screen !== 'playing') return;
    if (!s.gamepadAim) this.setState({ gamepadAim: true });
    if (edge(9)) return this.toggleMenu(); // Start
    if (edge(0)) this.selectedEat(); // A: a selected creature eats what is in front of it
    if (edge(1)) this.selectedExcrete(); // B: … or excretes what is in its tail's slot
    if (edge(3)) this.selectedBehavior(BEHAVIOR.WANDER); // Y: selected creatures wander
    if (edge(2)) this.selectedBehavior(BEHAVIOR.WAIT); // X: … or wait again
    if (edge(4)) this.cycleTool(-1); // LB
    if (edge(5)) this.cycleTool(1); // RB
    if (edge(7)) {
      // RT
      this._updateTarget();
      this.useTool();
    }
    this._padCamera(dt, ax(2), ax(3), ax(1), [pressed[12], pressed[13], pressed[14], pressed[15]]);
  }

  /** D-pad / left stick moves the focus, A selects, B goes back, Start closes the pause menu. */
  _padMenu(edge, ax) {
    const s = this.state;
    const items = menuModel(s).items.filter((it) => !it.disabled);
    if (!items.length) return;
    let idx = items.findIndex((it) => it.id === s.menuFocus);
    const ly = ax(1);
    let stick = 0;
    if (this._padStickArmed !== false && Math.abs(ly) > 0.6) {
      stick = Math.sign(ly);
      this._padStickArmed = false;
    } else if (Math.abs(ly) < 0.3) this._padStickArmed = true;
    const down = edge(13) || stick > 0, up = edge(12) || stick < 0;
    if (up || down || ((edge(0)) && idx < 0)) {
      idx = idx < 0 ? 0 : (idx + (down ? 1 : up ? -1 : 0) + items.length) % items.length;
      this.setState({ menuFocus: items[idx].id });
      playTick();
      return;
    }
    // D-pad left / right adjusts a focused slider (Options → Speed)
    const slider = items[idx]?.slider;
    if (slider && (edge(14) || edge(15))) {
      this._setSlider(items[idx].id, slider.value + (edge(15) ? 1 : -1) * slider.step); // one notch
      playTick();
      return;
    }
    if (slider && edge(0)) return; // A on a slider: nothing to press
    if (edge(0)) return this.menuAction(items[idx].id); // A
    if (edge(1)) {
      // B
      if (s.menu !== 'main') this.menuAction('back');
      else if (s.paused) this.resume();
      return;
    }
    if (edge(9) && s.paused) this.resume();
  }

  /** Right stick orbits, left stick up/down zooms, D-pad pans. */
  _padCamera(dt, rx, ry, ly, [du, dd, dl, dr]) {
    if (!rx && !ry && !ly && !du && !dd && !dl && !dr) return;
    const c = this.controls, cam = this.camera;
    const off = cam.position.clone().sub(c.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta += rx * 2.2 * dt;
    sph.phi += ry * 1.6 * dt;
    sph.radius = THREE.MathUtils.clamp(sph.radius * Math.exp(ly * 1.6 * dt), c.minDistance, c.maxDistance);
    if (ly < 0) this._flyForward(-ly * FLY_M_PER_PAD_S * dt, sph); // stick past the zoom limit: fly forward
    sph.makeSafe();
    off.setFromSpherical(sph);
    const pan = new THREE.Vector3();
    if (du || dd || dl || dr) {
      const speed = sph.radius * 0.8 * dt;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      pan.addScaledVector(right, ((dr ? 1 : 0) - (dl ? 1 : 0)) * speed);
      pan.addScaledVector(upv, ((du ? 1 : 0) - (dd ? 1 : 0)) * speed);
    }
    c.target.add(pan);
    cam.position.copy(c.target).add(off);
    cam.lookAt(c.target);
  }

  /**
   * Debug → Performance: frames per second, averaged over the last FPS_WINDOW_MS (updated
   * each window, so the number is steady enough to read).
   */
  fps = 0;
  turnMs = null; // Debug → Performance: how long the last turn's actions (_turn) took, ms
  _fpsFrames = 0;
  _fpsSince = null;

  _countFrame(now) {
    this._fpsSince ??= now;
    this._fpsFrames++;
    if (now - this._fpsSince >= FPS_WINDOW_MS) {
      this.fps = (this._fpsFrames * 1000) / (now - this._fpsSince);
      this._fpsFrames = 0;
      this._fpsSince = now;
    }
  }

  _tick = (time) => {
    const now = time ?? performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - (this._lastTime ?? now)) / 1000));
    this._lastTime = now;
    this._countFrame(now);
    this._updateOrbitLight(now);
    this._advanceClock(dt);
    this.world.updateAnimations();
    this._updateSelectionVisuals(now);
    const xr = this.renderer.xr.isPresenting;
    if (!xr) {
      this._pollBrowserGamepad(dt);
      this.controls.update();
      this._pushCameraOutOfBlocks();
    } else {
      this._xrFrames++;
      if (this._needsXRPlacement && this._xrFrames > 2) {
        this._needsXRPlacement = false;
        this._placeWorldInFront();
        if (this.isMenuOpen()) this._placeMenuPanel();
      }
      this._pollGamepads();
      this._updateGrab();
      const dbg = this.state.debugMode;
      this.debugTablet.mesh.visible = dbg;
      if (dbg) {
        if (this._needsTabletPlacement !== false && this._xrFrames > 2) this._placeDebugTablet();
        this._updateTabletGrab();
        this.debugTablet.draw(this.debugInfo(), getLogs(40), getLogVersion(), !!this._tabletGrab || this._tabletHover);
      } else {
        this._tabletGrab = null;
      }
      let msg = null;
      if (this._hudMessage && performance.now() < this._hudMessage.until) msg = this._hudMessage.text;
      const playing = this.state.screen === 'playing';
      this.rightHud.draw(this.state.toolIndex, msg, this.toolLabel(), { procedural: this.state.proceduralMaterials, smooth: this.state.smoothRendering });
      this.leftHud.draw(this._hudHover === 'menu', this.state.paused, Engine.formatTime(this.state.gameTime), Engine.formatDiameter(this.state.blockCount));
      this.rightHud.mesh.visible = playing;
      this.leftHud.mesh.visible = playing;
      const open = this.isMenuOpen();
      // keep the menu docked to the left hand (re-dock if the controller connects / disconnects)
      if (open && (this.leftHud.mesh.parent ? this.menuPanel.mesh.parent !== this.leftHud.mesh : this.menuPanel.mesh.parent !== this.scene)) {
        this._placeMenuPanel();
      }
      this.menuPanel.mesh.visible = open;
    }
    this._updateTarget();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.renderer.setAnimationLoop(null);
    this._ro?.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('wheel', this._onWheel);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerleave', this._onPointerLeave);
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    this.controls.dispose();
    this.renderer.dispose();
    el.remove();
    this.listeners.clear();
  }
}
