import { describe, it, expect, vi } from 'vitest';

vi.mock('three', () => import('../__mocks__/three.js'));

import { getTerrainHeight, createTerrain } from '../../client/world/Terrain.js';

describe('getTerrainHeight', () => {
  it('returns a number for any coordinates', () => {
    expect(typeof getTerrainHeight(0, 0)).toBe('number');
    expect(typeof getTerrainHeight(100, -50)).toBe('number');
    expect(typeof getTerrainHeight(-250, 250)).toBe('number');
  });

  it('is deterministic (same input → same output)', () => {
    const h1 = getTerrainHeight(42, 73);
    const h2 = getTerrainHeight(42, 73);
    expect(h1).toBe(h2);
  });

  it('matches the expected formula at origin', () => {
    // Formula: sin(x*0.02)*1.5 + cos(z*0.02)*1.5 + sin(x*0.05 + z*0.03)*0.8
    // At (0, 0): sin(0)*1.5 + cos(0)*1.5 + sin(0)*0.8 = 0 + 1.5 + 0 = 1.5
    expect(getTerrainHeight(0, 0)).toBeCloseTo(1.5, 5);
  });

  it('matches the formula at known coordinates', () => {
    const x = 10, z = 20;
    const expected =
      Math.sin(x * 0.02) * 1.5 +
      Math.cos(z * 0.02) * 1.5 +
      Math.sin(x * 0.05 + z * 0.03) * 0.8;
    expect(getTerrainHeight(x, z)).toBeCloseTo(expected, 10);
  });

  it('stays within reasonable height range', () => {
    // Max possible: 1.5 + 1.5 + 0.8 = 3.8, Min: -1.5 + -1.5 + -0.8 = -3.8
    for (let x = -250; x <= 250; x += 50) {
      for (let z = -250; z <= 250; z += 50) {
        const h = getTerrainHeight(x, z);
        expect(h).toBeGreaterThanOrEqual(-3.8);
        expect(h).toBeLessThanOrEqual(3.8);
      }
    }
  });

  it('produces varying heights across the terrain', () => {
    const heights = new Set();
    for (let i = 0; i < 10; i++) {
      heights.add(getTerrainHeight(i * 30, i * 20).toFixed(4));
    }
    // Should have multiple distinct heights
    expect(heights.size).toBeGreaterThan(1);
  });

  it('handles very large coordinates without NaN', () => {
    expect(Number.isFinite(getTerrainHeight(10000, 10000))).toBe(true);
    expect(Number.isFinite(getTerrainHeight(-10000, -10000))).toBe(true);
  });
});

describe('createTerrain', () => {
  it('returns a group with children', () => {
    const terrain = createTerrain();
    expect(terrain).toBeDefined();
    expect(terrain.children.length).toBeGreaterThan(0);
  });

  it('creates at least a ground mesh and paths', () => {
    const terrain = createTerrain();
    // Ground mesh + 2 dirt paths = at least 3 children
    expect(terrain.children.length).toBeGreaterThanOrEqual(3);
  });
});
