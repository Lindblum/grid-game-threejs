// Turn-based simulation: runs once per game second ("turn").
// Order each turn: 1) connected groups not anchored at the origin fall one step toward it,
// 2) Water flows toward the origin, 3) creatures move, 4) trees (Wood groups) drink Water
// and grow Wood or Berries, 5) Dirt absorbs Water and becomes Moss, Plop becomes Wood (all
// only take Water that has been still for 2 turns), 6) every 10th turn, a raindrop (Water) appears 1 m
// from the origin, 7) every 3rd turn, each Nimbus may rain a Water block below it, 8) non-creature
// blocks are bucketed into same-type groups.
import { EDGE_STEPS, GRID, NEIGHBOR_DIRS, cellKey, isValidCell, randomCellOnSphere } from './lattice.js';
import { BEHAVIOR, BLOCK, BLOCK_TYPES, blockProps, isCreature, canWalkOn, canEat, priorityDietOf, isSingleCreature, isChainCreature, canFly, MATE_TURNS, GESTATION_TURNS } from './blocks.js';


/** Chance per turn that a creature carrying something in its inventory excretes it (see maybeExcrete). */
export const EXCRETE_CHANCE = 0.05;
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
 * Splits blocks into connected groups (blocks touching through any of their faces; a chain
 * creature's segments are one group, even where they meet only at an edge, round a corner).
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
      for (const n of world.squirmyOf?.get(b)?.segments ?? []) {
        if (!seen.has(n) && include(n) && linked(b, n)) {
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

/** The lattice direction (one of NEIGHBOR_DIRS) pointing most nearly along (x, y, z); ties at random. */
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
 * the largest shifts one step as a whole, in whichever of the grid's neighbour directions points
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

/** Chance that a Dirt (or Plop) block next to settled Water absorbs it (and turns into Moss / Wood) each turn. */
export const DIRT_ABSORB_CHANCE = 1;

/** The soils that soak up settled Water, and what each becomes when it does. */
const ABSORB_INTO = { [BLOCK.DIRT]: BLOCK.MOSS, [BLOCK.PLOP]: BLOCK.WOOD };

/**
 * Dirt or Plop next to settled Water (see WATER_SETTLE_TURNS) absorbs it: the Water block is
 * deleted — the one closest to the origin, if several touch — and the Dirt becomes Moss, the
 * Plop Wood (ABSORB_INTO). They act one at a time in random order, so each Water is absorbed
 * only once. Returns the number of blocks that changed.
 */
export function stepDirt(world, turn) {
  let changed = 0;
  // only soil touching settled Water can soak it up: find it from the Water side (far
  // fewer blocks to look at than all the Dirt)
  const candidates = new Set();
  for (const w of world.ofType(BLOCK.WATER)) {
    if (!isSettledWater(w, turn)) continue;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const n = world.blocks.get(cellKey(w.x + dx, w.y + dy, w.z + dz));
      if (n && ABSORB_INTO[n.type]) candidates.add(n);
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
    const into = ABSORB_INTO[d.type];
    if (!world.consume(d, w, 'waterSip')) continue; // the Water shrinks into the soil (its slot)
    if (!world.setType(d, into)) continue;
    changed++;
    // a Plop's Water is used up becoming Wood: its slot stays free, so the new tree can drink
    // (a tree only drinks while one of its blocks has an empty slot, see World.freeSlotFor)
    if (into === BLOCK.WOOD) d.inventory = null;
  }
  return changed;
}

/**
 * Whether a chain creature's head (`head`, body `own`) could step into cell (x, y, z): the
 * cell is empty and touches a block it can walk on (walkableBlocks: another chain creature's
 * body counts, so a Squirmy crawls over a Squirmy; its own doesn't hold it up). A creature without
 * `selfAvoidance` (Squirmy) may go next to any chain creature block, its own body or
 * another's (chains keep their own ids, so touching ones don't merge). One with it (Slither)
 * never goes next to another chain creature, nor next to its own body on its very next step
 * (`strict`): only further along a path (by then the body has moved on).
 */
function squirmyCellOk(world, head, own, x, y, z, strict) {
  if (world.blocks.has(cellKey(x, y, z))) return false;
  const avoids = !!blockProps(head.type).selfAvoidance;
  let habitat = false;
  for (const [ex, ey, ez] of NEIGHBOR_DIRS) {
    const n = world.blocks.get(cellKey(x + ex, y + ey, z + ez));
    if (!n || n === head) continue;
    if (isChainCreature(n.type)) {
      if (avoids && (strict || !own.has(n))) return false;
      if (!own.has(n) && canWalkOn(head.type, n.type)) habitat = true; // (another's body is ground to walk on: a Squirmy over a Squirmy; its own isn't)
    } else if (canWalkOn(head.type, n.type)) habitat = true;
  }
  return habitat || canFly(head); // Flight: no surface needed
}

/** Whether `creature` (a one-block creature, or a Squirmy's head) can be sent to cell (x, y, z). */
export function canStand(world, creature, x, y, z) {
  if (!isChainCreature(creature.type)) return isWalkable(world, x, y, z, creature);
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
 * Every 30–60 Wander turns it Burrows for 3–6 (burrow: excrete, eat, go down, round and round).
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
    maybeExcrete(world, head);
    const own = new Set(sq.segments);
    const ok = (x, y, z, steps) => squirmyCellOk(world, head, own, x, y, z, steps === 1);
    if (head.steer) {
      // steered by the player (controlled, or selected): its head goes that way, and a walk it
      // was on ends (steered somewhere it can't go: 'creatureBlocked')
      stopSteeredWalk(head);
      endMate(head);
      const to = steerTo(world, head);
      if (to) {
        moveChain(world, sq.segments, to);
        moved++;
      } else world.emit('creatureBlocked', head);
      continue;
    }
    if (head.behavior === BEHAVIOR.MATE) {
      mateTurn(world, head); // (a chain doesn't clamber about: it stays with its mate)
      continue;
    }
    if (head.isControlled && head.behavior !== BEHAVIOR.WALK) continue; // Creature controls: unsteered, it stays put (unless sent somewhere with Select)
    // now and then a wandering one burrows for a few turns (burrow)
    if ((head.behavior ?? blockProps(head.type).defaultBehavior) === BEHAVIOR.WANDER) maybeStartBurrow(head);
    if (head.behavior === BEHAVIOR.BURROW) {
      if (burrow(world, sq.segments)) moved++;
      continue;
    }
    // left to itself, a Fertile Squirmy goes after one of its kind to mate…
    const courted = seekMate(world, head, (goal) => firstStepToward(world, head, goal, ok), (to) => moveChain(world, sq.segments, to), (x, y, z) => ok(x, y, z, Infinity));
    if (courted) {
      if (courted === 'moved') moved++;
      continue;
    }
    // …else it goes for Berries it can see (and eats one next to it)
    const foraged = forage(world, head, (goal) => firstStepToward(world, head, goal, ok), (to) => moveChain(world, sq.segments, to));
    if (foraged) {
      if (foraged === 'moved') moved++;
      continue;
    }
    let to = null;
    const behavior = head.behavior ?? blockProps(head.type).defaultBehavior;
    if (behavior === BEHAVIOR.WANDER) {
      const cells = [];
      for (const [dx, dy, dz] of stepOffsets(world, head.x, head.y, head.z, head)) {
        const x = head.x + dx, y = head.y + dy, z = head.z + dz;
        if (ok(x, y, z, 1)) cells.push({ x, y, z });
      }
      if (!cells.length && isSupported(world, sq.segments, own)) {
        // nowhere that follows the rules: squeeze into any empty neighbouring cell instead
        // (only while something holds it up: one adrift, e.g. on Fog, stays put and falls)
        for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
          const x = head.x + dx, y = head.y + dy, z = head.z + dz;
          if (!world.blocks.has(cellKey(x, y, z))) cells.push({ x, y, z });
        }
      }
      if (cells.length) to = cells[Math.floor(Math.random() * cells.length)];
    } else if (behavior === BEHAVIOR.WALK && head.pursue) {
      // after another creature: a step toward the cell beside it nearest this head
      const goal = pursuitGoal(world, head, (x, y, z) => ok(x, y, z, Infinity));
      if (goal === 'gone') endWalk(head);
      else if (goal === 'there') {
        if (head.hunt) huntBite(world, head);
        else arriveBeside(world, head);
      } else if (goal) to = firstStepToward(world, head, goal, ok);
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
      // boxed in (no empty cell next to its head): if its head's slot is full it tries to
      // excrete (World.excrete, out behind its tail: only with an item there); otherwise it eats its way out
      // (an edible block next to its head, freeing that cell)
      if (!world.freeSlotFor(head)) world.excrete(world.clusterOf(head), 'excrete');
      else creatureEatNearby(world, head);
    }
  }
  return moved;
}

/** How many Wander turns go by between burrows, and how many turns one lasts (inclusive ranges). */
const BURROW_EVERY_TURNS = [30, 60];
const BURROW_TURNS = [3, 6];
/** A burrowing creature's turns, in order, round and round. */
const BURROW_CYCLE = ['excrete', 'eat', 'down'];
const randomIn = ([lo, hi]) => lo + Math.floor(Math.random() * (hi - lo + 1));

/**
 * A wandering creature that can Burrow (its behaviorList) counts down its Wander turns; when
 * BURROW_EVERY_TURNS have gone by it switches to Burrow for BURROW_TURNS turns. Returns whether it did.
 */
function maybeStartBurrow(head) {
  if (!blockProps(head.type).behaviorList?.includes(BEHAVIOR.BURROW)) return false;
  head.burrowIn ??= randomIn(BURROW_EVERY_TURNS);
  if (--head.burrowIn > 0) return false;
  delete head.burrowIn;
  head.burrowTurns = randomIn(BURROW_TURNS);
  head.burrowStep = 0;
  head.behavior = BEHAVIOR.BURROW;
  return true;
}

/**
 * One Burrow turn of a chain creature (`segments`, head first), the next in BURROW_CYCLE:
 * excrete (what it carries, out behind its tail), eat (the block in the most downward
 * direction, toward the origin), or go down (into the empty cell that way, as dropCell; gravity
 * does the rest). An action it can't do just passes the turn. When its turns are up it goes
 * back to Wander. Returns whether it moved.
 */
function burrow(world, segments) {
  const head = segments[0];
  const step = head.burrowStep ?? 0;
  head.burrowStep = step + 1;
  head.burrowTurns = (head.burrowTurns ?? 1) - 1; // (loaded from a save mid-burrow: one more turn)
  if (head.burrowTurns <= 0) {
    delete head.burrowTurns;
    delete head.burrowStep;
    head.behavior = BEHAVIOR.WANDER;
  }
  const act = BURROW_CYCLE[step % BURROW_CYCLE.length];
  if (act === 'excrete') {
    world.excrete(world.clusterOf(head), 'excrete'); // (only when there's an item in its tail)
  } else if (act === 'eat') {
    for (const c of downwardCells(head)) {
      const food = world.get(c.x, c.y, c.z);
      if (food && !food.vanishing && creatureEat(world, head, food)) break;
    }
  } else {
    const to = dropCell(world, head);
    if (to) {
      moveChain(world, segments, to);
      return true;
    }
  }
  return false;
}

/** Whether `block` has at least one empty neighbouring cell. */
function hasEmptyNeighbor(world, block) {
  return NEIGHBOR_DIRS.some(([dx, dy, dz]) => !world.blocks.has(cellKey(block.x + dx, block.y + dy, block.z + dz)));
}

/**
 * Now and then (EXCRETE_CHANCE a turn) a creature carrying something excretes it, out behind
 * its tail (World.excrete: eaten creatures and Berries come out as Plop). Not one the player
 * controls: it excretes only when told to (B).
 */
function maybeExcrete(world, creature) {
  if (creature.isControlled || Math.random() >= EXCRETE_CHANCE) return;
  world.excrete(world.clusterOf(creature), 'excrete'); // (only when there's an item in its tail)
}

/** Moves a Squirmy's head to `to`; each following segment takes the cell the one ahead of it just left. */
/**
 * Whether a chain creature is held up: some segment touches a block it can walk on (other than
 * its own body; Fog and Nimbus aren't walkable), or it flies.
 */
function isSupported(world, segments, own) {
  const head = segments[0];
  if (canFly(head)) return true;
  return segments.some((seg) => NEIGHBOR_DIRS.some(([dx, dy, dz]) => {
    const n = world.blocks.get(cellKey(seg.x + dx, seg.y + dy, seg.z + dz));
    return n && !own.has(n) && canWalkOn(head.type, n.type);
  }));
}

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
 * given it something to do) with its head's inventory slot free. Its priority foods are
 * its priorityDiet (its type's, plus its buffs', e.g. Rockbiter's Crystal: blocks.js), counting
 * only those it can eat right now (and no Berries while it's Fertile already: only when told to):
 *  - a priority food right next to it: it eats it (creatureEat)
 *  - else one it can see (within its sightRadius): it takes one step along the shortest path
 *    to a cell next to the nearest one it can reach. `stepToward(goal)` finds that step for
 *    this kind of creature, `moveTo(cell)` makes it.
 * Returns 'ate', 'moved', or false (nothing to forage: it does its normal behavior).
 */
function forage(world, creature, stepToward, moveTo) {
  if (creature.isAssignedBehavior || !world.freeSlotFor(creature)) return false;
  const wanted = new Set(priorityDietOf(creature).filter((type) => canEat(creature, type)));
  if (creature.buffs?.some((x) => x.type === 'fertile')) wanted.delete(BLOCK.BERRY); // (Fertile already: Berries only when told to)
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

/**
 * A Fertile creature left to itself (no orders: Wander, `isAssignedBehavior` false), with room
 * for an Egg, courts: beside one of its kind, it starts mating (startMate); else it goes after
 * the first of its kind it saw (`creature.courting`, kept while that one's still around and free),
 * or the nearest it can see now (within its sightRadius): a step toward the cell beside it nearest
 * this one (pursuitGoal with `ok`, the cells it may stand in; `stepToward`, `moveTo` as forage's).
 * Returns 'mated', 'moved', or false (nothing to do: it does its normal behavior).
 */
function seekMate(world, creature, stepToward, moveTo, ok) {
  const behavior = creature.behavior ?? blockProps(creature.type).defaultBehavior;
  if (creature.isAssignedBehavior || behavior !== BEHAVIOR.WANDER || !creature.buffs?.some((x) => x.type === 'fertile') || !world.freeSlotFor(creature)) {
    delete creature.courting;
    return false;
  }
  const beside = mateChoices(world, creature);
  if (beside.length) {
    const pick = beside.find((x) => x.partner === creature.courting) ?? beside[0];
    delete creature.courting;
    return startMate(world, creature, pick.partner) ? 'mated' : false;
  }
  const free = (p) => p && world.blocks.get(cellKey(p.x, p.y, p.z)) === p && !p.vanishing && !p.mate && p.type === creature.type;
  if (!free(creature.courting)) {
    // the first of its kind it sees: the nearest one within sight
    delete creature.courting;
    const own = new Set(world.clusterOf(creature));
    const d2 = (b) => (b.x - creature.x) ** 2 + (b.y - creature.y) ** 2 + (b.z - creature.z) ** 2;
    const seen = offsetsWithin(creature.sightRadius ?? blockProps(creature.type).sightRadius ?? 0)
      .map(([dx, dy, dz]) => world.blocks.get(cellKey(creature.x + dx, creature.y + dy, creature.z + dz)))
      .filter((b) => b && b.type === creature.type && !own.has(b))
      .sort((a, b) => d2(a) - d2(b))
      .map((b) => creatureOfBlock(world, b))
      .find(free);
    if (!seen) return false;
    creature.courting = seen;
  }
  const goal = pursuitGoal(world, creature, ok, creature.courting);
  if (!goal || typeof goal !== 'object') return false;
  const step = stepToward(goal);
  if (!step) return false;
  moveTo(step);
  return 'moved';
}

/** Sound a creature makes consuming a block: sip for Water, eat for anything else. */
const eatSound = (food) => (food.type === BLOCK.WATER ? 'sip' : 'eat');

/**
 * `creature` (a one-block creature, or a Squirmy's head) eats block `food`, if its type is in the
 * creature's diet (or a buff's: canEat) and its head's inventory slot is free (World.consume:
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
  if (wasBerry) {
    // a Berry makes it Fertile: it can Mate with one of its kind (mateChoices), until it does
    world.addBuff(creature, 'fertile', null);
    world.emit('creatureFertile', creature);
  }
  if (creature.type === BLOCK.BUZZY && wasBerry) world.growSegment(creature); // a Buzzy grows a body segment (wings and legs too)
  if (isChainCreature(creature.type) && wasBerry) {
    const body = world.clusterOf(creature);
    const cell = world._wormCell(body);
    // the newest block becomes the tail: it grows in out of the body block it's next to (the
    // old tail, if there was room there), like a Buzzy's segment
    if (cell && world.add(...cell, creature.type, { chain: creature.chain })) {
      const [x, y, z] = cell;
      const from = body.findLast((b) => NEIGHBOR_DIRS.some(([dx, dy, dz]) => b.x + dx === x && b.y + dy === y && b.z + dz === z));
      world.appear(world.get(x, y, z), from ?? body[body.length - 1]);
    }
  }
  return true;
}

/**
 * `creature` (a one-block creature, or a Squirmy's head) eats the block in front of it, or, if it
 * can't eat that one, the edible block next to it closest to its front direction (ties in random
 * order; with no front, any in random order). Returns whether it ate.
 */
export function creatureEatNearby(world, creature) {
  const front = blockInFront(world, creature);
  if (front && creatureEat(world, creature, front)) return true;
  const dirs = shuffle([...NEIGHBOR_DIRS]);
  if (creature.front) {
    const [fx, fy, fz] = creature.front;
    const cos = ([dx, dy, dz]) => (dx * fx + dy * fy + dz * fz) / Math.hypot(dx, dy, dz);
    dirs.sort((a, b) => cos(b) - cos(a)); // (a stable sort: ties keep their shuffled order)
  }
  for (const [dx, dy, dz] of dirs) {
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

/**
 * Offsets to the active grid's cells within `radius` blocks (sphere of radius * 2 cm), cached
 * per grid and radius. Each grid's cells are closed under subtraction, so an offset is a cell
 * offset exactly when it is itself a cell (GRID.isValid); lattice units are GRID.scale cm.
 */
const sightOffsets = new Map();
function offsetsWithin(radius) {
  const key = `${GRID.id}:${radius}`;
  if (!sightOffsets.has(key)) {
    const r = (radius * 2) / GRID.scale, r2 = r * r, n = Math.floor(r + 1e-9), list = [];
    for (let x = -n; x <= n; x++) for (let y = -n; y <= n; y++) for (let z = -n; z <= n; z++) {
      if ((x || y || z) && GRID.isValid(x, y, z) && x * x + y * y + z * z <= r2 + 1e-9) list.push([x, y, z]);
    }
    sightOffsets.set(key, list);
  }
  return sightOffsets.get(key);
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
export const SOLID_TYPES = new Set([BLOCK.STONE, BLOCK.DIRT, BLOCK.PLOP, BLOCK.MOSS, BLOCK.WOOD, BLOCK.BERRY, BLOCK.CRYSTAL]);
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
const SINKABLE_SET = new Set(SINKABLE_TYPES);

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
  // only a cluster touching Water can sink into it: start from the Water side (far fewer blocks
  // to look at than all the Stone and Dirt, which is most of the world)
  const starts = new Set();
  for (const w of world.ofType(BLOCK.WATER)) {
    if (w.vanishing) continue;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const n = world.blocks.get(cellKey(w.x + dx, w.y + dy, w.z + dz));
      if (n && SINKABLE_SET.has(n.type)) starts.add(n);
    }
  }
  for (const type of SINKABLE_TYPES) {
    for (const start of starts) {
      if (start.type !== type || done.has(start) || world.blocks.get(cellKey(start.x, start.y, start.z)) !== start) continue; // (gone, or moved, since)
      const cluster = world.clusterOf(start);
      for (const b of cluster) done.add(b);
      if (cluster.some((block) => skip.has(block) || moved.has(block) || block.vanishing || canFly(block))) continue;
      // holding on to something it can walk on: it doesn't sink (its own body doesn't count:
      // a Squirmy's segments can walk on Squirmy, and every one touches the next); a type that
      // walks on nothing (Stone, Dirt) never holds on
      const members = new Set(cluster);
      const holds = !!blockProps(type).walkableBlocks?.length && cluster.some((block) => NEIGHBOR_DIRS.some(([dx, dy, dz]) => {
        const n = world.blocks.get(cellKey(block.x + dx, block.y + dy, block.z + dz));
        return n && !members.has(n) && canWalkOn(block.type, n.type);
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
 * (any of its neighbours); a Buzzy in mid-air (isAirborneBuzzy) always does, it can't
 * hover. Returns whether it moved.
 */
function wander(world, creature) {
  if (Math.random() >= WANDER_MOVE_CHANCE && !isAirborneBuzzy(world, creature)) return false;
  const options = [];
  for (const [dx, dy, dz] of stepOffsets(world, creature.x, creature.y, creature.z, creature)) {
    const x = creature.x + dx, y = creature.y + dy, z = creature.z + dz;
    if (isWalkable(world, x, y, z, creature)) options.push({ x, y, z });
  }
  if (!options.length) return false;
  const to = options[Math.floor(Math.random() * options.length)];
  return world.move(creature, to, world.stepSeconds);
}

/**
 * The offsets a creature (`self`: one-block, or a chain's head) at (x, y, z) may step along: its neighbours, plus
 * (Cube mode) the EDGE_STEPS across one of its cube's edges where at least one of the two cells
 * beside that edge is open, so it goes up a step or round a corner but never squeezes between
 * two blocks (round an edge it slides along an arc: World.edgeVia).
 */
function stepOffsets(world, x, y, z, self) {
  if (!EDGE_STEPS.length) return NEIGHBOR_DIRS;
  const open = (cx, cy, cz) => {
    const b = world.blocks.get(cellKey(cx, cy, cz));
    return !b || b === self;
  };
  return [
    ...NEIGHBOR_DIRS,
    ...EDGE_STEPS.filter(([dx, dy, dz]) => (dx && open(x + dx, y, z)) || (dy && open(x, y + dy, z)) || (dz && open(x, y, z + dz))),
  ];
}

/**
 * The whole shortest path a Walk to cell `t` would take (firstStepToward's search, with the
 * rules the creature's turn uses: a chain's head squirmyCellOk, else isWalkable): its cells,
 * first step .. `t`; null if there's none (within WALK_SEARCH_LIMIT).
 */
export function pathToward(world, creature, t) {
  const ok = walkRules(world, creature);
  if (!ok(t.x, t.y, t.z, Infinity)) return null;
  const goal = cellKey(t.x, t.y, t.z), start = cellKey(creature.x, creature.y, creature.z);
  const parent = new Map([[start, null]]); // visited cell -> the cell it was reached from
  const queue = [{ x: creature.x, y: creature.y, z: creature.z, steps: 0, k: start }];
  for (let i = 0; i < queue.length && parent.size < WALK_SEARCH_LIMIT; i++) {
    const p = queue[i];
    for (const [dx, dy, dz] of stepOffsets(world, p.x, p.y, p.z, creature)) {
      const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz, steps: p.steps + 1 };
      q.k = cellKey(q.x, q.y, q.z);
      if (parent.has(q.k) || !ok(q.x, q.y, q.z, q.steps)) continue;
      parent.set(q.k, p);
      if (q.k === goal) {
        const cells = [];
        for (let n = q; n && n.k !== start; n = parent.get(n.k)) cells.push({ x: n.x, y: n.y, z: n.z });
        return cells.reverse();
      }
      queue.push(q);
    }
  }
  return null;
}

/** Most cells one Walk path search may visit (keeps a turn cheap in big builds). */
const WALK_SEARCH_LIMIT = 5000;
/** A walking creature that finds no path this many turns in a row gives up and Wanders. */
export const WALK_GIVE_UP_TURNS = 5;

/**
 * First step of a shortest path (fewest steps) from creature `creature` to cell `t`, found by
 * breadth-first search; null if there is none. `ok(x, y, z, steps)` says whether a cell can
 * be stepped into `steps` moves from now (default: the creature's isWalkable). Creatures also
 * take Cube mode's edge steps (stepOffsets; a chain's body follows its head round the edge).
 */
function firstStepToward(world, creature, t, ok = (x, y, z) => isWalkable(world, x, y, z, creature)) {
  if (!ok(t.x, t.y, t.z, Infinity)) return null;
  const goal = cellKey(t.x, t.y, t.z);
  const firstStep = new Map([[cellKey(creature.x, creature.y, creature.z), null]]); // visited cell -> first step on its path
  const queue = [{ x: creature.x, y: creature.y, z: creature.z, steps: 0 }];
  for (let i = 0; i < queue.length && firstStep.size < WALK_SEARCH_LIMIT; i++) {
    const p = queue[i];
    const via = firstStep.get(cellKey(p.x, p.y, p.z));
    for (const [dx, dy, dz] of stepOffsets(world, p.x, p.y, p.z, creature)) {
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
  if (creature.pursue) {
    // after another creature (sent with Select): a step toward the cell beside it nearest this one, every turn
    const goal = pursuitGoal(world, creature, (x, y, z) => isWalkable(world, x, y, z, creature));
    if (goal === 'gone') {
      endWalk(creature);
      return false;
    }
    if (goal === 'there') {
      if (creature.hunt) huntBite(world, creature); // (beside it, hunting it: a bite)
      else arriveBeside(world, creature); // (beside it: there, it can't go into it)
      return false;
    }
    if (!goal) return false; // (no room by it: waits for it to move)
    const next = firstStepToward(world, creature, goal);
    return !!next && world.move(creature, next, world.stepSeconds);
  }
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

/** The cells a Walk may step into, `ok(x, y, z, steps)` (its turn's rules: a chain's head squirmyCellOk, else isWalkable). */
function walkRules(world, creature) {
  if (!isChainCreature(creature.type)) return (x, y, z) => isWalkable(world, x, y, z, creature);
  const own = new Set(world.squirmyOf.get(creature)?.segments ?? [creature]);
  return (x, y, z, steps) => squirmyCellOk(world, creature, own, x, y, z, steps === 1);
}

/** The cell beside `quarry` that `creature` would head for to go after it (pursuitGoal), or null (beside it already, or no room). */
export function pursuitCell(world, creature, quarry) {
  const goal = pursuitGoal(world, creature, walkRules(world, creature), quarry);
  return typeof goal === 'object' ? goal : null;
}

/**
 * A hunting creature (`creature.hunt`: sent to eat its quarry, Consume with Select) beside its
 * quarry: it turns to face it if it's right behind, and eats it (creatureEat: its diet). Eaten,
 * the hunt is over. Returns whether it ate.
 */
function huntBite(world, creature) {
  const q = creature.pursue;
  if (isBehind(creature, q)) {
    const d = [q.x - creature.x, q.y - creature.y, q.z - creature.z];
    creature.front = NEIGHBOR_DIRS.find(([dx, dy, dz]) => dx === d[0] && dy === d[1] && dz === d[2]) ?? creature.front;
    world.eyes.track(creature, world.stepSeconds * 0.5, world.time);
  }
  if (!creatureEat(world, creature, q)) return false;
  endWalk(creature);
  return true;
}

/** A creature pursuing another (not to eat it) has got beside it: the pursuit is over, it goes back to wandering (selected or not). */
function arriveBeside(world, creature) {
  endWalk(creature);
  creature.behavior = BEHAVIOR.WANDER;
  world.emit('creatureArrived', creature);
}

/** Whether cell `b` is beside `creature`'s head (one of NEIGHBOR_DIRS from it). */
const besideHead = (creature, b) =>
  NEIGHBOR_DIRS.some(([dx, dy, dz]) => b.x - creature.x === dx && b.y - creature.y === dy && b.z - creature.z === dz);

/**
 * Where a creature pursuing another (`creature.pursue`, sent after it with Select) heads this
 * turn: of the cells beside its quarry (a chain's head) that `ok` lets it stand in, the nearest
 * to it; 'there' when it's beside its quarry already (hunting, beside its head, to bite it;
 * else beside any of its blocks); 'gone' when the quarry is no longer in the world (the pursuit
 * ends); null when there's no room beside it just now. `q`: another quarry.
 */
function pursuitGoal(world, creature, ok, q = creature.pursue) {
  if (!q || world.get(q.x, q.y, q.z) !== q) return 'gone';
  if (besideHead(creature, q)) return 'there';
  if (!creature.hunt && world.clusterOf(q).some((b) => besideHead(creature, b))) return 'there';
  let best = null, bestD = Infinity;
  for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
    const x = q.x + dx, y = q.y + dy, z = q.z + dz;
    const dist = (x - creature.x) ** 2 + (y - creature.y) ** 2 + (z - creature.z) ** 2;
    if (dist >= bestD || !ok(x, y, z)) continue;
    best = { x, y, z };
    bestD = dist;
  }
  return best;
}

// ---------------------------------------------------------------- mating and eggs

/** The creature block `block` belongs to (a Buzzy segment's head, a chain's head, a one-block creature), or null. */
function creatureOfBlock(world, block) {
  if (!block || !isCreature(block.type)) return null;
  if (block.segmentOf) return block.segmentOf;
  if (isChainCreature(block.type)) return world.squirmyOf.get(block)?.segments[0] ?? block;
  return block;
}

/**
 * Who creature `c` (one-block, or a chain's head) could Mate with right now: [{ partner, cell }]
 * (the partner's block beside it). It must be Fertile (a Berry), not mating already, with room
 * in its head's slot for the Egg; a partner is another of its kind beside its head, not mating.
 */
export function mateChoices(world, c) {
  if (!c?.buffs?.some((x) => x.type === 'fertile') || c.mate || c.vanishing || !world.freeSlotFor(c)) return [];
  const out = [], seen = new Set();
  for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
    const b = world.blocks.get(cellKey(c.x + dx, c.y + dy, c.z + dz));
    const p = creatureOfBlock(world, b);
    if (!p || p === c || p.type !== c.type || p.mate || p.vanishing || seen.has(p)) continue;
    seen.add(p);
    out.push({ partner: p, cell: b });
  }
  return out;
}

/** Creature `a` starts mating with `b` (one of mateChoices): both Mate for MATE_TURNS turns (`a` stays Fertile until its Egg forms: mateTurn). Returns whether it began. */
export function startMate(world, a, b) {
  if (!mateChoices(world, a).some((x) => x.partner === b)) return false;
  for (const [c, other, initiator] of [[a, b, true], [b, a, false]]) {
    delete c.walkTarget;
    delete c.pursue;
    delete c.hunt;
    delete c.walkStuck;
    c.mate = { partner: other, turns: MATE_TURNS, initiator };
    c.behavior = BEHAVIOR.MATE;
  }
  world.emit('creatureMating', a);
  return true;
}

/**
 * A mating creature's turn (BEHAVIOR.MATE; the one that started it runs the pair): they
 * clamber over each other (swap cells: one-block creatures), with the 'creatureMating' sound,
 * for MATE_TURNS turns; then the one that started it carries an Egg in its head's slot
 * ('eggMade'), and both go back to what they do. A mate gone meanwhile ends it. Returns whether it moved.
 */
function mateTurn(world, c) {
  const m = c.mate, p = m?.partner;
  if (!m || !p || world.blocks.get(cellKey(p.x, p.y, p.z)) !== p || p.vanishing || p.mate?.partner !== c) {
    endMate(c);
    return false;
  }
  if (!m.initiator) return false; // (its partner runs the pair)
  if (--m.turns > 0) {
    world.emit('creatureMating', c);
    return world.swap(c, p);
  }
  const slot = world.freeSlotFor(c);
  if (slot) {
    slot.inventory = BLOCK.EGG;
    world.removeBuff(c, 'fertile'); // (its Egg: Fertile no longer)
    world.emit('eggMade', c);
  }
  endMate(c);
  return false;
}

/** Mating is over for creature `c` (and its partner): each goes back to waiting (selected) or wandering. */
function endMate(c) {
  const p = c?.mate?.partner;
  for (const x of [c, p]) {
    if (!x) continue;
    if (x === p && x.mate?.partner !== c) continue; // (it's moved on to another: leave it be)
    delete x.mate;
    if (x.behavior === BEHAVIOR.MATE) x.behavior = x.isSelected ? BEHAVIOR.WAIT : BEHAVIOR.WANDER; // (also one restored mid-mating, its partner gone)
  }
}

/**
 * Every turn: each Egg counts down to hatching (GESTATION_TURNS after it was laid or placed, or
 * loaded) and then hatches (World.hatch: it shrinks away, its creature grows in). Its spots
 * follow the creature inside it.
 */
export function stepEggs(world) {
  for (const egg of [...world.ofType(BLOCK.EGG)]) {
    if (egg.vanishing) continue;
    if (egg.spotsOf !== egg.inventory) world._refreshLook(egg); // (loaded, or just laid: its spots)
    egg.hatchTurn ??= world.turn + GESTATION_TURNS;
    if (world.turn >= egg.hatchTurn) world.hatch(egg);
  }
}

/** A creature the player steers stops any walk it was sent on (Select), and waits once the steering stops. */
function stopSteeredWalk(creature) {
  if (creature.behavior !== BEHAVIOR.WALK) return;
  delete creature.pursue;
  delete creature.hunt;
  delete creature.walkTarget;
  delete creature.walkStuck;
  creature.behavior = BEHAVIOR.WAIT;
  creature.heldBehavior = BEHAVIOR.WANDER;
}

/**
 * A timed Wait (`creature.waitTurns`: from saves made when selecting set one) counts down a turn; at 0
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
  delete creature.pursue;
  delete creature.hunt;
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

/**
 * Creature controls (the player steering `creature`: `creature.steer`, a direction in lattice
 * space set by the engine): of the neighbouring cells `ok(x, y, z)` allows, the one most nearly
 * in the steer direction (within about 70° of it; `anyWay`: whichever way it's steered); null
 * if none, or not steered. The steer is used up (unless `keep`: a preview, see
 * nextSteppedCell): the player's input since the last turn moves it one step. `dirs`: the
 * offsets it may step along (default: its neighbours).
 */
export function steeredCell(creature, ok, dirs = NEIGHBOR_DIRS, { keep = false, anyWay = false } = {}) {
  const s = creature.steer;
  if (!keep) delete creature.steer;
  if (!s) return null;
  let best = null, bestDot = anyWay ? -Infinity : 0.35; // anyWay: steered at all is enough
  for (const [dx, dy, dz] of dirs) {
    const dot = (dx * s[0] + dy * s[1] + dz * s[2]) / Math.hypot(dx, dy, dz);
    if (dot <= bestDot) continue;
    const x = creature.x + dx, y = creature.y + dy, z = creature.z + dz;
    if (!ok(x, y, z)) continue;
    best = { x, y, z };
    bestDot = dot;
  }
  return best;
}

/**
 * Where a controlled creature (one-block, or a chain's head) may step when steered:
 * { ok(x, y, z), dirs, anyWay } for steeredCell, the same rules its turn uses (a chain's head:
 * squirmyCellOk next step; a one-block creature: isWalkable; both with Cube mode's edge steps).
 * With nowhere to walk, it may drop into the empty cell straight below its head (dropCell),
 * whichever way it's steered (anyWay), and gravity takes it from there.
 */
function steerRules(world, creature) {
  const rules = isChainCreature(creature.type)
    ? (() => {
        const own = new Set(world.squirmyOf.get(creature)?.segments ?? [creature]);
        return { ok: (x, y, z) => squirmyCellOk(world, creature, own, x, y, z, true), dirs: stepOffsets(world, creature.x, creature.y, creature.z, creature) };
      })()
    : { ok: (x, y, z) => isWalkable(world, x, y, z, creature), dirs: stepOffsets(world, creature.x, creature.y, creature.z, creature) };
  if (rules.dirs.some(([dx, dy, dz]) => rules.ok(creature.x + dx, creature.y + dy, creature.z + dz))) return rules;
  const drop = dropCell(world, creature);
  if (!drop) return rules;
  return { ok: (x, y, z) => x === drop.x && y === drop.y && z === drop.z, dirs: [[drop.x - creature.x, drop.y - creature.y, drop.z - creature.z]], anyWay: true };
}

/**
 * The empty cell beside `creature` in the most downward direction (toward the origin: the
 * lattice direction(s) nearest the line to it), or null if that's taken, or it is at the origin.
 */
function dropCell(world, creature) {
  return downwardCells(creature).find((c) => !world.has(c.x, c.y, c.z)) ?? null; // (ties: the first that's free, so the preview agrees with the turn)
}

/** The valid cells beside `creature` in the most downward direction (toward the origin; several when tied); none at the origin. */
function downwardCells(creature) {
  const { x, y, z } = creature;
  const len = Math.hypot(x, y, z);
  if (!len) return [];
  let bestCos = -Infinity, cells = [];
  for (const d of NEIGHBOR_DIRS) {
    const cos = -(d[0] * x + d[1] * y + d[2] * z) / (Math.hypot(...d) * len);
    if (cos > bestCos + 1e-9) {
      bestCos = cos;
      cells = [];
    }
    if (cos >= bestCos - 1e-9) cells.push({ x: x + d[0], y: y + d[1], z: z + d[2] });
  }
  return cells.filter((c) => isValidCell(c.x, c.y, c.z));
}

/** steeredCell under the creature's steer rules (steerRules); `keep`: a preview. */
function steerTo(world, creature, keep = false) {
  const { ok, dirs, anyWay } = steerRules(world, creature);
  return steeredCell(creature, ok, dirs, { keep, anyWay });
}

/** The cell a controlled creature will step into on its next turn, as steered right now (its `steer` is kept); null if none. */
export function nextSteppedCell(world, creature) {
  return creature.steer ? steerTo(world, creature, true) : null;
}

/** The cells a controlled creature could step into on its next turn, whichever way it is steered. */
export function steppableCells(world, creature) {
  const { ok, dirs } = steerRules(world, creature);
  const cells = [];
  for (const [dx, dy, dz] of dirs) {
    const x = creature.x + dx, y = creature.y + dy, z = creature.z + dz;
    if (ok(x, y, z)) cells.push({ x, y, z });
  }
  return cells;
}

/** The blocks next to `creature` it could eat right now (its diet, or a buff's; not the one right behind it): what an aimed Eat chooses from. */
export function edibleNeighbors(world, creature) {
  const out = [];
  for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
    const n = world.blocks.get(cellKey(creature.x + dx, creature.y + dy, creature.z + dz));
    if (n && !n.vanishing && canEat(creature, n.type) && !isBehind(creature, n)) out.push(n);
  }
  return out;
}

/** The empty cells next to `creature`'s tail (its own block, if it has no body), which an aimed Excrete chooses from (World.excrete's `cell`). */
export function excretableCells(world, creature) {
  const tail = world.clusterOf(creature).at(-1);
  return NEIGHBOR_DIRS.map(([dx, dy, dz]) => ({ x: tail.x + dx, y: tail.y + dy, z: tail.z + dz }))
    .filter((c) => isValidCell(c.x, c.y, c.z) && !world.blocks.has(cellKey(c.x, c.y, c.z)));
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
    maybeExcrete(world, c);
    if (c.steer) {
      // steered by the player (controlled, or selected): it goes that way, and a walk it was on
      // ends (steered somewhere it can't go: 'creatureBlocked')
      stopSteeredWalk(c);
      endMate(c);
      const to = steerTo(world, c);
      if (to && world.move(c, to, world.stepSeconds)) moved++;
      else world.emit('creatureBlocked', c);
      continue;
    }
    if (c.behavior === BEHAVIOR.MATE) {
      if (mateTurn(world, c)) moved++;
      continue;
    }
    if (c.isControlled) {
      // Creature controls: unsteered, it stays put, unless sent somewhere with Select
      if (c.behavior === BEHAVIOR.WALK && walk(world, c)) moved++;
      continue;
    }
    // left to itself, a Fertile creature goes after one of its kind to mate…
    const courted = seekMate(world, c, (goal) => firstStepToward(world, c, goal), (to) => world.move(c, to, world.stepSeconds), (x, y, z) => isWalkable(world, x, y, z, c));
    if (courted) {
      if (courted === 'moved') moved++;
      continue;
    }
    // …else it goes for the food it wants that it can see (and eats one next to it)
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
