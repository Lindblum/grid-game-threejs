// Options → Rendering: Smooth: every BlockBundle is drawn as one merged mesh, built from
// the bundle's outer faces (faces between two of its own blocks are left out), welded into
// one surface, smoothed so its edges round off, and shaded with smooth normals. Bundles are
// World.bundleOf's: connected blocks of one type, a Squirmy's chain, a Crawly or Buzzy on
// its own. The blocks stay in the World (raycasting, rules); the block shader skips the ones
// flagged in the `blockMerged` instance attribute (uniforms.uSmoothRendering), and these meshes are
// drawn instead. Blocks growing in or shrinking away (appear / vanish) aren't merged, so
// their animations still play on the instanced mesh.
import * as THREE from 'three';
import { cellKey } from './lattice.js';
import { FACE_DIRS, truncatedOctahedronFaces } from './geometry.js';
import { blockProps, isCreature, isTranslucent } from './blocks.js';

const FACES = truncatedOctahedronFaces();
/** Taubin smoothing (shrink, then inflate) passes over a welded body: rounds its edges off. */
const SMOOTH_PASSES = 4;
const SMOOTH_LAMBDA = 0.5;
const SMOOTH_MU = -0.53;

const _c = new THREE.Color();
const _p = new THREE.Vector3();

/**
 * Topology of a bundle's body from its blocks' cells: welded vertices (cell space, then
 * smoothed), the blocks each one moves with (`owners`, indices into `blocks`), triangles over
 * the welded vertices (for normals), and the render vertices: every outer face fanned from
 * its centre (3 per edge), each knowing its block, face, block-local position and welded
 * vertex. `flat` (shadeFlat types): no smoothing, the faces stay flat.
 */
function buildBody(blocks, flat = false) {
  const at = new Map(blocks.map((b, i) => [cellKey(b.x, b.y, b.z), i]));
  const rest = []; // welded x, y, z
  const owners = []; // per welded vertex: block indices it moves with
  const weld = new Map(); // position key -> welded vertex
  const tris = []; // welded triangles
  const rBlock = [], rFace = [], rLocal = [], rWeld = []; // per render vertex
  const vertex = (b, i, v, welded) => {
    const x = b.x + v.x, y = b.y + v.y, z = b.z + v.z;
    const k = welded ? `${x},${y},${z}` : null;
    let w = k ? weld.get(k) : undefined;
    if (w === undefined) {
      w = rest.length / 3;
      rest.push(x, y, z);
      owners.push([]);
      if (k) weld.set(k, w);
    }
    if (!owners[w].includes(i)) owners[w].push(i);
    return w;
  };
  blocks.forEach((b, i) => {
    FACES.forEach((f, fi) => {
      const [dx, dy, dz] = FACE_DIRS[fi];
      if (at.has(cellKey(b.x + dx, b.y + dy, b.z + dz))) return; // inside the body
      const ring = f.verts.map((v) => vertex(b, i, v, true));
      const centre = vertex(b, i, f.center, false);
      for (let k = 0; k < ring.length; k++) {
        const k2 = (k + 1) % ring.length;
        tris.push(centre, ring[k], ring[k2]);
        for (const [w, v] of [[centre, f.center], [ring[k], f.verts[k]], [ring[k2], f.verts[k2]]]) {
          rBlock.push(i);
          rFace.push(fi);
          rLocal.push(v.x, v.y, v.z);
          rWeld.push(w);
        }
      }
    });
  });
  // Taubin smoothing: alternately pull each vertex toward its neighbours' average (λ) and
  // push it back out (μ), which rounds the edges without shrinking the body much
  const n = owners.length;
  const nbrs = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    nbrs[a].add(b).add(c);
    nbrs[b].add(a).add(c);
    nbrs[c].add(a).add(b);
  }
  let pos = Float32Array.from(rest);
  for (let pass = 0; pass < (flat ? 0 : SMOOTH_PASSES * 2); pass++) {
    const f = pass % 2 ? SMOOTH_MU : SMOOTH_LAMBDA;
    const next = new Float32Array(pos.length);
    for (let v = 0; v < n; v++) {
      let ax = 0, ay = 0, az = 0;
      for (const u of nbrs[v]) {
        ax += pos[u * 3];
        ay += pos[u * 3 + 1];
        az += pos[u * 3 + 2];
      }
      const m = nbrs[v].size || 1;
      next[v * 3] = pos[v * 3] + f * (ax / m - pos[v * 3]);
      next[v * 3 + 1] = pos[v * 3 + 1] + f * (ay / m - pos[v * 3 + 1]);
      next[v * 3 + 2] = pos[v * 3 + 2] + f * (az / m - pos[v * 3 + 2]);
    }
    pos = next;
  }
  return { smooth: pos, owners, tris: Uint32Array.from(tris), rBlock, rFace, rLocal, rWeld: Uint32Array.from(rWeld) };
}

