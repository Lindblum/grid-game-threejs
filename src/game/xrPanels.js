import * as THREE from 'three';
import { TOOLS } from './tools.js';
import { drawToolIcon, drawMenuIcon, roundRect } from './icons.js';
import { drawMenuItemIcon } from './menuIcons.js';
import { CONTROL_SCHEMAS, CONTROL_COLUMNS } from './controls.js';
import { splitLabel } from './menu.js';
import { gridMode } from './lattice.js';
/** The rows of the Controls table of control schema `table` (id). */
const tableRows = (table) => (CONTROL_SCHEMAS[table] ?? CONTROL_SCHEMAS.observer).controls;
import { drawCell, cellWidth } from './inputIcons.js';

/** A flat plane textured with a 2D canvas, used for in-world UI panels in XR. */
class CanvasPanel {
  constructor(pxW, pxH, widthM) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const heightM = (widthM * pxH) / pxW;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), this.material);
    this.mesh.renderOrder = 10;
  }
}

const PX_TO_M = 0.17 / 1000; // shared pixel density for the controller HUDs

function hudBackground(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  roundRect(ctx, 4, 4, W - 8, H - 8, 34);
  ctx.fillStyle = 'rgba(18, 22, 30, 0.6)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function hudLabel(ctx, text, x, color = '#e8ecf2') {
  ctx.fillStyle = color;
  ctx.font = '600 34px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, 40);
}

/** Hover just above a controller, tilted back toward the eyes. */
export const HUD_DOCK = {
  up: 0.045, // m above the controller's grip
  forward: 0.09, // m in front of the grip
  tilt: -Math.PI / 2, // tilted back so the face points up toward the eyes (0 = upright)
};

export function dockAboveController(mesh) {
  mesh.position.set(0, HUD_DOCK.up, -HUD_DOCK.forward);
  mesh.rotation.set(HUD_DOCK.tilt, 0, 0);
}

const SLOT = 104, SLOT_GAP = 14, SLOT_Y = 72;

/** Left HUD (docked to the left controller): game time and the Menu button. */
export class LeftHudPanel extends CanvasPanel {
  constructor() {
    super(200, 250, 200 * PX_TO_M); // time, Mean Diameter, then the Menu button
    this.mesh.name = 'xr-hud-left';
    dockAboveController(this.mesh);
    this.button = { x: (200 - SLOT) / 2, y: SLOT_Y + 44, w: SLOT, h: SLOT };
    this._last = '';
  }

  draw(hover, menuOpen, timeText = '00:00:00', diameterText = '') {
    const sig = `${hover}|${menuOpen}|${timeText}|${diameterText}`;
    if (sig === this._last) return;
    this._last = sig;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    hudBackground(ctx, W, H);
    hudLabel(ctx, timeText, W / 2); // game time HH:mm:ss
    const { x, y, w, h } = this.button;
    roundRect(ctx, x, y, w, h, 16);
    ctx.fillStyle = hover ? 'rgba(90, 160, 255, 0.55)' : menuOpen ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)';
    ctx.fill();
    if (hover || menuOpen) {
      roundRect(ctx, x - 3, y - 3, w + 6, h + 6, 18);
      ctx.strokeStyle = hover ? '#9cc8ff' : '#ffffff';
      ctx.lineWidth = 7;
      ctx.stroke();
    }
    drawMenuIcon(ctx, x + w / 2, y + h / 2, w * 0.8);
    // Mean Diameter between the time and the button
    ctx.fillStyle = 'rgba(232, 236, 242, 0.75)';
    ctx.font = '600 28px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(diameterText, W / 2, 84);
    this.texture.needsUpdate = true;
  }

  /** uv from a raycast hit -> 'menu' or null. */
  hitTest(uv) {
    const px = uv.x * this.canvas.width, py = (1 - uv.y) * this.canvas.height;
    const { x, y, w, h } = this.button;
    return px >= x - 8 && px <= x + w + 8 && py >= y - 8 && py <= y + h + 8 ? 'menu' : null;
  }
}

