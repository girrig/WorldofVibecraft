import * as THREE from 'three';
import { PLAYER_RADIUS, PLAYER_HEIGHT } from '../../shared/constants.js';
import { getTerrainHeight } from './Terrain.js';

// ── Constants ──
const CELL_SIZE = 16;
const MAX_SLIDE_ITERATIONS = 3;
const PUSH_EPSILON = 0.001;

const COLLIDER_AABB = 0;
const COLLIDER_CYLINDER = 1;
const COLLIDER_OBB = 2;
const COLLIDER_TRIMESH = 3;

// ── Module state ──
const colliders = [];
const spatialGrid = new Map();

// ── Spatial hash helpers ──

function cellKey(cx, cz) {
  return ((cx + 0x8000) << 16) | (cz + 0x8000);
}

function insertIntoGrid(index, minX, minZ, maxX, maxZ) {
  const cMinX = Math.floor(minX / CELL_SIZE);
  const cMinZ = Math.floor(minZ / CELL_SIZE);
  const cMaxX = Math.floor(maxX / CELL_SIZE);
  const cMaxZ = Math.floor(maxZ / CELL_SIZE);
  for (let cx = cMinX; cx <= cMaxX; cx++) {
    for (let cz = cMinZ; cz <= cMaxZ; cz++) {
      const key = cellKey(cx, cz);
      let list = spatialGrid.get(key);
      if (!list) {
        list = [];
        spatialGrid.set(key, list);
      }
      list.push(index);
    }
  }
}

function queryGrid(minX, minZ, maxX, maxZ) {
  const cMinX = Math.floor(minX / CELL_SIZE);
  const cMinZ = Math.floor(minZ / CELL_SIZE);
  const cMaxX = Math.floor(maxX / CELL_SIZE);
  const cMaxZ = Math.floor(maxZ / CELL_SIZE);
  const result = [];
  const seen = new Set();
  for (let cx = cMinX; cx <= cMaxX; cx++) {
    for (let cz = cMinZ; cz <= cMaxZ; cz++) {
      const list = spatialGrid.get(cellKey(cx, cz));
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const idx = list[i];
          if (!seen.has(idx)) {
            seen.add(idx);
            result.push(idx);
          }
        }
      }
    }
  }
  return result;
}

// ── Collider registration ──

export function addCylinderCollider(cx, cz, radius, minY, maxY) {
  const index = colliders.length;
  colliders.push({
    type: COLLIDER_CYLINDER,
    cx, cz, radius, minY, maxY,
  });
  insertIntoGrid(index, cx - radius, cz - radius, cx + radius, cz + radius);
}

export function addAABBCollider(minX, minZ, maxX, maxZ, minY, maxY) {
  const index = colliders.length;
  colliders.push({
    type: COLLIDER_AABB,
    minX, minZ, maxX, maxZ, minY, maxY,
  });
  insertIntoGrid(index, minX, minZ, maxX, maxZ);
}

export function addOBBCollider(cx, cz, halfW, halfD, cosA, sinA, minY, maxY) {
  const index = colliders.length;
  colliders.push({
    type: COLLIDER_OBB,
    cx, cz, halfW, halfD, cosA, sinA, minY, maxY,
  });
  // World-space AABB of the rotated box for spatial grid insertion
  const extentX = Math.abs(halfW * cosA) + Math.abs(halfD * sinA);
  const extentZ = Math.abs(halfW * sinA) + Math.abs(halfD * cosA);
  insertIntoGrid(index, cx - extentX, cz - extentZ, cx + extentX, cz + extentZ);
}

export function addTrimeshCollider(tris, minY, maxY) {
  const index = colliders.length;
  // Compute XZ AABB from triangle vertices for spatial grid
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < tris.length; i += 2) {
    if (tris[i] < minX) minX = tris[i];
    if (tris[i] > maxX) maxX = tris[i];
    if (tris[i + 1] < minZ) minZ = tris[i + 1];
    if (tris[i + 1] > maxZ) maxZ = tris[i + 1];
  }
  colliders.push({ type: COLLIDER_TRIMESH, tris, minY, maxY });
  insertIntoGrid(index, minX, minZ, maxX, maxZ);
}

// ── Narrow-phase tests ──
// Return null if no collision, or { nx, nz, depth } push-out vector

