import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WORLD_SIZE } from '../../shared/constants.js';
import { addAABBCollider, addTrimeshCollider, finalize as finalizeCollision } from './CollisionSystem.js';

// ── Module state ──
let doodadData = null;
let manifest = null;
let collisionMeshes = null;
const modelCache = new Map();
const loadingModels = new Map();

// ── Collision helpers ──

function registerDoodadColliders(modelPath, instances) {
  // Use Blizzard's actual M2 collision mesh triangles (extracted from MPQ)
  const meshData = collisionMeshes?.[modelPath];
  if (!meshData) return; // No collision data = non-collidable (bushes, birds, etc.)

  const modelVerts = meshData.verts; // flat [x0,y0,z0, ...] in glTF Y-up
  const triIndices = meshData.tris;  // flat [i0,i1,i2, ...] triangle indices
  if (!modelVerts || modelVerts.length < 9) return;
  if (!triIndices || triIndices.length < 3) return;

  const numVerts = modelVerts.length / 3;
  const numTris = triIndices.length / 3;

  const rotHelper = new THREE.Object3D();
  const v = new THREE.Vector3();

  for (const d of instances) {
    const s = d.scale || 1.0;

    rotHelper.rotation.set(
      (d.rotX || 0) * Math.PI / 180,
      (d.rotY || 0) * Math.PI / 180,
      -(d.rotZ || 0) * Math.PI / 180,
      'YZX'
    );
    rotHelper.updateMatrix();

    // Transform all collision vertices to world space
    const wx = new Float32Array(numVerts);
    const wy = new Float32Array(numVerts);
    const wz = new Float32Array(numVerts);
    let minY = Infinity, maxY = -Infinity;

    for (let i = 0; i < numVerts; i++) {
      v.set(
        modelVerts[i * 3] * s,
        modelVerts[i * 3 + 1] * s,
        modelVerts[i * 3 + 2] * s
      );
      v.applyMatrix4(rotHelper.matrix);
      wx[i] = v.x + d.x;
      wy[i] = v.y + d.y;
      wz[i] = v.z + d.z;
      if (wy[i] < minY) minY = wy[i];
      if (wy[i] > maxY) maxY = wy[i];
    }

    if (maxY - minY < 0.2) continue;

    // Build XZ triangle array (6 floats per tri: ax,az, bx,bz, cx,cz)
    const tris = new Float32Array(numTris * 6);
    for (let t = 0; t < numTris; t++) {
      const i0 = triIndices[t * 3];
      const i1 = triIndices[t * 3 + 1];
      const i2 = triIndices[t * 3 + 2];
      tris[t * 6]     = wx[i0];
      tris[t * 6 + 1] = wz[i0];
      tris[t * 6 + 2] = wx[i1];
      tris[t * 6 + 3] = wz[i1];
      tris[t * 6 + 4] = wx[i2];
      tris[t * 6 + 5] = wz[i2];
    }

    addTrimeshCollider(tris, minY, maxY);
  }
}

function registerWMOColliderFromGLB(wmo, gltf) {
  // Build the WMO placement matrix (same transform as visual placement)
  const placement = new THREE.Object3D();
  placement.position.set(wmo.x, wmo.y, wmo.z);
  placement.rotation.set(
    (wmo.rotX || 0) * Math.PI / 180,
    (wmo.rotY || 0) * Math.PI / 180,
    -(wmo.rotZ || 0) * Math.PI / 180,
    'YZX'
  );
  placement.scale.setScalar(wmo.scale || 1.0);
  placement.updateMatrix();

  gltf.scene.updateMatrixWorld(true);

  // Rasterize all mesh vertices onto a 2D XZ grid.
  // Cells with vertically-spanning geometry become wall colliders;
  // empty cells (doorways, interiors) remain passable.
  const CELL = 1.5;
  const grid = new Map();
  const v = new THREE.Vector3();

  gltf.scene.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    const pos = child.geometry.attributes.position;
    if (!pos) return;

    const combinedMatrix = new THREE.Matrix4();
    combinedMatrix.multiplyMatrices(placement.matrix, child.matrixWorld);

    const arr = pos.array;
    for (let i = 0; i < pos.count; i++) {
      v.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);
      v.applyMatrix4(combinedMatrix);

      const gx = Math.floor(v.x / CELL);
      const gz = Math.floor(v.z / CELL);
      const key = `${gx},${gz}`;

      let cell = grid.get(key);
      if (!cell) {
        cell = { gx, gz, minY: v.y, maxY: v.y, count: 0 };
        grid.set(key, cell);
      }
      if (v.y < cell.minY) cell.minY = v.y;
      if (v.y > cell.maxY) cell.maxY = v.y;
      cell.count++;
    }
  });

  // Create AABB colliders for grid cells with wall-like geometry
  for (const cell of grid.values()) {
    const h = cell.maxY - cell.minY;
    // Must have significant vertical extent (skip floor/ceiling-only cells)
    if (h < 1.0) continue;
    // Must have enough vertices to be a real structure
    if (cell.count < 4) continue;

    addAABBCollider(
      cell.gx * CELL, cell.gz * CELL,
      (cell.gx + 1) * CELL, (cell.gz + 1) * CELL,
      cell.minY, cell.maxY
    );
  }
}

