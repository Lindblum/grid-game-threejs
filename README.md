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
**Options → XR: Off** in the menu to turn XR on (with **Background: Passthrough** you see your room;
passthrough needs the Quest Browser — PC browsers driving the headset over Link only
offer VR with a solid background). The grid origin appears
50 cm in front of you, and the menu lies flat above the Left HUD on your left controller.

## Controls

| Action | Mouse / Keyboard | Gamepad | XR controller (Quest Touch) |
|---|---|---|---|
| Use tool (place / delete) | Left click | RT | Right trigger |
| Aim | Mouse pointer | Crosshair at screen centre | Point the right controller |
| Change tool | ← / → (or 1–9, 0) | LB / RB | Right thumbstick left/right |
| Menu | Esc or Enter, or ≡ on the Left HUD | Start | Point at ≡ on the Left HUD + trigger (or Y) |
| Orbit / zoom / pan | Right-drag / wheel / middle-drag | Right stick / left stick ↑↓ / D-pad | Hold both grips: turn your hands to rotate, spread / pinch to scale (Tilt Brush style). Hold one grip to drag the build |
| Menu select / back | Click / Esc | D-pad + A / B | Point + right trigger |

The same table (with button icons) is under **Options → Controls** in the game.

**Menu:** the game opens straight into a freshly generated scene, with a countdown (T -3, -2, -1 with a
"ready" beep each, then a higher "go" beep at 0); tools work from 0. The menu
(titled "Grid Game") has Resume, New, Load, Save, Options (sound, background: passthrough or solid in XR,
materials: procedural or solid, outlines on/off, ambient occlusion on/off, XR on/off, speed (12–120 turns per minute, default 60), rain on/off, debug on/off, Controls).

**Debug** (Options) adds a panel under the HUDs with the selected (or pointed-at) block's
properties, a Crawly's behavior among them, and the recent console log. In XR it is a
floating tablet: squeeze a grip near it, or while pointing at it, to move it. Debug also
unlocks developer options in Options (Bevel (Experimental), not implemented yet). Leave XR with Options → XR: On.

**HUD:** the Left HUD holds the Menu (≡) button, the Right HUD holds the tool selector.
In XR each is docked above its own controller, tilted to face up toward you
(position and tilt are `HUD_DOCK` in `src/game/xrPanels.js`); in the browser they sit in the
bottom-left and bottom-right corners.

Tools: Select, Stone (gray), Dirt (brown), Berry (red), Wood (orange), Crystal (yellow), Moss (green),
Water (blue), Crawly (magenta), and Delete.

**Select** has two phases. *Select*: click a Crawly to select it (green wireframe).
*Target*: point at a surface a Crawly can walk on (Stone, Dirt, Moss) and the empty cell
beside it gets a green indicator, with a shrinking copy every turn; click it and the Crawly
switches to the **Walk** behavior, heading there by the shortest path one step per turn,
then goes back to **Wander**. Clicking another Crawly while targeting selects that one
instead; clicking anything else (or empty space), or switching tools, clears the selection.

**Squirmy** (pink creature): touching Squirmy blocks form one chain; the first placed is
the head (with eyes), the last the tail. On Wander, each turn the head steps to an empty
cell beside a solid block that touches no other Squirmy block, and each segment follows
into the cell the one ahead of it left. The Select tool can select a Squirmy (the whole
body lights up); it waits while selected, and can be sent to a spot like a Crawly.

**Trapped:** a Crawly walled in on all 14 sides by non-creature blocks switches to the
Trapped behavior and does nothing. A turn with an empty neighbouring cell frees it (back to
Wander); after 30 trapped turns it dies and its block is removed.

**Turns:** the game clock (shown on the Left HUD as HH:mm:ss) counts up once per second
while you play, and pauses while the menu is open; New and Load reset it to 00:00:00.
Every second is a turn: first, blocks are split into connected groups, and every group
that doesn't contain the origin block shifts one step toward the origin as a whole (in the
lattice direction closest to the line from its centre to the origin), so detached chunks
fall onto the main build; then Water flows toward the origin; then each Crawly may crawl (a
½-second slide; every move animates over half a turn) into an empty neighbouring cell that borders Stone, Dirt or Moss.
Every turn, each tree (connected group of Wood) that touches Water drinks the Water block
closest to the origin and grows one Wood into a cell next to the tree that touches
exactly one Wood and no other Solid block (Stone, Dirt, Moss, Wood, Berry). A tree of 5
or more Wood grows a Berry instead 25 % of the time. Then each Dirt next to Water absorbs
it (deleting the Water) and turns into Moss. Trees and Dirt only take Water that has
stayed still for 2 turns, so falling or flowing Water isn't absorbed mid-move.
Rain: every 10th turn a Water block appears at a random point 1 m from the origin (on
the surface of a sphere) and falls in toward the build.
Rules live in `src/game/sim.js`. Each Crawly knows its floor (a side touching Stone or
Dirt) and its front (the way it last moved); its two eyes revolve to the front side.
With a block tool, the empty cell beside the face you point at (square or hexagon)
is outlined in the edge colour of the block you're about to place; with Delete, the
targeted block is outlined in red.

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
| `src/game/engine.js` | Three.js scene, camera, input, raycasting, XR controllers |
| `src/game/xrPanels.js` | Canvas-textured Left/Right HUDs and menu panel for XR |
| `src/game/icons.js` | Tool icons drawn from the real 3D shape |
| `src/game/menuIcons.js` | Icons shown beside each menu button |
| `src/game/controls.js` | The control mappings shown on the Controls panel |
| `src/game/inputIcons.js` | Key, mouse, gamepad and Touch-controller button glyphs |
| `src/game/sim.js` | Per-turn simulation (falling groups, Water, Crawlies, Wood growth) |
| `src/game/crawly.js` | Crawly floor/front orientation and eyes |
| `src/game/audio.js` | Synthesised sounds: place, delete, resume, new/load, save (no audio files) |
| `src/App.jsx` | React UI: Left/Right HUD, menu, toasts |

Note: the Quest Browser uses the left controller's physical Menu (≡) button as
"Back", so the game's menu is opened from the Left HUD button instead (or Y).
