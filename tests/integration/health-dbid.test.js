// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * GET /health dbId handshake field (src/server.js).
 *
 * The delegated-headless CLI only hands work to a running server when the
 * server's /health `dbId` matches the digest the CLI computes locally via
 * computeDbId(resolveDbPath(config)). This exercises the payload factory the
 * route uses (buildHealthPayload) plus the exact startup wiring — dbId derived
 * from resolveDbPath(config) — over a listening loopback server, without booting
 * the full server (which binds a fixed port and reads real config).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { listenOnLoopback, closeServer } from '../utils/loopback-server';

const { buildHealthPayload } = require('../../src/server');
const { resolveDbPath, computeDbId } = require('../../src/utils/db-identity');
const pkgVersion = require('../../package.json').version;

// resolveDbName() honors PAIR_REVIEW_DB_NAME above config.db_name. If that var is
// exported in the ambient env (a dev shell, CI), it would collapse alpha.db and
// beta.db onto ONE resolved path and make the different-paths→different-digests
// assertion below fail spuriously. Neutralize it for this suite (save/restore).
let savedDbNameEnv;
beforeEach(() => {
  savedDbNameEnv = process.env.PAIR_REVIEW_DB_NAME;
  delete process.env.PAIR_REVIEW_DB_NAME;
});
afterEach(() => {
  if (savedDbNameEnv === undefined) delete process.env.PAIR_REVIEW_DB_NAME;
  else process.env.PAIR_REVIEW_DB_NAME = savedDbNameEnv;
});

/** Mirror the server.js startup wiring: compute dbId once, serve it on /health. */
function makeHealthApp(config) {
  const app = express();
  const dbId = computeDbId(resolveDbPath(config));
  app.get('/health', (req, res) => res.json(buildHealthPayload(dbId)));
  return app;
}

describe('buildHealthPayload', () => {
  it('assembles the handshake fields and passes dbId through unchanged', () => {
    const payload = buildHealthPayload('deadbeef');
    expect(payload.status).toBe('ok');
    expect(payload.service).toBe('pair-review');
    expect(payload.version).toBe(pkgVersion);
    expect(payload.dbId).toBe('deadbeef');
    expect(typeof payload.timestamp).toBe('string');
    // Timestamp must be a parseable ISO string.
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
  });
});

describe('GET /health', () => {
  let server;

  afterEach(async () => {
    await closeServer(server);
    server = null;
  });

  it('returns dbId equal to computeDbId(resolveDbPath(config)) alongside the existing fields', async () => {
    const config = { db_name: 'health-test.db' };
    server = await listenOnLoopback(makeHealthApp(config));

    const res = await request(server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'pair-review',
      version: pkgVersion
    });
    expect(res.body.timestamp).toBeTruthy();
    // The load-bearing field: byte-identical to the CLI-side computation.
    expect(res.body.dbId).toBe(computeDbId(resolveDbPath(config)));
    // A SHA-256 hex digest.
    expect(res.body.dbId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives a different dbId for a different resolved database path', async () => {
    const idA = computeDbId(resolveDbPath({ db_name: 'alpha.db' }));
    const idB = computeDbId(resolveDbPath({ db_name: 'beta.db' }));
    expect(idA).not.toBe(idB);

    server = await listenOnLoopback(makeHealthApp({ db_name: 'alpha.db' }));
    const res = await request(server).get('/health');
    expect(res.body.dbId).toBe(idA);
    expect(res.body.dbId).not.toBe(idB);
  });
});
