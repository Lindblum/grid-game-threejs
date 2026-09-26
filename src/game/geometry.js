import * as THREE from 'three';

/**
 * Regular truncated octahedron whose square faces have an inscribed radius of 1
 * (i.e. square faces lie on the planes x,y,z = ±1). Hexagon faces lie on
 * |x|+|y|+|z| = 1.5 (distance √3/2 from the centre). Units: cm.
 * Vertices are all permutations of (0, ±½, ±1).
 */

function buildVertices() {
  const out = [];
  const seen = new Set();
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const a of [-0.5, 0.5]) {
    for (const b of [-1, 1]) {
      const base = [0, a, b];
      for (const p of perms) {
        const v = [base[p[0]], base[p[1]], base[p[2]]];
        const k = v.join(',');
        if (!seen.has(k)) {
          seen.add(k);
          out.push(new THREE.Vector3(...v));
        }
      }
    }
  }
  return out; // 24 vertices
}

/** Returns the 14 faces: { type, normal, verts: Vector3[] (CCW seen from outside), inradius } */
export function truncatedOctahedronFaces() {
  const V = buildVertices();
  const faces = [];
  const addFace = (type, normal, planeDist) => {
    const verts = V.filter((v) => Math.abs(v.dot(normal) - planeDist) < 1e-6);
    const c = verts.reduce((acc, v) => acc.add(v), new THREE.Vector3()).multiplyScalar(1 / verts.length);
    // basis (u, w, n) right-handed -> ascending angle is CCW seen from outside
    const u = verts[0].clone().sub(c).normalize();
    const w = new THREE.Vector3().crossVectors(normal, u);
    verts.sort((p, q) => {
      const dp = p.clone().sub(c), dq = q.clone().sub(c);
      return Math.atan2(dp.dot(w), dp.dot(u)) - Math.atan2(dq.dot(w), dq.dot(u));
    });
    // distance from face centre to an edge
    const mid = verts[0].clone().add(verts[1]).multiplyScalar(0.5);
    faces.push({ type, normal: normal.clone(), verts, center: c, inradius: mid.distanceTo(c) });
  };
  for (let axis = 0; axis < 3; axis++) {
    for (const s of [1, -1]) {
      const n = new THREE.Vector3();
      n.setComponent(axis, s);
      addFace('square', n, 1);
    }
  }
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const n = new THREE.Vector3(x, y, z).normalize();
    addFace('hexagon', n, 1.5 / Math.sqrt(3));
  }
  return faces;
}

/**
 * Flat-shaded BufferGeometry. Each face is fanned from its centre so we can store,
 * per vertex, the distance to the face's outer edge ("edgeDist") — used by the
 * block shader to draw crisp dark outlines on every face.
 */
export function createBlockGeometry() {
  const faces = truncatedOctahedronFaces();
  const pos = [], nor = [], edge = [];
  for (const f of faces) {
    const n = f.normal;
    for (let i = 0; i < f.verts.length; i++) {
      const a = f.verts[i], b = f.verts[(i + 1) % f.verts.length];
      for (const [p, e] of [[f.center, f.inradius], [a, 0], [b, 0]]) {
        pos.push(p.x, p.y, p.z);
        nor.push(n.x, n.y, n.z);
        edge.push(e);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('edgeDist', new THREE.Float32BufferAttribute(edge, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** Line segments along the 36 edges of the truncated octahedron. */
export function createEdgesGeometry() {
  const faces = truncatedOctahedronFaces();
  const seen = new Set();
  const pts = [];
  for (const f of faces) {
    for (let i = 0; i < f.verts.length; i++) {
      const a = f.verts[i], b = f.verts[(i + 1) % f.verts.length];
      const k = [a, b].map((v) => v.toArray().map((x) => x.toFixed(3)).join(',')).sort().join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** MeshStandardMaterial with per-instance colour and dark face outlines. */
export function createBlockMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float edgeDist;\nvarying float vEdgeDist;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdgeDist = edgeDist;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vEdgeDist;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float fw = max(fwidth(vEdgeDist), 1e-4);
        float edgeW = 0.045;
        float edgeMix = smoothstep(edgeW - fw, edgeW + fw, vEdgeDist);
        diffuseColor.rgb *= mix(0.45, 1.0, edgeMix);`
      );
  };
  mat.customProgramCacheKey = () => 'grid-block-outline';
  return mat;
}
