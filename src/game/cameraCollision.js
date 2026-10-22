// Browser camera vs blocks. The blocks nearby form a smooth "distance to the nearest block
// surface" field: each block's distance is measured to its real shape (the grid mode's cell:
// its face planes, blended so the edges are slightly rounded), and nearby blocks are
// blended together with a smooth minimum, so the direction out of the field (its gradient)
// changes smoothly across seams and corners instead of flipping between blocks.
//
// Each frame the camera sweeps, in small steps, from where it safely was to where the
// controls want it. Wherever a step would bring it closer than CAMERA_CLEARANCE_CM to a
// surface, the part of the step heading into the surface is dropped, so the camera slides
// along walls; it can't tunnel through thin ones or jump. A block that arrives at the
// camera (placed, falling, sliding) eases it out over EASE_OUT_S; only a camera caught inside
// a block snaps out. Water doesn't count (PASSABLE): the camera moves through it as through air.
import * as THREE from 'three';
import { GRID, cellKey, isValidCell } from './lattice.js';
import { BLOCK } from './blocks.js';

/** Blocks the camera passes through as if they were empty: it can move in Water as in air. */
const PASSABLE = new Set([BLOCK.WATER]);

/**
 * How close the camera may come to a block surface, cm: room to sit in a one-cell pocket (its
 * walls are 0.87–1 cm from the centre) and pass through the hexagonal openings between empty
 * cells, though not the smaller square ones (~0.35 cm from centre to edge); and more than the
 * near plane reaches at its corners (engine.js: 0.25 cm near plane, 60° view: ~0.4 cm), so
 * faces never clip.
 */
export const CAMERA_CLEARANCE_CM = 0.5;
const STEP_CM = 0.2; // sweep step
const LONG_MOVE_CM = 40; // moves longer than this are teleports (no sweep)
const EASE_OUT_S = 0.15; // a block arriving at the camera eases it out this fast
const FACE_BLEND = 10; // sharpness of a block's edges in the field (higher: sharper)
const BLOCK_BLEND = 24; // sharpness of the seams between blocks (higher: sharper, and closer to the true distance in tight spaces)
const REACH_CM = CAMERA_CLEARANCE_CM + 2.5; // blocks further than this can't matter (slides included)

// the active grid's cell face planes, in cm: unit normal and distance from the centre
const planesByGrid = new Map();
function planes() {
  let p = planesByGrid.get(GRID.id);
  if (!p) {
    // every face plane is halfway to the neighbour across it
    p = GRID.faces.map(({ normal: n, offset: o }) => [n.x, n.y, n.z, (Math.hypot(...o) / 2) * GRID.scale]);
    planesByGrid.set(GRID.id, p);
  }
  return p;
}

/** Signed distance (cm, approximate) from offset (x, y, z) to a block centred at the origin: a smooth max of its face planes. */
function blockDistance(x, y, z) {
  const P = planes(), n = P.length;
  let m = -Infinity;
  const d = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = P[i];
    d[i] = p[0] * x + p[1] * y + p[2] * z - p[3];
    if (d[i] > m) m = d[i];
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.exp(FACE_BLEND * (d[i] - m));
  return m + Math.log(s) / FACE_BLEND; // on a face this is the plane distance; at edges and corners a little more (rounded)
}

const _v = new THREE.Vector3();

export class CameraCollider {
  constructor(world) {
    this.world = world;
    this.centres = []; // flat x, y, z of the blocks that could matter this frame (drawn positions)
  }

  /** Collects the blocks near the segment a–b (cm), at their drawn positions (but not those in `skip`). */
  _gather(a, b, now, skip) {
    this.centres.length = 0;
    // the box around the segment, in lattice units
    const s = GRID.scale;
    const lo = a.clone().min(b).subScalar(REACH_CM).divideScalar(s), hi = a.clone().max(b).addScalar(REACH_CM).divideScalar(s);
    const blocks = this.world.blocks;
    for (let x = Math.ceil(lo.x); x <= hi.x; x++) {
      for (let y = Math.ceil(lo.y); y <= hi.y; y++) {
        for (let z = Math.ceil(lo.z); z <= hi.z; z++) {
          if (!isValidCell(x, y, z)) continue;
          const blk = blocks.get(cellKey(x, y, z));
          if (!blk || blk.vanishing || PASSABLE.has(blk.type) || skip?.has(blk)) continue;
          this.world.renderedPosition(blk, now, _v);
          this.centres.push(_v.x, _v.y, _v.z);
        }
      }
    }
    return this.centres.length > 0;
  }

