import * as THREE from 'three';
import { BLOCK, BLOCK_COLORS, RANDOM_BLOCKS } from './tools.js';
import { NEIGHBOR_DIRS, cellKey, isValidCell } from './lattice.js';
import { BLOCK_STYLE, FACE_DIRS, createBlockGeometry, createBlockMaterials } from './geometry.js';
import { CrawlyEyes, orientCrawly } from './crawly.js';

/** Block types drawn with a procedural surface shader instead of flat colour. */
const STYLE_BY_TYPE = {
  [BLOCK.DIRT]: BLOCK_STYLE.dirt,
  [BLOCK.STONE]: BLOCK_STYLE.stone,
  [BLOCK.WATER]: BLOCK_STYLE.water,
  [BLOCK.MOSS]: BLOCK_STYLE.moss,
  [BLOCK.BERRY]: BLOCK_STYLE.berry,
  [BLOCK.CRAWLY]: BLOCK_STYLE.crawly,
  [BLOCK.WOOD]: BLOCK_STYLE.wood,
};
/** Length of every per-turn animation (block slides, eye turns): half a turn, in seconds. */
export const STEP_SECONDS = 0.75;

/** Blocks added by "New" after the gray origin block, in order. */
export const NEW_SCENE_RECIPE = [
  [BLOCK.STONE, 400],
  [BLOCK.DIRT, 300],
  [BLOCK.MOSS, 200],
  [BLOCK.WOOD, 20],
  [BLOCK.WATER, 30],
  [BLOCK.CRAWLY, 10]
];
/** Larger = flatter distribution; smaller = tighter clump around the origin (cm). */
export const NEW_SCENE_FALLOFF_CM = 3;

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

/**
 * Stores the blocks and renders them with one InstancedMesh (used for raycasting), plus
 * a translucent water mesh that shares its instance buffers and draws only water blocks.
 * Coordinates are integer cm on the BCC lattice; the parent group scales cm -> m.
 */
export class World {
  constructor(parent) {
    this.parent = parent;
    this.geometry = createBlockGeometry();
    this.materials = createBlockMaterials();
    this.waterMesh = null;
    this.blocks = new Map(); // key -> { x, y, z, type, index }
    this.keysByIndex = [];
    this.anims = new Map(); // key -> { from, to, t0, dur } for sliding blocks
    this.crawlies = new Set(); // Crawly blocks (also carry .floor and .front, see crawly.js)
    this.eyes = new CrawlyEyes(parent);
    this.turn = 0; // current game turn, set by the engine; stamped on blocks as movedTurn
    this.capacity = 0;
    this.mesh = null;
    this._allocate(1024);
  }

  /** Re-derives a Crawly's floor/front; revolves its eyes if either changed. */
  _reorient(c, moveDir = null, durationS = STEP_SECONDS) {
    const { front, floor } = c;
    orientCrawly(this, c, moveDir);
    if (c.front !== front || c.floor !== floor) this.eyes.track(c, durationS);
  }

