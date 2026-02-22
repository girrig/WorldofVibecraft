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

  it('returns an empty group (decorations removed for real terrain)', () => {
    const env = createEnvironment();
    expect(env.children.length).toBe(0);
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
