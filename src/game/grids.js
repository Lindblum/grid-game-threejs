// Grid modes: four honeycombs of identical cells that fill space with no gaps.
//
// Every mode puts its cells on integer lattice coordinates (x, y, z), a subset of Z³, so cell
// keys (lattice.js cellKey) and saves work the same in all of them. A mode says which integer
// points are cells, the offset to the neighbour across each face of a cell, the cell's shape
// (in lattice units), and the lattice -> cm scale that gives the shape an inradius of 1 cm
// (toCm: just that scale, except Hexagonal Prism's, which also squashes; see below).
//
//   Truncated Octahedron  BCC: all even or all odd    6 × (±2,0,0) + 8 × (±1,±1,±1)  scale 1
//   Rhombic Dodecahedron  FCC: x + y + z even         12 × (±1,±1,0)                 scale √2
//   Cube                  all even                    6 × (±2,0,0)                   scale 1
//   Hexagonal Prism       x + y + z a multiple of 3   6 × (1,-1,0) perms + ±(1,1,1)  scale √2
//
// The hexagonal prisms' columns run along (1, 1, 1): each layer (x + y + z = 3m) is a
// triangular lattice of side √2, the layers √3 apart. That makes a prism 1.22× as tall as it
// is wide across its flats, so its lattice -> cm map (toCm) also squashes the column axis by
// √(2/3), which makes it as tall as it is wide across its flats: 2 cm each way (an inradius of
// 1 cm, to its sides and its caps alike), its sides 1.15 cm (the hexagon's edge) by 2 cm tall.
// Every neighbour offset lies along the axis or square to it, so the squash keeps each one's
// direction (face normals and creature facings come out the same); only lengths change, so
// distances (gravity, sight, …) are measured in cm (lattice.js toCm, cmDist2), not lattice
// units. Gravity pulls toward the origin, so the tilted axis doesn't look tilted.
//
// Directions are named by the signs of their offset's axes: "+X", "+X-Y", "+X+Y+Z". A
// direction's kind is how many axes it uses: face (1 axis), edge (2) or corner (3). A name
// means the same way in every mode that has it; dirName / GRID.dirByName convert.
import * as THREE from 'three';

export const DIR_KINDS = ['', 'face', 'edge', 'corner'];

/** The direction name of lattice offset `o`, e.g. [2, 0, 0] -> "+X", [1, -1, 1] -> "+X-Y+Z". */
export function dirName(o) {
  let s = '';
  for (let i = 0; i < 3; i++) if (o[i]) s += (o[i] > 0 ? '+' : '-') + 'XYZ'[i];
  return s;
}

/** A direction's kind: face, edge or corner (how many axes its offset moves along). */
export const dirKind = (o) => DIR_KINDS[o.filter((v) => v !== 0).length];

const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

/** Every distinct permutation of every sign choice of `base` (zeros keep their place). */
function signedPerms(base) {
  const out = new Map();
  for (const p of PERMS) {
    const v = [base[p[0]], base[p[1]], base[p[2]]];
    for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
      const w = [v[0] * sx, v[1] * sy, v[2] * sz].map((c) => c || 0);
      out.set(w.join(','), w);
    }
  }
  return [...out.values()];
}

/**
 * The cell's faces, one per neighbour offset in `offsets` (same order): the face lies halfway
 * to that neighbour, on the plane through the `vertices` there. Each face is { type (its
 * direction's kind), name (its direction's name), offset, normal, verts: Vector3[] (CCW seen
 * from outside), center, inradius (face centre to an edge) }.
 */
function buildFaces(vertices, offsets) {
  return offsets.map((offset) => {
    const d = new THREE.Vector3(...offset);
    const planeDist = d.length() / 2;
    const normal = d.normalize();
    const verts = vertices.filter((v) => Math.abs(v.dot(normal) - planeDist) < 1e-6).map((v) => v.clone());
    const c = verts.reduce((acc, v) => acc.add(v), new THREE.Vector3()).multiplyScalar(1 / verts.length);
    // basis (u, w, n) right-handed -> ascending angle is CCW seen from outside
    const u = verts[0].clone().sub(c).normalize();
    const w = new THREE.Vector3().crossVectors(normal, u);
    verts.sort((p, q) => {
      const dp = p.clone().sub(c), dq = q.clone().sub(c);
      return Math.atan2(dp.dot(w), dp.dot(u)) - Math.atan2(dq.dot(w), dq.dot(u));
    });
    const mid = verts[0].clone().add(verts[1]).multiplyScalar(0.5);
    return { type: dirKind(offset), name: dirName(offset), offset, normal, verts, center: c, inradius: mid.distanceTo(c) };
  });
}