/** Right HUD (docked to the right controller): the tool selector. */
export class RightHudPanel extends CanvasPanel {
  constructor() {
    const W = TOOLS.length * SLOT + (TOOLS.length - 1) * SLOT_GAP + 72;
    super(W, 200, W * PX_TO_M);
    this.mesh.name = 'xr-hud-right';
    dockAboveController(this.mesh);
    this._last = '';
  }

  /** `style`: the icons' look ({ materials, smooth }, see drawToolIcon). `hover`: the slot under the gaze, if any. */
  draw(toolIndex, message, label = TOOLS[toolIndex].label, style = {}, hover = null) {
    const sig = `${toolIndex}|${message || ''}|${label}|${style.materials}|${!!style.smooth}|${hover}|${gridMode()}`; // (icons show the grid's block shape)
    if (sig === this._last) return;
    this._last = sig;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    hudBackground(ctx, W, H);
    const total = TOOLS.length * SLOT + (TOOLS.length - 1) * SLOT_GAP;
    const x0 = (W - total) / 2;
    if (message) {
      hudLabel(ctx, message, W / 2, '#ffd166'); // messages stay centred
    } else {
      // tool name directly above the selected slot, kept inside the panel
      ctx.font = '600 34px system-ui, -apple-system, Segoe UI, sans-serif';
      const half = ctx.measureText(label).width / 2;
      const cx = x0 + toolIndex * (SLOT + SLOT_GAP) + SLOT / 2;
      hudLabel(ctx, label, Math.min(Math.max(cx, 28 + half), W - 28 - half));
    }
    TOOLS.forEach((t, i) => {
      const x = x0 + i * (SLOT + SLOT_GAP);
      roundRect(ctx, x, SLOT_Y, SLOT, SLOT, 16);
      ctx.fillStyle = i === hover ? 'rgba(90, 160, 255, 0.55)' : i === toolIndex ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)';
      ctx.fill();
      drawToolIcon(ctx, t, x + SLOT / 2, SLOT_Y + SLOT / 2, SLOT * 0.78, style);
      if (i === toolIndex || i === hover) {
        roundRect(ctx, x - 3, SLOT_Y - 3, SLOT + 6, SLOT + 6, 18);
        ctx.strokeStyle = i === hover ? '#9cc8ff' : '#ffffff';
        ctx.lineWidth = 7;
        ctx.stroke();
      }
    });
    this.texture.needsUpdate = true;
  }

  /** uv from a raycast hit -> the index of the tool slot under it, or null. */
  hitTest(uv) {
    const px = uv.x * this.canvas.width, py = (1 - uv.y) * this.canvas.height;
    const x0 = (this.canvas.width - (TOOLS.length * SLOT + (TOOLS.length - 1) * SLOT_GAP)) / 2;
    if (py < SLOT_Y - 6 || py > SLOT_Y + SLOT + 6) return null;
    const i = Math.floor((px - x0 + SLOT_GAP / 2) / (SLOT + SLOT_GAP));
    return i >= 0 && i < TOOLS.length ? i : null;
  }
}

const MENU_WIDTH_M = 0.31; // wide enough for the longer Options labels
// an open dropdown's choices: two to a row beneath its button, indented (from xr-music-threejs)
const OPTION_H = 52, OPTION_GAP = 12, OPTION_INDENT = 54, OPTION_ICON = 32, CHECK = 30;
const OPTION_FONT = '400 28px system-ui, -apple-system, Segoe UI, sans-serif';

/** Two choices to a row, or one when a label wouldn't fit in half the width `w`. */
function optionColumns(ctx, options, w) {
  ctx.font = OPTION_FONT;
  const room = (w - OPTION_GAP) / 2 - 36 - CHECK - 10;
  return options.every((o) => ctx.measureText(o.label).width + (o.icon ? OPTION_ICON + 14 : 0) <= room) ? 2 : 1;
}

/** What a menu button's right edge shows: an arrow to a submenu, or a dropdown's (or section's) chevron. */
function trailingIcon(it) {
  if (it.submenu) return 'forward';
  const open = (it.dropdown ?? it.section)?.open;
  if (open !== undefined) return open ? 'dropdownOpen' : 'dropdown';
  return null;
}

