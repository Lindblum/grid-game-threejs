// World generation stages: template lines with a `stage` (World.generateNew runs them in order,
// mixed with the older accretion lines, which have a `type` and no `stage`).
//
// The stages build a world the way it is meant to look, rather than growing it outward layer by
// layer: `shape` lines set the ground's outline (balls and tori, with noisy relief; several
// lines make a world of several parts), `spokes` tie a ring to the world inside it, `bodies`
// buries things in it (geodes: a Void hollow lined with Crystal in a Stone shell; boulders),
// `fill` fills the rest of the ground (Dirt), `cover` paints part of the surface (Moss),
// `trees` grows trees on it, `lakes` digs basins and fills them, `pools` lays Water in its hollows, `fauna` puts creatures on it,
// and `shell` wraps it in a layer (Fog). Sizes and distances are in cm, so they mean the same in every grid mode and at any world
// size; counts are absolute.
//
// Everything random goes through Math.random, which generateNew seeds (World.seed): the same
// seed and template give the same world.
import * as THREE from 'three';
import { BLOCK, blockProps, canWalkOn, isChainCreature, isCreature } from './blocks.js';
import { NEIGHBOR_DIRS, cellKey, isValidCell, latticeBox, toCm } from './lattice.js';

/** The stage names, each with the properties its template line may have (besides `stage`). */
export const STAGE_KEYS = {
  shape: ['form', 'radius', 'tube', 'relief', 'reliefSize'],
  bodies: ['count', 'layers', 'lumpiness', 'cover', 'gap'],
  fill: ['type'],
  spokes: ['type', 'count', 'width'],
  cover: ['type', 'on', 'fraction', 'patchSize'],
  trees: ['type', 'on', 'count', 'height', 'branches', 'spacing'],
  pools: ['type', 'count', 'size', 'spacing'],
  lakes: ['type', 'part', 'count', 'radius', 'depth', 'spacing'],
  fauna: ['type', 'count', 'length', 'spacing'],
  shell: ['type', 'thickness'],
};
/** Stage properties that name block types (a type, a list of them, or layers with a `type`): template files may write them as names (world.js templateType). */
export const STAGE_TYPE_KEYS = ['type', 'on', 'layers'];

