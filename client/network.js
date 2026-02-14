import { MSG } from '../shared/constants.js';

export class NetworkClient {
  constructor() {
    this.ws = null;
    this.playerId = null;
    this.handlers = {};
    this.connected = false;
  }

  connect(name) {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.hostname;
      // In dev, connect to the server port (3000); in prod, same port
      const port = 3000;
      this.ws = new WebSocket(`${protocol}://${host}:${port}`);

      this.ws.onopen = () => {
        this.connected = true;
        this.send({ type: MSG.JOIN, name });
      };

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === MSG.WELCOME) {
          this.playerId = data.id;
          resolve(data);
        }
        const handler = this.handlers[data.type];
        if (handler) handler(data);
      };

      this.ws.onclose = () => {
        this.connected = false;
        console.log('Disconnected from server');
      };

      this.ws.onerror = (err) => {
        reject(err);
      };
    });
  }

  on(type, handler) {
    this.handlers[type] = handler;
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  sendMove(position, rotation) {
    this.send({
      type: MSG.MOVE,
      position,
      rotation,
    });
  }

  sendChat(message) {
    this.send({
      type: MSG.CHAT,
      message,
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}