// the menu's buttons: height and gap; the Controls table's header and rows
const BUTTON_H = 70, BUTTON_GAP = 12, TABLE_HEAD = 44, TABLE_ROW = 66;
const tableHeight = (table) => TABLE_HEAD + tableRows(table).length * TABLE_ROW + BUTTON_GAP;

/** Menu panel for XR: docked above the Left HUD (or floating in front of the face if there is no left controller). */
export class MenuPanel extends CanvasPanel {
  constructor() {
    super(954, 1760, MENU_WIDTH_M); // same pixel density as before (800 px per 0.26 m); tall enough for Options with Controls open
    this.anchorBottom = false;
    this.mesh.name = 'xr-menu';
    this.material.depthTest = false;
    this.mesh.renderOrder = 20;
    this.rects = [];
    this._last = '';
  }

  draw(model, hoverId) {
    const sig = JSON.stringify([model, hoverId, this.anchorBottom]);
    if (sig === this._last) return;
    this._last = sig;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    // Panel is sized to its content (the rest of the canvas stays transparent).
    const bx = 70, bw = W - 140;
    const contentH = Math.min(H - 12, 150 + this._itemsHeight(ctx, model.items, bw) + 40);
    // When docked above the Left HUD the panel grows upward from its bottom edge.
    const offY = this.anchorBottom ? H - 12 - contentH : 0;
    this.content = { x: 6, y: 6 + offY, w: W - 12, h: contentH }; // visible panel box (canvas px)
    ctx.save();
    ctx.translate(0, offY);
    roundRect(ctx, 6, 6, W - 12, contentH, 48);
    ctx.fillStyle = 'rgba(18, 22, 30, 0.62)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 60px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(model.title, W / 2, 84);

    this.rects = [];
    this._drawItems(ctx, model.items, bx, 150, bw, hoverId, offY);
    ctx.restore();
    this.texture.needsUpdate = true;
  }

  /** The height of `items` drawn `w` wide: their buttons, open dropdowns' choices and open sections. */
  _itemsHeight(ctx, items, w) {
    return items.reduce((sum, it) => {
      sum += BUTTON_H + BUTTON_GAP;
      if (it.dropdown?.open) {
        const { options } = it.dropdown;
        sum += Math.ceil(options.length / optionColumns(ctx, options, w - OPTION_INDENT)) * (OPTION_H + OPTION_GAP);
      }
      if (it.section?.open) {
        if (it.section.table) sum += tableHeight(it.section.table);
        sum += this._itemsHeight(ctx, it.section.items, w - OPTION_INDENT);
      }
      return sum;
    }, 0);
  }

  /**
   * `items` from (x, y), `w` wide, each followed by its open dropdown's choices, or its open
   * section's Controls table and entries (indented). Returns the next y.
   */
  _drawItems(ctx, items, x, y, w, hoverId, offY) {
    for (const it of items) {
      y = this._drawItem(ctx, it, x, y, w, hoverId, offY);
      if (it.dropdown?.open) y = this._drawOptions(ctx, it.dropdown.options, x + OPTION_INDENT, y, w - OPTION_INDENT, hoverId, offY);
      if (it.section?.open) {
        if (it.section.table) y = this._drawControlsTable(ctx, x + OPTION_INDENT, y, x + w, tableRows(it.section.table)) + BUTTON_GAP;
        y = this._drawItems(ctx, it.section.items, x + OPTION_INDENT, y, w - OPTION_INDENT, hoverId, offY);
      }
    }
    return y;
  }

