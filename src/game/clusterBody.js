// Options → Rendering: Smooth: every cluster is drawn as one merged mesh, built from
// the cluster's outer faces (faces between two of its own blocks are left out), welded into
// one surface, smoothed so its edges round off, and shaded with smooth normals. Clusters are
// World.clusterOf's: connected blocks of one type, a Squirmy's chain, a Crawly or Buzzy on
// its own. The blocks stay in the World (raycasting, rules); the block shader skips the ones
// flagged in the `blockMerged` instance attribute (uniforms.uSmoothRendering), and these meshes are
// drawn instead. Blocks growing in or shrinking away (appear / vanish) aren't merged, so
// their animations still play on the instanced mesh.
import * as THREE from 'three';
import { NEIGHBOR_DIRS, cellKey } from './lattice.js';
import { FACE_DIRS, truncatedOctahedronFaces } from './geometry.js';
import { BLOCK, blockProps, isCreature, isTranslucent } from './blocks.js';

const FACES = truncatedOctahedronFaces();
/** Taubin smoothing (shrink, then inflate) passes over a welded body: rounds its edges off. */
const SMOOTH_PASSES = 4;
const SMOOTH_LAMBDA = 0.5;
const SMOOTH_MU = -0.53;

const _c = new THREE.Color();
const _p = new THREE.Vector3();

/**
 * Corners of the blocks sit on a half-cm grid, so a corner's welding key packs (2x, 2y, 2z)
 * into one number (like lattice.js cellKey): no string per corner, and fast Map lookups.
 */
const WELD_SPAN = 1 << 17; // 17 bits per axis: 51 in all, within the 53 a JS number holds exactly
const WELD_HALF = WELD_SPAN / 2;
const weldKey = (x, y, z) => ((2 * x + WELD_HALF) * WELD_SPAN + (2 * y + WELD_HALF)) * WELD_SPAN + (2 * z + WELD_HALF);
/** A welded corner belongs to at most 4 blocks (cells meet 4 at a corner in this honeycomb). */
const MAX_OWNERS = 4;

/**
 * Topology of a cluster's body from its blocks' cells, all in flat typed arrays: welded
 * vertices (`smooth`: cell space, then smoothed), the blocks each one moves with
 * (`ownerIdx` / `ownerCount`: up to MAX_OWNERS indices into `blocks` per vertex), triangles
 * over the welded vertices (`tris`, for normals), and the render vertices: every outer face
 * fanned from its centre (3 per edge), each knowing its block (`rBlock`), face (`rFace`),
 * block-local position (`rLocal`) and welded vertex (`rWeld`). `flat` (shadeFlat types):
 * no smoothing, the faces stay flat.
 */
