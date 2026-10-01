// One drawing pass's blocks. The World keeps a batch per pass (solid, clouds, Crystal, Water):
// each is an InstancedMesh holding only that pass's blocks, so no pass spends time on the
// others' (they used to share one instance list, and every pass ran its vertex shader over
// every block, throwing away the ones it didn't draw). A block's `batch` is the one it's in
// and its `index` its instance there.
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

/** Per-instance attributes a batch keeps, and their sizes (see World and the block shader). */
const INSTANCE_ATTRIBUTES = { blockStyle: 4, blockMerged: 1, blockSmooth: 1 };

export class BlockBatch {
  /**
   * `baseGeometry`: the block's shape and per-vertex data (shared by every batch);
   * `material`: this pass's material. `name` names the mesh; `renderOrder` places it among
   * the see-through passes.
   */
  constructor(parent, baseGeometry, material, name, { renderOrder = 0, initialCapacity = 256 } = {}) {
    this.parent = parent;
    this.baseGeometry = baseGeometry;
    this.material = material;
    this.name = name;
    this.renderOrder = renderOrder;
    this.blocks = []; // instance index -> block
    this.capacity = 0;
    this.mesh = null;
    this.geometry = null;
    this._allocate(initialCapacity);
  }

  get count() {
    return this.blocks.length;
  }

  /** (Re)builds the mesh and its instance buffers with room for `capacity` blocks, keeping the current ones. */
  _allocate(capacity) {
    const old = this.mesh, oldGeometry = this.geometry;
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(this.baseGeometry.attributes)) g.setAttribute(name, attr); // shared, uploaded once
    if (this.baseGeometry.index) g.setIndex(this.baseGeometry.index); // (the block's triangles: indexed, see createBlockGeometry)
    g.boundingSphere = this.baseGeometry.boundingSphere;
    g.boundingBox = this.baseGeometry.boundingBox;
    for (const [name, size] of Object.entries(INSTANCE_ATTRIBUTES)) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      if (oldGeometry) a.array.set(oldGeometry.getAttribute(name).array.subarray(0, this.blocks.length * size));
      g.setAttribute(name, a);
    }
    const mesh = new THREE.InstancedMesh(g, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, _c.set('#ffffff')); // make sure the colour buffer exists
    mesh.frustumCulled = false;
    mesh.name = this.name;
    mesh.renderOrder = this.renderOrder;
    mesh.userData.batch = this; // picking: hit.object -> batch, hit.instanceId -> block
    if (old) {
      for (let i = 0; i < this.blocks.length; i++) {
        old.getMatrixAt(i, _m);
        mesh.setMatrixAt(i, _m);
        old.getColorAt(i, _c);
        mesh.setColorAt(i, _c);
      }
      this.parent.remove(old);
      old.dispose();
      oldGeometry.dispose(); // (the shared attributes stay alive in the new geometry)
    }
    mesh.count = this.blocks.length;
    this.parent.add(mesh);
    this.mesh = mesh;
    this.geometry = g;
    this.capacity = capacity;
    this.dirty();
  }

  /** Adds `block` as the last instance (its data is written by the World); sets b.batch / b.index. */
  add(block) {
    if (this.blocks.length >= this.capacity) this._allocate(this.capacity * 2);
    block.batch = this;
    block.index = this.blocks.length;
    this.blocks.push(block);
    this.mesh.count = this.blocks.length;
  }

  /** Removes `block`: the last instance moves into its slot (all its instance data with it). */
  remove(block) {
    const last = this.blocks.length - 1;
    if (block.index !== last) {
      const lb = this.blocks[last];
      this.mesh.getMatrixAt(last, _m);
      this.mesh.setMatrixAt(block.index, _m);
      this.mesh.getColorAt(last, _c);
      this.mesh.setColorAt(block.index, _c);
      for (const [name, size] of Object.entries(INSTANCE_ATTRIBUTES)) {
        const arr = this.geometry.getAttribute(name).array;
        arr.copyWithin(block.index * size, last * size, last * size + size);
      }
      lb.index = block.index;
      this.blocks[block.index] = lb;
    }
    this.blocks.pop();
    this.mesh.count = this.blocks.length;
    delete block.batch;
  }

  clear() {
    this.blocks.length = 0;
    this.mesh.count = 0;
    this.dirty();
  }

  attr(name) {
    return this.geometry.getAttribute(name);
  }

  /** Marks the instance data for upload, and the bounds for recomputing (picking). */
  dirty() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    for (const name of Object.keys(INSTANCE_ATTRIBUTES)) this.geometry.getAttribute(name).needsUpdate = true;
    this.mesh.boundingSphere = null;
    this.mesh.boundingBox = null;
  }
}
