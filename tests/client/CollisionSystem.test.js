import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('three', () => import('../__mocks__/three.js'));

import { PLAYER_RADIUS, PLAYER_HEIGHT } from '../../shared/constants.js';

// Each test suite gets a fresh module to avoid shared collider state
async function freshModule() {
  vi.resetModules();
  return import('../../client/world/CollisionSystem.js');
}

// ── AABB colliders ──

describe('CollisionSystem — AABB', () => {
  let mod;

  beforeEach(async () => {
    mod = await freshModule();
  });

  it('exports expected functions', () => {
    expect(typeof mod.addAABBCollider).toBe('function');
    expect(typeof mod.addCylinderCollider).toBe('function');
    expect(typeof mod.addOBBCollider).toBe('function');
    expect(typeof mod.addTrimeshCollider).toBe('function');
    expect(typeof mod.resolveMovement).toBe('function');
    expect(typeof mod.finalize).toBe('function');
    expect(typeof mod.getStats).toBe('function');
    expect(typeof mod.getColliders).toBe('function');
    expect(typeof mod.createDebugMeshes).toBe('function');
  });

  it('resolveMovement is pass-through with no colliders', () => {
    const result = mod.resolveMovement(0, 0, 5, 5, 0);
    expect(result).toEqual({ x: 5, z: 5 });
  });

  it('blocks movement into an AABB', () => {
    // Place a box at (10, 10) to (12, 12), height 0-2
    mod.addAABBCollider(10, 10, 12, 12, 0, 2);
    // Try to walk from (9, 11) into the box at (11, 11)
    const result = mod.resolveMovement(9, 11, 11, 11, 0);
    // Should be pushed back — x should be less than 10 - PLAYER_RADIUS
    expect(result.x).toBeLessThanOrEqual(10 - PLAYER_RADIUS + 0.01);
  });

  it('allows movement parallel to AABB (wall sliding)', () => {
    mod.addAABBCollider(10, 0, 12, 20, 0, 2);
    // Walk along the wall: start at (9.5, 5), try to go to (11, 10)
    const result = mod.resolveMovement(9.5, 5, 11, 10, 0);
    // X should be blocked, but Z should progress
    expect(result.x).toBeLessThanOrEqual(10 - PLAYER_RADIUS + 0.01);
    expect(result.z).toBeGreaterThan(5);
  });

  it('allows movement when AABB is vertically out of range', () => {
    // AABB at height 10-12, player at y=0 (height 0 to PLAYER_HEIGHT)
    mod.addAABBCollider(10, 10, 12, 12, 10, 12);
    const result = mod.resolveMovement(9, 11, 11, 11, 0);
    // No vertical overlap, should pass through
    expect(result).toEqual({ x: 11, z: 11 });
  });

  it('getStats reflects registered colliders', () => {
    mod.addAABBCollider(0, 0, 5, 5, 0, 2);
    mod.addAABBCollider(20, 20, 25, 25, 0, 2);
    const stats = mod.getStats();
    expect(stats.colliderCount).toBe(2);
    expect(stats.cellCount).toBeGreaterThan(0);
  });

  it('getColliders returns all registered colliders', () => {
    mod.addAABBCollider(0, 0, 1, 1, 0, 1);
    expect(mod.getColliders().length).toBe(1);
  });

  it('finalize logs without errors', () => {
    mod.addAABBCollider(0, 0, 5, 5, 0, 2);
    expect(() => mod.finalize()).not.toThrow();
  });
});

// ── Cylinder colliders ──

describe('CollisionSystem — Cylinder', () => {
  let mod;

  beforeEach(async () => {
    mod = await freshModule();
  });

  it('blocks movement into a cylinder', () => {
    // Cylinder at (10, 10), radius 1, height 0-3
    mod.addCylinderCollider(10, 10, 1, 0, 3);
    const result = mod.resolveMovement(8, 10, 10, 10, 0);
    // Should be pushed out — distance from (result.x, result.z) to (10,10) >= 1 + PLAYER_RADIUS
    const dist = Math.sqrt((result.x - 10) ** 2 + (result.z - 10) ** 2);
    expect(dist).toBeGreaterThanOrEqual(1 + PLAYER_RADIUS - 0.01);
  });

  it('allows movement past a cylinder with clearance', () => {
    mod.addCylinderCollider(10, 10, 0.5, 0, 3);
    // Walk from (10, 5) to (10, 15) — passes right through center
    const result = mod.resolveMovement(10, 5, 10, 15, 0);
    // Should be deflected but z should progress
    expect(result.z).toBeGreaterThan(5);
  });

  it('skips cylinder when vertically out of range', () => {
    mod.addCylinderCollider(10, 10, 1, 10, 15);
    const result = mod.resolveMovement(8, 10, 10, 10, 0);
    expect(result).toEqual({ x: 10, z: 10 });
  });
});

