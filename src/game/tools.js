/**
 * Block type ids, by game name. Always refer to block types through these constants.
 * The id strings are the blocks' original colour names; they are what save files store,
 * so they must never change (older saves would stop loading).
 */
export const BLOCK = Object.freeze({
  STONE: 'gray',
  DIRT: 'brown',
  BERRY: 'red',
  WOOD: 'orange',
  CRYSTAL: 'yellow',
  MOSS: 'green',
  WATER: 'blue',
  CRAWLY: 'magenta',
});

/**
 * Creatures: living, self-moving block types (they walk, and have eyes / behaviors). Every
 * other type is terrain or material, and those are what form same-type block groups.
 * Add new creature types here as they arrive.
 */
export const CREATURE_TYPES = new Set([BLOCK.CRAWLY]);
export const isCreature = (type) => CREATURE_TYPES.has(type);

export const BLOCK_COLORS = {
  [BLOCK.BERRY]: '#e53935',
  [BLOCK.WOOD]: '#b8804a', // warm tan
  [BLOCK.CRYSTAL]: '#e03cd2', // magenta
  [BLOCK.MOSS]: '#43a047',
  [BLOCK.WATER]: '#1e88e5',
  [BLOCK.CRAWLY]: '#d63ad6',
  [BLOCK.DIRT]: '#8b5a2b',
  [BLOCK.STONE]: '#9aa0a6',
};

/** Ids of the tools that don't place a block. */
export const TOOL = Object.freeze({ SELECT: 'select', DELETE: 'delete' });

export const TOOLS = [
  { id: TOOL.SELECT, label: 'Select', block: null },
  { id: BLOCK.STONE, label: 'Stone', block: BLOCK.STONE },
  { id: BLOCK.DIRT, label: 'Dirt', block: BLOCK.DIRT },
  { id: BLOCK.BERRY, label: 'Berry', block: BLOCK.BERRY },
  { id: BLOCK.WOOD, label: 'Wood', block: BLOCK.WOOD },
  { id: BLOCK.CRYSTAL, label: 'Crystal', block: BLOCK.CRYSTAL },
  { id: BLOCK.MOSS, label: 'Moss', block: BLOCK.MOSS },
  { id: BLOCK.WATER, label: 'Water', block: BLOCK.WATER },
  { id: BLOCK.CRAWLY, label: 'Crawly', block: BLOCK.CRAWLY },
  { id: TOOL.DELETE, label: 'Delete', block: null },
];

/** Block types used for the random blocks in "New" (everything except Stone). */
export const RANDOM_BLOCKS = [BLOCK.BERRY, BLOCK.WOOD, BLOCK.CRYSTAL, BLOCK.MOSS, BLOCK.WATER, BLOCK.CRAWLY, BLOCK.DIRT];