/**
 * Async loader — call in startGame() alongside loadTerrain().
 * Loads doodad placement data and model manifest in parallel.
 */
export async function loadEnvironment() {
  const [doodadResp, manifestResp, collisionResp] = await Promise.all([
    fetch('/assets/terrain/northshire_doodads.json'),
    fetch('/assets/models/doodad_manifest.json').catch(() => null),
    fetch('/assets/models/collision_data.json').catch(() => null),
  ]);
  doodadData = await doodadResp.json();
  if (manifestResp && manifestResp.ok) {
    manifest = await manifestResp.json();
  }
  if (collisionResp && collisionResp.ok) {
    collisionMeshes = await collisionResp.json();
  }
}

/**
 * Preload ALL doodad and WMO models to completely eliminate lag spikes.
 * @param {Function} onProgress - Callback(percent, status) called with progress updates
 * @returns {Promise<void>}
 */
export function preloadEnvironmentModels(onProgress) {
  if (!manifest || !doodadData) {
    console.warn('loadEnvironment() must be called before preloadEnvironmentModels()');
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    // Collect all unique model paths from the manifest
    const allModels = [];

    // Add all doodad models
    if (manifest.models) {
      for (const [modelPath, info] of Object.entries(manifest.models)) {
        if (info.glb) {
          allModels.push({ type: 'doodad', glb: info.glb, path: modelPath });
        }
      }
    }

    // Add all WMO models
    if (manifest.wmos) {
      for (const [wmoPath, info] of Object.entries(manifest.wmos)) {
        if (info.glb) {
          allModels.push({ type: 'wmo', glb: info.glb, path: wmoPath });
        }
      }
    }

    const total = allModels.length;
    let loaded = 0;

    if (total === 0) {
      resolve();
      return;
    }

    const promises = allModels.map((model) => {
      const url = '/assets/models/' + model.glb;
      return loadGLB(url)
        .then(() => {
          loaded++;
          if (onProgress) {
            const percent = Math.round((loaded / total) * 100);
            const modelName = model.glb.split('/').pop().replace('.glb', '');
            onProgress(percent, modelName);
          }
        })
        .catch((err) => {
          console.warn(`Failed to preload ${model.glb}:`, err);
          loaded++;
          if (onProgress) {
            const percent = Math.round((loaded / total) * 100);
            onProgress(percent, 'error');
          }
        });
    });

    Promise.all(promises).then(() => resolve());
  });
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
    // Use Y coordinate from ADT data directly (already at correct height)
    dummy.position.set(d.x, d.y, d.z);
    dummy.rotation.set(
      (d.rotX || 0) * Math.PI / 180,
      (d.rotY || 0) * Math.PI / 180,
      -(d.rotZ || 0) * Math.PI / 180,
      'YZX'
    );
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
  // Use Y coordinate from ADT data directly (already at correct height)
  mesh.position.set(wmo.x, wmo.y, wmo.z);
  mesh.rotation.set(
    (wmo.rotX || 0) * Math.PI / 180,
    (wmo.rotY || 0) * Math.PI / 180,
    -(wmo.rotZ || 0) * Math.PI / 180,
    'YZX'
  );
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

      // Register collision shapes from M2 collision mesh data
      try {
        registerDoodadColliders(modelPath, instances);
      } catch (e) {
        // Collision registration failure shouldn't prevent visual placement
      }

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
          // Use Y coordinate from ADT data (more accurate than terrain mesh)
          dummy.position.set(d.x, d.y, d.z);
          dummy.rotation.set(
            (d.rotX || 0) * Math.PI / 180,
            (d.rotY || 0) * Math.PI / 180,
            -(d.rotZ || 0) * Math.PI / 180,
            'YZX'
          );
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

      // Register AABB collision from actual model geometry
      try {
        registerWMOColliderFromGLB(wmo, gltf);
      } catch (e) {
        // Collision registration failure shouldn't prevent visual placement
      }

      const model = gltf.scene.clone();

      // Use Y coordinate from ADT data (more accurate than terrain mesh)
      model.position.set(wmo.x, wmo.y, wmo.z);
      model.rotation.set(
        (wmo.rotX || 0) * Math.PI / 180,
        (wmo.rotY || 0) * Math.PI / 180,
        -(wmo.rotZ || 0) * Math.PI / 180,
        'YZX'
      );
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

  // Place all doodads (models are already preloaded, so this is instant)
  for (const [modelPath, instances] of Object.entries(byModel)) {
    loadAndPlaceModel(group, modelPath, instances);
  }

  // Place all WMOs (also preloaded)
  for (const wmo of doodadData.wmos) {
    loadAndPlaceWMO(group, wmo);
  }
}

/**
 * Create environment group and wait for it to be fully populated.
 * All models are preloaded, so population is instant.
 */
export async function createEnvironment() {
  const group = new THREE.Group();
  if (!doodadData) return group;

  await populateEnvironment(group).catch((err) =>
    console.warn('Environment population error:', err)
  );

  finalizeCollision();
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