const AXIS_DIRS = [[2, 0, 0], [-2, 0, 0], [0, 2, 0], [0, -2, 0], [0, 0, 2], [0, 0, -2]];
const BODY_DIRS = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) BODY_DIRS.push([x, y, z]);
const PLANE_DIRS = [];
for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
  for (const sa of [1, -1]) for (const sb of [1, -1]) {
    const o = [0, 0, 0];
    o[a] = sa;
    o[b] = sb;
    PLANE_DIRS.push(o);
  }
}

// a hexagonal prism's 6 neighbours round its column: (1, -1, 0) permuted
const HEX_SIDE_DIRS = PERMS.map((p) => { const o = [0, 0, 0]; o[p[0]] = 1; o[p[1]] = -1; return o; });

const even = (v) => Math.abs(v) % 2 === 0;
const mod3 = (v) => ((v % 3) + 3) % 3;
const d2 = (c, x, y, z) => (c[0] - x) ** 2 + (c[1] - y) ** 2 + (c[2] - z) ** 2;

const stepKey = (o) => o.join(',');

function defineGrid(def) {
  const vertices = def.vertices.map((v) => new THREE.Vector3(...v));
  const faces = buildFaces(vertices, def.offsets);
  const dirs = faces.map(({ name, type, offset }) => ({ name, kind: type, offset }));
  // edge steps: [a, b] pairs of face offsets; the step goes to a + b, past the cells at a and b
  const pairs = def.edgePairs ?? [];
  const edgeSteps = pairs.map(([a, b]) => a.map((v, i) => v + b[i]));
  // lattice -> cm: the scale, times (squash) a squash by `k` along `axis`
  const toCm = new THREE.Matrix3().multiplyScalar(def.scale);
  if (def.squash) {
    const a = new THREE.Vector3(...def.squash.axis).normalize(), k = def.squash.k;
    const e = [0, 1, 2].map((i) => [0, 1, 2].map((j) => def.scale * ((i === j ? 1 : 0) + (k - 1) * a.getComponent(i) * a.getComponent(j))));
    toCm.set(...e[0], ...e[1], ...e[2]);
  }
  const fromCm = toCm.clone().invert();
  const normalToCm = fromCm.clone().transpose(); // (normals map by the inverse transpose)
  const cmFaces = faces.map((f) => {
    const verts = f.verts.map((v) => v.clone().applyMatrix3(toCm));
    const center = f.center.clone().applyMatrix3(toCm);
    const normal = f.normal.clone().applyMatrix3(normalToCm).normalize();
    return { ...f, verts, center, normal, distance: normal.dot(center), inradius: verts[0].clone().add(verts[1]).multiplyScalar(0.5).distanceTo(center) };
  });
  return {
    ...def,
    edgeSteps,
    edgeSides: new Map(edgeSteps.map((o, i) => [stepKey(o), pairs[i]])),
    vertices, // lattice units
    faces, // lattice units
    cmFaces, // the faces in cm, each also with `distance`: its plane's from the centre
    cmVertices: vertices.map((v) => v.clone().applyMatrix3(toCm)),
    dirs,
    dirByName: new Map(dirs.map((d) => [d.name, d])),
    toCm, // Matrix3, lattice units -> cm
    fromCm,
    uniform: !def.squash, // toCm is just a scale
    volumeCm3: def.cellVolume * toCm.determinant(), // the space one cell takes up
  };
}