  /** One menu button at (bx, y), `bw` wide. Returns the next y. */
  _drawItem(ctx, it, bx, y, bw, hoverId, offY) {
    const bh = BUTTON_H;
    const hover = it.id === hoverId && !it.disabled;
    roundRect(ctx, bx, y, bw, bh, 22);
    ctx.fillStyle = it.disabled
      ? 'rgba(255,255,255,0.04)'
      : hover
        ? 'rgba(90, 160, 255, 0.55)'
        : it.accent
          ? 'rgba(90, 160, 255, 0.25)'
          : 'rgba(255,255,255,0.10)';
    ctx.fill();
    if (hover) {
      ctx.strokeStyle = '#9cc8ff';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    // icon on the left, then the label (left-aligned), optional sub-text on the right
    const iconSize = 46;
    drawMenuItemIcon(ctx, it.icon, bx + 22 + iconSize / 2, y + bh / 2, iconSize, { alpha: it.disabled ? 0.45 : 1 });
    const tx = bx + 22 + iconSize + 18;
    let right = bx + bw - 28;
    const trailing = trailingIcon(it);
    if (trailing) {
      // a submenu: Back's arrow, mirrored; a dropdown or section: a chevron. At the far right, the icons' size
      drawMenuItemIcon(ctx, trailing, bx + bw - 22 - iconSize / 2, y + bh / 2, iconSize, { alpha: it.disabled ? 0.45 : 1 });
      right = bx + bw - 22 - iconSize - 18;
    }
    ctx.textBaseline = 'middle';
    let track = null;
    if (it.slider) {
      // slider: track + knob in the right half; the label gets the left half
      const { min, max, value } = it.slider;
      track = { x0: bx + bw * 0.55, x1: bx + bw - 34, min, max, step: it.slider.step ?? 1 };
      const ty = y + bh / 2;
      const kx = track.x0 + ((value - min) / (max - min)) * (track.x1 - track.x0);
      ctx.lineCap = 'round';
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.moveTo(track.x0, ty); ctx.lineTo(track.x1, ty); ctx.stroke();
      ctx.strokeStyle = '#5aa0ff';
      ctx.beginPath(); ctx.moveTo(track.x0, ty); ctx.lineTo(kx, ty); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(kx, ty, 17, 0, Math.PI * 2); ctx.fill();
      right = track.x0 - 24;
    }
    if (it.sub) {
      ctx.font = '400 24px system-ui, -apple-system, Segoe UI, sans-serif';
      const sub = fit(ctx, it.sub, bw * 0.3);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(sub, right, y + bh / 2);
      right -= ctx.measureText(sub).width + 24;
    }
    ctx.font = '500 34px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = it.disabled ? 'rgba(255,255,255,0.4)' : '#ffffff';
    // "Name: Value": the name on the left, the value against the right edge
    const { name, value } = splitLabel(it.label);
    ctx.fillText(fit(ctx, name, right - tx), tx, y + bh / 2);
    if (value) {
      const room = right - tx - ctx.measureText(name).width - 30;
      ctx.textAlign = 'right';
      ctx.fillText(fit(ctx, value, room), right, y + bh / 2);
    }
    ctx.textAlign = 'center';
    if (!it.disabled) this.rects.push({ id: it.id, x: bx, y: y + offY, w: bw, h: bh, track });
    return y + bh + BUTTON_GAP;
  }

  /**
   * An open dropdown's choices, two to a row from (x, y): the current one lit and ticked, the ones
   * this device can't use dimmed (and not pointable). Returns the next y.
   */
  _drawOptions(ctx, options, x, y, w, hoverId, offY) {
    const cols = optionColumns(ctx, options, w);
    const ow = (w - (cols - 1) * OPTION_GAP) / cols;
    options.forEach((option, i) => {
      const ox = x + (i % cols) * (ow + OPTION_GAP), oy = y + Math.floor(i / cols) * (OPTION_H + OPTION_GAP);
      const hover = option.id === hoverId && !option.disabled;
      ctx.globalAlpha = option.disabled ? 0.4 : 1;
      roundRect(ctx, ox, oy, ow, OPTION_H, 14);
      ctx.fillStyle = hover ? 'rgba(90, 160, 255, 0.55)' : option.selected ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.fill();
      ctx.strokeStyle = hover ? '#9cc8ff' : option.selected ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = hover ? 4 : 2;
      ctx.stroke();
      let tx = ox + 18;
      if (option.icon) {
        drawMenuItemIcon(ctx, option.icon, tx + OPTION_ICON / 2, oy + OPTION_H / 2, OPTION_ICON, { alpha: ctx.globalAlpha });
        tx += OPTION_ICON + 14;
      }
      if (option.selected) drawMenuItemIcon(ctx, 'check', ox + ow - 18 - CHECK / 2, oy + OPTION_H / 2, CHECK, { alpha: ctx.globalAlpha });
      ctx.font = OPTION_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(fit(ctx, option.label, ox + ow - 18 - tx - (option.selected ? CHECK + 10 : 0)), tx, oy + OPTION_H / 2);
      ctx.globalAlpha = 1;
      if (!option.disabled) this.rects.push({ id: option.id, x: ox, y: oy + offY, w: ow, h: OPTION_H });
    });
    return y + Math.ceil(options.length / cols) * (OPTION_H + OPTION_GAP);
  }

  /** Options → Controls table, from x0 to x1: Action | Mouse/Keyboard | Gamepad | XR Controller. Returns bottom y. */
  _drawControlsTable(ctx, x0, y0, x1, rows) {
    const headH = TABLE_HEAD, rowH = TABLE_ROW;
    const widths = [178, 200, 188, 194];
    const colX = widths.map((_, i) => x0 + widths.slice(0, i).reduce((a, b) => a + b, 0));
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = '700 18px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = 'rgba(232,236,242,0.65)';
    CONTROL_COLUMNS.forEach((column, i) => ctx.fillText(column, colX[i] + 8, y0 + headH / 2));
    let y = y0 + headH;
    const glyphH = 40;
    rows.forEach((row, r) => {
      if (r % 2 === 0) {
        roundRect(ctx, x0, y + 2, x1 - x0, rowH - 4, 12);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fill();
      }
      ctx.font = '600 21px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(fit(ctx, row.action, widths[0] - 12), colX[0] + 8, y + rowH / 2);
      [row.mk, row.pad, row.xr].forEach((binding, i) => {
        const avail = widths[i + 1] - 12;
        const h = Math.min(glyphH, (glyphH * avail) / Math.max(1, cellWidth(ctx, binding.g, glyphH)));
        drawCell(ctx, binding.g, colX[i + 1] + 8, y + rowH / 2, h);
      });
      y += rowH;
    });
    return y;
  }

  /** uv from a raycast hit -> item id (or null). */
  hitTest(uv) {
    const px = uv.x * this.canvas.width;
    const py = (1 - uv.y) * this.canvas.height;
    const r = this.rects.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
    return r ? r.id : null;
  }

  /** For a slider item: the value under uv (clamped to the track, snapped to its step), else null. */
  sliderValueAt(uv, id) {
    const r = this.rects.find((q) => q.id === id);
    if (!r?.track) return null;
    const { x0, x1, min, max, step } = r.track;
    const t = Math.min(1, Math.max(0, (uv.x * this.canvas.width - x0) / (x1 - x0)));
    return Math.round((min + t * (max - min)) / step) * step;
  }

  /** Whether `uv` is over slider item `id`'s track (not its label): what the gaze can set. */
  onSliderTrack(uv, id) {
    const r = this.rects.find((q) => q.id === id);
    return !!r?.track && uv.x * this.canvas.width >= r.track.x0 - 30;
  }

  /** True when `uv` is on the visible panel (not the transparent rest of the canvas). */
  contains(uv) {
    const c = this.content;
    if (!c) return false;
    const px = uv.x * this.canvas.width;
    const py = (1 - uv.y) * this.canvas.height;
    return px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h;
  }
}

/** `text` broken into lines no wider than maxW (at word breaks; a long word stays whole). */
function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (line.trim() && ctx.measureText(line + word).width > maxW) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line += word;
    }
    out.push(line);
  }
  return out;
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

