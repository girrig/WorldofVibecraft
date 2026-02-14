import * as THREE from 'three';
import { WORLD_SIZE } from '../../shared/constants.js';

export function createTerrain() {
  const group = new THREE.Group();

  // Main ground plane
  const size = WORLD_SIZE;
  const geometry = new THREE.PlaneGeometry(size, size, 64, 64);
  geometry.rotateX(-Math.PI / 2);

  // Add subtle height variation
  const vertices = geometry.attributes.position.array;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i];
    const z = vertices[i + 2];
    vertices[i + 1] =
      Math.sin(x * 0.02) * 1.5 +
      Math.cos(z * 0.02) * 1.5 +
      Math.sin(x * 0.05 + z * 0.03) * 0.8;
  }
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0x3a7d44,
    roughness: 0.9,
    metalness: 0.0,
    flatShading: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  group.add(mesh);

  // Dirt paths — darker strips
  const pathGeo = new THREE.PlaneGeometry(4, 200);
  pathGeo.rotateX(-Math.PI / 2);
  const pathMat = new THREE.MeshStandardMaterial({
    color: 0x8b6914,
    roughness: 1,
  });
  const path1 = new THREE.Mesh(pathGeo, pathMat);
  path1.position.set(0, 0.05, 0);
  group.add(path1);

  const path2 = path1.clone();
  path2.rotation.y = Math.PI / 2;
  group.add(path2);

  return group;
}

export function getTerrainHeight(x, z) {
  return (
    Math.sin(x * 0.02) * 1.5 +
    Math.cos(z * 0.02) * 1.5 +
    Math.sin(x * 0.05 + z * 0.03) * 0.8
  );
}
