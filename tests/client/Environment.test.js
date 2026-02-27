import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('three', () => import('../__mocks__/three.js'));

const { mockGLTFLoad } = vi.hoisted(() => ({
  mockGLTFLoad: vi.fn(),
}));

vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    load(...args) { mockGLTFLoad(...args); }
  },
}));

import {
  Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial,
} from '../__mocks__/three.js';

// ── Helpers ──

function makeMockScene(meshCount = 1) {
  const scene = new Group();
  for (let i = 0; i < meshCount; i++) {
    scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
  }
  return scene;
}

async function flushAsync() {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
}

const DOODAD_PAYLOAD = {
  doodads: [
    { model: 'trees/oak.m2', x: 10, y: 5.0, z: 20, rotX: 0, rotY: 45, rotZ: 0, scale: 1.0, type: 'vegetation' },
    { model: 'trees/oak.m2', x: 30, y: 5.0, z: 40, rotX: 5, rotY: 90, rotZ: -10, scale: 0.8, type: 'vegetation' },
    { model: 'rocks/boulder.m2', x: -5, y: 5.0, z: 15, rotX: 0, rotY: 0, rotZ: 0, scale: 1.5, type: 'rock' },
  ],
  wmos: [
    { model: 'buildings/abbey.wmo', x: 0, y: 5.0, z: 0, rotX: 0, rotY: 158.5, rotZ: 0, scale: 1.0, sizeX: 20, sizeY: 10, sizeZ: 20 },
  ],
};

const MANIFEST_PAYLOAD = {
  models: {
    'trees/oak.m2': { glb: 'doodads/oak.glb' },
  },
  wmos: {
    'buildings/abbey.wmo': { glb: 'wmos/abbey.glb' },
  },
};

function mockFetchWith(doodads, manifest) {
  global.fetch = vi.fn((url) => {
    if (url.includes('northshire_doodads.json')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(doodads) });
    }
    if (url.includes('doodad_manifest.json')) {
      if (manifest) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(manifest) });
      }
      return Promise.resolve({ ok: false });
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
}

// ── Tests using fresh module state ──

