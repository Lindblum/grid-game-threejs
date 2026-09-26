import * as THREE from 'three';
import { TOOLS } from './tools.js';
import { drawToolIcon, roundRect } from './icons.js';

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

/** Tool-selector HUD docked to the left controller. */
export class HudPanel extends CanvasPanel {
  constructor() {
    super(1000, 200, 0.17);
    this.mesh.name = 'xr-hud';
    // Hover just above the left controller, tilted back toward the eyes.
    this.mesh.position.set(0, 0.045, -0.06);
    this.mesh.rotation.set(-Math.PI / 4, 0, 0);
    this._last = '';
  }

  draw(toolIndex, message) {
    const sig = `${toolIndex}|${message || ''}`;
    if (sig === this._last) return;
    this._last = sig;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, 4, 4, W - 8, H - 8, 34);
    ctx.fillStyle = 'rgba(18, 22, 30, 0.86)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = message ? '#ffd166' : '#e8ecf2';
    ctx.font = '600 34px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message || TOOLS[toolIndex].label, W / 2, 40);

    const slot = 104, gap = 14;
    const total = TOOLS.length * slot + (TOOLS.length - 1) * gap;
    const x0 = (W - total) / 2, y0 = 72;
    TOOLS.forEach((t, i) => {
      const x = x0 + i * (slot + gap);
      roundRect(ctx, x, y0, slot, slot, 16);
      ctx.fillStyle = i === toolIndex ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)';
      ctx.fill();
      drawToolIcon(ctx, t, x + slot / 2, y0 + slot / 2, slot * 0.78);
      if (i === toolIndex) {
        roundRect(ctx, x - 3, y0 - 3, slot + 6, slot + 6, 18);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 7;
        ctx.stroke();
      }
    });
    this.texture.needsUpdate = true;
  }
}

/** Pause menu panel shown 50 cm in front of the face in XR. */
export class MenuPanel extends CanvasPanel {
  constructor() {
    super(800, 960, 0.34);
    this.mesh.name = 'xr-menu';
    this.material.depthTest = false;
    this.mesh.renderOrder = 20;
    this.rects = [];
    this._last = '';
  }

  draw(model, hoverId) {
    const sig = JSON.stringify([model, hoverId]);
    if (sig === this._last) return;
    this._last = sig;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    // Panel is sized to its content (the rest of the canvas stays transparent).
    const contentH = Math.min(H - 12, 150 + model.items.length * 82 + 40);
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
    const bx = 70, bw = W - 140, bh = 70, gap = 12;
    let y = 150;
    for (const it of model.items) {
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
      ctx.fillStyle = it.disabled ? 'rgba(255,255,255,0.4)' : '#ffffff';
      ctx.font = '500 34px system-ui, -apple-system, Segoe UI, sans-serif';
      if (it.sub) {
        const labelFont = ctx.font;
        ctx.font = '400 24px system-ui, -apple-system, Segoe UI, sans-serif';
        const sub = fit(ctx, it.sub, bw * 0.3);
        const subW = ctx.measureText(sub).width;
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(sub, bx + bw - 28, y + bh / 2);
        ctx.font = labelFont;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(fit(ctx, it.label, bw - 56 - subW - 24), bx + 28, y + bh / 2);
        ctx.textAlign = 'center';
      } else {
        ctx.fillText(fit(ctx, it.label, bw - 40), W / 2, y + bh / 2);
      }
      if (!it.disabled) this.rects.push({ id: it.id, x: bx, y, w: bw, h: bh });
      y += bh + gap;
    }
    this.texture.needsUpdate = true;
  }

  /** uv from a raycast hit -> item id (or null). */
  hitTest(uv) {
    const px = uv.x * this.canvas.width;
    const py = (1 - uv.y) * this.canvas.height;
    const r = this.rects.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
    return r ? r.id : null;
  }
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
