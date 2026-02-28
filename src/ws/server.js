// SPDX-License-Identifier: GPL-3.0-or-later
const { WebSocketServer } = require('ws');
const logger = require('../utils/logger');

const HEARTBEAT_INTERVAL = 30000;

let wss = null;
let heartbeatTimer = null;

/**
 * Attach a WebSocket server to an existing HTTP server.
 * Operates in noServer mode, handling upgrade requests on the /ws path only.
 * @param {import('http').Server} httpServer
 */
function attachWebSocket(httpServer) {
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    ws._topics = new Set();
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        logger.warn('WS: received non-JSON message');
        return;
      }

      const { action, topic } = msg;
      if (!topic) return;

      if (action === 'subscribe') {
        ws._topics.add(topic);
      } else if (action === 'unsubscribe') {
        ws._topics.delete(topic);
      }
    });

    ws.on('close', () => {
      ws._topics.clear();
    });

    ws.on('error', (err) => {
      logger.warn(`WS: client error: ${err.message}`);
      ws._topics.clear();
    });
  });

  // Heartbeat: ping every HEARTBEAT_INTERVAL, terminate dead connections
  heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        logger.debug('WS: terminating unresponsive client');
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  logger.info('WebSocket server attached on /ws');
}

/**
 * Broadcast a payload to all clients subscribed to the given topic.
 * @param {string} topic
 * @param {object} payload
 */
function broadcast(topic, payload) {
  if (!wss) return;

  const message = JSON.stringify({ ...payload, topic });

  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN && ws._topics && ws._topics.has(topic)) {
      try {
        ws.send(message);
      } catch (err) {
        logger.debug(`WS: failed to send to client: ${err.message}`);
      }
    }
  });
}

/**
 * Close all connections and shut down the WebSocket server.
 */
function closeAll() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (!wss) return;

  wss.clients.forEach((ws) => {
    ws.terminate();
  });

  wss.close();
  wss = null;
}

module.exports = { attachWebSocket, broadcast, closeAll, get _wss() { return wss; } };
