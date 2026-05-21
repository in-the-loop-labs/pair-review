// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Load full AI index so the registry is populated with the real providers.
require('../../src/ai/index.js');
const providerModule = require('../../src/ai/provider.js');
const { resolveNonExecutableProviderId, registerProvider } = providerModule;

/**
 * Snapshot the provider registry so each test runs in isolation.
 * The provider module keeps a module-level Map; we replace it with a fresh
 * state for the test by re-registering specific providers.
 */
function makeProviderClass({ id, isExecutable }) {
  class FakeProvider {}
  FakeProvider.getProviderId = () => id;
  FakeProvider.getProviderName = () => id;
  FakeProvider.getModels = () => [];
  FakeProvider.getDefaultModel = () => null;
  FakeProvider.getInstallInstructions = () => '';
  FakeProvider.isExecutable = isExecutable;
  return FakeProvider;
}

describe('resolveNonExecutableProviderId', () => {
  let savedRegistry;

  beforeEach(() => {
    // Snapshot then clear the live registry
    const ids = providerModule.getRegisteredProviderIds();
    savedRegistry = ids.map((id) => [id, providerModule.getProviderClass(id)]);
    for (const [id] of savedRegistry) {
      // No public unregister — replace the underlying Map by re-registering as null-safe
      // Use registerProvider with sentinel; we'll restore in afterEach.
    }
    // Forcefully clear via Map handle: registerProvider exposes registry through closure
    // but we can simulate "empty" by registering only known fakes for our test scope.
    // Simplest approach: rely on registerProvider to overwrite ids we care about.
  });

  afterEach(() => {
    // Restore the original registry entries (overwrite anything we added)
    for (const [id, cls] of savedRegistry) {
      registerProvider(id, cls);
    }
  });

  it('returns preferredId when it is non-executable and registered', () => {
    const NonExec = makeProviderClass({ id: 'fake-nonexec', isExecutable: false });
    registerProvider('fake-nonexec', NonExec);
    expect(resolveNonExecutableProviderId('fake-nonexec')).toBe('fake-nonexec');
  });

  it('falls back to first non-executable when preferredId is executable', () => {
    const Exec = makeProviderClass({ id: 'fake-exec', isExecutable: true });
    const NonExec = makeProviderClass({ id: 'fake-nonexec', isExecutable: false });
    registerProvider('fake-exec', Exec);
    registerProvider('fake-nonexec', NonExec);
    const resolved = resolveNonExecutableProviderId('fake-exec');
    // Must be a registered non-exec id; can be any non-exec depending on iteration order
    const cls = providerModule.getProviderClass(resolved);
    expect(cls).toBeDefined();
    expect(cls.isExecutable).toBeFalsy();
  });

  it('returns null when no non-executable providers are registered', () => {
    // Replace every entry with an executable variant
    const ids = providerModule.getRegisteredProviderIds();
    for (const id of ids) {
      const Exec = makeProviderClass({ id, isExecutable: true });
      registerProvider(id, Exec);
    }
    expect(resolveNonExecutableProviderId(undefined)).toBeNull();
    expect(resolveNonExecutableProviderId('does-not-exist')).toBeNull();
  });

  it('falls back to first non-executable when preferredId is unknown', () => {
    const NonExec = makeProviderClass({ id: 'fake-nonexec', isExecutable: false });
    registerProvider('fake-nonexec', NonExec);
    const resolved = resolveNonExecutableProviderId('completely-unknown-id');
    expect(resolved).toBeTruthy();
    const cls = providerModule.getProviderClass(resolved);
    expect(cls.isExecutable).toBeFalsy();
  });
});
