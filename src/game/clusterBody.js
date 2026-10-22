// Options → Rendering: Smooth: every cluster is drawn as one merged mesh, built from
// the cluster's outer faces (faces between two of its own blocks are left out), welded into
// one surface, smoothed so its edges round off, and shaded with smooth normals. Clusters are
// World.clusterOf's: connected blocks of one type, a Squirmy's chain, a Crawly or Buzzy on
// its own. The blocks stay in the World (raycasting, rules); the block shader skips the ones
// flagged in the `blockMerged` instance attribute (uniforms.uSmoothRendering), and these meshes are
// drawn instead. Blocks growing in or shrinking away (appear / vanish) aren't merged, so
// their animations still play on the instanced mesh.
import * as THREE from 'three';
import { GRID, NEIGHBOR_DIRS, cellKey } from './lattice.js';
import { FACE_DIRS } from './geometry.js';
import { addDepthPrePass } from './blockBatch.js';
import { BLOCK, blockProps, isChainCreature, isCreature, isTranslucent } from './blocks.js';

/** Taubin smoothing (shrink, then inflate) passes over a welded body: rounds its edges off. */
const SMOOTH_PASSES = 4;
const SMOOTH_LAMBDA = 0.5;
const SMOOTH_MU = -0.53;

/** A chain creature's tube (ClusterBodies._createTube): radius (cm; a cell's inradius is 1 cm), sides, rings per segment (even) and per end cap. */
const TUBE_RADIUS_CM = 0.95;
const TUBE_SIDES = 16;
const TUBE_RINGS_PER_SEGMENT = 6;
const TUBE_CAP_RINGS = 4;

const _c = new THREE.Color();
const _p = new THREE.Vector3();

/**
 * Corners of the blocks sit on a half-unit grid of lattice coordinates (every grid mode), so a corner's welding key packs (2x, 2y, 2z)
 * into one number (like lattice.js cellKey): no string per corner, and fast Map lookups.
 */
const WELD_SPAN = 1 << 17; // 17 bits per axis: 51 in all, within the 53 a JS number holds exactly
const WELD_HALF = WELD_SPAN / 2;
const weldKey = (x, y, z) => ((2 * x + WELD_HALF) * WELD_SPAN + (2 * y + WELD_HALF)) * WELD_SPAN + (2 * z + WELD_HALF);
/** A welded corner belongs to at most 8 blocks (cubes meet 8 at a corner; truncated octahedra 4, rhombic dodecahedra 4 or 6). */
const MAX_OWNERS = 8;

/**
 * Topology of a cluster's body from its blocks' cells, all in flat typed arrays: welded
 * vertices (`smooth`: cm, then smoothed), the blocks each one moves with
 * (`ownerIdx` / `ownerCount`: up to MAX_OWNERS indices into `blocks` per vertex), triangles
 * over the welded vertices (`tris`, for normals), and the render vertices: every outer face
 * fanned from its centre (3 per edge), each knowing its block (`rBlock`), face (`rFace`),
 * block-local position (`rLocal`) and welded vertex (`rWeld`). `flat` (shadeFlat types):
 * no smoothing, the faces stay flat.
 */