/** A seeded random number generator (mulberry32): returns a function giving 0 ≤ x < 1. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 3D Perlin noise (about −1..1) with its permutation shuffled by `random`. */
export function makeNoise3(random = Math.random) {
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const G = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
  const grad = (h, x, y, z) => {
    const g = G[h % 12];
    return g[0] * x + g[1] * y + g[2] * z;
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  return (x, y, z) => {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = perm[xi] + yi, AA = perm[A] + zi, AB = perm[A + 1] + zi;
    const B = perm[xi + 1] + yi, BA = perm[B] + zi, BB = perm[B + 1] + zi;
    return lerp(
      lerp(lerp(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u), lerp(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u), v),
      lerp(lerp(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u), lerp(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u), v),
      w
    );
  };
}

/** Three octaves of `noise`, about −1..1. */
function fbm(noise, x, y, z) {
  return (noise(x, y, z) + 0.5 * noise(x * 2 + 5.3, y * 2 + 1.7, z * 2 + 9.1) + 0.25 * noise(x * 4 + 2.9, y * 4 + 7.7, z * 4 + 3.3)) / 1.75 * 1.6;
}

/** A value from a number or a [min, max] range (picked at random). */
const pick = (v) => (Array.isArray(v) ? v[0] + Math.random() * (v[1] - v[0]) : v);
const pickInt = (v) => Math.round(pick(v));
const cm = (b) => toCm(b.x, b.y, b.z, new THREE.Vector3());

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** The generation's state, shared by its stages: the noise, the ground's shape, its cells, the bodies buried so far. */
export function newGenContext() {
  return { noise: makeNoise3(Math.random), parts: [], shape: null, ground: null, bodies: [] };
}

/** The ground's shape: its parts (the `shape` lines; the default ball if no line gave one) together. */
function shapeOf(ctx) {
  if (!ctx.parts.length) STAGES.shape(null, {}, ctx);
  return ctx.shape;
}

/**
 * Several parts as one shape: a point belongs to the part it lies deepest in (or, outside them
 * all, the one whose surface is nearest), and takes its height and "up" from it.
 */
function combine(parts) {
  if (parts.length === 1) return parts[0];
  const partAt = (p) => {
    let best = parts[0], bestDepth = -Infinity;
    for (const s of parts) {
      const d = s.depth(p);
      if (d > bestDepth) {
        bestDepth = d;
        best = s;
      }
    }
    return best;
  };
  const extent = new THREE.Vector3();
  for (const s of parts) extent.max(s.extent);
  return {
    parts, extent,
    height: (p) => partAt(p).height(p),
    up: (p) => partAt(p).up(p),
    depth: (p) => parts.reduce((m, s) => Math.max(m, s.depth(p)), -Infinity),
  };
}

/**
 * Every cell of the ground (inside its shape: every valid cell of its bounding box with a depth
 * of 0 or more), with its position (cm) and depth below the surface (cm).
 */
function groundCells(ctx) {
  if (ctx.ground) return ctx.ground;
  const shape = shapeOf(ctx);
  const e = shape.extent;
  const { lo, hi } = latticeBox(new THREE.Vector3(-e.x, -e.y, -e.z), e);
  const out = [];
  for (let x = lo[0]; x <= hi[0]; x++) {
    for (let y = lo[1]; y <= hi[1]; y++) {
      for (let z = lo[2]; z <= hi[2]; z++) {
        if (!isValidCell(x, y, z)) continue;
        const p = toCm(x, y, z, new THREE.Vector3());
        const depth = shape.depth(p);
        if (depth >= 0) out.push({ x, y, z, p, depth });
      }
    }
  }
  return (ctx.ground = out);
}

/** Height (cm) of cell (x, y, z) above the shape's core (shape.height). */
const heightOf = (shape, x, y, z) => shape.height(toCm(x, y, z, new THREE.Vector3()));

/** Blocks of the `on` types with an empty neighbouring cell higher than they are (further from the shape's core): the ground's open top. */
function surfaceBlocks(world, shape, on) {
  const out = [];
  for (const type of on) {
    for (const b of world.ofType(type)) {
      const h = heightOf(shape, b.x, b.y, b.z);
      if (NEIGHBOR_DIRS.some(([dx, dy, dz]) => !world.has(b.x + dx, b.y + dy, b.z + dz) && isValidCell(b.x + dx, b.y + dy, b.z + dz) && heightOf(shape, b.x + dx, b.y + dy, b.z + dz) > h)) out.push(b);
    }
  }
  return out;
}

/** Empty cells next to a block that isn't Fog or Nimbus: where things can rest on the world. Each: { x, y, z, h (its height above the shape's core, cm) }. */
function openCells(world, shape) {
  const out = new Map();
  for (const b of world.blocks.values()) {
    if (b.type === BLOCK.FOG || b.type === BLOCK.NIMBUS || b.type === BLOCK.VOID) continue;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const x = b.x + dx, y = b.y + dy, z = b.z + dz, k = cellKey(x, y, z);
      if (out.has(k) || world.has(x, y, z) || !isValidCell(x, y, z)) continue;
      out.set(k, { x, y, z, h: heightOf(shape, x, y, z) });
    }
  }
  return out;
}

/** The empty neighbouring cell of block `b` most nearly straight up from it (shape.up), or null. */
function upCell(world, shape, b) {
  const p = toCm(b.x, b.y, b.z, new THREE.Vector3()), up = shape.up(p);
  let best = null, bestDot = 0;
  for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
    const x = b.x + dx, y = b.y + dy, z = b.z + dz;
    if (world.has(x, y, z) || !isValidCell(x, y, z)) continue;
    const d = toCm(x, y, z, new THREE.Vector3()).sub(p).normalize().dot(up);
    if (d > bestDot + 1e-9 || (Math.abs(d - bestDot) <= 1e-9 && Math.random() < 0.5)) {
      bestDot = d;
      best = [x, y, z];
    }
  }
  return best;
}

