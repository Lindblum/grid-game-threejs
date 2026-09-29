// Turn-based simulation: runs once per game second ("turn").
// Order each turn: 1) connected groups not anchored at the origin fall one step toward it,
// 2) Water flows toward the origin, 3) Crawlies move, 4) trees (Wood groups) drink Water
// and grow Wood or Berries, 5) Dirt absorbs Water and becomes Moss (both only take Water
// that has been still for 2 turns), 6) every 10th turn, a raindrop (Water) appears 1 m
// from the origin, 7) every 3rd turn, each Nimbus may rain a Water block below it, 8) non-creature
// blocks are bucketed into same-type groups.
import { NEIGHBOR_DIRS, cellKey } from './lattice.js';
import { BLOCK, isCreature } from './tools.js';
import { CRAWLY_BEHAVIOR, CRAWLY_SIGHT_RADIUS, DEFAULT_CRAWLY_BEHAVIOR } from './crawly.js';

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
 * Gravity toward the origin. Blocks are bucketed into connected groups; every group except
 * the largest shifts one step as a whole, in whichever of the 14 lattice directions points
 * most nearly at the origin from the group's average centre. The largest group is the
 * anchor: it stays put, and detached chunks fall onto it and merge. (It used to be the group
 * holding the origin block, but then clearing the centre cell made the whole world rock
 * back and forth.) On a tie for largest, the group holding last turn's anchor block wins,
 * so the anchor doesn't flip between equal groups. Groups move one at a time in random
 * order against the current layout, so a group whose path is blocked (by a group that moved
 * earlier this turn) waits. Returns the set of moved blocks.
 */
export function stepGroups(world) {
  const moved = new Set();
  const groups = connectedGroups(world);
  let anchor = null;
  for (const g of groups) {
    const better = !anchor || g.length > anchor.length ||
      (g.length === anchor.length && world.anchorBlock && g.includes(world.anchorBlock));
    if (better) anchor = g;
  }
  if (anchor && !anchor.includes(world.anchorBlock)) world.anchorBlock = anchor[0]; // remember it for ties
  for (const group of shuffle(groups)) {
    if (group === anchor) continue; // the largest group stays put
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
      if (world.move(b, { x: b.x + dx, y: b.y + dy, z: b.z + dz }, world.stepSeconds, { turnCrawly: false })) moved.add(b);
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
  return b.type === BLOCK.WATER && !b.vanishing && !(b.movedTurn > turn - WATER_SETTLE_TURNS);
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
    world.vanish(w, d, { toward: true }); // the Water shrinks into the Dirt, then goes
    if (world.setType(d, BLOCK.MOSS)) changed++;
  }
  return changed;
}

/** Blocks a Squirmy crawls along: the solid ones (Stone, Dirt, Moss, Berry, Crystal, Wood). */
export const SQUIRMY_HABITAT = new Set([BLOCK.STONE, BLOCK.DIRT, BLOCK.MOSS, BLOCK.BERRY, BLOCK.CRYSTAL, BLOCK.WOOD]);

/**
 * Whether a Squirmy's head (`head`, body `own`) could step into cell (x, y, z): the cell is
 * empty and touches a SQUIRMY_HABITAT block. On its very next step (`strict`) the cell may
 * touch no Squirmy block but the head; further along a path it may pass next to its own body
 * (which will have moved on by then), but never next to another Squirmy.
 */
function squirmyCellOk(world, head, own, x, y, z, strict) {
  if (world.blocks.has(cellKey(x, y, z))) return false;
  let habitat = false;
  for (const [ex, ey, ez] of NEIGHBOR_DIRS) {
    const n = world.blocks.get(cellKey(x + ex, y + ey, z + ez));
    if (!n || n === head) continue;
    if (n.type === BLOCK.SQUIRMY) {
      if (strict || !own.has(n)) return false;
    } else if (SQUIRMY_HABITAT.has(n.type)) habitat = true;
  }
  return habitat;
}