function buildBody(blocks, flat = false) {
  const at = new Map();
  blocks.forEach((block, i) => at.set(cellKey(block.x, block.y, block.z), i));
  // which faces are on the outside, and how big everything will be
  const outer = new Uint8Array(blocks.length * FACES.length);
  let faceCount = 0, cornerCount = 0;
  blocks.forEach((block, i) => {
    for (let fi = 0; fi < FACES.length; fi++) {
      const [dx, dy, dz] = FACE_DIRS[fi];
      if (at.has(cellKey(block.x + dx, block.y + dy, block.z + dz))) continue; // inside the body
      outer[i * FACES.length + fi] = 1;
      faceCount++;
      cornerCount += FACES[fi].verts.length;
    }
  });
  const maxWelded = faceCount + cornerCount; // (corners are shared, so fewer in practice)
  const renderCount = cornerCount * 3; // a triangle per face edge
  const rest = new Float32Array(maxWelded * 3);
  const ownerIdx = new Int32Array(maxWelded * MAX_OWNERS);
  const ownerCount = new Uint8Array(maxWelded);
  const tris = new Uint32Array(cornerCount * 3);
  const rBlock = new Uint32Array(renderCount), rWeld = new Uint32Array(renderCount);
  const rFace = new Float32Array(renderCount), rLocal = new Float32Array(renderCount * 3);
  const weld = new Map(); // corner key -> welded vertex
  let n = 0, nt = 0, nr = 0;
  const addOwner = (w, i) => {
    const o = w * MAX_OWNERS, c = ownerCount[w];
    for (let k = 0; k < c; k++) if (ownerIdx[o + k] === i) return;
    if (c < MAX_OWNERS) ownerIdx[o + c] = i, ownerCount[w] = c + 1;
  };
  const newVertex = (x, y, z) => {
    rest[n * 3] = x;
    rest[n * 3 + 1] = y;
    rest[n * 3 + 2] = z;
    return n++;
  };
  const ring = new Int32Array(6);
  blocks.forEach((block, i) => {
    for (let fi = 0; fi < FACES.length; fi++) {
      if (!outer[i * FACES.length + fi]) continue;
      const f = FACES[fi], verts = f.verts, len = verts.length;
      for (let k = 0; k < len; k++) {
        const v = verts[k];
        const x = block.x + v.x, y = block.y + v.y, z = block.z + v.z;
        const key = weldKey(x, y, z);
        let w = weld.get(key);
        if (w === undefined) weld.set(key, (w = newVertex(x, y, z)));
        addOwner(w, i);
        ring[k] = w;
      }
      const centre = newVertex(block.x + f.center.x, block.y + f.center.y, block.z + f.center.z); // not welded
      addOwner(centre, i);
      for (let k = 0; k < len; k++) {
        const k2 = k + 1 === len ? 0 : k + 1;
        tris[nt++] = centre;
        tris[nt++] = ring[k];
        tris[nt++] = ring[k2];
        // the triangle's three render vertices: centre, corner k, corner k2
        for (let j = 0; j < 3; j++) {
          const lv = j === 0 ? f.center : verts[j === 1 ? k : k2];
          rBlock[nr] = i;
          rFace[nr] = fi;
          rLocal[nr * 3] = lv.x;
          rLocal[nr * 3 + 1] = lv.y;
          rLocal[nr * 3 + 2] = lv.z;
          rWeld[nr] = j === 0 ? centre : ring[j === 1 ? k : k2];
          nr++;
        }
      }
    }
  });
  // neighbours along the triangle edges, as compressed sparse rows: vertex v's neighbours are
  // list[start[v] .. start[v] + count[v]] (each listed once, as the old Sets did)
  const start = new Int32Array(n + 1);
  for (let k = 0; k < nt; k++) start[tris[k] + 1] += 2; // 2 neighbours per triangle corner (before removing repeats)
  for (let v = 0; v < n; v++) start[v + 1] += start[v];
  const list = new Int32Array(start[n]);
  const count = new Int32Array(n);
  const put = (v, u) => {
    const s = start[v], c = count[v];
    for (let k = 0; k < c; k++) if (list[s + k] === u) return; // already listed
    list[s + c] = u;
    count[v] = c + 1;
  };
  for (let k = 0; k < nt; k += 3) {
    const a = tris[k], b = tris[k + 1], c = tris[k + 2];
    put(a, b); put(a, c);
    put(b, a); put(b, c);
    put(c, a); put(c, b);
  }
  // Taubin smoothing: alternately pull each vertex toward its neighbours' average (λ) and
  // push it back out (μ), which rounds the edges without shrinking the body much
  let pos = rest.slice(0, n * 3), next = new Float32Array(n * 3);
  for (let pass = 0; pass < (flat ? 0 : SMOOTH_PASSES * 2); pass++) {
    const f = pass % 2 ? SMOOTH_MU : SMOOTH_LAMBDA;
    for (let v = 0; v < n; v++) {
      let ax = 0, ay = 0, az = 0;
      const s = start[v], m = count[v];
      for (let k = s; k < s + m; k++) {
        const u = list[k] * 3;
        ax += pos[u];
        ay += pos[u + 1];
        az += pos[u + 2];
      }
      const o = v * 3, d = m || 1;
      next[o] = pos[o] + f * (ax / d - pos[o]);
      next[o + 1] = pos[o + 1] + f * (ay / d - pos[o + 1]);
      next[o + 2] = pos[o + 2] + f * (az / d - pos[o + 2]);
    }
    [pos, next] = [next, pos];
  }
  return {
    vertexCount: n, smooth: pos, ownerIdx, ownerCount, tris: tris.subarray(0, nt),
    rBlock, rFace, rLocal, rWeld,
  };
}

/** The clusters to draw: World.clusterOf's groups, over the blocks that aren't animating in / out. */
function clustersOf(world) {
  const skip = (block) => block.vanishing || world.vanishing.has(block) || world.appearing.has(block);
  const done = new Set();
  const out = [];
  for (const b of world.blocks.values()) {
    if (done.has(b) || skip(b)) continue;
    const blocks = world.clusterOf(b).filter((x) => !skip(x) && !done.has(x));
    for (const x of blocks) done.add(x);
    if (blocks.length) out.push(blocks);
  }
  return out;
}

