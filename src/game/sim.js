// Turn-based simulation: runs once per game second ("turn").
// Order each turn: 1) connected groups not anchored at the origin fall one step toward it,
// 2) Water flows toward the origin, 3) creatures move, 4) trees (Wood groups) drink Water
// and grow Wood or Berries, 5) Dirt absorbs Water and becomes Moss (both only take Water
// that has been still for 2 turns), 6) every 10th turn, a raindrop (Water) appears 1 m
// from the origin, 7) every 3rd turn, each Nimbus may rain a Water block below it, 8) non-creature
// blocks are bucketed into same-type groups.
import { NEIGHBOR_DIRS, cellKey, randomCellOnSphere } from './lattice.js';
import { BEHAVIOR, BLOCK, BLOCK_TYPES, blockProps, isCreature, canWalkOn, canEat, priorityDietOf, isSingleCreature, canFly } from './blocks.js';


/** Chance that a wandering creature decides to move on a given turn (when it has somewhere to go). */
export const WANDER_MOVE_CHANCE = 0.5;

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
 * `starts` (default: every block) is where groups can begin: pass World.ofType(type) when
 * only one type can be included, so the whole world isn't scanned.
 */
export function connectedGroups(world, include = () => true, linked = () => true, starts = world.blocks.values()) {
  const seen = new Set();
  const groups = [];
  for (const start of starts) {
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
 * Buckets every non-creature block into clusters, groups of connected blocks of the same
 * type (like trees are connected Wood). Not run every turn (nothing needs it yet, and it walks
 * the whole world): call it when needed; World.clusterOf gives one block's cluster on demand.
 * Stored on the world:
 *   world.clusters  — array of { type, blocks }
 *   world.clusterByBlock — Map block -> its { type, blocks } cluster
 * Creatures (see CREATURE_TYPES) are left out (World.clusterOf covers them). Returns
 * world.clusters.
 */
export function updateClusters(world) {
  const clusters = connectedGroups(world, (block) => !isCreature(block.type), (a, b) => a.type === b.type)
    .map((blocks) => ({ type: blocks[0].type, blocks }));
  const clusterByBlock = new Map();
  for (const g of clusters) for (const b of g.blocks) clusterByBlock.set(b, g);
  world.clusters = clusters;
  world.clusterByBlock = clusterByBlock;
  return clusters;
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
/** Clouds: falling treats them as empty space (they don't fall, don't join groups, get blown aside). */
export const CLOUD_TYPES = new Set([BLOCK.FOG, BLOCK.NIMBUS]);

export function stepGroups(world) {
  const moved = new Set();
  const groups = connectedGroups(world, (block) => !CLOUD_TYPES.has(block.type) && !canFly(block)); // clouds and flyers don't fall
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
    // every target cell must be empty or vacated by this group (another group may have moved
    // in). Fog / Nimbus in the way is blown aside; it keeps its cell while it shrinks away, so
    // the group falls on through next turn.
    let blocked = false;
    for (const b of group) {
      const n = world.blocks.get(cellKey(b.x + dx, b.y + dy, b.z + dz));
      if (!n || members.has(n)) continue;
      blocked = true;
      if (CLOUD_TYPES.has(n.type)) world.blow(group, n, 'breeze');
    }
    if (blocked) continue;
    // leading blocks first, so each block's target cell is already free when it moves
    group.sort((a, b) => (b.x * dx + b.y * dy + b.z * dz) - (a.x * dx + a.y * dy + a.z * dz));
    for (const b of group) {
      if (world.move(b, { x: b.x + dx, y: b.y + dy, z: b.z + dz }, world.stepSeconds, { turnCreature: false })) moved.add(b);
    }
  }
  return moved;
}

/** Rain: one Water drop every RAIN_EVERY turns, RAIN_RADIUS_CM from the origin (1 m). */
export const RAIN_EVERY = 5;
export const RAIN_RADIUS_CM = 50;

/**
 * Rain, on turns that are a multiple of RAIN_EVERY: picks a uniformly random point on the
 * sphere of radius RAIN_RADIUS_CM around the origin and puts a Water block in the lattice
 * cell nearest to it (skipped if that cell is already taken). The drop is its own
 * detached group, so stepGroups makes it fall toward the origin on the following turns.
 * Returns the new Water block, or null.
 */
export function stepRain(world, turn) {
  if (turn % RAIN_EVERY !== 0) return null;
  return spawnOnSphere(world, BLOCK.WATER, RAIN_RADIUS_CM);
}

/** Fog forms far out: one Fog block every FOG_EVERY turns, FOG_RADIUS_CM from the origin. */
export const FOG_EVERY = 1;
export const FOG_RADIUS_CM = 50;

/**
 * Fog forming, on turns that are a multiple of FOG_EVERY: like rain, but a Fog block, placed
 * at a uniformly random point on the sphere of radius FOG_RADIUS_CM. It then falls in as a
 * Fog cluster (stepFog) and settles onto whatever it meets, joining any Fog there. Returns the
 * new Fog block, or null.
 */
export function stepFogForm(world, turn) {
  if (turn % FOG_EVERY !== 0) return null;
  return spawnOnSphere(world, BLOCK.FOG, FOG_RADIUS_CM);
}

/**
 * Puts a block of `type` in the lattice cell nearest a uniformly random point on the sphere of
 * radius `radiusCm` around the origin (skipped if that cell is taken). Returns it, or null.
 */
function spawnOnSphere(world, type, radiusCm) {
  const c = randomCellOnSphere(radiusCm);
  return world.add(c.x, c.y, c.z, type) ? world.get(c.x, c.y, c.z) : null;
}

/** Water can only be absorbed (by trees or Dirt) once it has stayed still this many turns. */
export const WATER_SETTLE_TURNS = 2;

/** Water that hasn't moved during the last WATER_SETTLE_TURNS turns (including this one). */
function isSettledWater(block, turn) {
  return block.type === BLOCK.WATER && !block.vanishing && !(block.movedTurn > turn - WATER_SETTLE_TURNS);
}

/** The block closest to the origin among `blocks` (ties at random). */
function closestToOrigin(blocks) {
  const d2 = (block) => block.x * block.x + block.y * block.y + block.z * block.z;
  const minD = Math.min(...blocks.map(d2));
  const nearest = blocks.filter((block) => d2(block) === minD);
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
  // only Dirt touching settled Water can soak it up: find those from the Water side (far
  // fewer blocks to look at than all the Dirt)
  const candidates = new Set();
  for (const w of world.ofType(BLOCK.WATER)) {
    if (!isSettledWater(w, turn)) continue;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const n = world.blocks.get(cellKey(w.x + dx, w.y + dy, w.z + dz));
      if (n?.type === BLOCK.DIRT) candidates.add(n);
    }
  }
  for (const d of shuffle([...candidates])) {
    const waters = [];
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const n = world.blocks.get(cellKey(d.x + dx, d.y + dy, d.z + dz));
      if (n && isSettledWater(n, turn)) waters.push(n);
    }
    if (!waters.length || Math.random() >= DIRT_ABSORB_CHANCE) continue;
    const w = closestToOrigin(waters);
    if (!world.consume(d, w, 'waterSip')) continue; // the Water shrinks into the Dirt (its slot)
    if (world.setType(d, BLOCK.MOSS)) changed++;
  }
  return changed;
}

