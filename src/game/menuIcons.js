// Clean monochrome line glyphs shown to the left of each menu button (DOM and XR panels).
// Every icon is drawn with a single ink colour on a 1×1 grid (P(u, v) maps to pixels).

import * as THREE from 'three';
import { GRIDS } from './grids.js';

const INK = '#e8ecf2';

// Lineicons' gear-1 (regular), the gear the other apps (4d-viewer-threejs, …) use: six rounded
// teeth round a ring, on a 24 × 25 grid; filled, the holes cut out (evenodd)
const GEAR_PATHS = [
  'M11.9992 8.7743C9.88118 8.7743 8.16419 10.4913 8.16419 12.6093C8.16419 14.7273 9.88118 16.4443 11.9992 16.4443C14.1172 16.4443 15.8342 14.7273 15.8342 12.6093C15.8342 10.4913 14.1172 8.7743 11.9992 8.7743ZM9.66419 12.6093C9.66419 11.3197 10.7096 10.2743 11.9992 10.2743C13.2888 10.2743 14.3342 11.3197 14.3342 12.6093C14.3342 13.8989 13.2888 14.9443 11.9992 14.9443C10.7096 14.9443 9.66419 13.8989 9.66419 12.6093Z',
  'M2.5809 8.9224C1.96404 9.99083 2.33012 11.357 3.39854 11.9739C3.88777 12.2563 3.88776 12.9625 3.39856 13.2449C2.33013 13.8618 1.96407 15.2279 2.58092 16.2964L4.09692 18.9222C4.71391 19.9908 6.08044 20.3568 7.14896 19.7399C7.63844 19.4573 8.25011 19.8106 8.25011 20.3754C8.25011 21.6092 9.2503 22.6094 10.4841 22.6094H13.5165C14.7502 22.6094 15.7501 21.6091 15.7501 20.3756C15.7501 19.8108 16.3615 19.458 16.8503 19.7402C17.9185 20.357 19.2845 19.991 19.9012 18.9227L21.4176 16.2963C22.0344 15.2279 21.6684 13.8617 20.6 13.2449C20.1108 12.9624 20.1108 12.2563 20.6 11.9739C21.6684 11.3571 22.0345 9.99089 21.4176 8.92247L19.9012 6.29604C19.2845 5.2278 17.9185 4.86179 16.8503 5.47854C16.3615 5.76076 15.7501 5.40794 15.7501 4.84314C15.7501 3.60961 14.7502 2.60938 13.5165 2.60938H10.4841C9.2503 2.60938 8.25011 3.60957 8.25011 4.84337C8.25011 5.40822 7.63842 5.76152 7.14894 5.47892C6.08042 4.86201 4.71388 5.22797 4.09689 6.29663L2.5809 8.9224ZM4.14854 10.6748C3.79755 10.4722 3.6773 10.0234 3.87994 9.6724L5.39593 7.04663C5.59863 6.69554 6.04772 6.57518 6.39894 6.77796C7.88811 7.63773 9.75011 6.56327 9.75011 4.84337C9.75011 4.43799 10.0787 4.10937 10.4841 4.10937L13.5165 4.10937C13.9216 4.10937 14.2501 4.43788 14.2501 4.84314C14.2501 6.56227 16.1112 7.63733 17.6003 6.77758C17.9511 6.57504 18.3997 6.69524 18.6022 7.04604L20.1186 9.67247C20.3212 10.0234 20.201 10.4722 19.85 10.6749C18.3608 11.5346 18.3608 13.6841 19.85 14.5439C20.2009 14.7465 20.3212 15.1953 20.1186 15.5463L18.6022 18.1727C18.3996 18.5235 17.9511 18.6437 17.6003 18.4412C16.1112 17.5815 14.2501 18.6565 14.2501 20.3756C14.2501 20.7809 13.9216 21.1094 13.5165 21.1094H10.4841C10.0787 21.1094 9.75011 20.7808 9.75011 20.3754C9.75011 18.6555 7.88812 17.5811 6.39896 18.4408C6.04774 18.6436 5.59866 18.5232 5.39596 18.1722L3.87996 15.5464C3.67732 15.1954 3.79757 14.7466 4.14856 14.5439C5.63778 13.6841 5.63775 11.5346 4.14854 10.6748Z',
];
let gearPaths = null; // Path2D, made on first use

