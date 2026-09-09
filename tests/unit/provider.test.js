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

describe('resolveCliModelConfig', () => {
  const { resolveCliModelConfig } = providerModule;

  it('prefers the config override cli_model', () => {
    expect(resolveCliModelConfig({ cli_model: 'built-in' }, { cli_model: 'from-config' }, 'the-id'))
      .toBe('from-config');
  });

  it('falls back to the built-in cli_model', () => {
    expect(resolveCliModelConfig({ cli_model: 'built-in' }, { name: 'Renamed' }, 'the-id'))
      .toBe('built-in');
  });

  it('falls back to the model id when neither defines cli_model', () => {
    expect(resolveCliModelConfig({}, {}, 'the-id')).toBe('the-id');
    expect(resolveCliModelConfig(undefined, undefined, 'the-id')).toBe('the-id');
    expect(resolveCliModelConfig(null, null, 'the-id')).toBe('the-id');
  });

  it('preserves an explicit null (suppress the model flag) at either rung', () => {
    expect(resolveCliModelConfig({ cli_model: 'built-in' }, { cli_model: null }, 'the-id')).toBeNull();
    expect(resolveCliModelConfig({ cli_model: null }, undefined, 'the-id')).toBeNull();
  });

  it('preserves an empty string so the CLI surfaces its own error', () => {
    expect(resolveCliModelConfig({ cli_model: 'built-in' }, { cli_model: '' }, 'the-id')).toBe('');
  });

  it('does not let a falsy-but-defined built-in value fall through to the id', () => {
    // Regression guard: a truthiness-based ladder would return 'the-id' here.
    expect(resolveCliModelConfig({ cli_model: '' }, undefined, 'the-id')).toBe('');
  });
});
