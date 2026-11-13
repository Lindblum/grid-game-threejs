// The active grid mode (grids.js): which integer points are cells, and each cell's neighbours
// (one per face). NEIGHBOR_DIRS and GRID are live bindings: setGridMode swaps them, so every
// rule that loops over a cell's neighbours works in any mode. Switch only with an empty world
// (World.setGridMode does that, and rebuilds what depends on the shape).
import * as THREE from 'three';
import { DEFAULT_GRID, GRIDS } from './grids.js';

const _v = new THREE.Vector3();

/** The active grid (see grids.js): id, name, scale (lattice -> cm), faces, dirs, … */
export let GRID = GRIDS[DEFAULT_GRID];
/** Offsets to a cell's neighbours, in face order (GRID.faces). */
export let NEIGHBOR_DIRS = GRID.offsets;
/** Extra creature steps across a cell's edges (Cube and Hexagonal Prism; empty in the others, where every step is a face). */
export let EDGE_STEPS = GRID.edgeSteps;
/**
 * The two face offsets [a, b] beside each edge step (a + b), keyed by edgeStepKey: a step
 * from a cell goes past the cells at a and b.
 */
export let EDGE_SIDES = GRID.edgeSides;
export const edgeStepKey = (dx, dy, dz) => `${dx},${dy},${dz}`;

const listeners = new Set();

/** Calls `fn(grid)` after every switch of grid mode. Returns a function that stops it. */
export function onGridChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The active grid mode's id ('to', 'rd', 'cube', 'hex'). */
export const gridMode = () => GRID.id;

/** Switches to grid mode `id` (unknown ids: the default). Returns whether it changed. */
export function setGridMode(id) {
  const next = GRIDS[id] ?? GRIDS[DEFAULT_GRID];
  if (next === GRID) return false;
  GRID = next;
  NEIGHBOR_DIRS = next.offsets;
  EDGE_STEPS = next.edgeSteps;
  EDGE_SIDES = next.edgeSides;
  for (const fn of listeners) fn(next);
  return true;
}

/**
 * Map key of cell (x, y, z): one number packing the three coordinates (each within
 * ±KEY_HALF: cells further out aren't valid, see isValidCell), much faster to build and look
 * up than a string, and no garbage: 10 bits each keeps every key under 2^30, a small integer
 * to the JS engine (a bigger one is a heap number: one allocation per lookup).
 */
const KEY_SPAN = 1 << 10;
const KEY_HALF = KEY_SPAN / 2;
export const cellKey = (x, y, z) => ((x + KEY_HALF) * KEY_SPAN + (y + KEY_HALF)) * KEY_SPAN + (z + KEY_HALF);

export function parseKey(k) {
  const z = (k % KEY_SPAN) - KEY_HALF;
  const rest = Math.floor(k / KEY_SPAN);
  return { x: Math.floor(rest / KEY_SPAN) - KEY_HALF, y: (rest % KEY_SPAN) - KEY_HALF, z };
}

/** True when (x, y, z) is a cell of the active grid. */
export function isValidCell(x, y, z) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return false;
  if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) >= KEY_HALF - 4) return false; // (beyond what cellKey packs, neighbours included)
  return GRID.isValid(x, y, z);
}

/**
 * Given an outward face normal of a cell (unit vector, cell-local), the face it belongs to:
 * { type (face / edge / corner), name, offset to the neighbouring cell across it }.
 */
export function faceFromNormal(n) {
  let best = GRID.cmFaces[0], bestDot = -Infinity;
  for (const f of GRID.cmFaces) { // (the drawn block's normals: cm)
    const d = f.normal.x * n.x + f.normal.y * n.y + f.normal.z * n.z;
    if (d > bestDot) bestDot = d, best = f;
  }
  return { type: best.type, name: best.name, offset: best.offset };
}

/** The cell whose centre is nearest lattice point (x, y, z). */
export function nearestCell(x, y, z) {
  const [cx, cy, cz] = GRID.nearest(x, y, z);
  return { x: cx, y: cy, z: cz };
}

/** The cell nearest a uniformly random point on the sphere of radius `radiusCm` around the origin. */
export function randomCellOnSphere(radiusCm) {
  // uniform direction: z uniform in [-1, 1], angle uniform around the z axis
  const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  const p = fromCm(r * Math.cos(a) * radiusCm, r * Math.sin(a) * radiusCm, z * radiusCm, _v);
  return nearestCell(p.x, p.y, p.z);
}

// Lattice units <-> cm (GRID.toCm). In most modes that's just GRID.scale; Hexagonal Prism's
// also squashes its column axis (grids.js), so a length or a direction in lattice units isn't
// one in cm: convert positions with toCm / fromCm, and measure distances with cmDist2.

/** Lattice point (x, y, z) in cm, into `out` (a Vector3). */
export function toCm(x, y, z, out) {
  if (GRID.uniform) return out.set(x * GRID.scale, y * GRID.scale, z * GRID.scale);
  const e = GRID.toCm.elements; // (column-major)
  return out.set(e[0] * x + e[3] * y + e[6] * z, e[1] * x + e[4] * y + e[7] * z, e[2] * x + e[5] * y + e[8] * z);
}

/** Point (x, y, z) in cm, in lattice units, into `out`. */
export function fromCm(x, y, z, out) {
  if (GRID.uniform) return out.set(x / GRID.scale, y / GRID.scale, z / GRID.scale);
  const e = GRID.fromCm.elements;
  return out.set(e[0] * x + e[3] * y + e[6] * z, e[1] * x + e[4] * y + e[7] * z, e[2] * x + e[5] * y + e[8] * z);
}

/** The squared length in cm of lattice offset (x, y, z) (from the origin: its squared distance). */
export function cmDist2(x, y, z) {
  if (GRID.uniform) return (x * x + y * y + z * z) * GRID.scale * GRID.scale;
  const p = toCm(x, y, z, _v);
  return p.x * p.x + p.y * p.y + p.z * p.z;
}

/**
 * The lattice box (integer { lo, hi } corners) holding every point of the cm box `lo`..`hi`
 * (Vector3s): what to loop over to find the cells there.
 */
export function latticeBox(lo, hi) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = fromCm(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z, _v);
    for (let j = 0; j < 3; j++) {
      const c = p.getComponent(j);
      if (c < min[j]) min[j] = c;
      if (c > max[j]) max[j] = c;
    }
  }
  return { lo: min.map(Math.ceil), hi: max.map(Math.floor) };
}

/** How far (cm) a cell's surface is from its centre along unit vector `u` (cm). */
export function cellExtent(u) {
  let d = Infinity;
  for (const f of GRID.cmFaces) {
    const c = f.normal.dot(u);
    if (c > 1e-9) d = Math.min(d, f.distance / c);
  }
  return d;
}
