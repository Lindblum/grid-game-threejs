// Shared by every creature type (Crawly, Buzzy, and a Squirmy's head): orientation (floor +
// front), the two eyes, and (for types with `wings`) two flapping wings. Each creature type's own rules (moving, eating, …) live in sim.js, and a
// Squirmy's chain bundling in world.js.
import * as THREE from 'three';
import { NEIGHBOR_DIRS, cellKey } from './lattice.js';
import { BLOCK, blockProps } from './blocks.js';
// Behaviors, sight radius and eye size are per creature type: see BLOCK_TYPES in blocks.js.

/** Block types a creature can use as its floor (sets which way is "up" for its eyes). */
export const FLOOR_TYPES = new Set([BLOCK.STONE, BLOCK.DIRT, BLOCK.MOSS, BLOCK.CRYSTAL, BLOCK.WOOD, BLOCK.BERRY]);
/**
 * Eye centres in the creature's own frame, cm: x = right, y = up (away from the floor),
 * z = front. The frame turns; the eyes themselves never rotate.
 */
const EYE_OFFSETS = [new THREE.Vector3(-0.32, 0, 0.92), new THREE.Vector3(0.32, 0, 0.92)];

/**
 * Wings (creature types with `wings: true`): hinge points on the creature's upper sides, in
 * its own frame (cm; x = right, y = up, z = front). Each wing is a thin, translucent oval
 * that sticks out sideways and a little back, and swings up about its hinge (the body's
 * front-back axis) once at the start of every turn.
 */
const WING_HINGES = [new THREE.Vector3(0.62, 0.5, -0.15), new THREE.Vector3(-0.62, 0.5, -0.15)];
const WING_REST = 0.3; // rad the wings are raised by at rest
const WING_FLAP = 0.95; // rad of extra lift at the top of a flap

/** Wing geometry, hinge at the origin: an oval 1 cm long (out along +x), 0.45 cm wide, flat in x-z. */
function createWingGeometry() {
  const g = new THREE.CircleGeometry(0.5, 28);
  g.rotateX(-Math.PI / 2); // lie flat (x-z plane)
  g.scale(1, 1, 0.45);
  g.translate(0.5, 0, -0.12); // inner edge at the hinge, swept a little back
  return g;
}

const _v = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _flap = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _wingScale = [new THREE.Vector3(1, 1, 1), new THREE.Vector3(-1, 1, 1)]; // right, left (mirrored)
const _f = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _noRot = new THREE.Quaternion();

const dot = (a, b) => (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b);
const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Neighbour offsets (lattice directions) that hold a floor block. */
function floorDirs(world, c) {
  return NEIGHBOR_DIRS.filter(([dx, dy, dz]) => FLOOR_TYPES.has(world.blocks.get(cellKey(c.x + dx, c.y + dy, c.z + dz))?.type));
}

/**
 * Updates `c.floor` and `c.front` (lattice direction arrays, or floor = null when no
 * floor block touches it).
 * - Front: the direction it just moved (`moveDir`); unchanged when it didn't move. A new
 *   creature faces a random side perpendicular (or nearly) to its floor.
 * - Floor: any side touching a FLOOR_TYPES block. The current floor is kept while it is still
 *   valid; otherwise the candidate best aligned with the old floor (or world down) wins,
 *   so "down" stays consistent as the creature walks around corners.
 */
export function orientCreature(world, c, moveDir = null) {
  if (moveDir) c.front = moveDir;
  const dirs = floorDirs(world, c);
  if (!dirs.length) c.floor = null;
  else if (!dirs.some((d) => same(d, c.floor))) {
    const ref = c.floor ?? [0, -1, 0];
    c.floor = dirs.reduce((best, d) => (dot(d, ref) > dot(best, ref) ? d : best));
  }
  if (!c.front) {
    const down = c.floor ?? [0, -1, 0];
    const minDot = Math.min(...NEIGHBOR_DIRS.map((d) => Math.abs(dot(d, down))));
    const cands = NEIGHBOR_DIRS.filter((d) => Math.abs(dot(d, down)) - minDot < 1e-6);
    c.front = cands[Math.floor(Math.random() * cands.length)];
  }
}

/**
 * Rotation taking the creature's frame (right, up, forward) to world axes. Forward is the
 * direction it last moved (its front), so the eyes sit on the side it moved through. Up is
 * "away from the floor" with its forward part removed, which keeps the line between the two
 * eyes perpendicular to the floor normal: the pair stays level with the floor surface even
 * after a diagonal step. With no floor, world up is used.
 */
function frameQuaternion(c, out) {
  _f.set(...c.front).normalize();
  if (c.floor) _up.set(...c.floor).negate().normalize();
  else _up.set(0, 1, 0);
  _up.addScaledVector(_f, -_up.dot(_f)); // make up perpendicular to forward
  if (_up.lengthSq() < 1e-6) {
    // moved straight toward / away from the floor: keep the previous up, or pick any
    if (c.eyeUp) {
      _up.set(...c.eyeUp);
      _up.addScaledVector(_f, -_up.dot(_f));
    }
    if (_up.lengthSq() < 1e-6) _up.set(0, 1, 0).addScaledVector(_f, -_f.y);
    if (_up.lengthSq() < 1e-6) _up.set(1, 0, 0).addScaledVector(_f, -_f.x);
  }
  _up.normalize();
  c.eyeUp = _up.toArray();
  _right.crossVectors(_up, _f);
  return out.setFromRotationMatrix(_basis.makeBasis(_right, _up, _f));
}

