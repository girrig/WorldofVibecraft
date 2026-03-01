// Lightweight Three.js mock for testing without WebGL
import { vi } from 'vitest';

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x; this.y = y; this.z = z;
  }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  normalize() {
    const len = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
    if (len > 0) { this.x /= len; this.y /= len; this.z /= len; }
    return this;
  }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  lerp(v, alpha) {
    this.x += (v.x - this.x) * alpha;
    this.y += (v.y - this.y) * alpha;
    this.z += (v.z - this.z) * alpha;
    return this;
  }
  applyAxisAngle(axis, angle) {
    // Simplified: only supports Y-axis rotation (which is all this project uses)
    if (axis.y === 1) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const x = this.x * cos - this.z * sin;
      const z = this.x * sin + this.z * cos;
      this.x = x;
      this.z = z;
    }
    return this;
  }
  setScalar(s) { this.x = s; this.y = s; this.z = s; return this; }
  applyMatrix4(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z;
    const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    return this;
  }
}

function makeMatrix16() {
  const elements = new Float32Array(16);
  elements[0] = elements[5] = elements[10] = elements[15] = 1;
  return {
    elements,
    toArray(target, offset = 0) {
      for (let i = 0; i < 16; i++) target[offset + i] = elements[i];
    },
  };
}

function makeEuler() {
  return { x: 0, y: 0, z: 0, order: 'XYZ', set(x, y, z, order) { this.x = x; this.y = y; this.z = z; if (order) this.order = order; } };
}

export class Group {
  constructor() {
    this.position = new Vector3();
    this.rotation = makeEuler();
    this.scale = new Vector3(1, 1, 1);
    this.matrix = makeMatrix16();
    this.children = [];
    this.parent = null;
  }
  add(child) {
    child.parent = this;
    this.children.push(child);
  }
  remove(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parent = null;
    }
  }
  updateMatrix() {
    const e = this.matrix.elements;
    e.fill(0);
    e[0] = this.scale.x; e[5] = this.scale.y; e[10] = this.scale.z;
    e[12] = this.position.x; e[13] = this.position.y; e[14] = this.position.z;
    e[15] = 1;
  }
  updateMatrixWorld(force) {
    this.updateMatrix();
    for (const child of this.children) {
      if (child.updateMatrixWorld) child.updateMatrixWorld(force);
    }
  }
  clone() {
    const cloned = new Group();
    cloned.position.copy(this.position);
    cloned.rotation.x = this.rotation.x;
    cloned.rotation.y = this.rotation.y;
    cloned.rotation.z = this.rotation.z;
    cloned.scale.copy(this.scale);
    for (const child of this.children) {
      if (child.clone) cloned.add(child.clone());
    }
    return cloned;
  }
  traverse(fn) {
    fn(this);
    for (const child of this.children) {
      if (child.traverse) child.traverse(fn);
      else fn(child);
    }
  }
}

export class Object3D extends Group {}

export class Mesh {
  constructor(geometry, material) {
    this.geometry = geometry;
    this.material = material;
    this.position = new Vector3();
    this.rotation = makeEuler();
    this.castShadow = false;
    this.receiveShadow = false;
    this.isMesh = true;
    this.parent = null;
    this.children = [];
  }
  add(child) { child.parent = this; this.children.push(child); }
  clone() {
    const cloned = new Mesh(this.geometry, this.material);
    cloned.position.copy(this.position);
    cloned.rotation = { ...this.rotation };
    cloned.castShadow = this.castShadow;
    cloned.receiveShadow = this.receiveShadow;
    return cloned;
  }
  traverse(fn) {
    fn(this);
    for (const child of this.children) {
      if (child.traverse) child.traverse(fn);
      else fn(child);
    }
  }
}

export class Scene extends Group {
  constructor() {
    super();
    this.background = null;
    this.fog = null;
  }
}

// Animation support
export class AnimationAction {
  constructor() {
    this.loop = null;
    this._fadeIn = vi.fn().mockReturnThis();
    this._fadeOut = vi.fn().mockReturnThis();
    this._play = vi.fn().mockReturnThis();
    this._reset = vi.fn().mockReturnThis();
  }
  setLoop(mode) { this.loop = mode; return this; }
  fadeIn(duration) { return this; }
  fadeOut(duration) { return this; }
  play() { return this; }
  reset() { return this; }
  stop() { return this; }
}

export class AnimationMixer {
  constructor(root) {
    this.root = root;
    this._actions = new Map();
  }
  clipAction(clip) {
    if (!this._actions.has(clip.name)) {
      this._actions.set(clip.name, new AnimationAction());
    }
    return this._actions.get(clip.name);
  }
  update(dt) {}
  stopAllAction() {}
}

export class AnimationClip {
  constructor(name = '', duration = 1, tracks = []) {
    this.name = name;
    this.duration = duration;
    this.tracks = tracks;
  }
}

export class Raycaster {
  constructor(origin, direction, near, far) {
    this.ray = { origin, direction };
    this.near = near || 0;
    this.far = far || Infinity;
    this._intersections = [];
  }
  intersectObjects(objects, recursive) {
    return this._intersections;
  }
}

// Geometry stubs
export class PlaneGeometry {
  constructor() { this.attributes = { position: { array: new Float32Array(0) } }; }
  rotateX() { return this; }
  computeVertexNormals() {}
  dispose() {}
}
export class CylinderGeometry { constructor() {} dispose() {} }
export class SphereGeometry { constructor() {} dispose() {} }
export class BoxGeometry { constructor() {} dispose() {} }
export class ConeGeometry { constructor() {} dispose() {} }
export class DodecahedronGeometry { constructor() {} dispose() {} }
export class BufferGeometry {
  constructor() { this.attributes = {}; }
  setAttribute() { return this; }
  setIndex() { return this; }
  computeVertexNormals() {}
  dispose() {}
}
export class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
}