export function buildBody(blocks, flat = false) {
  // the cell shape in lattice units (corners weld on lattice coordinates), drawn in cm
  const FACES = GRID.faces, scale = GRID.scale;
  const at = new Map();
  blocks.forEach((block, i) => at.set(cellKey(block.x, block.y, block.z), i));
  // which faces are on the outside, and how big everything will be
  const outer = new Uint8Array(blocks.length * FACES.length);
  let faceCount = 0, cornerCount = 0;
  blocks.forEach((block, i) => {
    for (let fi = 0; fi < FACES.length; fi++) {
      const [dx, dy, dz] = FACE_DIRS[fi];
      const j = at.get(cellKey(block.x + dx, block.y + dy, block.z + dz));
      if (j !== undefined) continue; // inside the body
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
  const weldFor = (key, x, y, z) => {
    let w = weld.get(key);
    if (w === undefined) weld.set(key, (w = newVertex(x, y, z)));
    return w;
  };
  let n = 0, nt = 0, nr = 0;
  const addOwner = (w, i) => {
    const o = w * MAX_OWNERS, c = ownerCount[w];
    for (let k = 0; k < c; k++) if (ownerIdx[o + k] === i) return;
    if (c < MAX_OWNERS) ownerIdx[o + c] = i, ownerCount[w] = c + 1;
  };
  const newVertex = (x, y, z) => {
    rest[n * 3] = x * scale;
    rest[n * 3 + 1] = y * scale;
    rest[n * 3 + 2] = z * scale;
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
        const w = weldFor(weldKey(x, y, z), x, y, z);
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
          rLocal[nr * 3] = lv.x * scale;
          rLocal[nr * 3 + 1] = lv.y * scale;
          rLocal[nr * 3 + 2] = lv.z * scale;
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
    this._seeThrough = new Set(); // bodies drawn see-through (setSeeThrough)
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

  /**
   * Draws the bodies holding any of `blocks` (a Set) see-through: dithered all over, inside
   * faces too (the camera is inside them; see World.setSeeThrough), and those holding any of
   * `internal` 3/4 opaque (View Internal; `blocks` wins). Opaque bodies only. Call every frame:
   * rebuilt bodies start out with their own material.
   */
  setSeeThrough(blocks, internal = new Set()) {
    const { body: plain, bodySeeThrough, bodyInternal } = this.materials;
    const want = new Map(); // body -> its material
    const mark = (set, material) => {
      for (const block of set) {
        const body = this._byBlock.get(block);
        const m = body?.mesh.material;
        if (m === plain || m === bodySeeThrough || m === bodyInternal) want.set(body, material);
      }
    };
    mark(internal, bodyInternal);
    mark(blocks, bodySeeThrough);
    for (const body of this._seeThrough) if (!want.has(body)) body.mesh.material = plain;
    for (const [body, material] of want) body.mesh.material = material;
    this._seeThrough = new Set(want.keys());
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
    // a creature in segments (a chain creature like a Squirmy, or a Buzzy grown longer) is a
    // tube through them (see _createTube), not its cells welded
    const head = blocks[0].segmentOf ?? blocks[0];
    const chain = isChainCreature(blocks[0].type) ? this._world?.squirmyOf.get(blocks[0])?.segments
      : isCreature(blocks[0].type) && head.segments?.length ? [head, ...head.segments] : null;
    if (chain && blocks.length > 1) return this._createTube(blocks, chain);
    const topo = buildBody(blocks, flat);
    const n = topo.rWeld.length;
    const vn = topo.vertexCount;
    const g = this._bodyGeometry(n);
    g.getAttribute('localPos').array.set(topo.rLocal);
    g.getAttribute('faceIndex').array.set(topo.rFace);
    const mesh = this._bodyMesh(g, blocks[0].type);
    return { mesh, blocks, topo, flat, indices: [], normals: new Float32Array(vn * 3), welded: new Float32Array(vn * 3), offsets: new Float32Array(blocks.length * 3) };
  }

  /**
   * A chain creature's body: a round tube along a smooth curve (Catmull-Rom) through its
   * segments' centres, head to tail, capped with half-spheres. Its cells welded together would
   * make a boxy elbow at every turn, pinched while the segments slide round it; the curve bends
   * smoothly instead, and follows the segments as they slide (see _poseTube). Each segment owns
   * the stretch of tube nearest it (rings are doubled where two meet), so its pattern stays its own.
   */
  _createTube(blocks, chain) {
    const order = [...blocks].sort((a, b) => chain.indexOf(a) - chain.indexOf(b));
    const n = order.length, R = TUBE_RINGS_PER_SEGMENT, last = (n - 1) * R;
    // rings: { i (segment), s (sample along the spine, 0 = head .. last = tail), rad, axial }:
    // radius and offset along the tangent, both as fractions of the tube radius
    const rings = [];
    const cap = (i, s, sign, outward) => {
      for (let k = 1; k <= TUBE_CAP_RINGS; k++) {
        const kk = outward ? k : TUBE_CAP_RINGS + 1 - k;
        const a = (kk / TUBE_CAP_RINGS) * Math.PI / 2;
        rings.push({ i, s, rad: Math.cos(a), axial: sign * Math.sin(a) });
      }
    };
    for (let i = 0; i < n; i++) {
      if (i === 0) cap(0, 0, -1, false); // the head's end, pole first
      for (let s = Math.max(0, i * R - R / 2); s <= Math.min(last, i * R + R / 2); s++) rings.push({ i, s, rad: 1, axial: 0 });
      if (i === n - 1) cap(i, last, 1, true); // the tail's end, pole last
    }
    const V = TUBE_SIDES;
    const index = [];
    for (let r = 0; r + 1 < rings.length; r++) {
      if (rings[r].i !== rings[r + 1].i) continue; // (a doubled ring: the next segment starts afresh)
      for (let j = 0; j < V; j++) {
        const a = r * V + j, b = r * V + ((j + 1) % V), c = a + V, d = b + V;
        index.push(a, b, c, b, d, c); // (counter-clockwise from outside)
      }
    }
    const count = rings.length * V;
    const g = this._bodyGeometry(count);
    g.setIndex(index);
    const rBlock = new Uint32Array(count);
    rings.forEach((ring, r) => rBlock.fill(blocks.indexOf(order[ring.i]), r * V, (r + 1) * V));
    const mesh = this._bodyMesh(g, blocks[0].type);
    return { mesh, blocks, tube: { order, rings, samples: last + 1 }, topo: { rBlock }, indices: [] };
  }

  /** A body's geometry, `n` vertices: positions and normals set when posed, the rest by _refreshLook. */
  _bodyGeometry(n) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('localPos', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); // each vertex's place on its own block (cm)
    g.setAttribute('faceIndex', new THREE.BufferAttribute(new Float32Array(n), 1));
    // smooth bodies: no corner darkening
    g.setAttribute('aoFaces', new THREE.BufferAttribute(new Float32Array(n * 4).fill(-1), 4));
    g.setAttribute('blockStyle', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('blockIndex', new THREE.BufferAttribute(new Float32Array(n), 1));
    return g;
  }

  /** The mesh drawing a body of `type`, with the matching body material, added to the scene. */
  _bodyMesh(g, type) {
    const isCloud = type === BLOCK.FOG || type === BLOCK.NIMBUS;
    const isCrystal = type === BLOCK.CRYSTAL;
    const isWater = isTranslucent(type) && !isCloud && !isCrystal;
    if (isCloud || isWater) addDepthPrePass(g); // (depth first, then colour: see createBlockMaterials' cloudDepth)
    const mesh = new THREE.Mesh(g, isCloud ? [this.materials.bodyCloudDepth, this.materials.bodyCloud] : isCrystal ? this.materials.bodyCrystal
      : isWater ? [this.materials.bodyTranslucentDepth, this.materials.bodyTranslucent] : this.materials.body);
    mesh.name = 'cluster-body';
    mesh.frustumCulled = false;
    mesh.raycast = () => { }; // picking uses the (hidden) blocks
    if (isTranslucent(type)) mesh.renderOrder = isCloud ? 1 : 2; // clouds first (they write depth), then Water / Crystal
    this.parent.add(mesh);
    return mesh;
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
    if (body.tube) return this._poseTube(world, body, now);
    const { smooth, ownerIdx, ownerCount, tris, rWeld, vertexCount } = body.topo;
    const offsets = body.offsets;
    const s = GRID.scale; // (rendered positions are in cm)
    body.blocks.forEach((block, i) => {
      world.renderedPosition(block, now, _p);
      offsets[i * 3] = _p.x - block.x * s;
      offsets[i * 3 + 1] = _p.y - block.y * s;
      offsets[i * 3 + 2] = _p.z - block.z * s;
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

  /**
   * Places a chain creature's tube (_createTube): the spine is sampled along a curve through
   * the segments' rendered centres (so it bends smoothly while they slide), each ring is set
   * round it on a twist-free frame (carried along from the head), and normals point straight
   * out from the spine (and round the end caps).
   */
  _poseTube(world, body, now) {
    const { order, rings, samples } = body.tube;
    const n = order.length, R = TUBE_RINGS_PER_SEGMENT, V = TUBE_SIDES;
    const centres = order.map((block) => world.renderedPosition(block, now, new THREE.Vector3()));
    // the spine: points and tangents (head -> tail)
    const P = [], T = [];
    if (n === 1) {
      P.push(centres[0]);
      T.push(new THREE.Vector3(0, 1, 0));
    } else {
      const curve = new THREE.CatmullRomCurve3(centres, false, 'centripetal');
      for (let s = 0; s < samples; s++) P.push(curve.getPoint(s / (samples - 1)));
      for (let s = 0; s < samples; s++) {
        const t = P[Math.min(s + 1, samples - 1)].clone().sub(P[Math.max(s - 1, 0)]);
        T.push(t.lengthSq() > 1e-12 ? t.normalize() : (T[s - 1]?.clone() ?? new THREE.Vector3(0, 1, 0)));
      }
    }
    // a frame (N, B) round each spine point, carried along without twisting (parallel transport)
    const N = [], B = [];
    const n0 = Math.abs(T[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    N.push(n0.sub(T[0].clone().multiplyScalar(n0.dot(T[0]))).normalize());
    for (let s = 1; s < samples; s++) {
      const prev = N[s - 1];
      const next = prev.clone().sub(T[s].clone().multiplyScalar(prev.dot(T[s])));
      N.push(next.lengthSq() > 1e-12 ? next.normalize() : prev.clone());
    }
    for (let s = 0; s < samples; s++) B.push(T[s].clone().cross(N[s]));
    const g = body.mesh.geometry;
    const pos = g.getAttribute('position').array, nor = g.getAttribute('normal').array, local = g.getAttribute('localPos').array;
    const r = TUBE_RADIUS_CM;
    rings.forEach((ring, k) => {
      const p = P[ring.s], t = T[ring.s], nn = N[ring.s], bb = B[ring.s], c = centres[ring.i];
      for (let j = 0; j < V; j++) {
        const a = (j / V) * Math.PI * 2, ca = Math.cos(a) * ring.rad, sa = Math.sin(a) * ring.rad;
        const nx = nn.x * ca + bb.x * sa + t.x * ring.axial;
        const ny = nn.y * ca + bb.y * sa + t.y * ring.axial;
        const nz = nn.z * ca + bb.z * sa + t.z * ring.axial;
        const o = (k * V + j) * 3;
        pos[o] = p.x + r * nx;
        pos[o + 1] = p.y + r * ny;
        pos[o + 2] = p.z + r * nz;
        nor[o] = nx;
        nor[o + 1] = ny;
        nor[o + 2] = nz;
        // its place on its own segment, for the per-block patterns
        local[o] = pos[o] - c.x;
        local[o + 1] = pos[o + 1] - c.y;
        local[o + 2] = pos[o + 2] - c.z;
      }
    });
    g.getAttribute('position').needsUpdate = g.getAttribute('normal').needsUpdate = g.getAttribute('localPos').needsUpdate = true;
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