/** The BlockBundles to draw: World.bundleOf's groups, over the blocks that aren't animating in / out. */
function bundlesOf(world) {
  const skip = (b) => b.vanishing || world.vanishing.has(b) || world.appearing.has(b);
  const done = new Set();
  const out = [];
  for (const b of world.blocks.values()) {
    if (done.has(b) || skip(b)) continue;
    const blocks = world.bundleOf(b).filter((x) => !skip(x) && !done.has(x));
    for (const x of blocks) done.add(x);
    if (blocks.length) out.push(blocks);
  }
  return out;
}

export class BundleBodies {
  /** `materials`: the block materials (`body`, `bodyTranslucent`: MERGED_BODY). */
  constructor(parent, materials) {
    this.parent = parent;
    this.materials = materials;
    this.enabled = false;
    this.bodies = new Map(); // topology key (type + the blocks' cells) -> body
    this._revision = -1; // world.revision the bodies were built for
  }

  setEnabled(on) {
    this.enabled = on;
    this._revision = -1;
    if (!on) this.clear();
  }

  clear() {
    for (const body of this.bodies.values()) this._dispose(body);
    this.bodies.clear();
  }

  _dispose(body) {
    this.parent.remove(body.mesh);
    body.mesh.geometry.dispose();
  }

  /** Call once per frame: rebuilds bodies whose blocks changed, and moves the ones sliding. */
  update(world, now) {
    if (!this.enabled) return;
    if (world.revision !== this._revision) this._rebuild(world);
    // bodies with a sliding block follow it (and settle once it has arrived)
    for (const k of world.anims.keys()) {
      const body = this._byBlock.get(world.blocks.get(k));
      if (body) body.moving = true;
    }
    for (const body of this.bodies.values()) {
      if (!body.moving) continue;
      body.moving = body.blocks.some((b) => world.anims.has(cellKey(b.x, b.y, b.z)));
      this._pose(world, body, now);
    }
  }

  _rebuild(world) {
    this._revision = world.revision;
    const seen = new Set();
    this._byBlock = new Map();
    const merged = world.geometry.getAttribute('blockMerged');
    merged.array.fill(0);
    for (const blocks of bundlesOf(world)) {
      const key = `${blocks[0].type}:${blocks.map((b) => cellKey(b.x, b.y, b.z)).sort().join('|')}`;
      seen.add(key);
      let body = this.bodies.get(key);
      const members = new Set(blocks);
      if (!body || body.blocks.some((b) => !members.has(b))) { // same cells, but new blocks
        if (body) this._dispose(body);
        body = this._create(blocks);
        this.bodies.set(key, body);
        this._refreshLook(world, body);
        body.moving = true; // placed on the next pose
      } else if (isCreature(blocks[0].type) || body.blocks.some((b, i) => b.index !== body.indices[i])) {
        this._refreshLook(world, body); // buff colours, or blocks renumbered by a removal
      }
      for (const b of body.blocks) {
        this._byBlock.set(b, body);
        merged.array[b.index] = 1;
      }
    }
    merged.needsUpdate = true;
    for (const [key, body] of this.bodies) {
      if (seen.has(key)) continue;
      this._dispose(body);
      this.bodies.delete(key);
    }
  }

