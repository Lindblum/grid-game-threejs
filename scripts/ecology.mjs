// Writes docs/ecology.html: the game's ecological economy as a graph. Every block type is a
// draggable tile; arrows show what it takes part in:
//   Consume  food -> critter (its diet; also trees drinking Water, Dirt and Plop soaking it up)
//   Excrete  critter -> what that food comes out as (World.excrete / excretedType), and its Eggs
//   Grow     parent -> child (trees grow Wood, Leaves, Berries; Dirt -> Moss, Plop -> Wood when
//            watered; Eggs hatch; Nimbus rains; a Glowy grows a segment on a Berry)
//   Becomes  death and withering (a dead critter -> Glop; a dry tree's Leaves / Berries -> Slop)
// Consume and Excrete are read from blocks.js (diet, excretes), so they stay current; Grow and
// Becomes mirror rules in sim.js / world.js / needs.js, listed below: keep them in step.
// Run: npm run docs:ecology
import { writeFileSync, mkdirSync } from 'node:fs';
import { BLOCK, BLOCK_TYPES, blockProps } from '../src/game/blocks.js';

const K = (key) => BLOCK[key];
const CREATURES = BLOCK_TYPES.filter((t) => t.creature).map((t) => t.id);
const isCreature = (id) => CREATURES.includes(id);
// (world.js PLANT_TYPES and excretedType: eaten plants come out as Slop, creatures as Glop, Crystal as Stone)
const PLANT_TYPES = [K('WOOD'), K('LEAVES'), K('BERRY'), K('MOSS')];
const excretedType = (holder, type) => blockProps(holder).excretes?.[type]
  ?? (isCreature(type) ? K('GLOP') : PLANT_TYPES.includes(type) ? K('SLOP') : type === K('CRYSTAL') ? K('STONE') : type);

const edges = [];
const add = (kind, from, to, note) => {
  if (from == null || to == null) throw new Error(`ecology: unknown block in ${kind} ${from} -> ${to}`);
  if (!edges.some((e) => e.kind === kind && e.from === from && e.to === to)) edges.push({ kind, from, to, note });
};
const name = (id) => blockProps(id).name;

// ---- Consume / Excrete: each critter's diet, and what each food comes out as
for (const c of CREATURES) {
  const p = blockProps(c);
  for (const food of p.diet ?? []) {
    const water = food === K('WATER');
    add('consume', food, c, `${name(c)} ${water ? 'drinks' : 'eats'} ${name(food)}${p.priorityDiet?.includes(food) ? ' (a favourite)' : ''}`);
    if (water) continue; // (drinking restores Quench; nothing is passed)
    const out = excretedType(c, food);
    add('excrete', c, out, `${name(c)} passes ${name(food)} as ${name(out)}`);
  }
  add('excrete', c, K('EGG'), `${name(c)} lays an Egg after mating`);
}
// ---- the rest of the economy (sim.js stepWood, stepDirt, stepEggs, stepNimbus; needs.js; World.die)
add('consume', K('WATER'), K('WOOD'), 'a tree drinks settled Water beside it (Quench; it grows)');
add('consume', K('WATER'), K('DIRT'), 'Dirt soaks up settled Water');
add('consume', K('WATER'), K('PLOP'), 'Plop soaks up settled Water');
add('grow', K('WOOD'), K('WOOD'), 'a watered tree grows Wood');
add('grow', K('WOOD'), K('LEAVES'), 'a watered tree grows Leaves (in a free cell next to its Wood)');
add('grow', K('WOOD'), K('BERRY'), 'a watered tree of 5+ Wood grows Berries');
add('grow', K('DIRT'), K('MOSS'), 'watered Dirt becomes Moss');
add('grow', K('PLOP'), K('WOOD'), 'watered Plop becomes Wood (a new tree)');
add('grow', K('NIMBUS'), K('WATER'), 'a Nimbus rains Water');
for (const c of CREATURES) add('grow', K('EGG'), c, `an Egg hatches a ${name(c)}`);
for (const c of CREATURES) if (blockProps(c).growsOnBerry) add('grow', c, c, `a ${name(c)} grows a body segment when it eats a Berry`);
for (const c of CREATURES) if (blockProps(c).needs) add('becomes', c, K('GLOP'), `a ${name(c)} that dies (0 HP) becomes Glop`);
add('becomes', K('LEAVES'), K('SLOP'), 'withers when its tree is out of Quench');
add('becomes', K('BERRY'), K('SLOP'), 'withers when its tree is out of Quench');

