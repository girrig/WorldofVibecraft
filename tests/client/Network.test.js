import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NetworkClient } from '../../client/network.js';
import { MSG } from '../../shared/constants.js';

// Mock WebSocket
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.sent = [];
    MockWebSocket.lastInstance = this;
  }
  send(data) { this.sent.push(data); }
  close() { if (this.onclose) this.onclose(); }

  // Test helpers
  _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  _message(data) { if (this.onmessage) this.onmessage({ data: JSON.stringify(data) }); }
  _error(err) { if (this.onerror) this.onerror(err); }
}
MockWebSocket.OPEN = 1;
MockWebSocket.lastInstance = null;

// Install mock
globalThis.WebSocket = MockWebSocket;

describe('NetworkClient', () => {
  let client;

  beforeEach(() => {
    client = new NetworkClient();
    MockWebSocket.lastInstance = null;
  });

  describe('constructor', () => {
    it('starts disconnected with no playerId', () => {
      expect(client.connected).toBe(false);
      expect(client.playerId).toBeNull();
      expect(client.ws).toBeNull();
    });
  });

  describe('connect', () => {
    it('creates WebSocket and sends JOIN on open', () => {
      const promise = client.connect('Alice');
      const ws = MockWebSocket.lastInstance;
      expect(ws).not.toBeNull();

      ws._open();
      // Should have sent JOIN
      expect(ws.sent.length).toBe(1);
      expect(JSON.parse(ws.sent[0])).toEqual({ type: MSG.JOIN, name: 'Alice' });
    });

    it('resolves with welcome data and sets playerId', async () => {
      const promise = client.connect('Alice');
      const ws = MockWebSocket.lastInstance;
      ws._open();
      ws._message({ type: MSG.WELCOME, id: 'abc123', players: [] });

      const data = await promise;
      expect(data.type).toBe(MSG.WELCOME);
      expect(data.id).toBe('abc123');
      expect(client.playerId).toBe('abc123');
      expect(client.connected).toBe(true);
    });

    it('rejects on error', async () => {
      const promise = client.connect('Alice');
      const ws = MockWebSocket.lastInstance;
      ws._error(new Error('connection failed'));

      await expect(promise).rejects.toThrow('connection failed');
    });

    it('sets connected to false on close', async () => {
      const promise = client.connect('Alice');
      const ws = MockWebSocket.lastInstance;
      ws._open();
      ws._message({ type: MSG.WELCOME, id: 'x', players: [] });
      await promise;

      expect(client.connected).toBe(true);
      ws.close();
      expect(client.connected).toBe(false);
    });
  });

  describe('on', () => {
    it('registers and calls handlers for message types', async () => {
      const handler = vi.fn();
      client.on(MSG.STATE, handler);

      const promise = client.connect('Alice');
      const ws = MockWebSocket.lastInstance;
      ws._open();
      ws._message({ type: MSG.WELCOME, id: 'x', players: [] });
      await promise;

      ws._message({ type: MSG.STATE, players: [{ id: 'x' }] });
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.STATE }));
    });
  });

  describe('send', () => {
    it('sends JSON when connected', async () => {
      const promise = client.connect('Alice');
      const ws = MockWebSocket.lastInstance;
      ws._open();
      ws._message({ type: MSG.WELCOME, id: 'x', players: [] });
      await promise;

      client.send({ type: 'test', data: 123 });
      const last = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(last).toEqual({ type: 'test', data: 123 });
    });

    it('does not send when ws is null', () => {
      expect(() => client.send({ type: 'test' })).not.toThrow();
    });
  });

  describe('sendMove', () => {
    it('sends MOVE message with position and rotation', async () => {
      const promise = client.connect('Alice');
      const ws = MockWebSocket.lastInstance;
      ws._open();
      ws._message({ type: MSG.WELCOME, id: 'x', players: [] });
      await promise;

      client.sendMove({ x: 1, y: 2, z: 3 }, 1.5);
      const last = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(last.type).toBe(MSG.MOVE);
      expect(last.position).toEqual({ x: 1, y: 2, z: 3 });
      expect(last.rotation).toBe(1.5);
    });
  });

  describe('sendChat', () => {
    it('sends CHAT message', async () => {
      const promise = client.connect('Alice');
      const ws = MockWebSocket.lastInstance;
      ws._open();
      ws._message({ type: MSG.WELCOME, id: 'x', players: [] });
      await promise;

      client.sendChat('hello!');
      const last = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(last.type).toBe(MSG.CHAT);
      expect(last.message).toBe('hello!');
    });
  });

  describe('disconnect', () => {
    it('closes the WebSocket', async () => {
      const promise = client.connect('Alice');
      const ws = MockWebSocket.lastInstance;
      ws._open();
      ws._message({ type: MSG.WELCOME, id: 'x', players: [] });
      await promise;

      client.disconnect();
      expect(client.connected).toBe(false);
    });

    it('is safe to call when not connected', () => {
      expect(() => client.disconnect()).not.toThrow();
    });
  });
});
