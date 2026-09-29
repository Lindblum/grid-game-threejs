import * as THREE from 'three';
import { BLOCK_STYLE, BLOCK_TYPES } from './blocks.js';
import { PERLIN_PERIOD, VORONOI_BORDER_MAX, VORONOI_PERIOD, createNoiseTexture } from './noiseTexture.js';

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
 * Lattice offset to the neighbouring cell across each face, in the face order of
 * truncatedOctahedronFaces() (= the `faceIndex` vertex attribute).
 */
export const FACE_DIRS = truncatedOctahedronFaces().map(({ type, normal: n }) =>
  type === 'square' ? [Math.round(n.x) * 2, Math.round(n.y) * 2, Math.round(n.z) * 2] : [Math.sign(n.x), Math.sign(n.y), Math.sign(n.z)]
);

/**
 * For a corner of the block (a vertex of the truncated octahedron), the FACE_DIRS indices
 * of the 3 neighbouring cells that share it (4 cells meet at every vertex of this
 * honeycomb). Used for ambient occlusion: the more of them are filled, the darker the corner.
 */
function cornerNeighbours(v, verts) {
  const out = [];
  FACE_DIRS.forEach(([dx, dy, dz], i) => {
    // the neighbour's own copy of the shape contains v if v - d is one of our vertices
    if (verts.some((u) => Math.abs(u.x - (v.x - dx)) + Math.abs(u.y - (v.y - dy)) + Math.abs(u.z - (v.z - dz)) < 1e-6)) out.push(i);
  });
  return out;
}

/**
 * Flat-shaded BufferGeometry. Each face is fanned from its centre so we can store,
 * per vertex, the distance to the face's outer edge ("edgeDist") — used by the
 * block shader to draw crisp dark outlines on every face — which face it belongs to
 * ("faceIndex", see FACE_DIRS), and for corners the 3 neighbours sharing that corner
 * ("aoFaces", FACE_DIRS indices; -1 for face centres) for ambient occlusion.
 */