  /** Re-derives the floor of every Crawly next to cell (x, y, z). */
  _reorientAround(x, y, z) {
    if (!this.crawlies.size) return;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const n = this.blocks.get(cellKey(x + dx, y + dy, z + dz));
      if (n && n.type === BLOCK.CRAWLY) this._reorient(n);
    }
  }

  /** Snaps every Crawly's orientation and eyes into place with no animation. */
  _settleCrawlies() {
    for (const c of this.crawlies) {
      orientCrawly(this, c);
      this.eyes.track(c, 0);
    }
  }

  /**
   * Recomputes the water face mask (blockStyle.z) of the Water block at (x, y, z), if any,
   * and of every Water block next to it: bit i set = face i touches another Water block.
   */
  _refreshWaterAround(x, y, z) {
    const style = this.geometry.getAttribute('blockStyle');
    const update = (b) => {
      if (!b || b.type !== BLOCK.WATER) return;
      let mask = 0;
      FACE_DIRS.forEach(([dx, dy, dz], i) => {
        if (this.blocks.get(cellKey(b.x + dx, b.y + dy, b.z + dz))?.type === BLOCK.WATER) mask |= 1 << i;
      });
      style.setZ(b.index, mask);
    };
    update(this.blocks.get(cellKey(x, y, z)));
    for (const [dx, dy, dz] of FACE_DIRS) update(this.blocks.get(cellKey(x + dx, y + dy, z + dz)));
  }

  /**
   * Recomputes the ambient-occlusion neighbour mask (blockStyle.w) of the block at
   * (x, y, z), if any, and of every block next to it: bit i set = the neighbour across
   * face i holds a block that occludes (anything but Water, which is see-through).
   */
  _refreshAOAround(x, y, z) {
    const style = this.geometry.getAttribute('blockStyle');
    const update = (b) => {
      if (!b) return;
      let mask = 0;
      FACE_DIRS.forEach(([dx, dy, dz], i) => {
        const n = this.blocks.get(cellKey(b.x + dx, b.y + dy, b.z + dz));
        if (n && n.type !== BLOCK.WATER) mask |= 1 << i;
      });
      style.setW(b.index, mask);
    };
    update(this.blocks.get(cellKey(x, y, z)));
    for (const [dx, dy, dz] of FACE_DIRS) update(this.blocks.get(cellKey(x + dx, y + dy, z + dz)));
  }

  /** Where block `b` is drawn right now (mid-slide while it is moving), in cm. */
  renderedPosition(b, now, out) {
    const a = this.anims.get(cellKey(b.x, b.y, b.z));
    if (!a) return out.set(b.x, b.y, b.z);
    const t = Math.min(1, (now - a.t0) / a.dur);
    return out.lerpVectors(a.from, a.to, t * t * (3 - 2 * t)); // smoothstep ease in/out
  }

  _allocate(capacity) {
    const old = this.mesh;
    const mesh = new THREE.InstancedMesh(this.geometry, this.materials.opaque, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = 'blocks';
    // make sure the colour buffer exists
    mesh.setColorAt(0, _c.set('#ffffff'));
    // per-instance (style, seed, water face mask, AO neighbour mask) for the block shader; lives on the shared geometry
    const oldStyle = this.geometry.getAttribute('blockStyle');
    const style = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    style.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('blockStyle', style);
    if (old) {
      for (let i = 0; i < old.count; i++) {
        old.getMatrixAt(i, _m);
        mesh.setMatrixAt(i, _m);
        old.getColorAt(i, _c);
        mesh.setColorAt(i, _c);
        style.setXYZW(i, oldStyle.getX(i), oldStyle.getY(i), oldStyle.getZ(i), oldStyle.getW(i));
      }
      mesh.count = old.count;
      this.parent.remove(old);
      old.dispose();
    }
    if (this.waterMesh) {
      this.parent.remove(this.waterMesh);
      this.waterMesh.dispose();
    }
    // same instances, translucent water material; raycasts go through `mesh` only
    const water = new THREE.InstancedMesh(this.geometry, this.materials.water, capacity);
    water.instanceMatrix = mesh.instanceMatrix;
    water.instanceColor = mesh.instanceColor;
    water.frustumCulled = false;
    water.name = 'water-blocks';
    water.raycast = () => { };
    this.parent.add(mesh);
    this.parent.add(water);
    this.mesh = mesh;
    this.waterMesh = water;
    this.capacity = capacity;
    this._dirty();
  }

  _dirty() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.geometry.getAttribute('blockStyle').needsUpdate = true;
    this.waterMesh.count = this.mesh.count;
    this.mesh.boundingSphere = null;
    this.mesh.boundingBox = null;
  }

  get size() {
    return this.blocks.size;
  }

  has(x, y, z) {
    return this.blocks.has(cellKey(x, y, z));
  }

  get(x, y, z) {
    return this.blocks.get(cellKey(x, y, z));
  }

  /** Draw this block 50 % see-through (dithered); pass null to clear. */
  setDithered(block) {
    this.materials.uniforms.uDitherIndex.value = block ? block.index : -1;
  }

  blockAtIndex(i) {
    const k = this.keysByIndex[i];
    return k ? this.blocks.get(k) : undefined;
  }

  add(x, y, z, type) {
    if (!isValidCell(x, y, z) || !BLOCK_COLORS[type]) return false;
    const k = cellKey(x, y, z);
    if (this.blocks.has(k)) return false;
    if (this.blocks.size >= this.capacity) this._allocate(this.capacity * 2);
    const index = this.blocks.size;
    const b = { x, y, z, type, index };
    this.blocks.set(k, b);
    this.keysByIndex[index] = k;
    _m.makeTranslation(x, y, z);
    this.mesh.setMatrixAt(index, _m);
    this.mesh.setColorAt(index, _c.set(BLOCK_COLORS[type]));
    this.geometry.getAttribute('blockStyle').setXYZW(index, STYLE_BY_TYPE[type] ?? BLOCK_STYLE.plain, Math.random() * 40, 0, 0);
    if (type === BLOCK.WATER) this._refreshWaterAround(x, y, z);
    this._refreshAOAround(x, y, z);
    this.mesh.count = this.blocks.size;
    this._dirty();
    if (type === BLOCK.CRAWLY) {
      this.crawlies.add(b);
      orientCrawly(this, b);
      this.eyes.track(b, 0);
    }
    this._reorientAround(x, y, z);
    return true;
  }

  remove(x, y, z) {
    const k = cellKey(x, y, z);
    const b = this.blocks.get(k);
    if (!b) return false;
    const last = this.blocks.size - 1;
    if (b.index !== last) {
      // move the last instance into the freed slot
      const lastKey = this.keysByIndex[last];
      const lb = this.blocks.get(lastKey);
      this.mesh.getMatrixAt(last, _m);
      this.mesh.setMatrixAt(b.index, _m);
      this.mesh.getColorAt(last, _c);
      this.mesh.setColorAt(b.index, _c);
      const style = this.geometry.getAttribute('blockStyle');
      style.setXYZW(b.index, style.getX(last), style.getY(last), style.getZ(last), style.getW(last));
      lb.index = b.index;
      this.keysByIndex[b.index] = lastKey;
    }
    this.keysByIndex.length = last;
    this.blocks.delete(k);
    this.anims.delete(k);
    this.crawlies.delete(b);
    this.eyes.untrack(b);
    this.mesh.count = this.blocks.size;
    if (b.type === BLOCK.WATER) this._refreshWaterAround(x, y, z);
    this._refreshAOAround(x, y, z);
    this._dirty();
    this._reorientAround(x, y, z);
    return true;
  }

  /**
   * Changes a block's type in place (same cell, index and pattern seed), updating its
   * colour, shader style, Crawly tracking, water face masks and neighbouring Crawly floors.
   */
  setType(b, type) {
    if (!BLOCK_COLORS[type] || b.type === type || this.blocks.get(cellKey(b.x, b.y, b.z)) !== b) return false;
    const old = b.type;
    b.type = type;
    this.mesh.setColorAt(b.index, _c.set(BLOCK_COLORS[type]));
    const style = this.geometry.getAttribute('blockStyle');
    style.setX(b.index, STYLE_BY_TYPE[type] ?? BLOCK_STYLE.plain);
    style.setZ(b.index, 0);
    if (old === BLOCK.CRAWLY) {
      this.crawlies.delete(b);
      this.eyes.untrack(b);
    } else if (type === BLOCK.CRAWLY) {
      this.crawlies.add(b);
      orientCrawly(this, b);
      this.eyes.track(b, 0);
    }
    if (old === BLOCK.WATER || type === BLOCK.WATER) {
      this._refreshWaterAround(b.x, b.y, b.z);
      this._refreshAOAround(b.x, b.y, b.z); // Water doesn't occlude, other blocks do
    }
    this._dirty();
    this._reorientAround(b.x, b.y, b.z);
    return true;
  }

  /**
   * Moves a block to an empty neighbouring cell. The data moves immediately; the
   * rendered block slides there over `durationS` seconds (see updateAnimations).
   * `turnCrawly: false` keeps a Crawly's front unchanged (it was carried, not walking).
   */
  move(from, to, durationS = STEP_SECONDS, { turnCrawly = true } = {}) {
    const k = cellKey(from.x, from.y, from.z);
    const b = this.blocks.get(k);
    const tk = cellKey(to.x, to.y, to.z);
    if (!b || this.blocks.has(tk) || !isValidCell(to.x, to.y, to.z)) return false;
    this.blocks.delete(k);
    const fromPos = new THREE.Vector3(b.x, b.y, b.z);
    b.x = to.x;
    b.y = to.y;
    b.z = to.z;
    this.blocks.set(tk, b);
    this.keysByIndex[b.index] = tk;
    b.movedTurn = this.turn; // lets rules tell settled blocks from moving ones
    this.anims.set(tk, { from: fromPos, to: new THREE.Vector3(to.x, to.y, to.z), t0: performance.now(), dur: durationS * 1000 });
    // a Crawly now faces the way it moved (unless it was carried, e.g. by a falling group);
    // its old and new neighbours may change floors
    if (b.type === BLOCK.CRAWLY) {
      this._reorient(b, turnCrawly ? [to.x - fromPos.x, to.y - fromPos.y, to.z - fromPos.z] : null, durationS);
    }
    this._reorientAround(fromPos.x, fromPos.y, fromPos.z);
    this._reorientAround(to.x, to.y, to.z);
    if (b.type === BLOCK.WATER) {
      this._refreshWaterAround(fromPos.x, fromPos.y, fromPos.z);
      this._refreshWaterAround(to.x, to.y, to.z);
    }
    this._refreshAOAround(fromPos.x, fromPos.y, fromPos.z);
    this._refreshAOAround(to.x, to.y, to.z);
    this._dirty();
    return true;
  }

  /** Advances sliding blocks, Crawly eyes and the water animation; call once per frame. */
  updateAnimations(now = performance.now()) {
    this.materials.uniforms.uTime.value = now / 1000;
    const p = new THREE.Vector3();
    this.eyes.update(now, (c, out) => this.renderedPosition(c, now, out));
    if (!this.anims.size) return;
    for (const [k, a] of this.anims) {
      const b = this.blocks.get(k);
      if (!b) {
        this.anims.delete(k);
        continue;
      }
      this.renderedPosition(b, now, p);
      this.mesh.setMatrixAt(b.index, _m.makeTranslation(p.x, p.y, p.z));
      if (now - a.t0 >= a.dur) this.anims.delete(k);
    }
    this._dirty();
  }

  clear() {
    this.crawlies.clear();
    this.eyes.clear();
    this.anims.clear();
    this.blocks.clear();
    this.keysByIndex.length = 0;
    this.mesh.count = 0;
    this._dirty();
  }

  /** All empty cells adjacent to at least one block. */
  emptyNeighbors() {
    const out = new Map();
    for (const b of this.blocks.values()) {
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const x = b.x + dx, y = b.y + dy, z = b.z + dz;
        const k = cellKey(x, y, z);
        if (!this.blocks.has(k) && !out.has(k)) out.set(k, [x, y, z]);
      }
    }
    return [...out.values()];
  }

  /**
   * Adds a block of `type` in a random empty cell next to an existing block.
   * Candidates are weighted by exp(-distance / falloffCm), so cells closer to the
   * origin are more likely (a cell 3 cm nearer is ~2.7x as likely with the default).
   */
  addRandomAdjacent(type, falloffCm = NEW_SCENE_FALLOFF_CM) {
    const cands = this.emptyNeighbors();
    if (!cands.length) return false;
    const weights = cands.map(([x, y, z]) => Math.exp(-Math.hypot(x, y, z) / falloffCm));
    let r = Math.random() * weights.reduce((a, w) => a + w, 0);
    let i = 0;
    while (i < cands.length - 1 && (r -= weights[i]) > 0) i++;
    const [x, y, z] = cands[i];
    return this.add(x, y, z, type);
  }

  /** "New" scene: gray at origin, then 50 gray, 30 brown, 15 green and 10 random-colour blocks. */
  generateNew() {
    this.clear();
    this.add(0, 0, 0, BLOCK.STONE);
    for (const [type, count] of NEW_SCENE_RECIPE) {
      for (let i = 0; i < count; i++) {
        const t = type === 'random' ? RANDOM_BLOCKS[Math.floor(Math.random() * RANDOM_BLOCKS.length)] : type;
        this.addRandomAdjacent(t);
      }
    }
    this._settleCrawlies();
  }

  toJSON() {
    return {
      format: 'grid-game-save',
      version: 1,
      units: 'cm',
      savedAt: new Date().toISOString(),
      blocks: [...this.blocks.values()].map(({ x, y, z, type, front }) =>
        (type === BLOCK.CRAWLY && front ? { x, y, z, type, front } : { x, y, z, type })),
    };
  }

  /** Clears the scene and loads blocks. Returns { loaded, skipped }. */
  fromJSON(data) {
    const list = Array.isArray(data) ? data : data?.blocks;
    if (!Array.isArray(list)) throw new Error('Save file has no "blocks" array');
    this.clear();
    let loaded = 0, skipped = 0;
    for (const b of list) {
      const x = Number(b.x), y = Number(b.y), z = Number(b.z);
      const type = b.type ?? b.color;
      if (this.add(x, y, z, type)) {
        loaded++;
        // restore which way a Crawly was facing (its floor is re-derived below)
        const dir = Array.isArray(b.front) && b.front.map(Number);
        if (type === BLOCK.CRAWLY && dir && NEIGHBOR_DIRS.some((d) => d.every((v, i) => v === dir[i]))) {
          this.get(x, y, z).front = dir;
        }
      } else skipped++;
    }
    this._settleCrawlies();
    return { loaded, skipped };
  }
}
