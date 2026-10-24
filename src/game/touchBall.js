// XR: each controller's touch ball, what a grip takes hold of blocks and creatures with. It's
// a grid cell (the active grid's shape, at the build's scale and turned with it, so it shows
// the cell it reaches into), drawn as see-through, wavy, bluish energy: a bright rim where
// its faces turn away from the view, and bands of light rippling over it. `uHot` (0..1)
// brightens it: on a block it could take hold of, more on a creature (or carrying one).
import * as THREE from 'three';

/** The touch balls' blue (between their deep and bright tones): the selection glow shares it (engine.js). */
export const ENERGY_BLUE = '#3fb4ff';

/** The shared clock (s) for every touch ball's ripples: set it each frame. */
export const touchBallTime = { value: 0 };

export function createTouchBallMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: touchBallTime, uHot: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vPos;     // cell-local, cm
      varying vec3 vNormal;  // view space
      varying vec3 vView;    // view space, from the surface to the eye
      void main() {
        vPos = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uHot;
      varying vec3 vPos;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float ndv = abs(dot(normalize(vNormal), normalize(vView)));
        float rim = pow(1.0 - ndv, 2.0);
        // two sets of ripples crossing the cell, each bent by the other
        float w1 = sin(vPos.y * 5.0 + uTime * 3.1 + sin(vPos.x * 4.0 + uTime * 1.7) * 1.4);
        float w2 = sin((vPos.x + vPos.z) * 3.6 - uTime * 2.3 + sin(vPos.y * 3.3 - uTime * 1.3) * 1.2);
        float bands = smoothstep(0.55, 1.0, w1) + 0.7 * smoothstep(0.6, 1.0, w2);
        float shimmer = 0.5 + 0.5 * sin(uTime * 6.0 + vPos.z * 7.0);
        vec3 deep = vec3(0.05, 0.25, 0.9);
        vec3 bright = vec3(0.45, 0.9, 1.0);
        vec3 col = mix(deep, bright, clamp(rim + 0.5 * bands, 0.0, 1.0));
        float a = 0.06 + 0.55 * rim + 0.28 * bands * (0.75 + 0.25 * shimmer);
        float boost = 1.0 + 1.3 * uHot;
        gl_FragColor = vec4(col * a * boost, 1.0); // (added onto what's behind)
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, // (its far side too: it looks like a volume of light)
    toneMapped: false,
  });
}