/** The debug tablet's pixel density (canvas px per metre): its text is always this size, however big the tablet. */
const TABLET_PX_PER_M = 1000 / 0.34;
/** The debug tablet's size (m): at first, and the limits when resizing it (drag its corner handle). */
export const TABLET_SIZE = { width: 0.34, height: 0.26, minWidth: 0.2, minHeight: 0.16, maxWidth: 0.8, maxHeight: 0.7 };
const TABLET_GRIP_PX = 64; // the resize handle: this square in the bottom-right corner
const LOG_COLORS = { log: '#c9d1dc', info: '#9cc8ff', warn: '#ffd166', error: '#ff8a80' };

/**
 * Debug tablet for XR: a free-floating panel showing the same content as the browser's Debug
 * dock: Performance (FPS and timings), the Inspector (properties of the selected / targeted
 * block), Claude (the prompt: typed with the system keyboard, dictated or cleared; not sent
 * anywhere yet), then the recent console log; each section collapses (trigger on its header). It lives in the scene, can be picked up and moved with
 * either grip, and resized by dragging its bottom-right corner with the trigger: the panel
 * gets bigger or smaller, its text keeps its size (more or fewer rows and log lines fit).
 */
export class DebugTablet extends CanvasPanel {
  constructor() {
    super(Math.round(TABLET_SIZE.width * TABLET_PX_PER_M), Math.round(TABLET_SIZE.height * TABLET_PX_PER_M), TABLET_SIZE.width);
    this.mesh.name = 'xr-debug-tablet';
    this.mesh.visible = false;
    this.width = TABLET_SIZE.width;
    this.height = TABLET_SIZE.height;
    this._last = '';
  }

