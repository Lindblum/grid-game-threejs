import * as THREE from 'three';
import { BLOCK_COLORS, RANDOM_COLORS } from './tools.js';
import { NEIGHBOR_DIRS, cellKey, isValidCell } from './lattice.js';
import { createBlockGeometry, createBlockMaterial } from './geometry.js';

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

/**
 * Stores the blocks and renders them with a single InstancedMesh.
 * Coordinates are integer cm on the BCC lattice; the parent group scales cm -> m.
 */
export class World {
  constructor(parent) {
    this.parent = parent;
    this.geometry = createBlockGeometry();
    this.material = createBlockMaterial();
    this.blocks = new Map(); // key -> { x, y, z, type, index }
    this.keysByIndex = [];
    this.capacity = 0;
    this.mesh = null;
    this._allocate(1024);
  }

  _allocate(capacity) {
    const old = this.mesh;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = 'blocks';
    // make sure the colour buffer exists
    mesh.setColorAt(0, _c.set('#ffffff'));
    if (old) {
      for (let i = 0; i < old.count; i++) {
        old.getMatrixAt(i, _m);
        mesh.setMatrixAt(i, _m);
        old.getColorAt(i, _c);
        mesh.setColorAt(i, _c);
      }
      mesh.count = old.count;
      this.parent.remove(old);
      old.dispose();
    }
    this.parent.add(mesh);
    this.mesh = mesh;
    this.capacity = capacity;
    this._dirty();
  }

  _dirty() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
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
    this.blocks.set(k, { x, y, z, type, index });
    this.keysByIndex[index] = k;
    _m.makeTranslation(x, y, z);
    this.mesh.setMatrixAt(index, _m);
    this.mesh.setColorAt(index, _c.set(BLOCK_COLORS[type]));
    this.mesh.count = this.blocks.size;
    this._dirty();
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
      lb.index = b.index;
      this.keysByIndex[b.index] = lastKey;
    }
    this.keysByIndex.length = last;
    this.blocks.delete(k);
    this.mesh.count = this.blocks.size;
    this._dirty();
    return true;
  }

  clear() {
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

  addRandomAdjacent(type) {
    const cands = this.emptyNeighbors();
    if (!cands.length) return false;
    const [x, y, z] = cands[Math.floor(Math.random() * cands.length)];
    return this.add(x, y, z, type);
  }

  /** "New" scene: gray at origin, 20 random gray neighbours, 10 random coloured neighbours. */
  generateNew() {
    this.clear();
    this.add(0, 0, 0, 'gray');
    for (let i = 0; i < 20; i++) this.addRandomAdjacent('gray');
    for (let i = 0; i < 10; i++) {
      this.addRandomAdjacent(RANDOM_COLORS[Math.floor(Math.random() * RANDOM_COLORS.length)]);
    }
  }

  toJSON() {
    return {
      format: 'grid-game-save',
      version: 1,
      units: 'cm',
      savedAt: new Date().toISOString(),
      blocks: [...this.blocks.values()].map(({ x, y, z, type }) => ({ x, y, z, type })),
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
      if (this.add(x, y, z, type)) loaded++;
      else skipped++;
    }
    return { loaded, skipped };
  }
}
