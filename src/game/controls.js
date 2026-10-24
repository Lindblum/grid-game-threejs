// Control schemas: which input does what, and the tables the Options → Controls panel shows
// (DOM and XR). The Observer schema is the default; with a creature selected, the gamepad's R3
// switches to the Creature schema, taking on that creature's view (and back).
// Each binding: { g: glyph tokens (see inputIcons.js), t: text for tooltips / screen readers }.

export const CONTROL_COLUMNS = ['Action', 'Mouse / Keyboard', 'Gamepad', 'XR Controller'];

const OBSERVER_CONTROLS = [
  {
    action: 'Use tool',
    mk: { g: ['mouse:L'], t: 'Left click' },
    pad: { g: ['pad:A'], t: 'A' },
    xr: { g: ['xr:trigger:R'], t: 'Right trigger' },
  },
  {
    action: 'Aim',
    mk: { g: ['mouse:move'], t: 'Move the mouse' },
    pad: { g: ['crosshair'], t: 'Aims at the crosshair in the screen centre' },
    xr: { g: ['ray'], t: 'Point the right controller' },
  },
  {
    action: 'Move selected creature',
    mk: { g: ['key:W', 'key:A', 'key:S', 'key:D'], t: 'WASD (and the arrows, with Creative off): steer the selected creature, relative to the camera (on its turn); Shift: the way most nearly away. It stops any walk it was sent on' },
    pad: { g: ['stick:L:any'], t: 'Left stick: steer the selected creature (L3 held: the way most nearly away from the camera). It stops any walk it was sent on' },
    xr: { g: ['xr:stick:L:any'], t: 'Left thumbstick: steer the selected creature, relative to your view (held in: straight away from you). It stops any walk it was sent on' },
  },
  {
    action: 'Change tool',
    mk: { g: ['key:←', 'key:→', 'sep:/', 'key:0–9'], t: 'Left / Right arrows, or 1–9 and 0 (Options → Creative on)' },
    pad: { g: ['pad:LB', 'pad:RB'], t: 'Bumpers (LB / RB) (Options → Creative on)' },
    xr: { g: ['xr:stick:R:x'], t: 'Right thumbstick left / right, or open the Control menu’s Tool dropdown and point at a tool (the left controller reaches it). Options → Creative on; off, the tool is Select. The right controller’s ball shows the tool: blue energy (Select), a red wireframe (Delete), or the block it places' },
  },
  {
    action: 'Deselect',
    mk: { g: ['mouse:R'], t: 'Right click (without dragging): no creature selected any more (cancels the Select tool’s target)' },
    pad: { g: ['pad:X'], t: 'X: no creature selected any more (cancels the Select tool’s target)' },
    xr: { g: ['text:—'], t: 'Point the Select tool at empty space and pull the trigger' },
  },
  {
    action: 'Consume (selected creature)',
    mk: { g: ['key:E'], t: 'E: the selected creature consumes the block in front of it. Hold E and press WASD / the arrows to choose which block (it consumes on letting go)' },
    pad: { g: ['pad:Y', 'sep:+', 'stick:L:any'], t: 'Y: the selected creature consumes the block in front of it. Hold Y and push the left stick to choose which block (it consumes on letting go)' },
    xr: { g: ['xr:B', 'sep:+', 'xr:stick:L:any'], t: 'B: the selected creature consumes the block in front of it. Hold B and push the left thumbstick to choose which block (it consumes on letting go)' },
  },
  {
    action: 'Excrete (selected creature)',
    mk: { g: ['key:Q'], t: 'Q: the selected creature excretes the item in its tail slot. Hold Q and press WASD / the arrows to choose where (it excretes on letting go)' },
    pad: { g: ['pad:B', 'sep:+', 'stick:L:any'], t: 'B: the selected creature excretes the item in its tail slot. Hold B and push the left stick to choose where (it excretes on letting go)' },
    xr: { g: ['xr:A', 'sep:+', 'xr:stick:L:any'], t: 'A: the selected creature excretes the item in its tail slot. Hold A and push the left thumbstick to choose where (it excretes on letting go)' },
  },
  {
    action: 'Wander / Wait (selected creature)',
    mk: { g: ['text:—'], t: 'No keyboard / mouse binding yet' },
    pad: { g: ['pad:view'], t: 'View (Back): Wait, or resume what it was doing (toggle)' },
    xr: { g: ['xr:Y', 'sep:/', 'xr:X'], t: 'Left Y: Wander (opens the menu when nothing is selected), left X: Wait' },
  },
  {
    action: 'Options (pauses)',
    mk: { g: ['key:Esc', 'sep:/', 'hud:menu'], t: 'Esc or Enter, or click the gear button (top left)' },
    pad: { g: ['pad:start'], t: 'Start / Menu button' },
    xr: { g: ['hud:menu', 'sep:/', 'xr:Y'], t: 'Point at the gear (Options, on the left controller) and pull the trigger, or press Y' },
  },
  {
    action: 'Move / dock a panel',
    mk: { g: ['text:—'], t: 'The panels keep to the window’s corners: drag a panel’s corner grip to resize it' },
    pad: { g: ['text:—'], t: 'The panels keep to the window’s corners' },
    xr: {
      g: ['xr:grip:L', 'sep:/', 'xr:grip:R'],
      t: 'Grip a panel (touching or pointing at it) to take it; let go near the other controller to dock it there, anywhere else to leave it. Double-tap a grip at a panel to dock it on that controller, or at nothing to undock that controller’s panels. Triple-tap a grip to bring every undocked panel to that controller. While gripping a panel, a creature or the build, that hand’s thumbstick up / down pushes it away / reels it in, and left / right turns the build about that controller’s ray',
    },
  },
  {
    action: 'Carry a creature',
    mk: { g: ['text:—'], t: 'XR only' },
    pad: { g: ['text:—'], t: 'XR only' },
    xr: { g: ['xr:grip:L', 'sep:/', 'xr:grip:R'], t: 'Grip a creature (touching it with the cell in front of the controller, or pointing at it) to pick it up out of the grid; let go to put it back in, in the nearest cells it fits, selected. It wriggles (shakes, and buzzes in your hand) while you carry it' },
  },
  {
    action: 'Rotate view',
    mk: { g: ['mouse:L', 'sep:/', 'mouse:R'], t: 'Left- or right-drag (a left click without dragging uses the tool; a right click deselects)' },
    pad: { g: ['stick:R:any'], t: 'Right stick' },
    xr: { g: ['xr:grip:L', 'sep:+', 'xr:grip:R'], t: 'Grip blocks with both hands (touching or pointing at them) and turn your hands around each other (or walk around)' },
  },
  {
    action: 'Zoom',
    mk: { g: ['mouse:wheel'], t: 'Mouse wheel' },
    pad: { g: ['pad:LT', 'sep:/', 'pad:RT'], t: 'LT: zoom out, RT: zoom in' },
    xr: { g: ['xr:grip:L', 'sep:+', 'xr:grip:R'], t: 'Grip blocks with both hands and move your hands apart / together' },
  },
  {
    action: 'Pan / move',
    mk: { g: ['mouse:M'], t: 'Middle-drag' },
    pad: { g: ['dpad:any'], t: 'D-pad' },
    xr: { g: ['xr:grip:L', 'sep:/', 'xr:grip:R'], t: 'Grip a block (touching it with the cell in front of the controller, or pointing at it) and move your hand to drag the build. A grip on nothing does nothing' },
  },
  {
    action: 'Menu select',
    mk: { g: ['mouse:L'], t: 'Click' },
    pad: { g: ['dpad:ud', 'sep:+', 'pad:A'], t: 'D-pad up / down, then A' },
    xr: { g: ['ray', 'sep:+', 'xr:trigger:R'], t: 'Point and pull the trigger (either controller: the left one presses panels only). Hold it on a panel’s corner ridges to resize it; a thumbstick up / down scrolls Options' },
  },
  {
    action: 'Debug panel',
    mk: { g: ['key:`', 'sep:/', 'key:~'], t: '` or ~ (the key left of 1): Debug panel on / off' },
    pad: { g: ['text:—'], t: 'Options → Debug' },
    xr: { g: ['text:—'], t: 'Options → Debug' },
  },
  {
    action: 'Direction guides',
    mk: { g: ['key:G'], t: 'G: Direction Guides on / off (the lines and dots showing where a creature can step, eat or excrete)' },
    pad: { g: ['text:—'], t: 'Options → Accessibility → Direction Guides' },
    xr: { g: ['text:—'], t: 'Options → Accessibility → Direction Guides' },
  },
  {
    action: 'Menu back',
    mk: { g: ['key:Esc'], t: 'Esc' },
    pad: { g: ['pad:B'], t: 'B' },
    xr: { g: ['text:the Back item'], t: 'Point at Back and pull the trigger' },
  },
];

