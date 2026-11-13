// Options → Display → Show Health: three thin bars above every critter, no text: HP (red),
// Sate (orange) and Quench (blue), top to bottom, each filled by how much of it the critter
// has (needs.js; a critter of several blocks: its blocks' HP added up against their full HP,
// and its Sate and Quench averaged). They face the camera and sit above the critter as seen.
import * as THREE from 'three';
import { needsOf, needsOfType, MAX_SATE, MAX_QUENCH } from './needs.js';

const BARS = [
  { color: '#ff3030', of: (body, t) => body.reduce((n, b) => n + Math.max(0, needsOf(b).hp), 0) / (t.hp * body.length) },
  { color: '#ff9430', of: (body) => body.reduce((n, b) => n + needsOf(b).sate, 0) / (MAX_SATE * body.length) },
  { color: '#3a8cff', of: (body) => body.reduce((n, b) => n + needsOf(b).quench, 0) / (MAX_QUENCH * body.length) },
];
/** Bar size (cm: a block is 2 cm), the gap between bars, and how far above the critter's centre the lowest sits. */
const BAR_W = 2.4;
const BAR_H = 0.28;
const BAR_GAP = 0.1;
const ABOVE_CM = 1.9;
/** Drawn this far (cm) toward the camera, so the critter's own body doesn't cut into them. */
const TOWARD_CAMERA_CM = 1.0;

const _cam = new THREE.Vector3(), _up = new THREE.Vector3(), _right = new THREE.Vector3();
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _a = new THREE.Vector3();

function barSprite(color, opacity, order) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ color, transparent: true, opacity, // (all in the see-through pass, so renderOrder puts the fills over their backs)
    depthWrite: false, toneMapped: false, fog: false }));
  s.center.set(0, 0.5); // (anchored at its left end: the fill grows to the right)
  s.renderOrder = order;
  s.raycast = () => { };
  return s;
}

export class HealthBars {
  /** `parent`: the world's root (cm units, like the blocks). */
  constructor(parent) {
    this.parent = parent;
    this.group = new THREE.Group();
    this.group.name = 'health-bars';
    this.group.visible = false;
    parent.add(this.group);
    this.byHead = new Map(); // critter head -> { back: [Sprite×3], fill: [Sprite×3] }
  }

  setShown(on) {
    this.group.visible = on;
    if (!on) this.clear();
  }

  /** Every critter (head, body) now in `world` (as needs.js stepNeeds sees them). */
  _bodies(world) {
    const out = [];
    for (const c of world.soloCreatures) if (!c.vanishing) out.push(world.clusterOf(c));
    for (const sq of world.squirmies) if (sq.segments.length && !sq.segments[0].vanishing) out.push(sq.segments);
    return out;
  }

  /** Moves and fills the bars to scene time `now` (ms), facing `camera`; call once per frame. */
  update(world, now, camera) {
    if (!this.group.visible || !camera) return;
    // the camera's position, and its up and right, in the world's (cm) frame
    camera.getWorldPosition(_cam);
    camera.getWorldQuaternion(_q);
    const local = (dir, out) => {
      _a.copy(_cam).add(dir);
      return out.copy(this.parent.worldToLocal(_a)).sub(this.parent.worldToLocal(_p.copy(_cam))).normalize();
    };
    local(new THREE.Vector3(0, 1, 0).applyQuaternion(_q), _up);
    local(new THREE.Vector3(1, 0, 0).applyQuaternion(_q), _right);
    const camLocal = this.parent.worldToLocal(_cam.clone());
    const seen = new Set();
    for (const body of this._bodies(world)) {
      const head = body[0];
      const t = needsOfType(head.type);
      if (!t) continue;
      seen.add(head);
      let bars = this.byHead.get(head);
      if (!bars) {
        bars = { back: BARS.map(() => barSprite('#101010', 0.6, 5)), fill: BARS.map((b) => barSprite(b.color, 1, 6)) };
        for (const s of [...bars.back, ...bars.fill]) this.group.add(s);
        this.byHead.set(head, bars);
      }
      world.renderedPosition(head, now, _p);
      const at = _p.clone().addScaledVector(camLocal.clone().sub(_p).normalize(), TOWARD_CAMERA_CM);
      BARS.forEach((bar, i) => {
        const f = Math.min(1, Math.max(0, bar.of(body, t)));
        const pos = at.clone().addScaledVector(_up, ABOVE_CM + (BARS.length - 1 - i) * (BAR_H + BAR_GAP)).addScaledVector(_right, -BAR_W / 2);
        bars.back[i].position.copy(pos);
        bars.back[i].scale.set(BAR_W, BAR_H, 1);
        bars.fill[i].position.copy(pos);
        bars.fill[i].scale.set(Math.max(1e-4, BAR_W * f), BAR_H, 1);
        bars.fill[i].visible = f > 0;
      });
    }
    for (const [head, bars] of this.byHead) if (!seen.has(head)) this._drop(head, bars);
  }

  _drop(head, bars) {
    for (const s of [...bars.back, ...bars.fill]) {
      this.group.remove(s);
      s.material.dispose();
    }
    this.byHead.delete(head);
  }

  clear() {
    for (const [head, bars] of this.byHead) this._drop(head, bars);
  }
}
