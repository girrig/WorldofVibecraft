import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('three', () => import('../__mocks__/three.js'));
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { load() {} },
}));
vi.mock('three/addons/utils/SkeletonUtils.js', () => ({
  clone: () => {
    const { Group } = require('../__mocks__/three.js');
    return new Group();
  },
}));

// Mock terrain/environment loaders
vi.mock('../../client/world/Terrain.js', () => ({
  loadTerrain: vi.fn(() => Promise.resolve()),
  createTerrain: vi.fn(() => {
    const { Group } = require('../__mocks__/three.js');
    return new Group();
  }),
  getTerrainHeight: () => 0,
}));

vi.mock('../../client/world/Environment.js', () => ({
  loadEnvironment: vi.fn(() => Promise.resolve()),
  createEnvironment: vi.fn(() => {
    const { Group } = require('../__mocks__/three.js');
    return new Group();
  }),
  createLighting: vi.fn(),
  createSky: vi.fn(),
}));

vi.mock('../../client/entities/PlayerModel.js', () => ({
  preloadPlayerModel: vi.fn(() => Promise.resolve()),
  getPlayerColor: () => 0x4488ff,
  createPlayerMesh: () => {
    const { Group } = require('../__mocks__/three.js');
    return { group: new Group(), mixer: null, actions: {}, spineBone: null };
  },
}));

// Mock NetworkClient
const mockNetwork = {
  connect: vi.fn(),
  on: vi.fn(),
  sendMove: vi.fn(),
  sendChat: vi.fn(),
  disconnect: vi.fn(),
};
vi.mock('../../client/network.js', () => ({
  NetworkClient: class {
    constructor() { Object.assign(this, mockNetwork); }
  },
}));

// Mock canvas 2D context for ChatBox/Minimap/RemotePlayer nameplates
const mockCtx = {
  fillStyle: '', font: '', textAlign: '', lineWidth: 0, strokeStyle: '',
  fillText: vi.fn(), fillRect: vi.fn(), fill: vi.fn(), roundRect: vi.fn(),
  clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
  stroke: vi.fn(), arc: vi.fn(),
};
HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx);

import { Game } from '../../client/Game.js';
import { MSG } from '../../shared/constants.js';

// Set up DOM elements that Game expects
function setupDOM() {
  document.body.innerHTML = `
    <canvas id="game-canvas"></canvas>
    <div id="game-container"></div>
    <div id="chat-log"></div>
    <input id="chat-input" />
    <div id="hud-coords"></div>
    <div id="hud-players"></div>
    <canvas id="minimap-canvas" width="150" height="150"></canvas>
  `;
}

