// Block types and their properties, in one place.
//
// BLOCK_TYPES has one entry per block type. Properties:
//   key             constant name: BLOCK[key] is the id (BLOCK.STONE, …)
//   id              save-file id; never change it (older saves would stop loading). The
//                   first types kept their original colour names; newer ones use plain ids
//   name            display name (tool label, debug panel); lowercased, the BLOCK_STYLE name
//   color           base colour (instance colour, tool icon, Solid materials mode)
//   style           surface shader number (the per-instance blockStyle.x in the block
//                   shader; each shader branch in geometry.js is keyed on it). Unique; 0 is
//                   the plain, flat-colour style
//   opacity         1 = solid; below 1 = see-through: drawn by the translucent pass, casts no
//                   ambient occlusion, and this is its alpha in Solid materials mode
//   hidden          true: never drawn (Void)
//   shadeFlat       true: always drawn with flat faces. With Options → Rendering: Smooth, its bundles are
//                   merged but keep their sharp edges and flat face normals instead of being
//                   rounded off and smooth-shaded (Crystal: a faceted gem)
// Creatures also have:
//   creature        true
//   body            'single' (one block: Crawly, Buzzy) or 'chain' (a Squirmy's segments)
//   fly             true: it flies (like the Flight buff): any empty cell is a floor, never falls
//   wings           true: two translucent wings on its sides that flap every turn
//   legs            true: six black legs on its floor side that step every turn
//   diet            keys of the block types it can consume (World.consume); CREATURE_DIET and
//                   blockProps(type).diet give them as ids
//   priorityDiet    keys of the foods it goes for on its own when it sees one (and eats once
//                   next to it), if the player hasn't given it orders; buffs can add more
//                   (see priorityDietOf). Only foods it can eat right now count
//   walkableBlocks  keys of the block types it can walk along: it can only stand in a cell
//                   touching one of them (as ids, like diet, once the table is built)
//   sightRadius     how far it sees, in blocks (1 block = 2 cm); it clears Fog within it
//   behaviorList    the behaviors it can have (from BEHAVIOR)
//   defaultBehavior the behavior it starts with
//   eyeScale        eye size relative to a block
//   eatBuffs        { foodKey: { buff, turns, charges } }: eating that food gives it that buff
//                   (BUFF_TYPES), lasting `turns` turns (null: no time limit) and/or `charges`
//                   uses (see below; null or left out: no limit)
//
// Any block can carry buffs: `b.buffs = [{ type, turns, charges }]`. `turns` counts down each
// turn (null: permanent); `charges` counts down each time the creature eats a block from the
// buff's own priorityDiet (null: unlimited). The buff expires when either reaches 0.

/** Everything a creature can be doing on its turn (stored on the block as `behavior`, saved with it). */
export const BEHAVIOR = Object.freeze({
  WANDER: 'wander', // random steps along the surfaces it walks on
  WAIT: 'wait', // stays where it is (e.g. while selected)
  WALK: 'walk', // heads for `walkTarget` (set with the Select tool) by the shortest path
  TRAPPED: 'trapped', // walled in on all sides: does nothing; freed by a gap, dies if it lasts too long
});

