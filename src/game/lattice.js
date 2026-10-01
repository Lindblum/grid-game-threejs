// Body-centred cubic lattice of truncated octahedra (bitruncated cubic honeycomb).
// Cell centres (in cm) are (2i, 2j, 2k) or (2i+1, 2j+1, 2k+1).
// Each cell touches 14 neighbours: 6 through square faces, 8 through hexagon faces.

export const SQUARE_DIRS = [
  [2, 0, 0], [-2, 0, 0],
  [0, 2, 0], [0, -2, 0],
  [0, 0, 2], [0, 0, -2],
];

export const HEX_DIRS = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) HEX_DIRS.push([x, y, z]);

export const NEIGHBOR_DIRS = [...SQUARE_DIRS, ...HEX_DIRS];

/**
 * Map key of cell (x, y, z): one number packing the three coordinates (each within
 * ±KEY_HALF cm), much faster to build and look up than a string, and no garbage.
 */
const KEY_SPAN = 1 << 17;
const KEY_HALF = KEY_SPAN / 2;
export const cellKey = (x, y, z) => ((x + KEY_HALF) * KEY_SPAN + (y + KEY_HALF)) * KEY_SPAN + (z + KEY_HALF);

export function parseKey(k) {
  const z = (k % KEY_SPAN) - KEY_HALF;
  const rest = Math.floor(k / KEY_SPAN);
  return { x: Math.floor(rest / KEY_SPAN) - KEY_HALF, y: (rest % KEY_SPAN) - KEY_HALF, z };
}

/** True when (x,y,z) is a valid cell centre: integers that are all even or all odd. */
export function isValidCell(x, y, z) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return false;
  const px = Math.abs(x) % 2, py = Math.abs(y) % 2, pz = Math.abs(z) % 2;
  return px === py && py === pz;
}

/**
 * Given an outward face normal of a cell (unit vector, cell-local),
 * return the face type and the offset to the neighbouring cell across that face.
 */
export function faceFromNormal(n) {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  const m = Math.max(ax, ay, az);
  if (m > 0.8) {
    // square face: normal along an axis
    if (m === ax) return { type: 'square', offset: [Math.sign(n.x) * 2, 0, 0] };
    if (m === ay) return { type: 'square', offset: [0, Math.sign(n.y) * 2, 0] };
    return { type: 'square', offset: [0, 0, Math.sign(n.z) * 2] };
  }
  // hexagon face: normal along a body diagonal (±1,±1,±1)/√3
  return { type: 'hexagon', offset: [Math.sign(n.x), Math.sign(n.y), Math.sign(n.z)] };
}

/** The lattice cell (all-even or all-odd coordinates) whose centre is nearest (x, y, z). */
export function nearestCell(x, y, z) {
  const even = [x, y, z].map((v) => 2 * Math.round(v / 2));
  const odd = [x, y, z].map((v) => 2 * Math.round((v - 1) / 2) + 1);
  const d2 = (cell) => (cell[0] - x) ** 2 + (cell[1] - y) ** 2 + (cell[2] - z) ** 2;
  const [cx, cy, cz] = d2(even) <= d2(odd) ? even : odd;
  return { x: cx, y: cy, z: cz };
}

/** The lattice cell nearest a uniformly random point on the sphere of radius `radiusCm` around the origin. */
export function randomCellOnSphere(radiusCm) {
  // uniform direction: z uniform in [-1, 1], angle uniform around the z axis
  const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return nearestCell(r * Math.cos(a) * radiusCm, r * Math.sin(a) * radiusCm, z * radiusCm);
}
