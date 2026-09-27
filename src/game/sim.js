// Turn-based simulation: runs once per game second ("turn").
// Order each turn: 1) stray (neighbourless) blocks step toward the others, 2) Water flows
// toward the origin, 3) Crawlies move, 4) every 10th turn, Wood grows.
import { NEIGHBOR_DIRS, cellKey } from './lattice.js';
import { CRAWLY_TYPE } from './crawly.js';

/** Block types (ids) a Crawly is willing to crawl next to: Stone, Dirt, Moss. */
export const CRAWLY_HABITAT = new Set(['gray', 'brown', 'green']);
/** Chance that a Crawly decides to move on a given turn (when it has somewhere to go). */
export const CRAWLY_MOVE_CHANCE = 0.5;
/** Duration of a Crawly's step animation, in seconds. */
export const CRAWLY_STEP_SECONDS = 0.25;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Duration of a stray block's step toward the others, in seconds. */
export const STRAY_STEP_SECONDS = 0.25;

function hasNeighbor(world, b) {
  return NEIGHBOR_DIRS.some(([dx, dy, dz]) => world.blocks.has(cellKey(b.x + dx, b.y + dy, b.z + dz)));
}

/**
 * Any block with no neighbours takes one step toward its nearest block: into the empty
 * adjacent cell that is closest (straight-line distance) to that block, ties broken at random.
 * All moves are planned from the start-of-turn layout, then applied in random order
 * (a step whose cell got taken in the meantime is skipped). Returns the set of moved blocks.
 */
export function stepStrays(world) {
  const all = [...world.blocks.values()];
  if (all.length < 2) return new Set();
  const plans = [];
  for (const b of all) {
    if (hasNeighbor(world, b)) continue;
    // nearest other block
    let nearest = null, best = Infinity;
    for (const o of all) {
      if (o === b) continue;
      const d = (o.x - b.x) ** 2 + (o.y - b.y) ** 2 + (o.z - b.z) ** 2;
      if (d < best) {
        best = d;
        nearest = o;
      }
    }
    // the empty neighbouring cell that gets closest to it
    let cells = [], bestD = Infinity;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const x = b.x + dx, y = b.y + dy, z = b.z + dz;
      if (world.blocks.has(cellKey(x, y, z))) continue;
      const d = (nearest.x - x) ** 2 + (nearest.y - y) ** 2 + (nearest.z - z) ** 2;
      if (d < bestD - 1e-9) {
        bestD = d;
        cells = [{ x, y, z }];
      } else if (Math.abs(d - bestD) < 1e-9) cells.push({ x, y, z });
    }
    if (cells.length && bestD < best) plans.push({ b, to: cells[Math.floor(Math.random() * cells.length)] });
  }
  const moved = new Set();
  for (const { b, to } of shuffle(plans)) {
    if (world.move(b, to, STRAY_STEP_SECONDS)) moved.add(b);
  }
  return moved;
}

/** Wood grows on every WOOD_GROW_EVERY-th turn. */
export const WOOD_GROW_EVERY = 10;
/** Chance that a Wood block with room to grow actually grows on a growth turn. */
export const WOOD_GROW_CHANCE = 0.5;
/** At most this many new Wood blocks per growth turn (stops exponential growth). */
export const WOOD_GROW_MAX_PER_TURN = 10;
/** Solid block types (Stone, Dirt, Wood, Berry): Wood only grows into cells away from these. */
export const SOLID_TYPES = new Set(['gray', 'brown', 'green', 'orange', 'red']);

/**
 * Wood growth, on turns that are a multiple of WOOD_GROW_EVERY. Each Wood block that
 * existed at the start of the turn acts once, in random order, seeing growth already
 * made this turn. It looks for empty neighbouring cells that touch no Solid block other
 * than itself; if there are any, it has a WOOD_GROW_CHANCE chance to place Wood in one
 * of them (picked at random). Growth stops for the turn once WOOD_GROW_MAX_PER_TURN
 * blocks have been placed; the random order keeps that fair between Wood blocks.
 * Returns the number of Wood blocks placed.
 */
