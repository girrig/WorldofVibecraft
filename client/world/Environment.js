import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getTerrainHeight } from './Terrain.js';
import { WORLD_SIZE } from '../../shared/constants.js';

// ── Module state ──
let doodadData = null;
let manifest = null;
const modelCache = new Map();
const loadingModels = new Map();

/**
 * Async loader — call in startGame() alongside loadTerrain().
 * Loads doodad placement data and model manifest in parallel.
 */
export async function loadEnvironment() {
  const [doodadResp, manifestResp] = await Promise.all([
    fetch('/assets/terrain/northshire_doodads.json'),
    fetch('/assets/models/doodad_manifest.json').catch(() => null),
  ]);
  doodadData = await doodadResp.json();
  if (manifestResp && manifestResp.ok) {
    manifest = await manifestResp.json();
  }
}

// ── GLB loader with caching ──

function loadGLB(url) {
  if (modelCache.has(url)) return Promise.resolve(modelCache.get(url));
  if (loadingModels.has(url)) return loadingModels.get(url);

  const promise = new Promise((resolve, reject) => {
    new GLTFLoader().load(url, (gltf) => {
      modelCache.set(url, gltf);
      loadingModels.delete(url);
      resolve(gltf);
    }, undefined, (err) => {
      loadingModels.delete(url);
      reject(err);
    });
  });
  loadingModels.set(url, promise);
  return promise;
}

// ── Fallback placeholder shapes ──

const SHAPES = {
  vegetation: { color: 0x2d6b2d, yOffset: 2.0 },
  rock:       { color: 0x888888, yOffset: 0.5 },
  prop:       { color: 0xccaa66, yOffset: 0.75 },
  container:  { color: 0x8b6914, yOffset: 0.4 },
  misc:       { color: 0xdddddd, yOffset: 0.25 },
};

let geoVegetation, geoRock, geoProp, geoContainer, geoMisc;

function getGeometry(type) {
  if (!geoVegetation) {
    geoVegetation = new THREE.CylinderGeometry(0.3, 0.5, 4, 6);
    geoRock = new THREE.BoxGeometry(1.5, 1.0, 1.5);
    geoProp = new THREE.BoxGeometry(0.5, 1.5, 0.5);
    geoContainer = new THREE.BoxGeometry(1.0, 0.8, 0.6);
    geoMisc = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  }
  switch (type) {
    case 'vegetation': return geoVegetation;
    case 'rock': return geoRock;
    case 'prop': return geoProp;
    case 'container': return geoContainer;
    default: return geoMisc;
  }
}

