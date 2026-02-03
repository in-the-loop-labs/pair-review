// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for provider-availability.js
 *
 * Tests the cache management and state tracking functionality.
 * Note: Tests for checkProviderAvailability and checkAllProviders are limited
 * because they require mocking the provider module which is challenging with
 * CommonJS modules. The actual provider availability checking is covered by
 * integration tests.
 */

const {
  getCachedAvailability,
  getAllCachedAvailability,
  isCheckInProgress,
  clearCache,
  resetState
} = require('../../src/ai/provider-availability');

describe('provider-availability', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    resetState();
  });

  describe('getCachedAvailability', () => {
    it('should return null for uncached provider', () => {
      const result = getCachedAvailability('claude');
      expect(result).toBeNull();
    });

    it('should return null for non-existent provider', () => {
      const result = getCachedAvailability('nonexistent-provider');
      expect(result).toBeNull();
    });
  });

  describe('getAllCachedAvailability', () => {
    it('should return empty object when no providers checked', () => {
      const result = getAllCachedAvailability();
      expect(result).toEqual({});
    });

    it('should return an object not a Map', () => {
      const result = getAllCachedAvailability();
      expect(result).toBeInstanceOf(Object);
      expect(result).not.toBeInstanceOf(Map);
    });
  });

  describe('isCheckInProgress', () => {
    it('should return false initially', () => {
      expect(isCheckInProgress()).toBe(false);
    });

    it('should return a boolean', () => {
      expect(typeof isCheckInProgress()).toBe('boolean');
    });
  });

  describe('clearCache', () => {
    it('should be callable without error', () => {
      expect(() => clearCache()).not.toThrow();
    });

    it('should result in empty cache after call', () => {
      clearCache();
      expect(getAllCachedAvailability()).toEqual({});
    });

    it('should allow multiple calls without error', () => {
      clearCache();
      clearCache();
      clearCache();
      expect(getAllCachedAvailability()).toEqual({});
    });
  });

  describe('resetState', () => {
    it('should be callable without error', () => {
      expect(() => resetState()).not.toThrow();
    });

    it('should clear cache and reset checkInProgress flag', () => {
      resetState();
      expect(getAllCachedAvailability()).toEqual({});
      expect(isCheckInProgress()).toBe(false);
    });

    it('should allow multiple calls without error', () => {
      resetState();
      resetState();
      resetState();
      expect(getAllCachedAvailability()).toEqual({});
      expect(isCheckInProgress()).toBe(false);
    });
  });

  describe('module exports', () => {
    it('should export checkProviderAvailability function', () => {
      const { checkProviderAvailability } = require('../../src/ai/provider-availability');
      expect(typeof checkProviderAvailability).toBe('function');
    });

    it('should export checkAllProviders function', () => {
      const { checkAllProviders } = require('../../src/ai/provider-availability');
      expect(typeof checkAllProviders).toBe('function');
    });

    it('should export getCachedAvailability function', () => {
      expect(typeof getCachedAvailability).toBe('function');
    });

    it('should export getAllCachedAvailability function', () => {
      expect(typeof getAllCachedAvailability).toBe('function');
    });

    it('should export isCheckInProgress function', () => {
      expect(typeof isCheckInProgress).toBe('function');
    });

    it('should export clearCache function', () => {
      expect(typeof clearCache).toBe('function');
    });

    it('should export resetState function', () => {
      expect(typeof resetState).toBe('function');
    });
  });
});
