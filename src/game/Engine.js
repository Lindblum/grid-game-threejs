import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { World } from './world.js';
import { TOOLS } from './tools.js';
import { faceFromNormal, isValidCell } from './lattice.js';
import { truncatedOctahedronFaces } from './geometry.js';
import { playPlace, playDelete, playTick, playResume, playLoad, playSave, playError, unlockAudio, setMuted } from './audio.js';
import { LeftHudPanel, RightHudPanel, MenuPanel } from './xrPanels.js';
import { menuModel, displayName, PAGE_SIZE } from './menu.js';
import { listSaves, readSave, writeSave, normalizeSaveName, timestampName } from './saves.js';

const CM = 0.01; // world units are metres; lattice units are cm
const XR_RAY_LENGTH = 1.0; // 1 m
const DESKTOP_RAY_LENGTH = 50;
const BG = new THREE.Color('#1b2029');
const ORBIT_HEIGHT_CM = 100; // light 1 m above the scene
const ORBIT_RADIUS_CM = 300; // 3 m radius
const ORBIT_PERIOD_S = 60; // one revolution per minute
const GRAB_MIN_SCALE = 0.1; // two-hand zoom limits, relative to life size (1 lattice cm = 1 cm)
const GRAB_MAX_SCALE = 20;
const START_CAMERA = new THREE.Vector3(0.22, 0.26, 0.4).normalize().multiplyScalar(0.5); // 50 cm from origin