/** Whether point `p` (cm) is at least `spacing` cm from every point of `taken`. */
const clearOf = (p, taken, spacing) => taken.every((q) => q.distanceToSquared(p) >= spacing * spacing);

export const STAGES = {
  /**
   * A part of the ground's outline (adds nothing; each line adds a part, e.g. a ball with a
   * ring around it). `form`:
   *  - "ball" (default): a ball of `radius` cm (default 16)
   *  - "torus": a ring `radius` cm from the origin to the middle of its tube (default 28), the
   *    tube `tube` cm thick from its core to its surface (default 12), lying flat (around +y)
   * Its surface rises and falls by up to about `relief` cm (default 3), in hills `reliefSize` cm
   * across (default 9). Heights and depths are measured from the shape's core (the ball's centre;
   * the torus's core circle), and "up" is away from it: the stages use those, not the origin.
   * (The game's own rules still pull everything toward the origin.)
   */
  shape(world, { form = 'ball', radius = form === 'torus' ? 28 : 16, tube = 12, relief = 3, reliefSize = 9 }, ctx) {
    const noise = ctx.noise;
    const torus = form === 'torus';
    if (!torus && form !== 'ball') console.warn(`World generation: unknown shape form "${form}", using "ball"`);
    const thick = torus ? tube : radius; // (core to surface)
    /** The nearest point of the shape's core to point `p` (cm), into `out`. */
    const core = (p, out) => {
      if (!torus) return out.set(0, 0, 0);
      const r = Math.hypot(p.x, p.z);
      return r < 1e-6 ? out.set(radius, 0, 0) : out.set((p.x / r) * radius, 0, (p.z / r) * radius);
    };
    const _c = new THREE.Vector3(), _d = new THREE.Vector3();
    const reach = (torus ? radius + tube : radius) + relief * 1.6; // (fbm stays within ±1.6)
    const part = {
      form, radius, tube: torus ? tube : null, relief,
      /** Half the size of a box (cm, around the origin) that holds all of the ground. */
      extent: new THREE.Vector3(reach, torus ? tube + relief * 1.6 : reach, reach),
      /** How high point `p` (cm) is above the shape's core (cm). */
      height(p) {
        return p.distanceTo(core(p, _c));
      },
      /** The way up at point `p`: away from the core (a unit vector). */
      up(p) {
        const d = _d.copy(p).sub(core(p, _c));
        return d.lengthSq() > 1e-12 ? d.normalize().clone() : new THREE.Vector3(0, 1, 0);
      },
      /** The surface's height (cm above the core) over point `p` (cm). */
      surfaceAt(p) {
        core(p, _c);
        const d = _d.copy(p).sub(_c);
        const len = d.length();
        if (len < 1e-6) return thick;
        // (sampled on the nominal surface: the same bump at any depth)
        d.multiplyScalar(thick / len).add(_c).multiplyScalar(1 / reliefSize);
        return thick + relief * fbm(noise, d.x + 17.1, d.y + 3.7, d.z + 9.2);
      },
      /** How deep point `p` (cm) is below the surface (cm; negative above it). */
      depth(p) {
        return this.surfaceAt(p) - this.height(p);
      },
    };
    ctx.parts.push(part);
    ctx.shape = combine(ctx.parts);
    ctx.ground = null;
    return [];
  },

  /**
   * Ties each ring (torus part) to the world inside it: `count` straight spokes of `type`
   * (default Stone, 4 of them, evenly spaced) `width` cm thick (default 4), from the origin out
   * to the ring's core, filling only empty cells: the stretch between the parts. (One connected
   * world: the game lets only its largest piece stay put, and pulls the rest to the origin.)
   */
  spokes(world, { type = BLOCK.STONE, count = 4, width = 4 }, ctx) {
    const made = [];
    shapeOf(ctx);
    for (const ring of ctx.parts.filter((s) => s.form === 'torus')) {
      const turn = Math.random() * Math.PI * 2;
      const ends = Array.from({ length: count }, (_, i) => {
        const a = turn + (i / count) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * ring.radius, 0, Math.sin(a) * ring.radius);
      });
      const r = width / 2, e = ring.radius + r;
      const { lo, hi } = latticeBox(new THREE.Vector3(-e, -r, -e), new THREE.Vector3(e, r, e));
      const q = new THREE.Vector3();
      for (let x = lo[0]; x <= hi[0]; x++) {
        for (let y = lo[1]; y <= hi[1]; y++) {
          for (let z = lo[2]; z <= hi[2]; z++) {
            if (!isValidCell(x, y, z) || world.has(x, y, z)) continue;
            const p = toCm(x, y, z, new THREE.Vector3());
            // near one of the segments origin → end
            const near = ends.some((end) => {
              const t = Math.min(1, Math.max(0, p.dot(end) / end.lengthSq()));
              return q.copy(end).multiplyScalar(t).distanceToSquared(p) <= r * r;
            });
            if (near && world.add(x, y, z, type)) made.push(world.get(x, y, z));
          }
        }
      }
    }
    return made;
  },

  /**
   * Buries `count` bodies in the ground, each made of `layers` from the inside out
   * ({ type, size }: the first one's size is the core's radius, the others' their shells'
   * thickness, cm; a [min, max] size is picked for each body), e.g. a geode: a Void hollow,
   * then Crystal, then Stone. Their outlines are warped by `lumpiness` (0 = round). Each lies
   * at least `cover` cm under the surface and `gap` cm from the bodies already buried; bodies
   * that don't fit are left out. Takes only empty cells.
   */
  bodies(world, { count = 1, layers = [{ type: BLOCK.STONE, size: [2, 4] }], lumpiness = 0.3, cover = 3, gap = 1 }, ctx) {
    const shape = shapeOf(ctx), ground = groundCells(ctx), noise = ctx.noise;
    const made = [];
    let placed = 0;
    for (let n = 0; n < count; n++) {
      const sizes = layers.map((l) => Math.max(0, pick(l.size)));
      const outer = sizes.reduce((a, b) => a + b, 0) * (1 + 0.7 * lumpiness); // (Perlin noise seldom passes ±0.7)
      // where: of up to 24 random points that fit (the top `cover` under the surface above it,
      // `gap` clear of the other bodies), the one furthest from them, so bodies spread out and
      // more of them fit
      let c = null, best = -Infinity;
      const e = shape.extent;
      for (let t = 0, found = 0; t < 5000 && found < 24; t++) {
        const v = new THREE.Vector3((Math.random() * 2 - 1) * e.x, (Math.random() * 2 - 1) * e.y, (Math.random() * 2 - 1) * e.z);
        if (shape.depth(v) < 0) continue;
        const top = v.clone().addScaledVector(shape.up(v), outer);
        if (shape.depth(top) < cover) continue;
        const room = ctx.bodies.reduce((m, b) => Math.min(m, b.c.distanceTo(v) - b.r - outer), Infinity);
        if (room < gap) continue;
        found++;
        if (room > best) {
          best = room;
          c = v;
        }
      }
      if (!c) continue;
      ctx.bodies.push({ c, r: outer });
      placed++;
      const o = n * 7.31 + 3.1; // (each body's lumps its own)
      for (const g of ground) {
        const dist = g.p.distanceTo(c);
        if (dist > outer + 2 || world.has(g.x, g.y, g.z)) continue;
        const warped = dist / (1 + lumpiness * noise(g.p.x * 0.45 + o, g.p.y * 0.45 + o, g.p.z * 0.45 - o));
        let edge = 0;
        for (let i = 0; i < layers.length; i++) {
          edge += sizes[i];
          if (warped >= edge) continue;
          if (world.add(g.x, g.y, g.z, layers[i].type)) made.push(world.get(g.x, g.y, g.z));
          break;
        }
      }
    }
    if (placed < count) console.warn(`World generation: only ${placed} of ${count} bodies fit`);
    return made;
  },

  /** Fills every empty cell of the ground with `type` (default Dirt): it covers what's buried there. */
  fill(world, { type = BLOCK.DIRT }, ctx) {
    const made = [];
    for (const g of groundCells(ctx)) if (!world.has(g.x, g.y, g.z) && world.add(g.x, g.y, g.z, type)) made.push(world.get(g.x, g.y, g.z));
    return made;
  },

  /**
   * Turns `fraction` (default 0.5) of the open surface blocks of the `on` types (default Dirt)
   * into `type` (default Moss), in patches about `patchSize` cm across (default 5).
   */
  cover(world, { type = BLOCK.MOSS, on = [BLOCK.DIRT], fraction = 0.5, patchSize = 5 }, ctx) {
    const noise = ctx.noise, s = 1 / patchSize;
    const surface = surfaceBlocks(world, shapeOf(ctx), on).map((b) => {
      const p = cm(b);
      return { b, v: fbm(noise, p.x * s + 41.7, p.y * s - 12.3, p.z * s + 27.9) };
    });
    surface.sort((a, b) => b.v - a.v); // the patches: highest noise first
    const made = [];
    for (const { b } of surface.slice(0, Math.round(surface.length * fraction))) if (world.setType(b, type)) made.push(b);
    return made;
  },

  /**
   * Grows `count` trees of `type` (default Wood) on open surface blocks of the `on` types
   * (default Dirt and Moss), at least `spacing` cm apart (default 6): a trunk `height` blocks
   * tall growing straight up (shape.up), then `branches` blocks branching off it
   * (World._treeCell: never touching the ground or each other).
   */
  trees(world, { type = BLOCK.WOOD, on = [BLOCK.DIRT, BLOCK.MOSS], count = 6, height = [3, 6], branches = [4, 10], leaves = [6, 14], spacing = 6 }, ctx) {
    const shape = shapeOf(ctx);
    const made = [], sites = [];
    for (const s of shuffle(surfaceBlocks(world, shape, on))) {
      if (sites.length >= count) break;
      const p = cm(s);
      if (!clearOf(p, sites, spacing)) continue;
      const tree = [];
      const grow = (c) => {
        if (!c || !world.add(...c, type)) return false;
        tree.push(world.get(...c));
        return true;
      };
      if (!grow(upCell(world, shape, s))) continue;
      const h = pickInt(height), b = pickInt(branches);
      for (let i = 1; i < h && grow(upCell(world, shape, tree[tree.length - 1])); i++);
      for (let i = 0; i < b && grow(world._treeCell(tree)); i++);
      // Leaves: in empty cells next to its Wood, the higher ones first (a crown)
      const free = new Map();
      for (const w of tree) {
        for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
          const c = [w.x + dx, w.y + dy, w.z + dz];
          const k = c.join();
          if (!free.has(k) && !world.has(...c) && isValidCell(...c)) free.set(k, { c, h: shape.height(toCm(...c, new THREE.Vector3())) + Math.random() * 2 });
        }
      }
      const crown = [...free.values()].sort((a, c) => c.h - a.h).slice(0, pickInt(leaves));
      for (const { c } of crown) if (world.add(...c, BLOCK.LEAVES)) tree.push(world.get(...c));
      sites.push(p);
      made.push(...tree);
    }
    if (sites.length < count) console.warn(`World generation: only ${sites.length} of ${count} trees fit`);
    return made;
  },

  /**
   * Lays `count` pools of `type` (default Water), `size` blocks each, in the world's lowest
   * open spots (nearest the shape's core), at least `spacing` cm apart: each fills its hollow
   * from the bottom up. (Water still flows where it can once play starts.)
   */
  /**
   * Digs `count` lakes into one part of the ground (`part`: its place among the `shape` lines,
   * default 0, the first: the inner world) and fills them with `type` (default Water): each a
   * bowl `radius` cm across the middle (default 5–9) and `depth` cm deep there (default
   * 1.5–3), sunk into one of the part's lowest open spots (nearest its core), at least
   * `spacing` cm apart (default 14). Anything but creatures in the bowl, below the ground's
   * level at the lake's middle, is dug out and becomes the lake; above that level, within the
   * radius, it's dug out and left open, so the lake lies in a little valley. Run it before
   * `cover` and `trees` (they keep to dry land then).
   */
  lakes(world, { type = BLOCK.WATER, part = 0, count = 3, radius = [5, 9], depth = [1.5, 3], spacing = 14 }, ctx) {
    shapeOf(ctx);
    const shape = ctx.parts[part] ?? ctx.parts[0];
    const own = (p) => ctx.parts.every((s) => s === shape || s.depth(p) <= shape.depth(p)); // (a point of this part: deepest in it)
    // the part's open top: blocks with an empty neighbour higher than them, lowest first (shuffled among equals)
    const tops = [];
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    for (const b of world.blocks.values()) {
      if (isCreature(b.type) || b.type === BLOCK.VOID) continue;
      toCm(b.x, b.y, b.z, p);
      if (!own(p)) continue;
      const h = shape.height(p);
      if (NEIGHBOR_DIRS.some(([dx, dy, dz]) => !world.has(b.x + dx, b.y + dy, b.z + dz) && isValidCell(b.x + dx, b.y + dy, b.z + dz)
        && shape.height(toCm(b.x + dx, b.y + dy, b.z + dz, q)) > h)) tops.push({ b, p: p.clone(), h });
    }
    shuffle(tops).sort((a, c) => a.h - c.h);
    const made = [], sites = [];
    for (const top of tops) {
      if (sites.length >= count) break;
      if (!clearOf(top.p, sites, spacing)) continue;
      sites.push(top.p);
      const r = pick(radius), d = pick(depth), up = shape.up(top.p), level = top.h;
      // the bowl: within r of the middle across the ground, and down to d × (1 - (across / r)²) below its level
      const reach = r + d + 2;
      const { lo, hi } = latticeBox(top.p.clone().subScalar(reach), top.p.clone().addScalar(reach));
      for (let x = lo[0]; x <= hi[0]; x++) {
        for (let y = lo[1]; y <= hi[1]; y++) {
          for (let z = lo[2]; z <= hi[2]; z++) {
            if (!isValidCell(x, y, z)) continue;
            const c = toCm(x, y, z, q);
            const h = shape.height(c);
            const off = c.clone().sub(top.p);
            const across = off.clone().addScaledVector(up, -off.dot(up)).length();
            if (across > r) continue;
            const old = world.get(x, y, z);
            if (old && (isCreature(old.type) || old.type === type || old.type === BLOCK.VOID)) continue; // (not into a geode's hollow)
            if (h > level + 0.01) {
              // above the lake's level: dug out, so the lake lies open in a little valley
              if (old) world.remove(x, y, z);
              continue;
            }
            if (level - h > d * (1 - (across / r) ** 2)) continue; // (below the bowl: left as it is)
            if (old) world.remove(x, y, z);
            if (world.add(x, y, z, type)) made.push(world.get(x, y, z));
          }
        }
      }
    }
    if (sites.length < count) console.warn(`World generation: only ${sites.length} of ${count} lakes fit`);
    return made;
  },

  pools(world, { type = BLOCK.WATER, count = 3, size = [15, 35], spacing = 10 }, ctx) {
    const shape = shapeOf(ctx);
    const open = openCells(world, shape);
    const byDepth = [...open.values()].sort((a, b) => a.h - b.h);
    const made = [], seeds = [];
    for (const seed of byDepth) {
      if (seeds.length >= count) break;
      const p = toCm(seed.x, seed.y, seed.z, new THREE.Vector3());
      if (world.has(seed.x, seed.y, seed.z) || !clearOf(p, seeds, spacing)) continue;
      seeds.push(p);
      // flood: always the lowest open cell next to the pool
      const want = pickInt(size), frontier = new Map([[cellKey(seed.x, seed.y, seed.z), seed]]);
      for (let n = 0; n < want && frontier.size; n++) {
        let low = null;
        for (const c of frontier.values()) if (!low || c.h < low.h) low = c;
        frontier.delete(cellKey(low.x, low.y, low.z));
        if (world.has(low.x, low.y, low.z) || !world.add(low.x, low.y, low.z, type)) continue;
        made.push(world.get(low.x, low.y, low.z));
        // (any empty cell next to the pool: it rises once its hollow's floor is covered)
        for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
          const x = low.x + dx, y = low.y + dy, z = low.z + dz, k = cellKey(x, y, z);
          if (!frontier.has(k) && !world.has(x, y, z) && isValidCell(x, y, z)) frontier.set(k, { x, y, z, h: heightOf(shape, x, y, z) });
        }
      }
    }
    return made;
  },

  /**
   * Puts `count` creatures of `type` on the world, in open cells next to blocks they can walk
   * on (a flyer: any open cell), at least `spacing` cm from every creature placed so far
   * (default 4). A chain creature (Squirmy, Slither) is laid out `length` blocks long along
   * the ground.
   */
  fauna(world, { type = BLOCK.CRAWLY, count = 5, length = [3, 5], spacing = 4 }, ctx) {
    const flies = !!blockProps(type).fly;
    const open = openCells(world, shapeOf(ctx));
    const fits = (c) => flies || NEIGHBOR_DIRS.some(([dx, dy, dz]) => {
      const n = world.get(c.x + dx, c.y + dy, c.z + dz);
      return n && canWalkOn(type, n.type);
    });
    const placed = (ctx.creatures ??= []);
    const made = [];
    let n = 0;
    for (const c of shuffle([...open.values()])) {
      if (n >= count) break;
      const p = toCm(c.x, c.y, c.z, new THREE.Vector3());
      if (world.has(c.x, c.y, c.z) || !fits(c) || !clearOf(p, placed, spacing)) continue;
      const body = [c];
      if (isChainCreature(type)) {
        // a winding line along the ground, never touching itself
        const len = pickInt(length);
        while (body.length < len) {
          const last = body[body.length - 1];
          const next = shuffle(NEIGHBOR_DIRS.map(([dx, dy, dz]) => open.get(cellKey(last.x + dx, last.y + dy, last.z + dz))).filter(Boolean))
            .find((s) => !world.has(s.x, s.y, s.z) && fits(s) && !body.includes(s)
              && body.every((b) => b === last || !NEIGHBOR_DIRS.some(([dx, dy, dz]) => b.x === s.x + dx && b.y === s.y + dy && b.z === s.z + dz)));
          if (!next) break;
          body.push(next);
        }
        if (body.length < 2) continue;
      }
      for (const b of body) {
        if (!world.add(b.x, b.y, b.z, type)) continue;
        made.push(world.get(b.x, b.y, b.z));
        placed.push(toCm(b.x, b.y, b.z, new THREE.Vector3()));
      }
      n++;
    }
    if (n < count) console.warn(`World generation: only ${n} of ${count} ${blockProps(type).name} fit`);
    return made;
  },

  /**
   * Wraps the world in a layer of `type` (default Fog): every empty cell within `thickness` cm
   * (default 4) of a block that isn't Fog or Nimbus (measured to the nearest one found by a
   * spreading search), so it follows any shape in any grid mode. Void counts as a block, so
   * a geode's hollow stays empty.
   */
  shell(world, { type = BLOCK.FOG, thickness = 4 }) {
    const src = new Map(); // cell key -> the block it is nearest
    let frontier = [];
    const pos = (c) => toCm(c.x, c.y, c.z, new THREE.Vector3());
    for (const b of world.blocks.values()) if (b.type !== BLOCK.FOG && b.type !== BLOCK.NIMBUS) frontier.push({ x: b.x, y: b.y, z: b.z, from: pos(b) });
    const cells = [];
    while (frontier.length) {
      const next = [];
      for (const c of frontier) {
        for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
          const x = c.x + dx, y = c.y + dy, z = c.z + dz, k = cellKey(x, y, z);
          if (src.has(k) || world.has(x, y, z) || !isValidCell(x, y, z)) continue;
          const p = toCm(x, y, z, new THREE.Vector3());
          if (p.distanceTo(c.from) > thickness + 1e-6) continue;
          src.set(k, c.from);
          cells.push([x, y, z]);
          next.push({ x, y, z, from: c.from });
        }
      }
      frontier = next;
    }
    const made = [];
    for (const c of cells) if (world.add(...c, type)) made.push(world.get(...c));
    return made;
  },
};