/** The surfaces a creature walks along (for the Select tool's target check). */
export function habitatOf(c) {
  return c.type === BLOCK.SQUIRMY ? SQUIRMY_HABITAT : CRAWLY_HABITAT;
}

/** Whether creature `c` (a Crawly, or a Squirmy's head) can be sent to cell (x, y, z). */
export function canStand(world, c, x, y, z) {
  if (c.type !== BLOCK.SQUIRMY) return isWalkable(world, x, y, z, c);
  const own = new Set(world.squirmyOf.get(c)?.segments ?? [c]);
  return squirmyCellOk(world, c, own, x, y, z, false);
}

/**
 * Squirmies, every turn (bundled first, see World.refreshSquirmies). A Squirmy whose head is
 * on Wander moves as a chain: the head steps to a random empty neighbouring cell that
 * touches a SQUIRMY_HABITAT block and touches no Squirmy block other than the head itself
 * (so it can't coil into itself or bump into another Squirmy) — or, if there is no such
 * cell, into any empty neighbouring cell; then each following segment
 * moves into the cell the one ahead of it just left. On Walk (sent with the Select tool) the
 * head takes the next step of a shortest path to its `walkTarget` instead, and goes back to
 * Wander on arrival (event crawlyArrived), or after WALK_GIVE_UP_TURNS turns with no path.
 * Other behaviors (e.g. Wait while selected) stay put, as does a Squirmy with a segment that
 * fell with its group this turn.
 * Returns the number of Squirmies that moved.
 */
export function stepSquirmies(world, skip = new Set()) {
  world.refreshSquirmies();
  let moved = 0;
  for (const sq of shuffle([...world.squirmies])) {
    const head = sq.segments[0];
    if (sq.segments.some((b) => skip.has(b))) continue;
    const own = new Set(sq.segments);
    const ok = (x, y, z, steps) => squirmyCellOk(world, head, own, x, y, z, steps === 1);
    let to = null;
    const behavior = head.behavior ?? DEFAULT_CRAWLY_BEHAVIOR;
    if (behavior === CRAWLY_BEHAVIOR.WANDER) {
      const cells = [];
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const x = head.x + dx, y = head.y + dy, z = head.z + dz;
        if (ok(x, y, z, 1)) cells.push({ x, y, z });
      }
      if (!cells.length) {
        // nowhere that follows the rules: squeeze into any empty neighbouring cell instead
        for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
          const x = head.x + dx, y = head.y + dy, z = head.z + dz;
          if (!world.blocks.has(cellKey(x, y, z))) cells.push({ x, y, z });
        }
      }
      if (cells.length) to = cells[Math.floor(Math.random() * cells.length)];
    } else if (behavior === CRAWLY_BEHAVIOR.WALK) {
      const t = head.walkTarget;
      const stop = () => {
        head.behavior = CRAWLY_BEHAVIOR.WANDER;
        delete head.walkTarget;
        delete head.walkStuck;
      };
      if (!t || (head.x === t.x && head.y === t.y && head.z === t.z)) stop();
      else {
        to = firstStepToward(world, head, t, ok);
        if (!to) {
          head.walkStuck = (head.walkStuck || 0) + 1;
          if (head.walkStuck >= WALK_GIVE_UP_TURNS) stop();
        } else {
          head.walkStuck = 0;
          if (to.x === t.x && to.y === t.y && to.z === t.z) {
            stop();
            world.emit('crawlyArrived', head);
          }
        }
      }
    }
    if (to) {
      // follow the leader: each segment takes the cell the one ahead of it just left
      let prev = to;
      for (const seg of sq.segments) {
        const here = { x: seg.x, y: seg.y, z: seg.z };
        world.move(seg, prev, world.stepSeconds, { turnCrawly: seg === head });
        prev = here;
      }
      moved++;
    }
    squirmyEat(world, head, sq.segments);
  }
  return moved;
}

