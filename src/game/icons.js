import * as THREE from 'three';
import { truncatedOctahedronFaces } from './geometry.js';
import { BLOCK_COLORS } from './tools.js';

const FACES = truncatedOctahedronFaces();
const ROT = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.42, -0.62, 0, 'XYZ'));
const LIGHT = new THREE.Vector3(-0.45, 0.75, 0.6).normalize();

/** Draws a small shaded truncated octahedron icon centred at (cx, cy). */
export function drawBlockIcon(ctx, cx, cy, size, color, { alpha = 1, stroke = 'rgba(0,0,0,0.45)' } = {}) {
  const base = new THREE.Color().setStyle(color, THREE.LinearSRGBColorSpace); // raw sRGB values, no conversion (2D canvas)
  const scale = size / 3.1; // shape spans about ±1.4 units
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, size / 48);
  for (const f of FACES) {
    const n = f.normal.clone().applyMatrix4(ROT);
    if (n.z <= 1e-4) continue; // back face
    const shade = 0.42 + 0.58 * Math.max(0, n.dot(LIGHT));
    const c = base.clone().multiplyScalar(shade);
    ctx.fillStyle = `rgb(${Math.round(Math.min(1, c.r) * 255)},${Math.round(Math.min(1, c.g) * 255)},${Math.round(Math.min(1, c.b) * 255)})`;
    ctx.strokeStyle = stroke;
    ctx.beginPath();
    f.verts.forEach((v, i) => {
      const p = v.clone().applyMatrix4(ROT);
      const x = cx + p.x * scale, y = cy - p.y * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Delete tool icon: ghosted block with a red X. */
export function drawDeleteIcon(ctx, cx, cy, size) {
  drawBlockIcon(ctx, cx, cy, size, '#b0b4ba', { alpha: 0.35, stroke: 'rgba(255,255,255,0.5)' });
  const r = size * 0.3;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#ff3b30';
  ctx.lineWidth = size * 0.13;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r);
  ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx + r, cy - r);
  ctx.lineTo(cx - r, cy + r);
  ctx.stroke();
  ctx.restore();
}

export function drawToolIcon(ctx, tool, cx, cy, size) {
  if (tool.block) drawBlockIcon(ctx, cx, cy, size, BLOCK_COLORS[tool.block]);
  else drawDeleteIcon(ctx, cx, cy, size);
}

const cache = new Map();
/** PNG data URL of a tool icon (for the DOM HUD). */
export function toolIconURL(tool, size = 96) {
  const k = `${tool.id}:${size}`;
  if (!cache.has(k)) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    drawToolIcon(cv.getContext('2d'), tool, size / 2, size / 2, size * 0.9);
    cache.set(k, cv.toDataURL());
  }
  return cache.get(k);
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Menu icon: three horizontal lines (≡). */
export function drawMenuIcon(ctx, cx, cy, size, color = '#e8ecf2') {
  const w = size * 0.62, t = size * 0.1, gap = size * 0.2;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = t;
  ctx.beginPath();
  for (const dy of [-gap, 0, gap]) {
    ctx.moveTo(cx - w / 2, cy + dy);
    ctx.lineTo(cx + w / 2, cy + dy);
  }
  ctx.stroke();
  ctx.restore();
}

/** PNG data URL of the menu icon (for the DOM HUD). */
export function menuIconURL(size = 96) {
  const k = `menu:${size}`;
  if (!cache.has(k)) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    drawMenuIcon(cv.getContext('2d'), size / 2, size / 2, size * 0.9);
    cache.set(k, cv.toDataURL());
  }
  return cache.get(k);
}