/**
 * Whether a Squirmy's head (`head`, body `own`) could step into cell (x, y, z): the cell is
 * empty and touches a block the Squirmy can walk on (walkableBlocks). On its very next step (`strict`) the cell may
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
    } else if (canWalkOn(head.type, n.type)) habitat = true;
  }
  return habitat || canFly(head); // Flight: no surface needed
}

/** Whether `creature` (a one-block creature, or a Squirmy's head) can be sent to cell (x, y, z). */
export function canStand(world, creature, x, y, z) {
  if (creature.type !== BLOCK.SQUIRMY) return isWalkable(world, x, y, z, creature);
  const own = new Set(world.squirmyOf.get(creature)?.segments ?? [creature]);
  return squirmyCellOk(world, creature, own, x, y, z, false);
}

/**
 * Squirmies, every turn (clustered first, see World.refreshSquirmies). A Squirmy whose head is
 * on Wander moves as a chain: the head steps to a random empty neighbouring cell that
 * touches a block it can walk on (walkableBlocks) and touches no Squirmy block other than the head itself
 * (so it can't coil into itself or bump into another Squirmy) — or, if there is no such
 * cell, into any empty neighbouring cell; then each following segment
 * moves into the cell the one ahead of it just left. On Walk (sent with the Select tool) the
 * head takes the next step of a shortest path to its `walkTarget` instead, and goes back to
 * Wander on arrival (event creatureArrived), or after WALK_GIVE_UP_TURNS turns with no path.
 * Other behaviors (e.g. Wait while selected) stay put, as does a Squirmy with a segment that
 * fell with its group this turn.
 * Returns the number of Squirmies that moved.
 */
export function stepSquirmies(world, skip = new Set()) {
  world.refreshSquirmies();
  let moved = 0;
  for (const sq of shuffle([...world.squirmies])) {
    const head = sq.segments[0];
    tickWait(head);
    if (sq.segments.some((block) => skip.has(block))) continue;
    const own = new Set(sq.segments);
    const ok = (x, y, z, steps) => squirmyCellOk(world, head, own, x, y, z, steps === 1);
    // left to itself, a Squirmy goes for Berries it can see (and eats one next to it)
    const foraged = forage(world, head, (goal) => firstStepToward(world, head, goal, ok), (to) => moveChain(world, sq.segments, to));
    if (foraged) {
      if (foraged === 'moved') moved++;
      continue;
    }
    let to = null;
    const behavior = head.behavior ?? blockProps(head.type).defaultBehavior;
    if (behavior === BEHAVIOR.WANDER) {
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
    } else if (behavior === BEHAVIOR.WALK) {
      const t = head.walkTarget;
      const stop = () => endWalk(head);
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
            world.emit('creatureArrived', head);
          }
        }
      }
    }
    if (to) {
      moveChain(world, sq.segments, to);
      moved++;
    } else if ((behavior === BEHAVIOR.WANDER || behavior === BEHAVIOR.WALK) && !hasEmptyNeighbor(world, head)) {
      // boxed in (no empty cell next to its head): if its inventory is full it tries to
      // excrete (World.excrete, out behind its tail); otherwise it eats its way out
      // (an edible block next to its head, freeing that cell)
      if (!world.freeSlotFor(head)) world.excrete(world.clusterOf(head), 'excrete');
      else creatureEatNearby(world, head);
    }
  }
  return moved;
}