export const BLOCK_TYPES = [
  { key: 'STONE', id: 'gray', name: 'Stone', color: '#9aa0a6', style: 2, opacity: 1 },
  { key: 'DIRT', id: 'brown', name: 'Dirt', color: '#8b5a2b', style: 1, opacity: 1 },
  { key: 'BERRY', id: 'red', name: 'Berry', color: '#e53935', style: 5, opacity: 1 },
  { key: 'WOOD', id: 'orange', name: 'Wood', color: '#b8804a', style: 7, opacity: 1 }, // warm tan
  { key: 'CRYSTAL', id: 'yellow', name: 'Crystal', color: '#e03cd2', style: 8, opacity: 0.9, shadeFlat: true }, // magenta gem
  { key: 'MOSS', id: 'green', name: 'Moss', color: '#43a047', style: 4, opacity: 1 },
  { key: 'WATER', id: 'blue', name: 'Water', color: '#1e88e5', style: 3, opacity: 0.55 },
  {
    key: 'CRAWLY', id: 'magenta', name: 'Crawly', color: '#d63ad6', style: 6, opacity: 1,
    creature: true,
    body: 'single',
    legs: true,
    diet: ['BERRY'],
    priorityDiet: ['BERRY'],
    walkableBlocks: ['STONE', 'DIRT', 'MOSS', 'CRYSTAL', 'WOOD', 'BERRY'],
    sightRadius: 2,
    behaviorList: [BEHAVIOR.WANDER, BEHAVIOR.WAIT, BEHAVIOR.WALK, BEHAVIOR.TRAPPED],
    defaultBehavior: BEHAVIOR.WANDER,
    eyeScale: 0.25,
    eatBuffs: { BERRY: { buff: 'rockbiter', turns: null, charges: 5 } },
  },
  {
    // like a Crawly, but it flies (as if it always had the Flight buff)
    key: 'BUZZY', id: 'buzzy', name: 'Buzzy', color: '#1f5a3c', style: 12, opacity: 1, // dark green, pearlescent
    creature: true,
    body: 'single',
    fly: true,
    wings: true,
    legs: true,
    diet: ['BERRY'],
    priorityDiet: ['BERRY'],
    walkableBlocks: ['STONE', 'DIRT', 'MOSS', 'CRYSTAL', 'WOOD', 'BERRY'],
    sightRadius: 3,
    behaviorList: [BEHAVIOR.WANDER, BEHAVIOR.WAIT, BEHAVIOR.WALK, BEHAVIOR.TRAPPED],
    defaultBehavior: BEHAVIOR.WANDER,
    eyeScale: 0.25,
  },
  {
    key: 'SQUIRMY', id: 'squirmy', name: 'Squirmy', color: '#f07898', style: 11, opacity: 1, // pink
    creature: true,
    body: 'chain',
    diet: ['BERRY', 'DIRT', 'WATER'],
    priorityDiet: ['BERRY'],
    walkableBlocks: ['STONE', 'DIRT', 'MOSS', 'CRYSTAL', 'WOOD', 'BERRY'], // the solid ones
    sightRadius: 1, // around its head
    behaviorList: [BEHAVIOR.WANDER, BEHAVIOR.WAIT, BEHAVIOR.WALK], // the head's behavior drives the chain
    defaultBehavior: BEHAVIOR.WANDER,
    eyeScale: 0.25,
  },
  { key: 'FOG', id: 'fog', name: 'Fog', color: '#d3d7dd', style: 9, opacity: 0.8 }, // light gray
  { key: 'NIMBUS', id: 'nimbus', name: 'Nimbus', color: '#5b616b', style: 10, opacity: 0.8 }, // dark gray
  // world-creation helper: a placeholder that takes up cells while the NEW_SCENE_RECIPE runs
  // (e.g. to leave a cave or gap), then every Void is deleted (World.generateNew). Never drawn.
  { key: 'VOID', id: 'void', name: 'Void', color: '#ffffff', style: 13, opacity: 1, hidden: true },
];

/**
 * Block type ids by key (BLOCK.STONE === 'gray', …), built from BLOCK_TYPES. Always refer
 * to block types through these constants.
 */
export const BLOCK = Object.freeze(Object.fromEntries(BLOCK_TYPES.map((t) => [t.key, t.id])));

// diets and walkable blocks are written as keys (the table can't refer to BLOCK while BLOCK
// is built from it); turn them into ids
for (const t of BLOCK_TYPES) {
  for (const field of ['diet', 'priorityDiet', 'walkableBlocks']) {
    if (!t[field]) continue;
    t[field] = t[field].map((k) => {
      if (!BLOCK[k]) throw new Error(`BLOCK_TYPES: ${t.name}.${field} has unknown key ${k}`);
      return BLOCK[k];
    });
  }
}

/**
 * Buffs: effects a block carries (`b.buffs = [{ type, turns, charges }]`): `turns` counted
 * down each turn by World.tickBuffs (null: permanent), `charges` by World.useBuffCharges
 * each time it eats one of the buff's priorityDiet foods (null: unlimited). Properties:
 *   name   display name (debug panel)
 *   diet   extra block types a creature can eat while it has the buff
 *   priorityDiet  extra foods it goes for on its own when it sees one (see priorityDietOf)
 *   color  the block is drawn in this colour while it has the buff (a creature's shell turns
 *          it, metallic)
 *   fly    it can stand in / move through any empty cell (no floor needed), and doesn't fall
 */
export const BUFF_TYPES = Object.freeze({
  rockbiter: {
    name: 'Rockbiter', color: '#e2b227', // gold
    diet: [BLOCK.STONE, BLOCK.CRYSTAL], // bites through Stone and Crystal…
    priorityDiet: [BLOCK.CRYSTAL], // …and goes after any Crystal it sees
  },
  flight: { name: 'Flight', fly: true }, // any empty cell is a floor to it, and it never falls
});

