// Critter needs: every creature block has its own HP, Sate (hunger health) and Quench (thirst
// health), so a bite can kill one segment of a Squirmy and leave two Squirmies.
//
//  - Now and then (its type's `needs.hunger.every`, in turns) a critter has a hunger pang:
//    every block of it loses `needs.hunger.loss` Sate ('creaturePang', kind 'hunger': an orange
//    pulse and a stomach grumble). A block with no Sate left loses HP instead ('creatureHurt',
//    cause 'hunger': a red pulse). Thirst pangs work the same on Quench ('thirst': yellow).
//  - Eating restores Sate to the whole body (World creature eats: creatureEat), drinking Water
//    restores Quench.
//  - Below HUNGRY of its Sate (or Quench), a critter left to itself goes for anything edible it
//    can see (sim.js forage), not just its favourite foods.
//  - A predator's bite takes `needs.bite` HP from the prey's block ('creatureHurt', cause
//    'bite'); only the bite that takes it to 0 eats it.
//  - A block at 0 HP dies: it becomes Glop (World.dieBlock; the whole critter: World.die).
//  - Every HEAL_EVERY turns a block with at least HEAL_AT of its Sate and of its Quench heals
//    HEAL_HP, up to its type's full HP ('creatureHeal').
//
// The values are shown only in the Debug panel's Inspector. Blocks get them when first needed
// (a creature placed, born, grown or loaded from an older save starts full).
import { BLOCK, blockProps, isChainCreature, isCreature } from './blocks.js';

/** Sate and Quench run from 0 to this. */
export const MAX_SATE = 100;
export const MAX_QUENCH = 100;
/** Below this share of its Sate (or Quench), a critter eats (or drinks) anything it can. */
export const HUNGRY = 0.75;
/** Sate one eaten block gives every block of the eater: a creature (meat), or anything else. */
export const MEAT_SATE = 50;
export const FOOD_SATE = 30;
/** Quench one drink of Water gives every block of the drinker. */
export const DRINK_QUENCH = 35;
/** HP a pang takes from a block with no Sate (or Quench) left. */
export const PANG_DAMAGE = 1;

/** Healing: every this many turns, a block at or above HEAL_AT of both its Sate and Quench gets HEAL_HP back. */
export const HEAL_EVERY = 5;
export const HEAL_AT = 0.5;
export const HEAL_HP = 1;

/** Type `type`'s needs (blocks.js `needs`). */
export const needsOfType = (type) => blockProps(type).needs ?? null;

/** Creature block `block`'s HP, Sate and Quench, giving it full ones if it has none yet. */
export function needsOf(block) {
  const t = needsOfType(block.type);
  if (!t) return block;
  block.hp ??= t.hp;
  block.sate ??= MAX_SATE;
  block.quench ??= MAX_QUENCH;
  return block;
}

/** Whether creature `creature` (its head) wants food: Sate below HUNGRY. */
export const isHungry = (creature) => needsOf(creature).sate < HUNGRY * MAX_SATE;
/** Whether creature `creature` (its head) wants Water: Quench below HUNGRY. */
export const isThirsty = (creature) => needsOf(creature).quench < HUNGRY * MAX_QUENCH;

/** A whole number from [lo, hi]. */
const randomIn = ([lo, hi]) => lo + Math.floor(Math.random() * (hi - lo + 1));

/**
 * A creature whose blocks are `body` ate a block of `foodType`: Water restores Quench to every
 * block of it, anything else Sate (more for a creature).
 */
export function feed(body, foodType) {
  const water = foodType === BLOCK.WATER;
  const amount = water ? DRINK_QUENCH : isCreature(foodType) ? MEAT_SATE : FOOD_SATE;
  for (const b of body) {
    const n = needsOf(b);
    if (water) n.quench = Math.min(MAX_QUENCH, n.quench + amount);
    else n.sate = Math.min(MAX_SATE, n.sate + amount);
  }
}

/**
 * Predator `by` bites prey block `prey` (a creature's): it loses the predator's bite in HP
 * ('creatureHurt', cause 'bite'). Returns whether that killed it (0 HP: it can be eaten now).
 */
export function bite(world, by, prey) {
  const n = needsOf(prey);
  n.hp = Math.max(0, n.hp - (needsOfType(by.type)?.bite ?? 1));
  world.emit('creatureHurt', { block: prey, by, cause: 'bite' });
  return n.hp <= 0;
}

/**
 * One turn of every critter's needs: pangs come due (each critter counts its own down, from
 * its type's ranges), take Sate / Quench or, with none left, HP; blocks at 0 HP die (World.die
 * for a whole critter, else World.dieBlock each: a chain splits round them). Returns how many pangs.
 */
export function stepNeeds(world) {
  const bodies = [];
  for (const c of world.soloCreatures) if (!c.vanishing) bodies.push(world.clusterOf(c));
  for (const sq of world.squirmies) if (sq.segments.length && !sq.segments[0].vanishing) bodies.push(sq.segments);
  let pangs = 0;
  for (const body of bodies) {
    const head = body[0];
    const t = needsOfType(head.type);
    if (!t) continue;
    for (const [kind, key, counter] of [['hunger', 'sate', 'hungerIn'], ['thirst', 'quench', 'thirstIn']]) {
      const need = t[kind];
      if (!need) continue;
      head[counter] ??= randomIn(need.every);
      if (--head[counter] > 0) continue;
      head[counter] = randomIn(need.every);
      pangs++;
      world.emit('creaturePang', { block: head, kind });
      for (const b of body) {
        const n = needsOf(b);
        if (n[key] > 0) n[key] = Math.max(0, n[key] - need.loss);
        else {
          n.hp = Math.max(0, n.hp - PANG_DAMAGE);
          world.emit('creatureHurt', { block: b, cause: kind });
        }
      }
    }
    // well fed and watered: heal a bit now and then
    if ((world.turn ?? 0) % HEAL_EVERY === 0) {
      let healed = false;
      for (const b of body) {
        const n = needsOf(b);
        if (n.hp > 0 && n.hp < t.hp && n.sate >= HEAL_AT * MAX_SATE && n.quench >= HEAL_AT * MAX_QUENCH) {
          n.hp = Math.min(t.hp, n.hp + HEAL_HP);
          healed = true;
        }
      }
      if (healed) world.emit('creatureHeal', { block: head });
    }
    const dead = body.filter((b) => b.hp != null && b.hp <= 0);
    if (!dead.length) continue;
    if (dead.length === body.length || (dead.includes(head) && !isChainCreature(head.type))) {
      // the whole critter (or a one-block critter's head): it dies, its body Glop
      const at = { x: head.x, y: head.y, z: head.z };
      world.die(head);
      world.emit('creatureDied', { creature: head, ...at });
    } else {
      for (const b of dead) world.dieBlock(b);
    }
  }
  return pangs;
}