/** Thick wireframe of a truncated octahedron made from thin cylinders (visible in XR too). */
function makeWireframe(color, radiusCm) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
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
      screen: 'playing', // 'playing' | 'closed' (after Quit in the browser)
      paused: true, // the game opens on a New scene with the menu up
      menu: 'main', // 'main' | 'load' | 'save' | 'options'
      soundOn: true,
      passthrough: true, // Options → Background: XR passthrough (true) or solid colour
      saves: null,
      savesError: null,
      page: 0,
      toolIndex: 0,
      inXR: false,
      xrSupport: null, // truthy when this browser can start XR at all
      xrAR: false, // browser supports immersive-ar (passthrough), e.g. Quest Browser
      xrVR: false, // browser supports immersive-vr, e.g. PC Chrome with a headset over Link
      blockCount: 0,
      toast: null,
      gamepadAim: false, // aiming with a gamepad (crosshair at screen centre)
      menuFocus: null, // id of the menu item focused with the gamepad
    };
    this._toastId = 0;
    this.mouse = null;
    this.target = null;
    this.hands = { left: null, right: null };
    this._stickArmed = true;
    this._leftMenuWas = false;
    this._menuHover = null;
    this._hudHover = null;
    this._xrFrames = 0;
    this._grab = null;

    this._initRenderer();
    this._initScene();
    this._initXR();
    this._bindEvents();
    this._detectXR();

    this.world.generateNew();
    this._syncCount();
    this.renderer.setAnimationLoop(this._tick);
  }

  // ---------------------------------------------------------------- state
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;
  setState(patch) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
  toast(text, kind = 'info') {
    if (kind === 'error') playError();
    this.setState({ toast: { text, kind, id: ++this._toastId } });
    this._hudMessage = { text, until: performance.now() + 2200 };
  }
  _syncCount() {
    if (this.state.blockCount !== this.world.size) this.setState({ blockCount: this.world.size });
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

    scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.1));
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35);
    fill.position.set(-1, -0.4, -0.6);
    scene.add(fill);

    // All lattice content lives in worldRoot (units: cm).
    const root = new THREE.Group();
    root.name = 'worldRoot';
    root.scale.setScalar(CM);
    scene.add(root);
    this.worldRoot = root;
    this.world = new World(root);

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
      // Grips: one hand drags the build, both hands rotate + scale it (Tilt Brush style).
      ctrl.addEventListener('squeezestart', () => {
        slot.gripHeld = true;
        this._beginGrab();
      });
      ctrl.addEventListener('squeezeend', () => {
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
      if (this.state.screen === 'playing' && !this.state.paused && !this.state.inXR) {
        this._updateTarget();
        this.useTool();
      }
    };
    this._onContextMenu = (e) => e.preventDefault();
    this._onKeyDown = (e) => this._handleKey(e);

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
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= TOOLS.length) {
      this.selectTool(Number(e.key) - 1);
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

  /** From the "closed" screen: back to the game with the menu open. */
  reopen() {
    this.setState({ screen: 'playing', paused: true, menu: 'main' });
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
    this.setState({ toolIndex: i });
    this._hudMessage = null;
    playTick();
  }

  useTool() {
    const tool = TOOLS[this.state.toolIndex];
    const t = this.target;
    if (!t) return false;
    let ok = false;
    if (tool.block && t.place && t.placeFree) {
      ok = this.world.add(t.place[0], t.place[1], t.place[2], tool.block);
      if (ok) playPlace();
    } else if (!tool.block && t.block) {
      ok = this.world.remove(t.block.x, t.block.y, t.block.z);
      if (ok) playDelete();
    }
    if (ok) {
      this._syncCount();
      this._pulse(0.35, 25);
    }
    return ok;
  }

  newScene() {
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

  /** Quit: in XR, leave the XR session (the menu stays up in the browser); otherwise close the game. */
  quit() {
    if (this.renderer.xr.isPresenting) {
      this.renderer.xr.getSession()?.end();
      return;
    }
    window.close(); // only works if the tab was opened by a script
    this.setState({ screen: 'closed', menu: 'main' });
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
    if (id === 'quit') return this.quit();
    if (id === 'options') return this.setState({ menu: 'options' });
    if (id === 'sound') return this.setSound(!s.soundOn);
    if (id === 'background') {
      this.setState({ passthrough: !s.passthrough });
      if (s.inXR && !s.passthrough && this._xrMode !== 'immersive-ar') {
        this.toast('This XR session can’t show passthrough (it was started as VR)');
      }
      return this._applyBackground();
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
      this.controls.enabled = false;
      this.setState({ inXR: true, screen: 'playing', menu: 'main' });
    } catch (e) {
      console.error(e);
      this.toast(`Could not start XR: ${e.message || e}`, 'error');
    }
  }

  _onXREnd() {
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
    if (this.isMenuOpen()) {
      if (this._menuHover) this.menuAction(this._menuHover);
      return;
    }
    if (this.state.screen === 'playing') this.useTool();
  }

  _pollGamepads() {
    // Right thumbstick left/right cycles tools.
    const rgp = this.hands.right?.source?.gamepad;
    if (rgp && this.state.screen === 'playing' && !this.state.paused) {
      const x = rgp.axes.length >= 4 ? rgp.axes[2] : rgp.axes[0] || 0;
      if (this._stickArmed && Math.abs(x) > 0.65) {
        this._stickArmed = false;
        this.cycleTool(x > 0 ? 1 : -1);
      } else if (Math.abs(x) < 0.3) {
        this._stickArmed = true;
      }
    }
    // The Quest Browser uses the left Menu (≡) button as "Back", so the menu is opened
    // with the Menu button on the left HUD; the Y button is a shortcut for it.
    const lgp = this.hands.left?.source?.gamepad;
    if (lgp) {
      const pressed = !!lgp.buttons[5]?.pressed;
      if (pressed && !this._leftMenuWas) this.toggleMenu();
      this._leftMenuWas = pressed;
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
    this.target = null;
    const s = this.state;
    const xr = this.renderer.xr.isPresenting;
    let rayLen = XR_RAY_LENGTH;
    this.rayDot.visible = false;

    const menuOpen = this.isMenuOpen(s);
    this._menuHover = null;
    this._hudHover = null;
    let uiHit = null;

    if (xr && this._setRayFromController()) {
      // UI first: the left HUD's Menu button and the start/pause panel.
      this.raycaster.far = 3;
      const targets = [];
      if (this.leftHud.mesh.visible && this.leftHud.mesh.parent) targets.push(this.leftHud.mesh);
      if (menuOpen) targets.push(this.menuPanel.mesh);
      for (const hit of this.raycaster.intersectObjects(targets, false)) {
        if (hit.object === this.leftHud.mesh) {
          if (this.leftHud.hitTest(hit.uv)) {
            this._hudHover = 'menu';
            uiHit = hit;
            break;
          }
        } else {
          this._menuHover = this.menuPanel.hitTest(hit.uv);
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

    if (s.screen === 'playing' && !s.paused && !uiHit) {
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
    if (!t) return;
    const tool = TOOLS[this.state.toolIndex];
    if (tool.block) {
      if (t.place && t.placeFree) {
        this.placeHL.position.set(...t.place);
        this.placeHL.visible = true;
      }
    } else if (t.block) {
      this.deleteHL.position.set(t.block.x, t.block.y, t.block.z);
      this.deleteHL.visible = true;
    }
  }

  _updateOrbitLight(timeMs) {
    const a = (timeMs / 1000) * ((2 * Math.PI) / ORBIT_PERIOD_S);
    // x = R cos a, z = R sin a turns clockwise when viewed from above (looking down -Y)
    this.orbitLight.position.set(ORBIT_RADIUS_CM * Math.cos(a), ORBIT_HEIGHT_CM, ORBIT_RADIUS_CM * Math.sin(a));
  }

  // ---------------------------------------------------------------- browser gamepad
  _pollBrowserGamepad(dt) {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((p) => p && p.connected) : [];
    const gp = pads.find((p) => p.mapping === 'standard') || pads[0];
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

  _tick = (time) => {
    const now = time ?? performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - (this._lastTime ?? now)) / 1000));
    this._lastTime = now;
    this._updateOrbitLight(now);
    const xr = this.renderer.xr.isPresenting;
    if (!xr) {
      this._pollBrowserGamepad(dt);
      this.controls.update();
    } else {
      this._xrFrames++;
      if (this._needsXRPlacement && this._xrFrames > 2) {
        this._needsXRPlacement = false;
        this._placeWorldInFront();
        if (this.isMenuOpen()) this._placeMenuPanel();
      }
      this._pollGamepads();
      this._updateGrab();
      let msg = null;
      if (this._hudMessage && performance.now() < this._hudMessage.until) msg = this._hudMessage.text;
      const playing = this.state.screen === 'playing';
      this.rightHud.draw(this.state.toolIndex, msg);
      this.leftHud.draw(this._hudHover === 'menu', this.state.paused);
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