// Material stubs
export class MeshStandardMaterial {
  constructor(opts = {}) { Object.assign(this, opts); this.map = null; }
  dispose() {}
}
export class MeshBasicMaterial {
  constructor(opts = {}) { Object.assign(this, opts); }
  dispose() {}
}
export class SpriteMaterial {
  constructor(opts = {}) { Object.assign(this, opts); }
  dispose() {}
}

// Texture stubs
export class CanvasTexture {
  constructor(canvas) { this.image = canvas; }
  dispose() {}
}

export class Sprite {
  constructor(material) {
    this.material = material;
    this.position = new Vector3();
    this.scale = new Vector3(1, 1, 1);
    this.parent = null;
  }
}

// Instanced mesh
export class InstancedMesh {
  constructor(geometry, material, count) {
    this.geometry = geometry;
    this.material = material;
    this.count = count;
    this.instanceMatrix = {
      array: new Float32Array(count * 16),
      needsUpdate: false,
    };
    this.castShadow = false;
    this.receiveShadow = false;
    this.isMesh = true;
    this.parent = null;
  }
  setMatrixAt(index, matrix) {
    if (matrix && matrix.elements) {
      const offset = index * 16;
      for (let i = 0; i < 16; i++) {
        this.instanceMatrix.array[offset + i] = matrix.elements[i];
      }
    }
  }
}

// Lights
class BaseLight {
  constructor(color, intensity) {
    this.color = color;
    this.intensity = intensity;
    this.position = new Vector3();
    this.castShadow = false;
    this.shadow = {
      mapSize: { width: 512, height: 512 },
      camera: { near: 0.5, far: 500, left: -10, right: 10, top: 10, bottom: -10 },
    };
    this.parent = null;
  }
}
export class AmbientLight extends BaseLight {}
export class DirectionalLight extends BaseLight {}
export class HemisphereLight extends BaseLight {}
export class PointLight extends BaseLight {
  constructor(color, intensity, distance) {
    super(color, intensity);
    this.distance = distance;
  }
}

// Constants
export const LoopRepeat = 2201;

// Fog
export class FogExp2 {
  constructor(color, density) { this.color = color; this.density = density; }
}

// Color
export class Color {
  constructor(c) { this.value = c; }
  set(c) { this.value = c; return this; }
}

// MathUtils
export const MathUtils = {
  degToRad(deg) { return deg * Math.PI / 180; },
  radToDeg(rad) { return rad * 180 / Math.PI; },
};

// Texture stubs
export class TextureLoader {
  load(url) { return { wrapS: 0, wrapT: 0, minFilter: 0, colorSpace: '' }; }
}
export const ClampToEdgeWrapping = 1001;
export const LinearMipmapLinearFilter = 1008;
export const SRGBColorSpace = 'srgb';
export const PCFSoftShadowMap = 2;

// Clock
export class Clock {
  constructor() { this._lastTime = 0; }
  getDelta() { return 0.016; }
  getElapsedTime() { return 0; }
}

// WebGLRenderer
export class WebGLRenderer {
  constructor(opts = {}) {
    this.domElement = opts.canvas || {};
    this.shadowMap = { enabled: false, type: 0 };
  }
  setSize() {}
  setPixelRatio() {}
  render() {}
  compile() {}
}

// PerspectiveCamera
export class PerspectiveCamera {
  constructor(fov, aspect, near, far) {
    this.fov = fov;
    this.aspect = aspect;
    this.near = near;
    this.far = far;
    this.position = new Vector3();
  }
  lookAt() {}
  updateProjectionMatrix() {}
}

// Matrix4
export class Matrix4 {
  constructor() {
    this.elements = new Float32Array(16);
    this.elements[0] = this.elements[5] = this.elements[10] = this.elements[15] = 1;
  }
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements, te = this.elements;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        te[i + j * 4] = ae[i] * be[j * 4] + ae[i + 4] * be[j * 4 + 1] +
                         ae[i + 8] * be[j * 4 + 2] + ae[i + 12] * be[j * 4 + 3];
      }
    }
    return this;
  }
  toArray(target, offset = 0) {
    for (let i = 0; i < 16; i++) target[offset + i] = this.elements[i];
  }
}

// Box3
export class Box3 {
  constructor() {
    this.min = new Vector3(Infinity, Infinity, Infinity);
    this.max = new Vector3(-Infinity, -Infinity, -Infinity);
  }
  union(box) {
    this.min.x = Math.min(this.min.x, box.min.x);
    this.min.y = Math.min(this.min.y, box.min.y);
    this.min.z = Math.min(this.min.z, box.min.z);
    this.max.x = Math.max(this.max.x, box.max.x);
    this.max.y = Math.max(this.max.y, box.max.y);
    this.max.z = Math.max(this.max.z, box.max.z);
    return this;
  }
  getSize(target) {
    target.x = this.max.x - this.min.x;
    target.y = this.max.y - this.min.y;
    target.z = this.max.z - this.min.z;
    return target;
  }
  getCenter(target) {
    target.x = (this.min.x + this.max.x) * 0.5;
    target.y = (this.min.y + this.max.y) * 0.5;
    target.z = (this.min.z + this.max.z) * 0.5;
    return target;
  }
}

// Quaternion
export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x; this.y = y; this.z = z; this.w = w;
  }
  setFromAxisAngle() { return this; }
  multiply() { return this; }
}
