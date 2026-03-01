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

export function addTrimeshCollider(tris, minY, maxY, tris3D) {
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
  colliders.push({ type: COLLIDER_TRIMESH, tris, minY, maxY, tris3D: tris3D || null });
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

function testCylinderVsTrimesh(px, pz, pRadius, tris, tris3D) {
  let deepest = null;
  let deepestDepth = 0;
  const numTris = tris.length / 6;
  for (let t = 0; t < numTris; t++) {
    // Skip walkable (floor) triangles — they handle vertical collision only.
    // Without this, standing on top of an object triggers XZ push-out from
    // the floor surface triangles, sliding the player off.
    if (tris3D) {
      const o3 = t * 9;
      const e1x = tris3D[o3+3] - tris3D[o3], e1y = tris3D[o3+4] - tris3D[o3+1], e1z = tris3D[o3+5] - tris3D[o3+2];
      const e2x = tris3D[o3+6] - tris3D[o3], e2y = tris3D[o3+7] - tris3D[o3+1], e2z = tris3D[o3+8] - tris3D[o3+2];
      const ny = e1z * e2x - e1x * e2z;
      const nLenSq = (e1y * e2z - e1z * e2y) ** 2 + ny * ny + (e1x * e2y - e1y * e2x) ** 2;
      if (nLenSq > 1e-10 && (ny * ny) / nLenSq >= MIN_WALKABLE_NORMAL_Y_SQ) continue;
    }

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

export function resolveMovement(startX, startZ, endX, endZ, playerY, grounded = true) {
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

  // Small tolerance: skip horizontal collision when player feet are near
  // collider top (standing on it). Prevents jitter during landing frames.
  // Only apply when grounded — airborne players need full wall collision
  // to prevent ghosting through the top portion of objects like planters.
  const ON_TOP_EPS = grounded ? 0.15 : 0;

  let prevNx = 0, prevNz = 0;

  for (let iter = 0; iter < MAX_SLIDE_ITERATIONS; iter++) {
    let deepest = null;
    let deepestDepth = 0;

    for (let i = 0; i < candidates.length; i++) {
      const c = colliders[candidates[i]];

      // Vertical overlap check (with tolerance for standing on top)
      if (playerMaxY <= c.minY || playerMinY >= c.maxY - ON_TOP_EPS) continue;

      let hit;
      if (c.type === COLLIDER_AABB) {
        hit = testCylinderVsAABB(posX, posZ, PLAYER_RADIUS, c.minX, c.minZ, c.maxX, c.maxZ);
      } else if (c.type === COLLIDER_OBB) {
        hit = testCylinderVsOBB(posX, posZ, PLAYER_RADIUS, c.cx, c.cz, c.halfW, c.halfD, c.cosA, c.sinA);
      } else if (c.type === COLLIDER_TRIMESH) {
        hit = testCylinderVsTrimesh(posX, posZ, PLAYER_RADIUS, c.tris, c.tris3D);
      } else {
        hit = testCylinderVsCylinder(posX, posZ, PLAYER_RADIUS, c.cx, c.cz, c.radius);
      }

      if (hit && hit.depth > deepestDepth) {
        deepest = hit;
        deepestDepth = hit.depth;
      }
    }

    if (!deepest) break;

    // Detect concave trap: consecutive push-outs in opposite directions
    // means we're bouncing between walls (trough, wheelbarrow, etc.)
    if (iter > 0) {
      const dot = deepest.nx * prevNx + deepest.nz * prevNz;
      if (dot < -0.5) {
        // Only revert if the start position is collision-free (player is
        // walking INTO the concave shape). If start is also inside, the
        // player is already trapped — let the push-out attempt proceed.
        let startClear = true;
        for (let j = 0; j < candidates.length; j++) {
          const sc = colliders[candidates[j]];
          if (playerMaxY <= sc.minY || playerMinY >= sc.maxY - ON_TOP_EPS) continue;
          let sh;
          if (sc.type === COLLIDER_AABB) sh = testCylinderVsAABB(startX, startZ, PLAYER_RADIUS, sc.minX, sc.minZ, sc.maxX, sc.maxZ);
          else if (sc.type === COLLIDER_OBB) sh = testCylinderVsOBB(startX, startZ, PLAYER_RADIUS, sc.cx, sc.cz, sc.halfW, sc.halfD, sc.cosA, sc.sinA);
          else if (sc.type === COLLIDER_TRIMESH) sh = testCylinderVsTrimesh(startX, startZ, PLAYER_RADIUS, sc.tris, sc.tris3D);
          else sh = testCylinderVsCylinder(startX, startZ, PLAYER_RADIUS, sc.cx, sc.cz, sc.radius);
          if (sh && sh.depth > PUSH_EPSILON) { startClear = false; break; }
        }
        // Start clear → walking INTO concave shape → block movement
        // Start inside → already trapped → freeze horizontal position (no jitter)
        // Either way, revert to start. Player can jump out vertically.
        return { x: startX, z: startZ };
      }
    }
    prevNx = deepest.nx;
    prevNz = deepest.nz;

    // Push player out of the deepest collision
    posX += deepest.nx * (deepest.depth + PUSH_EPSILON);
    posZ += deepest.nz * (deepest.depth + PUSH_EPSILON);
  }

  return { x: posX, z: posZ };
}

// ── Vertical collision: surface height query ──

const MIN_WALKABLE_NORMAL_Y = 0.574; // cos(55°) — WoW's walkable slope limit (55° from horizontal)
const MIN_WALKABLE_NORMAL_Y_SQ = MIN_WALKABLE_NORMAL_Y * MIN_WALKABLE_NORMAL_Y;

/**
 * Query the highest walkable collision surface at (px, pz) that the player
 * could stand on. Returns -Infinity if no surface found.
 *
 * @param {number} px - Player X position
 * @param {number} pz - Player Z position
 * @param {number} playerY - Player's current foot Y position
 * @param {number} stepHeight - Max height above playerY to auto-step onto
 */
export function getCollisionHeightAt(px, pz, playerY, stepHeight) {
  if (colliders.length === 0) return -Infinity;

  const candidates = queryGrid(px - PLAYER_RADIUS, pz - PLAYER_RADIUS,
                                px + PLAYER_RADIUS, pz + PLAYER_RADIUS);
  if (candidates.length === 0) return -Infinity;

  let maxSurfaceY = -Infinity;
  const maxAllowedY = playerY + stepHeight;

  for (let i = 0; i < candidates.length; i++) {
    const c = colliders[candidates[i]];

    // Quick Y-bounds: skip colliders entirely above step range or entirely below player
    if (c.minY > maxAllowedY) continue;

    if (c.type === COLLIDER_TRIMESH && c.tris3D) {
      // Test each 3D triangle for point-in-triangle (XZ) + Y interpolation
      const t3 = c.tris3D;
      const numTris = t3.length / 9;
      for (let t = 0; t < numTris; t++) {
        const o = t * 9;
        const ax = t3[o],   ay = t3[o+1], az = t3[o+2];
        const bx = t3[o+3], by = t3[o+4], bz = t3[o+5];
        const cx = t3[o+6], cy = t3[o+7], cz = t3[o+8];

        // Surface normal via cross product (e1 × e2)
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const ny = e1z * e2x - e1x * e2z;
        const nx = e1y * e2z - e1z * e2y;
        const nz = e1x * e2y - e1y * e2x;
        const nLenSq = nx * nx + ny * ny + nz * nz;
        if (nLenSq < 1e-10) continue;

        // Only consider roughly horizontal surfaces (walkable floors)
        const normalYSq = (ny * ny) / nLenSq;
        if (normalYSq < MIN_WALKABLE_NORMAL_Y_SQ) continue;

        // Point-in-triangle test (XZ projection) using barycentric coordinates
        const v0x = cx - ax, v0z = cz - az;
        const v1x = bx - ax, v1z = bz - az;
        const v2x = px - ax, v2z = pz - az;

        const dot00 = v0x * v0x + v0z * v0z;
        const dot01 = v0x * v1x + v0z * v1z;
        const dot02 = v0x * v2x + v0z * v2z;
        const dot11 = v1x * v1x + v1z * v1z;
        const dot12 = v1x * v2x + v1z * v2z;

        const denom = dot00 * dot11 - dot01 * dot01;
        if (Math.abs(denom) < 1e-10) continue;
        const inv = 1 / denom;

        const u = (dot11 * dot02 - dot01 * dot12) * inv; // weight for C
        const v = (dot00 * dot12 - dot01 * dot02) * inv; // weight for B

        if (u < -0.01 || v < -0.01 || u + v > 1.01) continue; // Outside triangle (small epsilon for edges)

        // Interpolate Y at player position
        const w = 1 - u - v; // weight for A
        const surfaceY = w * ay + v * by + u * cy;

        if (surfaceY <= maxAllowedY && surfaceY > maxSurfaceY) {
          maxSurfaceY = surfaceY;
        }
      }
    } else if (c.type === COLLIDER_AABB) {
      // Flat top of AABB
      if (px >= c.minX && px <= c.maxX && pz >= c.minZ && pz <= c.maxZ) {
        if (c.maxY <= maxAllowedY && c.maxY > maxSurfaceY) {
          maxSurfaceY = c.maxY;
        }
      }
    } else if (c.type === COLLIDER_OBB) {
      // Transform to local space and check if inside
      const dx = px - c.cx, dz = pz - c.cz;
      const localX = c.cosA * dx - c.sinA * dz;
      const localZ = c.sinA * dx + c.cosA * dz;
      if (localX >= -c.halfW && localX <= c.halfW && localZ >= -c.halfD && localZ <= c.halfD) {
        if (c.maxY <= maxAllowedY && c.maxY > maxSurfaceY) {
          maxSurfaceY = c.maxY;
        }
      }
    } else if (c.type === COLLIDER_CYLINDER) {
      const dx = px - c.cx, dz = pz - c.cz;
      if (dx * dx + dz * dz <= c.radius * c.radius) {
        if (c.maxY <= maxAllowedY && c.maxY > maxSurfaceY) {
          maxSurfaceY = c.maxY;
        }
      }
    }
  }

  return maxSurfaceY;
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