/** More changed cells than this since the last update: rebuild everything instead (cheaper than piecemeal). */
const FULL_REBUILD_CELLS = 3000;

export class ClusterBodies {
  /** `materials`: the block materials (`body`, `bodyTranslucent`, …: MERGED_BODY). */
  constructor(parent, materials) {
    this.parent = parent;
    this.materials = materials;
    this.enabled = false;
    this.bodies = new Set();
    this._byBlock = new Map(); // block -> its body
    this._bodyAtCell = new Map(); // cell key -> the body that had a block there when built
    this._revision = -1; // world.revision the bodies were last brought up to date for
    this._world = null;
  }

  setEnabled(on) {
    this.enabled = on;
    this._revision = -1;
    if (this._world) this._world.idleMarks.clusterBodies = null; // rebuilt in full when next needed
    if (!on) this.clear();
  }

  clear() {
    for (const body of this.bodies) this._dispose(body);
    this.bodies.clear();
    this._byBlock.clear();
    this._bodyAtCell.clear();
  }

  _dispose(body) {
    this.parent.remove(body.mesh);
    body.mesh.geometry.dispose();
  }

  /** Call once per frame: brings the bodies up to date with changed blocks, and moves the ones sliding. */
  update(world, now) {
    if (!this.enabled) return;
    this._world = world;
    if (world.revision !== this._revision) {
      this._revision = world.revision;
      // the World's change log says which cells changed since last time (World.changeLog;
      // our mark keeps trimChangeLog from dropping what we haven't read yet)
      const since = world.idleMarks.clusterBodies;
      if (since == null || (world.changeLog.length - since) / 3 > FULL_REBUILD_CELLS) this._rebuildAll(world);
      else this._rebuildChanged(world, since);
      world.idleMarks.clusterBodies = world.changeLog.length;
      // blocks renumbered by a removal elsewhere in their batch, or creatures' (buff) colours
      for (const body of this.bodies) {
        if (body.creature || body.blocks.some((block, i) => block.index !== body.indices[i])) this._refreshLook(world, body);
      }
    }
    // bodies with a sliding block follow it (and settle once it has arrived)
    for (const k of world.anims.keys()) {
      const body = this._byBlock.get(world.blocks.get(k));
      if (body) body.moving = true;
    }
    for (const body of this.bodies) {
      if (!body.moving) continue;
      body.moving = body.blocks.some((block) => world.anims.has(cellKey(block.x, block.y, block.z)));
      this._pose(world, body, now);
    }
  }

  /** Throws every body away and builds them all again (Smooth turned on, a new world, a huge change). */
  _rebuildAll(world) {
    this.clear();
    world.clearMergedFlags();
    for (const blocks of clustersOf(world)) this._add(world, blocks);
  }