/**
 * A Squirmy that sees a Berry (within its head's sightRadius) eats the nearest one: the
 * Berry drifts 1 cm toward the head while shrinking away, then is removed (World.vanish),
 * event 'squirmyAte' fires (sound), and the Squirmy grows one block at its tail, "worm"
 * style: in an empty cell next to the tail that touches no other block of the Squirmy
 * (falling back to the segment before, and so on). One Berry per turn.
 */
function squirmyEat(world, head, segments) {
  let berry = null, best = Infinity;
  for (const [dx, dy, dz] of offsetsWithin(head.sightRadius ?? 1)) {
    const n = world.blocks.get(cellKey(head.x + dx, head.y + dy, head.z + dz));
    const d = dx * dx + dy * dy + dz * dz;
    if (n?.type === BLOCK.BERRY && !n.vanishing && d < best) {
      berry = n;
      best = d;
    }
  }
  if (!berry || !world.vanish(berry, head, { toward: true })) return false;
  world.emit('squirmyAte', { squirmy: head, berry });
  const cell = world._wormCell(segments);
  if (cell) world.add(...cell, BLOCK.SQUIRMY); // the newest block becomes the tail
  return true;
}

/** Lattice offsets within `radius` blocks (sphere of radius * 2 cm), cached per radius. */
const sightOffsets = new Map();
function offsetsWithin(radius) {
  if (!sightOffsets.has(radius)) {
    const r = radius * 2, r2 = r * r, list = [];
    for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) for (let z = -r; z <= r; z++) {
      const allEven = !(x & 1) && !(y & 1) && !(z & 1), allOdd = x & 1 && y & 1 && z & 1;
      if ((allEven || allOdd) && (x || y || z) && x * x + y * y + z * z <= r2) list.push([x, y, z]);
    }
    sightOffsets.set(radius, list);
  }
  return sightOffsets.get(radius);
}

/**
 * Creature sight: every Fog block within a Crawly's or a Squirmy head's `sightRadius` (in blocks, see
 * CRAWLY_SIGHT_RADIUS, SQUIRMY_SIGHT_RADIUS) is cleared: it shrinks to nothing while drifting 1 cm away
 * from the creature (World.vanish), then is deleted. Sight isn't blocked by other blocks. Returns the
 * number of Fog blocks that started clearing.
 */
export function stepSight(world) {
  let cleared = 0;
  // Crawlies, and each Squirmy's head (its eyes)
  const seers = [...world.crawlies, ...world.squirmies.map((sq) => sq.segments[0])];
  for (const c of seers) {
    for (const [dx, dy, dz] of offsetsWithin(c.sightRadius ?? CRAWLY_SIGHT_RADIUS)) {
      const n = world.blocks.get(cellKey(c.x + dx, c.y + dy, c.z + dz));
      if (n?.type === BLOCK.FOG && world.vanish(n, c)) cleared++; // shrinks away from the Crawly, then goes
    }
  }
  return cleared;
}

/** A Nimbus may rain every NIMBUS_RAIN_EVERY turns, with NIMBUS_RAIN_CHANCE. */
export const NIMBUS_RAIN_EVERY = 3;
export const NIMBUS_RAIN_CHANCE = 0.25;

/**
 * Nimbus rain, on turns that are a multiple of NIMBUS_RAIN_EVERY: each Nimbus has a
 * NIMBUS_RAIN_CHANCE chance to put a Water block in the cell below it, if that cell is
 * empty. "Below" is toward the origin (the centre of gravity): the lattice direction
 * closest to the line from the Nimbus to the origin. Returns the number of drops made.
 */
