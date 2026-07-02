// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared loopback HTTP server helper for supertest-based tests.
 *
 * Why not `request(app)`: supertest's `serverAddress()` calls `app.listen(0)`,
 * which binds the WILDCARD address, then dials the client at 127.0.0.1. The
 * kernel (observed on macOS) can assign that wildcard listener an ephemeral
 * port that a foreign process already holds with a 127.0.0.1-specific bind —
 * the more-specific listener then receives the test's requests, producing
 * wrong statuses, `Parse Error: Expected HTTP/...`, or socket hang-ups.
 * Binding explicitly to 127.0.0.1 and handing supertest a LISTENING server
 * eliminates the collision (specific-vs-specific binds conflict loudly with
 * EADDRINUSE instead of silently shadowing) and reuses one listener per test
 * instead of one per request.
 */

const http = require('http');

/**
 * Create an http.Server for the given Express app, listening on 127.0.0.1.
 * Pass the returned server to supertest: `request(server)`.
 * @param {import('express').Express} app
 * @returns {Promise<http.Server>}
 */
async function listenOnLoopback(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}

/**
 * Close a server created by listenOnLoopback. Safe to call with null or an
 * already-closed server.
 * @param {http.Server|null|undefined} server
 * @returns {Promise<void>}
 */
async function closeServer(server) {
  if (server && server.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { listenOnLoopback, closeServer };