// ── OBB colliders ──

describe('CollisionSystem — OBB', () => {
  let mod;

  beforeEach(async () => {
    mod = await freshModule();
  });

  it('blocks movement into an axis-aligned OBB', () => {
    // OBB centered at (10, 10), halfW=2, halfD=2, no rotation — square box
    mod.addOBBCollider(10, 10, 2, 2, 1, 0, 0, 3); // cos=1, sin=0 → no rotation
    const result = mod.resolveMovement(7, 10, 10, 10, 0);
    // Player should end up outside the box (pushed away from center)
    const dx = result.x - 10, dz = result.z - 10;
    const dist = Math.sqrt(dx * dx + dz * dz);
    expect(dist).toBeGreaterThan(0);
    // Should not reach the center
    expect(result.x).not.toBeCloseTo(10, 0);
  });

  it('blocks movement into a rotated OBB', () => {
    // OBB at (10, 10), halfW=3, halfD=1, rotated 45 degrees
    const cos45 = Math.cos(Math.PI / 4);
    const sin45 = Math.sin(Math.PI / 4);
    mod.addOBBCollider(10, 10, 3, 1, cos45, sin45, 0, 3);
    // Walk into it from below-left
    const result = mod.resolveMovement(7, 7, 10, 10, 0);
    const dist = Math.sqrt((result.x - 10) ** 2 + (result.z - 10) ** 2);
    // Should be pushed away from center
    expect(dist).toBeGreaterThan(0.5);
  });

  it('allows movement past OBB when vertically out of range', () => {
    mod.addOBBCollider(10, 10, 2, 1, 1, 0, 10, 15);
    const result = mod.resolveMovement(7, 10, 10, 10, 0);
    expect(result).toEqual({ x: 10, z: 10 });
  });
});

// ── Trimesh colliders ──

describe('CollisionSystem — Trimesh', () => {
  let mod;

  beforeEach(async () => {
    mod = await freshModule();
  });

  // Helper: create a simple square trimesh (two triangles) at given position
  function squareTrimesh(cx, cz, halfSize) {
    const l = cx - halfSize, r = cx + halfSize;
    const b = cz - halfSize, t = cz + halfSize;
    // Two triangles forming a square: (l,b)-(r,b)-(r,t) and (l,b)-(r,t)-(l,t)
    return new Float32Array([
      l, b, r, b, r, t,  // tri 1
      l, b, r, t, l, t,  // tri 2
    ]);
  }

  it('blocks movement into a trimesh', () => {
    const tris = squareTrimesh(10, 10, 2); // 2-unit half-size square at (10,10)
    mod.addTrimeshCollider(tris, 0, 3);
    const result = mod.resolveMovement(7, 10, 10, 10, 0);
    // Should be pushed out of the triangles — not at the desired endpoint
    const dist = Math.sqrt((result.x - 10) ** 2 + (result.z - 10) ** 2);
    expect(dist).toBeGreaterThan(PLAYER_RADIUS - 0.1);
    expect(result.x !== 10 || result.z !== 10).toBe(true);
  });

  it('freezes player when starting inside concave trimesh (prevents jitter)', () => {
    const tris = squareTrimesh(10, 10, 5); // large square (shared diagonal = concave seam)
    mod.addTrimeshCollider(tris, 0, 3);
    // Start and end both inside — concave trap freezes position to prevent jitter
    const result = mod.resolveMovement(10, 10, 10.1, 10, 0);
    expect(result.x).toBe(10);
    expect(result.z).toBe(10);
  });

  it('allows movement when trimesh is vertically out of range', () => {
    const tris = squareTrimesh(10, 10, 2);
    mod.addTrimeshCollider(tris, 10, 15); // way above player
    const result = mod.resolveMovement(7, 10, 10, 10, 0);
    expect(result).toEqual({ x: 10, z: 10 });
  });

  it('allows movement when not touching trimesh', () => {
    const tris = squareTrimesh(100, 100, 2); // far away
    mod.addTrimeshCollider(tris, 0, 3);
    const result = mod.resolveMovement(0, 0, 5, 5, 0);
    expect(result).toEqual({ x: 5, z: 5 });
  });

  it('wall slides along trimesh edge', () => {
    // Long thin rectangle along Z axis: from x=9 to x=11, z=0 to z=100
    const tris = new Float32Array([
      9, 0, 11, 0, 11, 100,  // tri 1
      9, 0, 11, 100, 9, 100, // tri 2
    ]);
    mod.addTrimeshCollider(tris, 0, 3);
    // Walk diagonally into the wall
    const result = mod.resolveMovement(8, 5, 10, 15, 0);
    // X should be blocked, Z should progress
    expect(result.x).toBeLessThanOrEqual(9 - PLAYER_RADIUS + 0.1);
    expect(result.z).toBeGreaterThan(5);
  });

  it('handles single triangle', () => {
    // Single triangle centered roughly at (10,9.3)
    const tris = new Float32Array([
      8, 8, 12, 8, 10, 12,
    ]);
    mod.addTrimeshCollider(tris, 0, 3);
    // Walk into the triangle
    const result = mod.resolveMovement(7, 10, 10, 10, 0);
    // Player should be pushed out — not at the exact target
    expect(result.x !== 10 || result.z !== 10).toBe(true);
  });

  it('collider count includes trimesh', () => {
    const tris = squareTrimesh(0, 0, 1);
    mod.addTrimeshCollider(tris, 0, 1);
    mod.addTrimeshCollider(tris, 0, 1);
    expect(mod.getStats().colliderCount).toBe(2);
  });
});

