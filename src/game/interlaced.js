import * as THREE from 'three';

// View Mode → 3D: Interlaced (from 4d-viewer-threejs), row-interleaved stereo for passive
// (polarised) 3D monitors: the left eye on the screen's odd rows counting from the top (1st,
// 3rd, …), the right on the even ones. Each eye is drawn at full width and half height, keeping
// the full screen's aspect, then woven together row by row, so each pixel row shows one eye
// unscaled. Rows are counted from the top of the canvas, so it lines up when the page fills the
// screen (fullscreen).

const vertexShader = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const fragmentShader = /* glsl */ `
uniform sampler2D left;
uniform sampler2D right;
uniform vec2 size; // the drawing buffer, in pixels
uniform float eyeHeight; // each eye's rows

void main() {
  float row = floor(size.y - gl_FragCoord.y); // 0 at the top
  float eyeRow = floor(row / 2.0);
  vec2 uv = vec2(gl_FragCoord.x / size.x, 1.0 - (eyeRow + 0.5) / eyeHeight);
  gl_FragColor = mod(row, 2.0) < 1.0 ? texture2D(left, uv) : texture2D(right, uv);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const _size = new THREE.Vector2();

function eyeTarget() {
  return new THREE.WebGLRenderTarget(1, 1, {
    samples: 4,
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
}

export class Interlaced {
  constructor(eyeSep) {
    this.stereo = Object.assign(new THREE.StereoCamera(), { eyeSep });
    this.targets = [eyeTarget(), eyeTarget()];
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        left: { value: this.targets[0].texture },
        right: { value: this.targets[1].texture },
        size: { value: new THREE.Vector2() },
        eyeHeight: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    // one triangle covering the screen
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const quad = new THREE.Mesh(this.geometry, this.material);
    quad.frustumCulled = false;
    this.weave = new THREE.Scene().add(quad);
    this.camera = new THREE.Camera();
  }

  /** Draws `scene` from `camera` as the two eyes, woven row by row onto the canvas. */
  render(renderer, scene, camera) {
    camera.updateMatrixWorld();
    this.stereo.update(camera);
    renderer.getDrawingBufferSize(_size);
    const eyeHeight = Math.ceil(_size.y / 2);
    this.material.uniforms.size.value.copy(_size);
    this.material.uniforms.eyeHeight.value = eyeHeight;

    const previous = renderer.getRenderTarget();
    [this.stereo.cameraL, this.stereo.cameraR].forEach((eye, i) => {
      const target = this.targets[i];
      if (target.width !== _size.x || target.height !== eyeHeight) target.setSize(_size.x, eyeHeight);
      renderer.setRenderTarget(target);
      renderer.render(scene, eye);
    });
    renderer.setRenderTarget(previous);
    renderer.render(this.weave, this.camera);
  }

  dispose() {
    this.targets.forEach((t) => t.dispose());
    this.material.dispose();
    this.geometry.dispose();
  }
}
