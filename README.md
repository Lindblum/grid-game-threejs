# Grid Game

A small living world built from space-filling blocks: **truncated octahedra** (14
neighbours), **rhombic dodecahedra** (12) or **cubes** (6), picked per world (see
[Grid modes](#grid-modes)). Place blocks and creatures,
then watch Water flow, trees grow Berries, and Crawlies, Buzzies, Squirmies and Slithers
roam and eat. React + Three.js; plays in a desktop browser, in WebXR with passthrough
(Meta Quest), or on a phone as a Cardboard-style stereo view.

![Grid Game screenshot](docs/screenshot.png)

## Run

Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm run dev       # http://localhost:5172/grid-game-threejs/
npm run dev:xr    # HTTPS on your LAN, for Quest or phone
```

On a Quest, open the `dev:xr` address in the Quest Browser, accept the certificate warning,
and turn on **Options → XR**.

## Grid modes

**New** in the menu picks one of three space-filling grids:

| Mode | Cells (integer x, y, z) | Neighbours |
|---|---|---|
| Truncated Octahedron | all even or all odd | 14: `+X` … and `+X+Y+Z` … |
| Rhombic Dodecahedron | x + y + z even | 12: `+X+Y`, `+X-Z`, … |
| Cube | all even | 6: `+X`, `-X`, … |

Every block has an inradius of 1 cm. Directions are named by their axis signs and work the
same in every mode. Saves record their grid (`"grid": "to" | "rd" | "cube"`); older saves open
as Truncated Octahedron. See `src/game/grids.js`.

## Controls

| Action | Mouse / Keyboard | Gamepad | Quest Touch |
|---|---|---|---|
| Use tool | Left click | RT | Right trigger |
| Change tool | ← / → or 1–9, 0 | LB / RB | Right stick left/right |
| Menu | Esc / Enter | Start | ≡ on the Left HUD, or Y |
| Orbit / zoom / pan | Right-drag / wheel / middle-drag | Right stick / left stick / D-pad | Both grips: rotate and scale; one grip: drag |

With a creature selected: **A** eats, **B** excretes, **Y** wanders, **X** waits.
The full table is under **Options → Controls** in the game.

## How it works

The world advances one **turn** per second (speed is adjustable in Options). Each turn,
detached chunks fall toward the origin, Water flows, Fog settles, Nimbus clouds drift and
rain, trees drink Water to grow Wood and Berries, Dirt soaks up Water to become Moss, and
creatures move, eat and fill their inventories. A Crawly that eats a Berry becomes a
**Rockbiter** for a few charges and can chew through Stone and Crystal.

Rules live in `src/game/sim.js`; block and creature definitions in `src/game/blocks.js`.

## Saves

**Save** writes JSON to `saves/` through a small API in the Vite server (`saves-api.js`);
**Load** lists those files. Without the API, the game downloads and opens `.json` files
instead. You can also drop a save file, or a world template (see `NEW_SCENE_TEMPLATE` in
`src/game/world.js`), onto the page.
