import { describe, it, expect, vi } from 'vitest';

vi.mock('three', () => import('../__mocks__/three.js'));

import { createEnvironment, createLighting, createSky } from '../../client/world/Environment.js';
import { Scene } from '../__mocks__/three.js';

describe('createEnvironment', () => {
  it('returns a group', () => {
    const env = createEnvironment();
    expect(env).toBeDefined();
    expect(env.children).toBeDefined();
  });

  it('creates trees, rocks, campfire, stone circle, and signpost', () => {
    const env = createEnvironment();
    // 200 tree attempts + 80 rock attempts (some skipped near spawn)
    // + 1 campfire + 1 fire light + 8 stones + 1 post + 1 sign
    // Trees/rocks near center are skipped, so count will vary but should be substantial
    expect(env.children.length).toBeGreaterThan(50);
  });

  it('is deterministic (seeded random)', () => {
    const env1 = createEnvironment();
    const env2 = createEnvironment();
    expect(env1.children.length).toBe(env2.children.length);
  });

  it('does not place trees in the spawn area', () => {
    const env = createEnvironment();
    const townRadius = 25;
    // Check that no tree/rock group is positioned within spawn radius
    // The campfire and stone circle ARE in spawn (that's intentional)
    // Trees are Groups with 4 children (trunk + 3 cones)
    const treeGroups = env.children.filter(c => c.children && c.children.length === 4);
    for (const tree of treeGroups) {
      const dist = Math.sqrt(tree.position.x ** 2 + tree.position.z ** 2);
      expect(dist).toBeGreaterThanOrEqual(townRadius);
    }
  });
});

describe('createLighting', () => {
  it('adds lights to the scene', () => {
    const scene = new Scene();
    createLighting(scene);
    // ambient + sun + hemisphere = 3
    expect(scene.children.length).toBe(3);
  });

  it('creates a shadow-casting directional light', () => {
    const scene = new Scene();
    createLighting(scene);
    const sun = scene.children.find(c => c.castShadow);
    expect(sun).toBeDefined();
  });
});

describe('createSky', () => {
  it('sets scene background color', () => {
    const scene = new Scene();
    createSky(scene);
    expect(scene.background).toBeDefined();
  });

  it('sets scene fog', () => {
    const scene = new Scene();
    createSky(scene);
    expect(scene.fog).toBeDefined();
  });
});