/** Whether `block` has at least one empty neighbouring cell. */
function hasEmptyNeighbor(world, block) {
  return NEIGHBOR_DIRS.some(([dx, dy, dz]) => !world.blocks.has(cellKey(block.x + dx, block.y + dy, block.z + dz)));
}

/** Moves a Squirmy's head to `to`; each following segment takes the cell the one ahead of it just left. */
function moveChain(world, segments, to) {
  let prev = to;
  for (const seg of segments) {
    const here = { x: seg.x, y: seg.y, z: seg.z };
    world.move(seg, prev, world.stepSeconds, { turnCreature: seg === segments[0] });
    prev = here;
  }
}

/**
 * Foraging, for a creature left to itself (`creature.isAssignedBehavior` false: the player hasn't
 * given it something to do) with an inventory slot free in its cluster. Its priority foods are
 * its priorityDiet (its type's, plus its buffs', e.g. Rockbiter's Crystal: blocks.js), counting
 * only those it can eat right now:
 *  - a priority food right next to it: it eats it (creatureEat)
 *  - else one it can see (within its sightRadius): it takes one step along the shortest path
 *    to a cell next to the nearest one it can reach. `stepToward(goal)` finds that step for
 *    this kind of creature, `moveTo(cell)` makes it.
 * Returns 'ate', 'moved', or false (nothing to forage: it does its normal behavior).
 */
function forage(world, creature, stepToward, moveTo) {
  if (creature.isAssignedBehavior || !world.freeSlotFor(creature)) return false;
  const wanted = new Set(priorityDietOf(creature).filter((type) => canEat(creature, type)));
  if (!wanted.size) return false;
  for (const [dx, dy, dz] of shuffle([...NEIGHBOR_DIRS])) {
    const n = world.blocks.get(cellKey(creature.x + dx, creature.y + dy, creature.z + dz));
    if (n && wanted.has(n.type) && !n.vanishing && creatureEat(world, creature, n)) return 'ate';
  }
  const d2 = (block) => (block.x - creature.x) ** 2 + (block.y - creature.y) ** 2 + (block.z - creature.z) ** 2;
  const foods = offsetsWithin(creature.sightRadius ?? blockProps(creature.type).sightRadius ?? 0)
    .map(([dx, dy, dz]) => world.blocks.get(cellKey(creature.x + dx, creature.y + dy, creature.z + dz)))
    .filter((block) => block && wanted.has(block.type) && !block.vanishing)
    .sort((a, b) => d2(a) - d2(b));
  for (const food of foods) {
    // the cells next to it this creature could stand in, nearest first
    const goals = NEIGHBOR_DIRS.map(([dx, dy, dz]) => ({ x: food.x + dx, y: food.y + dy, z: food.z + dz }))
      .filter((g) => canStand(world, creature, g.x, g.y, g.z))
      .sort((a, b) => d2(a) - d2(b));
    for (const goal of goals) {
      const step = stepToward(goal);
      if (step) {
        moveTo(step);
        return 'moved';
      }
    }
  }
  return false;
}

/** Sound a creature makes consuming a block: sip for Water, eat for anything else. */
const eatSound = (food) => (food.type === BLOCK.WATER ? 'sip' : 'eat');

/**
 * `creature` (a one-block creature, or a Squirmy's head) eats block `food`, if its type is in the
 * creature's diet (or a buff's: canEat) and its cluster has a free inventory slot (World.consume:
 * the food shrinks toward `creature`, the eat sound plays, the item goes into a slot). A Squirmy
 * that eats a Berry then grows one block at its tail, "worm" style: in an empty cell next to
 * the tail that touches no other block of the Squirmy (falling back to the segment before,
 * and so on). It can't eat the block directly behind it (isBehind). Returns whether it ate.
 */
export function creatureEat(world, creature, food) {
  if (!food || !canEat(creature, food.type)) return false; // its diet, or a buff's (e.g. Rockbiter: Stone)
  if (isBehind(creature, food)) return false; // it can't reach round to the block right behind it
  const foodType = food.type;
  const wasBerry = foodType === BLOCK.BERRY;
  const slot = world.consume(creature, food, eatSound(food));
  if (!slot) return false;
  // some foods give a buff (blocks.js eatBuffs, e.g. a Crawly eating a Berry: Rockbiter); the
  // food is used up into the buff, so it leaves the inventory slot it went into
  world.useBuffCharges(creature, foodType); // a buff's priority food uses up one of its charges
  const buff = blockProps(creature.type).eatBuffs?.[foodType];
  if (buff) {
    world.addBuff(creature, buff.buff, buff.turns, buff.charges);
    slot.inventory = null;
  }
  if (creature.type === BLOCK.BUZZY && wasBerry) world.growSegment(creature); // a Buzzy grows a body segment (wings and legs too)
  if (creature.type === BLOCK.SQUIRMY && wasBerry) {
    const body = world.clusterOf(creature);
    const cell = world._wormCell(body);
    // the newest block becomes the tail: it grows in out of the body block it's next to (the
    // old tail, if there was room there), like a Buzzy's segment
    if (cell && world.add(...cell, BLOCK.SQUIRMY)) {
      const [x, y, z] = cell;
      const from = body.findLast((b) => NEIGHBOR_DIRS.some(([dx, dy, dz]) => b.x + dx === x && b.y + dy === y && b.z + dz === z));
      world.appear(world.get(x, y, z), from ?? body[body.length - 1]);
    }
  }
  return true;
}

/**
 * `creature` (a one-block creature, or a Squirmy's head) eats the block in front of it, or, if it
 * can't eat that one, any other edible block next to it (tried in random order).
 * Returns whether it ate.
 */
