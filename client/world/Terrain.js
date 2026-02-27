import * as THREE from 'three';
import { createTerrainMaterial, createAlphaTexture, loadTerrainTexture } from './TerrainShader.js';

// ── Module state (populated by loadTerrain) ──
let heightData = null;   // Float32Array from heightmap.bin
let meta = null;         // parsed northshire_meta.json
let chunkData = null;    // chunk-level texture/alpha data
let textureMapping = null; // BLP path -> WebP filename mapping
let centerHeight = 0;    // height at grid center, used as Y=0 reference
const CENTER_COL = 192;  // middle of 385-wide grid
const CENTER_ROW = 192;

// Texture cache for loaded terrain textures
const terrainTextureCache = new Map();

/**
 * Async loader — call before createTerrain().
 * Fetches the heightmap binary + meta JSON + chunk data produced by extract_terrain.py.
 */
export async function loadTerrain() {
  const [metaResp, binResp, chunksResp, mappingResp] = await Promise.all([
    fetch('/assets/terrain/northshire_meta.json'),
    fetch('/assets/terrain/northshire_heightmap.bin'),
    fetch('/assets/terrain/northshire_chunks.json'),
    fetch('/assets/terrain/texture_mapping.json'),
  ]);

  meta = await metaResp.json();
  const buf = await binResp.arrayBuffer();
  heightData = new Float32Array(buf);
  chunkData = await chunksResp.json();
  textureMapping = await mappingResp.json();

  // Use the height at grid center as Y=0 reference
  const ci = CENTER_ROW * meta.gridWidth + CENTER_COL;
  centerHeight = heightData[ci] || 0;

  console.log(`Loaded terrain: ${chunkData.chunks.length} chunks, ${chunkData.uniqueTextures.length} textures`);
}

/**
 * Preload all unique terrain textures with progress tracking.
 * @param {Function} onProgress - Callback(percent) called with 0-100 percent complete
 * @returns {Promise<void>}
 */
export async function preloadTerrainTextures(onProgress) {
  if (!chunkData || !textureMapping) {
    console.warn('loadTerrain() must be called before preloadTerrainTextures()');
    return;
  }

  const uniqueTextures = chunkData.uniqueTextures;
  const totalTextures = uniqueTextures.length;
  let loaded = 0;

  const promises = uniqueTextures.map(async (blpPath) => {
    const webpFilename = textureMapping[blpPath];
    if (!webpFilename) {
      console.warn(`No mapping found for texture: ${blpPath}`);
      return;
    }

    try {
      const texture = await loadTerrainTexture(webpFilename);
      terrainTextureCache.set(blpPath, texture);

      loaded++;
      if (onProgress) onProgress(Math.round((loaded / totalTextures) * 100));
    } catch (err) {
      console.error(`Failed to load texture ${blpPath} (${webpFilename}):`, err);
    }
  });

  await Promise.all(promises);
  console.log(`Preloaded ${terrainTextureCache.size}/${totalTextures} terrain textures`);
}

/**
 * Build the terrain mesh group (chunk-based meshes with shader materials).
 * Must be called after loadTerrain() and preloadTerrainTextures() resolve.
 */
export function createTerrain() {
  const group = new THREE.Group();

  if (!heightData || !meta || !chunkData) {
    // Fallback: flat green plane if data didn't load
    const geo = new THREE.PlaneGeometry(1600, 1600, 8, 8);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a7d44, roughness: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
    return group;
  }

  // Create chunk meshes with shader materials
  let chunksRendered = 0;
  for (const chunk of chunkData.chunks) {
    const mesh = createChunkMesh(chunk);
    if (mesh) {
      group.add(mesh);
      chunksRendered++;
    }
  }

  console.log(`Created ${chunksRendered} chunk meshes`);
  return group;
}

/**
 * Create one chunk mesh (9x9 vertices = 8x8 quads).
 * @param {Object} chunk - Chunk data from northshire_chunks.json
 */
