// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for shared.js cancellation-related functions
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  registerProcess,
  killProcesses,
  isAnalysisCancelled,
  activeProcesses,
  activeAnalyses
} from '../../src/routes/shared.js';

/**
 * Create a mock child process using EventEmitter
 * @param {Object} options - Options for the mock
 * @returns {EventEmitter} Mock child process
 */
function createMockChildProcess(options = {}) {
  const proc = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn((signal) => {
    if (options.throwOnKill) {
      throw new Error('Process already exited');
    }
    proc.killed = true;
    // Simulate async process exit
    if (options.autoExit !== false) {
      setImmediate(() => proc.emit('close', 0));
    }
    return true;
  });
  return proc;
}

describe('shared.js cancellation functions', () => {
  beforeEach(() => {
    // Clean up state between tests
    activeProcesses.clear();
    activeAnalyses.clear();
  });

  describe('registerProcess', () => {
    it('should register a process for a new analysisId', () => {
      const analysisId = 'test-analysis-1';
      const mockProc = createMockChildProcess({ autoExit: false });

      registerProcess(analysisId, mockProc);

      expect(activeProcesses.has(analysisId)).toBe(true);
      expect(activeProcesses.get(analysisId).has(mockProc)).toBe(true);
      expect(activeProcesses.get(analysisId).size).toBe(1);
    });

    it('should register multiple processes for the same analysisId', () => {
      const analysisId = 'test-analysis-2';
      const mockProc1 = createMockChildProcess({ autoExit: false });
      const mockProc2 = createMockChildProcess({ autoExit: false });
      const mockProc3 = createMockChildProcess({ autoExit: false });

      registerProcess(analysisId, mockProc1);
      registerProcess(analysisId, mockProc2);
      registerProcess(analysisId, mockProc3);

      expect(activeProcesses.get(analysisId).size).toBe(3);
      expect(activeProcesses.get(analysisId).has(mockProc1)).toBe(true);
      expect(activeProcesses.get(analysisId).has(mockProc2)).toBe(true);
      expect(activeProcesses.get(analysisId).has(mockProc3)).toBe(true);
    });

    it('should register processes for different analysisIds independently', () => {
      const analysisId1 = 'test-analysis-a';
      const analysisId2 = 'test-analysis-b';
      const mockProc1 = createMockChildProcess({ autoExit: false });
      const mockProc2 = createMockChildProcess({ autoExit: false });

      registerProcess(analysisId1, mockProc1);
      registerProcess(analysisId2, mockProc2);

      expect(activeProcesses.get(analysisId1).size).toBe(1);
      expect(activeProcesses.get(analysisId2).size).toBe(1);
      expect(activeProcesses.get(analysisId1).has(mockProc1)).toBe(true);
      expect(activeProcesses.get(analysisId2).has(mockProc2)).toBe(true);
    });
  });

  describe('registerProcess auto-cleanup on close', () => {
    it('should remove process from set when it emits close event', async () => {
      const analysisId = 'test-cleanup-1';
      const mockProc = createMockChildProcess({ autoExit: false });

      registerProcess(analysisId, mockProc);
      expect(activeProcesses.get(analysisId).has(mockProc)).toBe(true);

      // Simulate process closing
      mockProc.emit('close', 0);

      expect(activeProcesses.get(analysisId)).toBeUndefined();
    });

    it('should remove analysisId entry when last process closes', async () => {
      const analysisId = 'test-cleanup-2';
      const mockProc1 = createMockChildProcess({ autoExit: false });
      const mockProc2 = createMockChildProcess({ autoExit: false });

      registerProcess(analysisId, mockProc1);
      registerProcess(analysisId, mockProc2);

      expect(activeProcesses.get(analysisId).size).toBe(2);

      // Close first process
      mockProc1.emit('close', 0);
      expect(activeProcesses.get(analysisId).size).toBe(1);
      expect(activeProcesses.get(analysisId).has(mockProc2)).toBe(true);

      // Close second process
      mockProc2.emit('close', 0);
      expect(activeProcesses.has(analysisId)).toBe(false);
    });

    it('should handle close event for already removed process gracefully', () => {
      const analysisId = 'test-cleanup-3';
      const mockProc = createMockChildProcess({ autoExit: false });

      registerProcess(analysisId, mockProc);

      // Manually clear the map
      activeProcesses.clear();

      // Emitting close should not throw
      expect(() => mockProc.emit('close', 0)).not.toThrow();
    });
  });

  describe('killProcesses', () => {
    it('should return 0 when no processes exist for analysisId', () => {
      const result = killProcesses('non-existent-analysis');

      expect(result).toBe(0);
    });

    it('should return 0 when analysisId has empty process set', () => {
      const analysisId = 'empty-set-analysis';
      activeProcesses.set(analysisId, new Set());

      const result = killProcesses(analysisId);

      expect(result).toBe(0);
    });

    it('should kill all processes and return count', () => {
      const analysisId = 'test-kill-1';
      const mockProc1 = createMockChildProcess({ autoExit: false });
      const mockProc2 = createMockChildProcess({ autoExit: false });

      registerProcess(analysisId, mockProc1);
      registerProcess(analysisId, mockProc2);

      const result = killProcesses(analysisId);

      expect(result).toBe(2);
      expect(mockProc1.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockProc2.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should clear the activeProcesses entry after killing', () => {
      const analysisId = 'test-kill-2';
      const mockProc = createMockChildProcess({ autoExit: false });

      registerProcess(analysisId, mockProc);
      killProcesses(analysisId);

      expect(activeProcesses.has(analysisId)).toBe(false);
    });

    it('should handle processes that throw when killed (already exited)', () => {
      const analysisId = 'test-kill-3';
      const mockProc1 = createMockChildProcess({ throwOnKill: true, autoExit: false });
      const mockProc2 = createMockChildProcess({ autoExit: false });

      registerProcess(analysisId, mockProc1);
      registerProcess(analysisId, mockProc2);

      // Should not throw, and should still try to kill all processes
      const result = killProcesses(analysisId);

      // Count includes attempt on first (even though it threw)
      expect(result).toBe(1); // Only mockProc2 succeeded
      expect(mockProc1.kill).toHaveBeenCalled();
      expect(mockProc2.kill).toHaveBeenCalled();
      expect(activeProcesses.has(analysisId)).toBe(false);
    });
  });

  describe('isAnalysisCancelled', () => {
    it('should return false for non-existent analysis', () => {
      const result = isAnalysisCancelled('non-existent-id');

      expect(result).toBe(false);
    });

    it('should return true when analysis status is cancelled', () => {
      const analysisId = 'cancelled-analysis';
      activeAnalyses.set(analysisId, { status: 'cancelled' });

      const result = isAnalysisCancelled(analysisId);

      expect(result).toBe(true);
    });

    it('should return false when analysis status is running', () => {
      const analysisId = 'running-analysis';
      activeAnalyses.set(analysisId, { status: 'running' });

      const result = isAnalysisCancelled(analysisId);

      expect(result).toBe(false);
    });

    it('should return false when analysis status is completed', () => {
      const analysisId = 'completed-analysis';
      activeAnalyses.set(analysisId, { status: 'completed' });

      const result = isAnalysisCancelled(analysisId);

      expect(result).toBe(false);
    });

    it('should return false when analysis status is error', () => {
      const analysisId = 'error-analysis';
      activeAnalyses.set(analysisId, { status: 'error' });

      const result = isAnalysisCancelled(analysisId);

      expect(result).toBe(false);
    });

    it('should return false when analysis exists but has no status', () => {
      const analysisId = 'no-status-analysis';
      activeAnalyses.set(analysisId, {});

      const result = isAnalysisCancelled(analysisId);

      expect(result).toBe(false);
    });

    it('should return false when analysis exists with null status', () => {
      const analysisId = 'null-status-analysis';
      activeAnalyses.set(analysisId, { status: null });

      const result = isAnalysisCancelled(analysisId);

      expect(result).toBe(false);
    });
  });
});
