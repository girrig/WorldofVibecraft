import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('three', () => import('../__mocks__/three.js'));

import { PlayerControls } from '../../client/controls/PlayerControls.js';
import {
  CAMERA_MIN_DISTANCE,
  CAMERA_MAX_DISTANCE,
  CAMERA_DEFAULT_DISTANCE,
  CAMERA_SENSITIVITY,
} from '../../shared/constants.js';
import { Vector3 } from '../__mocks__/three.js';

// Create a mock canvas with event listener tracking
function createMockCanvas() {
  const listeners = {};
  return {
    addEventListener: vi.fn((event, handler, options) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    requestPointerLock: vi.fn(),
    _listeners: listeners,
    _fire: (event, data) => {
      (listeners[event] || []).forEach(fn => fn(data));
    },
  };
}

// Create a mock camera
function createMockCamera() {
  return {
    position: new Vector3(),
    lookAt: vi.fn(),
  };
}

describe('PlayerControls', () => {
  let controls, canvas, camera;

  beforeEach(() => {
    // Mock document.pointerLockElement and document.exitPointerLock
    Object.defineProperty(document, 'pointerLockElement', {
      value: null,
      writable: true,
      configurable: true,
    });
    document.exitPointerLock = vi.fn();

    canvas = createMockCanvas();
    camera = createMockCamera();
    controls = new PlayerControls(camera, canvas);
  });

  describe('constructor defaults', () => {
    it('initializes cameraYaw to 0', () => {
      expect(controls.cameraYaw).toBe(0);
    });

    it('initializes cameraPitch to 0.3', () => {
      expect(controls.cameraPitch).toBe(0.3);
    });

    it('initializes distance to default', () => {
      expect(controls.distance).toBe(CAMERA_DEFAULT_DISTANCE);
    });

    it('initializes mouse buttons as not pressed', () => {
      expect(controls.rightMouseDown).toBe(false);
      expect(controls.leftMouseDown).toBe(false);
    });

    it('initializes bothButtonsForward as false', () => {
      expect(controls.bothButtonsForward).toBe(false);
    });

    it('sets sensitivity from constants', () => {
      expect(controls.sensitivity).toBe(CAMERA_SENSITIVITY);
    });
  });

  describe('mouse button tracking', () => {
    it('tracks left mouse button down/up', () => {
      canvas._fire('mousedown', { button: 0 });
      expect(controls.leftMouseDown).toBe(true);
      canvas._fire('mouseup', { button: 0 });
      expect(controls.leftMouseDown).toBe(false);
    });

    it('tracks right mouse button down/up', () => {
      canvas._fire('mousedown', { button: 2 });
      expect(controls.rightMouseDown).toBe(true);
      canvas._fire('mouseup', { button: 2 });
      expect(controls.rightMouseDown).toBe(false);
    });

    it('bothButtonsForward is true only when both held', () => {
      canvas._fire('mousedown', { button: 0 });
      expect(controls.bothButtonsForward).toBe(false);
      canvas._fire('mousedown', { button: 2 });
      expect(controls.bothButtonsForward).toBe(true);
      canvas._fire('mouseup', { button: 0 });
      expect(controls.bothButtonsForward).toBe(false);
    });
  });

  describe('zoom (scroll wheel)', () => {
    it('zooms in on scroll up', () => {
      const startDist = controls.distance;
      canvas._fire('wheel', { deltaY: -100, preventDefault: vi.fn() });
      expect(controls.distance).toBeLessThan(startDist);
    });

    it('zooms out on scroll down', () => {
      const startDist = controls.distance;
      canvas._fire('wheel', { deltaY: 100, preventDefault: vi.fn() });
      expect(controls.distance).toBeGreaterThan(startDist);
    });

    it('clamps zoom to minimum distance', () => {
      // Scroll in a lot
      for (let i = 0; i < 100; i++) {
        canvas._fire('wheel', { deltaY: -1000, preventDefault: vi.fn() });
      }
      expect(controls.distance).toBeGreaterThanOrEqual(CAMERA_MIN_DISTANCE);
    });

    it('clamps zoom to maximum distance', () => {
      for (let i = 0; i < 100; i++) {
        canvas._fire('wheel', { deltaY: 1000, preventDefault: vi.fn() });
      }
      expect(controls.distance).toBeLessThanOrEqual(CAMERA_MAX_DISTANCE);
    });
  });

  describe('update — camera positioning', () => {
    it('camera looks at focus point above player', () => {
      const playerPos = { x: 5, y: 1, z: 10 };
      controls.update(playerPos, 0, null, null);
      expect(camera.lookAt).toHaveBeenCalled();
      const lookTarget = camera.lookAt.mock.calls[0][0];
      expect(lookTarget.x).toBe(5);
      expect(lookTarget.y).toBe(2.5); // playerPos.y + 1.5
      expect(lookTarget.z).toBe(10);
    });

    it('camera position changes with cameraYaw', () => {
      const playerPos = { x: 0, y: 0, z: 0 };
      controls.cameraYaw = 0;
      controls.update(playerPos, 0, null, null);
      const pos1 = { x: camera.position.x, z: camera.position.z };

      controls.cameraYaw = Math.PI / 2;
      controls.update(playerPos, 0, null, null);
      const pos2 = { x: camera.position.x, z: camera.position.z };

      // Positions should differ
      expect(pos1.x).not.toBeCloseTo(pos2.x, 1);
    });

    it('camera distance from player matches distance property', () => {
      controls.cameraYaw = 0;
      controls.cameraPitch = 0;
      controls.distance = 10;
      const playerPos = { x: 0, y: 0, z: 0 };
      controls.update(playerPos, 0, null, null);

      // The offset from focus point should have magnitude ≈ distance
      // Focus point is at (0, 1.5, 0), camera offset added to it
      const dx = camera.position.x - 0;
      const dy = camera.position.y - 1.5;
      const dz = camera.position.z - 0;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      expect(dist).toBeCloseTo(10, 0);
    });

    it('cameraPitch affects vertical position', () => {
      const playerPos = { x: 0, y: 0, z: 0 };
      controls.cameraPitch = 0;
      controls.update(playerPos, 0, null, null);
      const y1 = camera.position.y;

      controls.cameraPitch = 0.5;
      controls.update(playerPos, 0, null, null);
      const y2 = camera.position.y;

      expect(y2).toBeGreaterThan(y1);
    });
  });

  describe('mouse move — camera rotation', () => {
    it('ignores mouse move when no buttons held', () => {
      const startYaw = controls.cameraYaw;
      const startPitch = controls.cameraPitch;
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 100, movementY: 100 }));
      expect(controls.cameraYaw).toBe(startYaw);
      expect(controls.cameraPitch).toBe(startPitch);
    });

    it('rotates camera yaw on mouse move with right button held', () => {
      canvas._fire('mousedown', { button: 2 });
      const startYaw = controls.cameraYaw;
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 100, movementY: 0 }));
      expect(controls.cameraYaw).not.toBe(startYaw);
    });

    it('rotates camera pitch on mouse move with left button held', () => {
      canvas._fire('mousedown', { button: 0 });
      const startPitch = controls.cameraPitch;
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 100 }));
      expect(controls.cameraPitch).not.toBe(startPitch);
    });

    it('clamps pitch to avoid flipping over the top', () => {
      canvas._fire('mousedown', { button: 2 });
      // Extreme upward movement
      for (let i = 0; i < 100; i++) {
        document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: -1000 }));
      }
      expect(controls.cameraPitch).toBeGreaterThan(-Math.PI / 2);
    });

    it('clamps pitch to avoid flipping under', () => {
      canvas._fire('mousedown', { button: 2 });
      // Extreme downward movement
      for (let i = 0; i < 100; i++) {
        document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 1000 }));
      }
      expect(controls.cameraPitch).toBeLessThan(Math.PI / 2);
    });
  });

  describe('pointer lock', () => {
    it('requests pointer lock on right-click', () => {
      canvas._fire('mousedown', { button: 2 });
      expect(canvas.requestPointerLock).toHaveBeenCalled();
    });

    it('exits pointer lock when all buttons released', () => {
      document.pointerLockElement = canvas;
      canvas._fire('mousedown', { button: 2 });
      canvas._fire('mouseup', { button: 2 });
      expect(document.exitPointerLock).toHaveBeenCalled();
    });
  });

  describe('update — camera collision', () => {
    it('positions camera normally when no collision', () => {
      const playerPos = { x: 0, y: 0, z: 0 };
      controls.cameraPitch = 0; // Zero pitch simplifies the geometry
      controls.cameraYaw = 0;
      // Scene with no obstructing children
      const scene = { children: [] };
      controls.update(playerPos, 0, scene, null);
      // With pitch=0, yaw=0: offset = (0, 1.5, distance)
      // Camera at desiredPos, check the horizontal distance component equals distance
      expect(camera.position.z).toBeCloseTo(controls.distance, 1);
    });

    it('works when scene is null (no collision)', () => {
      const playerPos = { x: 0, y: 0, z: 0 };
      expect(() => controls.update(playerPos, 0, null, null)).not.toThrow();
    });

    it('pulls camera forward when obstacle is hit', async () => {
      // We need to make the Raycaster return a fake hit
      const { Raycaster } = await import('../__mocks__/three.js');

      controls.cameraPitch = 0;
      controls.cameraYaw = 0;
      controls.distance = 10;
      const playerPos = { x: 0, y: 0, z: 0 };

      // Create scene with a child that will trigger collision
      const obstacleHit = { object: { parent: null }, distance: 5 };
      const scene = {
        children: [{ parent: null }],
      };

      // Patch Raycaster prototype to return our fake hit
      const origIntersect = Raycaster.prototype.intersectObjects;
      Raycaster.prototype.intersectObjects = () => [obstacleHit];

      controls.update(playerPos, 0, scene, null);

      // Camera should be closer than full distance due to collision
      const dist = Math.sqrt(
        camera.position.x ** 2 +
        (camera.position.y - 1.5) ** 2 +
        camera.position.z ** 2
      );
      expect(dist).toBeLessThan(10);

      // Restore
      Raycaster.prototype.intersectObjects = origIntersect;
    });

    it('ignores obstacles closer than 0.5 units', async () => {
      const { Raycaster } = await import('../__mocks__/three.js');

      controls.cameraPitch = 0;
      controls.cameraYaw = 0;
      controls.distance = 10;
      const playerPos = { x: 0, y: 0, z: 0 };

      const closeHit = { object: { parent: null }, distance: 0.3 };
      const scene = { children: [{}] };

      const origIntersect = Raycaster.prototype.intersectObjects;
      Raycaster.prototype.intersectObjects = () => [closeHit];

      controls.update(playerPos, 0, scene, null);

      // Close hit (< 0.5) should be ignored — camera at full distance
      expect(camera.position.z).toBeCloseTo(10, 1);

      Raycaster.prototype.intersectObjects = origIntersect;
    });

    it('uses first valid hit when multiple obstacles exist', async () => {
      const { Raycaster } = await import('../__mocks__/three.js');

      controls.cameraPitch = 0;
      controls.cameraYaw = 0;
      controls.distance = 10;
      const playerPos = { x: 0, y: 0, z: 0 };

      const nearHit = { object: { parent: null }, distance: 3 };
      const farHit = { object: { parent: null }, distance: 7 };
      const scene = { children: [{}] };

      const origIntersect = Raycaster.prototype.intersectObjects;
      Raycaster.prototype.intersectObjects = () => [nearHit, farHit];

      controls.update(playerPos, 0, scene, null);

      // Should use nearest valid hit (distance 3), with 0.3 buffer → 2.7 from focus
      const dist = Math.sqrt(
        camera.position.x ** 2 +
        (camera.position.y - 1.5) ** 2 +
        camera.position.z ** 2
      );
      expect(dist).toBeCloseTo(2.7, 1);

      Raycaster.prototype.intersectObjects = origIntersect;
    });

    it('skips deeply nested children of local player mesh', async () => {
      const { Raycaster } = await import('../__mocks__/three.js');

      controls.cameraPitch = 0;
      controls.cameraYaw = 0;
      controls.distance = 10;
      const playerPos = { x: 0, y: 0, z: 0 };

      // Deep parent chain: hit.object → middle → localPlayerMesh
      const localPlayerMesh = { parent: null };
      const middle = { parent: localPlayerMesh };
      const deepHit = { object: { parent: middle }, distance: 5 };
      const scene = { children: [] };

      const origIntersect = Raycaster.prototype.intersectObjects;
      Raycaster.prototype.intersectObjects = () => [deepHit];

      controls.update(playerPos, 0, scene, localPlayerMesh);

      // Deep child of player mesh should be skipped — camera at full distance
      expect(camera.position.z).toBeCloseTo(10, 1);

      Raycaster.prototype.intersectObjects = origIntersect;
    });

    it('ignores collision hits on local player mesh', async () => {
      const { Raycaster } = await import('../__mocks__/three.js');

      controls.cameraPitch = 0;
      controls.cameraYaw = 0;
      controls.distance = 10;
      const playerPos = { x: 0, y: 0, z: 0 };

      const localPlayerMesh = { parent: null };
      // Hit object is a child of localPlayerMesh
      const selfHit = { object: { parent: localPlayerMesh }, distance: 5 };
      const scene = { children: [] };

      const origIntersect = Raycaster.prototype.intersectObjects;
      Raycaster.prototype.intersectObjects = () => [selfHit];

      controls.update(playerPos, 0, scene, localPlayerMesh);

      // Camera should be at full distance since self-hit is skipped
      expect(camera.position.z).toBeCloseTo(10, 1);

      Raycaster.prototype.intersectObjects = origIntersect;
    });
  });
});

// Test isChildOf as a separate concern — it's a module-level function
// We'll test it indirectly through collision behavior
describe('isChildOf (via PlayerControls collision)', () => {
  it('camera collision works without crashing when localPlayerMesh is null', () => {
    const canvas = createMockCanvas();
    const camera = createMockCamera();

    Object.defineProperty(document, 'pointerLockElement', {
      value: null, writable: true, configurable: true,
    });
    document.exitPointerLock = vi.fn();

    const controls = new PlayerControls(camera, canvas);
    const scene = { children: [] };
    expect(() => controls.update({ x: 0, y: 0, z: 0 }, 0, scene, null)).not.toThrow();
  });
});