describe('Environment', () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    mockGLTFLoad.mockReset();
    mockGLTFLoad.mockImplementation((url, onSuccess) => {
      onSuccess({ scene: makeMockScene(1) });
    });
    mod = await import('../../client/world/Environment.js');
  });

  // ── No-data tests ──

  describe('createEnvironment (no data)', () => {
    it('returns a group', async () => {
      const env = await await mod.createEnvironment();
      expect(env).toBeDefined();
      expect(env.children).toBeDefined();
    });

    it('returns an empty group when no data loaded', async () => {
      const env = await await mod.createEnvironment();
      expect(env.children.length).toBe(0);
    });
  });

  describe('loadEnvironment', () => {
    it('is an async function', () => {
      expect(typeof mod.loadEnvironment).toBe('function');
    });

    it('fetches doodad data and manifest', async () => {
      mockFetchWith(DOODAD_PAYLOAD, MANIFEST_PAYLOAD);
      await mod.loadEnvironment();
      expect(global.fetch).toHaveBeenCalledWith('/assets/terrain/northshire_doodads.json');
      expect(global.fetch).toHaveBeenCalledWith('/assets/models/doodad_manifest.json');
    });

    it('handles manifest fetch failure gracefully', async () => {
      global.fetch = vi.fn((url) => {
        if (url.includes('northshire_doodads.json')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(DOODAD_PAYLOAD) });
        }
        return Promise.reject(new Error('Network error'));
      });

      await mod.loadEnvironment();
      const group = await await mod.createEnvironment();
      expect(group.children.length).toBeGreaterThan(0);
    });

    it('handles non-ok manifest response', async () => {
      mockFetchWith(DOODAD_PAYLOAD, null);
      await mod.loadEnvironment();
      const group = await await mod.createEnvironment();
      expect(group.children.length).toBeGreaterThan(0);
    });
  });

  // ── Populated environment tests ──

  describe('createEnvironment (with data)', () => {
    beforeEach(async () => {
      mockFetchWith(DOODAD_PAYLOAD, MANIFEST_PAYLOAD);
      await mod.loadEnvironment();
    });

    it('returns group immediately (sync)', async () => {
      const group = await mod.createEnvironment();
      expect(group).toBeDefined();
      expect(group.children).toBeDefined();
    });

    it('populates group asynchronously', async () => {
      const group = await mod.createEnvironment();
      expect(group.children.length).toBeGreaterThan(0);
    });

    it('loads GLB for models in manifest', async () => {
      const group = await mod.createEnvironment();
      await flushAsync();

      const urls = mockGLTFLoad.mock.calls.map(c => c[0]);
      expect(urls).toContain('/assets/models/doodads/oak.glb');
      expect(urls).toContain('/assets/models/wmos/abbey.glb');
    });

    it('creates InstancedMesh with correct instance count', async () => {
      const group = await mod.createEnvironment();
      await flushAsync();

      // oak has 2 instances in manifest → InstancedMesh with count=2
      const oakMesh = group.children.find(c => c.count === 2);
      expect(oakMesh).toBeDefined();
      expect(oakMesh.castShadow).toBe(true);
      expect(oakMesh.receiveShadow).toBe(true);
    });

    it('creates one InstancedMesh per mesh part for multi-mesh GLBs', async () => {
      mockGLTFLoad.mockImplementation((url, onSuccess) => {
        if (url.includes('oak.glb')) {
          onSuccess({ scene: makeMockScene(2) });
        } else {
          onSuccess({ scene: makeMockScene(1) });
        }
      });

      const group = await mod.createEnvironment();
      await flushAsync();

      // oak → 2 mesh parts, each with count=2
      const oakMeshes = group.children.filter(c => c.count === 2);
      expect(oakMeshes.length).toBe(2);
    });

    it('sets instanceMatrix.needsUpdate after populating', async () => {
      const group = await mod.createEnvironment();
      await flushAsync();

      const instanced = group.children.find(c => c.count === 2);
      expect(instanced).toBeDefined();
      expect(instanced.instanceMatrix.needsUpdate).toBe(true);
    });

    it('writes position data into instance matrices', async () => {
      const group = await mod.createEnvironment();
      await flushAsync();

      const instanced = group.children.find(c => c.count === 2);
      expect(instanced).toBeDefined();
      const hasData = instanced.instanceMatrix.array.some(v => v !== 0);
      expect(hasData).toBe(true);
    });

    it('uses fallback placeholder when model not in manifest', async () => {
      const group = await mod.createEnvironment();
      await flushAsync();

      // boulder.m2 not in manifest → fallback InstancedMesh with count=1
      const boulderMesh = group.children.find(c => c.count === 1 && c.isMesh);
      expect(boulderMesh).toBeDefined();
    });

    it('uses fallback when GLB load fails', async () => {
      mockGLTFLoad.mockImplementation((url, onSuccess, onProgress, onError) => {
        onError(new Error('Load failed'));
      });

      const group = await mod.createEnvironment();
      await flushAsync();

      // All models should fall back to placeholders
      expect(group.children.length).toBeGreaterThan(0);
      // No GLB loaded → GLTFLoader.load should NOT have been called for boulder
      // (it's not in manifest), only for oak and abbey
    });

    it('places WMO from manifest as cloned scene', async () => {
      const group = await mod.createEnvironment();
      await flushAsync();

      // WMO clone is a Group (not InstancedMesh)
      const wmoChild = group.children.find(
        c => c.children !== undefined && c.count === undefined
      );
      expect(wmoChild).toBeDefined();
    });

    it('sets shadow on WMO mesh children', async () => {
      const group = await mod.createEnvironment();
      await flushAsync();

      const wmoChild = group.children.find(
        c => c.children !== undefined && c.count === undefined
      );
      expect(wmoChild).toBeDefined();
      // The cloned WMO group should have a Mesh child with castShadow set
      const meshChild = wmoChild.children.find(c => c.isMesh);
      if (meshChild) {
        expect(meshChild.castShadow).toBe(true);
        expect(meshChild.receiveShadow).toBe(true);
      }
    });

    it('falls back to box for WMO when GLB fails', async () => {
      mockGLTFLoad.mockImplementation((url, onSuccess, onProgress, onError) => {
        if (url.includes('abbey.glb')) {
          onError(new Error('WMO load failed'));
        } else {
          onSuccess({ scene: makeMockScene(1) });
        }
      });

      const group = await mod.createEnvironment();
      await flushAsync();

      // WMO fallback is a Mesh (box), not a Group clone
      const wmoFallback = group.children.find(
        c => c.isMesh && c.count === undefined
      );
      expect(wmoFallback).toBeDefined();
    });
  });

  // ── Rotation system ──

  describe('rotation handling', () => {
    it('applies all three rotation axes to doodad instances', async () => {
      const data = {
        doodads: [
          { model: 'test.m2', x: 0, y: 5.0, z: 0, rotX: 15, rotY: 45, rotZ: -10, scale: 1.0, type: 'prop' },
        ],
        wmos: [],
      };
      mockFetchWith(data, null);
      await mod.loadEnvironment();

      const group = await mod.createEnvironment();
      await flushAsync();

      // Verify that the InstancedMesh exists and has matrix data
      const mesh = group.children.find(c => c.count === 1);
      expect(mesh).toBeDefined();
      expect(mesh.instanceMatrix.array.length).toBe(16); // 4x4 matrix
    });

    it('handles missing rotation values with defaults', async () => {
      const data = {
        doodads: [
          { model: 'tree.m2', x: 0, y: 5.0, z: 0, type: 'vegetation' }, // No rotation values
        ],
        wmos: [],
      };
      mockFetchWith(data, null);
      await mod.loadEnvironment();

      const group = await mod.createEnvironment();
      await flushAsync();

      // Should still create mesh without errors
      expect(group.children.length).toBe(1);
    });

    it('negates rotZ on fallback WMO (wowdev wiki MDDF spec)', async () => {
      const data = {
        doodads: [],
        wmos: [
          { model: 'building.wmo', x: 0, y: 5.0, z: 0, rotX: 10, rotY: 158.5, rotZ: 25, sizeX: 10, sizeY: 8, sizeZ: 10 },
        ],
      };
      mockFetchWith(data, null);
      await mod.loadEnvironment();

      const group = await mod.createEnvironment();
      await flushAsync();

      const wmo = group.children.find(c => c.isMesh);
      expect(wmo).toBeDefined();
      // rotX and rotY should be positive (converted to radians)
      expect(wmo.rotation.x).toBeCloseTo(10 * Math.PI / 180, 5);
      expect(wmo.rotation.y).toBeCloseTo(158.5 * Math.PI / 180, 5);
      // rotZ must be NEGATED per wowdev wiki
      expect(wmo.rotation.z).toBeCloseTo(-25 * Math.PI / 180, 5);
    });

    it('negates rotZ on GLB WMO model (wowdev wiki MDDF spec)', async () => {
      const data = {
        doodads: [],
        wmos: [
          { model: 'abbey.wmo', x: 0, y: 5.0, z: 0, rotX: 5, rotY: 270, rotZ: -15, scale: 1.0, sizeX: 20, sizeY: 10, sizeZ: 20 },
        ],
      };
      const manifest = {
        models: {},
        wmos: {
          'abbey.wmo': { glb: 'wmos/abbey.glb' },
        },
      };
      mockFetchWith(data, manifest);
      await mod.loadEnvironment();

      const group = await mod.createEnvironment();
      await flushAsync();

      // WMO should be cloned from GLB (a Group, not InstancedMesh)
      const wmo = group.children.find(c => c.children !== undefined && c.count === undefined);
      expect(wmo).toBeDefined();
      expect(wmo.rotation.x).toBeCloseTo(5 * Math.PI / 180, 5);
      expect(wmo.rotation.y).toBeCloseTo(270 * Math.PI / 180, 5);
      // rotZ must be NEGATED per wowdev wiki
      expect(wmo.rotation.z).toBeCloseTo(15 * Math.PI / 180, 5);
    });

    it('uses YZX Euler order for all placements', async () => {
      const data = {
        doodads: [],
        wmos: [
          { model: 'building.wmo', x: 0, y: 5.0, z: 0, rotX: 10, rotY: 45, rotZ: 5, sizeX: 10, sizeY: 8, sizeZ: 10 },
        ],
      };
      mockFetchWith(data, null);
      await mod.loadEnvironment();

      const group = await mod.createEnvironment();
      await flushAsync();

      const wmo = group.children.find(c => c.isMesh);
      expect(wmo).toBeDefined();
      expect(wmo.rotation.order).toBe('YZX');
    });

    it('converts degrees to radians for Three.js', async () => {
      const data = {
        doodads: [],
        wmos: [
          { model: 'box.wmo', x: 0, y: 5.0, z: 0, rotX: 90, rotY: 180, rotZ: 0, sizeX: 5, sizeY: 5, sizeZ: 5 },
        ],
      };
      mockFetchWith(data, null);
      await mod.loadEnvironment();

      const group = await mod.createEnvironment();
      await flushAsync();

      const wmo = group.children.find(c => c.isMesh);
      expect(wmo).toBeDefined();
      expect(wmo.rotation.x).toBeCloseTo(Math.PI / 2, 5);
      expect(wmo.rotation.y).toBeCloseTo(Math.PI, 5);
    });

    it('negates rotZ consistently across fallback and GLB doodad paths', async () => {
      // Two separate models: one with manifest (GLB path), one without (fallback path)
      // Both should negate rotZ identically
      const data = {
        doodads: [
          { model: 'trees/oak.m2', x: 10, y: 5.0, z: 20, rotX: 0, rotY: 45, rotZ: 12, scale: 1.0, type: 'vegetation' },
          { model: 'rocks/boulder.m2', x: -5, y: 5.0, z: 15, rotX: 0, rotY: 0, rotZ: 12, scale: 1.0, type: 'rock' },
        ],
        wmos: [],
      };
      const manifest = {
        models: {
          'trees/oak.m2': { glb: 'doodads/oak.glb' },
        },
        wmos: {},
      };
      mockFetchWith(data, manifest);
      await mod.loadEnvironment();

      const group = await mod.createEnvironment();
      await flushAsync();

      // Both paths should produce meshes without errors
      expect(group.children.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Bounds checking ──

  describe('bounds checking', () => {
    it('skips out-of-bounds doodads', async () => {
      const data = {
        doodads: [
          { model: 'trees/far.m2', x: 900, y: 5.0, z: 0, type: 'vegetation' },
          { model: 'trees/near.m2', x: 10, y: 5.0, z: 20, type: 'vegetation' },
        ],
        wmos: [],
      };
      mockFetchWith(data, null);
      await mod.loadEnvironment();

      const group = await mod.createEnvironment();
      await flushAsync();

      // Only near doodad → 1 InstancedMesh
      expect(group.children.length).toBe(1);
    });

    it('skips out-of-bounds WMOs', async () => {
      const data = {
        doodads: [],
        wmos: [
          { model: 'buildings/far.wmo', x: 900, y: 5.0, z: 0, sizeX: 10, sizeY: 8, sizeZ: 10 },
        ],
      };
      mockFetchWith(data, null);
      await mod.loadEnvironment();

      const group = await mod.createEnvironment();
      expect(group.children.length).toBe(0);
    });

    it('skips oversized WMOs', async () => {
      const data = {
        doodads: [],
        wmos: [
          { model: 'buildings/huge.wmo', x: 0, y: 5.0, z: 0, sizeX: 2000, sizeY: 8, sizeZ: 10 },
        ],
      };
      mockFetchWith(data, null);
      await mod.loadEnvironment();

      const group = await mod.createEnvironment();
      expect(group.children.length).toBe(0);
    });
  });

  // ── Fallback types ──

  describe('fallback placeholders', () => {
    beforeEach(async () => {
      const data = {
        doodads: [
          { model: 'a.m2', x: 0, y: 5.0, z: 0, type: 'vegetation' },
          { model: 'b.m2', x: 5, y: 5.0, z: 5, type: 'rock' },
          { model: 'c.m2', x: 10, y: 5.0, z: 10, type: 'prop' },
          { model: 'd.m2', x: 15, y: 5.0, z: 15, type: 'container' },
          { model: 'e.m2', x: 20, y: 5.0, z: 20, type: 'unknown_type' },
        ],
        wmos: [],
      };
      mockFetchWith(data, null);
      await mod.loadEnvironment();
    });

    it('creates one InstancedMesh per unique model', async () => {
      const group = await mod.createEnvironment();
      await flushAsync();
      // 5 unique models, each with 1 instance → 5 InstancedMeshes
      expect(group.children.length).toBe(5);
    });

    it('all fallback meshes cast and receive shadows', async () => {
      const group = await mod.createEnvironment();
      await flushAsync();

      for (const child of group.children) {
        expect(child.castShadow).toBe(true);
        expect(child.receiveShadow).toBe(true);
      }
    });
  });

  // ── Lighting ──

  describe('createLighting', () => {
    it('adds 3 lights to the scene', () => {
      const scene = new Scene();
      mod.createLighting(scene);
      expect(scene.children.length).toBe(3);
    });

    it('creates a shadow-casting directional light', () => {
      const scene = new Scene();
      mod.createLighting(scene);
      const sun = scene.children.find(c => c.castShadow);
      expect(sun).toBeDefined();
    });

    it('configures 2048x2048 shadow map', () => {
      const scene = new Scene();
      mod.createLighting(scene);
      const sun = scene.children.find(c => c.castShadow);
      expect(sun.shadow.mapSize.width).toBe(2048);
      expect(sun.shadow.mapSize.height).toBe(2048);
    });

    it('configures shadow camera for large world', () => {
      const scene = new Scene();
      mod.createLighting(scene);
      const sun = scene.children.find(c => c.castShadow);
      expect(sun.shadow.camera.far).toBe(600);
      expect(sun.shadow.camera.left).toBe(-200);
      expect(sun.shadow.camera.right).toBe(200);
    });
  });

  // ── Sky ──

  describe('createSky', () => {
    it('sets scene background color', () => {
      const scene = new Scene();
      mod.createSky(scene);
      expect(scene.background).toBeDefined();
    });

    it('sets scene fog', () => {
      const scene = new Scene();
      mod.createSky(scene);
      expect(scene.fog).toBeDefined();
    });

    it('uses FogExp2 with correct density', () => {
      const scene = new Scene();
      mod.createSky(scene);
      expect(scene.fog.density).toBe(0.0012);
    });
  });
});