export const GRIDS = {
  to: defineGrid({
    id: 'to',
    name: 'Truncated Octahedron',
    scale: 1,
    // square faces on the planes x, y, z = ±1; hexagons on |x| + |y| + |z| = 1.5
    vertices: signedPerms([0, 0.5, 1]),
    offsets: [...AXIS_DIRS, ...BODY_DIRS],
    cellVolume: 4, // lattice units³: two cells in every 2-unit cube
    isValid: (x, y, z) => even(x) === even(y) && even(y) === even(z),
    nearest(x, y, z) {
      const e = [x, y, z].map((v) => 2 * Math.round(v / 2));
      const o = [x, y, z].map((v) => 2 * Math.round((v - 1) / 2) + 1);
      return d2(e, x, y, z) <= d2(o, x, y, z) ? e : o;
    },
  }),
  rd: defineGrid({
    id: 'rd',
    name: 'Rhombic Dodecahedron',
    scale: Math.SQRT2,
    // 4-face corners on the axes, 3-face corners at the cube corners
    vertices: [...signedPerms([1, 0, 0]), ...signedPerms([0.5, 0.5, 0.5])],
    offsets: PLANE_DIRS,
    cellVolume: 2, // four cells in every 2-unit cube
    isValid: (x, y, z) => even(x + y + z),
    nearest(x, y, z) {
      const r = [Math.round(x), Math.round(y), Math.round(z)];
      if (!even(r[0] + r[1] + r[2])) {
        // flip the coordinate that rounded furthest to the other side
        const err = [x - r[0], y - r[1], z - r[2]];
        const i = [0, 1, 2].reduce((a, b) => (Math.abs(err[b]) > Math.abs(err[a]) ? b : a));
        r[i] += err[i] >= 0 ? 1 : -1;
      }
      return r;
    },
  }),
  cube: defineGrid({
    id: 'cube',
    name: 'Cube',
    scale: 1,
    vertices: signedPerms([1, 1, 1]),
    offsets: AXIS_DIRS,
    // creatures also step diagonally across a cube's edge (up a step, round a corner): a cube
    // has no face there, so with its 6 faces alone they could only walk along flat ground.
    // Round a block's edge they arc round it (World.edgeVia / arcPoint)
    edgePairs: PLANE_DIRS.map((d) => d.map((v, i) => { const o = [0, 0, 0]; o[i] = 2 * v; return o; }).filter((o) => o.some((v) => v))),
    cellVolume: 8,
    isValid: (x, y, z) => even(x) && even(y) && even(z),
    nearest: (x, y, z) => [x, y, z].map((v) => 2 * Math.round(v / 2)),
  }),
  hex: defineGrid({
    id: 'hex',
    name: 'Hexagonal Prism',
    scale: Math.SQRT2,
    // the hexagons' corners (2,-1,-1)/3 and (-2,1,1)/3 permuted, half a layer above and below
    vertices: [...signedPerms([2 / 3, -1 / 3, -1 / 3])].filter((v) => Math.abs(v[0] + v[1] + v[2]) < 1e-9)
      .flatMap((v) => [0.5, -0.5].map((h) => v.map((c) => c + h))),
    offsets: [...HEX_SIDE_DIRS, [1, 1, 1], [-1, -1, -1]],
    // like a cube, a prism has no face across its edges: creatures step up onto the next layer
    // (or round a column's side) across a side and a cap edge
    edgePairs: HEX_SIDE_DIRS.flatMap((s) => [[s, [1, 1, 1]], [s, [-1, -1, -1]]]),
    squash: { axis: [1, 1, 1], k: Math.sqrt(2 / 3) }, // (as tall as it is wide: see the top of this file)
    iconUp: [1, 1, 1], // (menu icon: the column drawn upright, turned to show three sides)
    iconTwist: 0.4,
    cellVolume: 3, // one cell in every 3 lattice points
    isValid: (x, y, z) => mod3(x + y + z) === 0,
    nearest(x, y, z) {
      // the prisms stack in columns: the nearest layer, then the nearest hexagon in it
      const h = (x + y + z) / 3, m = Math.round(h);
      const p = [x - h, y - h, z - h], r = p.map(Math.round); // (p: in the plane x + y + z = 0)
      const sum = r[0] + r[1] + r[2];
      if (sum) {
        // hex rounding: the coordinate that rounded furthest takes up the difference
        const i = [0, 1, 2].reduce((a, b) => (Math.abs(p[b] - r[b]) > Math.abs(p[a] - r[a]) ? b : a));
        r[i] -= sum;
      }
      return r.map((v) => v + m);
    },
  }),
};

/** Grid modes in menu order. */
export const GRID_IDS = ['to', 'rd', 'cube', 'hex'];
export const DEFAULT_GRID = 'to';