function createChunkMesh(chunk) {
  const { tileX, tileY, chunkX, chunkY, layers } = chunk;

  if (!layers || layers.length === 0) {
    return null; // Skip chunks with no texture layers
  }

  const { gridWidth, cellSize } = meta;
  const startTileX = meta.tiles.startX;
  const startTileY = meta.tiles.startY;

  // Each chunk = 8x8 quads = 9x9 vertices
  const V = 9;
  const positions = new Float32Array(V * V * 3);
  const uvs = new Float32Array(V * V * 2);

  // Calculate grid offset for this chunk
  const tileGridCol = (tileX - startTileX) * 128;
  const tileGridRow = (tileY - startTileY) * 128;
  const chunkGridCol = tileGridCol + chunkX * 8;
  const chunkGridRow = tileGridRow + chunkY * 8;

  for (let r = 0; r < V; r++) {
    for (let c = 0; c < V; c++) {
      const gr = chunkGridRow + r;
      const gc = chunkGridCol + c;
      const vi = r * V + c;

      // Grid -> Three.js: col = east(+X), row = south(+Z), height = Y
      positions[vi * 3]     = (gc - CENTER_COL) * cellSize;                  // x
      positions[vi * 3 + 1] = heightData[gr * gridWidth + gc] - centerHeight; // y
      positions[vi * 3 + 2] = (gr - CENTER_ROW) * cellSize;                  // z

      // UVs are chunk-local (0-1 per chunk) for alpha map sampling
      uvs[vi * 2]     = c / 8;
      uvs[vi * 2 + 1] = r / 8;
    }
  }

  // Two triangles per quad, 8x8 quads
  const indexCount = 8 * 8 * 6;
  const indices = new Uint32Array(indexCount);
  let idx = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const a = r * V + c;
      const b = a + 1;
      const d = (r + 1) * V + c;
      const e = d + 1;
      indices[idx++] = a;
      indices[idx++] = d;
      indices[idx++] = b;
      indices[idx++] = b;
      indices[idx++] = d;
      indices[idx++] = e;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  // Create shader material with texture layers
  const material = createChunkMaterial(layers);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  return mesh;
}

/**
 * Create a shader material for a chunk based on its texture layers.
 * @param {Array} layers - Layer data from chunk
 */
function createChunkMaterial(layers) {
  // Get base texture (layer 0)
  const baseLayer = layers[0];
  const baseTexture = terrainTextureCache.get(baseLayer.texturePath);

  if (!baseTexture) {
    console.warn(`Base texture not loaded: ${baseLayer.texturePath}`);
    // Fallback material
    return new THREE.MeshStandardMaterial({ color: 0x3a7d44, roughness: 0.9 });
  }

  // Get overlay textures and alpha maps (layers 1-3)
  const overlayTextures = [];
  const alphaMaps = [];

  for (let i = 1; i < layers.length && i <= 3; i++) {
    const layer = layers[i];
    const texture = terrainTextureCache.get(layer.texturePath);

    if (texture && layer.alphaMap) {
      overlayTextures.push(texture);
      alphaMaps.push(createAlphaTexture(layer.alphaMap));
    }
  }

  // Create shader material (uses world-space positions for continuous tiling)
  return createTerrainMaterial({
    baseTexture,
    overlayTextures,
    alphaMaps,
    textureScale: 4.0,      // Tile textures globally
    alphaSharpening: 1.0,   // No sharpening - use raw alpha values
  });
}

/**
 * Get terrain height at a Three.js (x, z) position via bilinear interpolation.
 * Returns 0 before terrain data is loaded.
 */
export function getTerrainHeight(x, z) {
  if (!heightData || !meta) return 0;

  const { gridWidth, gridHeight, cellSize } = meta;

  // Three.js coords -> grid position
  const col = x / cellSize + CENTER_COL;
  const row = z / cellSize + CENTER_ROW;

  // Clamp to valid grid range
  const maxC = gridWidth - 2;
  const maxR = gridHeight - 2;
  const c = Math.max(0, Math.min(maxC, Math.floor(col)));
  const r = Math.max(0, Math.min(maxR, Math.floor(row)));

  // Fractional part for interpolation
  const fc = Math.max(0, Math.min(1, col - c));
  const fr = Math.max(0, Math.min(1, row - r));

  // Four corner heights
  const h00 = heightData[r * gridWidth + c];
  const h10 = heightData[r * gridWidth + c + 1];
  const h01 = heightData[(r + 1) * gridWidth + c];
  const h11 = heightData[(r + 1) * gridWidth + c + 1];

  // Bilinear interpolation, offset by centerHeight so grid center = Y 0
  return (
    h00 * (1 - fc) * (1 - fr) +
    h10 * fc * (1 - fr) +
    h01 * (1 - fc) * fr +
    h11 * fc * fr
  ) - centerHeight;
}
