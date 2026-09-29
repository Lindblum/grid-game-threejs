// The control mappings shown on the Options → Controls panel (DOM and XR).
// Each binding: { g: glyph tokens (see inputIcons.js), t: text for tooltips / screen readers }.

export const CONTROL_COLUMNS = ['Action', 'Mouse / Keyboard', 'Gamepad', 'XR Controller'];

export const CONTROLS = [
  {
    action: 'Use tool',
    mk: { g: ['mouse:L'], t: 'Left click' },
    pad: { g: ['pad:RT'], t: 'Right trigger (RT)' },
    xr: { g: ['xr:trigger:R'], t: 'Right trigger' },
  },
  {
    action: 'Aim',
    mk: { g: ['mouse:move'], t: 'Move the mouse' },
    pad: { g: ['crosshair'], t: 'Aims at the crosshair in the screen centre' },
    xr: { g: ['ray'], t: 'Point the right controller' },
  },
  {
    action: 'Change tool',
    mk: { g: ['key:←', 'key:→', 'sep:/', 'key:0–9'], t: 'Left / Right arrows, or 1–9 and 0' },
    pad: { g: ['pad:LB', 'pad:RB'], t: 'Bumpers (LB / RB)' },
    xr: { g: ['xr:stick:R:x'], t: 'Right thumbstick left / right' },
  },
  {
    action: 'Menu',
    mk: { g: ['key:Esc', 'sep:/', 'hud:menu'], t: 'Esc or Enter, or click the ≡ button' },
    pad: { g: ['pad:start'], t: 'Start / Menu button' },
    xr: { g: ['hud:menu', 'sep:/', 'xr:Y'], t: 'Point at ≡ on the left HUD and pull the trigger, or press Y' },
  },
  {
    action: 'Rotate view',
    mk: { g: ['mouse:R'], t: 'Right-drag' },
    pad: { g: ['stick:R:any'], t: 'Right stick' },
    xr: { g: ['xr:grip:L', 'sep:+', 'xr:grip:R'], t: 'Hold both grips and turn your hands around each other (or walk around)' },
  },
  {
    action: 'Zoom',
    mk: { g: ['mouse:wheel'], t: 'Mouse wheel' },
    pad: { g: ['stick:L:y'], t: 'Left stick up / down' },
    xr: { g: ['xr:grip:L', 'sep:+', 'xr:grip:R'], t: 'Hold both grips and move your hands apart / together' },
  },
  {
    action: 'Pan / move',
    mk: { g: ['mouse:M'], t: 'Middle-drag' },
    pad: { g: ['dpad:any'], t: 'D-pad' },
    xr: { g: ['xr:grip:L', 'sep:/', 'xr:grip:R'], t: 'Hold either grip and move your hand to drag the build' },
  },
  {
    action: 'Menu select',
    mk: { g: ['mouse:L'], t: 'Click' },
    pad: { g: ['dpad:ud', 'sep:+', 'pad:A'], t: 'D-pad up / down, then A' },
    xr: { g: ['ray', 'sep:+', 'xr:trigger:R'], t: 'Point and pull the right trigger' },
  },
  {
    action: 'Menu back',
    mk: { g: ['key:Esc'], t: 'Esc' },
    pad: { g: ['pad:B'], t: 'B' },
    xr: { g: ['text:the Back item'], t: 'Point at Back and pull the trigger' },
  },
];