  /**
   * Sets the tablet's size (m, clamped to TABLET_SIZE's limits), keeping its top-left corner
   * where it is: a bigger canvas at the same pixel density, so the contents don't scale.
   */
  setSize(widthM, heightM) {
    const w = Math.min(TABLET_SIZE.maxWidth, Math.max(TABLET_SIZE.minWidth, widthM));
    const h = Math.min(TABLET_SIZE.maxHeight, Math.max(TABLET_SIZE.minHeight, heightM));
    const pxW = Math.round(w * TABLET_PX_PER_M), pxH = Math.round(h * TABLET_PX_PER_M);
    if (pxW === this.canvas.width && pxH === this.canvas.height) return;
    // keep the top-left corner in place: the plane is centred on the mesh's position
    const shift = new THREE.Vector3((w - this.width) / 2, -(h - this.height) / 2, 0).applyQuaternion(this.mesh.quaternion);
    this.mesh.position.add(shift);
    this.width = w;
    this.height = h;
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    // a texture can't change size once uploaded: a new one for the new canvas
    this.texture.dispose();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material.map = this.texture;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(w, h);
    this._last = ''; // redraw
  }

  /** Whether `uv` (a ray hit on the tablet) is on its resize handle (bottom-right corner). */
  onResizeHandle(uv) {
    const px = uv.x * this.canvas.width, py = (1 - uv.y) * this.canvas.height;
    return px >= this.canvas.width - TABLET_GRIP_PX && py >= this.canvas.height - TABLET_GRIP_PX;
  }

  /** The id of the control under `uv` (a section header, the prompt box or a button), else null. */
  hitTest(uv) {
    const px = uv.x * this.canvas.width, py = (1 - uv.y) * this.canvas.height;
    const r = (this.hits ?? []).find((q) => px >= q.x && px <= q.x + q.w && py >= q.y && py <= q.y + q.h);
    return r ? r.id : null;
  }

  /**
   * The same content as the browser's Debug dock, top to bottom: Performance, Inspector, Claude
   * (reply area, prompt box, microphone / clear / Send) and Logging, each under a header the
   * trigger collapses or expands (shared with the dock). Logging takes the leftover height.
   * d = { info: { title, rows }, perf: [[label, text]], logs, logVersion, highlight (grabbed or
   * pointed at: brighter rim), handleHot (resize handle pointed at / dragged), claude: { prompt,
   * listening, micSupported, speaking, speechSupported, response }, collapsed: { performance, … }, hover: id under the ray }.
   */
  draw(d) {
    const { info, perf, logs, logVersion, highlight, handleHot = false, claude, collapsed, hover } = d;
    const sig = JSON.stringify([info, perf, logVersion, highlight, handleHot, claude, collapsed, hover]);
    if (sig === this._last) return;
    this._last = sig;
    const { ctx } = this;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, 4, 4, W - 8, H - 8, 30);
    ctx.fillStyle = 'rgba(12, 15, 22, 0.66)';
    ctx.fill();
    ctx.strokeStyle = highlight ? '#9cc8ff' : 'rgba(255,255,255,0.22)';
    ctx.lineWidth = highlight ? 6 : 3;
    ctx.stroke();