function placeFallbackInstances(group, instances) {
  const type = instances[0]?.type || 'misc';
  const shape = SHAPES[type] || SHAPES.misc;
  const geom = getGeometry(type);
  const mat = new THREE.MeshStandardMaterial({
    color: shape.color,
    roughness: 0.85,
    metalness: 0.05,
  });

  const mesh = new THREE.InstancedMesh(geom, mat, instances.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < instances.length; i++) {
    const d = instances[i];
    const terrainY = getTerrainHeight(d.x, d.z);
    const y = terrainY + shape.yOffset * (d.scale || 1.0);
    dummy.position.set(d.x, y, d.z);
    dummy.rotation.set(0, (d.rotY || 0) * Math.PI / 180, 0);
    dummy.scale.setScalar(d.scale || 1.0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
}

function placeWMOFallback(group, wmo) {
  const sx = wmo.sizeX || 10;
  const sy = wmo.sizeY || 8;
  const sz = wmo.sizeZ || 10;

  const geom = new THREE.BoxGeometry(sx, sy, sz);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xc4a47a,
    roughness: 0.7,
    metalness: 0.1,
    transparent: true,
    opacity: 0.7,
  });
  const mesh = new THREE.Mesh(geom, mat);
  const terrainY = getTerrainHeight(wmo.x, wmo.z);
  mesh.position.set(wmo.x, terrainY + sy / 2, wmo.z);
  mesh.rotation.set(0, (wmo.rotY || 0) * Math.PI / 180, 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

// ── Model-based placement ──

async function loadAndPlaceModel(group, modelPath, instances) {
  const glbInfo = manifest?.models?.[modelPath];

  if (glbInfo) {
    try {
      const gltf = await loadGLB('/assets/models/' + glbInfo.glb);

      // Collect ALL meshes (trunk + canopy, etc.)
      const meshParts = [];
      gltf.scene.traverse((child) => {
        if (child.isMesh) {
          meshParts.push({ geometry: child.geometry, material: child.material });
        }
      });

      if (meshParts.length > 0) {
        // Pre-compute instance matrices once, shared by all parts
        const matrices = new Float32Array(instances.length * 16);
        const dummy = new THREE.Object3D();
        for (let i = 0; i < instances.length; i++) {
          const d = instances[i];
          const terrainY = getTerrainHeight(d.x, d.z);
          dummy.position.set(d.x, terrainY, d.z);
          dummy.rotation.set(0, (d.rotY || 0) * Math.PI / 180, 0);
          dummy.scale.setScalar(d.scale || 1.0);
          dummy.updateMatrix();
          dummy.matrix.toArray(matrices, i * 16);
        }

        // One InstancedMesh per mesh part
        for (const part of meshParts) {
          const mesh = new THREE.InstancedMesh(part.geometry, part.material, instances.length);
          mesh.instanceMatrix.array.set(matrices);
          mesh.instanceMatrix.needsUpdate = true;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
        }
        return;
      }
    } catch (e) {
      // Fall through to placeholder
    }
  }

  placeFallbackInstances(group, instances);
}

async function loadAndPlaceWMO(group, wmo) {
  const halfWorld = WORLD_SIZE / 2;
  if (Math.abs(wmo.x) > halfWorld || Math.abs(wmo.z) > halfWorld) return;
  if (wmo.sizeX > WORLD_SIZE || wmo.sizeZ > WORLD_SIZE) return;

  const glbInfo = manifest?.wmos?.[wmo.model];

  if (glbInfo) {
    try {
      const gltf = await loadGLB('/assets/models/' + glbInfo.glb);
      const model = gltf.scene.clone();

      const terrainY = getTerrainHeight(wmo.x, wmo.z);
      model.position.set(wmo.x, terrainY, wmo.z);
      model.rotation.set(0, (wmo.rotY || 0) * Math.PI / 180, 0);
      model.scale.setScalar(wmo.scale || 1.0);
      model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      group.add(model);
      return;
    } catch (e) {
      // Fall through to placeholder
    }
  }

  placeWMOFallback(group, wmo);
}

async function populateEnvironment(group) {
  const halfWorld = WORLD_SIZE / 2;

  // Group doodads by model path
  const byModel = {};
  for (const d of doodadData.doodads) {
    if (Math.abs(d.x) > halfWorld || Math.abs(d.z) > halfWorld) continue;
    if (!byModel[d.model]) byModel[d.model] = [];
    byModel[d.model].push(d);
  }

  // Load models in parallel batches of 10
  const entries = Object.entries(byModel);
  for (let i = 0; i < entries.length; i += 10) {
    const batch = entries.slice(i, i + 10);
    await Promise.all(batch.map(([modelPath, instances]) =>
      loadAndPlaceModel(group, modelPath, instances)
    ));
  }

  // WMOs
  for (const wmo of doodadData.wmos) {
    await loadAndPlaceWMO(group, wmo);
  }
}

/**
 * Create environment group. Returns immediately with an empty group,
 * then asynchronously populates it with loaded GLB models (or fallback placeholders).
 */
export function createEnvironment() {
  const group = new THREE.Group();
  if (!doodadData) return group;

  populateEnvironment(group).catch((err) =>
    console.warn('Environment population error:', err)
  );

  return group;
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
