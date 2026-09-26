# Grid Game (phase 1: creative mode)

A Minecraft-style building space in React + Three.js where every "block" is a
**regular truncated octahedron** (6 squares + 8 hexagons) on a body-centred cubic
lattice. Square faces have an inscribed radius of 1 cm, so cell centres (in cm) are
`(2i, 2j, 2k)` or `(2i+1, 2j+1, 2k+1)` and every cell has 14 neighbours.
Plays in a desktop browser or in WebXR with passthrough (Meta Quest).

## Run it

Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm run dev        # desktop: open http://localhost:5173
```

### On a Quest headset (passthrough)

WebXR needs HTTPS, so start the XR server, which uses a self-signed certificate
and listens on your LAN:

```bash
npm run dev:xr     # prints https://<your-PC-IP>:5173
```

Open that address in the Quest Browser, accept the certificate warning, then choose
**Options → Enter XR** in the menu (with **Background: Passthrough** you see your room;
passthrough needs the Quest Browser — PC browsers driving the headset over Link only
offer VR with a solid background). The grid origin appears
50 cm in front of you, and the menu lies flat above the Left HUD on your left controller.

## Controls

| Action | Mouse / Keyboard | Gamepad | XR controller (Quest Touch) |
|---|---|---|---|
| Use tool (place / delete) | Left click | RT | Right trigger |
| Aim | Mouse pointer | Crosshair at screen centre | Point the right controller |
| Change tool | ← / → (or 1–9) | LB / RB | Right thumbstick left/right |
| Menu | Esc or Enter, or ≡ on the Left HUD | Start | Point at ≡ on the Left HUD + trigger (or Y) |
| Orbit / zoom / pan | Right-drag / wheel / middle-drag | Right stick / left stick ↑↓ / D-pad | Hold both grips: turn your hands to rotate, spread / pinch to scale (Tilt Brush style). Hold one grip to drag the build |
| Menu select / back | Click / Esc | D-pad + A / B | Point + right trigger |

The same table (with button icons) is under **Options → Controls** in the game.

**Menu:** the game opens on a freshly generated scene with the menu up. The menu
(titled "Grid Game") has Resume, New, Load, Save, Options (sound, background: passthrough or solid in XR,
enter/exit XR, Controls) and Quit. Quit leaves XR when in the headset; in the browser it closes the game.

**HUD:** the Left HUD holds the Menu (≡) button, the Right HUD holds the tool selector.
In XR each is docked above its own controller, tilted to face up toward you
(position and tilt are `HUD_DOCK` in `src/game/xrPanels.js`); in the browser they sit in the
bottom-left and bottom-right corners.

Tools: Red, Orange, Yellow, Green, Blue, Magenta, Brown, Gray block, and Delete.
With a block tool, the empty cell beside the face you point at (square or hexagon)
is outlined in gray; with Delete, the targeted block is outlined in red.

## Save files

**Save** writes JSON into the `saves/` folder (through a small API built into the
Vite dev/preview server, see `saves-api.js`). Pick **+ New save file** (optionally
type a name in the browser; in XR it is timestamped) or overwrite an existing one.
**Load** lists the files in `saves/`.

```json
{
  "format": "grid-game-save",
  "version": 1,
  "units": "cm",
  "blocks": [ { "x": 0, "y": 0, "z": 0, "type": "gray" }, { "x": 1, "y": 1, "z": 1, "type": "red" } ]
}
```

If the page is hosted somewhere without that API, the menu falls back to
downloading / opening a .json file instead.

## Code map

| File | Purpose |
|---|---|
| `src/game/lattice.js` | BCC lattice maths: 14 neighbour offsets, face → neighbour lookup |
| `src/game/geometry.js` | Truncated octahedron mesh (with outlined faces) and edges |
| `src/game/world.js` | Block storage, instanced rendering, New-scene generator, JSON |
| `src/game/Engine.js` | Three.js scene, camera, input, raycasting, XR controllers |
| `src/game/xrPanels.js` | Canvas-textured Left/Right HUDs and menu panel for XR |
| `src/game/icons.js` | Tool icons drawn from the real 3D shape |
| `src/game/menuIcons.js` | Icons shown beside each menu button |
| `src/game/controls.js` | The control mappings shown on the Controls panel |
| `src/game/inputIcons.js` | Key, mouse, gamepad and Touch-controller button glyphs |
| `src/game/audio.js` | Synthesised sounds: place, delete, resume, new/load, save (no audio files) |
| `src/App.jsx` | React UI: Left/Right HUD, menu, toasts |

Note: the Quest Browser uses the left controller's physical Menu (≡) button as
"Back", so the game's menu is opened from the Left HUD button instead (or Y).
