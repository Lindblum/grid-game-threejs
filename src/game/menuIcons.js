// Clean monochrome line glyphs shown to the left of each menu button (DOM and XR panels).
// Every icon is drawn with a single ink colour on a 1×1 grid (P(u, v) maps to pixels).

const INK = '#e8ecf2';

function line(ctx, P, pts) {
  ctx.beginPath();
  pts.forEach(([u, v], i) => (i ? ctx.lineTo(...P(u, v)) : ctx.moveTo(...P(u, v))));
  ctx.stroke();
}

function poly(ctx, P, pts, { fill = false } = {}) {
  ctx.beginPath();
  pts.forEach(([u, v], i) => (i ? ctx.lineTo(...P(u, v)) : ctx.moveTo(...P(u, v))));
  ctx.closePath();
  if (fill) ctx.fill();
  ctx.stroke();
}

function circle(ctx, P, u, v, r, s, { fill = false } = {}) {
  ctx.beginPath();
  ctx.arc(...P(u, v), r * s, 0, Math.PI * 2);
  if (fill) ctx.fill();
  else ctx.stroke();
}

function roundedRect(ctx, P, u, v, w, h, r, s) {
  const [x, y] = P(u, v);
  const W = w * s, H = h * s, R = r * s;
  ctx.beginPath();
  ctx.moveTo(x + R, y);
  ctx.arcTo(x + W, y, x + W, y + H, R);
  ctx.arcTo(x + W, y + H, x, y + H, R);
  ctx.arcTo(x, y + H, x, y, R);
  ctx.arcTo(x, y, x + W, y, R);
  ctx.closePath();
}

function plus(ctx, P, u, v, r) {
  line(ctx, P, [[u - r, v], [u + r, v]]);
  line(ctx, P, [[u, v - r], [u, v + r]]);
}

function floppy(ctx, P, s) {
  poly(ctx, P, [[0.18, 0.16], [0.7, 0.16], [0.84, 0.3], [0.84, 0.84], [0.18, 0.84]]);
  line(ctx, P, [[0.32, 0.16], [0.32, 0.36], [0.62, 0.36], [0.62, 0.16]]); // shutter
  roundedRect(ctx, P, 0.3, 0.56, 0.42, 0.28, 0.03, s); // label
  ctx.stroke();
}

function speaker(ctx, P) {
  poly(ctx, P, [[0.14, 0.4], [0.28, 0.4], [0.48, 0.22], [0.48, 0.78], [0.28, 0.6], [0.14, 0.6]]);
}

/** Regular hexagon (pointy top) filling most of the icon box. */
const HEX = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 3;
  return [0.5 + Math.cos(a) * 0.38, 0.5 + Math.sin(a) * 0.38];
});