/** The default controls: looking around, building, and giving creatures orders. */
export const ObserverControlSchema = {
  id: 'observer',
  name: 'Observer',
  controls: [
    ...OBSERVER_CONTROLS,
    {
      action: 'Control schema',
      mk: { g: ['mouse:L', 'text:×2'], t: 'Double-click a creature: control it; the camera orbits it, up close' },
      pad: { g: ['stick:R:press'], t: 'R3 (press the right stick): control the selected creature; the camera orbits it, up close' },
      xr: { g: ['xr:stick:R:any', 'text:click', 'sep:/', 'xr:trigger:R', 'text:×2'], t: 'Click the right thumbstick: control the selected creature (the build grows 4× about its head); or double-press the right trigger on a creature: control it' },
    },
  ],
};

/**
 * Controlling the selected creature (R3 with a creature selected; R3 again, or deselecting
 * it, goes back to Observer): the camera orbits the creature's head, up close, and follows it
 * (no panning); the gamepad's left stick moves the creature, relative to the camera (on its
 * turn); and no tools (using, aiming or switching them): those
 * belong to the Observer.
 */
const TOOL_ACTIONS = new Set(['Use tool', 'Aim', 'Change tool']); // (only Select, to send it somewhere: 'Send creature')
export const CreatureControlSchema = {
  id: 'creature',
  name: 'Creature',
  controls: [
    {
      action: 'Send creature',
      mk: { g: ['mouse:L'], t: 'Click a cell beside a surface it walks on: it walks there (the dotted line shows the way); click another creature: it goes after it, wherever it goes. Steering it, or any other order, stops it' },
      pad: { g: ['pad:A'], t: 'A at the crosshair: it walks there; steering it, or any other order, stops it' },
      xr: { g: ['ray', 'sep:+', 'xr:trigger:R'], t: 'Point at a cell beside a surface it walks on and pull the right trigger: it walks there (the dotted line shows the way); at another creature: it goes after it, wherever it goes. Steering it, or any other order, stops it' },
    },
    {
      action: 'Move creature',
      mk: { g: ['key:W', 'key:A', 'key:S', 'key:D', 'sep:/', 'key:↑', 'key:←', 'key:↓', 'key:→'], t: 'WASD or the arrow keys: move the controlled creature, relative to the camera (on its turn)' },
      pad: { g: ['stick:L:any'], t: 'Left stick: moves the selected creature, relative to the camera (on its turn)' },
      xr: { g: ['xr:stick:L:any'], t: 'Left thumbstick: moves the controlled creature, relative to your view (on its turn)' },
    },
    {
      action: 'Move away from camera',
      mk: { g: ['key:Shift'], t: 'Shift (held): the creature steps the way most nearly away from the camera' },
      pad: { g: ['stick:L:press'], t: 'L3 (hold the left stick in): the creature steps the way most nearly away from the camera' },
      xr: { g: ['xr:stick:L:any', 'text:click'], t: 'Hold the left thumbstick in: the creature steps the way most nearly away from you' },
    },
    ...OBSERVER_CONTROLS.filter((row) => !TOOL_ACTIONS.has(row.action) && row.action !== 'Move selected creature'),
    {
      action: 'Control schema',
      mk: { g: ['mouse:L', 'text:×2'], t: 'Double-click the creature: back to Observer controls (another creature: control that one instead)' },
      pad: { g: ['stick:R:press'], t: 'R3 (press the right stick): back to Observer controls; the camera orbits the world again' },
      xr: { g: ['xr:stick:R:any', 'text:click', 'sep:/', 'xr:trigger:R', 'text:×2'], t: 'Click the right thumbstick: back to Observer controls (the build shrinks back); or double-press the right trigger on the creature (another creature: control that one instead)' },
    },
  ],
};

/** The control schemas by id (Engine state.controlSchema). */
export const CONTROL_SCHEMAS = { observer: ObserverControlSchema, creature: CreatureControlSchema };