// ── Mixed collider types ──

describe('CollisionSystem — Mixed', () => {
  let mod;

  beforeEach(async () => {
    mod = await freshModule();
  });

  it('resolves against deepest collision from mixed types', () => {
    // AABB at (10, 10)
    mod.addAABBCollider(9, 9, 11, 11, 0, 3);
    // Cylinder at (10, 15)
    mod.addCylinderCollider(10, 15, 1, 0, 3);

    // Walk toward the AABB
    const result = mod.resolveMovement(7, 10, 10, 10, 0);
    expect(result.x).toBeLessThan(9);
  });

  it('handles multiple iterations for corner cases', () => {
    // Two AABBs forming an L-shape
    mod.addAABBCollider(10, 0, 12, 10, 0, 3); // vertical wall
    mod.addAABBCollider(0, 10, 10, 12, 0, 3); // horizontal wall
    // Walk into the corner
    const result = mod.resolveMovement(11, 11, 11, 11, 0);
    // Should be pushed out of both
    expect(result.x).toBeLessThan(12 + PLAYER_RADIUS);
    expect(result.z).toBeLessThan(12 + PLAYER_RADIUS);
  });
});

// ── Debug mesh creation ──

describe('CollisionSystem — createDebugMeshes', () => {
  let mod;

  beforeEach(async () => {
    mod = await freshModule();
  });

  it('returns a Group with no colliders', () => {
    const group = mod.createDebugMeshes();
    expect(group).toBeDefined();
    expect(group.name).toBe('collision-debug');
    expect(group.children.length).toBe(0);
  });

  it('creates child meshes for AABB colliders', () => {
    mod.addAABBCollider(0, 0, 5, 5, 0, 2);
    const group = mod.createDebugMeshes();
    expect(group.children.length).toBe(1);
  });

  it('creates child meshes for cylinder colliders', () => {
    mod.addCylinderCollider(5, 5, 1, 0, 3);
    const group = mod.createDebugMeshes();
    expect(group.children.length).toBe(1);
  });

  it('creates child meshes for OBB colliders', () => {
    mod.addOBBCollider(5, 5, 2, 1, 1, 0, 0, 3);
    const group = mod.createDebugMeshes();
    expect(group.children.length).toBe(1);
  });

  it('batches all trimesh triangles into a single mesh', () => {
    const tris1 = new Float32Array([0, 0, 1, 0, 0.5, 1]);
    const tris2 = new Float32Array([5, 5, 6, 5, 5.5, 6]);
    mod.addTrimeshCollider(tris1, 0, 2);
    mod.addTrimeshCollider(tris2, 0, 2);
    const group = mod.createDebugMeshes();
    // Should be one batched mesh, not two
    expect(group.children.length).toBe(1);
  });

  it('includes both individual and batched meshes for mixed types', () => {
    mod.addAABBCollider(0, 0, 2, 2, 0, 2);
    mod.addCylinderCollider(10, 10, 1, 0, 3);
    mod.addTrimeshCollider(new Float32Array([5, 5, 6, 5, 5.5, 6]), 0, 2);
    const group = mod.createDebugMeshes();
    // 1 AABB mesh + 1 cylinder mesh + 1 batched trimesh = 3
    expect(group.children.length).toBe(3);
  });
});

// ── Edge cases ──