  _create(blocks) {
    const flat = !!blockProps(blocks[0].type).shadeFlat;
    const topo = buildBody(blocks, flat);
    const n = topo.rWeld.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('localPos', new THREE.BufferAttribute(Float32Array.from(topo.rLocal), 3));
    g.setAttribute('faceIndex', new THREE.BufferAttribute(Float32Array.from(topo.rFace), 1));
    // smooth bodies: no face outlines, no corner darkening
    g.setAttribute('edgeDist', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
    g.setAttribute('aoFaces', new THREE.BufferAttribute(new Float32Array(n * 3).fill(-1), 3));
    g.setAttribute('blockStyle', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('blockIndex', new THREE.BufferAttribute(new Float32Array(n), 1));
    const type = blocks[0].type;
    const mesh = new THREE.Mesh(g, isTranslucent(type) ? this.materials.bodyTranslucent : this.materials.body);
    mesh.name = 'bundle-body';
    mesh.frustumCulled = false;
    mesh.raycast = () => { }; // picking uses the (hidden) blocks
    if (isTranslucent(type)) mesh.renderOrder = 1; // after the opaque bodies
    this.parent.add(mesh);
    return { mesh, blocks, topo, flat, indices: [], normals: new Float32Array(topo.owners.length * 3), welded: new Float32Array(topo.owners.length * 3) };
  }

  /** Copies each block's colour, style (seed, buff tint) and instance index to its vertices. */
  _refreshLook(world, body) {
    const g = body.mesh.geometry;
    const style = g.getAttribute('blockStyle'), color = g.getAttribute('color'), index = g.getAttribute('blockIndex');
    const src = world.geometry.getAttribute('blockStyle');
    const perBlock = body.blocks.map((b) => {
      world.mesh.getColorAt(b.index, _c);
      return [src.getX(b.index), src.getY(b.index), src.getZ(b.index), src.getW(b.index), _c.r, _c.g, _c.b, b.index];
    });
    body.topo.rBlock.forEach((bi, v) => {
      const s = perBlock[bi];
      style.array.set([s[0], s[1], isTranslucent(body.blocks[bi].type) ? 0 : s[2], s[3]], v * 4);
      color.array.set([s[4], s[5], s[6]], v * 3);
      index.array[v] = s[7];
    });
    style.needsUpdate = color.needsUpdate = index.needsUpdate = true;
    body.indices = body.blocks.map((b) => b.index);
  }

  /**
   * Places the body: each welded vertex moves by the average slide of the blocks it belongs
   * to (so a moving bundle stretches and bends instead of jumping), then smooth normals are
   * computed on the welded surface and copied to the render vertices.
   */
  _pose(world, body, now) {
    const { smooth, owners, tris, rWeld } = body.topo;
    const offsets = body.blocks.map((b) => {
      world.renderedPosition(b, now, _p);
      return [_p.x - b.x, _p.y - b.y, _p.z - b.z];
    });
    const W = body.welded, N = body.normals;
    owners.forEach((own, v) => {
      let ox = 0, oy = 0, oz = 0;
      for (const i of own) {
        ox += offsets[i][0];
        oy += offsets[i][1];
        oz += offsets[i][2];
      }
      const m = own.length;
      W[v * 3] = smooth[v * 3] + ox / m;
      W[v * 3 + 1] = smooth[v * 3 + 1] + oy / m;
      W[v * 3 + 2] = smooth[v * 3 + 2] + oz / m;
    });
    if (body.flat) return this._placeFlat(body, W);
    // area-weighted vertex normals over the welded triangles
    N.fill(0);
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const ux = W[b] - W[a], uy = W[b + 1] - W[a + 1], uz = W[b + 2] - W[a + 2];
      const vx = W[c] - W[a], vy = W[c + 1] - W[a + 1], vz = W[c + 2] - W[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) {
        N[i] += nx;
        N[i + 1] += ny;
        N[i + 2] += nz;
      }
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

