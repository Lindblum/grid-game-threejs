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

Open that address in the Quest Browser, accept the certificate warning, then press
**Enter XR (passthrough)**. The grid origin appears 50 cm in front of you.

## Controls

| Action | Browser | Quest Touch |
|---|---|---|
| Use tool (place / delete) | Left click | Right trigger |
| Change tool | ← / → (or 1–8) | Right thumbstick left/right |
| Pause menu | Esc or Enter | Left Menu button (Y also works) |
| Move the view | Right-drag orbit, wheel zoom, middle-drag pan | Walk around; hold left grip to drag the build |
| Menu selection | Mouse | Point with right ray + trigger |

Tools: Red, Orange, Yellow, Green, Blue, Magenta, Gray block, and Delete.
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
| `src/game/xrPanels.js` | Canvas-textured HUD (left controller) and pause panel for XR |
| `src/game/icons.js` | Tool icons drawn from the real 3D shape |
| `src/game/audio.js` | Synthesised place/delete sounds (no audio files) |
| `src/App.jsx` | React UI: title screen, bottom HUD, pause menu, toasts |

Note: Meta's Quest Browser may reserve the left controller's Menu (≡) button for
the system; the Y button pauses as a fallback.
