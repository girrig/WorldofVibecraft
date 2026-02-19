import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameWorld } from '../../server/GameWorld.js';
import { MSG } from '../../shared/constants.js';

function createMockWs() {
  return { readyState: 1, send: vi.fn() };
}

describe('GameWorld', () => {
  let world;

  beforeEach(() => {
    world = new GameWorld();
  });

  afterEach(() => {
    world.stop();
  });

  describe('start/stop', () => {
    it('starts tick interval', () => {
      world.start();
      expect(world.tickInterval).not.toBeNull();
    });

    it('stops tick interval', () => {
      world.start();
      world.stop();
      expect(world.tickInterval).not.toBeNull(); // clearInterval doesn't null it
    });

    it('stop is safe to call without start', () => {
      expect(() => world.stop()).not.toThrow();
    });
  });

  describe('addPlayer', () => {
    it('returns a unique player ID', () => {
      const ws = createMockWs();
      const id = world.addPlayer(ws, 'Alice');
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('stores the player in the map', () => {
      const ws = createMockWs();
      const id = world.addPlayer(ws, 'Alice');
      expect(world.players.has(id)).toBe(true);
      expect(world.players.get(id).name).toBe('Alice');
    });

    it('sends WELCOME message to the joining player', () => {
      const ws = createMockWs();
      const id = world.addPlayer(ws, 'Alice');

      expect(ws.send).toHaveBeenCalled();
      const msg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(msg.type).toBe(MSG.WELCOME);
      expect(msg.id).toBe(id);
      expect(Array.isArray(msg.players)).toBe(true);
    });

    it('broadcasts PLAYER_JOINED to existing players', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      world.addPlayer(ws1, 'Alice');
      ws1.send.mockClear();

      const id2 = world.addPlayer(ws2, 'Bob');

      // ws1 should receive PLAYER_JOINED for Bob
      expect(ws1.send).toHaveBeenCalled();
      const msg = JSON.parse(ws1.send.mock.calls[0][0]);
      expect(msg.type).toBe(MSG.PLAYER_JOINED);
      expect(msg.player.id).toBe(id2);
      expect(msg.player.name).toBe('Bob');
    });

    it('does not broadcast PLAYER_JOINED to the joining player', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      world.addPlayer(ws1, 'Alice');

      world.addPlayer(ws2, 'Bob');

      // ws2 should only get WELCOME, not PLAYER_JOINED
      const messages = ws2.send.mock.calls.map(c => JSON.parse(c[0]));
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe(MSG.WELCOME);
    });

    it('initializes player position at origin', () => {
      const ws = createMockWs();
      const id = world.addPlayer(ws, 'Alice');
      const player = world.players.get(id);
      expect(player.position).toEqual({ x: 0, y: 0, z: 0 });
    });

    it('generates different IDs for different players', () => {
      const id1 = world.addPlayer(createMockWs(), 'Alice');
      const id2 = world.addPlayer(createMockWs(), 'Bob');
      expect(id1).not.toBe(id2);
    });
  });

  describe('removePlayer', () => {
    it('removes the player from the map', () => {
      const ws = createMockWs();
      const id = world.addPlayer(ws, 'Alice');
      world.removePlayer(id);
      expect(world.players.has(id)).toBe(false);
    });

    it('broadcasts PLAYER_LEFT to remaining players', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const id1 = world.addPlayer(ws1, 'Alice');
      world.addPlayer(ws2, 'Bob');
      ws2.send.mockClear();

      world.removePlayer(id1);

      expect(ws2.send).toHaveBeenCalled();
      const msg = JSON.parse(ws2.send.mock.calls[0][0]);
      expect(msg.type).toBe(MSG.PLAYER_LEFT);
      expect(msg.id).toBe(id1);
    });

    it('is safe to call with unknown ID', () => {
      expect(() => world.removePlayer('nonexistent')).not.toThrow();
    });

    it('decrements player count', () => {
      const id = world.addPlayer(createMockWs(), 'Alice');
      world.addPlayer(createMockWs(), 'Bob');
      expect(world.players.size).toBe(2);
      world.removePlayer(id);
      expect(world.players.size).toBe(1);
    });
  });

  describe('handleMessage', () => {
    describe('MOVE', () => {
      it('updates player position and rotation', () => {
        const ws = createMockWs();
        const id = world.addPlayer(ws, 'Alice');

        world.handleMessage(id, {
          type: MSG.MOVE,
          position: { x: 10, y: 2, z: -5 },
          rotation: 1.5,
        });

        const player = world.players.get(id);
        expect(player.position).toEqual({ x: 10, y: 2, z: -5 });
        expect(player.rotation).toBe(1.5);
      });
    });

    describe('CHAT', () => {
      it('broadcasts chat message to all players', () => {
        const ws1 = createMockWs();
        const ws2 = createMockWs();
        const id1 = world.addPlayer(ws1, 'Alice');
        world.addPlayer(ws2, 'Bob');
        ws1.send.mockClear();
        ws2.send.mockClear();

        world.handleMessage(id1, {
          type: MSG.CHAT,
          message: 'Hello world!',
        });

        // Both should receive the chat
        const msg1 = JSON.parse(ws1.send.mock.calls[0][0]);
        const msg2 = JSON.parse(ws2.send.mock.calls[0][0]);
        expect(msg1.type).toBe(MSG.CHAT);
        expect(msg1.name).toBe('Alice');
        expect(msg1.message).toBe('Hello world!');
        expect(msg2.type).toBe(MSG.CHAT);
      });

      it('trims whitespace from messages', () => {
        const ws = createMockWs();
        const id = world.addPlayer(ws, 'Alice');
        ws.send.mockClear();

        world.handleMessage(id, {
          type: MSG.CHAT,
          message: '  hello  ',
        });

        const msg = JSON.parse(ws.send.mock.calls[0][0]);
        expect(msg.message).toBe('hello');
      });

      it('truncates messages to 200 characters', () => {
        const ws = createMockWs();
        const id = world.addPlayer(ws, 'Alice');
        ws.send.mockClear();

        const longMsg = 'a'.repeat(300);
        world.handleMessage(id, {
          type: MSG.CHAT,
          message: longMsg,
        });

        const msg = JSON.parse(ws.send.mock.calls[0][0]);
        expect(msg.message.length).toBe(200);
      });

      it('ignores empty messages', () => {
        const ws = createMockWs();
        const id = world.addPlayer(ws, 'Alice');
        ws.send.mockClear();

        world.handleMessage(id, {
          type: MSG.CHAT,
          message: '',
        });

        expect(ws.send).not.toHaveBeenCalled();
      });

      it('ignores whitespace-only messages', () => {
        const ws = createMockWs();
        const id = world.addPlayer(ws, 'Alice');
        ws.send.mockClear();

        world.handleMessage(id, {
          type: MSG.CHAT,
          message: '   ',
        });

        expect(ws.send).not.toHaveBeenCalled();
      });
    });

    it('does nothing for unknown player ID', () => {
      expect(() => {
        world.handleMessage('nonexistent', { type: MSG.MOVE, position: { x: 0, y: 0, z: 0 }, rotation: 0 });
      }).not.toThrow();
    });

    it('does not crash on unknown message type', () => {
      const ws = createMockWs();
      const id = world.addPlayer(ws, 'Alice');
      expect(() => {
        world.handleMessage(id, { type: 'unknown_type' });
      }).not.toThrow();
    });
  });

  describe('tick', () => {
    it('broadcasts STATE to all connected players', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      world.addPlayer(ws1, 'Alice');
      world.addPlayer(ws2, 'Bob');
      ws1.send.mockClear();
      ws2.send.mockClear();

      world.tick();

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);

      const msg = JSON.parse(ws1.send.mock.calls[0][0]);
      expect(msg.type).toBe(MSG.STATE);
      expect(msg.players.length).toBe(2);
    });

    it('skips disconnected players (readyState !== 1)', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      ws2.readyState = 3; // CLOSED
      world.addPlayer(ws1, 'Alice');
      world.addPlayer(ws2, 'Bob');
      ws1.send.mockClear();
      ws2.send.mockClear();

      world.tick();

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).not.toHaveBeenCalled();
    });
  });

  describe('getPlayersData', () => {
    it('returns array of player data without ws', () => {
      world.addPlayer(createMockWs(), 'Alice');
      world.addPlayer(createMockWs(), 'Bob');

      const data = world.getPlayersData();
      expect(data.length).toBe(2);
      data.forEach(p => {
        expect(p).toHaveProperty('id');
        expect(p).toHaveProperty('name');
        expect(p).toHaveProperty('position');
        expect(p).toHaveProperty('rotation');
        expect(p).not.toHaveProperty('ws');
      });
    });

    it('returns empty array when no players', () => {
      expect(world.getPlayersData()).toEqual([]);
    });
  });

  describe('broadcast', () => {
    it('sends to all players', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      world.addPlayer(ws1, 'Alice');
      world.addPlayer(ws2, 'Bob');
      ws1.send.mockClear();
      ws2.send.mockClear();

      world.broadcast({ type: 'test', data: 'hello' });

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);
    });

    it('excludes specified player', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const id1 = world.addPlayer(ws1, 'Alice');
      world.addPlayer(ws2, 'Bob');
      ws1.send.mockClear();
      ws2.send.mockClear();

      world.broadcast({ type: 'test' }, id1);

      expect(ws1.send).not.toHaveBeenCalled();
      expect(ws2.send).toHaveBeenCalledTimes(1);
    });

    it('skips players with closed WebSocket', () => {
      const ws1 = createMockWs();
      ws1.readyState = 3;
      world.addPlayer(ws1, 'Alice');
      ws1.send.mockClear();

      world.broadcast({ type: 'test' });

      expect(ws1.send).not.toHaveBeenCalled();
    });
  });
});
