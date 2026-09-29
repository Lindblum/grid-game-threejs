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
// Creatures also have:
//   creature        true
//   diet            keys of the block types it can consume (World.consume); CREATURE_DIET and
//                   blockProps(type).diet give them as ids
//   sightRadius     how far it sees, in blocks (1 block = 2 cm); it clears Fog within it
//   behaviorList    the behaviors it can have (from BEHAVIOR)
//   defaultBehavior the behavior it starts with
//   eyeScale        eye size relative to a block

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
  { key: 'CRYSTAL', id: 'yellow', name: 'Crystal', color: '#e03cd2', style: 8, opacity: 0.9 }, // magenta gem
  { key: 'MOSS', id: 'green', name: 'Moss', color: '#43a047', style: 4, opacity: 1 },
  { key: 'WATER', id: 'blue', name: 'Water', color: '#1e88e5', style: 3, opacity: 0.55 },
  {
    key: 'CRAWLY', id: 'magenta', name: 'Crawly', color: '#d63ad6', style: 6, opacity: 1,
    creature: true,
    diet: ['BERRY'],
    sightRadius: 3,
    behaviorList: [BEHAVIOR.WANDER, BEHAVIOR.WAIT, BEHAVIOR.WALK, BEHAVIOR.TRAPPED],
    defaultBehavior: BEHAVIOR.WANDER,
    eyeScale: 0.25,
  },
  {
    key: 'SQUIRMY', id: 'squirmy', name: 'Squirmy', color: '#f07898', style: 11, opacity: 1, // pink
    creature: true,
    diet: ['BERRY', 'DIRT'],
    sightRadius: 1, // around its head
    behaviorList: [BEHAVIOR.WANDER, BEHAVIOR.WAIT, BEHAVIOR.WALK], // the head's behavior drives the chain
    defaultBehavior: BEHAVIOR.WANDER,
    eyeScale: 0.25,
  },
  { key: 'FOG', id: 'fog', name: 'Fog', color: '#d3d7dd', style: 9, opacity: 0.8 }, // light gray
  { key: 'NIMBUS', id: 'nimbus', name: 'Nimbus', color: '#5b616b', style: 10, opacity: 0.8 }, // dark gray
];

/**
 * Block type ids by key (BLOCK.STONE === 'gray', …), built from BLOCK_TYPES. Always refer
 * to block types through these constants.
 */
export const BLOCK = Object.freeze(Object.fromEntries(BLOCK_TYPES.map((t) => [t.key, t.id])));

// diets are written as keys (the table can't refer to BLOCK while BLOCK is built from it)
for (const t of BLOCK_TYPES) if (t.diet) t.diet = t.diet.map((k) => BLOCK[k]);

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
/** Whether a creature of `type` can have behavior `behavior`. */
export const canBehave = (type, behavior) => !!BLOCK_PROPS[type]?.behaviorList?.includes(behavior);

// Views of the table, for code that wants a plain lookup.
export const BLOCK_COLORS = Object.freeze(Object.fromEntries(BLOCK_TYPES.map((t) => [t.id, t.color])));
export const CREATURE_TYPES = new Set(BLOCK_TYPES.filter((t) => t.creature).map((t) => t.id));
export const CREATURE_DIET = Object.freeze(Object.fromEntries(BLOCK_TYPES.filter((t) => t.diet).map((t) => [t.id, t.diet])));