describe('CollisionSystem — Edge cases', () => {
  let mod;

  beforeEach(async () => {
    mod = await freshModule();
  });

  it('handles zero-length movement', () => {
    mod.addAABBCollider(0, 0, 5, 5, 0, 2);
    const result = mod.resolveMovement(10, 10, 10, 10, 0);
    expect(result).toEqual({ x: 10, z: 10 });
  });

  it('handles very small movements', () => {
    mod.addAABBCollider(10, 10, 12, 12, 0, 2);
    const result = mod.resolveMovement(9, 11, 9.001, 11, 0);
    expect(result.x).toBeCloseTo(9.001, 2);
  });

  it('player height check uses PLAYER_HEIGHT', () => {
    // AABB just above player: minY = PLAYER_HEIGHT + 0.1
    mod.addAABBCollider(9, 9, 11, 11, PLAYER_HEIGHT + 0.1, PLAYER_HEIGHT + 2);
    const result = mod.resolveMovement(8, 10, 10, 10, 0);
    // Player at y=0 extends to PLAYER_HEIGHT, collider starts above that
    expect(result).toEqual({ x: 10, z: 10 });
  });

  it('player height overlaps collider bottom', () => {
    // AABB from y=1 to y=3, player at y=0 has top at PLAYER_HEIGHT=1.8
    mod.addAABBCollider(9, 9, 11, 11, 1, 3);
    const result = mod.resolveMovement(8, 10, 10, 10, 0);
    // Should collide (player 0-1.8 overlaps collider 1-3)
    expect(result.x).toBeLessThan(10);
  });

  it('grounded=true skips collision when player feet near collider top (ON_TOP_EPS)', () => {
    // AABB from y=0 to y=0.1 — player feet at y=0 are within 0.15 of top
    mod.addAABBCollider(9, 9, 11, 11, 0, 0.1);
    const result = mod.resolveMovement(8, 10, 10, 10, 0, true);
    // ON_TOP_EPS=0.15 when grounded: playerMinY(0) >= maxY(0.1) - 0.15(-0.05) is false
    // But this is standing on top — player feet at collider top → skip
    expect(result).toEqual({ x: 10, z: 10 });
  });

  it('grounded=false blocks collision at collider top (no ON_TOP_EPS)', () => {
    // Same setup but airborne — ON_TOP_EPS=0, so collision fires
    mod.addAABBCollider(9, 9, 11, 11, 0, PLAYER_HEIGHT + 0.5);
    // Player at y=PLAYER_HEIGHT - 0.1 with feet just inside collider top range
    const playerY = PLAYER_HEIGHT - 0.1;
    const resultGrounded = mod.resolveMovement(8, 10, 10, 10, playerY, true);
    const resultAirborne = mod.resolveMovement(8, 10, 10, 10, playerY, false);
    // Grounded skips (feet near top), airborne blocks
    // playerMinY = playerY, playerMaxY = playerY + PLAYER_HEIGHT
    // Collider maxY - ON_TOP_EPS: grounded → maxY - 0.15, airborne → maxY - 0
    // For grounded: playerMinY >= maxY - 0.15 means skip if feet at or above that
    // This tests that airborne is more restrictive
    expect(resultAirborne.x).toBeLessThanOrEqual(resultGrounded.x);
  });

  it('concave trap between two AABBs returns start position', () => {
    // Two parallel walls with narrow gap — player stuck between them
    mod.addAABBCollider(-1, -10, 0, 10, 0, 5);    // wall 1 (right face at x=0)
    mod.addAABBCollider(0.5, -10, 1.5, 10, 0, 5);  // wall 2 (left face at x=0.5)
    // Player at x=0.25 (between walls), radius 0.389 overlaps both
    const result = mod.resolveMovement(0.25, 0, 0.25, -1, 0);
    // Concave trap detects opposing push normals → returns start position
    expect(result.x).toBe(0.25);
    expect(result.z).toBe(0);
  });

  it('concave trap between two OBBs returns start position', () => {
    // Two OBBs forming a narrow gap (same geometry as AABB test, using OBB API)
    mod.addOBBCollider(-0.5, 0, 0.5, 10, 1, 0, 0, 5);  // wall 1: x=-1..0
    mod.addOBBCollider(0.75, 0, 0.25, 10, 1, 0, 0, 5);  // wall 2: x=0.5..1
    // Player at x=0.25 (between walls), radius 0.389 overlaps both
    const result = mod.resolveMovement(0.25, 0, 0.25, -1, 0);
    // Concave trap detects opposing push normals → returns start position
    expect(result.x).toBe(0.25);
    expect(result.z).toBe(0);
  });
});
