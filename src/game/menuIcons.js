// Line-art icons shown to the left of each menu button (DOM and XR panels).
import { drawBlockIcon } from './icons.js';

const INK = '#e8ecf2';

function badge(ctx, x, y, r, fill, glyph) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = r * 0.32;
  ctx.beginPath();
  if (glyph === 'plus') {
    ctx.moveTo(x - r * 0.5, y);
    ctx.lineTo(x + r * 0.5, y);
    ctx.moveTo(x, y - r * 0.5);
    ctx.lineTo(x, y + r * 0.5);
  }
  ctx.stroke();
}

function floppy(ctx, P, s) {
  ctx.beginPath();
  ctx.moveTo(...P(0.16, 0.14));
  ctx.lineTo(...P(0.72, 0.14));
  ctx.lineTo(...P(0.86, 0.28));
  ctx.lineTo(...P(0.86, 0.86));
  ctx.lineTo(...P(0.16, 0.86));
  ctx.closePath();
  ctx.fillStyle = '#3d7fd9';
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#dfe9f7';
  ctx.fillRect(...P(0.3, 0.14), s * 0.34, s * 0.22); // shutter
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(...P(0.28, 0.54), s * 0.46, s * 0.32); // label
}

const DRAW = {
  resume(ctx, P) {
    ctx.fillStyle = '#7ee08a';
    ctx.beginPath();
    ctx.moveTo(...P(0.3, 0.18));
    ctx.lineTo(...P(0.82, 0.5));
    ctx.lineTo(...P(0.3, 0.82));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  },
  new(ctx, P, s, cx, cy) {
    drawBlockIcon(ctx, cx - s * 0.06, cy + s * 0.06, s * 0.78, '#9aa0a6');
    badge(ctx, ...P(0.78, 0.24), s * 0.19, '#43a047', 'plus');
  },
  load(ctx, P) {
    ctx.beginPath();
    ctx.moveTo(...P(0.1, 0.24));
    ctx.lineTo(...P(0.38, 0.24));
    ctx.lineTo(...P(0.48, 0.34));
    ctx.lineTo(...P(0.9, 0.34));
    ctx.lineTo(...P(0.9, 0.8));
    ctx.lineTo(...P(0.1, 0.8));
    ctx.closePath();
    ctx.fillStyle = '#f2b544';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(...P(0.1, 0.44));
    ctx.lineTo(...P(0.9, 0.44));
    ctx.stroke();
  },
  file(ctx, P) {
    ctx.beginPath();
    ctx.moveTo(...P(0.24, 0.1));
    ctx.lineTo(...P(0.6, 0.1));
    ctx.lineTo(...P(0.78, 0.28));
    ctx.lineTo(...P(0.78, 0.9));
    ctx.lineTo(...P(0.24, 0.9));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(...P(0.6, 0.1));
    ctx.lineTo(...P(0.6, 0.28));
    ctx.lineTo(...P(0.78, 0.28));
    for (const y of [0.48, 0.62, 0.76]) {
      ctx.moveTo(...P(0.36, y));
      ctx.lineTo(...P(0.66, y));
    }
    ctx.stroke();
  },
  save(ctx, P, s) {
    floppy(ctx, P, s);
  },
  savenew(ctx, P, s) {
    floppy(ctx, P, s);
    badge(ctx, ...P(0.8, 0.22), s * 0.19, '#43a047', 'plus');
  },
  options(ctx, P, s, cx, cy) {
    const teeth = 8, ro = s * 0.42, ri = s * 0.31;
    ctx.beginPath();
    for (let i = 0; i < teeth * 4; i++) {
      const a = (i / (teeth * 4)) * Math.PI * 2;
      const r = i % 4 === 1 || i % 4 === 2 ? ro : ri;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = '#9aa7b8';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1b2029';
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.13, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  },
  quit(ctx, P, s, cx, cy) {
    ctx.strokeStyle = '#ff8a80';
    ctx.beginPath();
    ctx.arc(cx, cy + s * 0.04, s * 0.32, -Math.PI / 2 + 0.75, -Math.PI / 2 - 0.75 + Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(...P(0.5, 0.1));
    ctx.lineTo(...P(0.5, 0.5));
    ctx.stroke();
  },
  back(ctx, P) {
    ctx.beginPath();
    ctx.moveTo(...P(0.82, 0.5));
    ctx.lineTo(...P(0.2, 0.5));
    ctx.moveTo(...P(0.44, 0.26));
    ctx.lineTo(...P(0.2, 0.5));
    ctx.lineTo(...P(0.44, 0.74));
    ctx.stroke();
  },
  prev(ctx, P) {
    ctx.beginPath();
    ctx.moveTo(...P(0.62, 0.22));
    ctx.lineTo(...P(0.36, 0.5));
    ctx.lineTo(...P(0.62, 0.78));
    ctx.stroke();
  },
  next(ctx, P) {
    ctx.beginPath();
    ctx.moveTo(...P(0.38, 0.22));
    ctx.lineTo(...P(0.64, 0.5));
    ctx.lineTo(...P(0.38, 0.78));
    ctx.stroke();
  },
  soundOn(ctx, P, s) {
    DRAW.speaker(ctx, P);
    const [cx, cy] = P(0.5, 0.5);
    for (const r of [0.18, 0.32]) {
      ctx.beginPath();
      ctx.arc(cx, cy, s * r, -0.8, 0.8);
      ctx.stroke();
    }
  },
  soundOff(ctx, P) {
    DRAW.speaker(ctx, P);
    ctx.strokeStyle = '#ff8a80';
    ctx.beginPath();
    ctx.moveTo(...P(0.64, 0.36));
    ctx.lineTo(...P(0.88, 0.64));
    ctx.moveTo(...P(0.88, 0.36));
    ctx.lineTo(...P(0.64, 0.64));
    ctx.stroke();
  },
  speaker(ctx, P) {
    ctx.beginPath();
    ctx.moveTo(...P(0.12, 0.38));
    ctx.lineTo(...P(0.28, 0.38));
    ctx.lineTo(...P(0.5, 0.18));
    ctx.lineTo(...P(0.5, 0.82));
    ctx.lineTo(...P(0.28, 0.62));
    ctx.lineTo(...P(0.12, 0.62));
    ctx.closePath();
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.stroke();
  },
  xr(ctx, P, s) {
    const [x, y] = P(0.08, 0.3);
    const w = s * 0.84, h = s * 0.4, r = s * 0.12;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.lineTo(...P(0.58, 0.7));
    ctx.quadraticCurveTo(...P(0.5, 0.58), ...P(0.42, 0.7));
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = '#6c7a93';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#b8e0ff';
    for (const lx of [0.3, 0.7]) {
      ctx.beginPath();
      ctx.arc(...P(lx, 0.49), s * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  controls(ctx, P, s) {
    // gamepad outline
    ctx.beginPath();
    ctx.moveTo(...P(0.3, 0.3));
    ctx.lineTo(...P(0.7, 0.3));
    ctx.quadraticCurveTo(...P(0.92, 0.3), ...P(0.95, 0.62));
    ctx.quadraticCurveTo(...P(0.97, 0.84), ...P(0.8, 0.8));
    ctx.lineTo(...P(0.66, 0.66));
    ctx.lineTo(...P(0.34, 0.66));
    ctx.lineTo(...P(0.2, 0.8));
    ctx.quadraticCurveTo(...P(0.03, 0.84), ...P(0.05, 0.62));
    ctx.quadraticCurveTo(...P(0.08, 0.3), ...P(0.3, 0.3));
    ctx.closePath();
    ctx.fillStyle = '#6c7a93';
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = s * 0.07;
    ctx.beginPath();
    ctx.moveTo(...P(0.2, 0.47)); ctx.lineTo(...P(0.36, 0.47));
    ctx.moveTo(...P(0.28, 0.39)); ctx.lineTo(...P(0.28, 0.55));
    ctx.stroke();
    ctx.fillStyle = INK;
    for (const [u, v] of [[0.7, 0.4], [0.78, 0.5]]) {
      ctx.beginPath();
      ctx.arc(...P(u, v), s * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  bgPass(ctx, P, s) {
    // framed landscape: "see the real world"
    const [x, y] = P(0.1, 0.18);
    const w = s * 0.8, h = s * 0.64;
    ctx.fillStyle = '#7fc4ff';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(...P(0.7, 0.36), s * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4caf6a';
    ctx.beginPath();
    ctx.moveTo(...P(0.1, 0.82));
    ctx.lineTo(...P(0.36, 0.46));
    ctx.lineTo(...P(0.56, 0.66));
    ctx.lineTo(...P(0.68, 0.56));
    ctx.lineTo(...P(0.9, 0.82));
    ctx.closePath();
    ctx.fill();
    ctx.strokeRect(x, y, w, h);
  },
  bgSolid(ctx, P, s) {
    const [x, y] = P(0.1, 0.18);
    const w = s * 0.8, h = s * 0.64;
    ctx.fillStyle = '#1b2029';
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  },
  info(ctx, P, s, cx, cy) {
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.36, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(...P(0.5, 0.46));
    ctx.lineTo(...P(0.5, 0.7));
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(...P(0.5, 0.32), s * 0.05, 0, Math.PI * 2);
    ctx.fill();
  },
};

export const MENU_ICON_NAMES = Object.keys(DRAW);

/** Draws menu icon `name` in a size×size box centred at (cx, cy). */
export function drawMenuItemIcon(ctx, name, cx, cy, size, { alpha = 1 } = {}) {
  const fn = DRAW[name];
  if (!fn) return;
  const x0 = cx - size / 2, y0 = cy - size / 2;
  const P = (u, v) => [x0 + u * size, y0 + v * size];
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.5, size * 0.08);
  ctx.strokeStyle = INK;
  fn(ctx, P, size, cx, cy);
  ctx.restore();
}

const cache = new Map();
/** PNG data URL of a menu icon (for the DOM menus). */
export function menuItemIconURL(name, size = 64) {
  const k = `${name}:${size}`;
  if (!cache.has(k)) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    drawMenuItemIcon(cv.getContext('2d'), name, size / 2, size / 2, size * 0.86);
    cache.set(k, cv.toDataURL());
  }
  return cache.get(k);
}
