import * as THREE from 'three';

// Hands-free activation for XR without controllers (phones, a headset used with its hands, a
// Cardboard viewer): look at a control and hold your gaze for DWELL_SECONDS. A reticle marks the
// centre of view and fills a ring while the timer runs. Ported from 4d-viewer-threejs (Gaze.jsx).

export const DWELL_SECONDS = 1;
export const IDLE_DISTANCE = 2; // m: reticle depth when not over anything
const RETICLE_SIZE = 0.035; // outer ring radius per metre of distance (~2°): constant on-screen size
const RING_SEGMENTS = 48;
const REARM = 0.05; // after an activation the gaze must move this far (per metre of distance, ~3°) to re-arm

/**
 * The dwell timer. Each frame, `step` gets what the gaze is on ({ key, point, distance }, or null
 * when not on a control) and returns the key to activate, if its dwell has just run out.
 * After an activation the same spot can't fire again until the gaze moves off it: a stare
 * doesn't repeat, and a menu screen that changes under the gaze doesn't press its new button.
 */
export class GazeDwell {
  key = null;
  elapsed = 0;
  spent = null; // { key, point } of the last activation

  step(dt, hit) {
    if (this.spent && (!hit || (hit.key !== this.spent.key && hit.point.distanceTo(this.spent.point) > REARM * hit.distance))) {
      this.spent = null;
    }
    if (!hit || this.spent || hit.key !== this.key) {
      this.key = hit?.key ?? null;
      this.elapsed = 0;
      return null;
    }
    this.elapsed += Math.min(dt, 0.1);
    if (this.elapsed < DWELL_SECONDS) return null;
    this.markSpent(hit);
    return hit.key;
  }

  /** An activation by other means (a screen tap, a pinch) also needs the gaze to move before the next. */
  markSpent(hit) {
    this.spent = { key: hit.key, point: hit.point.clone() };
    this.elapsed = 0;
  }

  reset() {
    this.key = null;
    this.elapsed = 0;
    this.spent = null;
  }

  /** 0…1: how far the ring is filled. */
  get progress() {
    return this.key == null || this.spent ? 0 : Math.min(this.elapsed / DWELL_SECONDS, 1);
  }
}

/** The reticle: a dot, a faint ring and the dwell progress ring (gold, clockwise from 12 o'clock). */
export class GazeReticle {
  constructor() {
    const overlay = { depthTest: false, depthWrite: false, transparent: true, toneMapped: false };
    this.group = new THREE.Group();
    this.group.name = 'xr-gaze-reticle';
    this.group.renderOrder = 1000;
    this.group.visible = false;
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.22, 24), new THREE.MeshBasicMaterial({ color: '#ffffff', opacity: 0.9, ...overlay }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 1, RING_SEGMENTS), new THREE.MeshBasicMaterial({ color: '#ffffff', opacity: 0.25, ...overlay }));
    // starts at 12 o'clock and runs clockwise
    this.progressRing = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 1, RING_SEGMENTS, 1, Math.PI / 2, -Math.PI * 2),
      new THREE.MeshBasicMaterial({ color: '#ffd34d', side: THREE.DoubleSide, ...overlay }),
    );
    dot.renderOrder = ring.renderOrder = 1000;
    this.progressRing.renderOrder = 1001;
    for (const m of [dot, ring, this.progressRing]) {
      m.frustumCulled = false;
      m.raycast = () => {};
      this.group.add(m);
    }
  }

  /** Puts the reticle `distance` m along the gaze (just in front of what it is on), facing the eye. */
  update(origin, dir, quaternion, distance, progress) {
    const d = Math.max(distance - 0.01, 0.05);
    this.group.position.copy(origin).addScaledVector(dir, d);
    this.group.quaternion.copy(quaternion);
    this.group.scale.setScalar(d * RETICLE_SIZE);
    this.progressRing.geometry.setDrawRange(0, Math.round(progress * RING_SEGMENTS) * 6);
  }
}