export function stepNimbus(world, turn) {
  if (turn % NIMBUS_RAIN_EVERY !== 0) return 0;
  let drops = 0;
  for (const n of [...world.blocks.values()].filter((b) => b.type === BLOCK.NIMBUS)) {
    if (!n.x && !n.y && !n.z) continue; // at the origin: no "down"
    if (Math.random() >= NIMBUS_RAIN_CHANCE) continue;
    const [dx, dy, dz] = closestDir(-n.x, -n.y, -n.z);
    if (world.add(n.x + dx, n.y + dy, n.z + dz, BLOCK.WATER)) drops++; // add() refuses a filled cell
  }
  return drops;
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
    if (cellKey(c.x, c.y, c.z) === drinkKey) {
      world.remove(drink.x, drink.y, drink.z); // growing right where the Water was: swap it at once
    } else {
      // the Water shrinks into the Wood block of the tree that is drinking it, then goes
      const feeder = tree.find((w) => NEIGHBOR_DIRS.some(([dx, dy, dz]) => w.x + dx === drink.x && w.y + dy === drink.y && w.z + dz === drink.z));
      world.vanish(drink, feeder ?? tree[0], { toward: true });
    }
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
    if (world.move(w, cells[Math.floor(Math.random() * cells.length)], world.stepSeconds)) moved.add(w);
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
  return world.move(c, to, world.stepSeconds);
}

/** Most cells one Walk path search may visit (keeps a turn cheap in big builds). */
const WALK_SEARCH_LIMIT = 5000;
/** A walking Crawly that finds no path this many turns in a row gives up and Wanders. */
export const WALK_GIVE_UP_TURNS = 5;

/**
 * First step of a shortest path (fewest steps) from creature `c` to cell `t`, found by
 * breadth-first search; null if there is none. `ok(x, y, z, steps)` says whether a cell can
 * be stepped into `steps` moves from now (default: a Crawly's isWalkable).
 */
function firstStepToward(world, c, t, ok = (x, y, z) => isWalkable(world, x, y, z, c)) {
  if (!ok(t.x, t.y, t.z, Infinity)) return null;
  const goal = cellKey(t.x, t.y, t.z);
  const firstStep = new Map([[cellKey(c.x, c.y, c.z), null]]); // visited cell -> first step on its path
  const queue = [{ x: c.x, y: c.y, z: c.z, steps: 0 }];
  for (let i = 0; i < queue.length && firstStep.size < WALK_SEARCH_LIMIT; i++) {
    const p = queue[i];
    const via = firstStep.get(cellKey(p.x, p.y, p.z));
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz, steps: p.steps + 1 };
      const k = cellKey(q.x, q.y, q.z);
      if (firstStep.has(k) || !ok(q.x, q.y, q.z, q.steps)) continue;
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
  const moved = world.move(c, next, world.stepSeconds);
  if (arrived()) {
    stop();
    world.emit('crawlyArrived', c);
  }
  return moved;
}

/** A Crawly trapped for this many turns in a row dies. */
export const CRAWLY_TRAPPED_DEATH_TURNS = 15;

/**
 * Whether the neighbour of `c` at offset (dx, dy, dz) walls it in, for the Trapped rule:
 * a non-creature block, except Fog, which counts as empty space. (Another creature isn't a
 * wall: it can move away.)
 */
function isTrapWall(world, c, dx, dy, dz) {
  const n = world.blocks.get(cellKey(c.x + dx, c.y + dy, c.z + dz));
  return !!n && !isCreature(n.type) && n.type !== BLOCK.FOG;
}

/** Every neighbouring cell is a wall (see isTrapWall). */
function isWalledIn(world, c) {
  return NEIGHBOR_DIRS.every(([dx, dy, dz]) => isTrapWall(world, c, dx, dy, dz));
}

/**
 * Trapped bookkeeping, at the start of a Crawly's turn. A Crawly walled in by non-creature, non-Fog
 * blocks switches to Trapped (dropping any walk target; event 'crawlyTrapped'). A Trapped
 * Crawly that has an empty (or Fog) neighbouring cell goes back to Wander ('crawlyFreed'); otherwise
 * it counts the turn, and on the CRAWLY_TRAPPED_DEATH_TURNS-th trapped turn it dies: its
 * block is removed ('crawlyDied', with its last position). Returns true when the Crawly is
 * free to act this turn.
 */
function checkTrapped(world, c) {
  if (c.behavior === CRAWLY_BEHAVIOR.TRAPPED) {
    const hasGap = !isWalledIn(world, c); // an empty (or Fog) neighbouring cell frees it
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