export function creatureEatNearby(world, creature) {
  const front = blockInFront(world, creature);
  if (front && creatureEat(world, creature, front)) return true;
  for (const [dx, dy, dz] of shuffle([...NEIGHBOR_DIRS])) {
    const n = world.blocks.get(cellKey(creature.x + dx, creature.y + dy, creature.z + dz));
    if (n && n !== front && creatureEat(world, creature, n)) return true;
  }
  return false;
}

/** Whether `block` is directly behind creature `creature` (the cell opposite its `front` direction). */
export function isBehind(creature, block) {
  if (!creature.front) return false;
  const [dx, dy, dz] = creature.front;
  return block.x === creature.x - dx && block.y === creature.y - dy && block.z === creature.z - dz;
}

/** The block right in front of creature `creature` (the cell in its `front` direction), if any. */
export function blockInFront(world, creature) {
  if (!creature.front) return null;
  const [dx, dy, dz] = creature.front;
  return world.blocks.get(cellKey(creature.x + dx, creature.y + dy, creature.z + dz)) ?? null;
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
 * Creature sight: every Fog block within a one-block creature's or a Squirmy head's `sightRadius` (in blocks, see
 * each creature type's sightRadius in blocks.js) is cleared: it shrinks to nothing while drifting 1 cm away
 * from the creature (World.vanish), then is deleted. Sight isn't blocked by other blocks. Returns the
 * number of Fog blocks that started clearing.
 */
export function stepSight(world) {
  let cleared = 0;
  // one-block creatures, and each Squirmy's head (its eyes)
  const seers = [...world.soloCreatures, ...world.squirmies.map((sq) => sq.segments[0])];
  for (const c of seers) {
    for (const [dx, dy, dz] of offsetsWithin(c.sightRadius ?? blockProps(c.type).sightRadius ?? 0)) {
      const n = world.blocks.get(cellKey(c.x + dx, c.y + dy, c.z + dz));
      if (n?.type === BLOCK.FOG && world.blow(world.clusterOf(c), n, 'breeze')) cleared++; // blown away from the creature
    }
  }
  return cleared;
}

/**
 * Nimbus drift: each Nimbus cluster (connected Nimbus blocks) shifts one step west every
 * turn, if nothing is in the way (every cell ahead is empty or its own). West is taken
 * relative to the world: "north" is world up (+y) and "down" is toward the origin, so west =
 * north × down, i.e. clockwise around the vertical axis seen from above, like the orbiting
 * light. The step is the lattice direction closest to that, from the cluster's centre. A
 * cluster sitting on the vertical axis has no west and stays put. Returns the set of moved
 * blocks.
 */
export function stepNimbusDrift(world, skip = new Set()) {
  const moved = new Set();
  if (stillIdle(world, 'nimbusDrift', BLOCK.NIMBUS)) return moved; // stuck, and nothing near any Nimbus changed
  let waited = false;
  for (const cluster of shuffle(connectedGroups(world, (block) => block.type === BLOCK.NIMBUS && !block.vanishing, undefined, world.ofType(BLOCK.NIMBUS)))) {
    if (cluster.some((block) => skip.has(block))) {
      waited = true;
      continue;
    }
    let cx = 0, cz = 0;
    for (const b of cluster) {
      cx += b.x;
      cz += b.z;
    }
    if (!cx && !cz) continue; // on the vertical axis: no west
    // west = up × (toward the origin) = (0, 1, 0) × (-cx, -cy, -cz) = (-cz, 0, cx)
    const [dx, dy, dz] = closestDir(-cz, 0, cx);
    const members = new Set(cluster);
    const blocked = cluster.some((block) => {
      const n = world.blocks.get(cellKey(block.x + dx, block.y + dy, block.z + dz));
      return n && !members.has(n);
    });
    if (blocked) continue;
    // leading blocks first, so each block's target cell is already free when it moves
    cluster.sort((a, b) => (b.x * dx + b.y * dy + b.z * dz) - (a.x * dx + a.y * dy + a.z * dz));
    for (const b of cluster) {
      if (world.move(b, { x: b.x + dx, y: b.y + dy, z: b.z + dz })) moved.add(b);
    }
  }
  markIdle(world, 'nimbusDrift', !moved.size && !waited);
  return moved;
}

/** A Nimbus may rain every NIMBUS_RAIN_EVERY turns, with NIMBUS_RAIN_CHANCE. */
export const NIMBUS_RAIN_EVERY = 4;
export const NIMBUS_RAIN_CHANCE = 0.1;

/**
 * Nimbus rain, on turns that are a multiple of NIMBUS_RAIN_EVERY: each Nimbus has a
 * NIMBUS_RAIN_CHANCE chance to put a Water block in the cell below it, if that cell is
 * empty. "Below" is toward the origin (the centre of gravity): the lattice direction
 * closest to the line from the Nimbus to the origin. Returns the number of drops made.
 */
export function stepNimbus(world, turn) {
  if (turn % NIMBUS_RAIN_EVERY !== 0) return 0;
  let drops = 0;
  for (const n of [...world.ofType(BLOCK.NIMBUS)]) {
    if (!n.x && !n.y && !n.z) continue; // at the origin: no "down"
    if (Math.random() >= NIMBUS_RAIN_CHANCE) continue;
    if (n.inventory) continue; // its one slot is busy
    const [dx, dy, dz] = closestDir(-n.x, -n.y, -n.z);
    // the drop is excreted, so it grows in out of the cloud (excrete refuses a filled cell)
    n.inventory = BLOCK.WATER;
    if (world.excrete([n], null, { cell: { x: n.x + dx, y: n.y + dy, z: n.z + dz } })) drops++;
    else n.inventory = null;
  }
  return drops;
}

/** Solid block types (Stone, Dirt, Moss, Wood, Berry): Wood only grows into cells away from these. */
export const SOLID_TYPES = new Set([BLOCK.STONE, BLOCK.DIRT, BLOCK.MOSS, BLOCK.WOOD, BLOCK.BERRY, BLOCK.CRYSTAL]);
/** A tree (connected Wood group) needs at least this many Wood blocks to grow Berries. */
export const BERRY_MIN_TREE_SIZE = 5;
/** Chance that a big-enough tree with no Berries yet grows a Berry instead of Wood when watered. */
export const BERRY_CHANCE = 0.4;
/**
 * A tree carries about one Berry per this many Wood blocks: the Berry chance falls off
 * linearly as the Berries already on it approach that, and is 0 once it has that many.
 */
export const WOOD_PER_BERRY = 4;

/**
 * Chance that watered tree `tree` (its Wood blocks) grows a Berry: BERRY_CHANCE, scaled by
 * how much room it has left for Berries (Berry blocks touching its Wood, against one per
 * WOOD_PER_BERRY Wood), so a big tree with few Berries grows them readily and one loaded
 * with them rarely does. 0 below BERRY_MIN_TREE_SIZE.
 */
export function berryChance(world, tree) {
  if (tree.length < BERRY_MIN_TREE_SIZE) return 0;
  const berries = new Set();
  for (const w of tree) {
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const n = world.blocks.get(cellKey(w.x + dx, w.y + dy, w.z + dz));
      if (n?.type === BLOCK.BERRY && !n.vanishing) berries.add(n);
    }
  }
  const room = 1 - berries.size / (tree.length / WOOD_PER_BERRY);
  return BERRY_CHANCE * Math.max(0, room);
}

/**
 * Tree growth, every turn. Wood blocks are bucketed into connected Wood groups (trees).
 * Each tree (in random order, seeing earlier trees' growth) that touches settled Water
 * (still for WATER_SETTLE_TURNS turns) drinks one such Water block — the one closest to the
 * origin, ties at random — and grows one block into
 * a random cell next to the tree that is empty (or is the drunk Water's cell) and touches
 * exactly one Wood and no other Solid block. The new block is Wood, or, for a tree of at
 * least BERRY_MIN_TREE_SIZE Wood, a Berry with berryChance (BERRY_CHANCE, lower the more
 * Berries the tree already has for its size). A tree with no such cell
 * leaves its Water alone. Returns the number of blocks grown.
 */
export function stepWood(world, turn) {
  let grown = 0;
  for (const tree of shuffle(connectedGroups(world, (block) => block.type === BLOCK.WOOD, undefined, world.ofType(BLOCK.WOOD)))) {
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
    // Berry or Wood: less likely the more Berries the tree already carries for its size
    const fruit = Math.random() < berryChance(world, tree);
    // the Water shrinks into the Wood block drinking it and goes into the tree's inventory
    // (growing right where the Water was: it is taken at once, so the cell is free)
    const feeder = tree.find((w) => NEIGHBOR_DIRS.some(([dx, dy, dz]) => w.x + dx === drink.x && w.y + dy === drink.y && w.z + dz === drink.z));
    const instant = cellKey(c.x, c.y, c.z) === drinkKey;
    if (!world.consume(feeder ?? tree[0], drink, 'waterSip', { instant })) continue; // tree's inventory is full
    // the new block is excreted by the Wood it grows from, so it grows in out of the branch
    const parent = tree.find((w) => NEIGHBOR_DIRS.some(([dx, dy, dz]) => w.x + dx === c.x && w.y + dy === c.y && w.z + dz === c.z));
    const made = growFrom(world, parent ?? tree[0], c, fruit ? BLOCK.BERRY : BLOCK.WOOD);
    if (made) {
      grown++;
      if (fruit) world.emit('berryGrow', made);
    }
  }
  return grown;
}

/**
 * Block `from` puts out a new block of `type` into empty cell `cell` (next to it) with
 * World.excrete, so it grows in from `from`. Whatever `from` holds in its inventory slot
 * stays there. Returns the new block, or null.
 */
function growFrom(world, from, cell, type) {
  const held = from.inventory;
  from.inventory = type;
  const made = world.excrete([from], null, { cell });
  from.inventory = held;
  return made;
}

/** Block types with `sinkable` (blocks.js): they sink through Water they can't hold on in. */
const SINKABLE_TYPES = BLOCK_TYPES.filter((t) => t.sinkable).map((t) => t.id);

/**
 * Sinking, every turn: a cluster of a sinkable type (a Crawly on its own) that touches no
 * block it can walk on, and whose every cell beneath it (one step toward the origin, the
 * way things fall) holds Water, swaps places with that Water: the cluster moves down a step
 * and the Water rises into the cells it left (World.relocate). Flying ones, clusters that
 * already moved this turn (`skip`), and Water on its way out are left alone. Returns the set
 * of moved blocks.
 */
export function stepSink(world, skip = new Set()) {
  const moved = new Set();
  const done = new Set();
  for (const type of SINKABLE_TYPES) {
    for (const start of [...world.ofType(type)]) {
      if (done.has(start)) continue;
      const cluster = world.clusterOf(start);
      for (const b of cluster) done.add(b);
      if (cluster.some((block) => skip.has(block) || moved.has(block) || block.vanishing || canFly(block))) continue;
      // holding on to something it can walk on: it doesn't sink
      const holds = cluster.some((block) => NEIGHBOR_DIRS.some(([dx, dy, dz]) => {
        const n = world.blocks.get(cellKey(block.x + dx, block.y + dy, block.z + dz));
        return n && canWalkOn(block.type, n.type);
      }));
      if (holds) continue;
      let cx = 0, cy = 0, cz = 0;
      for (const b of cluster) {
        cx += b.x;
        cy += b.y;
        cz += b.z;
      }
      if (!cx && !cy && !cz) continue; // at the origin: no "down"
      const [dx, dy, dz] = closestDir(-cx, -cy, -cz);
      const members = new Set(cluster);
      const waters = [];
      let ok = true;
      for (const b of cluster) {
        const n = world.blocks.get(cellKey(b.x + dx, b.y + dy, b.z + dz));
        if (n && members.has(n)) continue; // its own block
        if (!n || n.type !== BLOCK.WATER || n.vanishing || skip.has(n) || moved.has(n)) {
          ok = false; // something other than Water beneath (empty: falling handles that)
          break;
        }
        waters.push(n);
      }
      if (!ok || !waters.length) continue;
      // the Water rises into the cells the cluster leaves (as many as there are Water blocks)
      const shifted = new Set(cluster.map((block) => cellKey(block.x + dx, block.y + dy, block.z + dz)));
      const vacated = cluster.filter((block) => !shifted.has(cellKey(block.x, block.y, block.z))).map((block) => ({ x: block.x, y: block.y, z: block.z }));
      const moves = cluster.map((block) => [block, { x: block.x + dx, y: block.y + dy, z: block.z + dz }]);
      waters.forEach((w, i) => moves.push([w, vacated[i]]));
      if (world.relocate(moves)) for (const [b] of moves) moved.add(b);
    }
  }
  return moved;
}

/**
 * Water flows toward the origin (see stepFlow).
 */
export function stepWater(world, skip = new Set()) {
  return stepFlow(world, BLOCK.WATER, skip);
}

/**
 * Turn skipping for rules that are often stuck (Fog that can't fall, a Nimbus that can't
 * drift): a rule that found nothing to do marks the change log (World.changeLog); next turn
 * it only runs again if some cell changed since then at or next to a block of `type` (only
 * then can its blocks have become free to move, or their groups have changed).
 */
function stillIdle(world, rule, type) {
  const since = world.idleMarks[rule];
  if (since == null) return false;
  const log = world.changeLog;
  for (let i = since; i < log.length; i += 3) {
    const x = log[i], y = log[i + 1], z = log[i + 2];
    if (world.blocks.get(cellKey(x, y, z))?.type === type) return false;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      if (world.blocks.get(cellKey(x + dx, y + dy, z + dz))?.type === type) return false;
    }
  }
  world.idleMarks[rule] = log.length; // checked up to here, still stuck
  return true;
}

