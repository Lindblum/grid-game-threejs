# Grid Game

A small living world built from space-filling blocks: **truncated octahedra** (14
neighbours), **rhombic dodecahedra** (12), **cubes** (6) or **hexagonal prisms** (8), picked per world (see
[Grid modes](#grid-modes)). Place blocks and critters,
then watch Water flow, trees grow Berries, and Crawlies, Buzzies, Squirmies and Slithers
roam and eat. React + Three.js; plays in a desktop browser, in WebXR with passthrough
(Meta Quest), or on a phone as a Cardboard-style stereo view.

![Grid Game screenshot](docs/screenshot.png)

## Run

Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm run dev       # http://localhost:5172/
npm run dev:xr    # HTTPS on your LAN, for Quest or phone
```

On a Quest, open the `dev:xr` address in the Quest Browser, accept the certificate warning,
and turn on **Options → XR**.

## Grid modes

**New** in the menu picks one of four space-filling grids (the page starts in the one used
last, kept in localStorage):

| Mode | Cells (integer x, y, z) | Neighbours |
|---|---|---|
| Truncated Octahedron | all even or all odd | 14: `+X` … and `+X+Y+Z` … |
| Rhombic Dodecahedron | x + y + z even | 12: `+X+Y`, `+X-Z`, … |
| Cube | all even | 6: `+X`, `-X`, … |
| Hexagonal Prism | x + y + z a multiple of 3 | 8: `+X-Y`, `+Y-Z`, … round the column, `+X+Y+Z` and `-X-Y-Z` along it |

Every block has an inradius of 1 cm (a hexagonal prism: 2 cm tall and 2 cm across its
flats, so its sides are 1.15 cm wide by 2 cm tall; its columns run along the (1, 1, 1) diagonal, which the lattice -> cm map,
`GRID.toCm`, squashes to give it those proportions). In Cube and Hexagonal
Prism, which have no faces across their edges, creatures also step diagonally across an edge
to climb a step or round a corner. Directions are named by their axis signs and work the
same in every mode. Saves record their grid (`"grid": "to" | "rd" | "cube" | "hex"`); older saves open
as Truncated Octahedron. See `src/game/grids.js`.

## Controls

| Action | Mouse / Keyboard | Gamepad | Quest Touch |
|---|---|---|---|
| Use tool | Left click | RT | Right trigger |
| Change tool (Options → Creative on; off, the tool is Select) | ← / → or 1–9, 0 | LB / RB | Right stick left/right (the right controller's ball shows the tool) |
| Steer the selected critter | WASD (Shift: away) | Left stick (L3: away) | Left thumbstick (held in: away) |
| Options (pauses) | Esc / Enter, or the gear (top left) | Start | The gear (Options, on the left controller), or Y |
| Orbit / zoom / pan | Left- or right-drag / wheel / middle-drag | Right stick / LT, RT / D-pad | Grip blocks: one hand drags, both rotate and scale (a grip on nothing does nothing) |
| Deselect | Right click (without dragging) | X | Select tool at empty space |
| Move / dock a panel | — | — | Grip a panel to take it; let go near the other controller to dock it. Double-tap a grip at a panel: dock it there; at nothing: undock. Triple-tap: dock every undocked panel on that controller. While gripping a panel, a critter or the build, that hand's thumbstick up / down pushes it away / reels it in, and left / right turns the build about that controller's ray |
| Carry a critter | — | — | Grip a critter (touching or pointing at it) to pick it up; let go to put it back in the nearest cells it fits, selected |

With a critter selected, on the XR controllers: **B** consumes, **A** excretes (hold either and aim with the left thumbstick), **Y** wanders, **X** waits (gamepad: **Y** consumes, **B** excretes, **View** waits; hold Y or B and aim with the left stick; keyboard: **E** consumes, **Q** excretes, held with WASD / the arrows to aim). Controlling a critter, WASD, the arrows, the gamepad's left stick or the XR left thumbstick move it (relative to your view of it; held in: straight away from you). In XR, taking control zooms the build in 4× about the critter's head, and going back to Observer zooms it back out. Controlling it, the Select tool still sends it somewhere (click / trigger a cell); with a critter selected, clicking another critter selects that one instead (no dotted path is drawn to it), and Consume while pointing at one sends it to hunt that one down and eat it (if it eats that kind, like a Slither). Steering it, or Consume / Excrete, stops the walk.
In the game, **Options → Controls** draws the input you last used (the mouse and the keys, a gamepad, or the XR controllers), each button labelled with what it does under the current control schema (Observer or Critter), as every threejs-ui project draws it. In XR, **Options → Accessibility → XR Control Guides** labels the controllers' own buttons and sticks the same way.

## How it works

The world advances one **turn** per second (speed is adjustable in Options). Each turn,
detached chunks fall toward the origin, Water flows, Fog settles, Nimbus clouds drift and
rain, trees drink Water to grow Wood and Berries, Dirt soaks up Water to become Moss, and
critters move, eat and fill their inventories. A critter that eats a Berry becomes
**Fertile** (pink ripples) until it mates. Left to itself, it goes after the first of its kind it sees and mates with it; selected beside another of its kind, **Mate** (X, gamepad A,
XR X; hold it and aim to pick which one) has them clamber over each other for 5 turns, and then it
carries an **Egg**. Excreted (or placed), the Egg, spotted in its parent's colour, hatches 5 turns
later into a young one of that kind (`MATE_TURNS`, `GESTATION_TURNS` in `src/game/blocks.js`).

Rules live in `src/game/sim.js`; block and creature definitions in `src/game/blocks.js`.

## Saves

**Save** writes JSON to `saves/` through a small API in the Vite server (`saves-api.js`);
**Load** lists those files. Without the API, the game downloads and opens `.json` files
instead. You can also drop a save file, or a world template (see `NEW_SCENE_TEMPLATE` in
`src/game/world.js`), onto the page.

A template is a list of lines run in order. Lines with a `stage` build the world the way it
should look (`src/game/worldgen.js`): `shape` (a `ball`, or a `torus` with a `tube` thickness;
its radius and relief, in cm), `bodies` (buried things made of layers from the inside out, e.g.
a geode: Void, then Crystal, then Stone), `fill` (Dirt around them), `cover` (Moss over part of
the surface), `trees`, `pools`, `fauna` and `shell` (a layer of Fog). Depth and "up" follow the
shape (away from a torus's core circle), though the game's own rules still pull everything
toward the origin. Lines without a stage grow blocks outward from what's there (the older
format; clouds still use it). An object template can also give a `grid` and a `seed`; the same
seed makes the same world, and every new world's seed is logged to the console.

```json
{ "grid": "to", "seed": 7, "template": [
  { "stage": "shape", "radius": 24, "relief": 4 },
  { "stage": "bodies", "count": 3, "cover": 2, "layers": [
    { "type": "Void", "size": [1.5, 3] }, { "type": "Crystal", "size": 2 }, { "type": "Stone", "size": 2 } ] },
  { "stage": "bodies", "count": 10, "layers": [{ "type": "Stone", "size": [1.5, 4] }] },
  { "stage": "fill", "type": "Dirt" },
  { "stage": "cover", "type": "Moss", "fraction": 0.5 },
  { "stage": "trees", "count": 8 },
  { "stage": "fauna", "type": "Crawly", "count": 12 }
] }
```
