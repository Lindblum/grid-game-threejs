import * as THREE from 'three';
import { CardboardLens } from './cardboardLens.js';

// Handheld XR for phones whose browser has no WebXR AR session (e.g. iPhone Safari): split-screen
// stereo for a Cardboard-style viewer, or a single full-screen view, both steered by the motion
// sensors (no walking). Passthrough here is the rear camera feed drawn behind the scene.
// Ported from 4d-viewer-threejs (Cardboard.jsx).

const EYE_HEIGHT = 1.6; // m
export const STEREO_FOV = 80;

/** Phones and tablets with motion sensors can use the Cardboard fallback. */
export function canUseCardboard() {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && window.matchMedia?.('(pointer: coarse)').matches === true;
}

/** A headset's own browser (Quest, Pico, Wolvic). */
export function isHeadsetBrowser() {
  return /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent);
}

/**
 * Phones and tablets, whose WebXR shows a single view. Detected by the device rather than by
 * WebXR support: some phone browsers also report VR.
 */
export function isPhone() {
  if (isHeadsetBrowser()) return false;
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) && canUseCardboard();
}

/**
 * Call from the click handler, before anything async: motion-sensor permission (iOS),
 * fullscreen and the orientation lock all need the tap. Resolves to whether the sensors may be used.
 */
export function enterCardboard({ landscape = true } = {}) {
  const permission = window.DeviceOrientationEvent?.requestPermission?.();
  const root = document.documentElement;
  const fullscreen = root.requestFullscreen?.({ navigationUI: 'hide' });
  Promise.resolve(fullscreen)
    .then(() => landscape && screen.orientation?.lock?.('landscape'))
    .catch(() => {}); // fullscreen and orientation lock are best effort
  return Promise.resolve(permission)
    .then((state) => state === undefined || state === 'granted')
    .catch(() => false);
}