  /**
   * Rebuilds only the bodies the changed cells (World.changeLog from `since`) can have changed:
   * the body that had a block in a changed cell, the body of the block there now, and the
   * bodies of same-type neighbours (they may have joined or split). Their blocks, and the
   * blocks around the changed cells, are then grouped into clusters again (World.clusterOf)
   * and get new bodies. Nothing else in the world is looked at.
   */
  _rebuildChanged(world, since) {
    const log = world.changeLog;
    const skip = (block) => block.vanishing || world.vanishing.has(block) || world.appearing.has(block);
    const stale = new Set(), seeds = new Set();
    for (let i = since; i < log.length; i += 3) {
      const x = log[i], y = log[i + 1], z = log[i + 2];
      const key = cellKey(x, y, z);
      const had = this._bodyAtCell.get(key);
      if (had) stale.add(had);
      const now = world.blocks.get(key);
      if (now) {
        seeds.add(now);
        const body = this._byBlock.get(now);
        if (body) stale.add(body);
      }
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const n = world.blocks.get(cellKey(x + dx, y + dy, z + dz));
        if (!n || (n.type !== now?.type && n.type !== had?.type)) continue; // other types' clusters can't have changed
        seeds.add(n);
        const body = this._byBlock.get(n);
        if (body) stale.add(body);
      }
    }
    for (const body of stale) this._remove(world, body, seeds);
    const done = new Set();
    for (const seed of seeds) {
      if (done.has(seed) || this._byBlock.has(seed) || skip(seed) || world.blocks.get(cellKey(seed.x, seed.y, seed.z)) !== seed) continue;
      const blocks = world.clusterOf(seed).filter((block) => !skip(block));
      for (const block of blocks) done.add(block);
      // (a cluster that grew into one not marked stale: that body goes too)
      for (const block of blocks) {
        const other = this._byBlock.get(block);
        if (other) this._remove(world, other, null);
      }
      if (blocks.length) this._add(world, blocks);
    }
  }

  /** Builds and registers a body for `blocks` (one cluster), flagging them as drawn by it. */
  _add(world, blocks) {
    const body = this._create(blocks);
    body.creature = isCreature(blocks[0].type);
    body.cells = blocks.map((block) => cellKey(block.x, block.y, block.z));
    this.bodies.add(body);
    for (const block of blocks) {
      this._byBlock.set(block, body);
      world.setMergedFlag(block);
    }
    for (const key of body.cells) this._bodyAtCell.set(key, body);
    this._refreshLook(world, body);
    body.moving = true; // placed on the next pose
  }

  /** Drops `body`: its blocks are drawn on their own again until a new body takes them (added to `seeds`). */
  _remove(world, body, seeds) {
    if (!this.bodies.delete(body)) return;
    this._dispose(body);
    for (const key of body.cells) if (this._bodyAtCell.get(key) === body) this._bodyAtCell.delete(key);
    for (const block of body.blocks) {
      if (this._byBlock.get(block) === body) this._byBlock.delete(block);
      if (world.blocks.get(cellKey(block.x, block.y, block.z)) !== block) continue; // gone from the world
      world.setMergedFlag(block, false);
      seeds?.add(block);
    }
  }

  _create(blocks) {
    const flat = !!blockProps(blocks[0].type).shadeFlat;
    const topo = buildBody(blocks, flat);
    const n = topo.rWeld.length;
    const vn = topo.vertexCount;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('localPos', new THREE.BufferAttribute(topo.rLocal, 3));
    g.setAttribute('faceIndex', new THREE.BufferAttribute(topo.rFace, 1));
    // smooth bodies: no face outlines, no corner darkening
    g.setAttribute('edgeDist', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
    g.setAttribute('aoFaces', new THREE.BufferAttribute(new Float32Array(n * 3).fill(-1), 3));
    g.setAttribute('blockStyle', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('blockIndex', new THREE.BufferAttribute(new Float32Array(n), 1));
    const type = blocks[0].type;
    const isCloud = type === BLOCK.FOG || type === BLOCK.NIMBUS;
    const isCrystal = type === BLOCK.CRYSTAL;
    const mesh = new THREE.Mesh(g, isCloud ? this.materials.bodyCloud : isCrystal ? this.materials.bodyCrystal
      : isTranslucent(type) ? this.materials.bodyTranslucent : this.materials.body);
    mesh.name = 'cluster-body';
    mesh.frustumCulled = false;
    mesh.raycast = () => { }; // picking uses the (hidden) blocks
    if (isTranslucent(type)) mesh.renderOrder = isCloud ? 1 : 2; // clouds first (they write depth), then Water / Crystal
    this.parent.add(mesh);
    return { mesh, blocks, topo, flat, indices: [], normals: new Float32Array(vn * 3), welded: new Float32Array(vn * 3), offsets: new Float32Array(blocks.length * 3) };
  }

  /** Copies each block's colour, style (seed, buff tint) and instance index to its vertices. */
  _refreshLook(world, body) {
    const g = body.mesh.geometry;
    const style = g.getAttribute('blockStyle'), color = g.getAttribute('color'), index = g.getAttribute('blockIndex');
    // each block's values once (8 numbers), then copied to its render vertices
    const per = new Float32Array(body.blocks.length * 8);
    body.blocks.forEach((block, i) => {
      const src = world._style(block), o = i * 8;
      world.colorOf(block, _c);
      per[o] = src.getX(block.index);
      per[o + 1] = src.getY(block.index);
      per[o + 2] = isTranslucent(block.type) ? 0 : src.getZ(block.index);
      per[o + 3] = src.getW(block.index);
      per[o + 4] = _c.r;
      per[o + 5] = _c.g;
      per[o + 6] = _c.b;
      per[o + 7] = block.index;
    });
    const rBlock = body.topo.rBlock, S = style.array, C = color.array, I = index.array;
    for (let v = 0; v < rBlock.length; v++) {
      const o = rBlock[v] * 8;
      S[v * 4] = per[o];
      S[v * 4 + 1] = per[o + 1];
      S[v * 4 + 2] = per[o + 2];
      S[v * 4 + 3] = per[o + 3];
      C[v * 3] = per[o + 4];
      C[v * 3 + 1] = per[o + 5];
      C[v * 3 + 2] = per[o + 6];
      I[v] = per[o + 7];
    }
    style.needsUpdate = color.needsUpdate = index.needsUpdate = true;
    body.indices = body.blocks.map((block) => block.index);
  }

  /**
   * Places the body: each welded vertex moves by the average slide of the blocks it belongs
   * to (so a moving cluster stretches and bends instead of jumping), then smooth normals are
   * computed on the welded surface and copied to the render vertices.
   */
  _pose(world, body, now) {
    const { smooth, ownerIdx, ownerCount, tris, rWeld, vertexCount } = body.topo;
    const offsets = body.offsets;
    body.blocks.forEach((block, i) => {
      world.renderedPosition(block, now, _p);
      offsets[i * 3] = _p.x - block.x;
      offsets[i * 3 + 1] = _p.y - block.y;
      offsets[i * 3 + 2] = _p.z - block.z;
    });
    const W = body.welded, N = body.normals;
    for (let v = 0; v < vertexCount; v++) {
      let ox = 0, oy = 0, oz = 0;
      const m = ownerCount[v], o = v * MAX_OWNERS;
      for (let k = 0; k < m; k++) {
        const b = ownerIdx[o + k] * 3;
        ox += offsets[b];
        oy += offsets[b + 1];
        oz += offsets[b + 2];
      }
      const d = m || 1, p = v * 3;
      W[p] = smooth[p] + ox / d;
      W[p + 1] = smooth[p + 1] + oy / d;
      W[p + 2] = smooth[p + 2] + oz / d;
    }
    if (body.flat) return this._placeFlat(body, W);
    // area-weighted vertex normals over the welded triangles
    N.fill(0);
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const ux = W[b] - W[a], uy = W[b + 1] - W[a + 1], uz = W[b + 2] - W[a + 2];
      const vx = W[c] - W[a], vy = W[c + 1] - W[a + 1], vz = W[c + 2] - W[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
      N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
      N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
    }
    for (let v = 0; v < N.length; v += 3) {
      const l = Math.hypot(N[v], N[v + 1], N[v + 2]) || 1;
      N[v] /= l;
      N[v + 1] /= l;
      N[v + 2] /= l;
    }
    const g = body.mesh.geometry;
    const pos = g.getAttribute('position').array, nor = g.getAttribute('normal').array;
    for (let r = 0; r < rWeld.length; r++) {
      const w = rWeld[r] * 3;
      pos[r * 3] = W[w];
      pos[r * 3 + 1] = W[w + 1];
      pos[r * 3 + 2] = W[w + 2];
      nor[r * 3] = N[w];
      nor[r * 3 + 1] = N[w + 1];
      nor[r * 3 + 2] = N[w + 2];
    }
    g.getAttribute('position').needsUpdate = g.getAttribute('normal').needsUpdate = true;
  }

  /** shadeFlat bodies: posed welded positions `W`, and each render triangle's own flat normal. */
  _placeFlat(body, W) {
    const { rWeld } = body.topo;
    const g = body.mesh.geometry;
    const pos = g.getAttribute('position').array, nor = g.getAttribute('normal').array;
    for (let r = 0; r < rWeld.length; r++) {
      const w = rWeld[r] * 3;
      pos[r * 3] = W[w];
      pos[r * 3 + 1] = W[w + 1];
      pos[r * 3 + 2] = W[w + 2];
    }
    for (let t = 0; t < pos.length; t += 9) {
      const ux = pos[t + 3] - pos[t], uy = pos[t + 4] - pos[t + 1], uz = pos[t + 5] - pos[t + 2];
      const vx = pos[t + 6] - pos[t], vy = pos[t + 7] - pos[t + 1], vz = pos[t + 8] - pos[t + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      for (let k = 0; k < 9; k += 3) {
        nor[t + k] = nx;
        nor[t + k + 1] = ny;
        nor[t + k + 2] = nz;
      }
    }
    g.getAttribute('position').needsUpdate = g.getAttribute('normal').needsUpdate = true;
  }
}