export function createBlockGeometry() {
  const faces = truncatedOctahedronFaces();
  const allVerts = faces.flatMap((f) => f.verts);
  const pos = [], nor = [], edge = [], face = [], ao = [];
  faces.forEach((f, fi) => {
    const n = f.normal;
    for (let i = 0; i < f.verts.length; i++) {
      const a = f.verts[i], b = f.verts[(i + 1) % f.verts.length];
      for (const [p, e, corner] of [[f.center, f.inradius, false], [a, 0, true], [b, 0, true]]) {
        pos.push(p.x, p.y, p.z);
        nor.push(n.x, n.y, n.z);
        edge.push(e);
        face.push(fi);
        const cn = corner ? cornerNeighbours(p, allVerts) : [];
        ao.push(cn[0] ?? -1, cn[1] ?? -1, cn[2] ?? -1);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('edgeDist', new THREE.Float32BufferAttribute(edge, 1));
  g.setAttribute('faceIndex', new THREE.Float32BufferAttribute(face, 1));
  g.setAttribute('aoFaces', new THREE.Float32BufferAttribute(ao, 3));
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

/** Face outlines are drawn at this fraction of the face colour (block shader + place highlight). */
export const EDGE_SHADE = 0.725;
/** Width of those face outlines, in cm (each face's dark band along its edges). */
export const EDGE_WIDTH_CM = 0.045;
/** Ambient occlusion: a corner with all 3 sharing neighbours filled is darkened by this much. */
export const AO_STRENGTH = 0.45;

export { BLOCK_STYLE }; // defined in blocks.js, with the rest of the block properties
/** See-through block types (opacity below 1): their styles are drawn by the translucent pass. */
const TRANSLUCENT = BLOCK_TYPES.filter((t) => t.opacity < 1);
/** Styles drawn by the translucent pass (the rest are opaque). */
export const TRANSLUCENT_STYLES = TRANSLUCENT.map((t) => t.style);

// Noise lookups from the pre-baked 3D texture (see noiseTexture.js): one texture fetch
// each instead of evaluating Perlin (8 gradient hashes) or Voronoi (27 cells) per pixel.
const NOISE_GLSL = `
uniform highp sampler3D uNoiseTex;
// 3D Perlin noise, ~[-1, 1]; one lattice cell per unit of p
float perlin3(vec3 p) {
  return texture(uNoiseTex, p * ${(1 / PERLIN_PERIOD).toFixed(6)}).r * 2.0 - 1.0;
}
float perlinFbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * perlin3(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// 3D Voronoi: x = distance to the border between the two nearest cells,
// y = random value in [0, 1) for the nearest cell; one cell per unit of p
vec2 voronoi3(vec3 p) {
  vec4 t = texture(uNoiseTex, p * ${(1 / VORONOI_PERIOD).toFixed(6)});
  float border = t.g + t.a / 255.0; // 16-bit border distance: high byte in G, low byte in A
  return vec2(border * ${VORONOI_BORDER_MAX.toFixed(4)}, t.b);
}
// Box-filtered coverage of a line of half-width w around a Voronoi border, for a pixel whose
// footprint spans ±pw in border-distance units: smooth edges up close, and a line thinner
// than a pixel fades out instead of flickering.
float lineCoverage(float d, float w, float pw) {
  pw = max(pw, 1e-4);
  return max(0.0, min(d + pw, w) - max(d - pw, -w)) / (2.0 * pw);
}
// arithmetic hash (no sin), three values in [0, 1) — Dave Hoskins' hash33
vec3 cellHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
`;

// Water surface height: sine bands warped by Perlin noise that stay fixed in the
// block (static waviness) plus Perlin ripples and a travelling wave that move with time.
const WATER_GLSL = `
float waterHeight(vec3 p, float t) {
  float w = perlin3(p * 1.3) * 2.5;
  float still = 0.5 * sin(p.x * 3.1 + p.z * 1.7 + w) + 0.5 * sin(p.y * 2.3 - p.z * 2.9 + w * 0.7);
  float moving = 1.2 * perlin3(p * 2.6 + vec3(0.0, t * 0.45, t * 0.3))
               + 0.25 * sin(dot(p, vec3(0.8, 0.5, -0.6)) * 5.0 - t * 1.8 + w);
  return still * 0.55 + moving * 0.45;
}
`;

// Bump-maps a view-space normal from a scalar height using screen-space derivatives
// (same maths as three.js perturbNormalArb).
const BUMP_GLSL = `
vec3 heightBump(vec3 surfPos, vec3 surfNorm, float h, float scale) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
  float det = dot(sx, r1);
  vec2 dh = vec2(dFdx(h), dFdy(h)) * scale;
  if (scale <= 0.0) return surfNorm; // after the derivatives, so they stay in uniform flow
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

/**
 * The two block materials: `opaque` (every style except the translucent ones) and
 * `translucent` (Water and Crystal, drawn by a second InstancedMesh that shares the same
 * instance buffers).
 * Each material's vertex shader collapses the instances that belong to the other pass.
 * Both have per-instance colour and soft face outlines.
 * `uniforms.uDitherIndex.value` = instance index to draw 50 % see-through with a
 * checkerboard dither (used for the block targeted by Delete); -1 = none.
 * `uniforms.uTime.value` = seconds, drives the water animation.
 * Instances whose `blockStyle.x` is BLOCK_STYLE.dirt (Perlin noise), BLOCK_STYLE.stone
 * (Perlin-warped Voronoi slabs), BLOCK_STYLE.water (wavy, animated, translucent) or
 * BLOCK_STYLE.moss (Voronoi cushions over soil), BLOCK_STYLE.berry (2D strawberry
 * seed pattern in each face's plane), BLOCK_STYLE.crawly (2D iridescent beetle shell), BLOCK_STYLE.wood
 * (3D growth rings) or BLOCK_STYLE.crystal (faceted, glowing, translucent magenta gem)
 * get a procedural surface tinted by the instance colour; `blockStyle.y` seeds the pattern.
 * `blockStyle.z` = bit mask of faces (bit i = FACE_DIRS[i]) that touch another block of the
 * same translucent type; the translucent pass skips those faces so touching Water (or
 * Crystal) looks like one body.
 * `blockStyle.w` = bit mask of neighbours (bit i = FACE_DIRS[i]) holding an opaque block,
 * for ambient occlusion (`uniforms.uAO.value` 1 = on, 0 = off).
 * `setProcedural(false)` switches both materials to plain instance colours (plus outlines
 * and Water / Crystal translucency): the procedural code is compiled out, for slower GPUs.
 */
export function createBlockMaterials() {
  const uniforms = {
    uDitherIndex: { value: -1 },
    uTime: { value: 0 },
    uNoiseTex: { value: createNoiseTexture() },
    uOutlines: { value: 1 }, // Options → Outlines: 1 = draw face outlines, 0 = hide them
    uAO: { value: 1 }, // Options → Ambient Occlusion: 1 = on, 0 = off
  };
  const options = { procedural: true };
  const opaque = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.0 });
  const translucent = new THREE.MeshStandardMaterial({ roughness: 0.1, metalness: 0.0, transparent: true, depthWrite: false });
  patchBlockShader(opaque, uniforms, options, false);
  patchBlockShader(translucent, uniforms, options, true);
  const setProcedural = (on) => {
    if (options.procedural === on) return;
    options.procedural = on;
    opaque.needsUpdate = translucent.needsUpdate = true; // recompile with / without SOLID_MATERIALS
  };
  return { opaque, translucent, uniforms, setProcedural };
}

function patchBlockShader(mat, uniforms, options, translucentPass) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (translucentPass) shader.defines = { ...shader.defines, TRANSLUCENT_PASS: '' };
    if (!options.procedural) shader.defines = { ...shader.defines, SOLID_MATERIALS: '' };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float edgeDist;
        attribute float faceIndex;
        attribute vec3 aoFaces;
        attribute vec4 blockStyle;
        varying float vAO;
        varying float vEdgeDist;
        uniform float uDitherIndex;
        varying float vDither;
        varying float vStyle;
        varying vec3 vNoisePos;
        varying vec3 vLocalNormal;
        varying vec3 vLocalPos;
        varying float vSeed;
        varying mat3 vLocalToView;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vEdgeDist = edgeDist;
        vDither = abs(float(gl_InstanceID) - uDitherIndex) < 0.5 ? 1.0 : 0.0;
        vStyle = blockStyle.x;
        // block-local position (cm), offset per block so each one's pattern differs and
        // stays glued to the block while it slides
        vNoisePos = position + blockStyle.y * vec3(7.31, 3.17, 5.53);
        vLocalNormal = normal; // block-local face normal (instances are only translated)
        vLocalPos = position;  // block-local position without the seed offset
        vSeed = blockStyle.y;
        // block-local directions -> view space (instances are only translated; drop the cm scale)
        {
          mat3 m = mat3(modelViewMatrix);
          vLocalToView = mat3(normalize(m[0]), normalize(m[1]), normalize(m[2]));
        }
        // ambient occlusion: fraction of the 3 cells sharing this corner that are filled
        // (blockStyle.w = neighbour mask, bit i = FACE_DIRS[i]); face centres stay 0
        {
          int occ = int(blockStyle.w + 0.5);
          float n = 0.0;
          for (int i = 0; i < 3; i++) {
            if (aoFaces[i] >= 0.0 && ((occ >> int(aoFaces[i] + 0.5)) & 1) == 1) n += 1.0;
          }
          vAO = n / 3.0;
        }`
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        // skip instances drawn by the other pass: push every vertex past the far plane
        bool isTranslucent = ${TRANSLUCENT_STYLES.map((s) => `abs(blockStyle.x - ${s.toFixed(1)}) < 0.5`).join(' || ')};
        #ifdef TRANSLUCENT_PASS
        if (!isTranslucent) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        // also skip faces shared with a block of the same translucent type (no inner walls, less overdraw)
        if (((int(blockStyle.z + 0.5) >> int(faceIndex + 0.5)) & 1) == 1) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        #else
        if (isTranslucent) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        #endif`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vEdgeDist;
        varying float vDither;
        varying float vStyle;
        varying vec3 vNoisePos;
        varying vec3 vLocalNormal;
        varying vec3 vLocalPos;
        varying float vSeed;
        varying mat3 vLocalToView;
        uniform float uTime;
        uniform float uOutlines;
        uniform float uAO;
        varying float vAO;
        ${NOISE_GLSL}
        ${WATER_GLSL}
        ${BUMP_GLSL}`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        // 50 % screen-door transparency: drop every other pixel in a checkerboard
        if (vDither > 0.5 && mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 1.0) discard;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float surfaceRough = 0.0;
        float bumpH = 0.0;        // height (roughly 0..1 per few mm) for bump mapping
        float bumpStrength = 0.0; // 0 = no bump
        float isShell = 0.0;      // Crawly shell: its view-dependent colour is applied once the normal is known
        float shellPhase = 0.0;
        vec3 shellBase = vec3(0.0);
        vec3 crystalGlow = vec3(0.0); // Crystal inner glow / cloud light scattering, added as emission
        vec3 cloudNormal = vec3(0.0); // Fog / Nimbus: block-local "fluffy" normal, replaces the flat face normal
        // Fog / Nimbus: purely diffuse, no specular highlights or reflections (any Materials mode)
        float isCloud = vStyle > ${(BLOCK_STYLE.fog - 0.5).toFixed(1)} && vStyle < ${(BLOCK_STYLE.nimbus + 0.5).toFixed(1)} ? 1.0 : 0.0;
        float noOutline = isCloud; // soft, rounded bodies skip face outlines and corner shading
        vec3 facetTilt = vec3(0.0);   // Crystal: per-facet normal tilt (block-local), applied with the normal
        #if defined(SOLID_MATERIALS)
          // Options → Materials: Solid — flat instance colour only
          #ifdef TRANSLUCENT_PASS
          // each see-through type at its opacity (blocks.js); Crystal glossy, Fog / Nimbus matte
          ${TRANSLUCENT.map((t) => `if (abs(vStyle - ${t.style.toFixed(1)}) < 0.5) diffuseColor.a = ${t.opacity.toFixed(3)};`).join('\n          ')}
          surfaceRough = vStyle > ${(BLOCK_STYLE.fog - 0.5).toFixed(1)} ? 1.0 : vStyle > ${(BLOCK_STYLE.crystal - 0.5).toFixed(1)} ? 0.04 : 0.08;
          #endif
        #elif defined(TRANSLUCENT_PASS)
        if (vStyle > ${(BLOCK_STYLE.fog - 0.5).toFixed(1)}) {
          // Fog / Nimbus: fluffy, slowly churning cloud. Everything is 3D noise in block space,
          // detailed down to ~1 mm so a single 2 cm block still looks soft:
          //  - "billow" noise (sums of |Perlin|) gives rounded puffs at several sizes
          //  - the normal points out from the block centre (so the block shades like a soft
          //    ball, not flat faces) and is jostled by noise, so light breaks up into lumps
          //  - some of the cloud's own colour is added as glow (light scattering inside it),
          //    which flattens the contrast the way real cloud lighting does
          // Nimbus uses the same shader with its darker colour, plus a heavier, darker bottom.
          vec3 drift = vec3(uTime * 0.05, uTime * 0.02, -uTime * 0.035);
          vec3 q = vNoisePos + drift;
          float billow = perlinFbm(q * 1.1);
          float puffs = abs(perlin3(q * 2.4)) * 0.5 + abs(perlin3(q * 5.1 + 3.7)) * 0.3 + abs(perlin3(q * 10.7 + 8.1)) * 0.2;
          vec3 lump = vec3(perlin3(q * 2.1 + 1.3), perlin3(q * 2.1 + 6.1), perlin3(q * 2.1 + 12.9));
          // Fog: smooth shading, the normal simply points out from the block centre (no face
          // or noise terms), so the block lights like a soft sphere. Nimbus keeps the lumps.
          cloudNormal = vStyle > ${(BLOCK_STYLE.nimbus - 0.5).toFixed(1)}
            ? normalize(normalize(vLocalPos) + 0.25 * normalize(vLocalNormal) + 0.9 * lump)
            : normalize(vLocalPos);
          vec3 base = diffuseColor.rgb;
          vec3 col = base * (0.8 + 0.25 * billow + 0.3 * puffs);
          if (vStyle > ${(BLOCK_STYLE.nimbus - 0.5).toFixed(1)}) col *= mix(0.72, 1.0, smoothstep(-1.0, 0.6, vLocalPos.y));
          diffuseColor.rgb = col;
          // opacity: its own slowly drifting 3D Perlin density field, around 80 % opaque, so
          // the cloud thins and thickens in patches independently of its shading
          float density = perlinFbm(vNoisePos * 0.9 + drift * 0.6 + vec3(11.3, 4.7, 7.9));
          diffuseColor.a = clamp(0.8 + 0.35 * density, 0.55, 0.95);
          surfaceRough = 1.0;
          crystalGlow = col * 0.22;
        } else if (vStyle > ${(BLOCK_STYLE.crystal - 0.5).toFixed(1)}) {
          // Crystal (magenta gem): Voronoi cells are internal facets. Each facet tilts the
          // normal its own way so highlights break up into glints; the colour runs from a pale
          // pink tint to a deep violet shade of the instance colour per facet, with a faint
          // cloudiness and bright lines where facets meet, plus a little inner glow. All tints
          // derive from the instance colour, so recolouring the block recolours the gem.
          vec2 vor = voronoi3(vNoisePos * 1.4);
          // Tilt each facet's normal its own way. Applied directly to the normal (see the
          // normal section), not as a bump, so facet borders are clean edges rather than
          // derivative spikes. The tilt is a smooth function of the cell value: the texture
          // blends that value across a border, which then reads as a narrow bevel, not noise.
          vec3 tilt = 0.35 * vec3(sin(vor.y * 19.0), sin(vor.y * 31.0 + 1.3), sin(vor.y * 43.0 + 2.1));
          vec3 fn = normalize(vLocalNormal);
          facetTilt = tilt - dot(tilt, fn) * fn; // keep the tilt within the face plane
          float cloud = perlinFbm(vNoisePos * 2.0);
          vec3 base = diffuseColor.rgb;
          vec3 pale = mix(base, vec3(1.0), 0.28) * 1.1;     // lighter, slightly whitened tint
          vec3 deep = base * vec3(0.62, 0.45, 0.8);         // deeper, cooler (violet-leaning) shade
          vec3 col = mix(pale, deep, clamp(vor.y * 0.75 + cloud * 0.45, 0.0, 1.0));
          float epw = length(fwidth(vNoisePos)) * 0.6 * 1.4; // pixel footprint in border-distance units
          col += (base * 0.25 + 0.06) * lineCoverage(vor.x, 0.02, epw); // bright facet edges, antialiased
          diffuseColor.rgb = col;
          diffuseColor.a = mix(0.82, 0.94, vor.y);
          surfaceRough = 0.04;
          crystalGlow = col * 0.12;
        } else {
          bumpH = waterHeight(vNoisePos, uTime);
          bumpStrength = 0.08;
          vec3 base = diffuseColor.rgb;
          float k = smoothstep(-0.8, 0.8, bumpH);
          // deep blue in the troughs, lighter cyan-blue on the swells, bright crests
          vec3 col = mix(base * vec3(0.35, 0.5, 0.7), base * vec3(1.15, 1.25, 1.1) + vec3(0.0, 0.03, 0.04), k);
          col += vec3(0.2, 0.3, 0.35) * smoothstep(0.7, 1.0, bumpH);
          diffuseColor.rgb = col;
          diffuseColor.a = mix(0.4, 0.65, k);
          surfaceRough = 0.08;
        }
        #else
        if (vStyle > 0.5 && vStyle < 1.5) {
          vec3 p = vNoisePos;
          float clumps = perlinFbm(p * 2.2);                 // large damp/dry patches
          float grain = perlin3(p * 14.0) * 0.6 + perlin3(p * 31.0) * 0.4; // fine soil grain
          // brown over dark brown: blend the instance colour with a darker, warmer shade
          float t = smoothstep(-0.35, 0.35, clumps * 1.2 + grain * 0.35);
          vec3 base = diffuseColor.rgb;
          vec3 darkBrown = base * vec3(0.32, 0.26, 0.22);
          diffuseColor.rgb = mix(darkBrown, base, t);
          surfaceRough = 1.0;
        } else if (vStyle > 1.5 && vStyle < 2.5) {
          vec3 p = vNoisePos;
          // pixel footprint in cm: smooth (it comes from the interpolated position, not from
          // the texture), so the antialiasing below doesn't step from texel to texel
          float px = length(fwidth(p)) * 0.6;
          // Perlin domain warp so the Voronoi slab borders wander like real fractures
          vec3 warp = vec3(perlin3(p * 2.3), perlin3(p * 2.3 + 5.2), perlin3(p * 2.3 + 9.7));
          // second, higher-frequency warp octave adds small zig-zags along each fracture; it
          // fades out once its ~1 mm wiggles get close to pixel size, where they'd only alias
          vec3 jag = vec3(perlin3(p * 9.0 + 3.1), perlin3(p * 9.0 + 7.4), perlin3(p * 9.0 + 12.6));
          float jagAmt = 0.12 * (1.0 - smoothstep(0.02, 0.06, px));
          vec2 vor = voronoi3(p * 1.7 + warp * 0.5 + jag * jagAmt);
          float cellShade = vor.y;                           // per-slab brightness
          float mottle = perlinFbm(p * 4.0);                 // mineral mottling inside slabs
          float speck = perlin3(p * 28.0);                   // fine grain
          vec3 base = diffuseColor.rgb;
          vec3 col = base * (0.78 + 0.34 * cellShade);
          col *= vec3(1.0 + 0.04 * (cellShade - 0.5), 1.0, 1.0 - 0.04 * (cellShade - 0.5)); // slight warm/cool shift
          col *= 1.0 + 0.3 * mottle + 0.12 * speck;
          // dark cracks along the cell borders: box-filtered over the pixel footprint (border
          // distance changes about 1.7x as fast as position), so edges stay smooth and cracks
          // thinner than a pixel fade instead of breaking up
          float pw = px * 1.7;
          float crack = lineCoverage(vor.x, 0.025, pw);
          float groove = 1.0 - smoothstep(0.0, 0.09 + pw, vor.x); // soft shading beside the crack
          col *= mix(1.0, 0.9, groove);
          col = mix(col, base * 0.6, crack);
          diffuseColor.rgb = max(col, 0.0);
          surfaceRough = mix(0.82, 1.0, crack);
        } else if (vStyle > 3.5 && vStyle < 4.5) {
          vec3 p = vNoisePos;
          // Voronoi cells = moss cushions, their borders slightly warped by Perlin noise
          vec3 warp = vec3(perlin3(p * 3.0 + 1.3), perlin3(p * 3.0 + 6.1), perlin3(p * 3.0 + 11.4));
          vec2 vor = voronoi3(p * 2.6 + warp * 0.3);
          float dome = smoothstep(0.0, 0.35, vor.x);         // rounded top, low at the cell borders
          // Perlin coverage: where moss grows vs. bare soil
          float cover = smoothstep(-0.2, 0.15, perlinFbm(p * 1.6) + 0.12);
          float fuzz = perlin3(p * 24.0) * 0.5 + perlin3(p * 48.0) * 0.5; // fibrous strands
          // green over dark brown: soil shows in bare patches, and only faintly in the thin
          // gaps between cushions
          float gap = 1.0 - smoothstep(0.0, 0.04, vor.x + fuzz * 0.02);
          float moss = cover * (1.0 - 0.45 * gap);
          vec3 base = diffuseColor.rgb;
          vec3 green = base * (0.55 + 0.6 * dome) * (1.0 + 0.3 * fuzz);
          green *= mix(vec3(1.0), vec3(1.3, 1.1, 0.55), vor.y * 0.6); // some cushions yellower
          vec3 soil = vec3(0.08, 0.035, 0.012) * (1.0 + 0.35 * perlin3(p * 18.0));
          diffuseColor.rgb = max(mix(soil, green, moss), 0.0);
          surfaceRough = 0.95;
        } else if (vStyle > 4.5 && vStyle < 5.5) {
          // 2D strawberry skin: coordinates in the face's own plane (flat faces, so no
          // stretching), seeds on a staggered grid, each sitting in a small darker pit
          vec3 n = normalize(vLocalNormal);
          vec3 tu = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 tv = cross(n, tu);
          vec2 uv = vec2(dot(vNoisePos, tu), dot(vNoisePos, tv)) * 3.6; // ~3.6 seeds per cm
          float row = floor(uv.y);
          vec2 cuv = vec2(uv.x + 0.5 * mod(row, 2.0), uv.y);        // offset every other row
          vec2 cell = floor(cuv);
          vec3 h = cellHash(vec3(cell, 3.1));
          vec2 f = fract(cuv) - 0.5 - (h.xy - 0.5) * 0.22;           // jittered seed centre
          // seed: small teardrop, slightly narrower towards +v
          vec2 q = f * vec2(1.0 + 1.2 * clamp(f.y * 4.0, 0.0, 1.0), 0.75);
          float r = length(q);
          float afw = max(fwidth(r), 1e-4);
          float seed = 1.0 - smoothstep(0.1 - afw, 0.1 + afw, r);
          float pit = 1.0 - smoothstep(0.09, 0.27, length(f));
          vec3 base = diffuseColor.rgb;
          float mottle = perlin3(vec3(uv * 0.5, 1.7)) * 0.6 + perlin3(vec3(uv * 2.3, 4.2)) * 0.4;
          vec3 red = base * (0.9 + 0.3 * mottle);
          red *= mix(1.0, 0.5, pit);                                  // shadowed pit around each seed
          red = mix(red, base * vec3(1.15, 1.6, 1.5), 0.25 * smoothstep(0.15, 0.6, 0.5 - f.y) * (1.0 - pit)); // soft sheen on the bump
          vec3 seedCol = mix(vec3(0.8, 0.52, 0.06), vec3(0.45, 0.55, 0.08), h.z); // golden to green-yellow
          seedCol *= 0.75 + 0.5 * clamp(0.5 - f.y * 4.0, 0.0, 1.0);   // lit from the top edge
          diffuseColor.rgb = mix(red, seedCol, seed);
          surfaceRough = mix(0.3, 0.75, max(pit * 0.6, seed));        // glossy skin, matte seeds
        } else if (vStyle > 5.5 && vStyle < 6.5) {
          // 2D beetle shell in each face's plane: a smooth, glossy sheen whose colour drifts
          // in broad noise patches. Only the shading is set here; the iridescent hue depends
          // on the view angle and is added after the normal.
          vec3 n = normalize(vLocalNormal);
          vec3 tu = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 tv = cross(n, tu);
          vec2 uv = vec2(dot(vNoisePos, tu), dot(vNoisePos, tv));
          float patches = perlinFbm(vec3(uv * 1.2, 2.0));
          shellBase = diffuseColor.rgb;
          shellPhase = 0.4 * patches;
          diffuseColor.rgb = vec3(0.95 + 0.05 * patches); // very soft light/dark drift
          isShell = 1.0;
          surfaceRough = 0.18;
        } else if (vStyle > 6.5 && vStyle < 7.5) {
          // 3D wood: growth rings around a vertical pith (offset per block), wobbled by
          // noise; grain fibres from noise stretched along the trunk (y). End faces show
          // rings, side faces show long grain.
          vec3 lp = vLocalPos;
          vec3 q = vNoisePos;
          vec3 h = cellHash(vec3(vSeed * 13.7, vSeed * 3.1, 1.7));
          vec2 pith = (h.xy - 0.5) * 1.6;
          vec3 qs = q * vec3(1.3, 0.35, 1.3);
          vec2 wobble = vec2(perlin3(qs), perlin3(qs + 7.7));
          float r = length(lp.xz - pith + wobble * 0.25) * 3.5 + perlin3(q * 0.8) * 0.4;
          float ring = fract(r);
          float rfw = fwidth(r);
          // dark latewood band at the end of each ring; fades to average when rings get sub-pixel
          float late = smoothstep(0.55, 0.9, ring) * (1.0 - smoothstep(0.9, 1.0, ring));
          late = mix(late, 0.2, clamp(rfw * 2.0 - 0.5, 0.0, 1.0));
          float fibre = perlin3(q * vec3(16.0, 1.0, 16.0)) * 0.5 + perlin3(q * vec3(40.0, 2.5, 40.0)) * 0.5;
          vec3 base = diffuseColor.rgb;
          vec3 col = mix(base * 1.1, base * vec3(0.5, 0.4, 0.32), late * 0.85);
          col *= 1.0 + 0.18 * fibre;
          col *= 0.92 + 0.16 * h.z;                          // per-block tone
          diffuseColor.rgb = max(col, 0.0);
          surfaceRough = mix(0.6, 0.8, late);
        } else if (vStyle > ${(BLOCK_STYLE.squirmy - 0.5).toFixed(1)} && vStyle < ${(BLOCK_STYLE.squirmy + 0.5).toFixed(1)}) {
          // Squirmy: wet, shiny, smooth flesh that wiggles. The normal points out from the
          // block centre (a rounded body, no flat faces) and wobbles with slowly drifting 3D
          // noise; ring-like folds ripple along it over time; thin dark veins and paler fatty
          // marbling make it read as meat; a little glow stands in for light under the skin.
          vec3 q = vNoisePos;
          float t = uTime;
          vec3 wig = vec3(perlin3(q * 1.3 + vec3(0.0, t * 0.6, 0.0)),
                          perlin3(q * 1.3 + vec3(5.2, t * 0.6, 1.7)),
                          perlin3(q * 1.3 + vec3(9.4, t * 0.6, 3.3)));
          cloudNormal = normalize(normalize(vLocalPos) + 0.45 * wig);
          float band = 0.5 + 0.5 * sin(dot(vLocalPos, vec3(0.28, 0.93, 0.21)) * 6.0 - t * 3.0 + perlin3(q * 2.0) * 2.0);
          float vein = 1.0 - smoothstep(0.0, 0.08, abs(perlin3(q * 3.2 + wig * 0.3)));
          float marble = perlinFbm(q * 2.1);
          vec3 base = diffuseColor.rgb;
          vec3 col = base * (0.9 + 0.2 * marble) * mix(0.82, 1.08, band);
          col = mix(col, base * vec3(0.55, 0.2, 0.28), vein * 0.55);
          col = mix(col, vec3(1.0, 0.86, 0.86), smoothstep(0.35, 0.7, marble) * 0.25);
          diffuseColor.rgb = col;
          crystalGlow = col * 0.12;
          surfaceRough = 0.22;
          noOutline = 1.0;
        }
        #endif
        float fw = max(fwidth(vEdgeDist), 1e-4);
        float edgeW = ${EDGE_WIDTH_CM.toFixed(4)};
        float edgeMix = smoothstep(edgeW - fw, edgeW + fw, vEdgeDist);
        // (clouds skip both: hard outlines and dark corners make them look like tiles)
        diffuseColor.rgb *= mix(${EDGE_SHADE.toFixed(4)}, 1.0, max(max(edgeMix, 1.0 - uOutlines), noOutline));
        diffuseColor.rgb *= 1.0 - uAO * ${AO_STRENGTH.toFixed(3)} * vAO * (1.0 - noOutline); // corners hemmed in by neighbours go darker`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        if (surfaceRough > 0.0) roughnessFactor = surfaceRough;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        #ifndef SOLID_MATERIALS
        {
          // bump the normal by the surface height; scale converts the cm-space height
          // gradient to view units so the bumps look the same at any world scale.
          // Evaluated for every style (bumpStrength 0 = unchanged) to keep derivatives uniform.
          float cmToView = (length(dFdx(vViewPosition)) + length(dFdy(vViewPosition)))
                         / max(length(dFdx(vNoisePos)) + length(dFdy(vNoisePos)), 1e-6);
          normal = heightBump(-vViewPosition, normal, bumpH, bumpStrength * cmToView);
        }
        // Crystal facets: tilt the normal directly (block-local tilt -> view space)
        if (dot(facetTilt, facetTilt) > 0.0) normal = normalize(normal + vLocalToView * facetTilt);
        // Fog / Nimbus: replace the flat face normal with the fluffy one (block-local -> view)
        if (dot(cloudNormal, cloudNormal) > 0.0) normal = normalize(vLocalToView * cloudNormal);
        if (isShell > 0.5) {
          // thin-film-like iridescence: the hue cycles as the viewing angle changes,
          // biased toward beetle greens, blues and violets plus the instance colour
          float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          float ph = 1.4 * (1.0 - ndv) + shellPhase;
          vec3 irid = 0.5 + 0.5 * cos(6.2831853 * (ph + vec3(0.0, 0.33, 0.67)));
          irid *= vec3(0.55, 1.0, 1.05);
          vec3 shell = mix(shellBase * 0.5, irid, 0.75) * 0.7;
          diffuseColor.rgb *= shell; // keeps the soft shading and face outlines
          metalnessFactor = 0.35;    // tints highlights with the shell colour
        }
        #endif
        #ifdef TRANSLUCENT_PASS
        {
          // Fresnel: grazing angles reflect more and look less see-through (not for clouds)
          float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
          diffuseColor.a = mix(diffuseColor.a, max(diffuseColor.a, 0.9), fres * (1.0 - isCloud)); // never less opaque at the rim
        }
        #endif`
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        if (isCloud > 0.5) {
          // clouds don't reflect: drop all specular light (highlights and environment)
          reflectedLight.directSpecular = vec3(0.0);
          reflectedLight.indirectSpecular = vec3(0.0);
        }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += crystalGlow; // Crystal's inner glow (zero for everything else)`
      );
  };
  mat.customProgramCacheKey = () =>
    `${translucentPass ? 'grid-block-translucent' : 'grid-block-opaque'}-${options.procedural ? 'procedural' : 'solid'}`;
}
