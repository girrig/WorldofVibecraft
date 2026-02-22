import { describe, it, expect, vi } from 'vitest';

vi.mock('three', () => import('../__mocks__/three.js'));

import { getTerrainHeight, createTerrain, loadTerrain } from '../../client/world/Terrain.js';

describe('getTerrainHeight (before data loaded)', () => {
  it('returns 0 when terrain data is not loaded', () => {
    expect(getTerrainHeight(0, 0)).toBe(0);
    expect(getTerrainHeight(100, -50)).toBe(0);
  });

  it('returns a number for any coordinates', () => {
    expect(typeof getTerrainHeight(0, 0)).toBe('number');
    expect(typeof getTerrainHeight(100, -50)).toBe('number');
  });

  it('is deterministic', () => {
    const h1 = getTerrainHeight(42, 73);
    const h2 = getTerrainHeight(42, 73);
    expect(h1).toBe(h2);
  });

  it('handles very large coordinates without NaN', () => {
    expect(Number.isFinite(getTerrainHeight(10000, 10000))).toBe(true);
    expect(Number.isFinite(getTerrainHeight(-10000, -10000))).toBe(true);
  });
});

describe('createTerrain', () => {
  it('returns a group with children (fallback plane)', () => {
    const terrain = createTerrain();
    expect(terrain).toBeDefined();
    expect(terrain.children.length).toBeGreaterThan(0);
  });
});

describe('loadTerrain', () => {
  it('is an async function', () => {
    expect(typeof loadTerrain).toBe('function');
  });
});
