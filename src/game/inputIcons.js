// Glyphs for input bindings (keys, mouse buttons, gamepad and Quest Touch buttons),
// drawn on a 2D canvas so the DOM Controls table and the XR panel look the same.
//
// A binding cell is a list of tokens, e.g. ['key:Esc', 'sep:/', 'hud:menu'].
//   key:<label>            keyboard key cap
//   mouse:L|R|M|wheel|move mouse with the relevant part highlighted
//   pad:A|B|X|Y            Xbox-style face button
//   pad:LB|RB|LT|RT        bumpers / triggers
//   pad:start              Start / Menu button
//   stick:L|R:x|y|any      gamepad thumbstick (with direction arrows)
//   dpad:lr|ud|any         D-pad with highlighted arms
//   xr:trigger:L|R         Touch controller index trigger
//   xr:grip:L|R            Touch controller grip
//   xr:stick:L|R:x|y|any   Touch thumbstick
//   xr:A|B|X|Y             Touch face button
//   hud:menu               the in-game ≡ Menu button
//   ray                    pointing ray
//   crosshair              screen-centre crosshair
//   text:<words>           plain text
//   sep:<char>             separator ('/', '+')

const INK = '#e8ecf2';
const MUTED = 'rgba(232,236,242,0.6)';
const ACCENT = '#5aa0ff';
const XR_TINT = '#8e7cf0';
const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif';

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(ctx, s, x, y, size, color = INK, weight = 600, align = 'center') {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}

function tri(ctx, x, y, dir, s) {
  // small filled arrow head pointing in `dir` ('l','r','u','d')
  ctx.beginPath();
  if (dir === 'l') { ctx.moveTo(x - s, y); ctx.lineTo(x + s * 0.6, y - s); ctx.lineTo(x + s * 0.6, y + s); }
  if (dir === 'r') { ctx.moveTo(x + s, y); ctx.lineTo(x - s * 0.6, y - s); ctx.lineTo(x - s * 0.6, y + s); }
  if (dir === 'u') { ctx.moveTo(x, y - s); ctx.lineTo(x - s, y + s * 0.6); ctx.lineTo(x + s, y + s * 0.6); }
  if (dir === 'd') { ctx.moveTo(x, y + s); ctx.lineTo(x - s, y - s * 0.6); ctx.lineTo(x + s, y - s * 0.6); }
  ctx.closePath();
  ctx.fill();
}

function dirsOf(d) {
  return d === 'x' ? ['l', 'r'] : d === 'y' ? ['u', 'd'] : d === 'any' ? ['l', 'r', 'u', 'd'] : [];
}

/** Returns the width a token occupies at height h. */
export function glyphWidth(ctx, token, h) {
  const [kind, a] = token.split(':');
  switch (kind) {
    case 'key': {
      ctx.font = `700 ${h * 0.4}px ${FONT}`;
      return Math.max(h * 0.9, ctx.measureText(a).width + h * 0.5);
    }
    case 'mouse': return a === 'move' ? h * 1.25 : h * 0.72;
    case 'pad':
      if (a === 'LB' || a === 'RB') return h * 1.15;
      if (a === 'LT' || a === 'RT') return h * 0.95;
      if (a === 'start') return h * 0.95;
      return h * 0.9;
    case 'stick': case 'dpad': case 'hud': case 'crosshair': return h * 0.95;
    case 'xr':
      if (a === 'trigger' || a === 'grip') return h * 0.95;
      if (a === 'stick') return h * 0.95;
      return h * 0.9;
    case 'ray': return h * 1.3;
    case 'sep': return h * 0.45;
    case 'text': {
      ctx.font = `500 ${h * 0.36}px ${FONT}`;
      return ctx.measureText(token.slice(5)).width + h * 0.1;
    }
    default: return 0;
  }
}

