// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Browser-side WebSocket client singleton.
 * Provides topic-based pub/sub over a single WebSocket connection
 * with automatic reconnection and subscription restoration.
 */
(function () {
  'use strict';

  class WSClient {
    constructor() {
      /** @type {WebSocket|null} */
      this._ws = null;
      /** @type {Map<string, Set<Function>>} topic -> callbacks */
      this._subscriptions = new Map();
      /** @type {boolean} */
      this.connected = false;
      /** @type {number} current backoff delay in ms */
      this._backoff = 1000;
      /** @type {number} */
      this._backoffMax = 10000;
      /** @type {boolean} whether close() was called intentionally */
      this._closed = false;
      /** @type {Array<object>} messages queued while socket not yet open */
      this._queue = [];
      /** @type {number|null} reconnect timer id */
      this._reconnectTimer = null;
    }

    /**
     * Open the WebSocket connection. No-op if already connected or connecting.
     */
    connect() {
      if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      this._closed = false;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${location.host}/ws`;
      this._ws = new WebSocket(url);

      this._ws.onopen = () => {
        this.connected = true;
        this._backoff = 1000;
        // Flush queued messages
        for (const msg of this._queue) {
          this._ws.send(JSON.stringify(msg));
        }
        this._queue = [];
        // Re-subscribe to all active topics
        for (const topic of this._subscriptions.keys()) {
          this._ws.send(JSON.stringify({ action: 'subscribe', topic }));
        }
      };

      this._ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        const callbacks = this._subscriptions.get(msg.topic);
        if (callbacks) {
          for (const cb of callbacks) {
            cb(msg);
          }
        }
      };

      this._ws.onclose = () => {
        this.connected = false;
        this._ws = null;
        if (!this._closed) {
          this._scheduleReconnect();
        }
      };

      this._ws.onerror = () => {
        // onclose will fire after onerror, which handles reconnection
      };
    }

    /**
     * Subscribe to a topic. Returns an unsubscribe function.
     * Safe to call before connect() — the subscribe message will be
     * sent once the connection is established.
     *
     * @param {string} topic
     * @param {Function} callback - receives the full parsed message object
     * @returns {Function} unsubscribe
     */
    subscribe(topic, callback) {
      let callbacks = this._subscriptions.get(topic);
      if (!callbacks) {
        callbacks = new Set();
        this._subscriptions.set(topic, callbacks);
      }
      callbacks.add(callback);

      // Send subscribe message (or queue it)
      const msg = { action: 'subscribe', topic };
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify(msg));
      } else {
        this._queue.push(msg);
      }

      // Return unsubscribe function
      return () => {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this._subscriptions.delete(topic);
          const unsub = { action: 'unsubscribe', topic };
          if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(unsub));
          }
          // Also remove any queued subscribe for this topic
          this._queue = this._queue.filter(
            (m) => !(m.action === 'subscribe' && m.topic === topic)
          );
        }
      };
    }

    /**
     * Close the WebSocket and stop reconnection.
     */
    close() {
      this._closed = true;
      if (this._reconnectTimer !== null) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (this._ws) {
        this._ws.close();
        this._ws = null;
      }
      this.connected = false;
    }

    /** @private */
    _scheduleReconnect() {
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this.connect();
      }, this._backoff);
      this._backoff = Math.min(this._backoff * 2, this._backoffMax);
    }
  }

  // Export as singleton on window
  if (typeof window !== 'undefined') {
    window.WSClient = WSClient;
    window.wsClient = new WSClient();
  }
})();
