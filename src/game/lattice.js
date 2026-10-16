// The active grid mode (grids.js): which integer points are cells, and each cell's neighbours
// (one per face). NEIGHBOR_DIRS and GRID are live bindings: setGridMode swaps them, so every
// rule that loops over a cell's neighbours works in any mode. Switch only with an empty world
// (World.setGridMode does that, and rebuilds what depends on the shape).
import { DEFAULT_GRID, GRIDS } from './grids.js';

/** The active grid (see grids.js): id, name, scale (lattice -> cm), faces, dirs, … */
export let GRID = GRIDS[DEFAULT_GRID];
/** Offsets to a cell's neighbours, in face order (GRID.faces). */
export let NEIGHBOR_DIRS = GRID.offsets;

const listeners = new Set();

/** Calls `fn(grid)` after every switch of grid mode. Returns a function that stops it. */
export function onGridChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The active grid mode's id ('to', 'rd', 'cube'). */
export const gridMode = () => GRID.id;

/** Switches to grid mode `id` (unknown ids: the default). Returns whether it changed. */
export function setGridMode(id) {
  const next = GRIDS[id] ?? GRIDS[DEFAULT_GRID];
  if (next === GRID) return false;
  GRID = next;
  NEIGHBOR_DIRS = next.offsets;
  for (const fn of listeners) fn(next);
  return true;
}

/**
 * Map key of cell (x, y, z): one number packing the three coordinates (each within
 * ±KEY_HALF), much faster to build and look up than a string, and no garbage.
 */
const KEY_SPAN = 1 << 17;
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
  return GRID.isValid(x, y, z);
}

/**
 * Given an outward face normal of a cell (unit vector, cell-local), the face it belongs to:
 * { type (face / edge / corner), name, offset to the neighbouring cell across it }.
 */
export function faceFromNormal(n) {
  let best = GRID.faces[0], bestDot = -Infinity;
  for (const f of GRID.faces) {
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
  const R = radiusCm / GRID.scale;
  return nearestCell(r * Math.cos(a) * R, r * Math.sin(a) * R, z * R);
}