/** Options icon: a gear (the Options button, in XR too), `size` across, centred at (cx, cy). */
export function drawMenuIcon(ctx, cx, cy, size, color = '#e8ecf2') {
  gearPaths ??= GEAR_PATHS.map((d) => new Path2D(d));
  const k = size / 20; // the gear is 20 units across (2.3–21.7 wide, 2.6–22.6 tall)
  ctx.save();
  ctx.translate(cx - 12 * k, cy - 12.61 * k); // its centre (12, 12.61) to (cx, cy)
  ctx.scale(k, k);
  ctx.fillStyle = color;
  for (const path of gearPaths) ctx.fill(path, 'evenodd');
  ctx.restore();
}


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

/** Small cloud outline in the upper half of the icon box. */
function cloud(ctx, P, s) {
  ctx.beginPath();
  const [x0, y0] = P(0.22, 0.56);
  ctx.moveTo(x0, y0);
  ctx.arc(...P(0.3, 0.46), 0.1 * s, Math.PI * 0.5, Math.PI * 1.5);
  ctx.arc(...P(0.46, 0.36), 0.14 * s, Math.PI * 1.05, Math.PI * 1.95);
  ctx.arc(...P(0.66, 0.44), 0.12 * s, Math.PI * 1.4, Math.PI * 0.5);
  ctx.closePath();
  ctx.stroke();
}

/** Regular hexagon (pointy top) filling most of the icon box. */
const HEX = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 3;
  return [0.5 + Math.cos(a) * 0.38, 0.5 + Math.sin(a) * 0.38];
});

/** A cut gem: a flat crown over a pointed base. */
const GEM = [[0.3, 0.2], [0.7, 0.2], [0.84, 0.38], [0.5, 0.84], [0.16, 0.38]];

/** Two beamed eighth notes. */
function musicNote(ctx, P, s) {
  ctx.fillStyle = INK;
  for (const [x, y] of [[0.34, 0.72], [0.66, 0.64]]) {
    const [cx, cy] = P(x, y);
    ctx.beginPath();
    ctx.ellipse(cx, cy, s * 0.09, s * 0.065, -0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  line(ctx, P, [[0.42, 0.7], [0.42, 0.26]]); // stems…
  line(ctx, P, [[0.74, 0.62], [0.74, 0.18]]);
  ctx.lineWidth *= 2;
  line(ctx, P, [[0.42, 0.27], [0.74, 0.19]]); // …and the beam
  ctx.lineWidth /= 2;
}

const SHAPE_VIEW = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.42, -0.62, 0, 'XYZ'));

/** The camera settings' glyph: a dot (what it orbits) with an arrow round it, clockwise (`dir` 1) or anticlockwise (-1). */
function orbitArrow(ctx, P, dir) {
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const a = (dir * (-150 + i * 22.5) * Math.PI) / 180; // a 270° arc
    pts.push([0.5 + 0.32 * Math.cos(a), 0.5 + 0.32 * Math.sin(a)]);
  }
  line(ctx, P, pts);
  const [u, v] = pts[pts.length - 1], [pu, pv] = pts[pts.length - 2];
  const tu = u - pu, tv = v - pv, len = Math.hypot(tu, tv);
  const du = (tu / len) * 0.14, dv = (tv / len) * 0.14; // the arrowhead, along the arc's end
  line(ctx, P, [[u - du - dv * 0.7, v - dv + du * 0.7], [u, v], [u - du + dv * 0.7, v - dv - du * 0.7]]);
  circle(ctx, P, 0.5, 0.5, 0.07, P(1, 0)[0] - P(0, 0)[0], { fill: true });
}

