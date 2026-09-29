import * as THREE from 'three';
import { TOOLS } from './tools.js';
import { drawToolIcon, drawMenuIcon, roundRect } from './icons.js';
import { drawMenuItemIcon } from './menuIcons.js';
import { CONTROLS, CONTROL_COLUMNS } from './controls.js';
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
  ctx.fillStyle = 'rgba(18, 22, 30, 0.86)';
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

function dockAboveController(mesh) {
  mesh.position.set(0, HUD_DOCK.up, -HUD_DOCK.forward);
  mesh.rotation.set(HUD_DOCK.tilt, 0, 0);
}

const SLOT = 104, SLOT_GAP = 14, SLOT_Y = 72;

/** Left HUD (docked to the left controller): game time and the Menu button. */
export class LeftHudPanel extends CanvasPanel {
  constructor() {
    super(200, 200, 200 * PX_TO_M);
    this.mesh.name = 'xr-hud-left';
    dockAboveController(this.mesh);
    this.button = { x: (200 - SLOT) / 2, y: SLOT_Y, w: SLOT, h: SLOT };
    this._last = '';
  }

  draw(hover, menuOpen, timeText = '00:00:00') {
    const sig = `${hover}|${menuOpen}|${timeText}`;
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

  draw(toolIndex, message, label = TOOLS[toolIndex].label) {
    const sig = `${toolIndex}|${message || ''}|${label}`;
    if (sig === this._last) return;
    this._last = sig;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    hudBackground(ctx, W, H);
    hudLabel(ctx, message || label, W / 2, message ? '#ffd166' : '#e8ecf2');

    const total = TOOLS.length * SLOT + (TOOLS.length - 1) * SLOT_GAP;
    const x0 = (W - total) / 2;
    TOOLS.forEach((t, i) => {
      const x = x0 + i * (SLOT + SLOT_GAP);
      roundRect(ctx, x, SLOT_Y, SLOT, SLOT, 16);
      ctx.fillStyle = i === toolIndex ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)';
      ctx.fill();
      drawToolIcon(ctx, t, x + SLOT / 2, SLOT_Y + SLOT / 2, SLOT * 0.78);
      if (i === toolIndex) {
        roundRect(ctx, x - 3, SLOT_Y - 3, SLOT + 6, SLOT + 6, 18);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 7;
        ctx.stroke();
      }
    });
    this.texture.needsUpdate = true;
  }
}

const MENU_WIDTH_M = 0.26;

/** Menu panel for XR: docked above the Left HUD (or floating in front of the face if there is no left controller). */
export class MenuPanel extends CanvasPanel {
  constructor() {
    super(800, 960, MENU_WIDTH_M);
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
    const TABLE_ROW = 66, TABLE_HEAD = 44;
    const tableH = model.table ? TABLE_HEAD + CONTROLS.length * TABLE_ROW + 16 : 0;
    const contentH = Math.min(H - 12, 150 + tableH + model.items.length * 82 + 40);
    // When docked above the Left HUD the panel grows upward from its bottom edge.
    const offY = this.anchorBottom ? H - 12 - contentH : 0;
    this.content = { x: 6, y: 6 + offY, w: W - 12, h: contentH }; // visible panel box (canvas px)
    ctx.save();
    ctx.translate(0, offY);
    roundRect(ctx, 6, 6, W - 12, contentH, 48);
    ctx.fillStyle = 'rgba(18, 22, 30, 0.92)';
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
    let y = 150;
    const bx = 70, bw = W - 140, bh = 70, gap = 12;
    // a leading Back button goes at the very top, above the Controls table
    const lead = model.items[0]?.id === 'back' ? 1 : 0;
    model.items.forEach((it, i) => {
      if (i === lead && model.table) y = this._drawControlsTable(ctx, W, y - 22, TABLE_HEAD, TABLE_ROW) + 16;
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
      ctx.textBaseline = 'middle';
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
      ctx.fillText(fit(ctx, it.label, right - tx), tx, y + bh / 2);
      ctx.textAlign = 'center';
      if (!it.disabled) this.rects.push({ id: it.id, x: bx, y: y + offY, w: bw, h: bh });
      y += bh + gap;
    });
    if (model.table && lead >= model.items.length) this._drawControlsTable(ctx, W, y - 22, TABLE_HEAD, TABLE_ROW);
    ctx.restore();
    this.texture.needsUpdate = true;
  }

  /** Options → Controls table: Action | Mouse/Keyboard | Gamepad | XR Controller. Returns bottom y. */
  _drawControlsTable(ctx, W, y0, headH, rowH) {
    const x0 = 20, widths = [178, 200, 188, 194];
    const colX = widths.map((_, i) => x0 + widths.slice(0, i).reduce((a, b) => a + b, 0));
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = '700 18px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = 'rgba(232,236,242,0.65)';
    CONTROL_COLUMNS.forEach((c, i) => ctx.fillText(c, colX[i] + 8, y0 + headH / 2));
    let y = y0 + headH;
    const glyphH = 40;
    CONTROLS.forEach((row, r) => {
      if (r % 2 === 0) {
        roundRect(ctx, x0, y + 2, W - 2 * x0, rowH - 4, 12);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fill();
      }
      ctx.font = '600 21px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(fit(ctx, row.action, widths[0] - 12), colX[0] + 8, y + rowH / 2);
      [row.mk, row.pad, row.xr].forEach((b, i) => {
        const avail = widths[i + 1] - 12;
        const h = Math.min(glyphH, (glyphH * avail) / Math.max(1, cellWidth(ctx, b.g, glyphH)));
        drawCell(ctx, b.g, colX[i + 1] + 8, y + rowH / 2, h);
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

  /** True when `uv` is on the visible panel (not the transparent rest of the canvas). */
  contains(uv) {
    const c = this.content;
    if (!c) return false;
    const px = uv.x * this.canvas.width;
    const py = (1 - uv.y) * this.canvas.height;
    return px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h;
  }
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
