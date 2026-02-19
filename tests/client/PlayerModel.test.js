import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Group as MockGroup,
  Mesh as MockMesh,
  AnimationClip as MockClip,
} from '../__mocks__/three.js';

// Controllable mock functions (hoisted before vi.mock)
const { mockLoadFn, mockCloneFn } = vi.hoisted(() => ({
  mockLoadFn: vi.fn(),
  mockCloneFn: vi.fn(),
}));

vi.mock('three', () => import('../__mocks__/three.js'));
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    load(...args) { mockLoadFn(...args); }
  },
}));
vi.mock('three/addons/utils/SkeletonUtils.js', () => ({
  clone: (...args) => mockCloneFn(...args),
}));

/** Create a mock glTF scene with a child mesh */
function makeMockScene() {
  const scene = new MockGroup();
  const mesh = new MockMesh();
  mesh.isMesh = true;
  mesh.castShadow = false;
  scene.add(mesh);
  return scene;
}

/** Create mock animation clips */
function makeMockAnimations(names = ['Stand', 'Run', 'Walk', 'WalkBackwards']) {
  return names.map(n => new MockClip(n, 1, []));
}

describe('Model loading pipeline', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockLoadFn.mockReset();
    mockCloneFn.mockReset();
    mockCloneFn.mockReturnValue(new MockGroup());
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('preloadPlayerModel', () => {
    it('calls GLTFLoader.load with the correct model path', async () => {
      mockLoadFn.mockImplementation(() => {});
      const { preloadPlayerModel } = await import('../../client/entities/Player.js');
      preloadPlayerModel();

      expect(mockLoadFn).toHaveBeenCalledTimes(1);
      expect(mockLoadFn.mock.calls[0][0]).toBe('/assets/models/human_male.glb');
    });

    it('resolves with the loaded scene on success', async () => {
      const scene = makeMockScene();
      mockLoadFn.mockImplementation((url, onSuccess) => {
        onSuccess({ scene, animations: [] });
      });
      const { preloadPlayerModel } = await import('../../client/entities/Player.js');

      const result = await preloadPlayerModel();
      expect(result).toBe(scene);
    });

    it('returns the same promise on repeated calls (caching)', async () => {
      mockLoadFn.mockImplementation(() => {});
      const { preloadPlayerModel } = await import('../../client/entities/Player.js');

      const p1 = preloadPlayerModel();
      const p2 = preloadPlayerModel();
      expect(p1).toBe(p2);
      expect(mockLoadFn).toHaveBeenCalledTimes(1);
    });

    it('enables castShadow on all meshes in the loaded scene', async () => {
      const scene = makeMockScene();
      const mesh = scene.children[0];
      expect(mesh.castShadow).toBe(false);

      mockLoadFn.mockImplementation((url, onSuccess) => {
        onSuccess({ scene, animations: [] });
      });
      const { preloadPlayerModel } = await import('../../client/entities/Player.js');

      await preloadPlayerModel();
      expect(mesh.castShadow).toBe(true);
    });

    it('defaults to empty animations when gltf.animations is undefined', async () => {
      const scene = makeMockScene();
      mockLoadFn.mockImplementation((url, onSuccess) => {
        onSuccess({ scene }); // no animations property
      });
      const { preloadPlayerModel, createPlayerMesh } = await import('../../client/entities/Player.js');

      await preloadPlayerModel();
      const { mixer } = createPlayerMesh();
      expect(mixer).toBeNull();
    });

    it('rejects on load error', async () => {
      mockLoadFn.mockImplementation((url, onSuccess, _progress, onError) => {
        onError(new Error('Network failure'));
      });
      const { preloadPlayerModel } = await import('../../client/entities/Player.js');

      await expect(preloadPlayerModel()).rejects.toThrow('Network failure');
    });
  });

  describe('createPlayerMesh — fallback (no cached model)', () => {
    it('returns group with 3 children (body, head, shoulders)', async () => {
      const { createPlayerMesh } = await import('../../client/entities/Player.js');
      const { group } = createPlayerMesh(0xff0000);

      expect(group.children.length).toBe(3);
    });

    it('returns null mixer and empty actions', async () => {
      const { createPlayerMesh } = await import('../../client/entities/Player.js');
      const { mixer, actions } = createPlayerMesh();

      expect(mixer).toBeNull();
      expect(actions).toEqual({});
    });

    it('positions body at y=0.9, head at y=1.65, shoulders at y=1.35', async () => {
      const { createPlayerMesh } = await import('../../client/entities/Player.js');
      const { group } = createPlayerMesh();

      expect(group.children[0].position.y).toBe(0.9);
      expect(group.children[1].position.y).toBe(1.65);
      expect(group.children[2].position.y).toBe(1.35);
    });

    it('all fallback parts have castShadow enabled', async () => {
      const { createPlayerMesh } = await import('../../client/entities/Player.js');
      const { group } = createPlayerMesh();

      group.children.forEach(child => {
        expect(child.castShadow).toBe(true);
      });
    });
  });

  describe('createPlayerMesh — with cached model', () => {
    async function loadModel(animations = []) {
      const scene = makeMockScene();
      mockLoadFn.mockImplementation((url, onSuccess) => {
        onSuccess({ scene, animations });
      });
      const mod = await import('../../client/entities/Player.js');
      await mod.preloadPlayerModel();
      return { ...mod, scene };
    }

    it('clones the cached model via SkeletonUtils', async () => {
      const { createPlayerMesh, scene } = await loadModel();
      createPlayerMesh();

      expect(mockCloneFn).toHaveBeenCalledWith(scene);
    });

    it('rotates cloned model by PI/2 for WoW→Three.js forward direction', async () => {
      const cloned = new MockGroup();
      mockCloneFn.mockReturnValue(cloned);
      const { createPlayerMesh } = await loadModel();
      createPlayerMesh();

      expect(cloned.rotation.y).toBeCloseTo(Math.PI / 2);
    });

    it('enables castShadow on cloned meshes', async () => {
      const cloned = new MockGroup();
      const mesh = new MockMesh();
      mesh.isMesh = true;
      mesh.castShadow = false;
      cloned.add(mesh);
      mockCloneFn.mockReturnValue(cloned);

      const { createPlayerMesh } = await loadModel();
      createPlayerMesh();

      expect(mesh.castShadow).toBe(true);
    });

    it('creates AnimationMixer when animations exist', async () => {
      const { createPlayerMesh } = await loadModel(makeMockAnimations(['Stand', 'Run']));
      const { mixer } = createPlayerMesh();

      expect(mixer).not.toBeNull();
    });

    it('creates an action for each animation clip', async () => {
      const { createPlayerMesh } = await loadModel(
        makeMockAnimations(['Stand', 'Run', 'Walk', 'WalkBackwards'])
      );
      const { actions } = createPlayerMesh();

      expect(Object.keys(actions)).toEqual(
        expect.arrayContaining(['Stand', 'Run', 'Walk', 'WalkBackwards'])
      );
    });

    it('returns null mixer when no animations are cached', async () => {
      const { createPlayerMesh } = await loadModel([]);
      const { mixer, actions } = createPlayerMesh();

      expect(mixer).toBeNull();
      expect(actions).toEqual({});
    });
  });

  describe('playAnimation', () => {
    it('is a no-op when mixer is null (fallback mesh)', async () => {
      const { LocalPlayer } = await import('../../client/entities/Player.js');
      const player = new LocalPlayer('no-mixer', 'NoMixer');

      expect(player.mixer).toBeNull();
      expect(player.currentAction).toBeNull();
      expect(() => player.playAnimation('Run')).not.toThrow();
      expect(player.currentAction).toBeNull();
    });

    it('crossfades from current animation to new one', async () => {
      const scene = makeMockScene();
      mockLoadFn.mockImplementation((url, onSuccess) => {
        onSuccess({ scene, animations: makeMockAnimations(['Stand', 'Run']) });
      });
      const { preloadPlayerModel, LocalPlayer } = await import('../../client/entities/Player.js');
      await preloadPlayerModel();

      const player = new LocalPlayer('crossfade', 'Crossfade');
      const standAction = player.currentAction;
      expect(standAction).not.toBeNull();

      player.playAnimation('Run');
      expect(player.currentAction).toBe(player.actions['Run']);
      expect(player.currentAction).not.toBe(standAction);
    });

    it('does not change action if same animation is already playing', async () => {
      const scene = makeMockScene();
      mockLoadFn.mockImplementation((url, onSuccess) => {
        onSuccess({ scene, animations: makeMockAnimations(['Stand']) });
      });
      const { preloadPlayerModel, LocalPlayer } = await import('../../client/entities/Player.js');
      await preloadPlayerModel();

      const player = new LocalPlayer('same', 'Same');
      const action = player.currentAction;

      player.playAnimation('Stand');
      expect(player.currentAction).toBe(action);
    });

    it('ignores unknown animation names', async () => {
      const scene = makeMockScene();
      mockLoadFn.mockImplementation((url, onSuccess) => {
        onSuccess({ scene, animations: makeMockAnimations(['Stand']) });
      });
      const { preloadPlayerModel, LocalPlayer } = await import('../../client/entities/Player.js');
      await preloadPlayerModel();

      const player = new LocalPlayer('unknown', 'Unknown');
      const before = player.currentAction;

      player.playAnimation('NonExistent');
      expect(player.currentAction).toBe(before);
    });

    it('calls mixer.update on each player update tick', async () => {
      const scene = makeMockScene();
      mockLoadFn.mockImplementation((url, onSuccess) => {
        onSuccess({ scene, animations: makeMockAnimations(['Stand', 'Run']) });
      });
      const { preloadPlayerModel, LocalPlayer } = await import('../../client/entities/Player.js');
      await preloadPlayerModel();

      const player = new LocalPlayer('tick', 'Tick');
      const spy = vi.spyOn(player.mixer, 'update');

      player.update(0.016, {
        rightMouseDown: false,
        leftMouseDown: false,
        bothButtonsForward: false,
        cameraYaw: 0,
      });

      expect(spy).toHaveBeenCalledWith(0.016);
    });
  });
});