/** Grid mode `id`'s cell as a line drawing: the outlines of its front faces, seen from above right. */
function cellGlyph(ctx, P, id) {
  const { faces, vertices } = GRIDS[id];
  const r = Math.max(...vertices.map((v) => v.length()));
  ctx.lineWidth *= 0.6; // many small faces: finer lines than the other glyphs
  for (const f of faces) {
    if (f.normal.clone().applyMatrix4(SHAPE_VIEW).z <= 1e-4) continue; // back face
    poly(ctx, P, f.verts.map((v) => {
      const q = v.clone().applyMatrix4(SHAPE_VIEW);
      return [0.5 + (q.x / r) * 0.4, 0.5 - (q.y / r) * 0.4];
    }));
  }
}

const DRAW = {
  resume(ctx, P) {
    ctx.fillStyle = INK;
    poly(ctx, P, [[0.32, 0.2], [0.8, 0.5], [0.32, 0.8]], { fill: true });
  },
  new(ctx, P) {
    plus(ctx, P, 0.5, 0.5, 0.3);
  },
  // New's grid modes (grids.js)
  gridTo(ctx, P) {
    cellGlyph(ctx, P, 'to');
  },
  gridRd(ctx, P) {
    cellGlyph(ctx, P, 'rd');
  },
  gridCube(ctx, P) {
    cellGlyph(ctx, P, 'cube');
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
  forward(ctx, P) {
    // Back's arrow, mirrored: marks a button that opens another menu screen
    line(ctx, P, [[0.2, 0.5], [0.78, 0.5]]);
    line(ctx, P, [[0.56, 0.28], [0.78, 0.5], [0.56, 0.72]]);
  },
  dropdown(ctx, P) {
    // a chevron: marks a button that opens a list of choices beneath it
    line(ctx, P, [[0.26, 0.38], [0.5, 0.62], [0.74, 0.38]]);
  },
  dropdownOpen(ctx, P) {
    line(ctx, P, [[0.26, 0.62], [0.5, 0.38], [0.74, 0.62]]);
  },
  check(ctx, P) {
    // the chosen option in a dropdown's list
    line(ctx, P, [[0.22, 0.52], [0.42, 0.72], [0.8, 0.3]]);
  },
  mic(ctx, P, s) {
    // microphone: capsule head, a cradle arc under it, stem and base
    roundedRect(ctx, P, 0.37, 0.12, 0.26, 0.44, 0.13, s);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(...P(0.5, 0.44), 0.24 * s, 0.15, Math.PI - 0.15);
    ctx.stroke();
    line(ctx, P, [[0.5, 0.68], [0.5, 0.84]]);
    line(ctx, P, [[0.34, 0.86], [0.66, 0.86]]);
  },
  speak(ctx, P) {
    // a head in profile (facing right) with sound waves coming from the mouth
    line(ctx, P, [
      [0.2, 0.86], [0.2, 0.66], [0.12, 0.54], [0.12, 0.36], [0.2, 0.2], [0.34, 0.12], [0.46, 0.14],
      [0.54, 0.24], [0.56, 0.36], [0.62, 0.46], [0.56, 0.5], [0.56, 0.62], [0.48, 0.66], [0.42, 0.66], [0.42, 0.86],
    ]);
    const [cx, cy] = P(0.6, 0.5);
    const s = P(1, 0)[0] - P(0, 0)[0];
    for (const r of [0.14, 0.26]) {
      ctx.beginPath();
      ctx.arc(cx, cy, s * r, -0.7, 0.7);
      ctx.stroke();
    }
  },
  clear(ctx, P) {
    // an X: empty the field
    line(ctx, P, [[0.24, 0.24], [0.76, 0.76]]);
    line(ctx, P, [[0.76, 0.24], [0.24, 0.76]]);
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
  musicOn(ctx, P, s) {
    musicNote(ctx, P, s);
  },
  musicOff(ctx, P, s) {
    musicNote(ctx, P, s);
    line(ctx, P, [[0.18, 0.18], [0.82, 0.82]]); // struck through
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
  // View Mode (drawn to match 4d-viewer-threejs): a screen, the screen split in two, a phone,
  // and a phone turned sideways in a viewer (two lenses); XR: HMD Stereo uses the headset above
  monitor(ctx, P, s) {
    roundedRect(ctx, P, 0.115, 0.177, 0.77, 0.5, 0.073, s);
    ctx.stroke();
    line(ctx, P, [[0.5, 0.677], [0.5, 0.823]]);
    line(ctx, P, [[0.354, 0.823], [0.646, 0.823]]);
  },
  monitorSbs(ctx, P, s) {
    DRAW.monitor(ctx, P, s);
    line(ctx, P, [[0.5, 0.25], [0.5, 0.604]]);
    circle(ctx, P, 0.308, 0.427, 0.058, s, { fill: true });
    circle(ctx, P, 0.692, 0.427, 0.058, s, { fill: true });
  },
  // Interlaced: the screen's rows, alternate ones solid and dashed
  monitorInterlaced(ctx, P, s) {
    DRAW.monitor(ctx, P, s);
    line(ctx, P, [[0.25, 0.323], [0.75, 0.323]]);
    line(ctx, P, [[0.25, 0.531], [0.75, 0.531]]);
    ctx.setLineDash([0.083 * s, 0.104 * s]);
    line(ctx, P, [[0.25, 0.427], [0.75, 0.427]]);
    ctx.setLineDash([]);
  },
  phone(ctx, P, s) {
    roundedRect(ctx, P, 0.281, 0.115, 0.438, 0.77, 0.083, s);
    ctx.stroke();
    line(ctx, P, [[0.448, 0.76], [0.552, 0.76]]);
  },
  phoneViewer(ctx, P, s) {
    roundedRect(ctx, P, 0.115, 0.281, 0.77, 0.438, 0.083, s);
    ctx.stroke();
    line(ctx, P, [[0.5, 0.281], [0.5, 0.719]]);
    circle(ctx, P, 0.308, 0.5, 0.0875, s);
    circle(ctx, P, 0.692, 0.5, 0.0875, s);
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
  video(ctx, P, s) {
    // monitor on a stand, with a small play triangle on the screen
    roundedRect(ctx, P, 0.1, 0.18, 0.8, 0.5, 0.05, s);
    ctx.stroke();
    line(ctx, P, [[0.5, 0.68], [0.5, 0.8]]);
    line(ctx, P, [[0.32, 0.82], [0.68, 0.82]]);
    poly(ctx, P, [[0.43, 0.32], [0.6, 0.43], [0.43, 0.54]]);
  },
  bgPass(ctx, P, s) {
    // framed landscape: see the real world
    roundedRect(ctx, P, 0.1, 0.2, 0.8, 0.6, 0.06, s);
    ctx.stroke();
    line(ctx, P, [[0.14, 0.72], [0.36, 0.46], [0.54, 0.64], [0.66, 0.54], [0.86, 0.74]]);
    circle(ctx, P, 0.68, 0.36, 0.06, s);
  },
  bgSky(ctx, P, s) {
    // a globe: the sky panorama wrapped all around
    circle(ctx, P, 0.5, 0.5, 0.34, s);
    line(ctx, P, [[0.16, 0.5], [0.84, 0.5]]);
    ctx.beginPath();
    ctx.ellipse(...P(0.5, 0.5), 0.15 * s, 0.34 * s, 0, 0, Math.PI * 2);
    ctx.stroke();
    line(ctx, P, [[0.23, 0.32], [0.77, 0.32]]);
    line(ctx, P, [[0.23, 0.68], [0.77, 0.68]]);
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
  matSimple(ctx, P) {
    // hexagon block face with a crack, no speckles: a pattern without the fine detail
    poly(ctx, P, HEX);
    line(ctx, P, [[0.34, 0.3], [0.46, 0.46], [0.42, 0.58], [0.56, 0.72]]);
    line(ctx, P, [[0.46, 0.46], [0.66, 0.42]]);
  },
  matSolid(ctx, P) {
    // hexagon block face filled flat
    ctx.fillStyle = INK;
    ctx.globalAlpha *= 0.35;
    poly(ctx, P, HEX, { fill: true });
    ctx.globalAlpha /= 0.35;
    poly(ctx, P, HEX);
  },
  aoOn(ctx, P) {
    // two blocks meeting in a corner, with a shadow wedge where they meet
    poly(ctx, P, [[0.14, 0.2], [0.44, 0.2], [0.44, 0.82], [0.14, 0.82]]);
    poly(ctx, P, [[0.44, 0.52], [0.86, 0.52], [0.86, 0.82], [0.44, 0.82]]);
    ctx.fillStyle = INK;
    ctx.globalAlpha *= 0.55;
    poly(ctx, P, [[0.44, 0.34], [0.44, 0.52], [0.66, 0.52]], { fill: true });
  },
  aoOff(ctx, P) {
    // the same two blocks, no shadow
    poly(ctx, P, [[0.14, 0.2], [0.44, 0.2], [0.44, 0.82], [0.14, 0.82]]);
    poly(ctx, P, [[0.44, 0.52], [0.86, 0.52], [0.86, 0.82], [0.44, 0.82]]);
  },
  refractionOn(ctx, P) {
    // a gem with a ray of light bent as it passes through
    poly(ctx, P, GEM);
    line(ctx, P, [[0.06, 0.36], [0.3, 0.46], [0.7, 0.62], [0.94, 0.86]]);
  },
  refractionOff(ctx, P) {
    // the same gem, the ray going straight through
    poly(ctx, P, GEM);
    line(ctx, P, [[0.06, 0.36], [0.94, 0.72]]);
  },
  speed(ctx, P, s) {
    // speedometer: an arc with a needle
    const [cx, cy] = P(0.5, 0.64);
    ctx.beginPath();
    ctx.arc(cx, cy, 0.34 * s, Math.PI, 2 * Math.PI);
    ctx.stroke();
    line(ctx, P, [[0.5, 0.64], [0.72, 0.42]]);
    ctx.fillStyle = INK;
    circle(ctx, P, 0.5, 0.64, 0.05, s, { fill: true });
  },
  creativeOn(ctx, P) {
    // Creative: a block (cube, in outline) with a plus beside it: blocks to place
    line(ctx, P, [[0.14, 0.4], [0.5, 0.4], [0.5, 0.84], [0.14, 0.84], [0.14, 0.4]]);
    line(ctx, P, [[0.14, 0.4], [0.3, 0.26], [0.64, 0.26], [0.5, 0.4]]);
    line(ctx, P, [[0.64, 0.26], [0.64, 0.68], [0.5, 0.84]]);
    line(ctx, P, [[0.8, 0.08], [0.8, 0.36]]);
    line(ctx, P, [[0.66, 0.22], [0.94, 0.22]]);
  },
  creativeOff(ctx, P, s) {
    // the same block, struck through
    line(ctx, P, [[0.14, 0.4], [0.5, 0.4], [0.5, 0.84], [0.14, 0.84], [0.14, 0.4]]);
    line(ctx, P, [[0.14, 0.4], [0.3, 0.26], [0.64, 0.26], [0.5, 0.4]]);
    line(ctx, P, [[0.64, 0.26], [0.64, 0.68], [0.5, 0.84]]);
    line(ctx, P, [[0.16, 0.9], [0.86, 0.14]]);
  },
  rainOn(ctx, P, s) {
    cloud(ctx, P, s);
    for (const u of [0.34, 0.5, 0.66]) line(ctx, P, [[u, 0.64], [u - 0.05, 0.8]]); // falling drops
  },
  fogOn(ctx, P) {
    // three wavy bands of mist
    for (const v of [0.34, 0.5, 0.66]) {
      const pts = [];
      for (let i = 0; i <= 8; i++) pts.push([0.16 + i * 0.085, v + Math.sin(i * 1.3 + v * 9) * 0.035]);
      line(ctx, P, pts);
    }
  },
  aaOn(ctx, P) {
    // Anti-aliasing: a smooth diagonal edge
    line(ctx, P, [[0.16, 0.84], [0.84, 0.16]]);
    ctx.globalAlpha *= 0.4;
    line(ctx, P, [[0.16, 0.66], [0.66, 0.16]]); // (its soft fringe)
    line(ctx, P, [[0.34, 0.84], [0.84, 0.34]]);
  },
  vsyncOn(ctx, P) {
    // VSync: a display, and in it a frame edge running straight down (no tearing)
    line(ctx, P, [[0.14, 0.2], [0.86, 0.2], [0.86, 0.68], [0.14, 0.68], [0.14, 0.2]]);
    line(ctx, P, [[0.5, 0.68], [0.5, 0.82]]);
    line(ctx, P, [[0.34, 0.82], [0.66, 0.82]]);
    line(ctx, P, [[0.44, 0.3], [0.44, 0.58]]);
  },
  xrResolution(ctx, P) {
    // XR Resolution: a pixel grid, its cells coarser toward one corner
    line(ctx, P, [[0.16, 0.16], [0.84, 0.16], [0.84, 0.84], [0.16, 0.84], [0.16, 0.16]]);
    line(ctx, P, [[0.5, 0.16], [0.5, 0.84]]);
    line(ctx, P, [[0.16, 0.5], [0.84, 0.5]]);
    ctx.globalAlpha *= 0.5;
    line(ctx, P, [[0.33, 0.16], [0.33, 0.5]]);
    line(ctx, P, [[0.16, 0.33], [0.5, 0.33]]);
  },
  vsyncOff(ctx, P) {
    // the same display, its picture torn: the edge jumps sideways halfway down
    line(ctx, P, [[0.14, 0.2], [0.86, 0.2], [0.86, 0.68], [0.14, 0.68], [0.14, 0.2]]);
    line(ctx, P, [[0.5, 0.68], [0.5, 0.82]]);
    line(ctx, P, [[0.34, 0.82], [0.66, 0.82]]);
    line(ctx, P, [[0.4, 0.3], [0.4, 0.44]]);
    line(ctx, P, [[0.56, 0.44], [0.56, 0.58]]);
    ctx.globalAlpha *= 0.4;
    line(ctx, P, [[0.22, 0.44], [0.78, 0.44]]); // (the tear)
    ctx.globalAlpha /= 0.4;
  },
  aaOff(ctx, P) {
    // the same edge, jagged: stair steps
    line(ctx, P, [[0.16, 0.84], [0.16, 0.67], [0.33, 0.67], [0.33, 0.5], [0.5, 0.5], [0.5, 0.33], [0.67, 0.33], [0.67, 0.16], [0.84, 0.16]]);
  },
  fogOff(ctx, P, s) {
    DRAW.fogOn(ctx, P, s);
    line(ctx, P, [[0.2, 0.84], [0.8, 0.16]]); // struck through
  },
  rainOff(ctx, P, s) {
    cloud(ctx, P, s);
    line(ctx, P, [[0.2, 0.84], [0.8, 0.24]]); // struck through
  },
  gear(ctx, P, s, cx, cy) {
    // Options: the gear, as wide as the other icons' glyphs (0.12–0.88 of the box)
    drawMenuIcon(ctx, cx, cy, s * 0.76, INK);
  },
  debug(ctx, P, s) {
    // terminal window with a ">_" prompt
    roundedRect(ctx, P, 0.12, 0.2, 0.76, 0.6, 0.07, s);
    ctx.stroke();
    line(ctx, P, [[0.12, 0.34], [0.88, 0.34]]);
    line(ctx, P, [[0.24, 0.46], [0.36, 0.56], [0.24, 0.66]]);
    line(ctx, P, [[0.44, 0.68], [0.62, 0.68]]);
  },
  renderBlocky(ctx, P) {
    // Rendering: Blocky — a faceted block: hexagon with an inset hexagon, joined at the corners
    const inner = HEX.map(([u, v]) => [0.5 + (u - 0.5) * 0.6, 0.5 + (v - 0.5) * 0.6]);
    poly(ctx, P, HEX);
    poly(ctx, P, inner);
    HEX.forEach((p, i) => line(ctx, P, [p, inner[i]]));
  },
  renderSmooth(ctx, P, s) {
    // Rendering: Smooth — a round blob with a curved highlight
    circle(ctx, P, 0.5, 0.5, 0.34, s);
    const arc = [];
    for (let a = 200; a <= 260; a += 10) {
      const r = (a * Math.PI) / 180;
      arc.push([0.5 + 0.22 * Math.cos(r), 0.5 + 0.22 * Math.sin(r)]);
    }
    line(ctx, P, arc);
  },
  accessibility(ctx, P, s) {
    // a figure with open arms, in a circle
    circle(ctx, P, 0.5, 0.5, 0.4, s);
    circle(ctx, P, 0.5, 0.27, 0.06, s, { fill: true });
    line(ctx, P, [[0.26, 0.4], [0.74, 0.4]]); // arms
    line(ctx, P, [[0.5, 0.4], [0.5, 0.58]]); // body
    line(ctx, P, [[0.38, 0.78], [0.5, 0.58], [0.62, 0.78]]); // legs
  },
  vibrationOn(ctx, P) {
    // Vibration: a controller's handle, with buzz lines either side
    line(ctx, P, [[0.38, 0.18], [0.62, 0.18], [0.62, 0.82], [0.38, 0.82], [0.38, 0.18]]);
    line(ctx, P, [[0.24, 0.32], [0.18, 0.42], [0.24, 0.52], [0.18, 0.62]]);
    line(ctx, P, [[0.76, 0.32], [0.82, 0.42], [0.76, 0.52], [0.82, 0.62]]);
  },
  vibrationOff(ctx, P) {
    // the same handle, still, struck through
    line(ctx, P, [[0.38, 0.18], [0.62, 0.18], [0.62, 0.82], [0.38, 0.82], [0.38, 0.18]]);
    line(ctx, P, [[0.18, 0.84], [0.82, 0.16]]);
  },
  textSize(ctx, P) {
    // a small and a large "A"
    line(ctx, P, [[0.12, 0.78], [0.26, 0.42], [0.4, 0.78]]);
    line(ctx, P, [[0.18, 0.64], [0.34, 0.64]]);
    line(ctx, P, [[0.46, 0.8], [0.67, 0.2], [0.88, 0.8]]);
    line(ctx, P, [[0.54, 0.58], [0.8, 0.58]]);
  },
  cameraNormal(ctx, P) {
    orbitArrow(ctx, P, 1);
  },
  cameraInvert(ctx, P) {
    orbitArrow(ctx, P, -1);
  },
  eye(ctx, P, s) {
    // the Control menu's show / hide button: an eye (almond outline, round iris and pupil)
    ctx.beginPath();
    ctx.moveTo(...P(0.08, 0.5));
    ctx.quadraticCurveTo(...P(0.5, 0.06), ...P(0.92, 0.5));
    ctx.quadraticCurveTo(...P(0.5, 0.94), ...P(0.08, 0.5));
    ctx.closePath();
    ctx.stroke();
    circle(ctx, P, 0.5, 0.5, 0.17, s);
    circle(ctx, P, 0.5, 0.5, 0.07, s, { fill: true });
  },
  controllerGuideOn(ctx, P, s) {
    // Controller Guide: a controller's handle with a button, and a label tag pointing at it
    poly(ctx, P, [[0.14, 0.3], [0.42, 0.3], [0.42, 0.88], [0.14, 0.88]]);
    circle(ctx, P, 0.28, 0.44, 0.06, s, { fill: true });
    line(ctx, P, [[0.34, 0.44], [0.56, 0.3]]);
    poly(ctx, P, [[0.56, 0.18], [0.9, 0.18], [0.9, 0.42], [0.56, 0.42]]);
  },
  controllerGuideOff(ctx, P, s) {
    poly(ctx, P, [[0.14, 0.3], [0.42, 0.3], [0.42, 0.88], [0.14, 0.88]]);
    circle(ctx, P, 0.28, 0.44, 0.06, s, { fill: true });
    line(ctx, P, [[0.5, 0.86], [0.9, 0.14]]); // struck through
  },
  guidesOn(ctx, P, s) {
    // Direction Guides: a creature (a block), a line out from it, and the dot it's heading for
    poly(ctx, P, [[0.12, 0.6], [0.4, 0.6], [0.4, 0.88], [0.12, 0.88]]);
    line(ctx, P, [[0.26, 0.74], [0.74, 0.26]]);
    circle(ctx, P, 0.76, 0.24, 0.09, s, { fill: true });
  },
  guidesOff(ctx, P, s) {
    poly(ctx, P, [[0.12, 0.6], [0.4, 0.6], [0.4, 0.88], [0.12, 0.88]]);
    circle(ctx, P, 0.76, 0.24, 0.09, s);
    line(ctx, P, [[0.56, 0.86], [0.9, 0.52]]); // struck through
  },
  internalOn(ctx, P) {
    // View Internal: a see-through (faint) body with the blocks inside it showing
    ctx.globalAlpha *= 0.5;
    poly(ctx, P, [[0.12, 0.2], [0.88, 0.2], [0.88, 0.8], [0.12, 0.8]]);
    ctx.globalAlpha /= 0.5;
    poly(ctx, P, [[0.24, 0.38], [0.44, 0.38], [0.44, 0.62], [0.24, 0.62]], { fill: true });
    poly(ctx, P, [[0.56, 0.38], [0.76, 0.38], [0.76, 0.62], [0.56, 0.62]], { fill: true });
  },
  internalOff(ctx, P) {
    // the body solid: nothing inside showing
    poly(ctx, P, [[0.12, 0.2], [0.88, 0.2], [0.88, 0.8], [0.12, 0.8]]);
    ctx.globalAlpha *= 0.35;
    poly(ctx, P, [[0.12, 0.2], [0.88, 0.2], [0.88, 0.8], [0.12, 0.8]], { fill: true });
  },
  performance(ctx, P, s, cx, cy) {
    // Debug → Performance: a gauge, its needle well up
    ctx.beginPath();
    ctx.arc(cx, cy + s * 0.12, s * 0.36, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    line(ctx, P, [[0.5, 0.62], [0.7, 0.36]]);
    circle(ctx, P, 0.5, 0.62, 0.05, s, { fill: true });
  },
  inspector(ctx, P, s) {
    // Debug → Inspector: a magnifying glass
    circle(ctx, P, 0.43, 0.43, 0.24, s);
    line(ctx, P, [[0.6, 0.6], [0.82, 0.82]]);
  },
  claude(ctx, P) {
    // Debug → Claude: a speech bubble
    poly(ctx, P, [[0.14, 0.2], [0.86, 0.2], [0.86, 0.66], [0.46, 0.66], [0.28, 0.82], [0.3, 0.66], [0.14, 0.66]]);
  },
  logging(ctx, P) {
    // Debug → Logging: lines of text of different lengths
    for (const [v, w] of [[0.24, 0.6], [0.4, 0.72], [0.56, 0.48], [0.72, 0.66]]) line(ctx, P, [[0.16, v], [0.16 + w, v]]);
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
