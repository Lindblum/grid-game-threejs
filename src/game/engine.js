import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { CameraCollider } from './cameraCollision.js';
import { InventoryView } from './inventoryView.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { STEP_FRACTION, World, excretedType, isSaveData, parseTemplate } from './world.js';
import { canStand, stepSquirmies, stepSight, stepNimbus, stepSoloCreatures, stepDirt, stepGroups, stepRain, stepWater, stepSink, stepFog, stepNimbusDrift, stepWood, creatureEat, creatureEatNearby, edibleNeighbors, excretableCells, nextSteppedCell, steppableCells, SELECT_WAIT_TURNS } from './sim.js';
import { BLOCK, BLOCK_COLORS, TOOL, TOOLS, isCreature } from './tools.js';
import { getLogs, getLogVersion } from './debugLog.js';
import { claudePrompt } from './claudePrompt.js';
import { debugSections } from './debugSections.js';
import { BEHAVIOR, BUFF_TYPES, blockProps, canFly, canWalkOn, describeBuff, isSingleCreature, isChainCreature, isTranslucent } from './blocks.js';
import { SELECT_GREEN } from './icons.js';
import { GRID, faceFromNormal, gridMode, isValidCell, onGridChange } from './lattice.js';
import { EDGE_SHADE, MATERIALS, cellFaces } from './geometry.js';
import {
  playPlace, playDelete, playTick, playResume, playPause, playLoad, playSave, playError, unlockAudio, setSoundVolume,
  playReady, playGo, playBerryGrow, playSfx, playWait, playAssign, playCreatureDone, playCreatureTrapped, playCreatureDeath,
  setListener, beginTurnSounds, endTurnSounds, setMusicLevel, MUSIC_LEVEL,
} from './audio.js';
import { RightHudPanel, MenuPanel, DebugTablet, ViewPanel } from './xrPanels.js';
import { menuModel, displayName, PAGE_SIZE, SPEED, TEXT_SIZE, VOLUME, CAMERA_SPEED, BACKGROUNDS, XR_VIEWS, availableViews, parsePick, isDisabledChoice, focusables, sectionOf } from './menu.js';
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
// Creature controls (R3): the creature's view, the Observer camera orbiting the creature's head. It starts
// two cells (4 cm) away, above and behind it at 45° (cm, the camera's own frame: y = up,
// z = back), and may zoom in to POV_MIN_DISTANCE_M (m; just clear of the head)
const POV_BOOM = new THREE.Vector3(0, 1, 1).setLength(4);
const ZOOM_OUT_S = 0.8; // back to Observer: the camera moves out to its old distance over this long
const ROTATE_SPEED = 5; // the trackball's mouse orbiting, about as fast as the old orbit controls
const POV_MIN_DISTANCE_M = 0.018;
const _povQ = new THREE.Quaternion();
const _povLook = new THREE.Vector3();
const _povTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // the camera looks down -z, a creature faces +z
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
const FLY_M_PER_PAD_S = 0.08; // …and the gamepad's RT flies up to 8 cm/s
// The windowed camera settles, gently, so down (toward the origin: gravity) is down (see _settleCamera):
// its roll eases level, and it drifts round its orbit to look down on its target from between these
// heights (degrees above the target's ground). Each eases over about _S seconds, never faster than _MAX_DEG_S.
const ROLL_LEVEL_S = 3;
const ROLL_LEVEL_MAX_DEG_S = 20;
const SETTLE_ELEVATION_DEG = [15, 70];
const SETTLE_S = 4;
const SETTLE_MAX_DEG_S = 10;
const _setOrigin = new THREE.Vector3(), _setGround = new THREE.Vector3(), _setOff = new THREE.Vector3();
const _setAxis = new THREE.Vector3(), _setFwd = new THREE.Vector3(), _setWant = new THREE.Vector3(), _setCur = new THREE.Vector3();
/** Creature controls: the next-step dot's radius (cm; a cell's inradius is 1 cm), small enough not to hide the cell. */
const STEP_MARKER_RADIUS_CM = 0.05;
/** Creature controls: the lines to the cells a creature could step into, room for this many at once (all controlled creatures). */
const STEP_LINES_MAX = 256;
// Select tool: the destination being pointed at is a dot (cm), with a dotted line to it from each
// selected creature's head (dash and gap, cm)
const TARGET_DOT_RADIUS_CM = 0.08;
const TARGET_LINE_DOT_CM = 0.06;
const TARGET_LINE_GAP_CM = 0.1;
const TARGET_LINES_MAX = 16;
/** Creature controls: the stick picks the step line nearest its direction on screen, within this (cosine: ~70°). */
/** The camera this close to a block's surface (cm), or inside it, draws it see-through: the near plane (0.25 cm, ~0.4 cm at its corners) would cut it. */
const SEE_THROUGH_REACH_CM = 0.45;
/** How far (px) the pointer may move between a left press and its release for it to be a click (the tool) rather than a drag (the camera). */
const CLICK_MAX_MOVE_PX = 6;
const STEER_SCREEN_COS = 0.35;
/**
 * XR panels (Options, Debug, the Right HUD; see _layoutPanels): docked on a controller, they
 * stand side by side in its pointing frame (-Z forward, +Y up), their bottoms on
 * PANEL_DOCK_ANCHOR, the first one's toggle button over the controller, tilted so their faces
 * tip up toward the eyes (as in xr-music-threejs).
 */
const XR_PANEL_ORDER = ['options', 'debug', 'view', 'right'];
const PANEL_DOCK_ANCHOR = new THREE.Vector3(0, 0.05, 0.02);
const PANEL_DOCK_TILT = -0.5; // radians about the controller's X: the top leans forward
const PANEL_DOCK_GAP = 0.008; // m between panels docked side by side
const PANEL_DOCK_REACH = 0.12; // m: a held panel let go this near the other controller docks there
const PANEL_TOUCH_REACH = 0.03; // m: a grip this near a panel's face takes it
const PANEL_GROW_RATE = 12; // per second: a panel in the hand eases to its free size
const GRIP_TAP_S = 0.3; // a grip pressed no longer than this is a tap…
const GRIP_DOUBLE_TAP_S = 0.35; // …and pressed again within this, a double tap
const MENU_SCROLL_PX_S = 1400; // XR Options: canvas px a second it scrolls at the thumbstick's full tilt
const PANEL_PULSE = { grab: [0.6, 50], detach: [0.4, 30], dock: [0.9, 80], zone: [0.25, 20] }; // haptics: [strength, ms]
const _panelRay = new THREE.Raycaster();
const _panelOffset = new THREE.Matrix4();
const _panelStep = new THREE.Matrix4();
const _panelWorld = new THREE.Matrix4();
const _panelTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), PANEL_DOCK_TILT);
/** Keyboard creature controls: each direction key as a left stick push ([right, down], like the gamepad's axes). */
const KEY_STICK = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};
/** XR: two right-trigger presses this close together (ms) on a creature are a double press (like a double-click). */
const XR_DOUBLE_PRESS_MS = 400;
const START_CAMERA = new THREE.Vector3(0.22, 0.26, 0.4).normalize().multiplyScalar(0.5); // 50 cm from origin

/**
 * Select tool: a selected (or pointed-at) creature's soft, blurry outline round its perimeter. Each
 * of its blocks gets a sphere GLOW_RADIUS times the block's own size (a ball of the cell's volume),
 * drawn inside out (back faces), added on, brightest next to the body and fading to nothing at
 * the sphere's edge. The body (opaque, in front of each sphere's far side) hides all of it but the
 * part out past its silhouette: a halo, with no post-processing pass (so XR too).
 */
const GLOW_RADIUS = 1.5;
const GLOW_SPHERE = new THREE.SphereGeometry(1, 24, 16);

