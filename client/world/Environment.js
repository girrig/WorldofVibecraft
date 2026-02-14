import * as THREE from 'three';
import { WORLD_SIZE } from '../../shared/constants.js';
import { getTerrainHeight } from './Terrain.js';

function createTree(x, z) {
  const group = new THREE.Group();
  const y = getTerrainHeight(x, z);

  // Trunk
  const trunkGeo = new THREE.CylinderGeometry(0.3, 0.4, 3, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4226 });
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.position.y = 1.5;
  trunk.castShadow = true;
  group.add(trunk);

  // Foliage (stacked cones for a pine-ish look)
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2d5a27 });
  const sizes = [
    { r: 2.2, h: 2.5, y: 3.5 },
    { r: 1.7, h: 2.0, y: 5.0 },
    { r: 1.1, h: 1.5, y: 6.2 },
  ];
  for (const s of sizes) {
    const coneGeo = new THREE.ConeGeometry(s.r, s.h, 7);
    const cone = new THREE.Mesh(coneGeo, leafMat);
    cone.position.y = s.y;
    cone.castShadow = true;
    group.add(cone);
  }

  group.position.set(x, y, z);
  return group;
}

function createRock(x, z) {
  const y = getTerrainHeight(x, z);
  const scale = 0.5 + Math.random() * 1.5;
  const geo = new THREE.DodecahedronGeometry(scale, 0);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x888888,
    roughness: 0.95,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y + scale * 0.4, z);
  mesh.rotation.set(Math.random(), Math.random(), Math.random());
  mesh.castShadow = true;
  return mesh;
}

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
}

export function createEnvironment() {
  const group = new THREE.Group();
  const rand = seededRandom(42);
  const half = WORLD_SIZE / 2;
  const townRadius = 25; // Keep town area clear

  // Scatter trees
  for (let i = 0; i < 200; i++) {
    const x = (rand() - 0.5) * WORLD_SIZE * 0.9;
    const z = (rand() - 0.5) * WORLD_SIZE * 0.9;
    const dist = Math.sqrt(x * x + z * z);
    if (dist < townRadius) continue; // Don't place trees in spawn
    group.add(createTree(x, z));
  }

  // Scatter rocks
  for (let i = 0; i < 80; i++) {
    const x = (rand() - 0.5) * WORLD_SIZE * 0.9;
    const z = (rand() - 0.5) * WORLD_SIZE * 0.9;
    const dist = Math.sqrt(x * x + z * z);
    if (dist < townRadius) continue;
    group.add(createRock(x, z));
  }

  // Town area: a few structures at spawn
  // Simple campfire
  const fireGeo = new THREE.ConeGeometry(0.3, 0.8, 5);
  const fireMat = new THREE.MeshStandardMaterial({
    color: 0xff6600,
    emissive: 0xff4400,
    emissiveIntensity: 0.8,
  });
  const fire = new THREE.Mesh(fireGeo, fireMat);
  fire.position.set(0, getTerrainHeight(0, 0) + 0.4, 0);
  group.add(fire);

  // Fire light
  const fireLight = new THREE.PointLight(0xff6633, 2, 15);
  fireLight.position.set(0, getTerrainHeight(0, 0) + 1.5, 0);
  group.add(fireLight);

  // Stone circle around fire
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const rx = Math.cos(angle) * 3;
    const rz = Math.sin(angle) * 3;
    const stoneGeo = new THREE.BoxGeometry(0.6, 0.4, 0.6);
    const stoneMat = new THREE.MeshStandardMaterial({
      color: 0x666666,
      roughness: 1,
    });
    const stone = new THREE.Mesh(stoneGeo, stoneMat);
    stone.position.set(rx, getTerrainHeight(rx, rz) + 0.2, rz);
    stone.rotation.y = Math.random() * Math.PI;
    group.add(stone);
  }

  // Wooden signpost
  const postGeo = new THREE.BoxGeometry(0.2, 2.5, 0.2);
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b6914 });
  const post = new THREE.Mesh(postGeo, woodMat);
  post.position.set(5, getTerrainHeight(5, -3) + 1.25, -3);
  group.add(post);

  const signGeo = new THREE.BoxGeometry(2, 0.6, 0.1);
  const sign = new THREE.Mesh(signGeo, woodMat);
  sign.position.set(5, getTerrainHeight(5, -3) + 2.2, -3);
  group.add(sign);

  return group;
}

export function createLighting(scene) {
  // Ambient light
  const ambient = new THREE.AmbientLight(0x6688cc, 0.4);
  scene.add(ambient);

  // Directional sunlight
  const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
  sun.position.set(50, 80, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 200;
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  scene.add(sun);

  // Hemisphere light for sky/ground color blending
  const hemi = new THREE.HemisphereLight(0x87ceeb, 0x3a7d44, 0.3);
  scene.add(hemi);
}

export function createSky(scene) {
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.FogExp2(0x87ceeb, 0.003);
}