/** After a rule ran: `stuck` = it had nothing to do (so it may skip until something nearby changes). */
function markIdle(world, rule, stuck) {
  world.idleMarks[rule] = stuck ? world.changeLog.length : null;
}

/**
 * Fog falls as whole Fog clusters (connected Fog blocks), never block by block, so a blanket
 * of Fog stays draped over the land (as fog of war) instead of trickling down into valleys.
 * Each cluster shifts one step toward the origin, in the lattice direction closest to the
 * line from its centre to the origin, but only if every cell ahead is empty (or its own):
 * anything in the way, even a single block, holds the whole cluster up. Falling groups of
 * other blocks treat Fog as empty space (and blow it aside); this is how Fog itself comes
 * down. Returns the set of moved blocks.
 */
export function stepFog(world, skip = new Set()) {
  const moved = new Set();
  if (stillIdle(world, 'fog', BLOCK.FOG)) return moved; // stuck, and nothing near any Fog changed
  let waited = false;
  for (const cluster of shuffle(connectedGroups(world, (block) => block.type === BLOCK.FOG && !block.vanishing, undefined, world.ofType(BLOCK.FOG)))) {
    if (cluster.some((block) => skip.has(block))) {
      waited = true;
      continue;
    }
    let cx = 0, cy = 0, cz = 0;
    for (const b of cluster) {
      cx += b.x;
      cy += b.y;
      cz += b.z;
    }
    if (!cx && !cy && !cz) continue; // centred on the origin: no direction to fall
    const [dx, dy, dz] = closestDir(-cx, -cy, -cz);
    const members = new Set(cluster);
    const blocked = cluster.some((block) => {
      const n = world.blocks.get(cellKey(block.x + dx, block.y + dy, block.z + dz));
      return n && !members.has(n);
    });
    if (blocked) continue;
    // leading blocks first, so each block's target cell is already free when it moves
    cluster.sort((a, b) => (b.x * dx + b.y * dy + b.z * dz) - (a.x * dx + a.y * dy + a.z * dz));
    for (const b of cluster) {
      if (world.move(b, { x: b.x + dx, y: b.y + dy, z: b.z + dz })) moved.add(b);
    }
  }
  markIdle(world, 'fog', !moved.size && !waited);
  return moved;
}