function testCylinderVsAABB(px, pz, pRadius, minX, minZ, maxX, maxZ) {
  // Closest point on AABB to player center
  const clampedX = Math.max(minX, Math.min(px, maxX));
  const clampedZ = Math.max(minZ, Math.min(pz, maxZ));
  const dx = px - clampedX;
  const dz = pz - clampedZ;
  const distSq = dx * dx + dz * dz;

  if (distSq >= pRadius * pRadius) return null;

  // Player center is inside the AABB
  if (distSq < 1e-8) {
    // Push out toward nearest edge
    const dLeft = px - minX;
    const dRight = maxX - px;
    const dBack = pz - minZ;
    const dFront = maxZ - pz;
    const minDist = Math.min(dLeft, dRight, dBack, dFront);
    if (minDist === dLeft) return { nx: -1, nz: 0, depth: pRadius + dLeft };
    if (minDist === dRight) return { nx: 1, nz: 0, depth: pRadius + dRight };
    if (minDist === dBack) return { nx: 0, nz: -1, depth: pRadius + dBack };
    return { nx: 0, nz: 1, depth: pRadius + dFront };
  }

  const dist = Math.sqrt(distSq);
  return {
    nx: dx / dist,
    nz: dz / dist,
    depth: pRadius - dist,
  };
}

function testCylinderVsCylinder(px, pz, pRadius, cx, cz, cRadius) {
  const dx = px - cx;
  const dz = pz - cz;
  const distSq = dx * dx + dz * dz;
  const sumR = pRadius + cRadius;

  if (distSq >= sumR * sumR) return null;

  if (distSq < 1e-8) {
    // Exact overlap — push in +X arbitrarily
    return { nx: 1, nz: 0, depth: sumR };
  }

  const dist = Math.sqrt(distSq);
  return {
    nx: dx / dist,
    nz: dz / dist,
    depth: sumR - dist,
  };
}

function testCylinderVsOBB(px, pz, pRadius, obbCx, obbCz, halfW, halfD, cosA, sinA) {
  // Transform player position into OBB's local (unrotated) space
  const dx = px - obbCx;
  const dz = pz - obbCz;
  const localX = cosA * dx - sinA * dz;
  const localZ = sinA * dx + cosA * dz;

  // Reuse standard AABB test in local space (box centered at origin)
  const hit = testCylinderVsAABB(localX, localZ, pRadius, -halfW, -halfD, halfW, halfD);
  if (!hit) return null;

  // Rotate the push-out normal back to world space
  return {
    nx: cosA * hit.nx + sinA * hit.nz,
    nz: -sinA * hit.nx + cosA * hit.nz,
    depth: hit.depth,
  };
}

// ── Circle-vs-triangle (2D XZ plane) ──
// Tests player circle against a single collision triangle.
// This is the same narrow-phase test WoW uses with its M2 collision meshes.

function testCircleVsTriangle(px, pz, radius, ax, az, bx, bz, cx, cz) {
  // Find closest point on triangle boundary (3 edges) to circle center
  let minDistSq = Infinity;
  let closestX = ax, closestZ = az;

  // Edge AB
  let ex = bx - ax, ez = bz - az;
  let len = ex * ex + ez * ez;
  if (len > 1e-10) {
    let t = ((px - ax) * ex + (pz - az) * ez) / len;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cpx = ax + t * ex, cpz = az + t * ez;
    const dSq = (px - cpx) * (px - cpx) + (pz - cpz) * (pz - cpz);
    if (dSq < minDistSq) { minDistSq = dSq; closestX = cpx; closestZ = cpz; }
  }

  // Edge BC
  ex = cx - bx; ez = cz - bz;
  len = ex * ex + ez * ez;
  if (len > 1e-10) {
    let t = ((px - bx) * ex + (pz - bz) * ez) / len;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cpx = bx + t * ex, cpz = bz + t * ez;
    const dSq = (px - cpx) * (px - cpx) + (pz - cpz) * (pz - cpz);
    if (dSq < minDistSq) { minDistSq = dSq; closestX = cpx; closestZ = cpz; }
  }

  // Edge CA
  ex = ax - cx; ez = az - cz;
  len = ex * ex + ez * ez;
  if (len > 1e-10) {
    let t = ((px - cx) * ex + (pz - cz) * ez) / len;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cpx = cx + t * ex, cpz = cz + t * ez;
    const dSq = (px - cpx) * (px - cpx) + (pz - cpz) * (pz - cpz);
    if (dSq < minDistSq) { minDistSq = dSq; closestX = cpx; closestZ = cpz; }
  }

  // Check if center is inside triangle (cross product winding test)
  const d1 = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
  const d2 = (cx - bx) * (pz - bz) - (cz - bz) * (px - bx);
  const d3 = (ax - cx) * (pz - cz) - (az - cz) * (px - cx);
  const inside = (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);

  if (inside) {
    // Center is inside triangle — push out to nearest edge
    const dist = Math.sqrt(minDistSq);
    if (dist < 1e-8) return { nx: 1, nz: 0, depth: radius };
    return {
      nx: (closestX - px) / dist,
      nz: (closestZ - pz) / dist,
      depth: radius + dist,
    };
  }

  // Center is outside — check if closest boundary point is within radius
  if (minDistSq >= radius * radius) return null;

  const dist = Math.sqrt(minDistSq);
  if (dist < 1e-8) return { nx: 1, nz: 0, depth: radius };
  return {
    nx: (px - closestX) / dist,
    nz: (pz - closestZ) / dist,
    depth: radius - dist,
  };
}