export function exitCardboard() {
  screen.orientation?.unlock?.();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

const _zee = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _screenTilt = new THREE.Quaternion();
const _cameraFromDevice = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° about X
const _yAxis = new THREE.Vector3(0, 1, 0);
const _yaw = new THREE.Quaternion();
const _size = new THREE.Vector2();

/** Device orientation (degrees) to a camera quaternion, three.js conventions. */
function orientationToQuaternion(target, { alpha, beta, gamma }, screenAngle) {
  const d = THREE.MathUtils.DEG2RAD;
  _euler.set(beta * d, alpha * d, -gamma * d, 'YXZ');
  target.setFromEuler(_euler);
  target.multiply(_cameraFromDevice);
  target.multiply(_screenTilt.setFromAxisAngle(_zee, -screenAngle * d));
  return target;
}

/** Drives `camera` from the phone's motion sensors and renders one view or two lens-corrected eyes. */
export class CardboardRig {
  constructor(renderer, camera) {
    this.renderer = renderer;
    this.camera = camera;
    this.active = false;
    this.split = true;
    this._device = new THREE.Quaternion();
    this._latest = null;
    this._yawOffset = null;
    this._onOrientation = (e) => {
      if (e.alpha != null) this._latest = e;
    };
    this.eyes = [0, 1].map(() => {
      const eye = new THREE.PerspectiveCamera();
      eye.matrixAutoUpdate = false; // set by the lens model each frame
      eye.matrixWorldAutoUpdate = false;
      return eye;
    });
  }

  start(split) {
    if (this.active) return;
    this.active = true;
    this.split = split;
    const cam = this.camera;
    this._saved = { position: cam.position.clone(), quaternion: cam.quaternion.clone(), up: cam.up.clone(), fov: cam.fov };
    cam.position.set(0, EYE_HEIGHT, 0);
    cam.quaternion.identity();
    cam.up.set(0, 1, 0);
    cam.fov = STEREO_FOV;
    cam.updateProjectionMatrix();
    this._latest = null;
    this._yawOffset = null;
    this.lens ??= new CardboardLens();
    window.addEventListener('deviceorientation', this._onOrientation);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('deviceorientation', this._onOrientation);
    const cam = this.camera;
    cam.position.copy(this._saved.position);
    cam.quaternion.copy(this._saved.quaternion);
    cam.up.copy(this._saved.up);
    cam.fov = this._saved.fov;
    cam.updateProjectionMatrix();
  }

  /** Per frame, before anything reads the camera: turn it the way the phone faces. */
  update() {
    const sample = this._latest;
    const cam = this.camera;
    if (sample) {
      orientationToQuaternion(this._device, sample, screen.orientation?.angle ?? window.orientation ?? 0);
      if (this._yawOffset == null) {
        // the heading the phone faced on entry becomes "forward" (-Z)
        _euler.setFromQuaternion(this._device, 'YXZ');
        this._yawOffset = -_euler.y;
      }
      cam.quaternion.copy(_yaw.setFromAxisAngle(_yAxis, this._yawOffset)).multiply(this._device);
    }
    cam.updateMatrixWorld();
  }

  render(scene) {
    const r = this.renderer;
    const cam = this.camera;
    r.getDrawingBufferSize(_size);
    if (!this.split) {
      cam.fov = STEREO_FOV;
      cam.aspect = _size.x / _size.y;
      cam.updateProjectionMatrix();
      r.render(scene, cam);
      return;
    }
    // both eyes, each with its lens's view, side by side into an offscreen image, then through
    // the lens model onto the screen
    const { x: width, y: height } = _size;
    const lens = this.lens;
    lens.setLayout(width, height);
    const target = lens.target;
    target.scissorTest = true;
    this.eyes.forEach((eye, i) => {
      lens.eyeCamera(i, cam.matrixWorld, cam.near, cam.far, eye);
      target.viewport.set((i * width) / 2, 0, width / 2, height);
      target.scissor.copy(target.viewport);
      r.setRenderTarget(target); // applies the target's viewport and scissor
      r.render(scene, eye);
    });
    r.setRenderTarget(null);
    lens.render(r);
  }
}

/**
 * The rear camera as a texture for the scene background, centre-cropped to each view so it isn't
 * stretched (see fit). `onReady` / `onError` are called once it is showing or has failed.
 */
export class CameraFeed {
  texture = null;
  failed = false;
  _session = 0;

  start(onReady, onError) {
    if (this._running) return;
    this._running = true;
    this.failed = false;
    const session = ++this._session;
    const cancelled = () => session !== this._session;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const openCamera = (attempt = 0) =>
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).catch((e) =>
        // still held by a just-ended AR session: retry a few times
        e?.name === 'NotReadableError' && attempt < 4 && !cancelled()
          ? new Promise((r) => setTimeout(r, 600)).then(() => openCamera(attempt + 1))
          : Promise.reject(e),
      );
    const fail = (e) => {
      if (cancelled()) return;
      this.failed = true;
      this._running = false;
      onError?.(e);
    };
    if (!navigator.mediaDevices?.getUserMedia) return fail(new Error('Camera API unavailable'));
    openCamera()
      .then((stream) => {
        if (cancelled()) return stream.getTracks().forEach((t) => t.stop());
        this._stream = stream;
        video.srcObject = stream;
        return video.play();
      })
      .then(() => {
        if (cancelled() || !this._stream) return;
        const t = new THREE.VideoTexture(video);
        t.colorSpace = THREE.SRGBColorSpace;
        this.texture = t;
        onReady?.(t);
      })
      .catch(fail);
  }

  stop() {
    this._session++;
    this._running = false;
    this._stream?.getTracks().forEach((track) => track.stop());
    this._stream = null;
    this.texture?.dispose();
    this.texture = null;
  }

  /** Cover a view of aspect `viewAspect` (width / height) with the image: crop whichever side overflows. */
  fit(viewAspect) {
    const t = this.texture;
    const video = t?.image;
    if (!video?.videoWidth) return;
    const videoAspect = video.videoWidth / video.videoHeight;
    if (videoAspect > viewAspect) t.repeat.set(viewAspect / videoAspect, 1);
    else t.repeat.set(1, videoAspect / viewAspect);
    t.offset.set((1 - t.repeat.x) / 2, (1 - t.repeat.y) / 2);
  }
}