// eatBuffs are written with food keys too; check they name real foods and buffs
for (const t of BLOCK_TYPES) {
  if (!t.eatBuffs) continue;
  t.eatBuffs = Object.fromEntries(Object.entries(t.eatBuffs).map(([k, v]) => {
    if (!BLOCK[k]) throw new Error(`BLOCK_TYPES: ${t.name}.eatBuffs has unknown food key ${k}`);
    if (!BUFF_TYPES[v.buff]) throw new Error(`BLOCK_TYPES: ${t.name}.eatBuffs has unknown buff ${v.buff}`);
    return [BLOCK[k], v];
  }));
}

/**
 * Shader style numbers by lowercased name (BLOCK_STYLE.fog === 9, …), built from
 * BLOCK_TYPES, plus `plain` (0) for flat colour.
 */
export const BLOCK_STYLE = Object.freeze({ plain: 0, ...Object.fromEntries(BLOCK_TYPES.map((t) => [t.name.toLowerCase(), t.style])) });

// catch table mistakes early: keys, ids and style numbers must each be unique
for (const field of ['key', 'id', 'style']) {
  const seen = new Set([field === 'style' ? 0 : undefined]);
  for (const t of BLOCK_TYPES) {
    if (seen.has(t[field])) throw new Error(`BLOCK_TYPES: duplicate ${field} ${t[field]} (${t.name})`);
    seen.add(t[field]);
  }
}

/** Block type id -> its entry in BLOCK_TYPES. */
export const BLOCK_PROPS = Object.freeze(Object.fromEntries(BLOCK_TYPES.map((t) => [t.id, t])));

const UNKNOWN = Object.freeze({ key: null, id: null, name: '?', color: '#ffffff', style: BLOCK_STYLE.plain, opacity: 1 });
/** Properties of block type `type` (a harmless default for unknown types). */
export const blockProps = (type) => BLOCK_PROPS[type] ?? UNKNOWN;

export const isCreature = (type) => !!BLOCK_PROPS[type]?.creature;
/** See-through (opacity below 1): drawn by the translucent pass, casts no ambient occlusion. */
export const isTranslucent = (type) => blockProps(type).opacity < 1;
/** A one-block creature (Crawly, Buzzy), as opposed to a chain like a Squirmy. */
export const isSingleCreature = (type) => BLOCK_PROPS[type]?.body === 'single';
/** Whether block `b` flies: its type does (Buzzy), or it has a buff that does (Flight). */
export const canFly = (b) => !!b && (!!BLOCK_PROPS[b.type]?.fly || hasBuffFlag(b, 'fly'));
/** A buff's name and what's left of it, e.g. "Rockbiter (permanent, 3 charges)". */
export const describeBuff = (x) => {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [x.turns == null ? 'permanent' : plural(x.turns, 'turn')];
  if (x.charges != null) parts.push(plural(x.charges, 'charge'));
  return `${BUFF_TYPES[x.type]?.name ?? x.type} (${parts.join(', ')})`;
};
/** Whether block `b` has a buff with property `flag` set (e.g. 'fly'). */
export const hasBuffFlag = (b, flag) => !!b?.buffs?.some((x) => BUFF_TYPES[x.type]?.[flag]);
/**
 * The foods creature block `c` goes for on its own when it sees one: its type's priorityDiet
 * plus its buffs' (e.g. Rockbiter adds Crystal), without repeats.
 */
export const priorityDietOf = (c) => [
  ...new Set([...(BLOCK_PROPS[c.type]?.priorityDiet ?? []), ...(c.buffs ?? []).flatMap((b) => BUFF_TYPES[b.type]?.priorityDiet ?? [])]),
];
/** Whether creature block `c` can eat a block of type `foodType`: its type's diet, or one of its buffs'. */
export const canEat = (c, foodType) =>
  !!BLOCK_PROPS[c.type]?.diet?.includes(foodType) || !!c.buffs?.some((b) => BUFF_TYPES[b.type]?.diet?.includes(foodType));
/** Whether a creature of type `creatureType` can walk along a block of type `blockType`. */
export const canWalkOn = (creatureType, blockType) => !!BLOCK_PROPS[creatureType]?.walkableBlocks?.includes(blockType);
/** Whether a creature of `type` can have behavior `behavior`. */
export const canBehave = (type, behavior) => !!BLOCK_PROPS[type]?.behaviorList?.includes(behavior);

// Views of the table, for code that wants a plain lookup.
export const BLOCK_COLORS = Object.freeze(Object.fromEntries(BLOCK_TYPES.map((t) => [t.id, t.color])));
export const CREATURE_TYPES = new Set(BLOCK_TYPES.filter((t) => t.creature).map((t) => t.id));
export const CREATURE_DIET = Object.freeze(Object.fromEntries(BLOCK_TYPES.filter((t) => t.diet).map((t) => [t.id, t.diet])));
