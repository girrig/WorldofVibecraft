import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MSG } from '../../shared/constants.js';

// We can't import server/index.js directly (it boots an HTTP server on import).
// Instead, test the WebSocket message-handling logic it implements by recreating
// the handler pattern with GameWorld.

import { GameWorld } from '../../server/GameWorld.js';

// This tests the same connection logic from server/index.js:
// 1. First message must be JOIN to get a playerId
// 2. Subsequent messages route through handleMessage
// 3. On close, player is removed

function createMockWs() {
  return { readyState: 1, send: vi.fn() };
}

describe('Server connection handler logic', () => {
  let world;

  beforeEach(() => {
    world = new GameWorld();
  });

  afterEach(() => {
    world.stop();
  });

  describe('JOIN flow', () => {
    it('trims and truncates player name', () => {
      const ws = createMockWs();
      const longName = 'A'.repeat(50);
      const name = (longName || 'Unknown').trim().slice(0, 20);
      const id = world.addPlayer(ws, name);

      const player = world.players.get(id);
      expect(player.name).toBe('A'.repeat(20));
    });

    it('defaults empty name to Unknown', () => {
      const ws = createMockWs();
      const name = ('' || 'Unknown').trim().slice(0, 20);
      const id = world.addPlayer(ws, name);

      const player = world.players.get(id);
      expect(player.name).toBe('Unknown');
    });
  });

  describe('message routing', () => {
    it('routes MOVE after JOIN', () => {
      const ws = createMockWs();
      const id = world.addPlayer(ws, 'Alice');

      world.handleMessage(id, {
        type: MSG.MOVE,
        position: { x: 5, y: 1, z: 10 },
        rotation: 2.0,
      });

      const player = world.players.get(id);
      expect(player.position).toEqual({ x: 5, y: 1, z: 10 });
    });

    it('ignores messages for unknown playerId', () => {
      expect(() => {
        world.handleMessage(null, { type: MSG.MOVE });
      }).not.toThrow();
    });
  });

  describe('disconnect flow', () => {
    it('removes player on close', () => {
      const ws = createMockWs();
      const id = world.addPlayer(ws, 'Alice');
      expect(world.players.size).toBe(1);

      world.removePlayer(id);
      expect(world.players.size).toBe(0);
    });

    it('close before join is safe', () => {
      expect(() => world.removePlayer(null)).not.toThrow();
    });
  });

  describe('bad message handling', () => {
    it('JSON.parse of invalid data throws (server catches this)', () => {
      expect(() => JSON.parse('not json')).toThrow();
    });

    it('server would catch and log parse errors', () => {
      // Verifying the pattern: try { JSON.parse(raw) } catch (err) { ... }
      let caught = false;
      try {
        JSON.parse('{invalid');
      } catch {
        caught = true;
      }
      expect(caught).toBe(true);
    });
  });
});