const DRAW = {
  resume(ctx, P) {
    ctx.fillStyle = INK;
    poly(ctx, P, [[0.32, 0.2], [0.8, 0.5], [0.32, 0.8]], { fill: true });
  },
  new(ctx, P) {
    plus(ctx, P, 0.5, 0.5, 0.3);
  },
  load(ctx, P) {
    // open folder
    poly(ctx, P, [[0.12, 0.26], [0.38, 0.26], [0.46, 0.34], [0.84, 0.34], [0.84, 0.44], [0.12, 0.44]]);
    poly(ctx, P, [[0.12, 0.44], [0.9, 0.44], [0.8, 0.8], [0.12, 0.8]]);
  },
  file(ctx, P) {
    poly(ctx, P, [[0.26, 0.12], [0.6, 0.12], [0.76, 0.28], [0.76, 0.88], [0.26, 0.88]]);
    line(ctx, P, [[0.6, 0.12], [0.6, 0.28], [0.76, 0.28]]);
    line(ctx, P, [[0.36, 0.52], [0.66, 0.52]]);
    line(ctx, P, [[0.36, 0.68], [0.66, 0.68]]);
  },
  save(ctx, P, s) {
    floppy(ctx, P, s);
  },
  savenew(ctx, P, s) {
    // smaller floppy in the lower-left, "+" in the upper-right
    const P2 = (u, v) => P(u * 0.78, 0.22 + v * 0.78);
    floppy(ctx, P2, s * 0.78);
    plus(ctx, P, 0.82, 0.18, 0.12);
  },
  options(ctx, P, s, cx, cy) {
    const teeth = 8, ro = s * 0.4, ri = s * 0.3;
    ctx.beginPath();
    for (let i = 0; i < teeth * 4; i++) {
      const a = (i / (teeth * 4)) * Math.PI * 2 - Math.PI / (teeth * 4);
      const r = i % 4 === 1 || i % 4 === 2 ? ro : ri;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    circle(ctx, P, 0.5, 0.5, 0.12, s);
  },
  quit(ctx, P, s, cx, cy) {
    ctx.beginPath();
    ctx.arc(cx, cy + s * 0.04, s * 0.3, -Math.PI / 2 + 0.7, -Math.PI / 2 - 0.7 + Math.PI * 2);
    ctx.stroke();
    line(ctx, P, [[0.5, 0.14], [0.5, 0.48]]);
  },
  back(ctx, P) {
    line(ctx, P, [[0.8, 0.5], [0.22, 0.5]]);
    line(ctx, P, [[0.44, 0.28], [0.22, 0.5], [0.44, 0.72]]);
  },
  prev(ctx, P) {
    line(ctx, P, [[0.6, 0.24], [0.36, 0.5], [0.6, 0.76]]);
  },
  next(ctx, P) {
    line(ctx, P, [[0.4, 0.24], [0.64, 0.5], [0.4, 0.76]]);
  },
  soundOn(ctx, P, s) {
    speaker(ctx, P);
    const [cx, cy] = P(0.5, 0.5);
    for (const r of [0.16, 0.3]) {
      ctx.beginPath();
      ctx.arc(cx, cy, s * r, -0.75, 0.75);
      ctx.stroke();
    }
  },
  soundOff(ctx, P) {
    speaker(ctx, P);
    line(ctx, P, [[0.62, 0.38], [0.86, 0.62]]);
    line(ctx, P, [[0.86, 0.38], [0.62, 0.62]]);
  },
  xr(ctx, P, s) {
    // headset seen from the front
    ctx.beginPath();
    const [x, y] = P(0.1, 0.3);
    const w = s * 0.8, h = s * 0.4, r = s * 0.12;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.lineTo(...P(0.58, 0.7));
    ctx.quadraticCurveTo(...P(0.5, 0.56), ...P(0.42, 0.7));
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.stroke();
  },
  controls(ctx, P, s) {
    // gamepad outline, D-pad cross and two buttons
    poly(ctx, P, [
      [0.3, 0.3], [0.7, 0.3], [0.86, 0.36], [0.94, 0.66], [0.84, 0.78],
      [0.66, 0.64], [0.34, 0.64], [0.16, 0.78], [0.06, 0.66], [0.14, 0.36],
    ]);
    plus(ctx, P, 0.3, 0.47, 0.07);
    ctx.fillStyle = INK;
    circle(ctx, P, 0.66, 0.43, 0.04, s, { fill: true });
    circle(ctx, P, 0.74, 0.52, 0.04, s, { fill: true });
  },
  bgPass(ctx, P, s) {
    // framed landscape: see the real world
    roundedRect(ctx, P, 0.1, 0.2, 0.8, 0.6, 0.06, s);
    ctx.stroke();
    line(ctx, P, [[0.14, 0.72], [0.36, 0.46], [0.54, 0.64], [0.66, 0.54], [0.86, 0.74]]);
    circle(ctx, P, 0.68, 0.36, 0.06, s);
  },
  bgSolid(ctx, P, s) {
    roundedRect(ctx, P, 0.1, 0.2, 0.8, 0.6, 0.06, s);
    ctx.fillStyle = INK;
    ctx.globalAlpha *= 0.35;
    ctx.fill();
    ctx.globalAlpha /= 0.35;
    ctx.stroke();
  },
  matProcedural(ctx, P, s) {
    // hexagon block face with a crack and speckles: textured surface
    poly(ctx, P, HEX);
    line(ctx, P, [[0.34, 0.3], [0.46, 0.46], [0.42, 0.58], [0.56, 0.72]]);
    line(ctx, P, [[0.46, 0.46], [0.66, 0.42]]);
    ctx.fillStyle = INK;
    circle(ctx, P, 0.66, 0.62, 0.035, s, { fill: true });
    circle(ctx, P, 0.3, 0.56, 0.035, s, { fill: true });
  },
  matSolid(ctx, P) {
    // hexagon block face filled flat
    ctx.fillStyle = INK;
    ctx.globalAlpha *= 0.35;
    poly(ctx, P, HEX, { fill: true });
    ctx.globalAlpha /= 0.35;
    poly(ctx, P, HEX);
  },
  info(ctx, P, s) {
    circle(ctx, P, 0.5, 0.5, 0.36, s);
    line(ctx, P, [[0.5, 0.46], [0.5, 0.7]]);
    ctx.fillStyle = INK;
    circle(ctx, P, 0.5, 0.32, 0.05, s, { fill: true });
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
  ctx.lineWidth = Math.max(1.5, size * 0.075);
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
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