export function stepWood(world, turn) {
  if (turn % WOOD_GROW_EVERY !== 0) return 0;
  const woods = shuffle([...world.blocks.values()].filter((b) => b.type === 'orange'));
  let grown = 0;
  for (const w of woods) {
    if (grown >= WOOD_GROW_MAX_PER_TURN) break;
    const cells = [];
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const x = w.x + dx, y = w.y + dy, z = w.z + dz;
      if (world.blocks.has(cellKey(x, y, z))) continue; // must be empty
      const crowded = NEIGHBOR_DIRS.some(([ex, ey, ez]) => {
        const n = world.blocks.get(cellKey(x + ex, y + ey, z + ez));
        return n && n !== w && SOLID_TYPES.has(n.type);
      });
      if (!crowded) cells.push({ x, y, z });
    }
    if (!cells.length || Math.random() >= WOOD_GROW_CHANCE) continue;
    const c = cells[Math.floor(Math.random() * cells.length)];
    if (world.add(c.x, c.y, c.z, 'orange')) grown++;
  }
  return grown;
}

/** Duration of a Water block's flow step, in seconds. */
export const WATER_STEP_SECONDS = 0.25;

/**
 * Water flows toward the origin. Water blocks act one at a time, nearest the origin first
 * (ties in random order), each seeing the moves already made this turn, so a front of
 * water advances together. A Water block moves into whichever empty adjacent cell is
 * closest to the origin (ties broken at random), but only if that cell is closer to the
 * origin than the block itself. Blocks in `skip` (already moved this turn) sit still.
 * Returns the set of Water blocks that moved.
 */
export function stepWater(world, skip = new Set()) {
  const dist2 = (p) => p.x * p.x + p.y * p.y + p.z * p.z;
  const waters = shuffle([...world.blocks.values()].filter((b) => b.type === 'blue' && !skip.has(b)));
  waters.sort((a, b) => dist2(a) - dist2(b)); // stable, so equal distances keep the shuffled order
  const moved = new Set();
  for (const w of waters) {
    const here = dist2(w);
    let cells = [], bestD = here;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const c = { x: w.x + dx, y: w.y + dy, z: w.z + dz };
      if (world.blocks.has(cellKey(c.x, c.y, c.z))) continue;
      const d = dist2(c);
      if (d < bestD) {
        bestD = d;
        cells = [c];
      } else if (d === bestD && d < here) cells.push(c);
    }
    if (!cells.length) continue;
    if (world.move(w, cells[Math.floor(Math.random() * cells.length)], WATER_STEP_SECONDS)) moved.add(w);
  }
  return moved;
}

/**
 * Every Crawly may move to an empty adjacent cell (any of its 14 neighbours) that borders
 * at least one Stone, Dirt or Moss block. Crawlies act one at a time in random order, so two
 * Crawlies never end up in the same cell. Crawlies in `skip` (already moved this turn) sit still.
 * Returns the number of Crawlies that moved.
 */
export function stepCrawlies(world, skip = new Set()) {
  const crawlies = shuffle([...world.blocks.values()].filter((b) => b.type === CRAWLY_TYPE && !skip.has(b)));
  let moved = 0;
  for (const c of crawlies) {
    if (Math.random() >= CRAWLY_MOVE_CHANCE) continue;
    const options = [];
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const x = c.x + dx, y = c.y + dy, z = c.z + dz;
      if (world.blocks.has(cellKey(x, y, z))) continue; // must be empty
      const bordersHabitat = NEIGHBOR_DIRS.some(([ex, ey, ez]) => {
        const n = world.blocks.get(cellKey(x + ex, y + ey, z + ez));
        return n && n !== c && CRAWLY_HABITAT.has(n.type);
      });
      if (bordersHabitat) options.push({ x, y, z });
    }
    if (!options.length) continue;
    const to = options[Math.floor(Math.random() * options.length)];
    if (world.move(c, to, CRAWLY_STEP_SECONDS)) moved++;
  }
  return moved;
}
