// The tool bar. Block types and their properties live in blocks.js (re-exported here for
// the modules that already import them from this file).
import { BLOCK, blockProps } from './blocks.js';

export { BLOCK, BLOCK_COLORS, CREATURE_TYPES, CREATURE_DIET, isCreature } from './blocks.js';

/** Ids of the tools that don't place a block. */
export const TOOL = Object.freeze({ SELECT: 'select', DELETE: 'delete' });

export const TOOLS = [
  { id: TOOL.SELECT, label: 'Select', block: null },
  { id: TOOL.DELETE, label: 'Delete', block: null },
  { id: BLOCK.CRAWLY, label: blockProps(BLOCK.CRAWLY).name, block: BLOCK.CRAWLY },
  { id: BLOCK.BUZZY, label: blockProps(BLOCK.BUZZY).name, block: BLOCK.BUZZY },
  { id: BLOCK.SQUIRMY, label: blockProps(BLOCK.SQUIRMY).name, block: BLOCK.SQUIRMY },
  { id: BLOCK.STONE, label: blockProps(BLOCK.STONE).name, block: BLOCK.STONE },
  { id: BLOCK.DIRT, label: blockProps(BLOCK.DIRT).name, block: BLOCK.DIRT },
  { id: BLOCK.MOSS, label: blockProps(BLOCK.MOSS).name, block: BLOCK.MOSS },
  { id: BLOCK.CRYSTAL, label: blockProps(BLOCK.CRYSTAL).name, block: BLOCK.CRYSTAL },
  { id: BLOCK.WOOD, label: blockProps(BLOCK.WOOD).name, block: BLOCK.WOOD },
  { id: BLOCK.BERRY, label: blockProps(BLOCK.BERRY).name, block: BLOCK.BERRY },
  { id: BLOCK.WATER, label: blockProps(BLOCK.WATER).name, block: BLOCK.WATER },
  { id: BLOCK.NIMBUS, label: blockProps(BLOCK.NIMBUS).name, block: BLOCK.NIMBUS },
  { id: BLOCK.FOG, label: blockProps(BLOCK.FOG).name, block: BLOCK.FOG },
];

/** Block types used for the random blocks in "New" (everything except Stone). */
export const RANDOM_BLOCKS = [BLOCK.BERRY, BLOCK.WOOD, BLOCK.CRYSTAL, BLOCK.MOSS, BLOCK.WATER, BLOCK.CRAWLY, BLOCK.DIRT];
