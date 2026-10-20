import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { CameraCollider } from './cameraCollision.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { STEP_FRACTION, World, isSaveData, parseTemplate } from './world.js';
import { canStand, stepSquirmies, stepSight, stepNimbus, stepSoloCreatures, stepDirt, stepGroups, stepRain, stepWater, stepSink, stepFog, stepNimbusDrift, stepWood, creatureEatNearby, SELECT_WAIT_TURNS } from './sim.js';
import { BLOCK, BLOCK_COLORS, TOOL, TOOLS, isCreature } from './tools.js';
import { getLogs, getLogVersion } from './debugLog.js';
import { claudePrompt } from './claudePrompt.js';
import { debugSections } from './debugSections.js';
import { BEHAVIOR, BUFF_TYPES, blockProps, canFly, canWalkOn, describeBuff, isSingleCreature, isChainCreature } from './blocks.js';
import { SELECT_GREEN } from './icons.js';
import { GRID, faceFromNormal, gridMode, isValidCell, onGridChange } from './lattice.js';
import { EDGE_SHADE, EDGE_WIDTH_CM, MATERIALS, cellFaces } from './geometry.js';
import {
  playPlace, playDelete, playTick, playResume, playLoad, playSave, playError, unlockAudio, setMuted,
  playReady, playGo, playBerryGrow, playSfx, playWait, playAssign, playCreatureDone, playCreatureTrapped, playCreatureDeath,
  setListener, beginTurnSounds, endTurnSounds, setMusicLevel, MUSIC_LEVEL,
} from './audio.js';
import { LeftHudPanel, RightHudPanel, MenuPanel, DebugTablet, dockAboveController } from './xrPanels.js';
import { menuModel, displayName, PAGE_SIZE, SPEED, BACKGROUNDS, XR_VIEWS, availableViews, parsePick, isDisabledChoice, focusables, sectionOf } from './menu.js';
import { GazeDwell, GazeReticle, IDLE_DISTANCE } from './gaze.js';
import { PhoneStereo, PHONE_AR_SESSION_INIT } from './phoneStereo.js';
import { Interlaced } from './interlaced.js';
import { CardboardRig, CameraFeed, enterCardboard, exitCardboard, isHeadsetBrowser, isPhone } from './cardboard.js';
import { loadOptionsCookie, saveOptionsCookie } from './optionsCookie.js';
import { listSaves, readSave, writeSave, normalizeSaveName, timestampName } from './saves.js';

const CM = 0.01; // world units are metres; lattice units are cm
const FPS_WINDOW_MS = 500; // Debug → Performance: FPS is averaged over this long
const COUNTDOWN_SECONDS = 3; // the page, New and Load all start with a T -3 … 0 countdown before play
const XR_RAY_LENGTH = 1.0; // 1 m
const GAZE_RAY_LENGTH = 2.0; // hands-free XR: how far the gaze reaches (tools and UI)
const SBS_EYE_SEPARATION = 0.064; // View Mode → 3D: SBS and 3D: Interlaced, m
// hands-free XR: the HUDs (and the menu above them) float this far ahead, this far below the eyes,
// and swing round to the front once the head has turned GAZE_DOCK_TURN away from them
const GAZE_DOCK_DISTANCE = 0.55;
const GAZE_DOCK_DROP = 0.2;
const GAZE_DOCK_TURN = THREE.MathUtils.degToRad(40);
const GAZE_DOCK_MOVE = 0.3; // m: …or once the head has moved this far
// a phone's XR view is smaller (and in a viewer blurrier) than a headset's: a bigger menu stays readable
const PHONE_MENU_SCALE = 1.5;
const _sbsSize = new THREE.Vector2();
const DESKTOP_RAY_LENGTH = 50;
const WHEEL_TOOL_REARM_MS = 200; // horizontal-scroll tool switching: quiet gap that ends one push
const BG = new THREE.Color('#1b2029');
// R3: the creature's first-person view: the camera sits between its eyes (its own frame, cm:
// x = right, y = up, z = front), and the right stick looks around by up to these angles
const POV_EYE = new THREE.Vector3(0, 0.15, 0.95);
const POV_MAX_PITCH = 1.3; // rad, up / down
const _povPos = new THREE.Vector3(), _povQ = new THREE.Quaternion(), _povLook = new THREE.Quaternion();
const _povTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // the camera looks down -z, a creature faces +z
const _povEuler = new THREE.Euler(0, 0, 0, 'YXZ');
// scratch for the listener (positional sound)
const _earPos = new THREE.Vector3(), _earFwd = new THREE.Vector3(), _earUp = new THREE.Vector3();
const _earQuat = new THREE.Quaternion(), _earScale = new THREE.Vector3();
/** Options → Background: Skybox: a 2:1 panorama wrapped all around the scene (loaded on first use). */
const SKYBOX_URL = new URL('../../img/skybox.jpg', import.meta.url).href;
const ORBIT_HEIGHT_CM = 100; // light 1 m above the scene
const ORBIT_RADIUS_CM = 300; // 3 m radius
const ORBIT_PERIOD_S = 60; // one revolution per minute
const GRAB_MIN_SCALE = 0.1; // two-hand zoom limits, relative to life size (1 lattice cm = 1 cm)
const GRAB_MAX_SCALE = 20;
const FLY_M_PER_WHEEL_PX = 0.00005; // zoomed all the way in, scrolling flies forward: ~0.5 cm per wheel notch
const FLY_M_PER_PAD_S = 0.08; // …and the gamepad's left stick flies up to 8 cm/s
// Select tool wireframes (selected / pointed-at creatures, the target cell and its pulses): thin tubes.
const SELECT_WIRE_RADIUS = EDGE_WIDTH_CM / 2;
const START_CAMERA = new THREE.Vector3(0.22, 0.26, 0.4).normalize().multiplyScalar(0.5); // 50 cm from origin

/** Thick wireframe of a block (the grid mode's cell) made from thin cylinders (visible in XR too). */
function makeWireframe(color, radiusCm) {
  const group = new THREE.Group();
  group.userData.material = new THREE.MeshBasicMaterial({ color, toneMapped: false });
  group.userData.radius = radiusCm;
  buildWireframe(group);
  group.visible = false;
  return group;
}