function makeGlowMaterial(color, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        // facing the view: the middle of the sphere (by the body); edge-on: its rim, faded out
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        gl_FragColor = vec4(uColor, pow(facing, 1.5) * uOpacity);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

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
      menu: 'main', // 'main' (Options) | 'load' | 'save' (Options → File)
      gridMode: gridMode(), // the world's grid mode (grids.js): chosen from New's dropdown, or by the save loaded
      soundVolume: VOLUME.default, // Options → Accessibility → Sounds: 0 (off) to 1
      controlSchema: 'observer', // 'observer' (default) or 'creature' (R3 with a creature selected; the camera takes on its view): controls.js
      musicVolume: VOLUME.default, // Options → Accessibility → Music: 0 (off) to 1; plays while the game is running (quieter in the pause menu)
      gameTime: -COUNTDOWN_SECONDS, // whole seconds (turns) since New / Load; negative = countdown
      background: 'passthrough', // Options → Background: 'solid', 'skybox' or 'passthrough' (XR passthrough; solid elsewhere)
      materials: 'procedural', // Options → Materials: 'solid', 'simple' or 'procedural' shaders (geometry.js MATERIALS)
      ambientOcclusion: true, // Options → Ambient Occlusion: darker corners between blocks
      speed: SPEED.default, // Options → Speed: 0x–4x (0x: stopped), where 1x is 60 turns a minute (sets the turn and animation length)
      rain: true, // Options → Rain: random raindrops appear 1 m out every 10th turn
      fog: true, // Options → Fog: Fog blocks are drawn (off: hidden, and the pointer passes through them)
      debugMode: false, // Options → Debug: debug panel (HUD / XR tablet)
      vsync: true, // Options → Video → VSync: frames paced by the display (off: as fast as they can be drawn; see _applyVSync)
      antialias: true, // Options → Video → Anti-aliasing (the renderer's MSAA: only takes effect when the page loads; see _initRenderer)
      refraction: true, // Options → Refraction: Crystal (and Water, with Procedural materials) bends what's behind it (Off: just see-through, cheaper)
      smoothRendering: false, // Options → Rendering: Smooth (clusters drawn as merged, smoothed bodies) or Blocky (default)
      cameraSpeed: CAMERA_SPEED.default, // Options → Accessibility → Camera Speed: a multiplier on the camera's turning
      textSize: TEXT_SIZE.default, // Options → Accessibility → Text Size: the page UI's text, a multiplier
      directionGuides: true, // Options → Accessibility → Direction Guides (or G): Creature controls' step lines and dots, and aimed Eat / Excrete's
      viewInternal: false, // Options → Accessibility → View Internal: the selected / controlled creatures see-through, their inventories inside
      observerCameraInvert: false, // Options → Accessibility → Observer Camera: Invert turns orbiting the other way
      controlCameraInvert: true, // Options → Accessibility → Control Camera: the same, under Creature controls
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
      rightHudOpen: true, // the Right panel / HUD (its eye button): shown, or only the button
      toolsOpen: true, // its Tools dropdown: open (the tool selector shows) or closed
      // what the selected creatures could do right now (the Right panel's actions; _updateActions):
      // eat (the distinct block types next to them they could eat), excrete (the block type that
      // would come out, with somewhere for it to go); input: which glyphs to show ('mk', 'pad', 'xr')
      actions: { eat: [], excrete: null },
      inputDevice: 'mk',
      toast: null,
      gamepadAim: false, // aiming with a gamepad (crosshair at screen centre)
      menuFocus: null, // id of the menu item focused with the gamepad
      dropdown: null, // the menu dropdown whose list is open ('new' | 'view' | 'background'), see menu.js
      section: null, // the Options section open beneath its button ('file' | 'controls' | 'video' | 'accessibility'), see menu.js
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
    this._pulses = []; // copies of the Select target dot (and Direction Guides' dots) spreading out and fading, one per turn

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
    // (an XR session always runs on the headset's own frame loop)
    this.renderer.xr.addEventListener('sessionstart', () => this._applyVSync());
    this.renderer.xr.addEventListener('sessionend', () => this._applyVSync());
    this._applyVSync();
  }

  /**
   * Options → Video → VSync. On: a frame per display refresh (requestAnimationFrame, through
   * three's animation loop). Off: the next frame starts as soon as one is done (a message
   * loop), so the frame rate isn't capped at the refresh rate; the browser still shows them
   * at its own refreshes. An XR session, or a hidden page, always waits for its frames.
   */
  _applyVSync() {
    const free = !this.state.vsync && !this.renderer.xr.isPresenting;
    if (this._loopFree === free) return;
    this._loopFree = free;
    if (!free) {
      this._freeLoop = null;
      this.renderer.setAnimationLoop(this._tick);
      return;
    }
    this.renderer.setAnimationLoop(null);
    const loop = (this._freeLoop = new MessageChannel());
    loop.port1.onmessage = () => {
      if (this._freeLoop !== loop) return;
      if (document.hidden) return void requestAnimationFrame(() => loop.port2.postMessage(0)); // (rests while hidden)
      this._tick(performance.now());
      loop.port2.postMessage(0);
    };
    loop.port2.postMessage(0);
  }

  // ---------------------------------------------------------------- state
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;
  setState(patch) {
    const wasOpen = this.state.paused;
    this.state = { ...this.state, ...patch };
    if (wasOpen && !this.state.paused) this._saveOptions(); // closed Options (gear, Esc, …)
    // the music plays while the game is running, at a quarter of its volume in the pause menu
    // (fades in / out / down / up as that changes)
    const s = this.state;
    setMusicLevel(s.screen === 'playing' ? s.musicVolume * (s.paused ? MUSIC_LEVEL.paused : MUSIC_LEVEL.playing) : 0);
    for (const fn of this.listeners) fn();
  }

  /** The settings the Options menu controls, as saved to the options cookie. */
  static OPTION_KEYS = ['musicVolume', 'soundVolume', 'background', 'materials', 'ambientOcclusion', 'speed', 'rain', 'fog', 'debugMode', 'smoothRendering', 'refraction', 'antialias', 'vsync', 'textSize', 'cameraSpeed', 'directionGuides', 'viewInternal', 'rightHudOpen', 'toolsOpen', 'observerCameraInvert', 'controlCameraInvert'];

  /** Options → Accessibility → Direction Guides, or G while playing: on / off; remembered. */
  toggleDirectionGuides() {
    const on = !this.state.directionGuides;
    this.setState({ directionGuides: on });
    if (!this.state.paused) {
      this.toast(`Direction Guides ${on ? 'on' : 'off'}`);
      this._saveOptions(); // (the menu saves on leaving Options; the key saves at once)
    }
  }

  /** Options → Debug, or ` / ~ while playing: the Debug panel (XR: the debug tablet) on / off; remembered. */
  toggleDebug() {
    const on = !this.state.debugMode;
    this.setState({ debugMode: on });
    if (!on) claudePrompt.stopDictation();
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
    // (older settings stored Music and Sounds on / off)
    if (typeof saved.musicVolume === 'number' || bool('musicOn')) this.setMusicVolume(saved.musicVolume ?? (saved.musicOn ? 1 : 0));
    if (typeof saved.soundVolume === 'number' || bool('soundOn')) this.setSoundVolume(saved.soundVolume ?? (saved.soundOn ? 1 : 0));
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
    if (typeof saved.movementGuides === 'boolean' && !bool('directionGuides')) this.setState({ directionGuides: saved.movementGuides }); // (its old name)
    for (const k of ['rain', 'debugMode', 'smoothRendering', 'antialias', 'vsync', 'directionGuides', 'viewInternal', 'rightHudOpen', 'toolsOpen', 'observerCameraInvert', 'controlCameraInvert']) if (bool(k)) this.setState({ [k]: saved[k] });
    if (typeof saved.textSize === 'number') this.setTextSize(saved.textSize);
    if (typeof saved.cameraSpeed === 'number') this.setCameraSpeed(saved.cameraSpeed);
    if (bool('smoothRendering')) this.world.setSmoothRendering(saved.smoothRendering);
    if (bool('fog')) this.setFog(saved.fog);
  }
  toast(text, kind = 'info') {
    if (kind === 'error') playError();
    this.setState({ toast: { text, kind, id: ++this._toastId } });
    this._hudMessage = { text, until: performance.now() + 2200 };
  }
  /**
   * One line in the console (and so the debug panel's log) for a creature's game event:
   * "[turn 42] consume | Crawly #17 | size 1 | ate Berry". The index is the block's instance
   * index, the size its cluster's (a Squirmy's length). Not for other blocks (Dirt soaking up
   * Water, trees drinking): they happen all the time, and a tree's or the soil's cluster is
   * big to measure.
   */
  _logEvent(kind, block, detail) {
    if (!isCreature(block.type)) return;
    const inWorld = this.world.get(block.x, block.y, block.z) === block;
    const size = inWorld ? this.world.clusterOf(block).length : 1;
    console.log(` | Turn ${this.world.turn} | ${blockProps(block.type).name} #${block.index} | size ${size} | ${kind} | ${detail}`);
  }

  /** Refreshes the HUD's block total (the Left HUD's Mean Diameter). */
  _syncCount() {
    if (this.state.blockCount !== this.world.size) this.setState({ blockCount: this.world.size });
  }

  // ---------------------------------------------------------------- setup
  _initRenderer() {
    // Options → Video → Anti-aliasing: a WebGL context's multisampling is fixed when it's made, so
    // the saved setting is read here, and a change takes effect on the next page load
    const antialias = loadOptionsCookie()?.antialias !== false;
    this.state.antialiasActive = antialias;
    const r = new THREE.WebGLRenderer({ antialias, alpha: true });
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
    // "up" turns with it; the world is a planet, so there's no fixed horizon. Near the ground the
    // camera eases, gently, so down is down: see _settleCamera)
    const controls = new TrackballControls(cam, this.renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }; // left: also tools (a click: see _onPointerUp)
    controls.keys = ['', '', '']; // no A / S / D mode keys (the game uses the keyboard)
    controls.rotateSpeed = ROTATE_SPEED; // (negated each frame while inverted: see _cameraSign)
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
    this.world.on('creatureBlocked', (creature) => playSfx('bump', 150, at(creature))); // steered where it can't go
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
    this.world.on('inventoryMoved', ({ blocks }) => playSfx('churn', 90, at(blocks[0])));
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
    // you could select, and the target cell's dot (plus its per-turn spreading copies)
    this.selectHLs = []; // glow spheres (makeGlowMaterial): one per block of each selected creature…
    this.hoverHLs = []; // …and, lighter, of a creature you could select
    this._selectGlow = makeGlowMaterial(SELECT_GREEN, 0.55);
    this._hoverGlow = makeGlowMaterial('#9be8a8', 0.35);
    this._hoverCreature = null;
    this._targetDotGeo = new THREE.SphereGeometry(TARGET_DOT_RADIUS_CM, 16, 12);
    this.targetHL = new THREE.Mesh(this._targetDotGeo, new THREE.MeshBasicMaterial({ color: SELECT_GREEN, toneMapped: false }));
    this.targetHL.renderOrder = 3;
    this.targetHL.visible = false;
    root.add(this.targetHL);
    // …and a dotted line to it from each selected creature's head
    const targetLineGeo = new THREE.BufferGeometry();
    targetLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TARGET_LINES_MAX * 6), 3).setUsage(THREE.DynamicDrawUsage));
    this.targetLine = new THREE.LineSegments(targetLineGeo, new THREE.LineDashedMaterial({
      color: SELECT_GREEN, dashSize: TARGET_LINE_DOT_CM, gapSize: TARGET_LINE_GAP_CM, transparent: true, opacity: 0.85, depthWrite: false,
    }));
    this.targetLine.frustumCulled = false;
    this.targetLine.renderOrder = 3;
    this.targetLine.visible = false;
    root.add(this.targetLine);
    // Creature controls (Accessibility → Direction Guides), each in its creature's own colour: a
    // small dot on the cell each steered creature will step into next turn…
    this._stepMarkerGeo = new THREE.SphereGeometry(STEP_MARKER_RADIUS_CM, 16, 12);
    this._stepMarkerMats = new Map(); // colour -> material
    this.stepMarkers = [];
    // …thin lines from its cell's centre to each cell it could step into…
    const lines = (opacity, depthTest = true) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STEP_LINES_MAX * 6), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(STEP_LINES_MAX * 6), 3).setUsage(THREE.DynamicDrawUsage));
      const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, depthTest }));
      l.frustumCulled = false;
      l.renderOrder = 3;
      l.visible = false;
      root.add(l);
      return l;
    };
    this.stepLines = lines(0.45);
    // …and, while it moves, a line from the cell it left to the one it's moving into
    this.moveLines = lines(0.8);
    // aimed Eat / Excrete (hold Y / B): lines to each choice, drawn over the blocks (what's eaten
    // is usually solid), and a dot on the chosen one (also over the blocks): see _padAim
    this._aim = null; // { kind: 'eat' | 'excrete', button, stick } while its button is held
    this.aimLines = lines(0.7, false);
    this.aimLines.renderOrder = 4;
    this.aimDots = [];
    // Accessibility → View Internal: the selected / controlled creatures' inventories, inside them
    this.inventoryView = new InventoryView(this.world, root);
    // a new grid mode (World.setGridMode): every wireframe takes the new block shape
    onGridChange(() => {
      for (const hl of [this.placeHL, this.deleteHL]) buildWireframe(hl);
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
    // the left controller points at panels too (its trigger presses them): its ray shows only then
    this.rayLineLeft = this.rayLine.clone();
    this.rayLineLeft.visible = false;
    this.rayDotLeft = this.rayDot.clone();

    this.rightHud = new RightHudPanel();
    this.menuPanel = new MenuPanel();
    this.debugTablet = new DebugTablet(); // Options → Debug, in XR
    this.viewPanel = new ViewPanel(); // back to the Normal view
    // the XR panels, like the windowed ones (each with its toggle button): where each docks at
    // first (`home`), its size in the gaze dock and held / free (`*Scale`; docked: the panel's own dockScale), where it is
    // docked now (`dock`: 'left', 'right' or null: free in the room) and where it shows (`on`:
    // that controller, the other when that one's missing, 'gaze' without controllers, or null)
    this._panels = {
      options: { panel: this.menuPanel, home: 'left', gazeScale: 1, freeScale: 1 },
      debug: { panel: this.debugTablet, home: 'left', gazeScale: 1, freeScale: 1 },
      view: { panel: this.viewPanel, home: 'left', gazeScale: 1, freeScale: 1.6 },
      right: { panel: this.rightHud, home: 'right', gazeScale: 1, freeScale: 1.6 },
    };
    for (const e of Object.values(this._panels)) {
      Object.assign(e, { dock: e.home, on: null });
      e.panel.mesh.visible = false;
      this.scene.add(e.panel.mesh);
    }
    this._panelGrabs = { left: null, right: null }; // a panel held in that hand's grip (see _takePanel)
    this._gripTaps = { left: null, right: null }; // each grip's last press and tap, for double taps
    this._resizing = null; // the panel (key) whose resize handle a trigger is dragging
    this._resizeHover = null; // the panel whose resize handle the pointer is on
    this._uiHand = null; // whose pointer is on a panel: 'right', 'left' or 'gaze' (see _updateTarget)
    this._uiPress = null; // the hand holding its trigger on a panel (dragging a slider or a resize handle)
    for (const [key, { panel }] of Object.entries(this._panels)) {
      try {
        // each panel's size (drag its corner) is remembered in this browser
        const size = JSON.parse(localStorage.getItem(`xrPanelSize.${key}`));
        if (size) panel.size = size;
      } catch {}
    }
    this._tabletHover = false;

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
          this.scene.add(this.rayDot);
        } else {
          ctrl.add(this.rayLineLeft);
          this.scene.add(this.rayDotLeft);
        }
      });
      ctrl.addEventListener('disconnected', () => {
        for (const h of ['left', 'right']) if (this.hands[h] === slot) this.hands[h] = null;
        if (this.rayLine.parent === ctrl) ctrl.remove(this.rayLine);
        if (this.rayLineLeft.parent === ctrl) ctrl.remove(this.rayLineLeft);
        // its panels go to the other controller (or the gaze dock) next frame; one it held stays where it is
        for (const h of ['left', 'right']) if (this._panelGrabs[h]?.slot === slot) this._panelGrabs[h] = null;
        for (const e of Object.values(this._panels)) if (e.panel.mesh.parent === ctrl) this.scene.attach(e.panel.mesh);
        slot.source = null;
        slot.gripHeld = false;
        this._beginGrab();
      });
      ctrl.addEventListener('selectstart', () => {
        if (this.hands.right === slot) this._onRightTrigger();
        else if (this.hands.left === slot) this._onLeftTrigger();
        else if (!slot.source && this._gazeMode()) this._onGazeTap();
      });
      ctrl.addEventListener('selectend', () => {
        const hand = this._handOf(slot);
        if (hand && this._uiPress === hand) {
          this._uiPress = null;
          this._sliderDrag = null;
          this._endResize();
        }
      });
      // Grips: one hand drags the build, both hands rotate + scale it (Tilt Brush style).
      // A grip touching or pointing at a panel takes the panel instead, and a double tap docks
      // or undocks panels (see _gripPanelStart).
      ctrl.addEventListener('squeezestart', () => {
        if (this._gripPanelStart(slot)) return;
        slot.gripHeld = true;
        this._beginGrab();
      });
      ctrl.addEventListener('squeezeend', () => {
        this._gripPanelEnd(slot);
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
      // left drag orbits the camera (like right drag); a left click, released where it was
      // pressed, uses the tool (_onPointerUp)
      this._press = { x: e.clientX, y: e.clientY, id: e.pointerId };
    };
    this._onPointerUp = (e) => {
      const press = this._press;
      this._press = null;
      if (e.button !== 0 || !press || press.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_MAX_MOVE_PX) return; // a drag: it moved the camera
      if (this.state.screen === 'playing' && !this.state.paused && !this.state.inXR) {
        this._onPointerMove(e);
        this._updateTarget();
        this.useTool();
      }
    };
    this._onDoubleClick = (e) => {
      if (e.button !== 0 || this.state.screen !== 'playing' || this.state.paused || this.state.inXR) return;
      this._onPointerMove(e);
      this._doubleClickCreature();
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
    el.addEventListener('pointerup', this._onPointerUp);
    el.addEventListener('dblclick', this._onDoubleClick);
    el.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
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
    if (this._keyCreatureDown(e)) {
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyG') {
      // G: Direction Guides on / off
      e.preventDefault();
      this.toggleDirectionGuides();
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
    // (closes Options on its main screen); Right on a button with an arrow (a submenu) or a closed dropdown or
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

  /** The gear button (the HUD's in XR): open Options, pausing the game, or close it, resuming. */
  toggleMenu() {
    if (this.state.screen !== 'playing') return;
    if (this.state.paused) this.resume();
    else this.pause();
  }

  pause() {
    if (this.state.screen !== 'playing') return;
    this.setState({ paused: true, menu: 'main', page: 0, dropdown: null, menuFocus: this.state.gamepadAim ? focusables(menuModel(this.state))[0]?.id ?? null : null });
    playPause();
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

  /** The Right panel's (and XR Right HUD's) title: Observer, or under Creature controls the controlled creature's type. */
  rightHudTitle(s = this.state) {
    if (s.controlSchema !== 'creature') return 'Observer';
    const c = this._controlled?.[0];
    return c ? blockProps(c.type).name : 'Creature';
  }

  /** The Right panel's (and XR Right HUD's) eye button: shows it, or hides all but the button; remembered. */
  toggleRightHud() {
    this.setState({ rightHudOpen: !this.state.rightHudOpen });
    playTick();
    this._saveOptions();
  }

  /**
   * Per frame: what the selected creatures could do now (state.actions, for the Right panel /
   * HUD): Eat, with a free head slot and something edible next to it (the distinct types); Excrete,
   * with an item in its tail's slot and an empty cell next to the tail (what it would come out
   * as). And which input to show their buttons for (state.inputDevice). Only set when it changes.
   */
  _updateActions() {
    const s = this.state;
    const eat = new Set();
    let excrete = null;
    if (s.screen === 'playing' && this.toolsReady(s)) {
      for (const c of this.selected) {
        if (this.world.get(c.x, c.y, c.z) !== c) continue;
        if (this.world.freeSlotFor(c)) for (const b of edibleNeighbors(this.world, c)) eat.add(b.type);
        const tail = this.world.clusterOf(c).at(-1);
        if (!excrete && tail.inventory && excretableCells(this.world, c).length) excrete = excretedType(tail.type, tail.inventory);
      }
    }
    const actions = { eat: [...eat].sort(), excrete };
    const inputDevice = s.inXR && !this.screenUI(s) ? 'xr' : s.gamepadAim ? 'pad' : 'mk';
    if (JSON.stringify(actions) !== JSON.stringify(s.actions) || inputDevice !== s.inputDevice) this.setState({ actions, inputDevice });
  }

  /** The input glyphs (inputIcons.js tokens) for Consume, Excrete and using the tool on `device` ('mk', 'pad', 'xr'). */
  static ACTION_GLYPHS = {
    mk: { eat: ['key:E'], excrete: ['key:Q'], tool: ['mouse:L'] },
    pad: { eat: ['pad:Y'], excrete: ['pad:B'], tool: ['pad:A'] },
    xr: { eat: ['xr:B'], excrete: ['xr:A'], tool: ['xr:trigger:R'] },
  };

  /** The Right panel's (and XR Right HUD's) Tools dropdown: opens or closes the tool selector; remembered. */
  toggleToolsOpen() {
    this.setState({ toolsOpen: !this.state.toolsOpen });
    playTick();
    this._saveOptions();
  }

  /** HUD label for the current tool (the Select tool shows its phase). */
  toolLabel(s = this.state) {
    if (!this.toolsAvailable(s)) {
      // Creature controls: no tools, just who you're controlling
      const c = this._controlled?.[0];
      return c ? `Controlling ${blockProps(c.type).name}` : 'Creature controls';
    }
    const tool = TOOLS[s.toolIndex];
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
   * `targeting`: the Select tool goes on to pick where it walks (its 'target' phase; by default
   * whenever something is selected).
   */
  _setSelected(list, targeting = list.length > 0) {
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
      if (list.length) {
        this._setControlled(list);
        if (this._pov && !list.includes(this._pov.creature)) this._startCreatureView(list[0]); // the view follows
      } else this.setControlSchema('observer');
    }
    this._setTargeting(targeting && list.length > 0);
  }

  /**
   * The Select tool's phase: 'target' (pick where the selection walks: the target dot and its
   * dotted line) or 'select' (pick a creature; one that's selected stays selected). Switching
   * between Observer and Creature controls goes back to 'select'.
   */
  _setTargeting(on) {
    this._targeting = on;
    const phase = on ? 'target' : 'select';
    if (this.state.selectPhase !== phase) this.setState({ selectPhase: phase });
  }

  /**
   * Gamepad Y / Touch B: each selected creature eats the block in front of it (its `front`
   * side; for a Squirmy, its head's), or else the edible block next to it closest to its front, if its
   * head's inventory slot is free. If none of them can, "ineffective" plays.
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

  // ---------------------------------------------------------------- creature view (Creature controls)

  /**
   * Creature controls' camera: the Observer camera, but orbiting `creature`'s head and carried
   * along with it; it starts close, above and behind it (see _updateCreatureView). Already in
   * the view: it moves to `creature` (placed close again). Not in XR (the headset is the
   * camera there).
   */
  _startCreatureView(creature) {
    if (this._immersive) return;
    // the camera flies in from where it is now (the reverse of the zoom out back to Observer),
    // turning from what it looks at now to the head as it goes
    const zoomIn = { pos: this.camera.position.clone(), up: this.camera.up.clone(), look: this._lookPoint(), t: 0 };
    this._lookBlend = null;
    if (this._pov) {
      Object.assign(this._pov, { creature, desired: null, head: null, zoomIn });
      return;
    }
    const c = this.controls;
    this._pov = {
      creature,
      desired: null, // where the orbit puts the camera (world space; before collisions pull it in)
      head: null, // the head's position last frame (world space)
      zoomIn, // while flying in: where from (world space), and how far along (0–1, over ZOOM_OUT_S)
      saved: { pos: this.camera.position.clone(), target: c.target.clone(), up: this.camera.up.clone(), minDistance: c.minDistance },
    };
    c.noPan = true; // (it stays on the head)
    c.minDistance = POV_MIN_DISTANCE_M;
  }

  /**
   * Back to the orbiting camera, where it was before the creature's view. `zoomOut`: instead it
   * stays where it is, turns to orbit the world's origin, and moves out from there to the
   * distance it had before (see _stepZoomOut).
   */
  _endCreatureView({ zoomOut = false } = {}) {
    const p = this._pov;
    if (!p) return false;
    this._pov = null;
    const { pos, target, up, minDistance } = p.saved;
    if (zoomOut) {
      this.controls.noPan = false;
      this.controls.minDistance = minDistance;
      this._orbitOrigin(); // (turning to it over the zoom out)
      this._camSafe = this.worldRoot.worldToLocal(this.camera.position.clone()); // sweeps on from here
      const from = this.camera.position.distanceTo(this.controls.target), to = pos.distanceTo(this.controls.target);
      this._zoomOut = to > from ? { from, to, t: 0 } : null;
      return true;
    }
    this.camera.position.copy(pos);
    this.camera.up.copy(up);
    this.controls.target.copy(target);
    this.controls.noPan = false;
    this.controls.minDistance = minDistance;
    this.camera.lookAt(target);
    this._camSafe = null; // a jump: no collision sweep from the creature's head
    this._stopControlsMomentum();
    this.controls.update();
    return true;
  }

  /**
   * Per frame (instead of the Observer camera's own update): the orbit target is the creature's
   * head as drawn (sliding), and the camera is carried along by however far it moved, so it
   * keeps its own heading as the creature turns. The trackball, the right stick and the zoom
   * then orbit and zoom about it as in Observer controls. Where the orbit wants the camera
   * (`desired`) is kept apart from where it's drawn: the camera is swept out from the head to
   * there through the camera collider (the creature's own blocks left out), so walls and
   * ceilings pull it in, and it goes back out once they're gone.
   */
  _updateCreatureView(now, dt) {
    const p = this._pov, c = p.creature;
    if (this.world.get(c.x, c.y, c.z) !== c) {
      // it's gone (died, deleted, a new world): on to another controlled creature, else back to Observer
      const next = (this._controlled ?? []).find((o) => o !== c && this.world.get(o.x, o.y, o.z) === o);
      if (next) this._startCreatureView(next);
      else if (this.state.controlSchema === 'creature') this.setControlSchema('observer');
      else this._endCreatureView();
      return;
    }
    const root = this.worldRoot;
    const centre = this.world.renderedPosition(c, now, new THREE.Vector3()); // cm, lattice space
    const head = root.localToWorld(centre.clone());
    if (!p.desired) {
      // first frame: close above and behind it, its up as up
      const q = this.world.eyes.state.get(c)?.q ?? _povQ.identity();
      const frame = q.clone().multiply(_povTurn);
      p.desired = root.localToWorld(POV_BOOM.clone().applyQuaternion(frame).add(centre));
      this.camera.up.set(0, 1, 0).applyQuaternion(frame).applyQuaternion(root.getWorldQuaternion(_povQ));
      this._stopControlsMomentum();
    } else p.desired.add(head.clone().sub(p.head));
    p.head = head;
    this.controls.target.copy(head);
    this.camera.position.copy(p.desired);
    this.controls.update();
    p.desired.copy(this.camera.position);
    this._settleCamera(dt, p.desired, head);
    const want = root.worldToLocal(p.desired.clone());
    this.cameraCollider ??= new CameraCollider(this.world);
    // (dt Infinity: a block that comes near pushes it straight out; it's swept afresh each frame anyway)
    const { pos } = this.cameraCollider.resolve(centre, want, now, Infinity, want.clone().sub(centre), new Set(this._bodyOf(c)));
    this.camera.position.copy(root.localToWorld(pos));
    const z = p.zoomIn;
    if (!z) return void this.camera.lookAt(head);
    // flying in (the reverse of the zoom out): drawn from where the camera was, eased into where
    // the view has it; its up blends too, for this frame's look only (the orbit keeps its own)
    z.t = Math.min(1, z.t + dt / ZOOM_OUT_S);
    if (z.t >= 1) p.zoomIn = null;
    const e = THREE.MathUtils.smootherstep(z.t, 0, 1);
    const orbitUp = this.camera.up.clone();
    this.camera.position.lerpVectors(z.pos, this.camera.position, e);
    this.camera.up.lerpVectors(z.up, orbitUp, e);
    if (this.camera.up.lengthSq() < 1e-6) this.camera.up.copy(orbitUp); // (turning right over: no blend half way)
    this.camera.lookAt(_povLook.lerpVectors(z.look, head, e));
    this.camera.up.copy(orbitUp);
  }

  /** Where the camera is looking: the point on its view line as far off as its orbit target. */
  _lookPoint() {
    const cam = this.camera;
    return cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(cam.position.distanceTo(this.controls.target)).add(cam.position);
  }

  /**
   * Per frame (Observer controls, after the orbit's own update): after leaving a creature's view
   * the camera turns from what it was looking at (the head) to its new orbit target (the origin)
   * over ZOOM_OUT_S, eased, instead of all at once. The orbit itself already orbits the new
   * target; this only turns the view.
   */
  _applyLookBlend(dt) {
    const b = this._lookBlend;
    if (!b) return;
    b.t = Math.min(1, b.t + dt / ZOOM_OUT_S);
    if (b.t >= 1) this._lookBlend = null;
    this.camera.lookAt(_povLook.lerpVectors(b.from, this.controls.target, THREE.MathUtils.smootherstep(b.t, 0, 1)));
  }

  // ---------------------------------------------------------------- control schemas

  /** R3: Observer → Creature controls (needs a selected creature), or back. */
  toggleControlSchema() {
    if (this.state.controlSchema === 'creature') return this.setControlSchema('observer');
    if (!this.selected.length) {
      playSfx('ineffective', 0);
      return false;
    }
    return this.setControlSchema('creature');
  }

  /**
   * Switches control schema (controls.js): 'creature' puts the selected creatures under the
   * player's control and takes on the first one's view (the camera orbits it, up close).
   * Back to 'observer' leaves that view: the camera goes back where it was, orbiting the
   * world's origin.
   */
  setControlSchema(id) {
    if (this.state.controlSchema === id) return false;
    if (id === 'observer') {
      if (!this._endCreatureView({ zoomOut: true })) this._orbitOrigin();
    } else if (this.selected[0]) this._startCreatureView(this.selected[0]);
    this._setControlled(id === 'creature' ? this.selected : []);
    this.setState({ controlSchema: id });
    this._setTargeting(false); // Select: back to picking a creature, not where it walks
    playSfx(id === 'creature' ? 'controlCreature' : 'controlObserver', 0);
    return true;
  }

  /**
   * Double-clicking a creature (any block of it, under the mouse) switches the mode. In
   * Observer controls: it becomes the selection and you take control of it (its view). In
   * Creature controls: one you're controlling lets go (back to Observer); another creature
   * is taken over instead (the view moves to it).
   */
  _doubleClickCreature() {
    if (!this.mouse) return false;
    this.raycaster.setFromCamera(this._viewMouse(), this.camera);
    this.raycaster.far = DESKTOP_RAY_LENGTH;
    return this._switchToCreature(this._creatureOf(this._pick()?.block));
  }

  /**
   * A double-click (XR: a double trigger press) on `creature` switches the mode, as
   * _doubleClickCreature says. Returns whether it did anything (nothing for no creature).
   */
  _switchToCreature(creature) {
    if (!creature) return false;
    const creatureControls = this.state.controlSchema === 'creature';
    if (creatureControls && this._controlled?.includes(creature)) return this.setControlSchema('observer');
    if (this.selected.length !== 1 || this.selected[0] !== creature) this._setSelected([creature], false); // (taking its view: Select picks creatures, not targets)
    if (creatureControls) {
      playSfx('controlCreature', 0); // (the view followed the selection)
      return true;
    }
    return this.setControlSchema('creature');
  }

  /**
   * Per frame after leaving a creature's view: the camera moves out from the origin (along
   * the line it's on) to its old distance over ZOOM_OUT_S, easing in and out. The trackball,
   * the sticks and collisions still apply on top; a new creature view ends it.
   */
  _stepZoomOut(dt) {
    const z = this._zoomOut;
    if (!z) return;
    if (this._pov) return void (this._zoomOut = null);
    const before = z.from + (z.to - z.from) * THREE.MathUtils.smootherstep(z.t, 0, 1);
    z.t = Math.min(1, z.t + dt / ZOOM_OUT_S);
    const after = z.from + (z.to - z.from) * THREE.MathUtils.smootherstep(z.t, 0, 1);
    const off = this.camera.position.clone().sub(this.controls.target);
    off.setLength(off.length() * (after / before)); // (relative: zooming meanwhile still counts)
    this.camera.position.copy(this.controls.target).add(off);
    if (z.t >= 1) this._zoomOut = null;
  }

  /**
   * The camera stays where it is, but orbits the world's origin from now on, turning to look at
   * it over ZOOM_OUT_S (_applyLookBlend), not at once.
   */
  _orbitOrigin() {
    this._lookBlend = this._immersive ? null : { from: this._lookPoint(), t: 0 }; // (XR: the headset is the camera)
    this.controls.target.copy(this.worldRoot.localToWorld(new THREE.Vector3()));
    this._stopControlsMomentum();
    this.controls.update();
    this._applyLookBlend(0); // (this frame still looks where it did)
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
   * walker's direction is kept along the ground it's on (perpendicular to "up": away from its
   * floor block, or from the world's centre when it has none); a flyer goes straight where the
   * camera looks. But when one of the cells it could step into (the step lines) lies that way
   * on screen, it goes there: the line nearest the stick's direction as drawn, so a step up a
   * ledge or a wall goes where it looks like it goes. Kept (`creature.steer`) until its next
   * turn uses it (sim: steeredCell), so a quick flick between turns still counts.
   */
  _steerControlled(sx, sy) {
    if (!sx && !sy) return;
    this._steerStick = [sx, sy]; // (for the step lines; cleared each gamepad poll)
    const toLattice = this.worldRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
    const look = this.camera.getWorldDirection(new THREE.Vector3()).applyQuaternion(toLattice);
    const screenRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).applyQuaternion(toLattice);
    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).applyQuaternion(toLattice);
    for (const c of this._controlled ?? []) {
      const fwd = look.clone(), right = screenRight.clone();
      if (!canFly(c)) {
        // (on a wall or under a ledge "up" is away from that, not from the world's centre)
        const up = c.floor ? new THREE.Vector3(...c.floor).negate() : new THREE.Vector3(c.x, c.y, c.z);
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
      c.steer = this._steerAlongLine(c, sx, sy) ?? [dir.x, dir.y, dir.z];
    }
  }

  /**
   * Creature controls, L3 held: each controlled creature steps the way that goes most nearly
   * away from the camera (the largest share of the view direction, in 3D) of the cells it could
   * step into; with none it's steered straight along the view, so it bumps.
   */
  _steerAway() {
    const toLattice = this.worldRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
    const look = this.camera.getWorldDirection(new THREE.Vector3()).applyQuaternion(toLattice);
    for (const c of this._controlled ?? []) {
      let best = null, bestDot = 0; // (never toward the camera)
      for (const t of steppableCells(this.world, c)) {
        const d = new THREE.Vector3(t.x - c.x, t.y - c.y, t.z - c.z).normalize();
        const dot = d.dot(look);
        if (dot <= bestDot) continue;
        best = d;
        bestDot = dot;
      }
      const dir = best ?? look;
      c.steer = [dir.x, dir.y, dir.z];
    }
  }

  /**
   * The step (lattice offset) from `c` to the cell it could step into whose line on screen is
   * nearest the stick's direction (`sx`, `sy`: right, down), within STEER_SCREEN_COS; null if
   * none.
   */
  _steerAlongLine(c, sx, sy) {
    let best = null, bestCos = STEER_SCREEN_COS;
    for (const { t, cos } of this._stepCosines(c, sx, sy) ?? []) {
      if (cos <= bestCos) continue;
      const d = Math.hypot(t.x - c.x, t.y - c.y, t.z - c.z);
      best = [(t.x - c.x) / d, (t.y - c.y) / d, (t.z - c.z) / d];
      bestCos = cos;
    }
    return best;
  }

  /** Each cell `c` could step into, with its cosine on screen: see _screenCosines. */
  _stepCosines(c, sx, sy) {
    return this._screenCosines(c, steppableCells(this.world, c), sx, sy);
  }

  /**
   * Each of `cells` (`t`) with the cosine (`cos`) between the stick's direction (`sx`, `sy`:
   * right, down) and the line from cell `c` to it as drawn on screen; null when `c` is behind
   * the camera. A line seen end-on, or reaching behind the camera, is left out.
   */
  _screenCosines(c, cells, sx, sy) {
    const s = GRID.scale;
    const toScreen = (x, y, z) => {
      const p = this.worldRoot.localToWorld(new THREE.Vector3(x * s, y * s, z * s)).project(this.camera);
      return p.z < 1 ? p : null; // (behind the camera: no use)
    };
    const from = toScreen(c.x, c.y, c.z);
    if (!from) return null;
    const stick = Math.hypot(sx, sy);
    const out = [];
    for (const t of cells) {
      const to = toScreen(t.x, t.y, t.z);
      if (!to) continue;
      const vx = (to.x - from.x) * this.camera.aspect, vy = to.y - from.y; // NDC y is up
      const len = Math.hypot(vx, vy);
      if (len < 1e-6) continue;
      out.push({ t, cos: (vx * sx - vy * sy) / (len * stick) });
    }
    return out;
  }

  /**
   * Creature controls: a dot on the cell each controlled creature will step into on its next
   * turn as it is being steered (sim.js nextSteppedCell); none while it isn't steered, or can't
   * go that way (it bumps instead). Lines run from each one's cell to the cells it could step
   * into (sim.js steppableCells): all the way while the stick is at rest; while it's pushed, as far as it points
   * along each (its cosine with the line on screen; with the step in 3D if the creature is
   * behind the camera): all the way when it points right along it, not at all at 90° or more.
   * While it moves, a line runs from the cell it left to the one it's moving into. All in its
   * own colour; only with Accessibility → Direction Guides on.
   */
  _updateStepMarkers() {
    const on = this.state.controlSchema === 'creature' && this.state.screen === 'playing' && this.state.directionGuides && !this._aim; // (aiming: its own guides)
    const controlled = on ? (this._controlled ?? []).filter((c) => this.world.get(c.x, c.y, c.z) === c) : [];
    const markers = controlled.map((c) => ({ c, cell: nextSteppedCell(this.world, c) })).filter((m) => m.cell);
    const draw = (lines, segments) => this._drawGuideLines(lines, segments);
    const stick = this._steerStick;
    const steps = [];
    for (const c of controlled) {
      // the stick at rest: a line all the way to every cell it could step into
      const cosines = !stick ? steppableCells(this.world, c).map((t) => ({ t, cos: 1 })) : this._stepCosines(c, ...stick) ?? steppableCells(this.world, c).map((t) => {
        const d = [t.x - c.x, t.y - c.y, t.z - c.z];
        const st = c.steer ?? [0, 0, 0];
        return { t, cos: (d[0] * st[0] + d[1] * st[1] + d[2] * st[2]) / Math.hypot(...d) };
      });
      for (const { t, cos } of cosines) {
        if (cos > 0) steps.push([c, c, { x: c.x + (t.x - c.x) * cos, y: c.y + (t.y - c.y) * cos, z: c.z + (t.z - c.z) * cos }]);
      }
    }
    draw(this.stepLines, steps);
    draw(this.moveLines, controlled.map((c) => {
      const slide = this.world.slideOf(c);
      return slide && [c, slide.from, slide.to];
    }).filter(Boolean));
    this._placeGuideDots(this.stepMarkers, markers);
  }

  /** Fills guide `lines` with `segments` ([creature, from, to]: lattice units), each in its creature's colour. */
  _drawGuideLines(lines, segments) {
    const s = GRID.scale, color = new THREE.Color();
    const pos = lines.geometry.getAttribute('position'), col = lines.geometry.getAttribute('color');
    const n = Math.min(segments.length, STEP_LINES_MAX);
    for (let i = 0; i < n; i++) {
      const [c, a, b] = segments[i];
      color.set(BLOCK_COLORS[c.type]);
      pos.setXYZ(i * 2, a.x * s, a.y * s, a.z * s);
      pos.setXYZ(i * 2 + 1, b.x * s, b.y * s, b.z * s);
      col.setXYZ(i * 2, color.r, color.g, color.b);
      col.setXYZ(i * 2 + 1, color.r, color.g, color.b);
    }
    pos.needsUpdate = col.needsUpdate = n > 0;
    lines.geometry.setDrawRange(0, n * 2);
    lines.visible = n > 0;
  }

  /**
   * Puts a guide dot (from pool `dots`, grown as needed) on each of `marks` ({ c: creature, cell }),
   * in its creature's colour; the rest hide. `overlay`: drawn over everything (never hidden by blocks).
   */
  _placeGuideDots(dots, marks, { overlay = false } = {}) {
    while (dots.length < marks.length) {
      const m = new THREE.Mesh(this._stepMarkerGeo);
      m.renderOrder = overlay ? 4 : 3; // after the see-through passes
      this.worldRoot.add(m);
      dots.push(m);
    }
    dots.forEach((m, i) => {
      m.visible = i < marks.length;
      if (!m.visible) return;
      const { c, cell } = marks[i];
      const hex = BLOCK_COLORS[c.type], key = overlay ? `${hex}:over` : hex;
      if (!this._stepMarkerMats.has(key)) this._stepMarkerMats.set(key, new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: overlay ? 0.9 : 0.75, depthWrite: false, depthTest: !overlay }));
      m.material = this._stepMarkerMats.get(key);
      m.position.set(cell.x, cell.y, cell.z).multiplyScalar(GRID.scale);
    });
  }

  // ---------------------------------------------------------------- aimed Eat / Excrete
  // Gamepad: hold Y (Eat) or B (Excrete) and the left stick chooses which way, like steering:
  // the block next to the creature to eat, or the empty cell next to its tail to excrete into,
  // whose line on screen is nearest the stick's direction. It happens on letting go of the
  // button; let go without pushing the stick, and it's the usual Eat / Excrete. Meanwhile guide
  // lines run to each choice (drawn over the blocks: what's eaten is usually solid; the stick
  // shortens them toward its way), and the chosen block or cell gets a dot (over the blocks too),
  // in the creature's colour.

  /**
   * Each selected creature's choices for aim `kind` ('eat' | 'excrete'): from where (`from`: the
   * creature, or its tail), to which cells (`steps`: { t, cos }, cos 1 with the stick at rest),
   * and the one the stick picks (`best`; null at rest, or with nothing that way).
   */
  _aimChoices(kind, stick) {
    const out = [];
    for (const c of this.selected) {
      if (this.world.get(c.x, c.y, c.z) !== c) continue;
      const from = kind === 'eat' ? c : this.world.clusterOf(c).at(-1);
      const cells = kind === 'eat' ? edibleNeighbors(this.world, c) : excretableCells(this.world, c);
      const steps = stick ? this._screenCosines(from, cells, ...stick) ?? [] : cells.map((t) => ({ t, cos: 1 }));
      let best = null, bestCos = 0;
      if (stick) for (const { t, cos } of steps) if (cos > bestCos) [best, bestCos] = [t, cos];
      out.push({ c, from, steps, best });
    }
    return out;
  }

  /**
   * Holding Y / B (gamepad buttons 3 / 1): starts, follows (the left stick) and, on letting go,
   * carries out an aimed Eat / Excrete. Returns whether one is being aimed (the left stick is
   * taken: no steering meanwhile).
   */
  _padAim(pressed, prev, ax) {
    const s = this.state;
    const ok = s.screen === 'playing' && !this.isMenuOpen(s);
    if (this._aim && this._aim.source !== 'pad') return false; // (the keyboard's: _pollKeys)
    if (!this._aim && ok) {
      for (const [button, kind] of [[3, 'eat'], [1, 'excrete']]) {
        if (pressed[button] && !prev[button]) {
          this._aim = { kind, source: 'pad', button, stick: null };
          break;
        }
      }
    }
    const a = this._aim;
    if (!a) return false;
    if (!ok) return void (this._aim = null);
    if (pressed[a.button]) {
      const sx = ax(0), sy = ax(1);
      if (sx || sy) a.stick = [sx, sy]; // (the last way it was pushed counts)
      return true;
    }
    this._finishAim(a); // let go: do it
    return false;
  }

  /** Carries out aim `a` (its button / key let go): the way it was aimed, or, never aimed, the usual Eat / Excrete. */
  _finishAim(a) {
    this._aim = null;
    if (!a.stick) return void (a.kind === 'eat' ? this.selectedEat() : this.selectedExcrete());
    if (!this.selected.length || !this.toolsReady()) return void playSfx('ineffective', 0);
    let did = false;
    for (const { c, best } of this._aimChoices(a.kind, a.stick)) {
      if (!best) continue;
      if (a.kind === 'eat' ? creatureEat(this.world, c, best) : this.world.excrete(this.world.clusterOf(c), 'excrete', { cell: best })) did = true;
    }
    if (did) this._syncCount();
    else playSfx('ineffective', 0);
  }

  // ---------------------------------------------------------------- keyboard creature controls
  // WASD / the arrow keys are a left stick (Creature controls: they steer, like _steerControlled;
  // with E or Q held they aim it instead); Shift held is L3 (straight away from the camera: _steerAway). E eats, Q excretes (any controls), on letting go: held
  // with a direction, the way it was aimed (like holding the gamepad's Y / B).

  /** keydown (not typing, playing, not paused): E / Q start an aimed Eat / Excrete; the rest are remembered as held (_pollKeys). Returns whether it used the key. */
  _keyCreatureDown(e) {
    if (e.code === 'KeyE' || e.code === 'KeyQ') {
      if (!e.repeat && !this._aim) this._aim = { kind: e.code === 'KeyE' ? 'eat' : 'excrete', source: 'key', key: e.code, stick: null };
      return true;
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      if (this.state.controlSchema !== 'creature') return false;
      this._keysHeld.add(e.code);
      return true;
    }
    if (!KEY_STICK[e.code]) return false;
    if (this.state.controlSchema !== 'creature' && !this._aim && e.code.startsWith('Arrow')) return false; // (Observer: ← / → change tools)
    this._keysHeld.add(e.code);
    return true;
  }

  _keysHeld = new Set(); // direction keys held down (_keyCreatureDown)

  _onKeyUp = (e) => {
    this._keysHeld.delete(e.code);
    if (this._aim?.source === 'key' && this._aim.key === e.code) {
      const s = this.state;
      if (s.screen === 'playing' && !this.isMenuOpen(s)) this._finishAim(this._aim);
      else this._aim = null;
    }
  };

  /** The window lost focus: no key is held any more (its keyup would never come); a key-held aim is dropped. */
  _onBlur = () => {
    this._keysHeld.clear();
    if (this._aim?.source === 'key') this._aim = null;
  };

  /** Per frame (after the gamepad): the held direction keys steer the controlled creatures (Shift: away from the camera), or aim a key-held Eat / Excrete. */
  _pollKeys() {
    const s = this.state;
    if (s.screen !== 'playing' || this.isMenuOpen(s)) return this._keysHeld.clear();
    const shift = this._keysHeld.has('ShiftLeft') || this._keysHeld.has('ShiftRight');
    if (shift && !this._aim && s.controlSchema === 'creature') return this._steerAway(); // Shift: the way most nearly away from the camera
    let sx = 0, sy = 0;
    for (const code of this._keysHeld) {
      if (!KEY_STICK[code]) continue;
      sx += KEY_STICK[code][0];
      sy += KEY_STICK[code][1];
    }
    const len = Math.hypot(sx, sy);
    if (!len) return;
    sx /= len;
    sy /= len;
    if (this._aim?.source === 'key') this._aim.stick = [sx, sy];
    else if (!this._aim && s.controlSchema === 'creature') this._steerControlled(sx, sy);
  }

  /** Per frame: the aimed Eat / Excrete's guide lines, and a dot on the chosen block / cell (both over the blocks); only with Direction Guides on. */
  _updateAimGuides() {
    const a = this.state.screen === 'playing' && this.state.directionGuides ? this._aim : null;
    const choices = a ? this._aimChoices(a.kind, a.stick) : [];
    const segments = [];
    for (const { c, from, steps } of choices) {
      for (const { t, cos } of steps) {
        if (cos > 0) segments.push([c, from, { x: from.x + (t.x - from.x) * cos, y: from.y + (t.y - from.y) * cos, z: from.z + (t.z - from.z) * cos }]);
      }
    }
    this._drawGuideLines(this.aimLines, segments);
    const chosen = choices.filter((x) => x.best);
    this._placeGuideDots(this.aimDots, chosen.map(({ c, best }) => ({ c, cell: best })), { overlay: true });
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
   * Gamepad B / Touch A: each selected creature excretes the item in its tail's inventory slot
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
      if (this.selected.length === 1 && this.selected[0] === creature) {
        // already selected ('select' phase after a switch of controls): on to picking its target
        if (this._targeting) return false;
        this._setTargeting(true);
        playTick();
        return true;
      }
      this._setSelected([creature]);
      playWait(this._soundAt(creature)); // selecting puts it in Wait
      return true;
    }
    if (!this.selected.length || !this._targeting) return false; // ('select' phase: only creatures)
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

  /** Starts a copy of the target dot that spreads out and fades away over one step animation (it follows the target dot: _showHighlight). */
  _pulseTarget() {
    this._pulseDot(this.targetHL, SELECT_GREEN, { followsTarget: true });
  }

  /** Once a turn: each Direction Guides dot (a step's, an aimed Eat / Excrete's) pulses like the target dot. */
  _pulseGuideDots() {
    for (const dot of this.stepMarkers) if (dot.visible) this._pulseDot(dot, dot.material.color);
    for (const dot of this.aimDots) if (dot.visible) this._pulseDot(dot, dot.material.color, { overlay: true });
  }

  /**
   * Starts a pulse on dot `dot` (a sphere mesh): a copy of it in `color` that spreads out and fades
   * away over one step animation (_updateSelectionVisuals). `overlay`: drawn over the blocks, like
   * the aim dots. `followsTarget`: it moves with the Select target dot.
   */
  _pulseDot(dot, color, { overlay = false, followsTarget = false } = {}) {
    let p = this._pulses.find((q) => !q.obj.visible);
    if (!p) {
      const obj = new THREE.Mesh(dot.geometry, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, depthWrite: false }));
      p = { obj, t0: 0 };
      this.worldRoot.add(p.obj);
      this._pulses.push(p);
    }
    p.obj.geometry = dot.geometry;
    p.obj.material.color.set(color);
    p.obj.material.depthTest = !overlay;
    p.obj.renderOrder = overlay ? 4 : 3;
    p.obj.position.copy(dot.position);
    p.obj.scale.setScalar(1);
    p.obj.visible = true;
    p.followsTarget = followsTarget;
    p.t0 = this.world.time;
  }

  /** Per frame: selection wireframes follow their (possibly sliding) creatures; pulses shrink. */
  _updateSelectionVisuals(now) {
    // a selected creature that was deleted, or changed type, drops out of the selection
    const alive = this.selected.filter((creature) => this.world.get(creature.x, creature.y, creature.z) === creature && this._creatureOf(creature));
    if (alive.length !== this.selected.length) this._setSelected(alive, this._targeting);
    // a soft outline (glow spheres, makeGlowMaterial) round each selected creature (a Squirmy's
    // whole chain), and a lighter one round a creature you are pointing at
    const radius = GLOW_RADIUS * Math.cbrt((3 * GRID.volumeCm3) / (4 * Math.PI)); // (a ball of the cell's volume, scaled)
    const place = (pool, blocks, material) => {
      while (pool.length < blocks.length) {
        const glow = new THREE.Mesh(GLOW_SPHERE, material);
        glow.renderOrder = 3; // after the see-through passes
        this.worldRoot.add(glow);
        pool.push(glow);
      }
      pool.forEach((glow, i) => {
        const b = blocks[i];
        glow.visible = !!b;
        if (!b) return;
        this.world.renderedPosition(b, now, glow.position);
        glow.scale.setScalar(radius);
      });
    };
    const watched = new Set(this._pov ? this._bodyOf(this._pov.creature) : []); // (this close, its own outline would crowd the view)
    place(this.selectHLs, this.selected.flatMap((creature) => this._bodyOf(creature)).filter((b) => !watched.has(b)), this._selectGlow);
    place(this.hoverHLs, this._hoverCreature ? this._bodyOf(this._hoverCreature) : [], this._hoverGlow);
    for (const p of this._pulses) {
      if (!p.obj.visible) continue;
      const k = (now - p.t0) / (this.world.stepSeconds * 1000);
      if (k >= 1) p.obj.visible = false;
      else {
        p.obj.scale.setScalar(1 + 2 * k); // (it moves with the target dot: _showHighlight)
        p.obj.material.opacity = 0.6 * (1 - k);
      }
    }
  }

  /** Per frame, once the target is placed (_updateTarget): the dotted line from each selected creature's head (as drawn, sliding) to the target dot. */
  _updateTargetLine(now) {
    const heads = this.targetHL.visible ? this.selected.slice(0, TARGET_LINES_MAX) : [];
    const pos = this.targetLine.geometry.getAttribute('position');
    const head = new THREE.Vector3();
    heads.forEach((c, i) => {
      this.world.renderedPosition(c, now, head);
      pos.setXYZ(i * 2, head.x, head.y, head.z);
      pos.setXYZ(i * 2 + 1, this.targetHL.position.x, this.targetHL.position.y, this.targetHL.position.z);
    });
    this.targetLine.visible = heads.length > 0;
    if (heads.length) {
      pos.needsUpdate = true;
      this.targetLine.geometry.setDrawRange(0, heads.length * 2);
      this.targetLine.computeLineDistances(); // (the dots run from each head)
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
   * Options → Fog: whether Fog is drawn. Off, it's hidden (still in the world: it drifts, and
   * the simulation sees it as before) and the pointer passes through it.
   */
  setFog(on) {
    this.world.setFogShown(on);
    this.setState({ fog: on });
  }

  /** Sets a menu slider's value (XR pointer, gamepad). */
  _setSlider(id, value) {
    if (value == null) return;
    if (id === 'speed') this.setSpeed(value);
    if (id === 'textSize') this.setTextSize(value);
    if (id === 'cameraSpeed') this.setCameraSpeed(value);
    if (id === 'music') this.setMusicVolume(value);
    if (id === 'sound') this.setSoundVolume(value);
  }

  /** Options → Accessibility → Music / Sounds: a volume, 0 (off) to 1, snapped to the slider's steps. */
  _volume(v) {
    const n = Number(v);
    const raw = THREE.MathUtils.clamp(Number.isFinite(n) ? n : VOLUME.default, VOLUME.min, VOLUME.max);
    return Math.round(raw / VOLUME.step) / Math.round(1 / VOLUME.step); // (in tenths, so 0.3 is 0.3, not 0.30000000000000004)
  }

  /** Options → Accessibility → Camera Speed: scales the camera's turning (mouse and stick), snapped to the slider's steps. */
  setCameraSpeed(multiplier) {
    const n = Number(multiplier);
    const raw = THREE.MathUtils.clamp(Number.isFinite(n) ? n : CAMERA_SPEED.default, CAMERA_SPEED.min, CAMERA_SPEED.max);
    const v = Math.round(raw / CAMERA_SPEED.step) / Math.round(1 / CAMERA_SPEED.step); // (in tenths, like _volume)
    if (v !== this.state.cameraSpeed) this.setState({ cameraSpeed: v });
  }

  setMusicVolume(v) {
    v = this._volume(v);
    if (v !== this.state.musicVolume) this.setState({ musicVolume: v });
  }

  setSoundVolume(v) {
    v = this._volume(v);
    setSoundVolume(v);
    if (v !== this.state.soundVolume) this.setState({ soundVolume: v });
  }

  /** Options → Accessibility → Text Size: scales the page UI's text (styles.css --text-scale), snapped to the slider's steps. */
  setTextSize(multiplier) {
    const n = Number(multiplier);
    const raw = THREE.MathUtils.clamp(Number.isFinite(n) ? n : TEXT_SIZE.default, TEXT_SIZE.min, TEXT_SIZE.max);
    const v = Math.round(raw / TEXT_SIZE.step) * TEXT_SIZE.step;
    document.documentElement.style.setProperty('--text-scale', String(v));
    if (v !== this.state.textSize) this.setState({ textSize: v });
  }

  /** -1 when the camera's orbiting is inverted (Options → Accessibility: Observer or Control Camera, by the control schema), else 1. */
  _cameraSign() {
    const s = this.state;
    return (s.controlSchema === 'creature' ? s.controlCameraInvert : s.observerCameraInvert) ? -1 : 1;
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
    // each phase is timed (Debug → Performance: the slowest; turnPhases: all of them, ms)
    const phases = (this.turnPhases = {});
    const timed = (name, fn) => {
      const t0 = performance.now();
      const out = fn();
      phases[name] = performance.now() - t0;
      return out;
    };
    const w = this.world;
    w.turn = turn; // moves this turn are stamped with it (Water settling)
    timed('changeLog', () => w.trimChangeLog()); // the change log only needs to reach back to the oldest stuck rule
    timed('buffs', () => w.tickBuffs()); // buffs count down a turn (and wear off)
    const moved = timed('groups', () => stepGroups(w)); // detached groups fall toward the origin first…
    timed('water', () => { for (const m of stepWater(w, moved)) moved.add(m); }); // …then Water flows…
    timed('sink', () => { for (const m of stepSink(w, moved)) moved.add(m); }); // …sinkable creatures (Crawlies) sink through Water…
    timed('fog', () => { for (const m of stepFog(w, moved)) moved.add(m); }); // …Fog clusters settle down, whole…
    timed('nimbusDrift', () => { for (const m of stepNimbusDrift(w, moved)) moved.add(m); }); // …Nimbus clouds drift west…
    timed('creatures', () => stepSoloCreatures(w, moved)); // …then one-block creatures (one that just fell with its group waits)…
    timed('squirmies', () => stepSquirmies(w, moved)); // …and Squirmies crawl as chains, head first…
    timed('sight', () => stepSight(w)); // …and every creature clears the Fog it can see (it shrinks away, then goes)…
    timed('digest', () => w.digest()); // …what creatures swallowed moves a block along their bodies…
    timed('wood', () => stepWood(w, turn)); // …then watered trees grow Wood (or Berries)…
    timed('dirt', () => stepDirt(w, turn)); // …then Dirt soaks up leftover settled Water and turns to Moss (Plop: to Wood)…
    if (this.state.rain) timed('rain', () => stepRain(w, turn)); // …a raindrop appears far out now and then (Options → Rain)…
    timed('nimbus', () => stepNimbus(w, turn)); // …and every 3rd turn each Nimbus may rain one Water below it
    timed('count', () => this._syncCount()); // rain, Nimbus and growth add blocks: keep the HUD's count (and diameter) current
    if (this.targetHL.visible) this._pulseTarget(); // Select tool: a turn tick on the pointed-at target…
    this._pulseGuideDots(); // …and on the Direction Guides' dots
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

  menuAction(id, arg) {
    const s = this.state;
    // New, Load-file and Save play their own sounds; everything else ticks.
    if (!/^(savenew|save:|load:|pick:new:)/.test(id)) playTick();
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
    if (id === 'load' || id === 'save') {
      this.setState({ menu: id, page: 0 });
      return this.refreshSaves();
    }
    // File, Controls, Video and Accessibility open (or close) their sections, closing any other
    if (id === 'file' || id === 'controls' || id === 'video' || id === 'accessibility') return this.setState({ section: s.section === id ? null : id });
    if (id === 'directionGuides') return this.toggleDirectionGuides();
    if (id === 'viewInternal') return this.setState({ viewInternal: !s.viewInternal });
    if (id === 'observerCamera') return this.setState({ observerCameraInvert: !s.observerCameraInvert });
    if (id === 'controlCamera') return this.setState({ controlCameraInvert: !s.controlCameraInvert });
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
    if (id === 'antialias') return this.setState({ antialias: !s.antialias });
    if (id === 'vsync') {
      this.setState({ vsync: !s.vsync });
      return this._applyVSync();
    }
    if (id === 'debug') return this.toggleDebug();
    if (id === 'rendering') {
      this.world.setSmoothRendering(!s.smoothRendering); // Smooth: clusters drawn as merged, smoothed bodies
      return this.setState({ smoothRendering: !s.smoothRendering });
    }
    if (id === 'back') return this.setState({ menu: 'main', page: 0, section: 'file' }); // Load / Save: back to Options → File
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

  /** The View panel's button: into XR: HMD Stereo from the window's views, or back to Normal from XR. */
  toggleHmd() {
    playTick();
    if (this.state.inXR) this.selectView('normal');
    else this.selectView('hmd');
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
    // each session, the panels start docked where they belong
    for (const e of Object.values(this._panels)) Object.assign(e, { dock: e.home, on: null });
    this._panelGrabs = { left: null, right: null };
    this._gripTaps = { left: null, right: null };
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
    this._xrMode = null;
    this._panelGrabs = { left: null, right: null };
    this._endResize();
    this._uiPress = null;
    for (const e of Object.values(this._panels)) {
      e.panel.mesh.visible = false;
      this.scene.add(e.panel.mesh);
    }
    this.reticle.group.visible = false;
    this.worldRoot.position.set(0, 0, 0);
    this.worldRoot.quaternion.identity();
    this.worldRoot.scale.setScalar(CM);
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
   * Hands-free XR: the gaze dock (the panels stand in it side by side: see _layoutPanels)
   * floats ahead of the head and swings round to the front once the head turns or moves well
   * away from it.
   */
  _updateGazeDock(dt) {
    if (!this._gazeMode()) return;
    const dock = this.gazeDock;
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

  /**
   * While a trigger drags a panel's resize handle: that corner follows where the controller's ray
   * meets the panel's plane. Free, it's the bottom-right corner (the top left stays put); docked,
   * the top right (it stands on its bottom edge, its left edge in place).
   */
  _updateResize() {
    const key = this._resizing;
    if (!key) return;
    const { panel } = this._panels[key], m = panel.mesh;
    if (!m.visible || !panel.isOpen || !this._setRayFromController(this._uiPress ?? 'right')) return this._endResize();
    m.updateMatrixWorld();
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(m.matrixWorld);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, m.getWorldPosition(new THREE.Vector3()));
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;
    const local = m.worldToLocal(hit); // metres, centred on the plane (at scale 1)
    const b = panel.boxMetres();
    panel.resizeBox(local.x - b.left, panel.corner === 'tr' ? local.y - b.bottom : b.top - local.y);
  }

  /** The resize drag is over: remember the panel's size. */
  _endResize() {
    const key = this._resizing;
    if (!key) return;
    this._resizing = null;
    try {
      localStorage.setItem(`xrPanelSize.${key}`, JSON.stringify(this._panels[key].panel.size));
    } catch {}
  }

  // ---------------------------------------------------------------- XR panels (docking)

  /** 'left' or 'right': the hand of controller `slot`, or null. */
  _handOf(slot) {
    return this.hands.left === slot ? 'left' : this.hands.right === slot ? 'right' : null;
  }

  /**
   * Puts each XR panel where it belongs this frame: docked panels stand side by side on their
   * controller (Options, Debug, the Right HUD, in that order), or on the other one when theirs
   * is missing, or in the gaze dock without controllers; free ones stay where they are in the
   * room; a held one follows its hand (_updatePanelGrabs).
   */
  _layoutPanels() {
    const gaze = this._gazeMode();
    // Options → Accessibility → Text Size: the panels are that much bigger (free ones grow or shrink in place)
    const text = this.state.textSize;
    if (this._panelText && this._panelText !== text) {
      for (const e of Object.values(this._panels)) if (!e.dock) e.panel.mesh.scale.multiplyScalar(text / this._panelText);
    }
    this._panelText = text;
    const rows = { left: [], right: [], gaze: [] };
    for (const key of XR_PANEL_ORDER) {
      const e = this._panels[key], m = e.panel.mesh;
      // its resize handle: free, bottom right; docked (standing on its bottom edge), top right; none in the gaze dock
      e.panel.corner = gaze ? null : e.dock ? 'tr' : 'br';
      if (this._panelGrabs.left?.key === key || this._panelGrabs.right?.key === key) {
        e.panel.corner = 'br';
        continue;
      }
      if (!e.dock) {
        e.on = null;
        if (m.parent !== this.scene) this.scene.attach(m);
        continue;
      }
      const other = e.dock === 'left' ? 'right' : 'left';
      e.on = gaze ? 'gaze' : this.hands[e.dock] ? e.dock : this.hands[other] ? other : 'gaze';
      if (m.visible) rows[e.on].push(e);
    }
    for (const hand of ['left', 'right']) if (rows[hand].length) this._layoutRow(rows[hand], this.hands[hand].ctrl, false);
    if (rows.gaze.length) this._layoutRow(rows.gaze, this.gazeDock, true);
  }

  /**
   * Panels `entries` side by side in `parent`, left to right, standing on their bottom edges:
   * on a controller, the first one's toggle button over it, tilted back (PANEL_DOCK_*); in the
   * gaze dock (`centred`), the row centred and upright.
   */
  _layoutRow(entries, parent, centred) {
    const boxes = entries.map((e) => e.panel.boxMetres());
    const text = this.state.textSize; // (Options → Accessibility → Text Size)
    const scales = entries.map((e) => text * (centred ? e.gazeScale * (e === this._panels.options && this.state.phone ? PHONE_MENU_SCALE : 1) : e.panel.dockScale));
    const widths = boxes.map((b, i) => (b.right - b.left) * scales[i]);
    let x = centred ? -(widths.reduce((a, w) => a + w, 0) + PANEL_DOCK_GAP * (entries.length - 1)) / 2 : -(boxes[0].button - boxes[0].left) * scales[0];
    entries.forEach((e, i) => {
      const m = e.panel.mesh, b = boxes[i], sc = scales[i];
      if (m.parent !== parent) parent.add(m);
      m.position.set(x - b.left * sc, -b.bottom * sc, i * 0.0005); // (each a hair in front of the last: no z-fighting where they meet)
      if (centred) m.quaternion.identity();
      else {
        m.quaternion.copy(_panelTilt);
        m.position.applyQuaternion(_panelTilt).add(PANEL_DOCK_ANCHOR);
      }
      m.scale.setScalar(sc);
      x += widths[i] + PANEL_DOCK_GAP;
    });
  }

  /**
   * The panel controller `slot` (of `hand`) touches (its grip within PANEL_TOUCH_REACH of the
   * panel's face) or else points at, not counting those docked on it: { key, point } or null.
   */
  _panelAt(hand, slot) {
    const shown = XR_PANEL_ORDER.filter((key) => this._panels[key].panel.mesh.visible && this._panels[key].on !== hand);
    const pos = this._gripPos(slot);
    for (const key of shown) {
      const { panel } = this._panels[key], m = panel.mesh;
      m.updateWorldMatrix(true, false);
      const local = m.worldToLocal(pos.clone());
      const r = PANEL_TOUCH_REACH / m.getWorldScale(new THREE.Vector3()).x;
      const b = panel.boxMetres();
      if (Math.abs(local.z) < r && local.x > b.left - r && local.x < b.right + r && local.y > b.bottom - r && local.y < b.top + r) return { key, point: pos };
    }
    slot.ctrl.updateMatrixWorld();
    _panelRay.set(new THREE.Vector3().setFromMatrixPosition(slot.ctrl.matrixWorld), new THREE.Vector3(0, 0, -1).transformDirection(slot.ctrl.matrixWorld));
    _panelRay.far = 3;
    const meshes = shown.map((key) => this._panels[key].panel.mesh);
    for (const hit of _panelRay.intersectObjects(meshes, false)) {
      const key = shown[meshes.indexOf(hit.object)];
      if (this._panels[key].panel.inBox(hit.uv)) return { key, point: hit.point };
    }
    return null;
  }

  /**
   * A grip pressed (as in xr-music-threejs). Soon after a short tap of it, a double tap: it
   * docks the panel it touches or points at on this controller, or, at no panel, lets go of
   * the panels docked on this controller, leaving them where they are; it takes nothing.
   * Otherwise, touching or pointing at a panel, it takes that (see _takePanel). Returns whether
   * the grip is the panels' (else it moves the build).
   */
  _gripPanelStart(slot) {
    const hand = this._handOf(slot);
    if (!hand) return false;
    const now = performance.now() / 1000;
    const tap = (this._gripTaps[hand] ??= { pressedAt: -1, tappedAt: -Infinity, double: false });
    tap.double = now - tap.tappedAt < GRIP_DOUBLE_TAP_S;
    tap.tappedAt = -Infinity;
    tap.pressedAt = now;
    const at = this._panelAt(hand, slot);
    if (tap.double) {
      this._dockByDoubleTap(hand, at?.key ?? null);
      return true;
    }
    if (!at) return false;
    this._takePanel(hand, slot, at);
    return true;
  }

  /** A grip let go: a held panel let go near the other controller docks there; anywhere else it stays put. */
  _gripPanelEnd(slot) {
    const hand = this._handOf(slot);
    if (!hand) return;
    const now = performance.now() / 1000, tap = this._gripTaps[hand];
    if (tap) tap.tappedAt = !tap.double && now - tap.pressedAt <= GRIP_TAP_S ? now : -Infinity;
    const g = this._panelGrabs[hand];
    if (!g) return;
    this._panelGrabs[hand] = null;
    const e = this._panels[g.key];
    const zone = this._dockZone(hand, e);
    if (!zone) return;
    e.dock = zone;
    playSfx('attach');
    this._pulse(...PANEL_PULSE.dock, zone);
  }

  /**
   * `hand`'s grip takes panel `at.key` (off its dock, if it was docked, with a click): held
   * rigidly, easing to its free size about the point it was taken by.
   */
  _takePanel(hand, slot, at) {
    const e = this._panels[at.key], m = e.panel.mesh;
    if (e.on) {
      playSfx('detach');
      this._pulse(...PANEL_PULSE.detach, hand);
    } else this._pulse(...PANEL_PULSE.grab, hand);
    e.dock = null;
    e.on = null;
    for (const h of ['left', 'right']) if (this._panelGrabs[h]?.key === at.key) this._panelGrabs[h] = null; // (the other hand lets go)
    this.scene.attach(m); // (keeping where it is)
    slot.grip.updateMatrixWorld();
    m.updateMatrixWorld();
    const gripInverse = slot.grip.matrixWorld.clone().invert();
    this._panelGrabs[hand] = {
      key: at.key,
      slot,
      offset: gripInverse.clone().multiply(m.matrixWorld),
      point: at.point.clone().applyMatrix4(gripInverse),
      size: 1,
      grow: (e.freeScale * this.state.textSize) / m.scale.x,
      zone: null,
    };
  }

  /** A double tap of `hand`'s grip: see _gripPanelStart. */
  _dockByDoubleTap(hand, key) {
    if (key) {
      for (const h of ['left', 'right']) if (this._panelGrabs[h]?.key === key) this._panelGrabs[h] = null;
      this._panels[key].dock = hand;
      playSfx('attach');
      this._pulse(...PANEL_PULSE.dock, hand);
      return;
    }
    const mine = Object.values(this._panels).filter((e) => e.on === hand);
    if (!mine.length) return;
    for (const e of mine) {
      Object.assign(e, { dock: null, on: null });
      this.scene.attach(e.panel.mesh);
    }
    playSfx('detach');
    this._pulse(...PANEL_PULSE.detach, hand);
  }

  /** The other controller, when it's within PANEL_DOCK_REACH of panel `e` (held in `hand`): where letting go docks it; else null. */
  _dockZone(hand, e) {
    const other = hand === 'left' ? 'right' : 'left';
    const slot = this.hands[other];
    if (!slot) return null;
    const m = e.panel.mesh, b = e.panel.boxMetres();
    m.updateWorldMatrix(true, false);
    const at = this._gripPos(slot);
    // the nearest point of the visible panel
    const local = m.worldToLocal(at.clone());
    local.set(THREE.MathUtils.clamp(local.x, b.left, b.right), THREE.MathUtils.clamp(local.y, b.bottom, b.top), 0);
    return m.localToWorld(local).distanceTo(at) < PANEL_DOCK_REACH ? other : null;
  }

  /** Held panels keep their pose in the hand, easing to their free size; a tick as one comes within reach of a dock. */
  _updatePanelGrabs(dt) {
    for (const hand of ['left', 'right']) {
      const g = this._panelGrabs[hand];
      if (!g) continue;
      const e = this._panels[g.key], m = e.panel.mesh;
      if (!m.visible) {
        this._panelGrabs[hand] = null;
        continue;
      }
      g.size += (g.grow - g.size) * (1 - Math.exp(-PANEL_GROW_RATE * Math.min(dt, 0.1)));
      const { x, y, z } = g.point;
      _panelOffset.makeTranslation(x, y, z).multiply(_panelStep.makeScale(g.size, g.size, g.size));
      _panelOffset.multiply(_panelStep.makeTranslation(-x, -y, -z)).multiply(g.offset);
      g.slot.grip.updateMatrixWorld();
      _panelWorld.multiplyMatrices(g.slot.grip.matrixWorld, _panelOffset).decompose(m.position, m.quaternion, m.scale);
      m.updateMatrixWorld();
      const zone = this._dockZone(hand, e);
      if (zone && zone !== g.zone) this._pulse(...PANEL_PULSE.zone, zone);
      g.zone = zone;
    }
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

  /** A haptic pulse on `hand`'s controller. */
  _pulse(intensity, ms, hand = 'right') {
    const gp = this.hands[hand]?.source?.gamepad;
    const act = gp?.hapticActuators?.[0];
    try {
      if (act?.pulse) act.pulse(intensity, ms);
      else gp?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: intensity });
    } catch {
      /* ignore */
    }
  }

  /**
   * A trigger (`hand`'s) on what its pointer is on in a panel: a resize handle (held: resizes),
   * a toggle button, an action, the Tool dropdown or a tool, a debug tablet control, a menu
   * item or slider (held: drags it). Returns whether it pressed something.
   */
  _pressUi(hand) {
    if (this._resizeHover) {
      this._resizing = this._resizeHover;
      this._uiPress = hand;
      return true;
    }
    const hud = {
      menu: () => this.toggleMenu(),
      debug: () => {
        playTick();
        debugSections.toggle('panel');
      },
      rightHud: () => this.toggleRightHud(),
      view: () => this.toggleHmd(),
      tools: () => this.toggleToolsOpen(),
      eat: () => this.selectedEat(),
      excrete: () => this.selectedExcrete(),
    }[this._hudHover];
    if (hud) {
      hud();
      return true;
    }
    if (this._toolHover != null) {
      this.selectTool(this._toolHover);
      return true;
    }
    if (this._tabletHover) {
      // pointing at the debug tablet: presses what it points at (a section header, the prompt box, a button)
      if (this._tabletHoverId) this._tabletAction(this._tabletHoverId);
      return true;
    }
    if (this.isMenuOpen() && this._menuHover) {
      const slider = this.menuPanel.sliderValueAt(this._menuHoverUV, this._menuHover);
      if (slider != null) {
        this._sliderDrag = this._menuHover; // hold the trigger to drag
        this._uiPress = hand;
        this._setSlider(this._menuHover, slider);
      } else this.menuAction(this._menuHover);
      return true;
    }
    return false;
  }

  /** The left trigger: presses what the left controller points at in a panel (it doesn't use tools). */
  _onLeftTrigger() {
    if (this._uiHand === 'left') this._pressUi('left');
  }

  _onRightTrigger() {
    const mine = this._uiHand !== 'left'; // (the pointer on a panel is the right's, or the gaze's)
    if (mine && this._pressUi('right')) return;
    if (this.isMenuOpen()) {
      if (!(mine && this._menuPanelHover)) this.resume(); // clicked outside the pause panel
      return;
    }
    if (this.state.screen === 'playing') {
      this.useTool();
      // a second press soon after, on the same creature: a double press (like a double-click)
      const creature = this._creatureOf(this.target?.block);
      const now = performance.now();
      const prev = this._lastTrigger;
      this._lastTrigger = { t: now, creature };
      if (creature && prev?.creature === creature && now - prev.t < XR_DOUBLE_PRESS_MS) {
        this._lastTrigger = null;
        this._switchToCreature(creature);
      }
    }
  }

  /**
   * Right Touch thumbstick flicked left/right cycles tools (XR, and window mode when the
   * browser exposes the Touch controllers as gamepads). Re-arms once the stick recentres.
   */
  _touchStickTools(gp) {
    if (this.state.screen !== 'playing') return; // (paused too: picking a tool is fine with Options open)
    const x = (gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0]) || 0; // xr-standard: thumbstick = axes 2/3
    if (this._stickArmed && Math.abs(x) > 0.65) {
      this._stickArmed = false;
      this.cycleTool(x > 0 ? 1 : -1);
    } else if (Math.abs(x) < 0.3) {
      this._stickArmed = true;
    }
  }

  _pollGamepads() {
    // pointing at Options (a menu taller than the panel): that hand's thumbstick up / down scrolls it
    const sgp = this._menuPanelHover && this.hands[this._uiHand]?.source?.gamepad;
    if (sgp) {
      const y = (sgp.axes.length >= 4 ? sgp.axes[3] : sgp.axes[1]) || 0;
      if (Math.abs(y) > 0.2) this.menuPanel.scrollBy(y * MENU_SCROLL_PX_S * (this._dt ?? 0));
    }
    const rgp = this.hands.right?.source?.gamepad;
    if (rgp) {
      this._touchStickTools(rgp);
      const playing = this.state.screen === 'playing' && !this.state.paused;
      const a = !!rgp.buttons[4]?.pressed; // A: excrete
      if (a && !this._rightAWas && playing) this.selectedExcrete();
      this._rightAWas = a;
      const b = !!rgp.buttons[5]?.pressed; // B: eat
      if (b && !this._rightBWas && playing) this.selectedEat();
      this._rightBWas = b;
      const stick = !!rgp.buttons[3]?.pressed; // thumbstick click: Observer ↔ Creature controls (like the gamepad's R3)
      if (stick && !this._rightStickWas && playing) this.toggleControlSchema();
      this._rightStickWas = stick;
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
  _setRayFromController(hand = 'right') {
    const ctrl = this.hands[hand]?.ctrl;
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

  /**
   * What the raycaster's ray is on in the panels: sets the hover state (a resize handle, a
   * toggle button, an action or tool, a debug tablet control, a menu item) and returns the hit,
   * or null when it misses them (or only crosses their clear margins).
   */
  _pointAtPanels(gaze, menuOpen, menuShown) {
    this.raycaster.far = 3;
    const targets = [];
    if (this.rightHud.mesh.visible) targets.push(this.rightHud.mesh);
    if (menuShown) targets.push(this.menuPanel.mesh);
    if (this.debugTablet.mesh.visible) targets.push(this.debugTablet.mesh);
    if (this.viewPanel.mesh.visible) targets.push(this.viewPanel.mesh);
    for (const hit of this.raycaster.intersectObjects(targets, false)) {
      const key = XR_PANEL_ORDER.find((k) => this._panels[k].panel.mesh === hit.object);
      const { panel } = this._panels[key];
      if (!panel.inBox(hit.uv)) continue;
      if (!gaze && panel.onResizeHandle(hit.uv)) {
        // the trigger, held, resizes it (the gaze can't hold)
        this._resizeHover = key;
        panel.handleHot = true;
        return hit;
      }
      if (key === 'debug') {
        this._tabletHover = true; // (the grip takes it)
        this._tabletHoverId = this.debugTablet.hitTest(hit.uv);
        if (this._tabletHoverId === 'toggle') {
          this._tabletHoverId = null;
          this._tabletHover = false;
          this._hudHover = 'debug';
        }
        return hit;
      }
      if (key === 'view') {
        if (panel.onToggle(hit.uv)) this._hudHover = 'view';
        return hit;
      }
      if (key === 'right') {
        const slot = this.rightHud.hitTest(hit.uv);
        if (slot === 'toggle' || slot === 'tools' || slot === 'eat' || slot === 'excrete') this._hudHover = slot === 'toggle' ? 'rightHud' : slot;
        else if (slot != null) this._toolHover = slot;
        return hit;
      }
      if (this.menuPanel.onToggle(hit.uv)) {
        this._hudHover = 'menu';
        return hit;
      }
      if (menuOpen) {
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
        return hit;
      }
    }
    return null;
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
    const menuShown = xr && this.menuPanel.mesh.visible; // the in-world Options (not with the page's own menus)
    this._menuHover = null;
    this._menuPanelHover = false; // ray is on the pause panel (button or not)
    this._tabletHover = false;
    this._tabletHoverId = null; // the tablet control under the ray (section header, prompt box, button)
    this._hudHover = null;
    this._toolHover = null; // the tool slot under the pointer
    for (const { panel } of Object.values(this._panels)) panel.handleHot = false;
    this._gazeHit = null; // hands-free XR: the control under the gaze ({ key, point, distance })
    this._resizeHover = null;
    let uiHit = null;
    this._uiHand = null;
    this.rayDotLeft.visible = false;
    this.rayLineLeft.visible = false;

    // UI first: the panels (Options, Debug, the Right HUD), under the right controller's ray (or
    // the gaze); else under the left's (it presses them with its trigger: it can reach the panels
    // docked on the right hand). A hand holding its trigger on a panel keeps it.
    const pointers = !xr ? [] : gaze ? ['gaze'] : this._uiPress === 'left' ? ['left', 'right'] : ['right', 'left'];
    for (const hand of pointers) {
      if (!(hand === 'gaze' ? this._setRayFromHead() : this._setRayFromController(hand))) continue;
      uiHit = this._pointAtPanels(gaze, menuOpen, menuShown);
      if (!uiHit) continue;
      this._uiHand = hand;
      break;
    }
    if (this._resizing) this._panels[this._resizing].panel.handleHot = true;
    if (uiHit) {
      if (gaze) {
        // what a stare (or a tap) would press; a slider's key includes the value it would set
        let key = null;
        if (this._menuHover) {
          const value = this.menuPanel.sliderValueAt(uiHit.uv, this._menuHover);
          key = `menu:${this._menuHover}${value != null ? `@${value}` : ''}`;
        } else if (this._hudHover) key = `hud:${this._hudHover}`;
        else if (this._toolHover != null) key = `tool:${this._toolHover}`;
        else if (this._tabletHoverId) key = `tablet:${this._tabletHoverId}`;
        if (key) this._gazeHit = { key, point: uiHit.point, distance: uiHit.distance };
      } else if (this._uiHand === 'left') {
        this.rayLineLeft.scale.z = uiHit.distance;
        this.rayLineLeft.visible = true;
        this.rayDotLeft.position.copy(uiHit.point);
        this.rayDotLeft.visible = true;
      } else {
        rayLen = uiHit.distance;
        this.rayDot.position.copy(uiHit.point);
        this.rayDot.visible = true;
      }
    }
    if (menuShown) this.menuPanel.draw(menuOpen ? menuModel(s) : null, this._hudHover === 'menu' ? 'toggle' : this._menuHover);
    const rightOnUi = uiHit && this._uiHand !== 'left'; // (the right controller still points into the world while the left is on a panel)

    if (s.screen === 'playing' && !s.paused && !rightOnUi && this.toolsReady(s) && this.toolsAvailable(s)) {
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

  /**
   * View Mode → 3D: SBS / Interlaced: the eyes converge on the camera's target, so what you're
   * looking at sits at the screen and the page's UI (a little in front of it) stays in front.
   */
  _setStereoFocus() {
    this.camera.focus = Math.max(this.camera.near * 2, this.camera.position.distanceTo(this.controls.target));
  }

  /** View Mode → 3D: SBS (half side-by-side, for 3D TVs): each eye squeezed into half the screen. */
  _renderSideBySide() {
    const r = this.renderer, cam = this.camera;
    this._sbs ??= Object.assign(new THREE.StereoCamera(), { eyeSep: SBS_EYE_SEPARATION });
    cam.updateMatrixWorld();
    this._setStereoFocus();
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
    else if (s.screenView === 'interlaced') {
      this._setStereoFocus();
      (this._interlaced ??= new Interlaced(SBS_EYE_SEPARATION)).render(this.renderer, this.scene, this.camera);
    }
    else this.renderer.render(this.scene, this.camera);
  }

  _pick() {
    const hits = this.raycaster.intersectObjects(this.world.pickMeshes, false);
    // (hidden Fog, Options → Fog off, isn't there to point at)
    const h = hits.find((x) => x.instanceId != null && (this.state.fog || this.world.blockAtHit(x)?.type !== BLOCK.FOG));
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
      } else if (this.selected.length && this._targeting && this._isSelectTarget(t)) {
        this.targetHL.position.set(...t.place).multiplyScalar(GRID.scale); // (lattice units -> cm)
        this.targetHL.visible = true;
        // its shrinking pulses move with it (same frame), staying centred in it
        for (const p of this._pulses) if (p.obj.visible && p.followsTarget) p.obj.position.copy(this.targetHL.position);
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
  /**
   * Blocks the camera is inside, or so close to that the near plane cuts them (the creature
   * view's camera may pass through its own creature), are drawn see-through: dithered, inside
   * faces showing (World.setSeeThrough). A creature goes see-through whole; in Smooth
   * rendering, so does the cluster body. Not in XR.
   */
  _updateSeeThrough(now) {
    const blocks = new Set();
    // Accessibility → View Internal: the selected and controlled creatures, 3/4 opaque, their
    // inventories drawn inside them (in XR too)
    const shown = this.state.viewInternal && this.state.screen === 'playing'
      ? [...new Set([...this.selected, ...(this._controlled ?? [])])].filter((c) => this.world.get(c.x, c.y, c.z) === c)
      : [];
    // (see-through only while there's something inside to see)
    const internal = new Set(shown.filter((c) => this.world.clusterOf(c).some((b) => b.inventory)).flatMap((c) => this._bodyOf(c)));
    this.inventoryView.update(shown, now);
    if (!this._immersive) {
      this.cameraCollider ??= new CameraCollider(this.world);
      const p = this.worldRoot.worldToLocal(this.camera.position.clone());
      for (const block of this.cameraCollider.blocksNear(p, now, SEE_THROUGH_REACH_CM)) {
        if (isTranslucent(block.type)) continue;
        const creature = this._creatureOf(block);
        for (const b of creature ? this._bodyOf(creature) : [block]) blocks.add(b);
      }
    }
    this.world.setSeeThrough(blocks, internal);
  }

  /**
   * Windowed: eases the camera, subtly, so down (toward the world's origin) is down on screen.
   * `pos` (the camera's position, moved in place) drifts round its orbit about `target` to look
   * down on it from SETTLE_ELEVATION_DEG above its ground, and the camera's roll eases level.
   * Both fade out where there's no clear down (orbiting the origin itself, looking straight at
   * it), and are slow enough that the player's own orbiting always wins.
   */
  _settleCamera(dt, pos, target) {
    const ease = (angle, s, maxDegS) => Math.sign(angle) * Math.min(Math.abs(angle) * (1 - Math.exp(-dt / s)), THREE.MathUtils.degToRad(maxDegS) * dt);
    const origin = this.worldRoot.getWorldPosition(_setOrigin);
    // the height: over the target's ground (none when it's the origin itself)
    const ground = _setGround.copy(target).sub(origin);
    const off = _setOff.copy(pos).sub(target);
    const r = ground.length(), d = off.length();
    if (r > 1e-6 && d > 1e-6) {
      const weight = Math.min(1, (2 * r) / (r + d)); // far out round the origin: hardly any
      ground.divideScalar(r);
      const elevation = Math.asin(THREE.MathUtils.clamp(off.dot(ground) / d, -1, 1));
      const [lo, hi] = SETTLE_ELEVATION_DEG.map(THREE.MathUtils.degToRad);
      const goal = THREE.MathUtils.clamp(elevation, lo, hi);
      const axis = _setAxis.crossVectors(off, ground); // turning about it raises the camera
      if (goal !== elevation && axis.lengthSq() > 1e-12) {
        off.applyAxisAngle(axis.normalize(), ease(goal - elevation, SETTLE_S, SETTLE_MAX_DEG_S) * weight);
        pos.copy(target).add(off);
      }
    }
    // the roll: the camera's up turns, about the view line, toward the way up from the origin
    const fwd = _setFwd.copy(target).sub(pos).normalize();
    const want = _setWant.copy(pos).sub(origin).normalize();
    want.addScaledVector(fwd, -want.dot(fwd));
    const weight = want.length(); // looking straight at (or away from) the origin: no down to keep
    if (weight < 1e-3) return;
    const cur = _setCur.copy(this.camera.up).addScaledVector(fwd, -this.camera.up.dot(fwd));
    if (cur.lengthSq() < 1e-12) return;
    const angle = Math.atan2(_setAxis.crossVectors(cur, want).dot(fwd), cur.dot(want));
    this.camera.up.applyAxisAngle(fwd, ease(angle, ROLL_LEVEL_S, ROLL_LEVEL_MAX_DEG_S) * weight);
  }

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
    if (dist > c.minDistance * 1.05 || metres <= 0 || this._pov) return; // (the creature's view stays on its head)
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
    this._steerStick = null; // set again below while the left stick steers a creature
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
    const aiming = this._padAim(pressed, prev, ax); // holding Y / B: the left stick aims Eat / Excrete (acts on letting go)
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
    if (edge(11)) this.toggleControlSchema(); // R3: Observer ↔ Creature controls (and its view)
    const steering = this.state.controlSchema === 'creature'; // the left stick moves the creature, not the camera
    if (steering && !aiming && pressed[10]) this._steerAway(); // L3 held: straight away from the camera
    else if (steering && !aiming) this._steerControlled(ax(0), ax(1));
    if (edge(0)) {
      // A: use the tool (at the crosshair; Observer controls only)
      this._updateTarget();
      this.useTool();
    }
    // Y: a selected creature eats (what's in front of it), B: excretes (what's in its tail's slot):
    // on letting go, the way the left stick chose meanwhile (_padAim)
    if (edge(2)) this.selectedToggleWait(); // X: selected creatures wait, or resume what they were doing
    if (edge(4)) this.cycleTool(-1); // LB
    if (edge(5)) this.cycleTool(1); // RB
    // the triggers zoom (LT out, RT in; the left stick doesn't); in the creature's view the
    // camera orbits its head the same way (no panning: see _padCamera)
    this._padCamera(dt, ax(2), ax(3), THREE.MathUtils.clamp(zoom, -1, 1), [pressed[12], pressed[13], pressed[14], pressed[15]]);
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
   * keeps turning over the poles), the triggers zoom (`ly`: < 0 in), D-pad pans.
   */
  _padCamera(dt, rx, ry, ly, [du, dd, dl, dr]) {
    if (!rx && !ry && !ly && !du && !dd && !dl && !dr) return;
    const c = this.controls, cam = this.camera;
    const pov = this._pov?.desired ? this._pov : null; // the creature's view: orbit where it wants the camera, not where walls pulled it in
    if (pov) cam.position.copy(pov.desired);
    const off = cam.position.clone().sub(c.target);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const sign = this._cameraSign() * this.state.cameraSpeed; // (inverted or not, at Camera Speed)
    rx *= sign;
    ry *= sign;
    // stick right: round the camera's up axis; stick down: over its right axis (the other way when inverted)
    const turn = new THREE.Quaternion().setFromAxisAngle(upv, rx * 2.2 * dt)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, ry * 1.6 * dt));
    off.applyQuaternion(turn);
    cam.up.copy(upv).applyQuaternion(turn);
    const radius = THREE.MathUtils.clamp(off.length() * Math.exp(ly * 1.6 * dt), c.minDistance, c.maxDistance);
    if (ly < 0) this._flyForward(-ly * FLY_M_PER_PAD_S * dt, radius); // RT past the zoom limit: fly forward
    off.setLength(radius);
    const pan = new THREE.Vector3();
    if ((du || dd || dl || dr) && !this._pov) {
      const speed = radius * 0.8 * dt;
      pan.addScaledVector(right, ((dr ? 1 : 0) - (dl ? 1 : 0)) * speed);
      pan.addScaledVector(upv, ((du ? 1 : 0) - (dd ? 1 : 0)) * speed);
    }
    c.target.add(pan);
    cam.position.copy(c.target).add(off);
    cam.lookAt(c.target);
    if (pov) pov.desired.copy(cam.position);
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
    this._updateStepMarkers();
    this._updateAimGuides();
    if (this.state.handheld) this.cardboard.update(); // the camera follows the phone
    const xr = this._immersive;
    if (!xr) {
      this._pollBrowserGamepad(dt);
      this._pollKeys(); // WASD / arrows: steer (or aim E / Q)
      this.controls.rotateSpeed = ROTATE_SPEED * this.state.cameraSpeed * this._cameraSign(); // mouse orbiting, at Camera Speed, inverted or not
      if (this._pov) this._updateCreatureView(sceneNow, dt);
      else {
        this._stepZoomOut(dt);
        this.controls.update();
        this._settleCamera(dt, this.camera.position, this.controls.target);
        this.camera.lookAt(this.controls.target);
        this._collideCamera(now, dt);
        this._applyLookBlend(dt); // (just after leaving a creature's view: still turning to the origin)
      }
    }
    this._updateSeeThrough(sceneNow);
    this._updateActions();
    if (xr) {
      this._xrFrames++;
      if (this._needsXRPlacement && this._xrFrames > 2) {
        this._needsXRPlacement = false;
        this._placeWorldInFront();
      }
      this._pollGamepads();
      this._updateGrab();
      this._updateGazeDock(dt);
      const flat = this.screenUI(); // the page's UI is in front instead (XR: Phone AR)
      const dbg = this.state.debugMode && !flat;
      this.debugTablet.mesh.visible = dbg;
      this._updateResize();
      if (dbg) {
        const grabbed = this._panelGrabs.left?.key === 'debug' || this._panelGrabs.right?.key === 'debug';
        this.debugTablet.draw({
          info: this.debugInfo(),
          perf: this.performanceRows(),
          logs: getLogs(120),
          logVersion: getLogVersion(),
          highlight: grabbed || this._tabletHover,
          claude: { ...claudePrompt.getSnapshot(), response: claudePrompt.responseText() },
          collapsed: debugSections.getSnapshot(),
          hover: this._hudHover === 'debug' ? 'toggle' : this._tabletHoverId,
          open: !debugSections.getSnapshot().panel,
        });
      }
      let msg = null;
      if (this._hudMessage && performance.now() < this._hudMessage.until) msg = this._hudMessage.text;
      const playing = this.state.screen === 'playing';
      this.rightHud.draw({
        open: this.state.rightHudOpen,
        title: this.rightHudTitle(),
        tools: this.toolsAvailable(),
        toolsOpen: this.state.toolsOpen,
        actions: this.state.actions,
        glyphs: Engine.ACTION_GLYPHS.xr,
        toolIndex: this.state.toolIndex,
        label: this.toolLabel(),
        message: msg,
        style: { materials: this.state.materials, smooth: this.state.smoothRendering },
        hover: this._hudHover === 'rightHud' ? 'toggle' : this._hudHover ?? this._toolHover,
      });
      this.rightHud.mesh.visible = playing && !flat;
      this.menuPanel.mesh.visible = !flat; // (closed, just its gear)
      this.viewPanel.mesh.visible = !flat && this.state.views.includes('hmd'); // (XR: HMD Stereo: not on phones)
      this.viewPanel.draw(this._hudHover === 'view');
      this._updatePanelGrabs(dt);
      this._layoutPanels();
    }
    this._dt = dt;
    this._updateTarget();
    this._updateTargetLine(sceneNow);
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
    this._freeLoop = null;
    this.renderer.setAnimationLoop(null);
    if (this.state.handheld) this._exitHandheld();
    setMusicLevel(0); // fades out
    this._ro?.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('wheel', this._onWheel);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerleave', this._onPointerLeave);
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointerup', this._onPointerUp);
    el.removeEventListener('dblclick', this._onDoubleClick);
    el.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
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
