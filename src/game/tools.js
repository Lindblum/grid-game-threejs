// Block type ids stay colour names (so older save files still load); the tool labels
// give some of them game names: gray = Stone, brown = Dirt, green = Moss, blue = Water,
// red = Berry, orange = Wood, magenta = Crawly.
export const BLOCK_COLORS = {
  red: '#e53935',
  orange: '#b8804a', // Wood: warm tan (the id stays 'orange' for old saves)
  yellow: '#fdd835',
  green: '#43a047',
  blue: '#1e88e5',
  magenta: '#d63ad6',
  brown: '#8b5a2b',
  gray: '#9aa0a6',
};

export const TOOLS = [
  { id: 'gray', label: 'Stone', block: 'gray' },
  { id: 'brown', label: 'Dirt', block: 'brown' },
  { id: 'red', label: 'Berry', block: 'red' },
  { id: 'orange', label: 'Wood', block: 'orange' },
  { id: 'yellow', label: 'Yellow block', block: 'yellow' },
  { id: 'green', label: 'Moss', block: 'green' },
  { id: 'blue', label: 'Water', block: 'blue' },
  { id: 'magenta', label: 'Crawly', block: 'magenta' },
  { id: 'delete', label: 'Delete', block: null },
];

/** Colours used for the random-colour blocks in "New" (all non-gray colours). */
export const RANDOM_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'magenta', 'brown'];