// ---- tiles, in columns by role (a starting layout; drag them anywhere)
const ROLE = (t) => t.creature ? 'Critters'
  : [K('GLOP'), K('SLOP'), K('PLOP'), K('EGG')].includes(t.id) ? 'Waste & Eggs'
    : [K('DIRT'), K('MOSS'), K('WOOD'), K('LEAVES'), K('BERRY')].includes(t.id) ? 'Plants & Soil'
      : 'Elements';
const nodes = BLOCK_TYPES.map((t) => ({ id: t.id, name: t.name, color: t.color, role: ROLE(t),
  info: t.creature ? `Critter. Diet: ${(t.diet ?? []).map(name).join(', ') || 'none'}${t.needs ? `. HP ${t.needs.hp}, bite ${t.needs.bite}` : ''}` : '' }));
const ROLES = ['Elements', 'Plants & Soil', 'Critters', 'Waste & Eggs'];

const data = { nodes, edges, roles: ROLES, made: new Date().toISOString().slice(0, 10) };
mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
writeFileSync(new URL('../docs/ecology.html', import.meta.url), page(data));
console.log(`docs/ecology.html: ${nodes.length} blocks, ${edges.length} relationships`);

function page(data) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ecology: block relationships</title>
<style>
  :root { color-scheme: dark; --bg: #14161c; --panel: #1d2029; --ink: #e8eaf0; --dim: #9aa0ad; --line: #2c303b; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font: 14px/1.4 system-ui, sans-serif; overflow: hidden; }
  header { position: fixed; inset: 0 0 auto 0; z-index: 3; display: flex; gap: 14px; align-items: center; white-space: nowrap; overflow-x: auto;
    padding: 10px 16px; background: color-mix(in srgb, var(--panel) 92%, transparent); border-bottom: 1px solid var(--line); }
  h1 { font-size: 16px; margin: 0 8px 0 0; font-weight: 600; }
  label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; user-select: none; }
  .key { display: inline-block; width: 22px; height: 0; border-top: 3px solid; vertical-align: middle; }
  .key.dashed { border-top-style: dashed; }
  button { background: #2a2f3b; color: var(--ink); border: 1px solid #3a404e; border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; }
  button:hover { background: #343a48; }
  #hint { color: var(--dim); font-size: 12px; margin-left: auto; }
  header label { font-size: 13px; }
  #stage { position: absolute; inset: 0; overflow: auto; }
  #canvas { position: relative; width: 1600px; height: 1100px; }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .col { position: absolute; top: 66px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  .tile { position: absolute; width: 132px; padding: 7px 10px 7px 8px; display: flex; gap: 8px; align-items: center;
    background: var(--panel); border: 1px solid var(--line); border-radius: 9px; cursor: grab; user-select: none; touch-action: none;
    box-shadow: 0 2px 8px #0006; z-index: 2; }
  .tile.dragging { cursor: grabbing; box-shadow: 0 6px 18px #000a; z-index: 4; }
  .tile.lit { border-color: #fff8; }
  .tile.faded { opacity: .35; }
  .sw { width: 22px; height: 22px; border-radius: 5px; flex: none; box-shadow: inset 0 0 0 1px #0005; }
  .tile b { font-weight: 600; }
  .tile small { display: block; color: var(--dim); font-size: 11px; }
  path.edge { fill: none; stroke-width: 2; opacity: .75; }
  path.edge.lit { stroke-width: 3.2; opacity: 1; }
  path.edge.faded { opacity: .08; }
  path.hit { fill: none; stroke: transparent; stroke-width: 12; cursor: help; }
  #tip { position: fixed; z-index: 5; pointer-events: none; background: #000d; color: #fff; padding: 5px 8px; border-radius: 6px;
    font-size: 12px; max-width: 320px; display: none; }
</style>
</head>
<body>
<header>
  <h1>Ecology</h1>
  <label><input type="checkbox" data-kind="consume" checked><span class="key" style="border-color:#f5a524"></span>Consume (food → critter)</label>
  <label><input type="checkbox" data-kind="excrete" checked><span class="key" style="border-color:#b07cff"></span>Excrete (critter → excrement)</label>
  <label><input type="checkbox" data-kind="grow" checked><span class="key" style="border-color:#4cd17a"></span>Grow (parent → child)</label>
  <label><input type="checkbox" data-kind="becomes" checked><span class="key dashed" style="border-color:#9aa0ad"></span>Becomes (dies / withers)</label>
  <button id="reset">Reset layout</button>
  <button id="copy">Copy layout</button>
  <span id="hint">Drag tiles · hover for details · ${data.made}</span>
</header>
<div id="stage"><div id="canvas"><svg id="svg"></svg></div></div>
<div id="tip"></div>
<script>
const DATA = ${JSON.stringify(data)};
const COLORS = { consume: '#f5a524', excrete: '#b07cff', grow: '#4cd17a', becomes: '#9aa0ad' };
const KEY = 'ecology-layout-v2';
const canvas = document.getElementById('canvas'), svg = document.getElementById('svg'), tip = document.getElementById('tip');
const NS = 'http://www.w3.org/2000/svg';
const shown = { consume: true, excrete: true, grow: true, becomes: true };

// arrowheads, one per kind
const defs = document.createElementNS(NS, 'defs');
for (const [k, c] of Object.entries(COLORS)) {
  defs.insertAdjacentHTML('beforeend', '<marker id="m-' + k + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + c + '"/></marker>');
}
svg.appendChild(defs);

// starting layout: a column per role
function defaultLayout() {
  const pos = {};
  DATA.roles.forEach((role, ci) => {
    const list = DATA.nodes.filter((n) => n.role === role);
    list.forEach((n, i) => { pos[n.id] = { x: 40 + ci * 290 + (i % 2) * 135, y: 100 + i * 74 }; });
  });
  return pos;
}
let pos;
try { pos = { ...defaultLayout(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { pos = defaultLayout(); }

DATA.roles.forEach((role, ci) => {
  const h = document.createElement('div');
  h.className = 'col'; h.textContent = role; h.style.left = (40 + ci * 290) + 'px';
  canvas.appendChild(h);
});

const tiles = {};
for (const n of DATA.nodes) {
  const t = document.createElement('div');
  t.className = 'tile';
  t.innerHTML = '<span class="sw" style="background:' + n.color + '"></span><span><b>' + n.name + '</b><small>' + n.role + '</small></span>';
  canvas.appendChild(t);
  tiles[n.id] = t;
  place(n.id);
  drag(t, n.id);
  t.addEventListener('pointerenter', () => { light(n.id); showTip(details(n), t); });
  t.addEventListener('pointerleave', () => { light(null); hideTip(); });
}

function place(id) { tiles[id].style.left = pos[id].x + 'px'; tiles[id].style.top = pos[id].y + 'px'; }
function box(id) { const t = tiles[id]; return { x: pos[id].x, y: pos[id].y, w: t.offsetWidth, h: t.offsetHeight }; }

function drag(el, id) {
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    start = { mx: e.clientX, my: e.clientY, x: pos[id].x, y: pos[id].y };
    el.setPointerCapture(e.pointerId); el.classList.add('dragging'); hideTip();
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    pos[id] = { x: Math.max(0, start.x + e.clientX - start.mx), y: Math.max(56, start.y + e.clientY - start.my) };
    place(id); draw();
  });
  const end = () => { if (!start) return; start = null; el.classList.remove('dragging'); localStorage.setItem(KEY, JSON.stringify(pos)); grow(); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}

// where the line from a box's centre toward (tx, ty) leaves the box
function exitPoint(b, tx, ty) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = tx - cx, dy = ty - cy;
  const s = Math.min(Math.abs((b.w / 2 + 3) / (dx || 1e-9)), Math.abs((b.h / 2 + 3) / (dy || 1e-9)));
  return [cx + dx * s, cy + dy * s];
}

let paths = [];
function draw() {
  for (const p of paths) p.remove();
  paths = [];
  const visible = DATA.edges.filter((e) => shown[e.kind]);
  // arrows between the same two tiles bend apart
  const groups = {};
  for (const e of visible) { const k = [e.from, e.to].sort().join('|'); (groups[k] ??= []).push(e); }
  for (const e of visible) {
    let d;
    const a = box(e.from), b = box(e.to);
    if (e.from === e.to) {
      // a loop over the tile's top right corner
      const x = a.x + a.w - 22, y = a.y;
      d = 'M' + x + ',' + y + ' C' + (x - 6) + ',' + (y - 46) + ' ' + (x + 50) + ',' + (y - 30) + ' ' + (a.x + a.w) + ',' + (y + 10);
    } else {
      const k = [e.from, e.to].sort().join('|'), g = groups[k], i = g.indexOf(e);
      const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
      const sign = e.from < e.to ? 1 : -1; // (the same side whichever way it runs)
      const bend = (g.length === 1 ? 0.12 : (i - (g.length - 1) / 2) * 0.32 + 0.1) * sign;
      const mx = (acx + bcx) / 2, my = (acy + bcy) / 2, nx = -(bcy - acy), ny = bcx - acx;
      const qx = mx + nx * bend, qy = my + ny * bend;
      const [sx, sy] = exitPoint(a, qx, qy), [tx, ty] = exitPoint(b, qx, qy);
      d = 'M' + sx + ',' + sy + ' Q' + qx + ',' + qy + ' ' + tx + ',' + ty;
    }
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d); p.setAttribute('class', 'edge'); p.setAttribute('stroke', COLORS[e.kind]);
    p.setAttribute('marker-end', 'url(#m-' + e.kind + ')');
    if (e.kind === 'becomes') p.setAttribute('stroke-dasharray', '6 5');
    p.edge = e;
    const hit = document.createElementNS(NS, 'path');
    hit.setAttribute('d', d); hit.setAttribute('class', 'hit');
    hit.addEventListener('pointerenter', (ev) => { p.classList.add('lit'); showTipAt(label(e), ev.clientX, ev.clientY); });
    hit.addEventListener('pointermove', (ev) => showTipAt(label(e), ev.clientX, ev.clientY));
    hit.addEventListener('pointerleave', () => { p.classList.remove('lit'); hideTip(); });
    svg.appendChild(p); svg.appendChild(hit);
    paths.push(p, hit);
  }
  light(lit);
}

const nameOf = (id) => DATA.nodes.find((n) => n.id === id).name;
const KIND = { consume: 'Consume', excrete: 'Excrete', grow: 'Grow', becomes: 'Becomes' };
function label(e) { return '<b>' + KIND[e.kind] + ':</b> ' + nameOf(e.from) + ' → ' + nameOf(e.to) + '<br>' + e.note; }
function details(n) {
  const ins = DATA.edges.filter((e) => e.to === n.id && shown[e.kind]), outs = DATA.edges.filter((e) => e.from === n.id && shown[e.kind]);
  const list = (es, other) => es.map((e) => KIND[e.kind] + ' ' + nameOf(e[other])).join(', ') || 'none';
  return '<b>' + n.name + '</b>' + (n.info ? '<br>' + n.info : '') + '<br>In: ' + list(ins, 'from') + '<br>Out: ' + list(outs, 'to');
}

let lit = null;
function light(id) {
  lit = id;
  const near = new Set(id ? [id] : []);
  for (const p of paths) {
    if (!p.edge) continue;
    const on = id && (p.edge.from === id || p.edge.to === id);
    if (on) { near.add(p.edge.from); near.add(p.edge.to); }
    p.classList.toggle('lit', !!on);
    p.classList.toggle('faded', !!id && !on);
  }
  for (const [tid, t] of Object.entries(tiles)) { t.classList.toggle('lit', tid === id); t.classList.toggle('faded', !!id && !near.has(tid)); }
}

function showTip(html, el) { const r = el.getBoundingClientRect(); showTipAt(html, r.right + 8, r.top); }
function showTipAt(html, x, y) {
  tip.innerHTML = html; tip.style.display = 'block';
  tip.style.left = Math.min(x + 12, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.min(y + 12, innerHeight - tip.offsetHeight - 8) + 'px';
}
function hideTip() { tip.style.display = 'none'; }

// the canvas grows to hold every tile
function grow() {
  let w = 1200, h = 800;
  for (const id in tiles) { const b = box(id); w = Math.max(w, b.x + b.w + 120); h = Math.max(h, b.y + b.h + 120); }
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
}

for (const cb of document.querySelectorAll('input[data-kind]')) cb.addEventListener('change', () => { shown[cb.dataset.kind] = cb.checked; draw(); });
document.getElementById('reset').onclick = () => { localStorage.removeItem(KEY); pos = defaultLayout(); for (const id in tiles) place(id); grow(); draw(); };
document.getElementById('copy').onclick = async () => {
  const text = JSON.stringify(pos);
  try { await navigator.clipboard.writeText(text); document.getElementById('copy').textContent = 'Copied'; }
  catch { prompt('Layout (positions by block id):', text); }
  setTimeout(() => (document.getElementById('copy').textContent = 'Copy layout'), 1200);
};
grow(); draw();
</script>
</body>
</html>
`;
}