function testCylinderVsTrimesh(px, pz, pRadius, tris) {
  let deepest = null;
  let deepestDepth = 0;
  const numTris = tris.length / 6;
  for (let t = 0; t < numTris; t++) {
    const o = t * 6;
    const hit = testCircleVsTriangle(px, pz, pRadius,
      tris[o], tris[o + 1], tris[o + 2], tris[o + 3], tris[o + 4], tris[o + 5]);
    if (hit && hit.depth > deepestDepth) {
      deepest = hit;
      deepestDepth = hit.depth;
    }
  }
  return deepest;
}

// ── Movement resolution ──

export function resolveMovement(startX, startZ, endX, endZ, playerY) {
  if (colliders.length === 0) return { x: endX, z: endZ };

  // Broad-phase: query swept bounding rect expanded by player radius
  const qMinX = Math.min(startX, endX) - PLAYER_RADIUS;
  const qMinZ = Math.min(startZ, endZ) - PLAYER_RADIUS;
  const qMaxX = Math.max(startX, endX) + PLAYER_RADIUS;
  const qMaxZ = Math.max(startZ, endZ) + PLAYER_RADIUS;
  const candidates = queryGrid(qMinX, qMinZ, qMaxX, qMaxZ);

  if (candidates.length === 0) return { x: endX, z: endZ };

  const playerMinY = playerY;
  const playerMaxY = playerY + PLAYER_HEIGHT;

  let posX = endX;
  let posZ = endZ;

  for (let iter = 0; iter < MAX_SLIDE_ITERATIONS; iter++) {
    let deepest = null;
    let deepestDepth = 0;

    for (let i = 0; i < candidates.length; i++) {
      const c = colliders[candidates[i]];

      // Vertical overlap check
      if (playerMaxY <= c.minY || playerMinY >= c.maxY) continue;

      let hit;
      if (c.type === COLLIDER_AABB) {
        hit = testCylinderVsAABB(posX, posZ, PLAYER_RADIUS, c.minX, c.minZ, c.maxX, c.maxZ);
      } else if (c.type === COLLIDER_OBB) {
        hit = testCylinderVsOBB(posX, posZ, PLAYER_RADIUS, c.cx, c.cz, c.halfW, c.halfD, c.cosA, c.sinA);
      } else if (c.type === COLLIDER_TRIMESH) {
        hit = testCylinderVsTrimesh(posX, posZ, PLAYER_RADIUS, c.tris);
      } else {
        hit = testCylinderVsCylinder(posX, posZ, PLAYER_RADIUS, c.cx, c.cz, c.radius);
      }

      if (hit && hit.depth > deepestDepth) {
        deepest = hit;
        deepestDepth = hit.depth;
      }
    }

    if (!deepest) break;

    // Push player out of the deepest collision
    posX += deepest.nx * (deepest.depth + PUSH_EPSILON);
    posZ += deepest.nz * (deepest.depth + PUSH_EPSILON);
  }

  return { x: posX, z: posZ };
}

// ── Debug / stats ──