/**
 * Renders two shiny black eyes (small spheres) per creature (a Crawly, or a Squirmy's head),
 * sized by its type's eyeScale. When a creature's front or floor changes, the eyes revolve around its centre to the new front side;
 * they only change position, never rotation.
 */
export class CreatureEyes {
  constructor(parent) {
    this.parent = parent;
    this.geometry = new THREE.SphereGeometry(1, 20, 14); // radius 1 = a block's inradius, scaled by the creature's eyeScale
    this.material = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.12, metalness: 0.0 });
    this.state = new Map(); // creature block -> { q, from, to, t0, dur }
    this.mesh = null;
    this.wingGeometry = createWingGeometry();
    this.wingMaterial = new THREE.MeshStandardMaterial({
      color: 0xdff4ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
      depthWrite: false, roughness: 0.15, metalness: 0.1,
    });
    this.wingMesh = null;
    this._flapTurn = null; // the turn the current flap belongs to
    this._flapT0 = -Infinity; // when it started (ms)
    this._allocate(64);
  }

  _allocate(capacity) {
    if (this.mesh) {
      this.parent.remove(this.mesh);
      this.mesh.dispose();
    }
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = 'creature-eyes';
    mesh.raycast = () => { };
    this.parent.add(mesh);
    this.mesh = mesh;
    if (this.wingMesh) {
      this.parent.remove(this.wingMesh);
      this.wingMesh.dispose();
    }
    const wings = new THREE.InstancedMesh(this.wingGeometry, this.wingMaterial, capacity);
    wings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    wings.count = 0;
    wings.frustumCulled = false;
    wings.name = 'creature-wings';
    wings.raycast = () => { };
    this.parent.add(wings);
    this.wingMesh = wings;
  }

  /** Points the eyes at `c`'s current front/floor, revolving there over `durationS`. */
  track(c, durationS = 0, now = performance.now()) {
    const to = frameQuaternion(c, new THREE.Quaternion());
    const s = this.state.get(c);
    if (!s || durationS <= 0) {
      this.state.set(c, { q: to.clone(), from: to.clone(), to, t0: now, dur: 0 });
      return;
    }
    s.from.copy(s.q);
    s.to = to;
    s.t0 = now;
    s.dur = durationS * 1000;
  }

  untrack(c) {
    this.state.delete(c);
  }

  clear() {
    this.state.clear();
  }

  /** Call once per frame. `positionOf(c, out)` gives the creature's rendered centre. */
  /**
   * Call once per frame. `positionOf(c, out)` gives the creature's rendered centre. `turn`
   * (the game turn) starts a wing flap each time it changes; a flap lasts `flapSeconds`.
   */
  update(now, positionOf, { turn = null, flapSeconds = 0.4 } = {}) {
    if (turn !== this._flapTurn) {
      this._flapTurn = turn;
      this._flapT0 = now;
    }
    let w = 0;
    const need = this.state.size * EYE_OFFSETS.length;
    if (need > this.mesh.instanceMatrix.count) {
      let cap = this.mesh.instanceMatrix.count;
      while (cap < need) cap *= 2;
      this._allocate(cap);
    }
    let i = 0;
    const scale = _v;
    const pos = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (const [c, s] of this.state) {
      if (s.dur > 0) {
        const t = Math.min(1, (now - s.t0) / s.dur);
        s.q.slerpQuaternions(s.from, s.to, t * t * (3 - 2 * t));
        if (t >= 1) s.dur = 0;
      }
      positionOf(c, pos);
      scale.setScalar(blockProps(c.type).eyeScale ?? 0.25);
      for (const off of EYE_OFFSETS) {
        p.copy(off).applyQuaternion(s.q).add(pos); // revolve the offset, not the eye
        this.mesh.setMatrixAt(i++, _m.compose(p, _noRot, scale));
      }
      if (blockProps(c.type).wings) {
        // one flap per turn, each creature slightly out of step with the others
        const lag = ((c.index * 0.37) % 1) * 0.12 * flapSeconds * 1000;
        const t = Math.min(1, Math.max(0, (now - this._flapT0 - lag) / (flapSeconds * 1000)));
        const lift = WING_REST + WING_FLAP * Math.sin(Math.PI * t);
        WING_HINGES.forEach((hinge, k) => {
          p.copy(hinge).applyQuaternion(s.q).add(pos);
          // turn with the body, then swing up about the front-back axis (mirrored for the left)
          _flap.setFromAxisAngle(_zAxis, k === 0 ? lift : -lift);
          _wq.copy(s.q).multiply(_flap);
          this.wingMesh.setMatrixAt(w++, _m.compose(p, _wq, _wingScale[k]));
        });
      }
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.wingMesh.count = w;
    this.wingMesh.instanceMatrix.needsUpdate = true;
  }
}