/**
 * Blocks of `type` flow toward the origin, each on its own. They act one at a time, nearest
 * the origin first (ties in random order), each seeing the moves already made this turn, so
 * a front advances together. A block moves into whichever empty adjacent cell is closest to
 * the origin (ties broken at random), but only if that cell is closer to the origin than the
 * block itself. Blocks in `skip` (already moved this turn) and blocks shrinking away
 * (vanishing) sit still. Returns the set of blocks that moved.
 */
function stepFlow(world, type, skip) {
  const dist2 = (p) => p.x * p.x + p.y * p.y + p.z * p.z;
  const waters = shuffle([...world.ofType(type)].filter((block) => !skip.has(block) && !block.vanishing));
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
 * True when a creature (`self`) could stand in cell (x, y, z): the cell is empty (or holds
 * `self`) and touches at least one block of its habitat (Stone, Dirt, Moss).
 */
export function isWalkable(world, x, y, z, self = null) {
  const here = world.blocks.get(cellKey(x, y, z));
  if (here && here !== self) return false;
  if (canFly(self)) return true; // Flight: any empty cell will do
  return NEIGHBOR_DIRS.some(([ex, ey, ez]) => {
    const n = world.blocks.get(cellKey(x + ex, y + ey, z + ez));
    return n && n !== self && canWalkOn(self?.type ?? BLOCK.CRAWLY, n.type);
  });
}

/**
 * A Buzzy in mid-air: nothing next to it but empty cells and clouds (Fog, Nimbus). Its body
 * segments don't count (they're part of it).
 */
function isAirborneBuzzy(world, creature) {
  if (creature.type !== BLOCK.BUZZY) return false;
  return NEIGHBOR_DIRS.every(([dx, dy, dz]) => {
    const n = world.blocks.get(cellKey(creature.x + dx, creature.y + dy, creature.z + dz));
    return !n || CLOUD_TYPES.has(n.type) || n.segmentOf === creature;
  });
}

/**
 * Wander: with WANDER_MOVE_CHANCE the creature steps to a random walkable adjacent cell
 * (any of its 14 neighbours); a Buzzy in mid-air (isAirborneBuzzy) always does, it can't
 * hover. Returns whether it moved.
 */
function wander(world, creature) {
  if (Math.random() >= WANDER_MOVE_CHANCE && !isAirborneBuzzy(world, creature)) return false;
  const options = [];
  for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
    const x = creature.x + dx, y = creature.y + dy, z = creature.z + dz;
    if (isWalkable(world, x, y, z, creature)) options.push({ x, y, z });
  }
  if (!options.length) return false;
  const to = options[Math.floor(Math.random() * options.length)];
  return world.move(creature, to, world.stepSeconds);
}

