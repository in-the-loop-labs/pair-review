// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { WebSocketServer } = require('ws');
const logger = require('../utils/logger');
const { worktreePoolUsage } = require('../git/worktree-pool-usage');
const { WorktreePoolRepository } = require('../database');

const HEARTBEAT_INTERVAL = 30000;

let wss = null;
let heartbeatTimer = null;

/**
 * Attach a WebSocket server to an existing HTTP server.
 * Operates in noServer mode, handling upgrade requests on the /ws path only.
 * @param {import('http').Server} httpServer
 * @param {Object} [db] - Database instance for pool worktree lookups
 */
function attachWebSocket(httpServer, db) {
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

  let nextWsId = 1;

  wss.on('connection', (ws) => {
    ws._topics = new Set();
    ws._wsId = nextWsId++;
    ws._poolSessions = [];
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

        // Track pool worktree usage for review topics
        if (topic.startsWith('review:') && db) {
          const reviewId = parseInt(topic.substring(7), 10);
          if (!isNaN(reviewId)) {
            const poolRepo = new WorktreePoolRepository(db);
            poolRepo.findByReviewId(reviewId).then(poolResult => {
              if (poolResult) {
                // Guard against race: socket may have closed or unsubscribed
                // while the async lookup was in flight
                if (ws.readyState !== ws.OPEN || !ws._topics.has(topic)) {
                  logger.debug(`WS: skipping pool session registration for ws-${ws._wsId} — socket closed or unsubscribed during lookup`);
                  return;
                }
                const sessionKey = `ws-${ws._wsId}-${topic}`;
                ws._poolSessions.push({ worktreeId: poolResult.id, sessionKey });
                worktreePoolUsage.addSession(poolResult.id, sessionKey);
              }
            }).catch(err => {
              logger.debug(`WS: pool worktree lookup failed for review ${reviewId}: ${err.message}`);
            });
          }
        }
      } else if (action === 'unsubscribe') {
        ws._topics.delete(topic);

        // Untrack pool worktree usage for review topics
        if (topic.startsWith('review:') && ws._poolSessions.length > 0) {
          const expectedKey = `ws-${ws._wsId}-${topic}`;
          ws._poolSessions = ws._poolSessions.filter(s => {
            if (s.sessionKey === expectedKey) {
              worktreePoolUsage.removeSession(s.worktreeId, s.sessionKey);
              return false;
            }
            return true;
          });
        }
      }
    });

    ws.on('close', () => {
      // Clean up all pool worktree sessions
      for (const { worktreeId, sessionKey } of ws._poolSessions) {
        worktreePoolUsage.removeSession(worktreeId, sessionKey);
      }
      ws._poolSessions = [];
      ws._topics.clear();
    });

    ws.on('error', (err) => {
      logger.warn(`WS: client error: ${err.message}`);
      // Clean up all pool worktree sessions
      for (const { worktreeId, sessionKey } of ws._poolSessions) {
        worktreePoolUsage.removeSession(worktreeId, sessionKey);
      }
      ws._poolSessions = [];
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
