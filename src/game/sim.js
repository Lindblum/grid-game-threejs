// Turn-based simulation: runs once per game second ("turn").
// Order each turn: 1) connected groups not anchored at the origin fall one step toward it,
// 2) Water flows toward the origin, 3) Crawlies move, 4) trees (Wood groups) drink Water
// and grow Wood or Berries, 5) Dirt absorbs Water and becomes Moss (both only take Water
// that has been still for 2 turns), 6) every 10th turn, a raindrop (Water) appears 1 m
// from the origin.
import { NEIGHBOR_DIRS, cellKey } from './lattice.js';
import { BLOCK } from './tools.js';
import { STEP_SECONDS } from './world.js'; // every move animates over half a turn

/** Block types (ids) a Crawly is willing to crawl next to: Stone, Dirt, Moss. */
export const CRAWLY_HABITAT = new Set([BLOCK.STONE, BLOCK.DIRT, BLOCK.MOSS]);
/** Chance that a Crawly decides to move on a given turn (when it has somewhere to go). */
export const CRAWLY_MOVE_CHANCE = 0.5;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Splits blocks into connected groups (blocks touching through any of the 14 faces).
 * Only blocks passing `include` are grouped, and only through each other.
 */
export function connectedGroups(world, include = () => true) {
  const seen = new Set();
  const groups = [];
  for (const start of world.blocks.values()) {
    if (seen.has(start) || !include(start)) continue;
    seen.add(start);
    const group = [start];
    for (let i = 0; i < group.length; i++) {
      const b = group[i];
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const n = world.blocks.get(cellKey(b.x + dx, b.y + dy, b.z + dz));
        if (n && !seen.has(n) && include(n)) {
          seen.add(n);
          group.push(n);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/** The lattice direction (one of the 14) pointing most nearly along (x, y, z); ties at random. */
function closestDir(x, y, z) {
  const len = Math.hypot(x, y, z);
  let best = [], bestCos = -Infinity;
  for (const d of NEIGHBOR_DIRS) {
    const cos = (d[0] * x + d[1] * y + d[2] * z) / (Math.hypot(...d) * len);
    if (cos > bestCos + 1e-9) {
      bestCos = cos;
      best = [d];
    } else if (Math.abs(cos - bestCos) <= 1e-9) best.push(d);
  }
  return best[Math.floor(Math.random() * best.length)];
}

/**
 * Gravity toward the origin. Blocks are bucketed into connected groups; every group that
 * does not contain the origin cell shifts one step as a whole, in whichever of the 14
 * lattice directions points most nearly at the origin from the group's average centre.
 * Groups move one at a time in random order against the current layout, so a group whose
 * path is blocked (by a group that moved earlier this turn) waits. The group holding the
 * origin block stays put; detached chunks fall onto it and merge. Returns the set of
 * moved blocks.
 */
export function stepGroups(world) {
  const moved = new Set();
  for (const group of shuffle(connectedGroups(world))) {
    if (group.some((b) => b.x === 0 && b.y === 0 && b.z === 0)) continue; // anchored at the origin
    let cx = 0, cy = 0, cz = 0;
    for (const b of group) {
      cx += b.x;
      cy += b.y;
      cz += b.z;
    }
    if (!cx && !cy && !cz) continue; // centred on the origin: no direction to fall
    const [dx, dy, dz] = closestDir(-cx, -cy, -cz);
    const members = new Set(group);
    // every target cell must be empty or vacated by this group (another group may have moved in)
    const blocked = group.some((b) => {
      const n = world.blocks.get(cellKey(b.x + dx, b.y + dy, b.z + dz));
      return n && !members.has(n);
    });
    if (blocked) continue;
    // leading blocks first, so each block's target cell is already free when it moves
    group.sort((a, b) => (b.x * dx + b.y * dy + b.z * dz) - (a.x * dx + a.y * dy + a.z * dz));
    for (const b of group) {
      if (world.move(b, { x: b.x + dx, y: b.y + dy, z: b.z + dz }, STEP_SECONDS, { turnCrawly: false })) moved.add(b);
    }
  }
  return moved;
}

/** Rain: one Water drop every RAIN_EVERY turns, RAIN_RADIUS_CM from the origin (1 m). */
export const RAIN_EVERY = 5;
export const RAIN_RADIUS_CM = 100;

/** The lattice cell (all-even or all-odd coordinates) whose centre is nearest (x, y, z). */
function nearestCell(x, y, z) {
  const even = [x, y, z].map((v) => 2 * Math.round(v / 2));
  const odd = [x, y, z].map((v) => 2 * Math.round((v - 1) / 2) + 1);
  const d2 = (c) => (c[0] - x) ** 2 + (c[1] - y) ** 2 + (c[2] - z) ** 2;
  const [cx, cy, cz] = d2(even) <= d2(odd) ? even : odd;
  return { x: cx, y: cy, z: cz };
}

/**
 * Rain, on turns that are a multiple of RAIN_EVERY: picks a uniformly random point on the
 * sphere of radius RAIN_RADIUS_CM around the origin and puts a Water block in the lattice
 * cell nearest to it (skipped if that cell is already taken). The drop is its own
 * detached group, so stepGroups makes it fall toward the origin on the following turns.
 * Returns the new Water block, or null.
 */
export function stepRain(world, turn) {
  if (turn % RAIN_EVERY !== 0) return null;
  // uniform direction: z uniform in [-1, 1], angle uniform around the z axis
  const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  const c = nearestCell(r * Math.cos(a) * RAIN_RADIUS_CM, r * Math.sin(a) * RAIN_RADIUS_CM, z * RAIN_RADIUS_CM);
  return world.add(c.x, c.y, c.z, BLOCK.WATER) ? world.get(c.x, c.y, c.z) : null;
}

/** Water can only be absorbed (by trees or Dirt) once it has stayed still this many turns. */
export const WATER_SETTLE_TURNS = 2;

/** Water that hasn't moved during the last WATER_SETTLE_TURNS turns (including this one). */
function isSettledWater(b, turn) {
  return b.type === BLOCK.WATER && !(b.movedTurn > turn - WATER_SETTLE_TURNS);
}

/** The block closest to the origin among `blocks` (ties at random). */
function closestToOrigin(blocks) {
  const d2 = (b) => b.x * b.x + b.y * b.y + b.z * b.z;
  const minD = Math.min(...blocks.map(d2));
  const nearest = blocks.filter((b) => d2(b) === minD);
  return nearest[Math.floor(Math.random() * nearest.length)];
}

/** Chance that a Dirt block next to settled Water absorbs it (and turns into Moss) each turn. */
export const DIRT_ABSORB_CHANCE = 1;

/**
 * Dirt next to settled Water (see WATER_SETTLE_TURNS) absorbs it: the Water block is
 * deleted — the one closest to the origin, if several touch — and the Dirt becomes Moss.
 * Dirt blocks act one at a time in random order, so each Water is absorbed only once.
 * Returns the number of Dirt blocks that turned into Moss.
 */
export function stepDirt(world, turn) {
  let changed = 0;
  for (const d of shuffle([...world.blocks.values()].filter((b) => b.type === BLOCK.DIRT))) {
    const waters = [];
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const n = world.blocks.get(cellKey(d.x + dx, d.y + dy, d.z + dz));
      if (n && isSettledWater(n, turn)) waters.push(n);
    }
    if (!waters.length || Math.random() >= DIRT_ABSORB_CHANCE) continue;
    const w = closestToOrigin(waters);
    world.remove(w.x, w.y, w.z);
    if (world.setType(d, BLOCK.MOSS)) changed++;
  }
  return changed;
}

/** Solid block types (Stone, Dirt, Moss, Wood, Berry): Wood only grows into cells away from these. */
export const SOLID_TYPES = new Set([BLOCK.STONE, BLOCK.DIRT, BLOCK.MOSS, BLOCK.WOOD, BLOCK.BERRY]);
/** A tree (connected Wood group) needs at least this many Wood blocks to grow Berries. */
export const BERRY_MIN_TREE_SIZE = 5;
/** Chance that a big-enough tree grows a Berry instead of Wood when watered. */
export const BERRY_CHANCE = 0.4;

/**
 * Tree growth, every turn. Wood blocks are bucketed into connected Wood groups (trees).
 * Each tree (in random order, seeing earlier trees' growth) that touches settled Water
 * (still for WATER_SETTLE_TURNS turns) drinks one such Water block — the one closest to the
 * origin, ties at random — and grows one block into
 * a random cell next to the tree that is empty (or is the drunk Water's cell) and touches
 * exactly one Wood and no other Solid block. The new block is Wood, or, for a tree of at
 * least BERRY_MIN_TREE_SIZE Wood, a Berry with BERRY_CHANCE. A tree with no such cell
 * leaves its Water alone. Returns the number of blocks grown.
 */
export function stepWood(world, turn) {
  let grown = 0;
  for (const tree of shuffle(connectedGroups(world, (b) => b.type === BLOCK.WOOD))) {
    // settled Water touching the group; drink the one closest to the origin
    const waters = new Set();
    for (const w of tree) {
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const n = world.blocks.get(cellKey(w.x + dx, w.y + dy, w.z + dz));
        if (n && isSettledWater(n, turn)) waters.add(n);
      }
    }
    if (!waters.size) continue;
    const drink = closestToOrigin([...waters]);
    const drinkKey = cellKey(drink.x, drink.y, drink.z);

    // growth cells: free (empty, or the Water about to be drunk), next to the group,
    // touching exactly one Solid block, which is Wood
    const cells = new Map();
    for (const w of tree) {
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const x = w.x + dx, y = w.y + dy, z = w.z + dz;
        const k = cellKey(x, y, z);
        if (cells.has(k) || (world.blocks.has(k) && k !== drinkKey)) continue;
        let solids = 0, woods = 0;
        for (const [ex, ey, ez] of NEIGHBOR_DIRS) {
          const n = world.blocks.get(cellKey(x + ex, y + ey, z + ez));
          if (n && SOLID_TYPES.has(n.type)) {
            solids++;
            if (n.type === BLOCK.WOOD) woods++;
          }
        }
        if (solids === 1 && woods === 1) cells.set(k, { x, y, z });
      }
    }
    if (!cells.size) continue;
    const c = [...cells.values()][Math.floor(Math.random() * cells.size)];
    var fruitRand = Math.random();
    const fruit = tree.length >= BERRY_MIN_TREE_SIZE && fruitRand < BERRY_CHANCE;
    world.remove(drink.x, drink.y, drink.z);
    if (world.add(c.x, c.y, c.z, fruit ? BLOCK.BERRY : BLOCK.WOOD)) grown++;
  }
  return grown;
}

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
  const waters = shuffle([...world.blocks.values()].filter((b) => b.type === BLOCK.WATER && !skip.has(b)));
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
    if (world.move(w, cells[Math.floor(Math.random() * cells.length)], STEP_SECONDS)) moved.add(w);
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
  const crawlies = shuffle([...world.blocks.values()].filter((b) => b.type === BLOCK.CRAWLY && !skip.has(b)));
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
    if (world.move(c, to, STEP_SECONDS)) moved++;
  }
  return moved;
}
