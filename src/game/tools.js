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
  YELLOW: 'yellow',
  MOSS: 'green',
  WATER: 'blue',
  CRAWLY: 'magenta',
});

export const BLOCK_COLORS = {
  [BLOCK.BERRY]: '#e53935',
  [BLOCK.WOOD]: '#b8804a', // warm tan
  [BLOCK.YELLOW]: '#fdd835',
  [BLOCK.MOSS]: '#43a047',
  [BLOCK.WATER]: '#1e88e5',
  [BLOCK.CRAWLY]: '#d63ad6',
  [BLOCK.DIRT]: '#8b5a2b',
  [BLOCK.STONE]: '#9aa0a6',
};

export const TOOLS = [
  { id: BLOCK.STONE, label: 'Stone', block: BLOCK.STONE },
  { id: BLOCK.DIRT, label: 'Dirt', block: BLOCK.DIRT },
  { id: BLOCK.BERRY, label: 'Berry', block: BLOCK.BERRY },
  { id: BLOCK.WOOD, label: 'Wood', block: BLOCK.WOOD },
  { id: BLOCK.YELLOW, label: 'Yellow block', block: BLOCK.YELLOW },
  { id: BLOCK.MOSS, label: 'Moss', block: BLOCK.MOSS },
  { id: BLOCK.WATER, label: 'Water', block: BLOCK.WATER },
  { id: BLOCK.CRAWLY, label: 'Crawly', block: BLOCK.CRAWLY },
  { id: 'delete', label: 'Delete', block: null },
];

/** Block types used for the random blocks in "New" (everything except Stone). */
export const RANDOM_BLOCKS = [BLOCK.BERRY, BLOCK.WOOD, BLOCK.YELLOW, BLOCK.MOSS, BLOCK.WATER, BLOCK.CRAWLY, BLOCK.DIRT];