/** Most cells one Walk path search may visit (keeps a turn cheap in big builds). */
const WALK_SEARCH_LIMIT = 5000;
/** A walking creature that finds no path this many turns in a row gives up and Wanders. */
export const WALK_GIVE_UP_TURNS = 5;

/**
 * First step of a shortest path (fewest steps) from creature `creature` to cell `t`, found by
 * breadth-first search; null if there is none. `ok(x, y, z, steps)` says whether a cell can
 * be stepped into `steps` moves from now (default: the creature's isWalkable).
 */
function firstStepToward(world, creature, t, ok = (x, y, z) => isWalkable(world, x, y, z, creature)) {
  if (!ok(t.x, t.y, t.z, Infinity)) return null;
  const goal = cellKey(t.x, t.y, t.z);
  const firstStep = new Map([[cellKey(creature.x, creature.y, creature.z), null]]); // visited cell -> first step on its path
  const queue = [{ x: creature.x, y: creature.y, z: creature.z, steps: 0 }];
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
 * Walk: take the next step of the shortest path to `creature.walkTarget`. On arrival the creature
 * goes back to Wander. If no path exists (blocked, or the target stopped being walkable)
 * it waits, and gives up (back to Wander) after WALK_GIVE_UP_TURNS such turns in a row.
 * Returns whether it moved.
 */
function walk(world, creature) {
  const t = creature.walkTarget;
  const arrived = () => t && creature.x === t.x && creature.y === t.y && creature.z === t.z;
  const stop = () => endWalk(creature);
  if (!t || arrived()) {
    stop();
    return false;
  }
  const next = firstStepToward(world, creature, t);
  if (!next) {
    creature.walkStuck = (creature.walkStuck || 0) + 1;
    if (creature.walkStuck >= WALK_GIVE_UP_TURNS) stop();
    return false;
  }
  creature.walkStuck = 0;
  const moved = world.move(creature, next, world.stepSeconds);
  if (arrived()) {
    stop();
    world.emit('creatureArrived', creature);
  }
  return moved;
}

/** Selecting a creature puts it in Wait for this many turns, then it resumes what it was doing. */
export const SELECT_WAIT_TURNS = 4;

/**
 * A timed Wait (`creature.waitTurns`, set when the Select tool selects it) counts down a turn; at 0
 * the creature goes back to its `heldBehavior` (it stays selected). A timer left over after
 * its behavior changed some other way is dropped.
 */
function tickWait(creature) {
  if (creature.waitTurns == null) return;
  if (creature.behavior !== BEHAVIOR.WAIT) {
    delete creature.waitTurns;
    return;
  }
  if (creature.waitTurns-- > 0) return; // waits this turn (waitTurns = turns still to wait after it)
  delete creature.waitTurns;
  creature.behavior = creature.heldBehavior ?? blockProps(creature.type).defaultBehavior;
}

/**
 * A walk is over (arrived, or gave up): the creature goes back to Wander, or, while it is
 * still selected (the Select tool keeps a creature selected after sending it), it waits
 * there, and wanders once deselected.
 */
function endWalk(creature) {
  delete creature.walkTarget;
  delete creature.walkStuck;
  if (!creature.isSelected) creature.isAssignedBehavior = false; // the order is done: it may forage again
  if (creature.isSelected) {
    creature.behavior = BEHAVIOR.WAIT;
    creature.heldBehavior = BEHAVIOR.WANDER;
  } else {
    creature.behavior = BEHAVIOR.WANDER;
  }
}

/** A creature trapped for this many turns in a row dies. */
export const TRAPPED_DEATH_TURNS = 15;

/**
 * Whether the neighbour of `creature` at offset (dx, dy, dz) walls it in, for the Trapped rule:
 * a non-creature block, except Fog, which counts as empty space. (Another creature isn't a
 * wall: it can move away.)
 */
function isTrapWall(world, creature, dx, dy, dz) {
  const n = world.blocks.get(cellKey(creature.x + dx, creature.y + dy, creature.z + dz));
  return !!n && !isCreature(n.type) && n.type !== BLOCK.FOG;
}

/** Every neighbouring cell is a wall (see isTrapWall). */
function isWalledIn(world, creature) {
  return NEIGHBOR_DIRS.every(([dx, dy, dz]) => isTrapWall(world, creature, dx, dy, dz));
}

/**
 * Trapped bookkeeping, at the start of a creature's turn. A creature walled in by non-creature, non-Fog
 * blocks switches to Trapped (dropping any walk target; event 'creatureTrapped'). A Trapped
 * creature that has an empty (or Fog) neighbouring cell goes back to Wander ('creatureFreed'); otherwise
 * it counts the turn, and on the TRAPPED_DEATH_TURNS-th trapped turn it dies: it shrinks
 * away to nothing (World.vanish) and is then removed ('creatureDied', with its position, as
 * it starts). Every trapped turn it lives
 * through, it tries to eat its way out (trappedAct). Returns true when the creature is free to
 * act this turn.
 */
function checkTrapped(world, creature) {
  if (creature.behavior === BEHAVIOR.TRAPPED) {
    const hasGap = !isWalledIn(world, creature); // an empty (or Fog) neighbouring cell frees it
    if (hasGap) {
      creature.behavior = BEHAVIOR.WANDER;
      delete creature.trappedTurns;
      world.emit('creatureFreed', creature);
      return true;
    }
    creature.trappedTurns = (creature.trappedTurns || 0) + 1;
    if (creature.trappedTurns >= TRAPPED_DEATH_TURNS) {
      // it dies: shrinks to nothing where it is, then is removed (World.vanish)
      const at = { x: creature.x, y: creature.y, z: creature.z };
      world.vanish(creature, creature, { distanceCm: 0 });
      world.emit('creatureDied', { creature, ...at });
      return false;
    }
    trappedAct(world, creature);
    return false;
  }
  if (isWalledIn(world, creature)) {
    creature.behavior = BEHAVIOR.TRAPPED;
    creature.trappedTurns = 1; // this turn counts
    delete creature.walkTarget;
    delete creature.walkStuck;
    world.emit('creatureTrapped', creature);
    trappedAct(world, creature);
    return false;
  }
  return true;
}

/**
 * A Trapped creature's turn: it tries to eat something next to it (creatureEatNearby: in
 * front first, never directly behind), which can open a way out. With its inventory full it
 * can't eat, so it just waits.
 */
function trappedAct(world, creature) {
  creatureEatNearby(world, creature);
}

/**
 * Each one-block creature (Crawly, Buzzy) takes its turn according to its `behavior` (see BEHAVIOR):
 * Wander = random steps along its habitat, Wait = stays put, Walk = heads for its
 * `walkTarget` along the shortest path, Trapped = eats to get out (see
 * checkTrapped, which runs first for every creature). They act one at a time in random order, so two
 * creatures never end up in the same cell. Ones in `skip` (already moved this turn) don't move.
 * Returns the number of creatures that moved.
 */
export function stepSoloCreatures(world, skip = new Set()) {
  const creatures = shuffle([...world.soloCreatures]); // every one-block creature (Crawly, Buzzy)
  let moved = 0;
  for (const c of creatures) {
    if (c.vanishing) continue; // dying (shrinking away): it does nothing more
    // being trapped is checked for every creature, even one that fell with its group this turn
    if (!checkTrapped(world, c)) continue; // trapped (or just died): no action this turn
    tickWait(c);
    if (skip.has(c)) continue;
    // left to itself, a creature goes for the food it wants that it can see (and eats one next to it)
    const foraged = forage(world, c, (goal) => firstStepToward(world, c, goal), (to) => world.move(c, to, world.stepSeconds));
    if (foraged) {
      if (foraged === 'moved') moved++;
      continue;
    }
    switch (c.behavior ?? blockProps(c.type).defaultBehavior) {
      case BEHAVIOR.WANDER:
        if (wander(world, c)) moved++;
        break;
      case BEHAVIOR.WAIT:
        break; // stays where it is
      case BEHAVIOR.WALK:
        if (walk(world, c)) moved++;
        break;
    }
  }
  return moved;
}