  /**
   * The blocks (not vanishing) whose surface is within `reach` cm of `p` (cm, worldRoot space)
   * or that contain it, at their drawn positions: what the camera there is inside, or so near
   * that its near plane cuts into them.
   */
  blocksNear(p, now, reach) {
    const s = GRID.scale, r = reach + 1.5 * s; // (a block's corners stick out ~1 cell from its centre)
    const found = [];
    for (let x = Math.ceil((p.x - r) / s); x <= (p.x + r) / s; x++) {
      for (let y = Math.ceil((p.y - r) / s); y <= (p.y + r) / s; y++) {
        for (let z = Math.ceil((p.z - r) / s); z <= (p.z + r) / s; z++) {
          if (!isValidCell(x, y, z)) continue;
          const blk = this.world.blocks.get(cellKey(x, y, z));
          if (!blk || blk.vanishing) continue;
          this.world.renderedPosition(blk, now, _v);
          if (blockDistance(p.x - _v.x, p.y - _v.y, p.z - _v.z) < reach) found.push(blk);
        }
      }
    }
    return found;
  }

  /** The field at p: smooth minimum of the nearby blocks' distances (cm; negative inside a block). */
  field(p) {
    const c = this.centres;
    let m = Infinity;
    const ds = [];
    for (let i = 0; i < c.length; i += 3) {
      const dx = p.x - c[i], dy = p.y - c[i + 1], dz = p.z - c[i + 2];
      if (dx * dx + dy * dy + dz * dz > REACH_CM * REACH_CM * 4) continue; // far: can't be the nearest
      const d = blockDistance(dx, dy, dz);
      ds.push(d);
      if (d < m) m = d;
    }
    if (!ds.length) return Infinity;
    let s = 0;
    for (const d of ds) s += Math.exp(-BLOCK_BLEND * (d - m));
    return m - Math.log(s) / BLOCK_BLEND;
  }

  /** The field's direction of increase at p (unit vector; out of the blocks), or null in a flat spot. */
  gradient(p, out = new THREE.Vector3()) {
    const h = 0.01;
    const f = (x, y, z) => this.field(_v.set(p.x + x, p.y + y, p.z + z));
    out.set(f(h, 0, 0) - f(-h, 0, 0), f(0, h, 0) - f(0, -h, 0), f(0, 0, h) - f(0, 0, -h));
    const len = out.length();
    return len > 1e-9 ? out.divideScalar(len) : null;
  }

  /**
   * Pushes `p` out along the field until it is at least `target` from the surfaces (a few
   * rounds: blended fields change a little slower than distance does). `away`: the way out
   * when the field is flat (dead in a block's centre). Returns `p`.
   */
  _pushOut(p, target, away) {
    const g = new THREE.Vector3();
    for (let k = 0; k < 5; k++) {
      const f = this.field(p);
      if (f >= target - 1e-4) break;
      if (!this.gradient(p, g)) g.copy(away).normalize();
      p.addScaledVector(g, target - f + 0.01);
    }
    return p;
  }

  /**
   * Moves the camera from `from` (where it safely was; null after a reset) toward `to` (where
   * the controls want it), both in cm (worldRoot space). `away` is the fallback direction out when the
   * camera sits dead in a block's centre. `skip`: blocks that don't count (a Set; e.g. the
   * creature a third-person camera sweeps out from). Returns { pos, blocked } (blocked: some of
   * the motion was stopped by a surface).
   */
  resolve(from, to, now, dt, away, skip = null) {
    const teleport = !from || from.distanceTo(to) > LONG_MOVE_CM;
    const start = teleport ? to.clone() : from.clone();
    if (!this._gather(start, to, now, skip)) return { pos: to.clone(), blocked: false };
    const clear = CAMERA_CLEARANCE_CM;
    let blocked = false;
    const pos = start.clone();
    const g = new THREE.Vector3();
    if (!teleport) {
      const total = to.clone().sub(start);
      const n = Math.max(1, Math.ceil(total.length() / STEP_CM));
      const step = total.divideScalar(n);
      const next = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const fPos = this.field(pos);
        next.copy(pos).add(step);
        if (this.field(next) >= Math.min(clear, fPos)) {
          pos.copy(next); // clear (or no deeper than it already was, when a block came to it)
          continue;
        }
        blocked = true;
        // go as far as the clearance allows (bisection), then slide the rest of the step:
        // drop the part heading into the surface
        const limit = Math.min(clear, fPos);
        let lo = 0, hi = 1;
        for (let k = 0; k < 6; k++) {
          const mid = (lo + hi) / 2;
          if (this.field(next.copy(pos).addScaledVector(step, mid)) >= limit) lo = mid;
          else hi = mid;
        }
        pos.addScaledVector(step, lo);
        const rest = step.clone().multiplyScalar(1 - lo);
        if (this.gradient(pos, g)) {
          const into = rest.dot(g);
          if (into < 0) rest.addScaledVector(g, -into);
          pos.add(rest);
          this._pushOut(pos, limit, away); // a curved or cornered surface: back onto the line
        }
      }
    }
    // a block at the camera that it didn't move into (placed, fallen, slid in): out of it,
    // easing unless the camera is inside the block
    const f = this.field(pos);
    if (f < clear - 1e-3) {
      const out = this._pushOut(pos.clone(), clear, away);
      if (f <= 0 || teleport) pos.copy(out);
      else pos.lerp(out, Math.min(1, dt / EASE_OUT_S));
    }
    return { pos, blocked };
  }
}
