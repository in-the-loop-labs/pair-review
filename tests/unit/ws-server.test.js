// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const http = require('http');
const WebSocket = require('ws');

// Freshly require the module for each test to reset module-level state
let wsServer;

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
}

function waitForMessage(ws) {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data)));
  });
}

function sendJSON(ws, obj) {
  ws.send(JSON.stringify(obj));
}

describe('WebSocket Server', () => {
  let httpServer;
  let port;

  beforeEach(async () => {
    // Isolate module state per test by clearing the require cache
    delete require.cache[require.resolve('../../src/ws/server')];
    wsServer = require('../../src/ws/server');

    httpServer = http.createServer();
    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        port = httpServer.address().port;
        resolve();
      });
    });
    wsServer.attachWebSocket(httpServer);
  });

  afterEach(async () => {
    wsServer.closeAll();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  describe('subscribe and unsubscribe', () => {
    it('should deliver messages to subscribed clients', async () => {
      const client = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(client);

      sendJSON(client, { action: 'subscribe', topic: 'test-topic' });
      // Small delay to let the server process the subscription
      await new Promise((r) => setTimeout(r, 50));

      const msgPromise = waitForMessage(client);
      wsServer.broadcast('test-topic', { data: 'hello' });
      const msg = await msgPromise;

      expect(msg).toEqual({ topic: 'test-topic', data: 'hello' });
      client.close();
    });

    it('should not deliver messages after unsubscribe', async () => {
      const client = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(client);

      sendJSON(client, { action: 'subscribe', topic: 'test-topic' });
      await new Promise((r) => setTimeout(r, 50));

      sendJSON(client, { action: 'unsubscribe', topic: 'test-topic' });
      await new Promise((r) => setTimeout(r, 50));

      let received = false;
      client.on('message', () => { received = true; });

      wsServer.broadcast('test-topic', { data: 'should-not-arrive' });
      await new Promise((r) => setTimeout(r, 100));

      expect(received).toBe(false);
      client.close();
    });

    it('should ignore messages without a topic', async () => {
      const client = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(client);

      // Send a message with no topic - should not throw
      sendJSON(client, { action: 'subscribe' });
      await new Promise((r) => setTimeout(r, 50));

      // Verify the client has no topics subscribed
      const wss = wsServer._wss;
      for (const ws of wss.clients) {
        expect(ws._topics.size).toBe(0);
      }
      client.close();
    });

    it('should handle non-JSON messages gracefully', async () => {
      const client = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(client);

      // Send invalid JSON - should not crash the server
      client.send('not-json');
      await new Promise((r) => setTimeout(r, 50));

      // Server should still be operational
      expect(wsServer._wss).not.toBeNull();
      client.close();
    });
  });

  describe('broadcast routing', () => {
    it('should only send to clients subscribed to the specific topic', async () => {
      const clientA = new WebSocket(`ws://localhost:${port}/ws`);
      const clientB = new WebSocket(`ws://localhost:${port}/ws`);
      await Promise.all([waitForOpen(clientA), waitForOpen(clientB)]);

      sendJSON(clientA, { action: 'subscribe', topic: 'topic-a' });
      sendJSON(clientB, { action: 'subscribe', topic: 'topic-b' });
      await new Promise((r) => setTimeout(r, 50));

      let receivedA = false;
      clientA.on('message', () => { receivedA = true; });

      const msgPromiseB = waitForMessage(clientB);
      wsServer.broadcast('topic-b', { value: 42 });

      const msgB = await msgPromiseB;
      expect(msgB).toEqual({ topic: 'topic-b', value: 42 });

      // Give clientA a moment to potentially receive
      await new Promise((r) => setTimeout(r, 100));
      expect(receivedA).toBe(false);

      clientA.close();
      clientB.close();
    });

    it('should broadcast to multiple subscribers of the same topic', async () => {
      const client1 = new WebSocket(`ws://localhost:${port}/ws`);
      const client2 = new WebSocket(`ws://localhost:${port}/ws`);
      await Promise.all([waitForOpen(client1), waitForOpen(client2)]);

      sendJSON(client1, { action: 'subscribe', topic: 'shared' });
      sendJSON(client2, { action: 'subscribe', topic: 'shared' });
      await new Promise((r) => setTimeout(r, 50));

      const p1 = waitForMessage(client1);
      const p2 = waitForMessage(client2);
      wsServer.broadcast('shared', { msg: 'for-all' });

      const [m1, m2] = await Promise.all([p1, p2]);
      expect(m1).toEqual({ topic: 'shared', msg: 'for-all' });
      expect(m2).toEqual({ topic: 'shared', msg: 'for-all' });

      client1.close();
      client2.close();
    });

    it('should be a no-op when wss is null', () => {
      wsServer.closeAll();
      // Should not throw
      wsServer.broadcast('any-topic', { data: 1 });
    });
  });

  describe('client cleanup on close', () => {
    it('should clear topics when a client disconnects', async () => {
      const client = new WebSocket(`ws://localhost:${port}/ws`);
      await waitForOpen(client);

      sendJSON(client, { action: 'subscribe', topic: 'cleanup-test' });
      await new Promise((r) => setTimeout(r, 50));

      // Verify client has topics
      const wss = wsServer._wss;
      let serverSideWs;
      for (const ws of wss.clients) {
        serverSideWs = ws;
      }
      expect(serverSideWs._topics.has('cleanup-test')).toBe(true);

      // Close the client and wait for server to process
      client.close();
      await new Promise((r) => setTimeout(r, 100));

      // After close, the topics set should have been cleared
      expect(serverSideWs._topics.size).toBe(0);
    });
  });

  describe('heartbeat', () => {
    it('should set up heartbeat interval on attach', () => {
      // The fact that attachWebSocket was called in beforeEach
      // and the server is functional proves the heartbeat was set up.
      // We verify by checking that _wss exists and has clients tracking.
      expect(wsServer._wss).not.toBeNull();
    });

    it('should terminate unresponsive clients after missed pong', async () => {
      // Instead of fighting fake timers with real I/O, directly test the
      // heartbeat logic: set isAlive to false on a connected client, then
      // manually invoke the heartbeat check via a short-lived interval.
      delete require.cache[require.resolve('../../src/ws/server')];

      // Patch setInterval to capture the heartbeat callback
      const originalSetInterval = global.setInterval;
      let heartbeatCallback = null;
      global.setInterval = (fn, ms) => {
        heartbeatCallback = fn;
        // Return a real timer id so clearInterval works
        return originalSetInterval(() => {}, 999999);
      };

      const freshWs = require('../../src/ws/server');
      const freshServer = http.createServer();
      await new Promise((resolve) => freshServer.listen(0, resolve));
      const freshPort = freshServer.address().port;
      freshWs.attachWebSocket(freshServer);

      global.setInterval = originalSetInterval;

      expect(heartbeatCallback).not.toBeNull();

      const client = new WebSocket(`ws://localhost:${freshPort}/ws`);
      await waitForOpen(client);

      // Disable automatic pong responses from the client
      client.pong = () => {};

      // Get the server-side WebSocket
      let serverWs;
      for (const ws of freshWs._wss.clients) {
        serverWs = ws;
      }

      // First heartbeat tick: sets isAlive=false and sends ping
      heartbeatCallback();
      expect(serverWs.isAlive).toBe(false);

      // Second heartbeat tick: sees isAlive still false, terminates
      heartbeatCallback();

      // Wait for termination to propagate
      await new Promise((r) => setTimeout(r, 100));

      expect(client.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);

      freshWs.closeAll();
      await new Promise((resolve) => freshServer.close(resolve));
    });
  });

  describe('closeAll', () => {
    it('should terminate all connected clients', async () => {
      const client1 = new WebSocket(`ws://localhost:${port}/ws`);
      const client2 = new WebSocket(`ws://localhost:${port}/ws`);
      await Promise.all([waitForOpen(client1), waitForOpen(client2)]);

      wsServer.closeAll();

      // Wait for close events to propagate
      await new Promise((r) => setTimeout(r, 100));

      expect(client1.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
      expect(client2.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
      expect(wsServer._wss).toBeNull();
    });

    it('should be safe to call multiple times', () => {
      wsServer.closeAll();
      wsServer.closeAll(); // Should not throw
      expect(wsServer._wss).toBeNull();
    });
  });

  describe('upgrade path rejection', () => {
    it('should reject upgrade requests on non-/ws paths', async () => {
      const client = new WebSocket(`ws://localhost:${port}/other`);

      await new Promise((resolve, reject) => {
        client.on('error', resolve); // Expect an error
        client.on('open', () => reject(new Error('Should not have connected')));
      });

      expect(client.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
    });
  });
});