/** (Re)builds wireframe `group`'s tubes and corner balls around the active grid's cell. */
function buildWireframe(group) {
  for (const c of [...group.children]) {
    group.remove(c);
    c.geometry.dispose();
  }
  const { material: mat, radius: radiusCm } = group.userData;
  const seen = new Set();
  const up = new THREE.Vector3(0, 1, 0);
  const cyl = new THREE.CylinderGeometry(radiusCm, radiusCm, 1, 6, 1, true);
  const ball = new THREE.SphereGeometry(radiusCm, 8, 6);
  const verts = new Map();
  for (const f of cellFaces()) {
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
}

export class Engine {
  constructor(container) {
    this.container = container;
    this.listeners = new Set();
    this.state = {
      screen: 'playing',
      paused: false, // the game opens straight into a New scene, with a countdown
      menu: 'main', // 'main' | 'load' | 'save' | 'options'
      gridMode: gridMode(), // the world's grid mode (grids.js): chosen from New's dropdown, or by the save loaded
      soundOn: true, // Options → Sounds
      controlSchema: 'observer', // 'observer' (default) or 'creature' (L3 with a creature selected): controls.js
      musicOn: true, // Options → Music: plays while the game is running (quieter in the pause menu)
      gameTime: -COUNTDOWN_SECONDS, // whole seconds (turns) since New / Load; negative = countdown
      background: 'passthrough', // Options → Background: 'solid', 'skybox' or 'passthrough' (XR passthrough; solid elsewhere)
      materials: 'procedural', // Options → Materials: 'solid', 'simple' or 'procedural' shaders (geometry.js MATERIALS)
      ambientOcclusion: true, // Options → Ambient Occlusion: darker corners between blocks
      speed: SPEED.default, // Options → Speed: 0x–4x (0x: stopped), where 1x is 60 turns a minute (sets the turn and animation length)
      rain: true, // Options → Rain: random raindrops appear 1 m out every 10th turn
      fog: true, // Options → Fog: Fog template steps in New scenes
      debugMode: false, // Options → Debug: debug panel (HUD / XR tablet)
      refraction: true, // Options → Refraction: Crystal bends what's behind it (Off: just see-through, cheaper)
      smoothRendering: false, // Options → Rendering: Smooth (clusters drawn as merged, smoothed bodies) or Blocky (default)
      saves: null,
      savesError: null,
      page: 0,
      toolIndex: 0,
      inXR: false, // in an XR view (a WebXR session, or the handheld motion-sensor view)
      screenView: 'normal', // View Mode outside XR: 'normal', 'sbs' or 'interlaced' (see menu.js currentView)
      views: ['normal'], // View Mode: the views this device can show (menu.js availableViews)
      phone: false, // a phone / tablet: XR is Phone AR or Phone Viewer instead of HMD Stereo
      phoneStereo: true, // phone XR: two lens-corrected eyes for a viewer (Phone Viewer), else one view (Phone AR)
      handheld: false, // the motion-sensor XR view is showing (phones without WebXR AR)
      xrSupport: null, // truthy when this browser can start XR at all
      xrAR: false, // browser supports immersive-ar (passthrough), e.g. Quest Browser
      domOverlay: false, // the XR session shows the page's UI over the view (XR: Phone AR, see screenUI)
      xrVR: false, // browser supports immersive-vr, e.g. PC Chrome with a headset over Link
      blockCount: 0,
      blockCounts: {}, // block type -> how many are in the world (tool labels: "Stone (x100)")
      toast: null,
      gamepadAim: false, // aiming with a gamepad (crosshair at screen centre)
      menuFocus: null, // id of the menu item focused with the gamepad
      dropdown: null, // the menu dropdown whose list is open ('new' | 'view' | 'background'), see menu.js
      section: null, // the Options section open beneath its button ('controls' | 'video'), see menu.js
      selectPhase: 'select', // Select tool: 'select' (pick a creature) or 'target' (pick where it walks)
    };
    this._toastId = 0;
    this.turnSeconds = 60 / (SPEED.turnsPerMinute * SPEED.default);
    this.mouse = null;
    this.target = null;
    this.hands = { left: null, right: null };
    this._stickArmed = true;
    this._leftMenuWas = false;
    this._menuHover = null;
    this._hudHover = null;
    this._xrFrames = 0;
    this._grab = null;
    this.selected = []; // Select tool: the selected creatures (currently at most one)
    this._pulses = []; // Select tool: shrinking copies of the target wireframe, one per turn

    this._headset = isHeadsetBrowser();
    const phone = isPhone();
    this.state.phone = phone;
    this.state.views = availableViews({ phone, headset: this._headset, xrSupported: false });

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
    const inOptions = (s) => s.paused && s.menu === 'options';
    const wasInOptions = inOptions(this.state);
    this.state = { ...this.state, ...patch };
    if (wasInOptions && !inOptions(this.state)) this._saveOptions(); // left Options (Back, Esc, Resume, …)
    // the music plays while the game is running, at a quarter of its volume in the pause menu
    // (fades in / out / down / up as that changes)
    const s = this.state;
    setMusicLevel(s.musicOn && s.screen === 'playing' ? (s.paused ? MUSIC_LEVEL.paused : MUSIC_LEVEL.playing) : 0);
    for (const fn of this.listeners) fn();
  }

  /** The settings the Options menu controls, as saved to the options cookie. */
  static OPTION_KEYS = ['musicOn', 'soundOn', 'background', 'materials', 'ambientOcclusion', 'speed', 'rain', 'fog', 'debugMode', 'smoothRendering', 'refraction'];

  /** Options → Debug, or ` / ~ while playing: the Debug panel (XR: the debug tablet) on / off; remembered. */
  toggleDebug() {
    const on = !this.state.debugMode;
    this.setState({ debugMode: on });
    if (!on) claudePrompt.stopDictation();
    if (on && this._immersive) this._placeDebugTablet();
    this._saveOptions(); // (the menu saves on leaving Options; the key saves at once)
    console.info(`Debug mode ${on ? 'on' : 'off'}`);
  }

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
    if (bool('musicOn')) this.setState({ musicOn: saved.musicOn });
    if (bool('soundOn')) {
      setMuted(!saved.soundOn);
      this.setState({ soundOn: saved.soundOn });
    }
    if (BACKGROUNDS.includes(saved.background) || bool('passthrough')) {
      // (older settings stored passthrough on / off)
      this.setState({ background: BACKGROUNDS.includes(saved.background) ? saved.background : saved.passthrough ? 'passthrough' : 'solid' });
      this._applyBackground();
    }
    if (MATERIALS.includes(saved.materials) || bool('proceduralMaterials')) {
      // (older settings stored procedural on / off)
      this._setMaterials(MATERIALS.includes(saved.materials) ? saved.materials : saved.proceduralMaterials ? 'procedural' : 'solid');
    }
    if (bool('ambientOcclusion')) {
      this.world.materials.uniforms.uAO.value = saved.ambientOcclusion ? 1 : 0;
      this.setState({ ambientOcclusion: saved.ambientOcclusion });
    }
    if (bool('refraction')) {
      this.world.materials.setRefraction(saved.refraction);
      this.setState({ refraction: saved.refraction });
    }
    // older cookies stored turns per minute (0–240); anything above the max multiplier is one of those
    if (typeof saved.speed === 'number') this.setSpeed(saved.speed > SPEED.max ? saved.speed / SPEED.turnsPerMinute : saved.speed);
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
   * index, the size its cluster's (a Squirmy's length, a tree's Wood count, …).
   */
  _logEvent(kind, block, detail) {
    const inWorld = this.world.get(block.x, block.y, block.z) === block;
    const size = inWorld ? this.world.clusterOf(block).length : 1;
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

    const cam = new THREE.PerspectiveCamera(60, 1, 0.0025, 20) // near 0.25 cm: inside the camera clearance (cameraCollision.js);
    cam.position.copy(START_CAMERA);
    this.camera = cam;
    scene.add(cam);

    // Trackball: turns freely in every direction, over the poles and on round (the camera's
    // "up" turns with it; the world is a planet, so there's no fixed horizon to keep)
    const controls = new TrackballControls(cam, this.renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }; // left: tools
    controls.keys = ['', '', '']; // no A / S / D mode keys (the game uses the keyboard)
    controls.rotateSpeed = 5; // about as fast as the old orbit controls
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.3;
    controls.staticMoving = false; // eases out after a drag
    controls.dynamicDampingFactor = 0.15;
    controls.minDistance = 0.04;
    controls.maxDistance = 4;
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
    // sounds for things the simulation does on its own, each from where it happens
    const at = (cell) => this._soundAt(cell);
    this.world.on('berryGrow', (berry) => playBerryGrow(at(berry)));
    this.world.on('creatureArrived', (creature) => playCreatureDone(at(creature)));
    this.world.on('creatureTrapped', (creature) => playCreatureTrapped(at(creature)));
    this.world.on('creatureTurned', (creature) => playSfx('buzz', 150, at(creature)));
    // a creature moving under its own power: a Crawly skitters, a Buzzy buzzes, a Squirmy slithers
    const MOVE_SOUNDS = { [BLOCK.CRAWLY]: 'skitter', [BLOCK.BUZZY]: 'buzz', [BLOCK.SQUIRMY]: 'slither', [BLOCK.SLITHER]: 'slither' };
    this.world.on('creatureMoved', (creature) => playSfx(MOVE_SOUNDS[creature.type], 150, at(creature)));
    this.world.on('blockConsumed', ({ sound, block }) => {
      playSfx(sound, 90, at(block));
      // a creature eaten whole dies: a one-block creature (a Buzzy's head; not a body segment
      // bitten off), or a chain creature's last segment
      const dies = isSingleCreature(block.type) ? !block.segmentOf
        : isChainCreature(block.type) && (this.world.squirmyOf.get(block)?.segments.length ?? 1) <= 1;
      if (dies) playCreatureDeath(at(block));
    });
    this.world.on('blockExcreted', ({ sound, block }) => playSfx(sound, 90, at(block)));
    // event log (console, so it also shows in the debug panel): consume, excrete, buffs, behavior
    const nameOf = (type) => blockProps(type).name;
    this.world.on('blockConsumed', ({ by, block }) => this._logEvent('consume', by, `ate ${nameOf(block.type)}`));
    this.world.on('blockExcreted', ({ by, block }) => this._logEvent('excrete', by, `excreted ${nameOf(block.type)}`));
    this.world.on('buffAdded', ({ block, buff, refreshed }) => this._logEvent('buff', block, `${refreshed ? 'refreshed' : 'gained'} ${describeBuff(buff)}`));
    this.world.on('buffChargeUsed', ({ block, type, charges }) =>
      this._logEvent('buff', block, `used a ${BUFF_TYPES[type]?.name ?? type} charge (${charges} left)`));
    this.world.on('buffExpired', ({ block, type }) => this._logEvent('buff', block, `${BUFF_TYPES[type]?.name ?? type} wore off`));
    this.world.on('behaviorChanged', ({ block, from, to }) => this._logEvent('behavior', block, `${from} → ${to}`));
    this.world.on('blockBlown', ({ sound, block }) => playSfx(sound, 250, at(block))); // many clouds at once: one breeze
    this.world.on('blockVanished', () => this._syncCount());
    this.world.on('creatureFreed', (creature) => playCreatureDone(at(creature))); // same "made it" sound as arriving
    this.world.on('creatureDied', (died) => {
      playCreatureDeath(at(died));
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
    // Select tool: green wireframes around selected creatures, a lighter one around a creature
    // you could select, and the target-cell indicator (plus its per-turn shrinking copies)
    this.selectHLs = [];
    this.hoverHLs = []; // light green, around every block of a creature you could select
    this._hoverCreature = null;
    this.targetHL = makeWireframe(SELECT_GREEN, SELECT_WIRE_RADIUS);
    root.add(this.targetHL);
    // a new grid mode (World.setGridMode): every wireframe takes the new block shape
    onGridChange(() => {
      for (const hl of [this.placeHL, this.deleteHL, this.targetHL, ...this.selectHLs, ...this.hoverHLs, ...this._pulses.map((p) => p.obj)]) buildWireframe(hl);
      // (after every other listener: the tool icons' own World must have its new shape first)
      queueMicrotask(() => this.setState({ gridMode: gridMode() }));
    });

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
    this._tabletResizing = false; // the right trigger is dragging the tablet's resize handle
    this._tabletHandleHover = false; // the right controller ray is on the tablet's resize handle
    try {
      // the tablet's size (drag its corner) is remembered in this browser
      const size = JSON.parse(localStorage.getItem('xrTabletSize'));
      if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) this.debugTablet.setSize(size.width, size.height);
    } catch {}
    this._tabletHover = false;
    this._tabletHandleHover = false; // right controller ray is on the tablet

    // hands-free XR (no controllers): the gaze points, a 1 s stare clicks (gaze.js); the HUDs
    // float ahead in this group instead of riding on the controllers
    this.gazeDwell = new GazeDwell();
    this.reticle = new GazeReticle();
    this.scene.add(this.reticle.group);
    this.gazeDock = new THREE.Group();
    this.gazeDock.name = 'xr-gaze-dock';
    this.scene.add(this.gazeDock);
    this._gazeDockAnchor = null; // { pos, yaw }: where the dock is heading (it eases there)
    // View Mode → XR: Phone Viewer (two eyes on a phone AR session) and the handheld view
    this.phoneStereo = new PhoneStereo(r, this.scene);
    // XR: Phone AR's DOM overlay: a tap on the menus or HUD (anything but the empty overlay
    // itself) is theirs, not also a tap into the scene (which uses the tool)
    this._onBeforeXRSelect = (e) => {
      if (e.target !== this._uiRoot) e.preventDefault();
    };
    this._uiRoot?.addEventListener('beforexrselect', this._onBeforeXRSelect);
    this.cardboard = new CardboardRig(r, this.camera);
    this.cameraFeed = new CameraFeed(); // the handheld view's passthrough: the rear camera

    for (let i = 0; i < 2; i++) {
      const ctrl = r.xr.getController(i);
      const grip = r.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      const slot = { ctrl, grip, source: null, gripHeld: false };
      ctrl.addEventListener('connected', (e) => {
        // articulated hands and screen taps aren't controllers: they leave the gaze in charge,
        // and their select (pinch, tap) clicks what it is on (see selectstart)
        if (e.data.hand || e.data.targetRayMode === 'screen' || e.data.targetRayMode === 'transient-pointer') return;
        slot.source = e.data;
        const hand = e.data.handedness === 'left' ? 'left' : 'right';
        this.hands[hand] = slot;
        if (hand === 'right') {
          ctrl.add(this.rayLine);
          grip.add(this.rightHud.mesh);
          dockAboveController(this.rightHud.mesh);
          this.scene.add(this.rayDot);
        } else {
          grip.add(this.leftHud.mesh);
          dockAboveController(this.leftHud.mesh);
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
        else if (!slot.source && this._gazeMode()) this._onGazeTap();
      });
      ctrl.addEventListener('selectend', () => {
        if (this.hands.right === slot) {
          this._sliderDrag = null;
          this._endTabletResize();
        }
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
    const views = availableViews({ phone: this.state.phone, headset: this._headset, xrSupported: ar || vr });
    this.setState({ xrAR: ar, xrVR: vr, xrSupport: ar || vr ? (ar ? 'immersive-ar' : 'immersive-vr') : null, views });
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
      this.controls?.handleResize(); // trackball maths use the canvas size
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

    // drag a save file or a template onto the page to load it (see openDroppedFile)
    this._onDragOver = (e) => {
      if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
      e.preventDefault(); // allow the drop
      e.dataTransfer.dropEffect = 'copy';
    };
    this._onDrop = (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault(); // don't let the browser open the file
      if (this.state.inXR) return;
      this.openDroppedFile(file);
    };
    window.addEventListener('dragover', this._onDragOver);
    window.addEventListener('drop', this._onDrop);
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
    if (s.paused && !typing && this._keyMenu(e)) return; // arrows / Enter / Space / Backspace in the pause menu
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      if (!s.paused) this.pause();
      else if (s.menu !== 'main') this.menuAction('back');
      else this.resume();
      return;
    }
    if (s.paused) return;
    if (e.key === '`' || e.key === '~' || e.code === 'Backquote') {
      // ` / ~: the Debug panel on / off
      e.preventDefault();
      this.toggleDebug();
      playTick();
      return;
    }
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

  /**
   * Keyboard navigation of the pause menu: Up / Down (or W / S) move the focus, Left / Right (or A / D)
   * nudge a focused slider, Enter / Space press the focused button, Backspace (or Esc) goes back.
   * Returns true when the key was used. With nothing focused, Enter keeps its old meaning (Back / Resume).
   */
  _keyMenu(e) {
    const s = this.state;
    const model = menuModel(s);
    const items = focusables(model);
    if (!items.length) return false;
    const idx = items.findIndex((it) => it.id === s.menuFocus);
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const up = k === 'ArrowUp' || k === 'w', down = k === 'ArrowDown' || k === 's';
    if (up || down) {
      e.preventDefault();
      const next = idx < 0 ? (down ? 0 : items.length - 1) : (idx + (down ? 1 : -1) + items.length) % items.length;
      this.setState({ menuFocus: items[next].id });
      playTick();
      return true;
    }
    const left = k === 'ArrowLeft' || k === 'a', right = k === 'ArrowRight' || k === 'd';
    const slider = items[idx]?.slider;
    if (slider && (left || right)) {
      e.preventDefault();
      this._setSlider(items[idx].id, slider.value + (right ? 1 : -1) * slider.step); // one notch
      playTick();
      return true;
    }
    // Left: closes an open dropdown, else the open section the focus is in, else like the Back button
    // (Resume on the main screen); Right on a button with an arrow (a submenu) or a closed dropdown or
    // section opens it, and on a toggle (On / Off, …) presses it
    if ((left || k === 'Escape' || k === 'Backspace') && s.dropdown) {
      e.preventDefault();
      this._closeDropdown();
      return true;
    }
    if ((left || k === 'Escape' || k === 'Backspace') && sectionOf(model, s.menuFocus)) {
      e.preventDefault();
      this._closeSection();
      return true;
    }
    if (left) {
      e.preventDefault();
      if (s.menu !== 'main') this._keyMenuGo('back');
      else this.resume();
      return true;
    }
    const it = items[idx];
    if (right && (it?.submenu || it?.toggle || (it?.dropdown && !it.dropdown.open) || (it?.section && !it.section.open))) {
      e.preventDefault();
      this._keyMenuGo(items[idx].id);
      return true;
    }
    if (k === 'Escape' && idx >= 0 && s.menu !== 'main') {
      e.preventDefault();
      this._keyMenuGo('back'); // keyboard-driven: keep a focus on the screen we return to
      return true;
    }
    if (k === 'Backspace') {
      e.preventDefault();
      if (s.menu !== 'main') this._keyMenuGo('back');
      return true;
    }
    if ((k === 'Enter' || k === ' ') && idx >= 0) {
      e.preventDefault();
      if (!slider) this._keyMenuGo(items[idx].id);
      return true;
    }
    return false;
  }

  /**
   * Presses a menu button from the keyboard. On opening another screen it focuses that screen's first item;
   * on going back, the button that led to the screen just left (e.g. Video →).
   */
  _keyMenuGo(id) {
    const before = this.state.menu;
    this.menuAction(id);
    const s = this.state;
    const pick = parsePick(id);
    if (pick && s.paused) return this.setState({ menuFocus: pick.id }); // back on the dropdown's button
    if (!s.paused || s.menu === before) return;
    const items = focusables(menuModel(s));
    const focus = items.find((it) => it.id === before) ?? items.find((it) => it.id !== 'back') ?? items[0];
    this.setState({ menuFocus: focus?.id ?? null });
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
    this.setState({ paused: true, menu: 'main', page: 0, dropdown: null, menuFocus: this.state.gamepadAim ? 'resume' : null });
    if (this._immersive) this._placeMenuPanel();
    playTick();
  }

  resume() {
    if (this.state.screen !== 'playing') return;
    this.setState({ paused: false, menu: 'main' });
    playResume();
  }

  /** Tools belong to the Observer: under Creature controls there are none (no using, aiming or switching them). */
  toolsAvailable(s = this.state) {
    return s.controlSchema !== 'creature';
  }

  cycleTool(dir) {
    if (!this.toolsAvailable()) return;
    const n = TOOLS.length;
    this.selectTool((this.state.toolIndex + dir + n) % n);
  }

  selectTool(i) {
    if (i === this.state.toolIndex || !this.toolsAvailable()) return;
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
    if (!this.toolsReady() || !this.toolsAvailable()) return false;
    const tool = TOOLS[this.state.toolIndex];
    const t = this.target;
    if (tool.id === TOOL.SELECT) return this._useSelect(t);
    if (!t) return false;
    let ok = false;
    if (tool.block && t.place && t.placeFree) {
      ok = this.world.add(t.place[0], t.place[1], t.place[2], tool.block);
      if (ok) playPlace(this._soundAt({ x: t.place[0], y: t.place[1], z: t.place[2] }));
    } else if (tool.id === TOOL.DELETE && t.block) {
      const where = this._soundAt(t.block);
      ok = this.world.remove(t.block.x, t.block.y, t.block.z);
      if (ok) playDelete(where);
    }
    if (ok) {
      this._syncCount();
      this._pulse(0.35, 25);
    }
    return ok;
  }

  // ---------------------------------------------------------------- Select tool
  // Two phases: 'select' (click a creature to select it) and 'target' (click an empty cell on
  // a surface the creature can walk on: it Walks there and stays selected, so it can be sent
  // on again; clicking empty space or anything else deselects it).
  // Clicking anything else in 'target' (or empty space) just clears the selection.

  /** HUD label for the current tool (the Select tool shows its phase). */
  toolLabel(s = this.state) {
    if (!this.toolsAvailable(s)) {
      // Creature controls: no tools, just who you're controlling
      const c = this._controlled?.[0];
      return c ? `Controlling ${blockProps(c.type).name}` : 'Creature controls';
    }
    const tool = TOOLS[s.toolIndex];
    if (tool.block) return `${tool.label} (x${s.blockCounts[tool.block] ?? 0})`; // e.g. "Stone (x100)"
    if (tool.id !== TOOL.SELECT) return tool.label;
    return s.selectPhase === 'target' ? 'Select: pick a target' : 'Select';
  }

  /**
   * Debug panel content: properties of the selected creature, or else of the block under the
   * pointer. Returns { title, rows: [[key, value]] }.
   */
  /** Debug → Performance as [label, text] rows (the XR debug tablet). */
  performanceRows() {
    const ms = (v, digits) => (v == null ? '—' : `${v.toFixed(digits)} ms`);
    return [
      ['FPS', this.fps.toFixed(0)],
      ['Turn', ms(this.turnMs, 1)],
      ['Anim', ms(this.animMs, 2)],
      ['Render', ms(this.renderMs, 2)],
    ];
  }

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
    const cluster = this.world.clusterOf(b); // its cluster, right now
    rows.push(['Cluster size', `${cluster.length} block${cluster.length === 1 ? '' : 's'}`]);
    if (b.movedTurn != null) rows.push(['Last moved', `turn ${b.movedTurn}`]);
    rows.push(['Buffs', b.buffs?.length ? b.buffs.map(describeBuff).join(', ') : 'none']);
    if (isCreature(b.type)) rows.push(['Flies', blockProps(b.type).fly ? 'yes (its type)' : canFly(b) ? 'yes (Flight buff)' : 'no']);
    rows.push(['Inventory', b.inventory ? (TOOLS.find((t) => t.block === b.inventory)?.label ?? b.inventory) : 'empty']);
    if (b.type === BLOCK.WOOD || isCreature(b.type)) {
      rows.push(['Cluster slots', `${cluster.filter((x) => x.inventory).length} of ${cluster.length} full`]);
    }
    if (isChainCreature(b.type)) {
      const segs = this.world.squirmyOf.get(b)?.segments ?? [b];
      const i = segs.indexOf(b);
      rows.push(['Segment', `${i + 1} of ${segs.length}${b.isHead ? ' (head)' : b.isTail ? ' (tail)' : ''}`]);
      if (!b.isHead) rows.push(['Behavior', `${segs[0].behavior ?? '—'} (the head's)`]);
    }
    if (isCreature(b.type) && (b.isHead)) {
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
    // Creature controls follow the selection; with nothing selected, back to Observer
    if (this.state.controlSchema === 'creature') {
      if (list.length) this._setControlled(list);
      else this.setControlSchema('observer');
    }
    const phase = list.length ? 'target' : 'select';
    if (this.state.selectPhase !== phase) this.setState({ selectPhase: phase });
  }

  /**
   * Gamepad / Touch A: each selected creature eats the block in front of it (its `front`
   * side; for a Squirmy, its head's), or else any other edible block next to it, if its
   * cluster has an inventory slot free. If none of them can, "ineffective" plays.
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
//    if (c.behavior === BEHAVIOR.TRAPPED) continue; // can't wander off while walled in
      c.behavior = behavior;
      c.isAssignedBehavior = true;
      delete c.waitTurns; // X's Wait lasts until deselected
      if (behavior === BEHAVIOR.WANDER) {
        c.heldBehavior = BEHAVIOR.WANDER; // what it resumes if put back in Wait and deselected
        delete c.walkTarget;
        delete c.walkStuck;
      }
    }
    const where = this._soundAt(this.selected[0]);
    if (behavior === BEHAVIOR.WANDER) playAssign(where);
    else playWait(where);
    return true;
  }

  // ---------------------------------------------------------------- creature view (R3)

  /**
   * R3: switches to the selected creature's first-person view (the camera between its eyes,
   * turning with it as it moves and turns; the right stick looks around), or back to the
   * orbiting camera where it was. Not in XR (the headset is the camera there).
   */
  toggleCreatureView() {
    if (this._pov) return this._endCreatureView();
    const creature = this.selected[0];
    if (!creature || this._immersive) {
      playSfx('ineffective', 0);
      return false;
    }
    this._pov = {
      creature, yaw: 0, pitch: 0,
      saved: { pos: this.camera.position.clone(), target: this.controls.target.clone(), up: this.camera.up.clone() },
    };
    this.controls.enabled = false;
    this.setState({ creatureView: true });
    this.toast(`${blockProps(creature.type).name}'s view (R3: back)`);
    playTick();
    return true;
  }

  /** Back to the orbiting camera, where it was before the creature's view. */
  _endCreatureView() {
    const p = this._pov;
    if (!p) return false;
    this._pov = null;
    const { pos, target, up } = p.saved;
    this.camera.position.copy(pos);
    this.camera.up.copy(up);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this._camSafe = null; // a jump: no collision sweep from the creature's head
    this.controls.enabled = true;
    this.controls.update();
    this.setState({ creatureView: false });
    playTick();
    return true;
  }

  /** Per frame: the camera rides between the creature's eyes, facing its front (plus the look-around). */
  _updateCreatureView(now) {
    const { creature: c, yaw, pitch } = this._pov;
    if (this.world.get(c.x, c.y, c.z) !== c) return this._endCreatureView(); // it's gone (died, deleted, a new world)
    // its frame as drawn: the eyes' rotation (eased as it turns) and its sliding position
    const q = this.world.eyes.state.get(c)?.q ?? _povQ.identity();
    this.world.renderedPosition(c, now, _povPos);
    _povPos.add(POV_EYE.clone().multiplyScalar(this.world.drawnScale(c, now)).applyQuaternion(q));
    this.camera.position.copy(this.worldRoot.localToWorld(_povPos));
    _povLook.setFromEuler(_povEuler.set(pitch, yaw, 0));
    this.camera.quaternion.copy(this.worldRoot.getWorldQuaternion(_povQ)).multiply(q).multiply(_povTurn).multiply(_povLook);
    this.camera.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
  }

  /** Right stick in the creature's view: turn the head (yaw: any way round, pitch: up to POV_MAX_PITCH). */
  _lookAround(dt, rx, ry) {
    const p = this._pov;
    p.yaw -= rx * 2.2 * dt;
    p.pitch = THREE.MathUtils.clamp(p.pitch - ry * 1.6 * dt, -POV_MAX_PITCH, POV_MAX_PITCH);
  }

  // ---------------------------------------------------------------- control schemas

  /** L3: Observer → Creature controls (needs a selected creature), or back. */
  toggleControlSchema() {
    if (this.state.controlSchema === 'creature') return this.setControlSchema('observer');
    if (!this.selected.length) {
      playSfx('ineffective', 0);
      return false;
    }
    return this.setControlSchema('creature');
  }

  /** Switches control schema (controls.js): 'creature' puts the selected creatures under the player's control. */
  setControlSchema(id) {
    if (this.state.controlSchema === id) return false;
    this._setControlled(id === 'creature' ? this.selected : []);
    this.setState({ controlSchema: id });
    this.toast(id === 'creature' ? 'Creature controls: the left stick moves the selected creature' : 'Observer controls');
    playTick();
    return true;
  }

  /** The creatures the player controls (Creature controls): flagged for the sim (isControlled, steer). */
  _setControlled(list) {
    for (const c of this._controlled ?? []) {
      delete c.isControlled;
      delete c.steer;
    }
    this._controlled = [...list];
    for (const c of this._controlled) c.isControlled = true;
  }

  /**
   * Creature controls: the left stick (`sx`, `sy`: right, down) steers each controlled
   * creature relative to the camera: up is away from the camera, right is screen right. A
   * walker's direction is kept along the ground (perpendicular to "up", away from the world's
   * centre); a flyer goes straight where the camera looks. Kept (`creature.steer`) until its
   * next turn uses it (sim: steeredCell), so a quick flick between turns still counts.
   */
  _steerControlled(sx, sy) {
    if (!sx && !sy) return;
    const toLattice = this.worldRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
    const look = this.camera.getWorldDirection(new THREE.Vector3()).applyQuaternion(toLattice);
    const screenRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).applyQuaternion(toLattice);
    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).applyQuaternion(toLattice);
    for (const c of this._controlled ?? []) {
      const fwd = look.clone(), right = screenRight.clone();
      if (!canFly(c)) {
        const up = new THREE.Vector3(c.x, c.y, c.z);
        if (up.lengthSq() < 1e-6) up.set(0, 1, 0);
        up.normalize();
        fwd.addScaledVector(up, -fwd.dot(up));
        // looking straight down at it: "forward" is the screen's up instead
        if (fwd.lengthSq() < 0.01) fwd.copy(screenUp).addScaledVector(up, -screenUp.dot(up));
        right.addScaledVector(up, -right.dot(up));
      }
      const dir = right.normalize().multiplyScalar(sx).addScaledVector(fwd.normalize(), -sy);
      if (dir.lengthSq() < 1e-6) continue;
      dir.normalize();
      c.steer = [dir.x, dir.y, dir.z];
    }
  }

  /**
   * Gamepad X: toggles Wait for the selected creatures. If they are all waiting, each resumes
   * what it was doing before (its `heldBehavior`: Wander, or Walk on to its target); otherwise
   * each one not yet waiting remembers what it was doing and waits, until X again (or it is
   * deselected). Plays wait.wav / assign.wav, or ineffective.wav with nothing selected.
   */
  selectedToggleWait() {
    if (!this.selected.length || !this.toolsReady()) {
      playSfx('ineffective', 0);
      return false;
    }
    const resume = this.selected.every((c) => c.behavior === BEHAVIOR.WAIT);
    for (const c of this.selected) {
      delete c.waitTurns; // X's Wait (and its end) is up to the player, not a timer
      c.isAssignedBehavior = true;
      if (resume) {
        const next = c.heldBehavior && c.heldBehavior !== BEHAVIOR.WAIT ? c.heldBehavior : BEHAVIOR.WANDER;
        c.behavior = next === BEHAVIOR.WALK && !c.walkTarget ? BEHAVIOR.WANDER : next;
        c.heldBehavior = c.behavior; // what it carries on with once deselected
      } else if (c.behavior !== BEHAVIOR.WAIT) {
        c.heldBehavior = c.behavior;
        c.behavior = BEHAVIOR.WAIT;
      }
    }
    const where = this._soundAt(this.selected[0]);
    if (resume) playAssign(where);
    else playWait(where);
    return true;
  }

  /**
   * Gamepad / Touch B: each selected creature excretes the item in its tail's inventory slot
   * (World.excrete on its cluster). If none of them can, "ineffective" plays.
   */
  selectedExcrete() {
    if (!this.selected.length || !this.toolsReady()) return false;
    let did = false;
    for (const c of this.selected) {
      if (this.world.excrete(this.world.clusterOf(c), 'excrete')) did = true;
    }
    if (did) this._syncCount();
    else playSfx('ineffective', 0);
    return did;
  }

  /** A cell a selected creature can be sent to: empty, next to the pointed-at walking surface. */
  _isSelectTarget(t) {
    if (!t?.block || !t.place || !t.placeFree) return false;
    // a surface the selected creature walks on, with room for it beside it
    return this.selected.some((creature) => (canWalkOn(creature.type, t.block.type) || canFly(creature)) && canStand(this.world, creature, ...t.place));
  }

  /** The creature a block belongs to: a one-block creature itself, a Buzzy segment's or Squirmy segment's head. Else null. */
  _creatureOf(block) {
    if (block?.segmentOf) return block.segmentOf; // a Buzzy's body segment: the Buzzy
    if (isSingleCreature(block?.type)) return block;
    if (isChainCreature(block?.type)) return this.world.squirmyOf.get(block)?.segments[0] ?? block;
    return null;
  }

  /** Every block of a creature: a Squirmy's or segmented Buzzy's whole body, or the one block. */
  _bodyOf(creature) {
    if (creature.segments?.length) return [creature, ...creature.segments]; // a Buzzy with body segments
    return isChainCreature(creature.type) ? this.world.squirmyOf.get(creature)?.segments ?? [creature] : [creature];
  }

  _useSelect(t) {
    // clicking a creature (any block of it) selects it (in either phase:
    // in 'target' it swaps the selection)
    const creature = this._creatureOf(t?.block);
    if (creature) {
      if (this.selected.length === 1 && this.selected[0] === creature) return false;
      this._setSelected([creature]);
      playWait(this._soundAt(creature)); // selecting puts it in Wait
      return true;
    }
    if (!this.selected.length) return false;
    if (!this._isSelectTarget(t)) {
      // clicked something that is neither a creature nor a valid target (or empty space):
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
    playAssign(this._soundAt({ x, y, z }));
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
    p.t0 = this.world.time;
  }

  /** Per frame: selection wireframes follow their (possibly sliding) creatures; pulses shrink. */
  _updateSelectionVisuals(now) {
    // a selected creature that was deleted, or changed type, drops out of the selection
    const alive = this.selected.filter((creature) => this.world.get(creature.x, creature.y, creature.z) === creature && this._creatureOf(creature));
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
    const watched = this._pov?.creature; // (seen from inside, its own wireframe would frame the view)
    place(this.selectHLs, this.selected.flatMap((creature) => this._bodyOf(creature)).filter((b) => b !== watched), SELECT_GREEN, SELECT_WIRE_RADIUS, 1.06);
    place(this.hoverHLs, this._hoverCreature ? this._bodyOf(this._hoverCreature) : [], '#9be8a8', SELECT_WIRE_RADIUS * 0.8, 1.04);
    for (const p of this._pulses) {
      if (!p.obj.visible) continue;
      const k = (now - p.t0) / (this.world.stepSeconds * 1000);
      if (k >= 1) p.obj.visible = false;
      else p.obj.scale.setScalar(1 - k); // (it moves with the target wireframe: _showHighlight)
    }
  }

  /**
   * Left HUD "Mean Diameter": the diameter of a solid ball holding `count` blocks. Each
   * block takes up its grid's cell volume (GRID.volumeCm3), so the ball's volume is count * that and
   * d = 2 * (3 * V / 4π)^(1/3). Returns cm.
   */
  static meanDiameter(count) {
    return 2 * Math.cbrt((3 * GRID.volumeCm3 * count) / (4 * Math.PI));
  }

  /** Formats a Mean Diameter for the HUD, e.g. "Ø 23.4 cm". */
  static formatDiameter(count) {
    return `${Engine.meanDiameter(count).toFixed(1)} cm`;
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
    this._resumeTime = 0; // Load: the saved game time, taken up when the countdown ends
    this.setState({ gameTime: -COUNTDOWN_SECONDS });
  }

  /** The game time to save: the current turn (during a countdown, the time it will resume at). */
  _savedGameTime() {
    return this.state.gameTime >= 0 ? this.state.gameTime : this._resumeTime || 0;
  }

  /** Game clock: runs only while playing (not while the menu is open). One turn per turnSeconds (Options → Speed). */
  /**
   * Options → Fog: on, New scenes include the template's Fog steps; off, they're skipped (Fog
   * already in the world stays).
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

  /**
   * Options → Speed: sets the speed multiplier (1x = 60 turns a minute), and with it the turn
   * and animation length. 0x: no turns at all (the simulation stands still; the tools still
   * work, their animations at the 1x pace).
   */
  setSpeed(multiplier) {
    const n = Number(multiplier);
    const raw = THREE.MathUtils.clamp(Number.isFinite(n) ? n : SPEED.default, SPEED.min, SPEED.max);
    const v = Math.round(raw / SPEED.step) * SPEED.step; // snap to the slider's steps
    this.turnSeconds = v > 0 ? 60 / (SPEED.turnsPerMinute * v) : Infinity;
    this.world.stepSeconds = STEP_FRACTION * (v > 0 ? this.turnSeconds : 60 / SPEED.turnsPerMinute);
    if (v !== this.state.speed) this.setState({ speed: v });
  }

  _advanceClock(dt) {
    const s = this.state;
    if (s.screen !== 'playing' || s.paused) return;
    // the countdown ticks at the 1x pace when Speed is 0x (else it would never start)
    const turnLength = Number.isFinite(this.turnSeconds) ? this.turnSeconds : s.gameTime < 0 ? 60 / SPEED.turnsPerMinute : Infinity;
    if (!Number.isFinite(turnLength)) return (this._clock = 0); // 0x: no turns (and none saved up for later)
    this._clock = (this._clock || 0) + dt;
    while (this._clock >= turnLength) {
      this._clock -= turnLength;
      const turn = this.state.gameTime + 1;
      this.setState({ gameTime: turn });
      if (turn < 0) playReady(); // countdown…
      else if (turn === 0) {
        playGo(); // …go: tools work from here, the simulation from the next turn
        if (this._resumeTime > 0) {
          this.setState({ gameTime: this._resumeTime }); // a loaded save carries on from its time
          this._resumeTime = 0;
        }
      }
      else {
        const t0 = performance.now();
        beginTurnSounds(); // the turn's sounds are collected…
        try {
          this._turn(turn);
        } finally {
          endTurnSounds(turnLength); // …then each plays as often as it happened, spread over the turn
        }
        this.turnMs = performance.now() - t0; // Debug → Performance
      }
    }
  }

  /** Everything that happens once per turn (`turn` = 1, 2, 3… since New / Load). */
  _turn(turn) {
    this.world.turn = turn; // moves this turn are stamped with it (Water settling)
    this.world.trimChangeLog(); // the change log only needs to reach back to the oldest stuck rule
    this.world.tickBuffs(); // buffs count down a turn (and wear off)
    const moved = stepGroups(this.world); // detached groups fall toward the origin first…
    for (const w of stepWater(this.world, moved)) moved.add(w); // …then Water flows…
    for (const s of stepSink(this.world, moved)) moved.add(s); // …sinkable creatures (Crawlies) sink through Water…
    for (const f of stepFog(this.world, moved)) moved.add(f); // …Fog clusters settle down, whole…
    for (const n of stepNimbusDrift(this.world, moved)) moved.add(n); // …Nimbus clouds drift west…
    stepSoloCreatures(this.world, moved); // …then one-block creatures (one that just fell with its group waits)…
    stepSquirmies(this.world, moved); // …and Squirmies crawl as chains, head first…
    stepSight(this.world); // …and every creature clears the Fog it can see (it shrinks away, then goes)…
    stepWood(this.world, turn); // …then watered trees grow Wood (or Berries)…
    stepDirt(this.world, turn); // …then Dirt soaks up leftover settled Water and turns to Moss (Plop: to Wood)…
    if (this.state.rain) stepRain(this.world, turn); // …a raindrop appears far out now and then (Options → Rain)…
    stepNimbus(this.world, turn); // …and every 3rd turn each Nimbus may rain one Water below it
    this._syncCount(); // rain, Nimbus and growth add blocks: keep the HUD's count (and diameter) current
    if (this.targetHL.visible) this._pulseTarget(); // Select tool: a turn tick on the pointed-at target
  }

  /**
   * A new world from `template` (default: NEW_SCENE_TEMPLATE) in grid mode `grid` (grids.js;
   * default: the current one); `name`: where it came from, for the message.
   */
  newScene(template = undefined, name = null, grid = gridMode()) {
    this._resetClock();
    this.world.setGridMode(grid);
    this._resetPlayerView();
    this.world.generateNew(template);
    this._syncCount();
    this._startPlaying();
    playLoad();
    if (name) this.toast(`New world from template "${name}"`);
  }

  /**
   * A file dropped on the page: a save file (World.toJSON) is loaded; a template (see
   * parseTemplate) generates a new world from it; anything else gets an error message.
   */
  async openDroppedFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return this.toast(`"${file.name}" isn't a JSON file`, 'error');
    }
    if (isSaveData(data)) return this.importJSON(data, file.name);
    const { template, grid, error } = parseTemplate(data);
    if (template) return this.newScene(template, file.name, grid ?? gridMode());
    this.toast(`"${file.name}" isn't a save file or a template (${error})`, 'error');
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
      await writeSave(name, this.exportJSON());
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
      const time = Number(data?.gameTime);
      if (Number.isFinite(time) && time > 0) this._resumeTime = Math.floor(time); // resumes after the countdown
      this._resetPlayerView();
      this._syncCount();
      this._startPlaying();
      playLoad();
      this.toast(`Loaded ${loaded} blocks from "${displayName(name)}"${skipped ? ` (${skipped} invalid skipped)` : ''}`);
    } catch (e) {
      this.toast(e.message || 'Invalid save file', 'error');
    }
  }

  /** The save file: the world's blocks, plus the game time (turns played). */
  exportJSON() {
    return { ...this.world.toJSON(), gameTime: this._savedGameTime() };
  }

  setSound(on) {
    setMuted(!on);
    this.setState({ soundOn: on });
    if (on) playTick();
  }

  menuAction(id, arg) {
    const s = this.state;
    // Resume, New, Load-file and Save play their own sounds; everything else ticks.
    if (!/^(resume|savenew|save:|load:|pick:new:)/.test(id)) playTick();
    const pick = parsePick(id);
    if (pick) {
      if (isDisabledChoice(menuModel(s), id)) return; // a choice this device can't use
      // a choice from a dropdown's list, which then closes
      this.setState({ dropdown: null });
      if (pick.id === 'background') return this._setBackground(pick.choice);
      if (pick.id === 'materials') return this._setMaterials(pick.choice);
      if (pick.id === 'view') return this.selectView(pick.choice);
      if (pick.id === 'new') return this.newScene(undefined, null, pick.choice); // New: a world in the grid mode picked
      return;
    }
    // New, View Mode, Background and Materials open (or close) their dropdowns; any other button closes one
    if (id === 'new' || id === 'view' || id === 'background' || id === 'materials') return this.setState({ dropdown: s.dropdown === id ? null : id });
    if (s.dropdown) this.setState({ dropdown: null });
    if (id === 'resume') return this.resume();
    if (id === 'load' || id === 'save') {
      this.setState({ menu: id, page: 0 });
      return this.refreshSaves();
    }
    if (id === 'options') return this.setState({ menu: 'options', section: null });
    // Controls and Video open (or close) their sections, closing the other one
    if (id === 'controls' || id === 'video') return this.setState({ section: s.section === id ? null : id });
    if (id === 'sound') return this.setSound(!s.soundOn);
    if (id === 'music') return this.setState({ musicOn: !s.musicOn });
    if (id === 'ao') {
      const on = !s.ambientOcclusion;
      this.world.materials.uniforms.uAO.value = on ? 1 : 0;
      return this.setState({ ambientOcclusion: on });
    }
    if (id === 'refraction') {
      const on = !s.refraction;
      this.world.materials.setRefraction(on);
      return this.setState({ refraction: on });
    }
    if (id === 'rain') return this.setState({ rain: !s.rain });
    if (id === 'fog') return this.setFog(!s.fog);
    if (id === 'debug') return this.toggleDebug();
    if (id === 'rendering') {
      this.world.setSmoothRendering(!s.smoothRendering); // Smooth: clusters drawn as merged, smoothed bodies
      return this.setState({ smoothRendering: !s.smoothRendering });
    }
    if (id === 'back') return this.setState({ menu: 'main', page: 0 });
    if (id === 'prev') return this.setState({ page: Math.max(0, s.page - 1) });
    if (id === 'next') {
      const pages = Math.ceil((s.saves?.length || 0) / PAGE_SIZE);
      return this.setState({ page: Math.min(pages - 1, s.page + 1) });
    }
    if (id === 'savenew') return this.saveAs(arg);
    if (id.startsWith('save:')) return this.saveAs(id.slice(5));
    if (id.startsWith('load:')) return this.loadFile(id.slice(5));
  }

  /** Closes the open Options section, focusing its button again. */
  _closeSection() {
    const { section } = this.state;
    if (!section) return;
    this.setState({ section: null, menuFocus: this.state.menuFocus ? section : null });
    playTick();
  }

  /** Closes the open menu dropdown, focusing its button again. */
  _closeDropdown() {
    const { dropdown } = this.state;
    if (!dropdown) return;
    this.setState({ dropdown: null, menuFocus: this.state.menuFocus ? dropdown : null });
    playTick();
  }

  /** Options → Video → Materials: 'solid', 'simple' or 'procedural' (recompiles the block shaders). */
  _setMaterials(level) {
    if (!MATERIALS.includes(level)) return;
    this.world.materials.setMaterials(level);
    this.setState({ materials: level });
  }

  /** Options → Video → Background: 'solid', 'skybox' or 'passthrough'. */
  _setBackground(next) {
    if (!BACKGROUNDS.includes(next)) return;
    const s = this.state;
    this.setState({ background: next });
    if (s.inXR && !s.handheld && next === 'passthrough' && this._xrMode !== 'immersive-ar') {
      this.toast('This XR session can’t show passthrough (it was started as VR)');
    }
    this._applyBackground();
  }

  // ---------------------------------------------------------------- XR
  /** In an XR view: a WebXR session, or the handheld motion-sensor view. */
  get _immersive() {
    return this.renderer.xr.isPresenting || this.state.handheld;
  }

  /** Hands-free XR: no controllers (a phone, a headset used with its hands), so the gaze points and clicks. */
  _gazeMode() {
    return this._immersive && !this.hands.left && !this.hands.right;
  }

  /**
   * XR: Phone AR draws the page's own menus and HUD in front of the view, as outside XR, instead
   * of the in-world panels: the handheld view is the page anyway, and a WebXR session shows the
   * page over it through its DOM overlay (when the browser grants one). Phone Viewer's two eyes
   * keep the in-world panels.
   */
  screenUI(s = this.state) {
    return s.inXR && s.phone && !s.phoneStereo && (s.handheld || s.domOverlay);
  }

  /** The element holding the page's UI (and the canvas): the WebXR DOM overlay's root. */
  get _uiRoot() {
    return this.container.parentElement;
  }

  /** A WebXR DOM overlay on or off. While on, the canvas is hidden: the session draws the view behind the overlay. */
  _setDomOverlay(on) {
    this._uiRoot?.classList.toggle('xr-dom-overlay', on);
    if (this.state.domOverlay !== on) this.setState({ domOverlay: on });
  }

  /**
   * Options → Video → View Mode (see menu.js): the windowed views switch at once; the XR views
   * start a session (only from a click, as browsers require), and Phone AR / Phone Viewer switch
   * live inside one.
   */
  selectView(next) {
    const s = this.state;
    if (XR_VIEWS.includes(next)) {
      const stereo = next === 'phoneViewer';
      if (s.inXR) return this._setPhoneStereo(stereo);
      // if the session fails to start, the next press carries on from Normal
      this.setState({ screenView: 'normal', phoneStereo: stereo });
      return this.enterXR();
    }
    if (s.inXR) this.exitXR();
    this.setState({ screenView: next });
  }

  /**
   * Into XR, straight from the click. Phones: an AR session (ARCore tracking) drawn as one view
   * or, for a viewer, two lens-corrected eyes; without WebXR AR, the handheld motion-sensor view.
   * Otherwise (XR: HMD Stereo) an immersive-ar session where the browser offers it (Quest
   * Browser), so every Background, Passthrough included, works and can be switched live; else VR
   * (PC browsers driving a headset over Link).
   */
  async enterXR() {
    const { xrAR, xrVR, phone } = this.state;
    if (this.state.inXR) return;
    if (phone && !xrAR) return this._enterHandheld();
    const mode = xrAR ? 'immersive-ar' : xrVR ? 'immersive-vr' : null;
    if (!mode) return;
    if (this.state.background === 'passthrough' && mode !== 'immersive-ar') {
      this.toast('Passthrough isn’t available in this browser — open the game in the Quest Browser for passthrough');
    }
    unlockAudio();
    this._endCreatureView(); // the headset is the camera in XR
    try {
      const session = await navigator.xr.requestSession(
        mode,
        phone
          ? { ...PHONE_AR_SESSION_INIT, domOverlay: { root: this._uiRoot } }
          : { requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking'] },
      );
      this._savedView = { pos: this.camera.position.clone(), target: this.controls.target.clone(), up: this.camera.up.clone() };
      this.renderer.xr.setReferenceSpaceType('local-floor');
      await this.renderer.xr.setSession(session);
      session.addEventListener('end', () => this._leaveImmersive());
      this._xrMode = mode;
      if (session.domOverlayState) this._setDomOverlay(true);
      if (phone && this.state.phoneStereo) this.phoneStereo.enable();
      this._beginImmersive();
      this._trapBackButton();
    } catch (e) {
      console.error(e);
      this.toast(`Could not start XR: ${e.message || e}`, 'error');
    }
  }

  /**
   * The Quest Browser turns the left controller's Menu (≡) button into the browser's Back, so a
   * history entry pushed on entering XR catches it: Back pops the entry, and that leaves XR.
   */
  _trapBackButton() {
    history.pushState({ gridGameXR: true }, '');
    this._onPopState = () => {
      this._releaseBackButton(false); // Back already took the entry
      this.exitXR();
    };
    window.addEventListener('popstate', this._onPopState);
  }

  /** Drops the Back trap; leaving XR some other way also removes the entry it pushed. */
  _releaseBackButton(popEntry = true) {
    if (!this._onPopState) return;
    window.removeEventListener('popstate', this._onPopState);
    this._onPopState = null;
    if (popEntry && history.state?.gridGameXR) history.back();
  }

  /** Out of XR (the session's end, or leaving the handheld view, tidies up: _leaveImmersive). */
  exitXR() {
    if (this.state.handheld) return this._exitHandheld();
    this.renderer.xr.getSession()?.end();
  }

  /** Phone AR <-> Phone Viewer, live. */
  _setPhoneStereo(stereo) {
    this.setState({ phoneStereo: stereo });
    if (this.state.handheld) {
      this.cardboard.split = stereo;
      // stereo wants landscape; mono can be held either way
      if (stereo) screen.orientation?.lock?.('landscape').catch(() => {});
      else screen.orientation?.unlock?.();
    } else if (this.renderer.xr.isPresenting && this.state.phone) {
      if (stereo) this.phoneStereo.enable();
      else this.phoneStereo.disable();
    }
    if (stereo && this.isMenuOpen()) this._placeMenuPanel(); // the page's menu gives way to the in-world one
    this._applyBackground();
  }

  /** The handheld view: the camera follows the motion sensors (no walking), one view or two eyes. */
  _enterHandheld() {
    const stereo = this.state.phoneStereo;
    // permission, fullscreen and the orientation lock all need this click: before anything async
    enterCardboard({ landscape: stereo }).then((sensors) => {
      if (!sensors) this.toast('Motion sensor access was denied: the view won’t follow the phone', 'error');
    });
    unlockAudio();
    this._endCreatureView();
    this._savedView = { pos: this.camera.position.clone(), target: this.controls.target.clone(), up: this.camera.up.clone() };
    this._xrMode = null;
    this.cameraFeed.failed = false; // try the camera again
    this.cardboard.start(stereo);
    this.setState({ handheld: true });
    this._beginImmersive();
    // leaving fullscreen (back gesture, Esc) also leaves the handheld view
    this._onFullscreenChange = () => {
      if (!document.fullscreenElement) this._exitHandheld();
    };
    document.addEventListener('fullscreenchange', this._onFullscreenChange);
  }

  _exitHandheld() {
    if (!this.state.handheld) return;
    document.removeEventListener('fullscreenchange', this._onFullscreenChange);
    exitCardboard();
    this.cardboard.stop();
    this.cameraFeed.stop();
    this._leaveImmersive();
  }

  /** What every XR view starts with. */
  _beginImmersive() {
    this._xrFrames = 0;
    this._needsXRPlacement = true;
    this._needsTabletPlacement = true; // debug tablet: re-place in front of the player each session
    this._gazeDockAnchor = null;
    this.gazeDwell.reset();
    this.controls.enabled = false;
    this.setState({ inXR: true, screen: 'playing', menu: 'main' });
    this._applyBackground();
  }

  _leaveImmersive() {
    this._releaseBackButton();
    this._setDomOverlay(false);
    this.phoneStereo.disable();
    this.debugTablet.mesh.visible = false;
    this._tabletGrab = null;
    this._xrMode = null;
    if (this.menuPanel.mesh.parent !== this.scene) this.scene.add(this.menuPanel.mesh);
    this.menuPanel.mesh.scale.setScalar(1);
    for (const hud of [this.leftHud, this.rightHud]) if (hud.mesh.parent === this.gazeDock) this.gazeDock.remove(hud.mesh);
    this.reticle.group.visible = false;
    this.worldRoot.position.set(0, 0, 0);
    this.worldRoot.quaternion.identity();
    this.worldRoot.scale.setScalar(CM);
    this.menuPanel.mesh.visible = false;
    this.rayDot.visible = false;
    this._grab = null;
    if (this._savedView) {
      this.camera.position.copy(this._savedView.pos);
      this.camera.quaternion.identity();
      this.camera.up.copy(this._savedView.up);
      this._camSafe = null;
      this.controls.target.copy(this._savedView.target);
      this.camera.lookAt(this.controls.target);
    }
    this.controls.enabled = true;
    this.controls.update();
    this._onResize();
    this.setState({ inXR: false, handheld: false, paused: true, menu: 'main' });
    this._applyBackground();
  }

  /**
   * A tap on the phone screen, a pinch (hand tracking) or a viewer's button, in hands-free XR:
   * clicks what the gaze is on (no need to wait for the stare), or uses the tool there.
   */
  _onGazeTap() {
    if (this._gazeHit) this.gazeDwell.markSpent(this._gazeHit);
    this._activateGaze();
  }

  /** The handheld view's tap (anywhere on the screen): see _onGazeTap. */
  gazeTap() {
    if (this.state.handheld) this._onGazeTap();
  }

  /** Clicks what the gaze is on: a menu button or slider position, the Menu button, a tool slot, a tablet control. */
  _activateGaze() {
    if (this._menuHover) {
      const value = this.menuPanel.sliderValueAt(this._menuHoverUV, this._menuHover);
      if (value != null) return this._setSlider(this._menuHover, value);
    }
    this._onRightTrigger();
  }

  /**
   * Hands-free XR: lays the HUDs out in the gaze dock (tools at the bottom, the time and Menu
   * button above them, the menu above that), which floats ahead of the head and swings round to
   * the front once the head turns or moves well away from it.
   */
  _updateGazeDock(dt) {
    if (!this._gazeMode()) return;
    const dock = this.gazeDock;
    const left = this.leftHud.mesh, right = this.rightHud.mesh;
    if (left.parent !== dock || right.parent !== dock) {
      dock.add(left, right);
      left.rotation.set(0, 0, 0);
      right.rotation.set(0, 0, 0);
      const leftH = left.geometry.parameters.height, rightH = right.geometry.parameters.height;
      left.position.set(0, 0, 0);
      right.position.set(0, -(leftH + rightH) / 2 - 0.006, 0);
      if (this.isMenuOpen()) this._placeMenuPanel();
    }
    const { pos, dir } = this._headPose();
    const yaw = Math.atan2(-dir.x, -dir.z);
    const turn = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b)); // signed, -π…π
    const anchor = this._gazeDockAnchor;
    if (!anchor) this._gazeDockShown = { pos: pos.clone(), yaw }; // first frame: no easing in
    if (!anchor || Math.abs(turn(yaw, anchor.yaw)) > GAZE_DOCK_TURN || anchor.pos.distanceTo(pos) > GAZE_DOCK_MOVE) {
      this._gazeDockAnchor = { pos: pos.clone(), yaw };
    }
    // ease toward the anchor
    const target = this._gazeDockAnchor, shown = this._gazeDockShown;
    const k = 1 - Math.exp(-dt * 4);
    shown.pos.lerp(target.pos, k);
    shown.yaw += turn(target.yaw, shown.yaw) * k;
    dock.position.set(-Math.sin(shown.yaw), 0, -Math.cos(shown.yaw)).multiplyScalar(GAZE_DOCK_DISTANCE).add(shown.pos);
    dock.position.y -= GAZE_DOCK_DROP;
    dock.lookAt(shown.pos); // panels face +z: toward the eyes, tilted up to them
  }

  // ---------------------------------------------------------------- XR debug tablet

  /** The trigger on a debug tablet control (see DebugTablet.hitTest). */
  _tabletAction(id) {
    playTick();
    if (id.startsWith('section:')) return debugSections.toggle(id.slice(8));
    if (id === 'prompt') return claudePrompt.openKeyboard(); // the headset's system keyboard
    if (id === 'clear') return claudePrompt.clear();
    if (id === 'mic') return claudePrompt.toggleDictation(); // (disabled where there is none: the keyboard has a mic)
    if (id === 'speak') return claudePrompt.toggleSpeech(); // read the response feed aloud
  }

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

  /**
   * While the trigger drags the tablet's resize handle: its bottom-right corner follows where
   * the right controller's ray meets the tablet's plane (its top-left corner stays put).
   */
  _updateTabletResize() {
    if (!this._tabletResizing || !this._setRayFromController()) return;
    const tablet = this.debugTablet, m = tablet.mesh;
    m.updateMatrixWorld();
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(m.matrixWorld);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, m.getWorldPosition(new THREE.Vector3()));
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;
    const local = m.worldToLocal(hit); // metres, centred on the tablet
    tablet.setSize(local.x + tablet.width / 2, tablet.height / 2 - local.y);
  }

  /** The resize drag is over: remember the tablet's size. */
  _endTabletResize() {
    if (!this._tabletResizing) return;
    this._tabletResizing = false;
    try {
      localStorage.setItem('xrTabletSize', JSON.stringify({ width: this.debugTablet.width, height: this.debugTablet.height }));
    } catch {}
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
    if (this._immersive) {
      this._grab = null;
      this.worldRoot.quaternion.identity();
      this.worldRoot.scale.setScalar(CM);
      this._placeWorldInFront();
    } else {
      this.worldRoot.position.set(0, 0, 0);
      this.controls.target.set(0, 0, 0);
      this.camera.position.copy(START_CAMERA);
      this.camera.up.set(0, 1, 0); // upright again (the trackball may have tipped it)
      this._camSafe = null; // a jump, not a move: no collision sweep from the old spot
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
    m.scale.setScalar(this.state.phone ? PHONE_MENU_SCALE : 1);
    if (hud.parent) {
      if (m.parent !== hud) hud.add(m);
      const hudH = hud.geometry.parameters.height;
      const menuH = m.geometry.parameters.height * m.scale.y;
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

  /**
   * Applies Options → Background: the solid colour, the skybox panorama, or passthrough
   * (nothing drawn behind the scene, in an XR passthrough session; elsewhere the solid colour).
   */
  _applyBackground() {
    const ar = this.renderer.xr.isPresenting && this._xrMode === 'immersive-ar';
    const mode = this.state.background;
    // in a passthrough (immersive-ar) session three.js always clears to transparent, so a plain
    // colour background would show the room: draw the colour as a texture there instead
    const solid = ar ? this._solidTexture() : BG;
    // the handheld view has no AR session: its passthrough is the rear camera (solid until it shows)
    const rearCamera = this.state.handheld && mode === 'passthrough';
    if (rearCamera && !this.cameraFeed.failed) {
      this.cameraFeed.start(
        () => this._applyBackground(),
        (e) => {
          console.warn('[grid-game] camera unavailable for passthrough:', e?.message ?? e);
          this.toast('Couldn’t open the camera for passthrough', 'error');
          this._applyBackground();
        },
      );
    } else if (!rearCamera) this.cameraFeed.stop();
    if (mode === 'passthrough' && ar) this.scene.background = null;
    else if (rearCamera && this.cameraFeed.texture) this.scene.background = this.cameraFeed.texture;
    else if (mode === 'skybox') this.scene.background = this._skybox() ?? solid; // the colour until it has loaded
    else this.scene.background = solid;
  }

  /** The solid background colour as a 1-pixel texture (drawn, unlike a colour, in passthrough sessions). */
  _solidTexture() {
    if (!this._solidTex) {
      const c = BG.clone().convertLinearToSRGB();
      const px = new Uint8Array([c.r * 255, c.g * 255, c.b * 255, 255].map(Math.round));
      this._solidTex = new THREE.DataTexture(px, 1, 1);
      this._solidTex.colorSpace = THREE.SRGBColorSpace;
      this._solidTex.needsUpdate = true;
    }
    return this._solidTex;
  }

  /** The skybox texture: loaded on first use (then applied, if Skybox is still chosen); null until then. */
  _skybox() {
    if (this._skyboxTexture) return this._skyboxTexture;
    if (!this._skyboxLoading) {
      this._skyboxLoading = true;
      new THREE.TextureLoader().load(
        SKYBOX_URL,
        (tex) => {
          tex.mapping = THREE.EquirectangularReflectionMapping; // a 2:1 panorama all around
          tex.colorSpace = THREE.SRGBColorSpace;
          this._skyboxTexture = tex;
          this._applyBackground();
        },
        undefined,
        () => this.toast('Couldn’t load the skybox image (img/skybox.jpg)', 'error'),
      );
    }
    return null;
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
    if (this._toolHover != null) return this.selectTool(this._toolHover); // hands-free XR: a tool slot
    if (this._tabletHover) {
      // pointing at the debug tablet: the trigger on its corner handle resizes it (held), else
      // presses what it points at (a section header, the prompt box, a button)
      if (this._tabletHandleHover) this._tabletResizing = true;
      else if (this._tabletHoverId) this._tabletAction(this._tabletHoverId);
      return;
    }
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
    // The Quest Browser uses the left Menu (≡) button as "Back" (it leaves XR: _trapBackButton),
    // so the menu is opened with the Menu button on the left HUD; the Y button is a shortcut for it.
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

  /** Hands-free XR: the ray along the gaze (the centre of view). */
  _setRayFromHead() {
    const { pos, dir } = this._headPose();
    this.raycaster.set(pos, dir);
    return true;
  }

  /** The pointer in the view's own terms: in 3D: SBS each half of the screen shows the whole view. */
  _viewMouse() {
    if (this.state.screenView !== 'sbs') return this.mouse;
    const u = (this.mouse.x + 1) / 2;
    return new THREE.Vector2((u < 0.5 ? u * 2 : u * 2 - 1) * 2 - 1, this.mouse.y);
  }

  _updateTarget() {
    this.placeHL.visible = false;
    this.deleteHL.visible = false;
    this._hoverCreature = null;
    this.targetHL.visible = false;
    this.world.setDithered(null);
    this.target = null;
    const s = this.state;
    const xr = this._immersive;
    const gaze = xr && this._gazeMode();
    let rayLen = XR_RAY_LENGTH;
    this.rayDot.visible = false;

    const menuOpen = this.isMenuOpen(s);
    const panelOpen = xr && menuOpen && !this.screenUI(s); // the in-world pause panel (not with the page's own menus)
    this._menuHover = null;
    this._menuPanelHover = false; // ray is on the pause panel (button or not)
    this._tabletHover = false;
    this._tabletHoverId = null; // the tablet control under the ray (section header, prompt box, button)
    this._hudHover = null;
    this._toolHover = null; // hands-free XR: the tool slot under the gaze
    this._gazeHit = null; // hands-free XR: the control under the gaze ({ key, point, distance })
    let uiHit = null;

    if (xr && (gaze ? this._setRayFromHead() : this._setRayFromController())) {
      // UI first: the left HUD's Menu button and the start/pause panel (and for the gaze, the tool slots).
      this.raycaster.far = 3;
      const targets = [];
      if (this.leftHud.mesh.visible && this.leftHud.mesh.parent) targets.push(this.leftHud.mesh);
      if (gaze && this.rightHud.mesh.visible && this.rightHud.mesh.parent) targets.push(this.rightHud.mesh);
      if (panelOpen) targets.push(this.menuPanel.mesh);
      if (this.debugTablet.mesh.visible) targets.push(this.debugTablet.mesh);
      for (const hit of this.raycaster.intersectObjects(targets, false)) {
        if (hit.object === this.debugTablet.mesh) {
          this._tabletHover = true; // grip now grabs it; the trigger resizes it from its corner handle
          this._tabletHandleHover = !gaze && this.debugTablet.onResizeHandle(hit.uv); // (resizing needs a held trigger)
          this._tabletHoverId = this._tabletHandleHover ? null : this.debugTablet.hitTest(hit.uv);
          uiHit = hit;
          break;
        } else if (hit.object === this.leftHud.mesh) {
          if (this.leftHud.hitTest(hit.uv)) {
            this._hudHover = 'menu';
            uiHit = hit;
            break;
          }
        } else if (hit.object === this.rightHud.mesh) {
          const slot = this.rightHud.hitTest(hit.uv);
          if (slot != null) {
            this._toolHover = slot;
            uiHit = hit;
            break;
          }
        } else if (this.menuPanel.contains(hit.uv)) {
          // only the visible panel counts; its transparent margin is "outside"
          this._menuHover = this.menuPanel.hitTest(hit.uv);
          this._menuHoverUV = hit.uv;
          // the gaze sets a slider only from its track (its label would mean the minimum)
          if (gaze && this._menuHover && this.menuPanel.sliderValueAt(hit.uv, this._menuHover) != null &&
            !this.menuPanel.onSliderTrack(hit.uv, this._menuHover)) this._menuHover = null;
          // dragging a slider: follow the ray along its track while the trigger is held
          if (this._sliderDrag && this._menuHover === this._sliderDrag) {
            this._setSlider(this._sliderDrag, this.menuPanel.sliderValueAt(hit.uv, this._sliderDrag));
          }
          this._menuPanelHover = true;
          uiHit = hit;
          break;
        }
      }
      if (gaze && uiHit) {
        // what a stare (or a tap) would press; a slider's key includes the value it would set
        let key = null;
        if (this._menuHover) {
          const value = this.menuPanel.sliderValueAt(uiHit.uv, this._menuHover);
          key = `menu:${this._menuHover}${value != null ? `@${value}` : ''}`;
        } else if (this._hudHover) key = 'hud:menu';
        else if (this._toolHover != null) key = `tool:${this._toolHover}`;
        else if (this._tabletHoverId) key = `tablet:${this._tabletHoverId}`;
        if (key) this._gazeHit = { key, point: uiHit.point, distance: uiHit.distance };
      } else if (uiHit) {
        rayLen = uiHit.distance;
        this.rayDot.position.copy(uiHit.point);
        this.rayDot.visible = true;
      }
    }
    if (panelOpen) this.menuPanel.draw(menuModel(s), this._menuHover);

    if (s.screen === 'playing' && !s.paused && !uiHit && this.toolsReady(s) && this.toolsAvailable(s)) {
      let ok = false;
      if (xr) {
        ok = gaze ? this._setRayFromHead() : this._setRayFromController();
        this.raycaster.far = gaze ? GAZE_RAY_LENGTH : XR_RAY_LENGTH;
      } else if (s.gamepadAim) {
        this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
        this.raycaster.far = DESKTOP_RAY_LENGTH;
        ok = true;
      } else if (this.mouse) {
        this.raycaster.setFromCamera(this._viewMouse(), this.camera);
        this.raycaster.far = DESKTOP_RAY_LENGTH;
        ok = true;
      }
      if (ok) {
        this.target = this._pick();
        if (this.target?.distance != null) {
          rayLen = Math.min(this.target.distance, XR_RAY_LENGTH);
          if (xr && !gaze) {
            this.rayDot.position.copy(this.target.point);
            this.rayDot.visible = true;
          }
        }
        this._showHighlight();
      }
    }

    this.rayLine.scale.z = rayLen;
    this.rayLine.visible = xr && (s.screen === 'playing' || menuOpen);

    // hands-free XR: the reticle, and the stare that clicks
    this.reticle.group.visible = gaze;
    if (gaze) {
      const fire = this.gazeDwell.step(this._dt ?? 0, this._gazeHit);
      const { pos, dir } = this._headPose();
      const distance = uiHit?.distance ?? this.target?.distance ?? IDLE_DISTANCE;
      this.reticle.update(pos, dir, this.camera.getWorldQuaternion(new THREE.Quaternion()), distance, this.gazeDwell.progress);
      if (fire) this._activateGaze();
    }
  }

  /** View Mode → 3D: SBS (half side-by-side, for 3D TVs): each eye squeezed into half the screen. */
  _renderSideBySide() {
    const r = this.renderer, cam = this.camera;
    this._sbs ??= Object.assign(new THREE.StereoCamera(), { eyeSep: SBS_EYE_SEPARATION });
    cam.updateMatrixWorld();
    this._sbs.update(cam);
    r.getSize(_sbsSize);
    const half = _sbsSize.x / 2;
    r.setScissorTest(true);
    [this._sbs.cameraL, this._sbs.cameraR].forEach((eye, i) => {
      r.setViewport(i * half, 0, half, _sbsSize.y);
      r.setScissor(i * half, 0, half, _sbsSize.y);
      r.render(this.scene, eye);
    });
    r.setScissorTest(false);
    r.setViewport(0, 0, _sbsSize.x, _sbsSize.y);
  }

  /** Draws the frame in the current View Mode. */
  _render(dt) {
    const s = this.state;
    if (s.handheld) {
      if (this.cameraFeed.texture) {
        this.renderer.getDrawingBufferSize(_sbsSize);
        this.cameraFeed.fit(((this.cardboard.split ? 0.5 : 1) * _sbsSize.x) / _sbsSize.y);
      }
      this.cardboard.render(this.scene);
    } else if (this.renderer.xr.isPresenting) {
      this.phoneStereo.update(dt, s.background === 'passthrough');
      this.phoneStereo.render(this.scene, this.camera); // a plain render unless Phone Viewer
    } else if (s.screenView === 'sbs') this._renderSideBySide();
    else if (s.screenView === 'interlaced') (this._interlaced ??= new Interlaced(SBS_EYE_SEPARATION)).render(this.renderer, this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  _pick() {
    const hits = this.raycaster.intersectObjects(this.world.pickMeshes, false);
    const h = hits.find((x) => x.instanceId != null);
    if (!h) {
      // Empty world: allow placing the first block at the origin.
      if (this.world.size === 0) return { block: null, place: [0, 0, 0], placeFree: true, faceType: null };
      return null;
    }
    const block = this.world.blockAtHit(h);
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
        this.targetHL.position.set(...t.place).multiplyScalar(GRID.scale); // (lattice units -> cm)
        this.targetHL.visible = true;
        // its shrinking pulses move with it (same frame), staying centred in it
        for (const p of this._pulses) if (p.obj.visible) p.obj.position.copy(this.targetHL.position);
      }
    } else if (tool.block) {
      if (t.place && t.placeFree) {
        this.placeHL.position.set(...t.place).multiplyScalar(GRID.scale);
        // a darker shade of the block that would be placed
        this.placeHL.userData.material.color.set(BLOCK_COLORS[tool.block]).multiplyScalar(EDGE_SHADE);
        this.placeHL.visible = true;
      }
    } else if (t.block) {
      this.deleteHL.position.set(t.block.x, t.block.y, t.block.z).multiplyScalar(GRID.scale);
      this.deleteHL.visible = true;
    }
  }

  /**
   * Browser only: keeps the camera out of blocks (cameraCollision.js). The camera sweeps from
   * where it safely was last frame to where the controls put it, sliding along block surfaces
   * it would come too close to; blocks that arrive at it ease it out. When a surface stopped
   * some of the motion, the controls' leftover momentum is dropped, so they don't keep
   * pushing into it.
   */
  _collideCamera(now, dt) {
    this.cameraCollider ??= new CameraCollider(this.world);
    const cam = this.camera, root = this.worldRoot;
    const to = root.worldToLocal(cam.position.clone()); // cm, lattice space
    const away = to.clone().sub(root.worldToLocal(this.controls.target.clone())); // back off along the view line
    const { pos, blocked } = this.cameraCollider.resolve(this._camSafe, to, now, dt, away);
    this._camSafe = pos.clone();
    if (pos.distanceToSquared(to) > 1e-10) {
      cam.position.copy(root.localToWorld(pos));
      cam.lookAt(this.controls.target);
    }
    if (blocked) this._stopControlsMomentum();
  }

  /** Drops the trackball's leftover turning, zooming and panning (its ease-out after a drag). */
  _stopControlsMomentum() {
    const c = this.controls;
    c._lastAngle = 0;
    c._movePrev?.copy(c._moveCurr);
    c._zoomStart?.copy(c._zoomEnd);
    c._panStart?.copy(c._panEnd);
  }

  /**
   * Browser: once the camera is zoomed all the way in on its orbit target (minDistance),
   * further zooming in moves the camera and the target forward together, along the view
   * direction. So you can always fly on in the direction you face, e.g. out of a hollow
   * chamber through its entrance, instead of being stuck zooming at a target inside it.
   * `sph`: the gamepad's spherical offset, when called from _padCamera (then it applies there).
   */
  _flyForward(metres, radius = null) {
    const c = this.controls, cam = this.camera;
    const dist = radius ?? cam.position.distanceTo(c.target);
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
    const pressed = gp.buttons.map((button) => button.pressed || button.value > 0.5);
    const prev = this._padPrev || [];
    this._padPrev = pressed;
    const edge = (i) => pressed[i] && !prev[i];
    const ax = (i) => {
      const v = gp.axes[i] || 0;
      return Math.abs(v) < 0.18 ? 0 : v;
    };
    // LT / RT zoom out / in, by how far they're pulled
    const trigger = (i) => {
      const v = gp.buttons[i]?.value ?? (gp.buttons[i]?.pressed ? 1 : 0);
      return v < 0.05 ? 0 : v;
    };
    const zoom = trigger(6) - trigger(7);
    if (!pressed.some(Boolean) && ![0, 1, 2, 3].some((i) => ax(i)) && !zoom) {
      this._padStickArmed = true;
      return;
    }
    unlockAudio();
    const s = this.state;
    if (this.isMenuOpen(s)) return this._padMenu(edge, ax);
    if (s.screen !== 'playing') return;
    if (!s.gamepadAim) this.setState({ gamepadAim: true });
    if (edge(9)) return this.toggleMenu(); // Start
    if (edge(10)) this.toggleControlSchema(); // L3: Observer ↔ Creature controls
    if (edge(11)) this.toggleCreatureView(); // R3: the selected creature's first-person view, or back
    const steering = this.state.controlSchema === 'creature'; // the left stick moves the creature, not the camera
    if (steering) this._steerControlled(ax(0), ax(1));
    if (edge(0)) {
      // A: use the tool (at the crosshair; Observer controls only)
      this._updateTarget();
      this.useTool();
    }
    if (edge(3)) this.selectedEat(); // Y: a selected creature eats what is in front of it
    if (edge(1)) this.selectedExcrete(); // B: … or excretes what is in its tail's slot
    if (edge(2)) this.selectedToggleWait(); // X: selected creatures wait, or resume what they were doing
    if (edge(4)) this.cycleTool(-1); // LB
    if (edge(5)) this.cycleTool(1); // RB
    // in the creature's view the right stick looks around (no orbiting, zooming or panning)
    if (this._pov) return this._lookAround(dt, ax(2), ax(3));
    // left stick up / down and the triggers zoom (LT out, RT in)
    this._padCamera(dt, ax(2), ax(3), THREE.MathUtils.clamp((steering ? 0 : ax(1)) + zoom, -1, 1), [pressed[12], pressed[13], pressed[14], pressed[15]]);
  }

  /** D-pad / left stick moves the focus, A selects, B goes back, Start closes the pause menu. */
  _padMenu(edge, ax) {
    const s = this.state;
    const items = focusables(menuModel(s));
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
    if (edge(0)) return this._keyMenuGo(items[idx].id); // A
    if (edge(1)) {
      // B: closes an open dropdown, else the open section the focus is in, else goes back
      if (s.dropdown) this._closeDropdown();
      else if (sectionOf(menuModel(s), s.menuFocus)) this._closeSection();
      else if (s.menu !== 'main') this.menuAction('back');
      else if (s.paused) this.resume();
      return;
    }
    if (edge(9) && s.paused) this.resume();
  }

  /**
   * Right stick orbits (like the trackball: about the camera's own up and right axes, so it
   * keeps turning over the poles), left stick up/down zooms, D-pad pans.
   */
  _padCamera(dt, rx, ry, ly, [du, dd, dl, dr]) {
    if (!rx && !ry && !ly && !du && !dd && !dl && !dr) return;
    const c = this.controls, cam = this.camera;
    const off = cam.position.clone().sub(c.target);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    // stick right: round the camera's up axis; stick down: over its right axis
    const turn = new THREE.Quaternion().setFromAxisAngle(upv, rx * 2.2 * dt)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, ry * 1.6 * dt));
    off.applyQuaternion(turn);
    cam.up.copy(upv).applyQuaternion(turn);
    const radius = THREE.MathUtils.clamp(off.length() * Math.exp(ly * 1.6 * dt), c.minDistance, c.maxDistance);
    if (ly < 0) this._flyForward(-ly * FLY_M_PER_PAD_S * dt, radius); // stick past the zoom limit: fly forward
    off.setLength(radius);
    const pan = new THREE.Vector3();
    if (du || dd || dl || dr) {
      const speed = radius * 0.8 * dt;
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
  animMs = null; // Debug → Performance: World.updateAnimations per frame, ms (averaged like fps)
  _animTotal = 0;
  renderMs = null; // Debug → Performance: renderer.render per frame, ms (averaged like fps; CPU time: issuing the draws, not the GPU finishing them)
  _renderTotal = 0;
  _fpsFrames = 0;
  _fpsSince = null;

  _countFrame(now) {
    this._fpsSince ??= now;
    this._fpsFrames++;
    if (now - this._fpsSince >= FPS_WINDOW_MS) {
      this.fps = (this._fpsFrames * 1000) / (now - this._fpsSince);
      this.animMs = this._animTotal / this._fpsFrames;
      this._animTotal = 0;
      this.renderMs = this._renderTotal / this._fpsFrames;
      this._renderTotal = 0;
      this._fpsFrames = 0;
      this._fpsSince = now;
    }
  }

  _tick = (time) => {
    const now = time ?? performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - (this._lastTime ?? now)) / 1000));
    this._lastTime = now;
    this._countFrame(now);
    // the scene clock only runs while the game does: pausing freezes the shaders' animation,
    // the revolving light, sliding blocks, eyes, wings and legs (World.time)
    const s0 = this.state;
    if (s0.screen === 'playing' && !s0.paused) this.world.advanceTime(dt * 1000);
    const sceneNow = this.world.time;
    this._updateOrbitLight(sceneNow);
    this._advanceClock(dt);
    const a0 = performance.now();
    this.world.updateAnimations(sceneNow); // every 3D object's per-frame update (see World.updateAnimations)
    this._animTotal += performance.now() - a0;
    this._updateSelectionVisuals(sceneNow);
    if (this.state.handheld) this.cardboard.update(); // the camera follows the phone
    const xr = this._immersive;
    if (!xr) {
      this._pollBrowserGamepad(dt);
      if (this._pov) this._updateCreatureView(sceneNow);
      else {
        this.controls.update();
        this._collideCamera(now, dt);
      }
    } else {
      this._xrFrames++;
      if (this._needsXRPlacement && this._xrFrames > 2) {
        this._needsXRPlacement = false;
        this._placeWorldInFront();
        if (this.isMenuOpen()) this._placeMenuPanel();
      }
      this._pollGamepads();
      this._updateGrab();
      this._updateGazeDock(dt);
      const flat = this.screenUI(); // the page's UI is in front instead (XR: Phone AR)
      const dbg = this.state.debugMode && !flat;
      this.debugTablet.mesh.visible = dbg;
      if (dbg) {
        if (this._needsTabletPlacement !== false && this._xrFrames > 2) this._placeDebugTablet();
        this._updateTabletGrab();
        this._updateTabletResize();
        this.debugTablet.draw({
          info: this.debugInfo(),
          perf: this.performanceRows(),
          logs: getLogs(120),
          logVersion: getLogVersion(),
          highlight: !!this._tabletGrab || this._tabletHover,
          handleHot: this._tabletResizing || this._tabletHandleHover,
          claude: { ...claudePrompt.getSnapshot(), response: claudePrompt.responseText() },
          collapsed: debugSections.getSnapshot(),
          hover: this._tabletHoverId,
        });
      } else {
        this._tabletGrab = null;
        this._endTabletResize();
      }
      let msg = null;
      if (this._hudMessage && performance.now() < this._hudMessage.until) msg = this._hudMessage.text;
      const playing = this.state.screen === 'playing';
      this.rightHud.draw(this.state.toolIndex, msg, this.toolLabel(), { materials: this.state.materials, smooth: this.state.smoothRendering }, this._toolHover);
      this.leftHud.draw(this._hudHover === 'menu', this.state.paused, Engine.formatTime(this.state.gameTime), Engine.formatDiameter(this.state.blockCount));
      this.rightHud.mesh.visible = playing && !flat;
      this.leftHud.mesh.visible = playing && !flat;
      const open = this.isMenuOpen() && !flat;
      // keep the menu docked to the left hand (re-dock if the controller connects / disconnects)
      if (open && (this.leftHud.mesh.parent ? this.menuPanel.mesh.parent !== this.leftHud.mesh : this.menuPanel.mesh.parent !== this.scene)) {
        this._placeMenuPanel();
      }
      this.menuPanel.mesh.visible = open;
    }
    this._dt = dt;
    this._updateTarget();
    this._updateListener();
    const r0 = performance.now();
    this._render(dt);
    this._renderTotal += performance.now() - r0;
  };

  /** Where lattice cell `cell` ({x, y, z}) is in the scene (metres), for positional sound; null without one. */
  _soundAt(cell) {
    if (!cell) return null;
    this.worldRoot.updateWorldMatrix(true, false);
    return this.worldRoot.localToWorld(new THREE.Vector3(cell.x, cell.y, cell.z).multiplyScalar(GRID.scale));
  }

  /** Scene sounds are heard from the camera (the headset in XR). */
  _updateListener() {
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    cam.matrixWorld.decompose(_earPos, _earQuat, _earScale);
    setListener(_earPos, _earFwd.set(0, 0, -1).applyQuaternion(_earQuat), _earUp.set(0, 1, 0).applyQuaternion(_earQuat));
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    if (this.state.handheld) this._exitHandheld();
    setMusicLevel(0); // fades out
    this._ro?.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('wheel', this._onWheel);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerleave', this._onPointerLeave);
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('dragover', this._onDragOver);
    window.removeEventListener('drop', this._onDrop);
    this._uiRoot?.removeEventListener('beforexrselect', this._onBeforeXRSelect);
    this.controls.dispose();
    this._interlaced?.dispose();
    this.renderer.dispose();
    el.remove();
    this.listeners.clear();
  }
}