/** Draws one token with its left edge at x, vertically centred on cy. Returns its width. */
export function drawGlyph(ctx, token, x, cy, h) {
  const parts = token.split(':');
  const [kind, a, b] = parts;
  const w = glyphWidth(ctx, token, h);
  const cx = x + w / 2;
  const lw = Math.max(1.5, h * 0.06);
  ctx.save();
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;

  switch (kind) {
    case 'key': {
      const kh = h * 0.82;
      rr(ctx, x + lw, cy - kh / 2, w - lw * 2, kh, h * 0.16);
      ctx.fillStyle = '#343b4a';
      ctx.fill();
      ctx.strokeStyle = '#aeb8c8';
      ctx.stroke();
      text(ctx, a, cx, cy, h * 0.4, INK, 700);
      break;
    }
    case 'mouse': {
      const mw = h * 0.6, mh = h * 0.9;
      const mx = a === 'move' ? cx - mw / 2 : x + (w - mw) / 2;
      const my = cy - mh / 2;
      const splitY = my + mh * 0.42;
      ctx.fillStyle = ACCENT;
      if (a === 'L' || a === 'R') {
        ctx.save();
        rr(ctx, mx, my, mw, mh, mw * 0.48);
        ctx.clip();
        ctx.fillRect(a === 'L' ? mx : mx + mw / 2, my, mw / 2, splitY - my);
        ctx.restore();
      }
      rr(ctx, mx, my, mw, mh, mw * 0.48);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mx, splitY);
      ctx.lineTo(mx + mw, splitY);
      ctx.moveTo(mx + mw / 2, my);
      ctx.lineTo(mx + mw / 2, splitY);
      ctx.stroke();
      if (a === 'M' || a === 'wheel') {
        const ww = mw * 0.22, wh = mh * 0.2;
        rr(ctx, mx + mw / 2 - ww / 2, my + mh * 0.12, ww, wh, ww / 2);
        ctx.fillStyle = ACCENT;
        ctx.fill();
        if (a === 'wheel') {
          ctx.fillStyle = ACCENT;
          tri(ctx, mx + mw + h * 0.02, my + mh * 0.08, 'u', h * 0.08);
          tri(ctx, mx + mw + h * 0.02, my + mh * 0.36, 'd', h * 0.08);
        }
      }
      if (a === 'move') {
        ctx.fillStyle = ACCENT;
        tri(ctx, mx - h * 0.2, cy + mh * 0.12, 'l', h * 0.1);
        tri(ctx, mx + mw + h * 0.2, cy + mh * 0.12, 'r', h * 0.1);
      }
      break;
    }
    case 'pad': {
      if ('ABXY'.includes(a) && a.length === 1) {
        const col = { A: '#3cb44b', B: '#e6453a', X: '#2f7de1', Y: '#e8b923' }[a];
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(cx, cy, h * 0.4, 0, Math.PI * 2);
        ctx.fill();
        text(ctx, a, cx, cy + h * 0.02, h * 0.46, a === 'Y' ? '#1b2029' : '#ffffff', 800);
      } else if (a === 'LB' || a === 'RB') {
        const bh = h * 0.5;
        rr(ctx, x + lw, cy - bh / 2, w - 2 * lw, bh, bh * 0.45);
        ctx.fillStyle = '#343b4a';
        ctx.fill();
        ctx.stroke();
        text(ctx, a, cx, cy, h * 0.34, INK, 700);
      } else if (a === 'LT' || a === 'RT') {
        const tw = w - 2 * lw, th = h * 0.86, tx = x + lw, ty = cy - th / 2;
        ctx.beginPath();
        ctx.moveTo(tx, ty + th);
        ctx.lineTo(tx, ty + th * 0.35);
        ctx.quadraticCurveTo(tx, ty, tx + tw / 2, ty);
        ctx.quadraticCurveTo(tx + tw, ty, tx + tw, ty + th * 0.35);
        ctx.lineTo(tx + tw, ty + th);
        ctx.closePath();
        ctx.fillStyle = '#343b4a';
        ctx.fill();
        ctx.stroke();
        text(ctx, a, cx, cy + h * 0.08, h * 0.32, INK, 700);
      } else if (a === 'start') {
        const bh = h * 0.52;
        rr(ctx, x + lw, cy - bh / 2, w - 2 * lw, bh, bh / 2);
        ctx.fillStyle = '#343b4a';
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        for (const dy of [-0.1, 0, 0.1]) {
          ctx.moveTo(cx - h * 0.16, cy + dy * h);
          ctx.lineTo(cx + h * 0.16, cy + dy * h);
        }
        ctx.lineWidth = lw * 0.8;
        ctx.stroke();
      }
      break;
    }
    case 'stick':
    case 'xr': {
      if (kind === 'xr' && 'ABXY'.includes(a) && a.length === 1) {
        ctx.fillStyle = '#4a5160';
        ctx.beginPath();
        ctx.arc(cx, cy, h * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = XR_TINT;
        ctx.stroke();
        text(ctx, a, cx, cy + h * 0.02, h * 0.44, '#ffffff', 800);
        break;
      }
      if (kind === 'xr' && (a === 'trigger' || a === 'grip')) {
        // Touch controller in profile: ring on top, handle below; highlight trigger or grip.
        const s = h;
        const ox = x + (w - s * 0.9) / 2, oy = cy - s / 2;
        const P = (u, v) => [ox + u * s, oy + v * s];
        ctx.strokeStyle = MUTED;
        ctx.beginPath(); // handle
        ctx.moveTo(...P(0.3, 0.35));
        ctx.lineTo(...P(0.25, 0.95));
        ctx.lineTo(...P(0.55, 0.95));
        ctx.lineTo(...P(0.62, 0.4));
        ctx.stroke();
        ctx.beginPath(); // tracking ring
        ctx.ellipse(...P(0.45, 0.22), s * 0.32, s * 0.14, -0.3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = XR_TINT;
        ctx.strokeStyle = XR_TINT;
        if (a === 'trigger') {
          ctx.beginPath();
          ctx.moveTo(...P(0.64, 0.4));
          ctx.quadraticCurveTo(...P(0.9, 0.45), ...P(0.8, 0.66));
          ctx.lineTo(...P(0.6, 0.55));
          ctx.closePath();
          ctx.fill();
        } else {
          rr(ctx, ...P(0.16, 0.5), s * 0.16, s * 0.36, s * 0.07);
          ctx.fill();
        }
        text(ctx, b || '', ...P(0.4, 0.66), h * 0.28, INK, 800);
        break;
      }
      // thumbstick (gamepad or Touch)
      const side = kind === 'xr' ? b : a;
      const dir = kind === 'xr' ? parts[3] : b;
      const tint = kind === 'xr' ? XR_TINT : ACCENT;
      ctx.strokeStyle = '#aeb8c8';
      ctx.beginPath();
      ctx.arc(cx, cy, h * 0.42, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#343b4a';
      ctx.beginPath();
      ctx.arc(cx, cy, h * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = tint;
      ctx.stroke();
      text(ctx, side || '', cx, cy + h * 0.01, h * 0.24, INK, 800);
      ctx.fillStyle = tint;
      const d = h * 0.33, ts = h * 0.07;
      for (const k of dirsOf(dir)) {
        tri(ctx, cx + (k === 'l' ? -d : k === 'r' ? d : 0), cy + (k === 'u' ? -d : k === 'd' ? d : 0), k, ts);
      }
      break;
    }
    case 'dpad': {
      const arm = h * 0.28, len = h * 0.42;
      const hi = new Set(dirsOf(a === 'lr' ? 'x' : a === 'ud' ? 'y' : 'any'));
      const arms = { u: [cx - arm / 2, cy - len, arm, len], d: [cx - arm / 2, cy, arm, len], l: [cx - len, cy - arm / 2, len, arm], r: [cx, cy - arm / 2, len, arm] };
      for (const [k, [ax, ay, aw, ah]] of Object.entries(arms)) {
        ctx.fillStyle = hi.has(k) ? ACCENT : '#343b4a';
        ctx.fillRect(ax, ay, aw, ah);
      }
      ctx.strokeStyle = '#aeb8c8';
      ctx.lineWidth = lw * 0.8;
      ctx.beginPath();
      ctx.moveTo(cx - arm / 2, cy - len); ctx.lineTo(cx + arm / 2, cy - len); ctx.lineTo(cx + arm / 2, cy - arm / 2);
      ctx.lineTo(cx + len, cy - arm / 2); ctx.lineTo(cx + len, cy + arm / 2); ctx.lineTo(cx + arm / 2, cy + arm / 2);
      ctx.lineTo(cx + arm / 2, cy + len); ctx.lineTo(cx - arm / 2, cy + len); ctx.lineTo(cx - arm / 2, cy + arm / 2);
      ctx.lineTo(cx - len, cy + arm / 2); ctx.lineTo(cx - len, cy - arm / 2); ctx.lineTo(cx - arm / 2, cy - arm / 2);
      ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'hud': {
      const s = h * 0.8;
      rr(ctx, cx - s / 2, cy - s / 2, s, s, s * 0.2);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.beginPath();
      for (const dy of [-0.16, 0, 0.16]) {
        ctx.moveTo(cx - s * 0.26, cy + dy * s);
        ctx.lineTo(cx + s * 0.26, cy + dy * s);
      }
      ctx.lineWidth = lw * 1.1;
      ctx.stroke();
      break;
    }
    case 'ray': {
      ctx.strokeStyle = '#b5b8bd';
      ctx.beginPath();
      ctx.moveTo(x + h * 0.12, cy + h * 0.3);
      ctx.lineTo(x + w - h * 0.15, cy - h * 0.25);
      ctx.stroke();
      ctx.fillStyle = XR_TINT;
      ctx.beginPath();
      ctx.arc(x + h * 0.12, cy + h * 0.3, h * 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x + w - h * 0.15, cy - h * 0.25, h * 0.08, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'crosshair': {
      const r = h * 0.3;
      ctx.strokeStyle = ACCENT;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.moveTo(cx - r * 1.5, cy); ctx.lineTo(cx - r * 0.5, cy);
      ctx.moveTo(cx + r * 0.5, cy); ctx.lineTo(cx + r * 1.5, cy);
      ctx.moveTo(cx, cy - r * 1.5); ctx.lineTo(cx, cy - r * 0.5);
      ctx.moveTo(cx, cy + r * 0.5); ctx.lineTo(cx, cy + r * 1.5);
      ctx.stroke();
      break;
    }
    case 'sep':
      text(ctx, a, cx, cy, h * 0.4, MUTED, 500);
      break;
    case 'text':
      text(ctx, token.slice(5), x, cy, h * 0.36, MUTED, 500, 'left');
      break;
  }
  ctx.restore();
  return w;
}

/** Width of a whole cell (list of tokens) at height h. */
export function cellWidth(ctx, tokens, h) {
  const gap = h * 0.12;
  return tokens.reduce((s, t) => s + glyphWidth(ctx, t, h), 0) + gap * Math.max(0, tokens.length - 1);
}

/** Draws a cell's tokens left-to-right starting at x. */
export function drawCell(ctx, tokens, x, cy, h) {
  const gap = h * 0.12;
  for (const t of tokens) x += drawGlyph(ctx, t, x, cy, h) + gap;
}

const cache = new Map();
/** PNG data URL of a cell (for the DOM table); `h` is the rendered pixel height. */
export function cellURL(tokens, h = 64) {
  const k = tokens.join('|') + '@' + h;
  if (!cache.has(k)) {
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    cv.width = Math.ceil(cellWidth(ctx, tokens, h)) + 4;
    cv.height = h;
    drawCell(ctx, tokens, 2, h / 2, h);
    cache.set(k, { url: cv.toDataURL(), w: cv.width, h });
  }
  return cache.get(k);
}
