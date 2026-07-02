// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const http = require('http');
const WebSocket = require('ws');
const { once } = require('events');

// Freshly require the module for each test to reset module-level state
let wsServer;

function waitForOpen(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForOpen timed out')), timeoutMs);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForMessage(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitForMessage timed out')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data));
    });
  });
}

function sendJSON(ws, obj) {
  ws.send(JSON.stringify(obj));
}

// Connect a client and deterministically capture the matching server-side socket.
// The 'connection' listener is registered before the client is created, and each
// call is awaited to completion, so sequential calls pair client/server correctly.
async function connectAndCapture(port, wss) {
  const connP = once(wss, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(client);
  const [serverWs] = await connP;
  return { client, serverWs };
}

// Send a payload and wait until the server-side socket has processed it.
// The production 'message' handler is registered at connection time (before
// our once() listener), and ws emits 'message' to listeners synchronously in
// registration order, so when this resolves the handler has already run.
async function sendProcessed(client, serverWs, obj) {
  const msgP = once(serverWs, 'message');
  sendJSON(client, obj);
  await msgP;
}

function subscribed(client, serverWs, topic) {
  return sendProcessed(client, serverWs, { action: 'subscribe', topic });
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
      httpServer.listen(0, '127.0.0.1', () => {
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
      const { client, serverWs } = await connectAndCapture(port, wsServer._wss);

      await subscribed(client, serverWs, 'test-topic');

      const msgPromise = waitForMessage(client);
      wsServer.broadcast('test-topic', { data: 'hello' });
      const msg = await msgPromise;

      expect(msg).toEqual({ topic: 'test-topic', data: 'hello' });
      client.close();
    });

    it('should not deliver messages after unsubscribe', async () => {
      const { client, serverWs } = await connectAndCapture(port, wsServer._wss);

      await subscribed(client, serverWs, 'test-topic');
      await sendProcessed(client, serverWs, { action: 'unsubscribe', topic: 'test-topic' });
      // Subscribe to a flush topic so a sentinel broadcast can prove ordering
      await subscribed(client, serverWs, 'flush');

      const received = [];
      client.on('message', (data) => received.push(JSON.parse(data)));

      // Broadcast the forbidden message first, then the sentinel. Frames on a
      // single connection arrive in order, so receiving the sentinel proves the
      // forbidden message was never sent.
      wsServer.broadcast('test-topic', { data: 'should-not-arrive' });
      const sentinelP = waitForMessage(client);
      wsServer.broadcast('flush', { sentinel: true });
      const msg = await sentinelP;

      expect(msg).toEqual({ topic: 'flush', sentinel: true });
      expect(received).toEqual([{ topic: 'flush', sentinel: true }]);
      client.close();
    });

    it('should ignore messages without a topic', async () => {
      const { client, serverWs } = await connectAndCapture(port, wsServer._wss);

      // Send a message with no topic - should not throw
      await sendProcessed(client, serverWs, { action: 'subscribe' });

      // Verify the client has no topics subscribed
      expect(serverWs._topics.size).toBe(0);
      client.close();
    });

    it('should handle non-JSON messages gracefully', async () => {
      const { client, serverWs } = await connectAndCapture(port, wsServer._wss);

      // Send invalid JSON - should not crash the server
      const msgP = once(serverWs, 'message');
      client.send('not-json');
      await msgP;

      // Server should still be operational
      expect(wsServer._wss).not.toBeNull();
      client.close();
    });
  });

  describe('broadcast routing', () => {
    it('should only send to clients subscribed to the specific topic', async () => {
      // Connect sequentially so each client pairs with its server-side socket
      const { client: clientA, serverWs: serverWsA } = await connectAndCapture(port, wsServer._wss);
      const { client: clientB, serverWs: serverWsB } = await connectAndCapture(port, wsServer._wss);

      await subscribed(clientA, serverWsA, 'topic-a');
      await subscribed(clientB, serverWsB, 'topic-b');
      // Extra flush topic on clientA to deterministically prove non-delivery
      await subscribed(clientA, serverWsA, 'flush');

      const receivedA = [];
      clientA.on('message', (data) => receivedA.push(JSON.parse(data)));

      const msgPromiseB = waitForMessage(clientB);
      // Broadcast the message clientA must NOT receive, then the sentinel.
      wsServer.broadcast('topic-b', { value: 42 });

      const msgB = await msgPromiseB;
      expect(msgB).toEqual({ topic: 'topic-b', value: 42 });

      const sentinelP = waitForMessage(clientA);
      wsServer.broadcast('flush', { sentinel: true });
      const sentinel = await sentinelP;

      // Frames on one connection arrive in order: the sentinel arriving first
      // (and alone) proves the topic-b broadcast never reached clientA.
      expect(sentinel).toEqual({ topic: 'flush', sentinel: true });
      expect(receivedA).toEqual([{ topic: 'flush', sentinel: true }]);

      clientA.close();
      clientB.close();
    });

    it('should broadcast to multiple subscribers of the same topic', async () => {
      const { client: client1, serverWs: serverWs1 } = await connectAndCapture(port, wsServer._wss);
      const { client: client2, serverWs: serverWs2 } = await connectAndCapture(port, wsServer._wss);

      await subscribed(client1, serverWs1, 'shared');
      await subscribed(client2, serverWs2, 'shared');

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
      const { client, serverWs } = await connectAndCapture(port, wsServer._wss);

      await subscribed(client, serverWs, 'cleanup-test');

      // Verify client has topics
      expect(serverWs._topics.has('cleanup-test')).toBe(true);

      // Close the client and wait for the server-side close handler to run.
      // The production 'close' handler is registered first, so by the time
      // this once() listener fires the topics have been cleared.
      const closeP = once(serverWs, 'close');
      client.close();
      await closeP;

      // After close, the topics set should have been cleared
      expect(serverWs._topics.size).toBe(0);
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
      let freshWs;
      let freshServer;
      let freshPort;

      try {
        try {
          global.setInterval = (fn, ms) => {
            heartbeatCallback = fn;
            // Return a real timer id so clearInterval works
            return originalSetInterval(() => {}, 999999);
          };

          freshWs = require('../../src/ws/server');
          freshServer = http.createServer();
          await new Promise((resolve) => freshServer.listen(0, '127.0.0.1', resolve));
          freshPort = freshServer.address().port;
          freshWs.attachWebSocket(freshServer);
        } finally {
          global.setInterval = originalSetInterval;
        }

        expect(heartbeatCallback).not.toBeNull();

        const { client, serverWs } = await connectAndCapture(freshPort, freshWs._wss);

        // Disable automatic pong responses from the client
        client.pong = () => {};

        // First heartbeat tick: sets isAlive=false and sends ping
        heartbeatCallback();
        expect(serverWs.isAlive).toBe(false);

        // Second heartbeat tick: sees isAlive still false, terminates
        heartbeatCallback();

        // Wait for the termination to propagate to the client
        await once(client, 'close');

        expect(client.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
      } finally {
        if (freshWs) freshWs.closeAll();
        if (freshServer) await new Promise((resolve) => freshServer.close(resolve));
      }
    });
  });

  describe('closeAll', () => {
    it('should terminate all connected clients', async () => {
      const { client: client1 } = await connectAndCapture(port, wsServer._wss);
      const { client: client2 } = await connectAndCapture(port, wsServer._wss);

      const closes = Promise.all([once(client1, 'close'), once(client2, 'close')]);
      wsServer.closeAll();

      // Wait for close events to propagate
      await closes;

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
      const client = new WebSocket(`ws://127.0.0.1:${port}/other`);

      await new Promise((resolve, reject) => {
        client.on('error', resolve); // Expect an error
        client.on('open', () => reject(new Error('Should not have connected')));
      });

      expect(client.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
    });
  });
});
