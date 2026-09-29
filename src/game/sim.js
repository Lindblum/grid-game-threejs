// Turn-based simulation: runs once per game second ("turn").
// Order each turn: 1) connected groups not anchored at the origin fall one step toward it,
// 2) Water flows toward the origin, 3) Crawlies move, 4) trees (Wood groups) drink Water
// and grow Wood or Berries, 5) Dirt absorbs Water and becomes Moss (both only take Water
// that has been still for 2 turns), 6) every 10th turn, a raindrop (Water) appears 1 m
// from the origin, 7) non-creature blocks are bucketed into same-type groups.
import { NEIGHBOR_DIRS, cellKey } from './lattice.js';
import { BLOCK, isCreature } from './tools.js';
import { CRAWLY_BEHAVIOR, DEFAULT_CRAWLY_BEHAVIOR } from './crawly.js';
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
 * Only blocks passing `include` are grouped, and a block only joins through a neighbour
 * `b` it is `linked(b, n)` to (e.g. same type); by default any two included blocks link.
 */
export function connectedGroups(world, include = () => true, linked = () => true) {
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
        if (n && !seen.has(n) && include(n) && linked(b, n)) {
          seen.add(n);
          group.push(n);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * End-of-turn bookkeeping: buckets every non-creature block into groups of connected
 * blocks of the same type (like trees are connected Wood). Stored on the world for later
 * rules to use:
 *   world.blockGroups — array of { type, blocks }
 *   world.groupOf     — Map block -> its { type, blocks } group
 * Creatures (see CREATURE_TYPES) are left out. Returns world.blockGroups.
 */
export function updateBlockGroups(world) {
  const groups = connectedGroups(world, (b) => !isCreature(b.type), (a, b) => a.type === b.type)
    .map((blocks) => ({ type: blocks[0].type, blocks }));
  const groupOf = new Map();
  for (const g of groups) for (const b of g.blocks) groupOf.set(b, g);
  world.blockGroups = groups;
  world.groupOf = groupOf;
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
export const RAIN_RADIUS_CM = 50;

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
    if (world.add(c.x, c.y, c.z, fruit ? BLOCK.BERRY : BLOCK.WOOD)) {
      grown++;
      if (fruit) world.emit('berryGrow', world.get(c.x, c.y, c.z));
    }
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
 * True when a Crawly (`self`) could stand in cell (x, y, z): the cell is empty (or holds
 * `self`) and touches at least one block of its habitat (Stone, Dirt, Moss).
 */
export function isWalkable(world, x, y, z, self = null) {
  const here = world.blocks.get(cellKey(x, y, z));
  if (here && here !== self) return false;
  return NEIGHBOR_DIRS.some(([ex, ey, ez]) => {
    const n = world.blocks.get(cellKey(x + ex, y + ey, z + ez));
    return n && n !== self && CRAWLY_HABITAT.has(n.type);
  });
}

/**
 * Wander: with CRAWLY_MOVE_CHANCE the Crawly steps to a random walkable adjacent cell
 * (any of its 14 neighbours). Returns whether it moved.
 */
function wander(world, c) {
  if (Math.random() >= CRAWLY_MOVE_CHANCE) return false;
  const options = [];
  for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
    const x = c.x + dx, y = c.y + dy, z = c.z + dz;
    if (isWalkable(world, x, y, z, c)) options.push({ x, y, z });
  }
  if (!options.length) return false;
  const to = options[Math.floor(Math.random() * options.length)];
  return world.move(c, to, STEP_SECONDS);
}

/** Most cells one Walk path search may visit (keeps a turn cheap in big builds). */
const WALK_SEARCH_LIMIT = 5000;
/** A walking Crawly that finds no path this many turns in a row gives up and Wanders. */
export const WALK_GIVE_UP_TURNS = 5;

/**
 * First step of a shortest path (fewest steps, through walkable cells) from Crawly `c`
 * to cell `t`, found by breadth-first search; null if there is none.
 */
function firstStepToward(world, c, t) {
  if (!isWalkable(world, t.x, t.y, t.z, c)) return null;
  const goal = cellKey(t.x, t.y, t.z);
  const firstStep = new Map([[cellKey(c.x, c.y, c.z), null]]); // visited cell -> first step on its path
  const queue = [{ x: c.x, y: c.y, z: c.z }];
  for (let i = 0; i < queue.length && firstStep.size < WALK_SEARCH_LIMIT; i++) {
    const p = queue[i];
    const via = firstStep.get(cellKey(p.x, p.y, p.z));
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
      const k = cellKey(q.x, q.y, q.z);
      if (firstStep.has(k) || !isWalkable(world, q.x, q.y, q.z, c)) continue;
      const first = via ?? q; // cells next to the start are their own first step
      if (k === goal) return first;
      firstStep.set(k, first);
      queue.push(q);
    }
  }
  return null;
}

/**
 * Walk: take the next step of the shortest path to `c.walkTarget`. On arrival the Crawly
 * goes back to Wander. If no path exists (blocked, or the target stopped being walkable)
 * it waits, and gives up (back to Wander) after WALK_GIVE_UP_TURNS such turns in a row.
 * Returns whether it moved.
 */
function walk(world, c) {
  const t = c.walkTarget;
  const arrived = () => t && c.x === t.x && c.y === t.y && c.z === t.z;
  const stop = () => {
    c.behavior = CRAWLY_BEHAVIOR.WANDER;
    delete c.walkTarget;
    delete c.walkStuck;
  };
  if (!t || arrived()) {
    stop();
    return false;
  }
  const next = firstStepToward(world, c, t);
  if (!next) {
    c.walkStuck = (c.walkStuck || 0) + 1;
    if (c.walkStuck >= WALK_GIVE_UP_TURNS) stop();
    return false;
  }
  c.walkStuck = 0;
  const moved = world.move(c, next, STEP_SECONDS);
  if (arrived()) {
    stop();
    world.emit('crawlyArrived', c);
  }
  return moved;
}

/** A Crawly trapped for this many turns in a row dies. */
export const CRAWLY_TRAPPED_DEATH_TURNS = 15;

/** Every neighbouring cell holds a non-creature block (another creature isn't a wall: it can move away). */
function isWalledIn(world, c) {
  return NEIGHBOR_DIRS.every(([dx, dy, dz]) => {
    const n = world.blocks.get(cellKey(c.x + dx, c.y + dy, c.z + dz));
    return n && !isCreature(n.type);
  });
}

/**
 * Trapped bookkeeping, at the start of a Crawly's turn. A Crawly walled in by non-creature
 * blocks switches to Trapped (dropping any walk target; event 'crawlyTrapped'). A Trapped
 * Crawly that has an empty neighbouring cell goes back to Wander ('crawlyFreed'); otherwise
 * it counts the turn, and on the CRAWLY_TRAPPED_DEATH_TURNS-th trapped turn it dies: its
 * block is removed ('crawlyDied', with its last position). Returns true when the Crawly is
 * free to act this turn.
 */
function checkTrapped(world, c) {
  if (c.behavior === CRAWLY_BEHAVIOR.TRAPPED) {
    const hasGap = NEIGHBOR_DIRS.some(([dx, dy, dz]) => !world.blocks.has(cellKey(c.x + dx, c.y + dy, c.z + dz)));
    if (hasGap) {
      c.behavior = CRAWLY_BEHAVIOR.WANDER;
      delete c.trappedTurns;
      world.emit('crawlyFreed', c);
      return true;
    }
    c.trappedTurns = (c.trappedTurns || 0) + 1;
    if (c.trappedTurns >= CRAWLY_TRAPPED_DEATH_TURNS) {
      const at = { x: c.x, y: c.y, z: c.z };
      world.remove(c.x, c.y, c.z);
      world.emit('crawlyDied', { crawly: c, ...at });
    }
    return false;
  }
  if (isWalledIn(world, c)) {
    c.behavior = CRAWLY_BEHAVIOR.TRAPPED;
    c.trappedTurns = 1; // this turn counts
    delete c.walkTarget;
    delete c.walkStuck;
    world.emit('crawlyTrapped', c);
    return false;
  }
  return true;
}

/**
 * Each Crawly takes its turn according to its `behavior` (see CRAWLY_BEHAVIOR):
 * Wander = random steps along its habitat, Wait = stays put, Walk = heads for its
 * `walkTarget` along the shortest path, Trapped = nothing (see checkTrapped, which runs
 * first for every Crawly). Crawlies act one at a time in random order, so two Crawlies
 * never end up in the same cell. Crawlies in `skip` (already moved this turn) don't move.
 * Returns the number of Crawlies that moved.
 */
export function stepCrawlies(world, skip = new Set()) {
  const crawlies = shuffle([...world.blocks.values()].filter((b) => b.type === BLOCK.CRAWLY));
  let moved = 0;
  for (const c of crawlies) {
    // being trapped is checked for every Crawly, even one that fell with its group this turn
    if (!checkTrapped(world, c)) continue; // trapped (or just died): no action this turn
    if (skip.has(c)) continue;
    switch (c.behavior ?? DEFAULT_CRAWLY_BEHAVIOR) {
      case CRAWLY_BEHAVIOR.WANDER:
        if (wander(world, c)) moved++;
        break;
      case CRAWLY_BEHAVIOR.WAIT:
        break; // stays where it is
      case CRAWLY_BEHAVIOR.WALK:
        if (walk(world, c)) moved++;
        break;
    }
  }
  return moved;
}
