import * as THREE from 'three';

export function createEnvironment() {
  // Decorations removed — real Northshire terrain is the world now.
  return new THREE.Group();
}

export function createLighting(scene) {
  // Ambient light
  const ambient = new THREE.AmbientLight(0x6688cc, 0.4);
  scene.add(ambient);

  // Directional sunlight — larger frustum for 1600-yard world
  const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
  sun.position.set(200, 300, 100);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 600;
  sun.shadow.camera.left = -200;
  sun.shadow.camera.right = 200;
  sun.shadow.camera.top = 200;
  sun.shadow.camera.bottom = -200;
  scene.add(sun);

  // Hemisphere light for sky/ground color blending
  const hemi = new THREE.HemisphereLight(0x87ceeb, 0x3a7d44, 0.3);
  scene.add(hemi);
}

export function createSky(scene) {
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.FogExp2(0x87ceeb, 0.0012);
}
