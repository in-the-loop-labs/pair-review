// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Loads the two council config tab classes with their `window.CouncilCrud`
 * dependency already installed.
 *
 * WHY THIS EXISTS. Every shared CRUD / dirty-state method on
 * VoiceCentricConfigTab and AdvancedConfigTab is a one-line delegation into
 * public/js/utils/council-crud.js, and each one resolves `window.CouncilCrud`
 * at CALL time rather than capturing it at load time. A test file that loads a
 * tab without ever loading council-crud.js therefore looks perfectly healthy
 * until the first delegating method runs, and then dies with
 * `Cannot read properties of undefined (reading 'saveCouncil')` — which reads
 * as a broken tab rather than as a missing require, and which the author of the
 * next such test file can only avoid by already knowing about the constraint.
 * Requiring the tabs from here makes the mistake unreachable: the dependency is
 * installed on the line above the one that loads them.
 *
 * WHY THE `globalThis.window` GUARD. Under the node environment there is no
 * `window` for council-crud.js to self-install onto, so one has to exist first.
 * With it in place the module DOES still self-install even in node: in Node a
 * property of `globalThis` is reachable as a bare identifier, so council-crud's
 * `typeof window !== 'undefined'` guard passes and it assigns `window.CouncilCrud`
 * on its own. The explicit assignment below is therefore not what makes the
 * dependency exist — it makes it EXPLICIT rather than a side effect of the
 * require, and pins the exact object the tabs will see. (The two are distinct
 * spread copies of the same api object, carrying identical function references,
 * so either would work.) Under jsdom the guard is a harmless no-op, since jsdom
 * already provides a `window`.
 *
 * The guard never REPLACES an existing `window`, so a test file that pre-stubs
 * something on it (config-tab-timeout.test.js stubs `window.TimeoutSelect`
 * before loading the components) keeps its stub.
 *
 * WHAT THIS DOES NOT COVER. The tabs also reference the bare identifier
 * `TimeoutSelect` — but only from inside methods that mount a timeout dropdown,
 * never at module load. Files that exercise those paths install it themselves,
 * either the real one (`require('.../TimeoutSelect.js'); global.TimeoutSelect =
 * window.TimeoutSelect;`) or a stub, and they must keep doing so: node-env
 * callers of this module want no real TimeoutSelect at all, and the timeout
 * suite deliberately wants a fake.
 *
 * Consume this with `require`, not `import` — vitest hoists ESM imports above
 * in-file statements, which would load the tabs before a test file's own
 * `global.document` / stub setup had run.
 */

globalThis.window = globalThis.window || {};

const CouncilCrud = require('../../public/js/utils/council-crud.js');
globalThis.window.CouncilCrud = CouncilCrud;

const { VoiceCentricConfigTab } = require('../../public/js/components/VoiceCentricConfigTab.js');
const { AdvancedConfigTab } = require('../../public/js/components/AdvancedConfigTab.js');

module.exports = { CouncilCrud, VoiceCentricConfigTab, AdvancedConfigTab };