describe('Game', () => {
  let game;

  beforeEach(() => {
    setupDOM();
    vi.clearAllMocks();
    mockNetwork.connect.mockResolvedValue({
      id: 'player1',
      players: [
        { id: 'player1', name: 'Me', position: { x: 0, y: 0, z: 0 } },
        { id: 'player2', name: 'Other', position: { x: 10, y: 0, z: 10 } },
      ],
    });
    game = new Game();
  });

  afterEach(() => {
    if (game) game.stop();
  });

  describe('constructor', () => {
    it('initializes with null state', () => {
      expect(game.scene).toBeNull();
      expect(game.camera).toBeNull();
      expect(game.renderer).toBeNull();
      expect(game.controls).toBeNull();
      expect(game.localPlayer).toBeNull();
      expect(game.network).toBeNull();
    });

    it('initializes empty remotePlayers map', () => {
      expect(game.remotePlayers).toBeInstanceOf(Map);
      expect(game.remotePlayers.size).toBe(0);
    });
  });

  describe('initRenderer', () => {
    it('creates renderer and camera', () => {
      game.initRenderer();
      expect(game.renderer).not.toBeNull();
      expect(game.camera).not.toBeNull();
    });

    it('enables shadow maps', () => {
      game.initRenderer();
      expect(game.renderer.shadowMap.enabled).toBe(true);
    });
  });

  describe('initGame', () => {
    beforeEach(() => {
      game.initRenderer();
      game.network = { on: vi.fn(), sendMove: vi.fn(), sendChat: vi.fn() };
    });

    it('creates scene', async () => {
      await game.initGame({ id: 'p1', players: [] }, 'TestPlayer');
      expect(game.scene).not.toBeNull();
    });

    it('creates local player with given id and name', async () => {
      await game.initGame({ id: 'p1', players: [] }, 'TestPlayer');
      expect(game.localPlayer).not.toBeNull();
      expect(game.localPlayer.id).toBe('p1');
      expect(game.localPlayer.name).toBe('TestPlayer');
    });

    it('adds existing remote players from welcome data', async () => {
      await game.initGame({
        id: 'p1',
        players: [
          { id: 'p1', name: 'Me' },
          { id: 'p2', name: 'Other', position: { x: 5, y: 0, z: 5 } },
        ],
      }, 'Me');
      expect(game.remotePlayers.size).toBe(1);
      expect(game.remotePlayers.has('p2')).toBe(true);
    });

    it('skips self in welcome player list', async () => {
      await game.initGame({
        id: 'p1',
        players: [{ id: 'p1', name: 'Me' }],
      }, 'Me');
      expect(game.remotePlayers.size).toBe(0);
    });

    it('creates controls, chatBox, minimap, and hud', async () => {
      await game.initGame({ id: 'p1', players: [] }, 'TestPlayer');
      expect(game.controls).not.toBeNull();
      expect(game.chatBox).not.toBeNull();
      expect(game.minimap).not.toBeNull();
      expect(game.hud).not.toBeNull();
    });
  });

  describe('setupNetworkHandlers', () => {
    beforeEach(async () => {
      game.initRenderer();
      game.network = { on: vi.fn(), sendMove: vi.fn(), sendChat: vi.fn() };
      await game.initGame({ id: 'p1', players: [] }, 'TestPlayer');
    });

    it('registers handlers for PLAYER_JOINED, PLAYER_LEFT, STATE, CHAT', () => {
      const registeredTypes = game.network.on.mock.calls.map(c => c[0]);
      expect(registeredTypes).toContain(MSG.PLAYER_JOINED);
      expect(registeredTypes).toContain(MSG.PLAYER_LEFT);
      expect(registeredTypes).toContain(MSG.STATE);
      expect(registeredTypes).toContain(MSG.CHAT);
    });
  });

  describe('addRemotePlayer', () => {
    beforeEach(async () => {
      game.initRenderer();
      game.network = { on: vi.fn(), sendMove: vi.fn(), sendChat: vi.fn() };
      await game.initGame({ id: 'p1', players: [] }, 'TestPlayer');
    });

    it('adds player to remotePlayers map', () => {
      game.addRemotePlayer({ id: 'r1', name: 'Remote', position: { x: 0, y: 0, z: 0 } });
      expect(game.remotePlayers.size).toBe(1);
      expect(game.remotePlayers.get('r1').name).toBe('Remote');
    });

    it('adds player mesh to scene', () => {
      const childCount = game.scene.children.length;
      game.addRemotePlayer({ id: 'r1', name: 'Remote', position: { x: 0, y: 0, z: 0 } });
      expect(game.scene.children.length).toBe(childCount + 1);
    });

    it('defaults position to origin when not provided', () => {
      game.addRemotePlayer({ id: 'r1', name: 'Remote' });
      expect(game.remotePlayers.get('r1')).toBeDefined();
    });
  });

  describe('network handler callbacks', () => {
    let handlers;

    beforeEach(async () => {
      game.initRenderer();
      game.network = { on: vi.fn(), sendMove: vi.fn(), sendChat: vi.fn() };
      await game.initGame({ id: 'p1', players: [] }, 'TestPlayer');

      // Extract registered handlers
      handlers = {};
      for (const call of game.network.on.mock.calls) {
        handlers[call[0]] = call[1];
      }
    });

    it('PLAYER_JOINED adds remote player', () => {
      handlers[MSG.PLAYER_JOINED]({
        player: { id: 'r2', name: 'NewPlayer', position: { x: 0, y: 0, z: 0 } },
      });
      expect(game.remotePlayers.size).toBe(1);
      expect(game.remotePlayers.has('r2')).toBe(true);
    });

    it('PLAYER_LEFT removes remote player', () => {
      game.addRemotePlayer({ id: 'r2', name: 'Leaving', position: { x: 0, y: 0, z: 0 } });
      expect(game.remotePlayers.size).toBe(1);

      handlers[MSG.PLAYER_LEFT]({ id: 'r2' });
      expect(game.remotePlayers.size).toBe(0);
    });

    it('PLAYER_LEFT is safe for unknown player id', () => {
      expect(() => handlers[MSG.PLAYER_LEFT]({ id: 'nonexistent' })).not.toThrow();
    });

    it('STATE updates remote player targets', () => {
      game.addRemotePlayer({ id: 'r2', name: 'Remote', position: { x: 0, y: 0, z: 0 } });
      const rp = game.remotePlayers.get('r2');
      const spy = vi.spyOn(rp, 'updateTarget');

      handlers[MSG.STATE]({
        players: [
          { id: 'p1', position: { x: 1, y: 0, z: 1 }, rotation: 0 },
          { id: 'r2', position: { x: 5, y: 0, z: 5 }, rotation: 1.5 },
        ],
      });

      expect(spy).toHaveBeenCalledWith({ x: 5, y: 0, z: 5 }, 1.5);
    });

    it('STATE skips local player updates', () => {
      handlers[MSG.STATE]({
        players: [{ id: 'p1', position: { x: 99, y: 0, z: 99 }, rotation: 0 }],
      });
      // Local player position should not be overwritten by state
      expect(game.localPlayer.position.x).not.toBe(99);
    });

    it('CHAT adds message to chatBox', () => {
      const spy = vi.spyOn(game.chatBox, 'addMessage');
      handlers[MSG.CHAT]({ name: 'Someone', message: 'Hello!' });
      expect(spy).toHaveBeenCalledWith('Someone', 'Hello!');
    });
  });

  describe('stop', () => {
    it('cancels animation frame', () => {
      game.animFrameId = 123;
      const spy = vi.spyOn(global, 'cancelAnimationFrame').mockImplementation(() => {});
      game.stop();
      expect(spy).toHaveBeenCalledWith(123);
      expect(game.animFrameId).toBeNull();
      spy.mockRestore();
    });

    it('is safe to call when no animation running', () => {
      expect(() => game.stop()).not.toThrow();
    });
  });

  describe('input handling', () => {
    beforeEach(async () => {
      game.initRenderer();
      game.network = { on: vi.fn(), sendMove: vi.fn(), sendChat: vi.fn() };
      await game.initGame({ id: 'p1', players: [] }, 'TestPlayer');
    });

    it('creates walk/run overlay', () => {
      const overlay = document.getElementById('emote-overlay');
      expect(overlay).not.toBeNull();
    });

    it('keydown sets player key', () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      expect(game.localPlayer.keys.w).toBe(true);
    });

    it('keyup clears player key', () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
      expect(game.localPlayer.keys.w).toBe(false);
    });

    it('/ key toggles walk mode', () => {
      expect(game.localPlayer.walkMode).toBe(false);
      const event = new KeyboardEvent('keydown', { key: '/' });
      document.dispatchEvent(event);
      expect(game.localPlayer.walkMode).toBe(true);
    });

    it('ignores keys when chat is open', () => {
      game.chatBox.isOpen = true;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      expect(game.localPlayer.keys.w).toBe(false);
    });

    it('W key cancels autorun', () => {
      game.localPlayer.autorun = true;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      expect(game.localPlayer.autorun).toBe(false);
    });
  });
});
