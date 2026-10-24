// Tool icons rendered by the engine itself: each block type (and creature, with its eyes,
// legs and wings) is drawn by a small offscreen three.js scene holding a one-block World,
// with the same block materials and lights as the game, in the current Options → Materials
// (Procedural / Solid) and Options → Rendering (Smooth / Blocky). The results are cached as
// canvases (see icons.js: drawToolIcon, toolIconURL).
import * as THREE from 'three';
import { World } from './world.js';
import { isCreature } from './blocks.js';
import { GRID, gridMode } from './lattice.js';
import { createBlockGeometry } from './geometry.js';
import { createTouchBallMaterial, touchBallTime } from './touchBall.js';

const SIZE = 160; // px, rendered square; icons are drawn scaled from this
/** The icon's view direction (from the upper right front), and its field of view. */
const VIEW_DIR = new THREE.Vector3(0.55, 0.62, 1).normalize();
const FOV = 30;
/**
 * How far the drawn thing reaches from the block centre, cm: the block's farthest corner (the
 * grid mode's cell) with a little room, and creatures' legs and wings beyond it.
 */
const blockRadius = () => 1.07 * GRID.scale * Math.max(...GRID.vertices.map((v) => v.length()));
const CREATURE_EXTRA = 0.55;
/** A fixed moment for the shaders' animations (Water, clouds, wings), so icons don't vary. */
const ICON_TIME_MS = 4200;

class IconRenderer {
  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(SIZE, SIZE, false);
    r.setClearColor(0x000000, 0);
    this.renderer = r;
    const scene = new THREE.Scene();
    // the game's lights: soft hemisphere and a fill from below behind, plus a key light
    // standing in for the orbiting sun, from the upper left front
    scene.add(new THREE.HemisphereLight(0xffff80, 0x404080, 0.25));
    const fill = new THREE.DirectionalLight(0xffff80, 1);
    fill.position.set(-1, -0.4, -0.6);
    scene.add(fill);
    const key = new THREE.DirectionalLight(0xfff4e0, 2.6);
    key.position.set(-0.6, 1, 0.8);
    scene.add(key);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    const root = new THREE.Group(); // lattice units (cm), like the game's worldRoot
    scene.add(root);
    this.world = new World(root);
  }

  /** Renders block type `type` in `style` ({ materials, smooth }); returns a canvas copy. */
  render(type, { materials = 'solid', smooth = false } = {}) {
    const w = this.world;
    w.materials.setMaterials(materials);
    w.setSmoothRendering(smooth);
    w.add(0, 0, 0, type);
    const b = w.get(0, 0, 0);
    if (isCreature(type)) {
      // face the viewer, standing upright (no floor: "up" is world up, legs hang below)
      b.front = [0, 0, 2];
      b.floor = null;
      w.eyes.track(b, 0);
    }
    w.turn = 1;
    w.updateAnimations(ICON_TIME_MS); // shader time, eyes, wings, legs, Smooth bodies
    const radius = blockRadius() + (isCreature(type) ? CREATURE_EXTRA : 0);
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(FOV / 2));
    this.camera.position.copy(VIEW_DIR).multiplyScalar(dist);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement('canvas');
    out.width = out.height = SIZE;
    out.getContext('2d').drawImage(this.renderer.domElement, 0, 0);
    w.remove(0, 0, 0);
    w.updateAnimations(ICON_TIME_MS); // drop its Smooth body, eyes and legs for the next icon
    return out;
  }

  /**
   * The XR controllers' touch ball (touchBall.js: its own shader, at a fixed moment), seen as
   * the blocks are. Its light is added onto what's behind it, so it's drawn on black and each
   * pixel's brightness becomes its opacity: laid over anything, it glows the same.
   */
  renderTouchBall() {
    const mesh = new THREE.Mesh(createBlockGeometry(), createTouchBallMaterial());
    mesh.material.uniforms.uHot.value = 0.6;
    this.scene.add(mesh);
    const time = touchBallTime.value;
    touchBallTime.value = 2.3;
    const dist = blockRadius() / Math.sin(THREE.MathUtils.degToRad(FOV / 2));
    this.camera.position.copy(VIEW_DIR).multiplyScalar(dist);
    this.camera.lookAt(0, 0, 0);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setClearColor(0x000000, 0);
    touchBallTime.value = time;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    const out = document.createElement('canvas');
    out.width = out.height = SIZE;
    const ctx = out.getContext('2d');
    ctx.drawImage(this.renderer.domElement, 0, 0);
    const img = ctx.getImageData(0, 0, SIZE, SIZE), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = Math.max(d[i], d[i + 1], d[i + 2]);
      if (a) for (let k = 0; k < 3; k++) d[i + k] = Math.round((d[i + k] * 255) / a);
      d[i + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }
}

let instance = null;
let failed = false;
const cache = new Map();

/**
 * The engine-rendered icon of block type `type` in `style`, as a canvas (cached), or null
 * when WebGL isn't available (the caller falls back to a hand-drawn icon).
 */
export function renderedTouchBallIcon() {
  if (failed || typeof document === 'undefined') return null;
  const key = `touchBall:${gridMode()}`;
  if (cache.has(key)) return cache.get(key);
  try {
    instance ??= new IconRenderer();
    const icon = instance.renderTouchBall();
    cache.set(key, icon);
    return icon;
  } catch (e) {
    console.warn('Tool icons: engine rendering failed, using drawn icons', e);
    failed = true;
    return null;
  }
}

export function renderedBlockIcon(type, style = {}) {
  if (failed || typeof document === 'undefined') return null;
  const key = `${type}:${style.materials ?? 'solid'}:${style.smooth ? 'r' : 'b'}:${gridMode()}`; // (its World follows the grid mode)
  if (cache.has(key)) return cache.get(key);
  try {
    instance ??= new IconRenderer();
    const icon = instance.render(type, style);
    cache.set(key, icon);
    return icon;
  } catch (e) {
    console.warn('Tool icons: engine rendering failed, using drawn icons', e);
    failed = true;
    return null;
  }
}