export function finalize() {
  console.log(`Collision system: ${colliders.length} colliders, ${spatialGrid.size} grid cells`);

  // Debug: log colliders near spawn (-132, 148)
  const spawnX = -132, spawnZ = 148;
  const nearby = [];
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    let dist;
    if (c.type === COLLIDER_CYLINDER) {
      dist = Math.sqrt((c.cx - spawnX) ** 2 + (c.cz - spawnZ) ** 2) - c.radius;
    } else if (c.type === COLLIDER_OBB) {
      const dx = spawnX - c.cx, dz = spawnZ - c.cz;
      const lx = c.cosA * dx - c.sinA * dz;
      const lz = c.sinA * dx + c.cosA * dz;
      const clX = Math.max(-c.halfW, Math.min(lx, c.halfW));
      const clZ = Math.max(-c.halfD, Math.min(lz, c.halfD));
      dist = Math.sqrt((lx - clX) ** 2 + (lz - clZ) ** 2);
    } else if (c.type === COLLIDER_TRIMESH) {
      // Min distance from spawn to any triangle vertex
      dist = Infinity;
      for (let j = 0; j < c.tris.length; j += 2) {
        const dd = Math.sqrt((c.tris[j] - spawnX) ** 2 + (c.tris[j + 1] - spawnZ) ** 2);
        if (dd < dist) dist = dd;
      }
    } else {
      const clX = Math.max(c.minX, Math.min(spawnX, c.maxX));
      const clZ = Math.max(c.minZ, Math.min(spawnZ, c.maxZ));
      dist = Math.sqrt((spawnX - clX) ** 2 + (spawnZ - clZ) ** 2);
    }
    if (dist < 5) {
      nearby.push({ i, dist: dist.toFixed(2), type: c.type });
    }
  }
  if (nearby.length > 0) {
    console.warn('Colliders within 5 units of spawn:', nearby);
  }
}

export function getStats() {
  return { colliderCount: colliders.length, cellCount: spatialGrid.size };
}

export function getColliders() {
  return colliders;
}

export function createDebugMeshes() {
  const group = new THREE.Group();
  group.name = 'collision-debug';

  const cylMat = new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true });
  const aabbMat = new THREE.MeshBasicMaterial({ color: 0xff4400, wireframe: true });
  const obbMat = new THREE.MeshBasicMaterial({ color: 0xff8800, wireframe: true });

  // Collect all trimesh triangles into one batched mesh
  const trimeshPositions = [];

  for (const c of colliders) {
    if (c.type === COLLIDER_CYLINDER) {
      const h = c.maxY - c.minY;
      const geom = new THREE.CylinderGeometry(c.radius, c.radius, h, 8);
      const mesh = new THREE.Mesh(geom, cylMat);
      mesh.position.set(c.cx, c.minY + h / 2, c.cz);
      group.add(mesh);
    } else if (c.type === COLLIDER_OBB) {
      const h = c.maxY - c.minY;
      const geom = new THREE.BoxGeometry(c.halfW * 2, h, c.halfD * 2);
      const mesh = new THREE.Mesh(geom, obbMat);
      mesh.position.set(c.cx, c.minY + h / 2, c.cz);
      mesh.rotation.y = Math.atan2(c.sinA, c.cosA);
      group.add(mesh);
    } else if (c.type === COLLIDER_TRIMESH) {
      const numTris = c.tris.length / 6;
      for (let t = 0; t < numTris; t++) {
        const o = t * 6;
        // tris stores XZ pairs: ax,az, bx,bz, cx,cz
        const ax = c.tris[o], az = c.tris[o + 1];
        const bx = c.tris[o + 2], bz = c.tris[o + 3];
        const cx = c.tris[o + 4], cz = c.tris[o + 5];
        // Sample terrain at centroid and raise slightly above
        const centX = (ax + bx + cx) / 3;
        const centZ = (az + bz + cz) / 3;
        const y = getTerrainHeight(centX, centZ) + 0.3;
        trimeshPositions.push(
          ax, y, az,
          bx, y, bz,
          cx, y, cz
        );
      }
    } else {
      const w = c.maxX - c.minX;
      const h = c.maxY - c.minY;
      const d = c.maxZ - c.minZ;
      const geom = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geom, aabbMat);
      mesh.position.set(c.minX + w / 2, c.minY + h / 2, c.minZ + d / 2);
      group.add(mesh);
    }
  }

  // Single batched mesh for all trimesh colliders (avoids 3000+ individual meshes)
  if (trimeshPositions.length > 0) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array(trimeshPositions), 3
    ));
    const trimeshMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true });
    const mesh = new THREE.Mesh(geom, trimeshMat);
    group.add(mesh);
  }

  return group;
}
