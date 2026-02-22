import * as THREE from 'three';

// ── Module state (populated by loadTerrain) ──
let heightData = null;   // Float32Array from heightmap.bin
let meta = null;         // parsed northshire_meta.json
let centerHeight = 0;    // height at grid center, used as Y=0 reference
const CENTER_COL = 192;  // middle of 385-wide grid
const CENTER_ROW = 192;

/**
 * Async loader — call before createTerrain().
 * Fetches the heightmap binary + meta JSON produced by extract_terrain.py.
 */
export async function loadTerrain() {
  const [metaResp, binResp] = await Promise.all([
    fetch('/assets/terrain/northshire_meta.json'),
    fetch('/assets/terrain/northshire_heightmap.bin'),
  ]);

  meta = await metaResp.json();
  const buf = await binResp.arrayBuffer();
  heightData = new Float32Array(buf);

  // Use the height at grid center as Y=0 reference
  const ci = CENTER_ROW * meta.gridWidth + CENTER_COL;
  centerHeight = heightData[ci] || 0;
}

/**
 * Build the terrain mesh group (9 tile meshes, one per ADT tile).
 * Must be called after loadTerrain() resolves.
 */
export function createTerrain() {
  const group = new THREE.Group();

  if (!heightData || !meta) {
    // Fallback: flat green plane if data didn't load
    const geo = new THREE.PlaneGeometry(1600, 1600, 8, 8);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a7d44, roughness: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
    return group;
  }

  const tilesX = meta.tiles.countX;  // 3
  const tilesY = meta.tiles.countY;  // 3

  for (let tileRow = 0; tileRow < tilesY; tileRow++) {
    for (let tileCol = 0; tileCol < tilesX; tileCol++) {
      group.add(createTileMesh(tileRow, tileCol));
    }
  }

  return group;
}

/**
 * Create one tile mesh (129x129 vertices = 128x128 quads).
 */
function createTileMesh(tileRow, tileCol) {
  const { gridWidth, cellSize } = meta;
  const V = 129; // vertices per axis per tile

  const positions = new Float32Array(V * V * 3);
  const uvs = new Float32Array(V * V * 2);

  for (let r = 0; r < V; r++) {
    for (let c = 0; c < V; c++) {
      const gr = tileRow * 128 + r;
      const gc = tileCol * 128 + c;
      const vi = r * V + c;

      // Grid -> Three.js: col = east(+X), row = south(+Z), height = Y
      positions[vi * 3]     = (gc - CENTER_COL) * cellSize;                  // x
      positions[vi * 3 + 1] = heightData[gr * gridWidth + gc] - centerHeight; // y
      positions[vi * 3 + 2] = (gr - CENTER_ROW) * cellSize;                  // z

      uvs[vi * 2]     = c / 128;
      uvs[vi * 2 + 1] = r / 128;
    }
  }

  // Two triangles per quad, 128x128 quads
  const indexCount = 128 * 128 * 6;
  const indices = new Uint32Array(indexCount);
  let idx = 0;
  for (let r = 0; r < 128; r++) {
    for (let c = 0; c < 128; c++) {
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

  // Texture
  const texIdx = tileRow * meta.tiles.countX + tileCol;
  const texture = new THREE.TextureLoader().load(
    `/assets/terrain/northshire_tex_${texIdx}.png`
  );
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.9,
    metalness: 0.0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
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