    const sans = (size, weight = 400) => `${weight} ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
    const mono = (size, weight = 400) => `${weight} ${size}px ui-monospace, Consolas, monospace`;
    const PAD = 32, IN = 40; // left edge of headers / of content
    const HEAD = 42, ROW = 30, LINE = 26;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = sans(34, 700);
    ctx.fillText('Debug', PAD, 42);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = sans(22);
    ctx.fillText(fit(ctx, 'grip to move · trigger on corner to resize', W - 200), W - PAD, 42);
    ctx.textAlign = 'left';
    this.hits = [];

    /** A section header (y: its top); returns the top of its content. */
    const header = (id, title, summary, y) => {
      const hot = hover === `section:${id}`;
      if (hot) {
        roundRect(ctx, PAD - 10, y, W - 2 * PAD + 20, HEAD, 10);
        ctx.fillStyle = 'rgba(90, 160, 255, 0.2)';
        ctx.fill();
      }
      const cy = y + HEAD / 2;
      ctx.font = sans(20, 700);
      ctx.fillStyle = hot ? '#ffffff' : 'rgba(255,255,255,0.5)';
      const label = title.toUpperCase();
      ctx.fillText(label, PAD, cy);
      const lw = ctx.measureText(label).width;
      ctx.textAlign = 'right';
      ctx.fillText(collapsed[id] ? '▸' : '▾', W - PAD, cy);
      ctx.textAlign = 'left';
      if (collapsed[id] && summary) {
        ctx.font = mono(20);
        ctx.fillStyle = '#e8ecf2';
        ctx.fillText(fit(ctx, summary, W - 2 * PAD - lw - 60), PAD + lw + 16, cy);
      }
      this.hits.push({ id: `section:${id}`, x: PAD - 10, y, w: W - 2 * PAD + 20, h: HEAD });
      return y + HEAD + 4;
    };
    const kv = (k, v, x, y, valueX, maxW) => {
      ctx.font = mono(22, 600);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(fit(ctx, k, valueX - x - 12), x, y);
      ctx.font = mono(22);
      ctx.fillStyle = '#e8ecf2';
      ctx.fillText(fit(ctx, String(v), maxW), valueX, y);
    };
    const box = (x, y, w, h, r, fill, stroke) => {
      roundRect(ctx, x, y, w, h, r);
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    };

    // heights of what goes below the Inspector, so its rows stop in time
    const CLAUDE_H = 56 + 8 + 48 + 8 + 70 + 8 + 48 + 8;
    const below = HEAD + 14 + (collapsed.claude ? 0 : CLAUDE_H) + HEAD + 14 + (collapsed.logging ? 0 : 4 * LINE + 12);

    // Performance: two columns when the tablet is wide enough
    let y = header('performance', 'Performance', perf[0] ? `${perf[0][1]} FPS` : '', 72);
    if (!collapsed.performance) {
      const cols = W >= 700 ? 2 : 1;
      perf.forEach(([k, v], i) => {
        const col = i % cols, line = Math.floor(i / cols);
        const x0 = col * (W / 2) + IN;
        kv(k, v, x0, y + ROW / 2 + line * ROW, x0 + 110, W / cols - 150);
      });
      y += Math.ceil(perf.length / cols) * ROW + 8;
    }

    // Inspector: as many rows as fit, leaving room for Claude and Logging
    y = header('inspector', 'Inspector', info.title, y + 6);
    if (!collapsed.inspector) {
      ctx.font = sans(26, 600);
      ctx.fillStyle = '#e8ecf2';
      ctx.fillText(fit(ctx, info.title, W - 2 * PAD), PAD, y + 18);
      y += 38;
      const valueX = Math.min(270, W * 0.4);
      const rowsFit = Math.max(0, Math.floor((H - 24 - below - y) / ROW));
      const shown = info.rows.length > rowsFit ? Math.max(0, rowsFit - 1) : info.rows.length;
      for (const [k, v] of info.rows.slice(0, shown)) {
        kv(k, v, IN, y + ROW / 2, valueX, W - valueX - IN);
        y += ROW;
      }
      if (info.rows.length > shown) {
        ctx.font = sans(20);
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillText(`… ${info.rows.length - shown} more (make the tablet taller)`, IN, y + ROW / 2);
        y += ROW;
      }
    }

    // Claude: reply area (not connected yet), the prompt box (trigger: the system keyboard), buttons
    y = header('claude', 'Claude', 'Not connected', y + 10);
    if (!collapsed.claude) {
      const w = W - 2 * PAD;
      const button = (id, x, bw, { icon, text, disabled = false, active = false, activeColor = 'red' }) => {
        const hot = hover === id && !disabled;
        box(x, y, bw, 48, 10,
          active ? (activeColor === 'blue' ? 'rgba(90, 160, 255, 0.45)' : 'rgba(255, 90, 90, 0.45)') : hot ? 'rgba(90, 160, 255, 0.4)' : 'rgba(255,255,255,0.09)',
          active ? (activeColor === 'blue' ? '#9cc8ff' : '#ff8a80') : hot ? '#9cc8ff' : 'rgba(255,255,255,0.14)');
        if (icon) drawMenuItemIcon(ctx, icon, x + bw / 2, y + 24, 30, { alpha: disabled ? 0.45 : 1 });
        if (text) {
          ctx.font = sans(22, 500);
          ctx.textAlign = 'center';
          ctx.fillStyle = disabled ? 'rgba(255,255,255,0.4)' : '#ffffff';
          ctx.fillText(text, x + bw / 2, y + 24);
          ctx.textAlign = 'left';
        }
        if (!disabled) this.hits.push({ id, x, y, w: bw, h: 48 });
      };
      box(PAD, y, w, 56, 12, 'rgba(0,0,0,0.3)');
      ctx.font = mono(20);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(fit(ctx, claude.response, w - 32), PAD + 16, y + 28);
      y += 56 + 8;

      // read the response feed aloud (speech synthesis)
      button('speak', PAD, 64, { icon: 'speak', active: claude.speaking, activeColor: 'blue', disabled: !claude.speechSupported });
      y += 48 + 8;

      const promptHot = hover === 'prompt';
      box(PAD, y, w, 70, 12, 'rgba(0,0,0,0.35)', promptHot ? '#9cc8ff' : claude.listening ? '#ff8a80' : 'rgba(255,255,255,0.18)');
      ctx.font = sans(22);
      if (claude.prompt) {
        ctx.fillStyle = '#e8ecf2';
        const lines = wrapText(ctx, claude.prompt, w - 32).slice(-2); // the end of a long prompt
        lines.forEach((l, i) => ctx.fillText(fit(ctx, l, w - 32), PAD + 16, y + 21 + i * 28));
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillText('Ask Claude…', PAD + 16, y + 35);
      }
      this.hits.push({ id: 'prompt', x: PAD, y, w, h: 70 });
      y += 70 + 8;

      button('mic', PAD, 64, { icon: 'mic', active: claude.listening, disabled: !claude.micSupported });
      button('clear', PAD + 72, 64, { icon: 'clear' });
      button('send', W - PAD - 110, 110, { text: 'Send', disabled: true });
      y += 48 + 8;
    }

    // Logging: newest at the bottom, filling the rest
    y = header('logging', 'Logging', `${logs.length} lines`, y + 10);
    if (!collapsed.logging) {
      box(PAD, y, W - 2 * PAD, H - 24 - y, 12, 'rgba(0,0,0,0.3)');
      const fitLines = Math.max(0, Math.floor((H - 30 - y) / LINE));
      ctx.font = mono(19);
      logs.slice(-fitLines).forEach((e, i) => {
        ctx.fillStyle = LOG_COLORS[e.level] ?? LOG_COLORS.log;
        ctx.fillText(fit(ctx, `${e.t} ${e.text}`, W - 2 * PAD - 24 - TABLET_GRIP_PX * 0.5), PAD + 12, y + LINE / 2 + 4 + i * LINE);
      });
      if (!logs.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText('No log output yet', PAD + 12, y + LINE / 2 + 4);
      }
    }

    // the resize handle: diagonal ridges in the bottom-right corner
    ctx.strokeStyle = handleHot ? '#9cc8ff' : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = handleHot ? 5 : 3;
    ctx.lineCap = 'round';
    for (const d of [18, 32, 46]) {
      ctx.beginPath();
      ctx.moveTo(W - 14 - d, H - 14);
      ctx.lineTo(W - 14, H - 14 - d);
      ctx.stroke();
    }
    this.texture.needsUpdate = true;
  }
}
