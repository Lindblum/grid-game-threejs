import * as THREE from 'three';
import { truncatedOctahedronFaces } from './geometry.js';
import { BLOCK, BLOCK_COLORS, TOOL } from './tools.js';

const FACES = truncatedOctahedronFaces();
const ROT = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.42, -0.62, 0, 'XYZ'));
const LIGHT = new THREE.Vector3(-0.45, 0.75, 0.6).normalize();

/**
 * Draws a small shaded truncated octahedron icon centred at (cx, cy). `faceColor(normal)`
 * (block-local face normal -> THREE.Color) can give each face its own colour.
 */
export function drawBlockIcon(ctx, cx, cy, size, color, { alpha = 1, stroke = 'rgba(0,0,0,0.45)', faceColor = null } = {}) {
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
    const c = (faceColor ? faceColor(f.normal) : base.clone()).multiplyScalar(shade);
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

/**
 * Crawly icon: the block with an iridescent beetle shell (each face a different hue from
 * violet through blue to green, like its shader) and its two shiny black eyes on the front.
 */
export function drawCrawlyIcon(ctx, cx, cy, size) {
  const shell = (n) => {
    const hue = 0.78 - 0.2 * (n.x * 0.5 + 0.5) - 0.18 * (n.y * 0.5 + 0.5); // violet -> blue -> green
    return new THREE.Color().setHSL(((hue % 1) + 1) % 1, 0.75, 0.55);
  };
  drawBlockIcon(ctx, cx, cy, size, '#ffffff', { faceColor: shell });
  drawIconEyes(ctx, cx, cy, size);
}

/** Buzzy icon: dark green with a pale pearly sheen on the faces toward the light, and eyes. */
export function drawBuzzyIcon(ctx, cx, cy, size) {
  const pearl = (n) => {
    const t = 0.5 + 0.5 * n.y; // paler toward the top
    return new THREE.Color().setHSL(0.4 - 0.12 * t, 0.45, 0.2 + 0.3 * t);
  };
  drawBlockIcon(ctx, cx, cy, size, '#ffffff', { faceColor: pearl });
  drawIconEyes(ctx, cx, cy, size);
}

/** Squirmy icon: a pink, fleshy head block with eyes. */
export function drawSquirmyIcon(ctx, cx, cy, size) {
  drawBlockIcon(ctx, cx, cy, size, BLOCK_COLORS[BLOCK.SQUIRMY], { stroke: 'rgba(90,20,40,0.35)' });
  drawIconEyes(ctx, cx, cy, size);
}

/** Two glossy black eyes on the icon's front (+z) face, where they sit on a real creature. */
function drawIconEyes(ctx, cx, cy, size) {
  const scale = size / 3.1;
  ctx.save();
  for (const sx of [-0.34, 0.34]) {
    const p = new THREE.Vector3(sx, 0.05, 1.02).applyMatrix4(ROT);
    const x = cx + p.x * scale, y = cy - p.y * scale, r = 0.27 * scale;
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, '#6a6f78');
    g.addColorStop(0.35, '#15161a');
    g.addColorStop(1, '#000000');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; // catch-light
    ctx.beginPath();
    ctx.arc(x - r * 0.35, y - r * 0.38, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
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

/** Select tool icon: a pointer arrow over a small green selection ring. */
export function drawSelectIcon(ctx, cx, cy, size) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // selection ring (the green of the selection wireframes)
  ctx.strokeStyle = SELECT_GREEN;
  ctx.lineWidth = size * 0.08;
  ctx.setLineDash([size * 0.12, size * 0.09]);
  ctx.beginPath();
  ctx.arc(cx + size * 0.08, cy + size * 0.1, size * 0.3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  // arrow, tip at the upper left
  const s = size / 100, x0 = cx - size * 0.3, y0 = cy - size * 0.38;
  const pts = [[0, 0], [0, 62], [15, 48], [26, 72], [38, 67], [27, 43], [47, 43]];
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x0 + x * s, y0 + y * s) : ctx.moveTo(x0 + x * s, y0 + y * s)));
  ctx.closePath();
  ctx.fillStyle = '#f4f6f8';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = Math.max(1, size * 0.035);
  ctx.stroke();
  ctx.restore();
}

/** Colour of the Select tool's wireframes (selected Crawly, target cell). */
export const SELECT_GREEN = '#3ddc5a';

export function drawToolIcon(ctx, tool, cx, cy, size) {
  if (tool.block === BLOCK.CRAWLY) drawCrawlyIcon(ctx, cx, cy, size);
  else if (tool.block === BLOCK.BUZZY) drawBuzzyIcon(ctx, cx, cy, size);
  else if (tool.block === BLOCK.SQUIRMY) drawSquirmyIcon(ctx, cx, cy, size);
  else if (tool.block) drawBlockIcon(ctx, cx, cy, size, BLOCK_COLORS[tool.block]);
  else if (tool.id === TOOL.SELECT) drawSelectIcon(ctx, cx, cy, size);
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
