// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Mock WebSocket that tracks instances and allows simulating events.
 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.sent = [];
    this.closed = false;
    MockWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }

  simulateMessage(data) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }

  simulateError() {
    if (this.onerror) this.onerror(new Error('ws error'));
  }
}

// Minimal CustomEvent polyfill for Node environment
class MockCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail || null;
  }
}

// Set up global mocks before loading the module
global.window = { dispatchEvent: vi.fn() };
global.CustomEvent = MockCustomEvent;
global.location = { protocol: 'http:', host: 'localhost:7247' };
global.WebSocket = MockWebSocket;

// Load the module — it auto-instantiates window.wsClient
require('../../public/js/ws-client.js');

const { WSClient } = global.window;

/** Get the most recent MockWebSocket instance */
function lastWs() {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

describe('WSClient', () => {
  let client;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    global.window.dispatchEvent.mockClear();
    client = new WSClient();
  });

  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  describe('connect', () => {
    it('should create a WebSocket with ws:// URL from http: origin', () => {
      global.location.protocol = 'http:';
      client.connect();
      expect(lastWs().url).toBe('ws://localhost:7247/ws');
    });

    it('should create a WebSocket with wss:// URL from https: origin', () => {
      const origProtocol = global.location.protocol;
      try {
        global.location = { ...global.location, protocol: 'https:' };
        client.connect();
        expect(lastWs().url).toBe('wss://localhost:7247/ws');
      } finally {
        global.location = { ...global.location, protocol: origProtocol };
      }
    });

    it('should set connected to true on open', () => {
      client.connect();
      expect(client.connected).toBe(false);
      lastWs().simulateOpen();
      expect(client.connected).toBe(true);
    });

    it('should be a no-op if already connected', () => {
      client.connect();
      lastWs().simulateOpen();
      const firstWs = lastWs();
      client.connect(); // should not create a new socket
      expect(lastWs()).toBe(firstWs);
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('should be a no-op if currently connecting', () => {
      client.connect();
      // readyState is CONNECTING
      const firstWs = lastWs();
      client.connect();
      expect(lastWs()).toBe(firstWs);
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  describe('subscribe', () => {
    it('should return an unsubscribe function', () => {
      client.connect();
      lastWs().simulateOpen();
      const unsub = client.subscribe('analysis:123', vi.fn());
      expect(typeof unsub).toBe('function');
    });

    it('should send subscribe message when connected', () => {
      client.connect();
      lastWs().simulateOpen();
      client.subscribe('analysis:123', vi.fn());
      const sent = lastWs().sent.map((s) => JSON.parse(s));
      expect(sent).toContainEqual({ action: 'subscribe', topic: 'analysis:123' });
    });

    it('should replay subscription from _subscriptions on connect', () => {
      // Subscribe before connect
      const cb = vi.fn();
      client.subscribe('analysis:456', cb);
      // Subscription is tracked locally
      expect(client._subscriptions.has('analysis:456')).toBe(true);
      // Now connect
      client.connect();
      lastWs().simulateOpen();
      // Subscribe message should be sent from _subscriptions on open
      const sent = lastWs().sent.map((s) => JSON.parse(s));
      const subscribes = sent.filter(
        (m) => m.action === 'subscribe' && m.topic === 'analysis:456'
      );
      expect(subscribes).toHaveLength(1);
    });

    it('should track subscription locally even when disconnected', () => {
      client.subscribe('topic-a', vi.fn());
      expect(client._subscriptions.has('topic-a')).toBe(true);
    });
  });

  describe('message dispatch', () => {
    it('should dispatch messages to the correct topic callbacks', () => {
      client.connect();
      lastWs().simulateOpen();
      const cbA = vi.fn();
      const cbB = vi.fn();
      client.subscribe('topic-a', cbA);
      client.subscribe('topic-b', cbB);

      lastWs().simulateMessage({ topic: 'topic-a', data: 'hello' });
      expect(cbA).toHaveBeenCalledWith({ topic: 'topic-a', data: 'hello' });
      expect(cbB).not.toHaveBeenCalled();
    });

    it('should dispatch to multiple callbacks on the same topic', () => {
      client.connect();
      lastWs().simulateOpen();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      client.subscribe('shared-topic', cb1);
      client.subscribe('shared-topic', cb2);

      lastWs().simulateMessage({ topic: 'shared-topic', value: 42 });
      expect(cb1).toHaveBeenCalledWith({ topic: 'shared-topic', value: 42 });
      expect(cb2).toHaveBeenCalledWith({ topic: 'shared-topic', value: 42 });
    });

    it('should isolate callback errors so all subscribers are called', () => {
      client.connect();
      lastWs().simulateOpen();

      const throwingCb = vi.fn(() => { throw new Error('subscriber boom'); });
      const healthyCb = vi.fn();
      client.subscribe('fragile-topic', throwingCb);
      client.subscribe('fragile-topic', healthyCb);

      // Should not throw despite the first callback throwing
      lastWs().simulateMessage({ topic: 'fragile-topic', value: 1 });

      expect(throwingCb).toHaveBeenCalledTimes(1);
      expect(healthyCb).toHaveBeenCalledTimes(1);
      expect(healthyCb).toHaveBeenCalledWith({ topic: 'fragile-topic', value: 1 });
    });

    it('should ignore messages for unknown topics', () => {
      client.connect();
      lastWs().simulateOpen();
      // Should not throw
      lastWs().simulateMessage({ topic: 'unknown', data: 'x' });
    });

    it('should ignore malformed JSON messages', () => {
      client.connect();
      lastWs().simulateOpen();
      // Directly trigger onmessage with invalid JSON
      lastWs().onmessage({ data: 'not-json{{{' });
      // Should not throw
    });
  });

  describe('unsubscribe', () => {
    it('should remove callback from the topic', () => {
      client.connect();
      lastWs().simulateOpen();
      const cb = vi.fn();
      const unsub = client.subscribe('topic-x', cb);

      unsub();

      lastWs().simulateMessage({ topic: 'topic-x', data: 'ignored' });
      expect(cb).not.toHaveBeenCalled();
    });

    it('should send unsubscribe message when last callback removed', () => {
      client.connect();
      lastWs().simulateOpen();
      const unsub = client.subscribe('topic-y', vi.fn());

      unsub();

      const sent = lastWs().sent.map((s) => JSON.parse(s));
      expect(sent).toContainEqual({ action: 'unsubscribe', topic: 'topic-y' });
    });

    it('should NOT send unsubscribe when other callbacks remain', () => {
      client.connect();
      lastWs().simulateOpen();
      const unsub1 = client.subscribe('topic-z', vi.fn());
      client.subscribe('topic-z', vi.fn());

      unsub1();

      const sent = lastWs().sent.map((s) => JSON.parse(s));
      const unsubs = sent.filter((m) => m.action === 'unsubscribe');
      expect(unsubs).toHaveLength(0);
      expect(client._subscriptions.has('topic-z')).toBe(true);
    });

    it('should remove subscription when unsubscribing before connect', () => {
      const unsub = client.subscribe('queued-topic', vi.fn());
      expect(client._subscriptions.has('queued-topic')).toBe(true);

      unsub();

      expect(client._subscriptions.has('queued-topic')).toBe(false);
    });
  });

  describe('reconnect', () => {
    it('should schedule reconnect on unexpected close', () => {
      client.connect();
      lastWs().simulateOpen();
      lastWs().simulateClose();

      expect(client.connected).toBe(false);
      // Verify a new connection is attempted after the timer fires
      vi.advanceTimersByTime(1000);
      // A new WebSocket should have been created
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    it('should NOT reconnect after intentional close()', () => {
      client.connect();
      lastWs().simulateOpen();

      client.close();

      vi.advanceTimersByTime(15000);
      // No new WebSocket should have been created after the original
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it('should re-send all active subscriptions on reconnect', () => {
      client.connect();
      lastWs().simulateOpen();
      client.subscribe('persist-a', vi.fn());
      client.subscribe('persist-b', vi.fn());

      // Simulate disconnect
      lastWs().simulateClose();

      // Trigger the reconnect
      vi.advanceTimersByTime(1000);
      const newSocket = lastWs();
      newSocket.simulateOpen();

      const sent = newSocket.sent.map((s) => JSON.parse(s));
      expect(sent).toContainEqual({ action: 'subscribe', topic: 'persist-a' });
      expect(sent).toContainEqual({ action: 'subscribe', topic: 'persist-b' });
    });

    it('should use exponential backoff capped at 10s', () => {
      client.connect();
      lastWs().simulateOpen();

      // Close without reopening — backoff should grow each time
      lastWs().simulateClose();
      // First reconnect after 1s
      vi.advanceTimersByTime(999);
      expect(MockWebSocket.instances).toHaveLength(1); // not yet
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(2); // reconnect #1

      // Close again without opening — backoff should be 2s
      lastWs().simulateClose();
      vi.advanceTimersByTime(1999);
      expect(MockWebSocket.instances).toHaveLength(2); // not yet
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(3); // reconnect #2

      // Close again — backoff should be 4s
      lastWs().simulateClose();
      vi.advanceTimersByTime(3999);
      expect(MockWebSocket.instances).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(4); // reconnect #3

      // Close again — backoff should be 8s
      lastWs().simulateClose();
      vi.advanceTimersByTime(7999);
      expect(MockWebSocket.instances).toHaveLength(4);
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(5); // reconnect #4

      // Close again — backoff should be capped at 10s (not 16s)
      lastWs().simulateClose();
      vi.advanceTimersByTime(9999);
      expect(MockWebSocket.instances).toHaveLength(5);
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(6); // reconnect #5
    });

    it('should reset backoff on successful connection', () => {
      client.connect();
      lastWs().simulateOpen();

      // Close and let backoff grow
      lastWs().simulateClose();
      vi.advanceTimersByTime(1000); // reconnect at 1s
      lastWs().simulateClose(); // close again without opening
      vi.advanceTimersByTime(2000); // reconnect at 2s, backoff now 4s

      // Now successfully open and close
      lastWs().simulateOpen(); // resets backoff to 1s
      lastWs().simulateClose();

      // Next reconnect should be at 1s again (not 4s)
      vi.advanceTimersByTime(999);
      const countBefore = MockWebSocket.instances.length;
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances).toHaveLength(countBefore + 1);
    });
  });

  describe('wsReconnected event', () => {
    it('should NOT dispatch wsReconnected on initial connect', () => {
      client.connect();
      lastWs().simulateOpen();

      expect(global.window.dispatchEvent).not.toHaveBeenCalled();
    });

    it('should dispatch wsReconnected on reconnect after disconnect', () => {
      client.connect();
      lastWs().simulateOpen();
      lastWs().simulateClose();

      vi.advanceTimersByTime(1000);
      lastWs().simulateOpen(); // this is a reconnect

      expect(global.window.dispatchEvent).toHaveBeenCalledTimes(1);
      const event = global.window.dispatchEvent.mock.calls[0][0];
      expect(event).toBeInstanceOf(MockCustomEvent);
      expect(event.type).toBe('wsReconnected');
    });

    it('should dispatch wsReconnected on each subsequent reconnect', () => {
      client.connect();
      lastWs().simulateOpen(); // initial — no event

      // First reconnect
      lastWs().simulateClose();
      vi.advanceTimersByTime(1000);
      lastWs().simulateOpen();
      expect(global.window.dispatchEvent).toHaveBeenCalledTimes(1);

      // Second reconnect
      lastWs().simulateClose();
      vi.advanceTimersByTime(1000);
      lastWs().simulateOpen();
      expect(global.window.dispatchEvent).toHaveBeenCalledTimes(2);
    });

    it('should set _hasConnected flag after first connect', () => {
      expect(client._hasConnected).toBe(false);
      client.connect();
      lastWs().simulateOpen();
      expect(client._hasConnected).toBe(true);
    });
  });

  describe('close', () => {
    it('should close the WebSocket and set connected to false', () => {
      client.connect();
      lastWs().simulateOpen();
      expect(client.connected).toBe(true);

      client.close();
      expect(client.connected).toBe(false);
    });

    it('should clear reconnect timer', () => {
      client.connect();
      lastWs().simulateOpen();
      lastWs().simulateClose();
      // reconnect timer is scheduled

      client.close();

      // Advance time well past any backoff — no new WebSocket should be created
      const countBefore = MockWebSocket.instances.length;
      vi.advanceTimersByTime(15000);
      expect(MockWebSocket.instances).toHaveLength(countBefore);
    });

    it('should be safe to call multiple times', () => {
      client.connect();
      lastWs().simulateOpen();
      client.close();
      client.close(); // should not throw
    });
  });

  describe('auto-instantiation', () => {
    it('should expose WSClient class on window', () => {
      expect(global.window.WSClient).toBe(WSClient);
    });

    it('should expose wsClient singleton on window', () => {
      expect(global.window.wsClient).toBeDefined();
      expect(global.window.wsClient).toBeInstanceOf(WSClient);
    });
  });
});
