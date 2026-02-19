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
  activeAnalyses,
  createProgressCallback,
  broadcastProgress,
  progressClients,
  parseEnabledLevels
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

describe('createProgressCallback', () => {
  let analysisId;
  let baseStatus;

  beforeEach(() => {
    // Clean up state between tests
    activeAnalyses.clear();
    progressClients.clear();
    vi.clearAllTimers();
    vi.useFakeTimers();

    analysisId = 'test-analysis-callback';
    baseStatus = {
      status: 'running',
      progress: 'Starting analysis...',
      levels: {
        1: { status: 'pending', progress: 'Waiting...', streamEvent: undefined },
        2: { status: 'pending', progress: 'Waiting...', streamEvent: undefined },
        3: { status: 'pending', progress: 'Waiting...', streamEvent: undefined },
        4: { status: 'pending', progress: 'Waiting...', streamEvent: undefined }
      }
    };
    activeAnalyses.set(analysisId, baseStatus);
  });

  it('should return a function', () => {
    const callback = createProgressCallback(analysisId);

    expect(typeof callback).toBe('function');
  });

  it('should do nothing when analysisId not in activeAnalyses', () => {
    const nonExistentId = 'non-existent-analysis';
    const callback = createProgressCallback(nonExistentId);

    // Should not throw
    expect(() => callback({ level: 1, status: 'running' })).not.toThrow();

    // Should not have created an entry
    expect(activeAnalyses.has(nonExistentId)).toBe(false);
  });

  describe('Non-voice regular updates (single-model mode)', () => {
    it('should update level status with status and progress', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 1,
        status: 'completed',
        progress: 'Level 1 complete'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].status).toBe('completed');
      expect(status.levels[1].progress).toBe('Level 1 complete');
    });

    it('should default status to "running" and progress to "In progress..."', () => {
      const callback = createProgressCallback(analysisId);

      callback({ level: 2 });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[2].status).toBe('running');
      expect(status.levels[2].progress).toBe('In progress...');
    });

    it('should clear any existing streamEvent', () => {
      // Set up a status with a stream event
      baseStatus.levels[1].streamEvent = { type: 'assistant_text', text: 'old text' };
      activeAnalyses.set(analysisId, baseStatus);

      const callback = createProgressCallback(analysisId);

      callback({ level: 1, status: 'running' });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].streamEvent).toBeUndefined();
    });

    it('should clear voiceId on non-voice update', () => {
      // Set up a status with voiceId from previous council run
      baseStatus.levels[1].voiceId = 'old-voice';
      activeAnalyses.set(analysisId, baseStatus);

      const callback = createProgressCallback(analysisId);

      callback({ level: 1, status: 'completed' });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].voiceId).toBeUndefined();
    });
  });

  describe('Per-voice updates (council mode)', () => {
    it('should create voices map on first per-voice update', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 1,
        voiceId: 'voice-alpha',
        status: 'running',
        progress: 'Analyzing...'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].voices).toBeDefined();
      expect(typeof status.levels[1].voices).toBe('object');
    });

    it('should track multiple voices in the voices map on the same level', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 2,
        voiceId: 'voice-alpha',
        status: 'running',
        progress: 'Alpha analyzing...'
      });

      callback({
        level: 2,
        voiceId: 'voice-beta',
        status: 'running',
        progress: 'Beta analyzing...'
      });

      callback({
        level: 2,
        voiceId: 'voice-gamma',
        status: 'completed',
        progress: 'Gamma complete'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[2].voices['voice-alpha']).toEqual({
        status: 'running',
        progress: 'Alpha analyzing...'
      });
      expect(status.levels[2].voices['voice-beta']).toEqual({
        status: 'running',
        progress: 'Beta analyzing...'
      });
      expect(status.levels[2].voices['voice-gamma']).toEqual({
        status: 'completed',
        progress: 'Gamma complete'
      });
    });

    it('should set backward-compatible voiceId, status, progress on the level', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 1,
        voiceId: 'voice-delta',
        status: 'completed',
        progress: 'Delta done'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].voiceId).toBe('voice-delta');
      expect(status.levels[1].status).toBe('completed');
      expect(status.levels[1].progress).toBe('Delta done');
    });

    it('should clear streamEvent on per-voice update', () => {
      baseStatus.levels[3].streamEvent = { type: 'tool_use', name: 'some_tool' };
      activeAnalyses.set(analysisId, baseStatus);

      const callback = createProgressCallback(analysisId);

      callback({
        level: 3,
        voiceId: 'voice-epsilon',
        status: 'running'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[3].streamEvent).toBeUndefined();
    });

    it('should preserve other voices when updating one voice', () => {
      const callback = createProgressCallback(analysisId);

      // First voice completes
      callback({
        level: 1,
        voiceId: 'voice-one',
        status: 'completed',
        progress: 'Voice one done'
      });

      // Second voice starts
      callback({
        level: 1,
        voiceId: 'voice-two',
        status: 'running',
        progress: 'Voice two in progress'
      });

      // Third voice completes
      callback({
        level: 1,
        voiceId: 'voice-three',
        status: 'completed',
        progress: 'Voice three done'
      });

      const status = activeAnalyses.get(analysisId);

      // All three voices should be tracked
      expect(status.levels[1].voices['voice-one']).toEqual({
        status: 'completed',
        progress: 'Voice one done'
      });
      expect(status.levels[1].voices['voice-two']).toEqual({
        status: 'running',
        progress: 'Voice two in progress'
      });
      expect(status.levels[1].voices['voice-three']).toEqual({
        status: 'completed',
        progress: 'Voice three done'
      });
    });
  });

  describe('Orchestration level updates', () => {
    it('should map level="orchestration" to levels[4]', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'orchestration',
        status: 'running',
        progress: 'Finalizing results...'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].status).toBe('running');
      expect(status.levels[4].progress).toBe('Finalizing results...');
    });

    it('should default orchestration progress to "Finalizing results..."', () => {
      const callback = createProgressCallback(analysisId);

      callback({ level: 'orchestration' });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].progress).toBe('Finalizing results...');
    });

    it('should preserve existing streamEvent on orchestration status update', () => {
      baseStatus.levels[4].streamEvent = { type: 'assistant_text', text: 'still streaming' };
      activeAnalyses.set(analysisId, baseStatus);

      const callback = createProgressCallback(analysisId);

      callback({ level: 'orchestration', status: 'running' });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].streamEvent).toEqual({ type: 'assistant_text', text: 'still streaming' });
    });
  });

  describe('Consolidation level updates (consolidation-L*)', () => {
    it('should map level="consolidation-L1" to levels[4]', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L1',
        status: 'running',
        progress: 'Consolidating Level 1...'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].status).toBe('running');
      expect(status.levels[4].progress).toBe('Consolidating Level 1...');
      expect(status.levels[4].consolidationStep).toBe('L1');
    });

    it('should map level="consolidation-L2" to levels[4] with step L2', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L2',
        status: 'running',
        progress: 'Consolidating Level 2...'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].status).toBe('running');
      expect(status.levels[4].consolidationStep).toBe('L2');
    });

    it('should map level="consolidation-L3" to levels[4] with step L3', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L3',
        status: 'running'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].status).toBe('running');
      expect(status.levels[4].consolidationStep).toBe('L3');
    });

    it('should default consolidation progress to "Consolidating..."', () => {
      const callback = createProgressCallback(analysisId);

      callback({ level: 'consolidation-L1' });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].progress).toBe('Consolidating...');
    });

    it('should track per-step status in steps map', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L1',
        status: 'running',
        progress: 'Consolidating L1...'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].steps).toBeDefined();
      expect(status.levels[4].steps.L1).toEqual({
        status: 'running',
        progress: 'Consolidating L1...'
      });
    });

    it('should preserve steps from different consolidation levels', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L1',
        status: 'completed',
        progress: 'L1 done'
      });

      callback({
        level: 'consolidation-L2',
        status: 'running',
        progress: 'L2 in progress'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].steps.L1).toEqual({
        status: 'completed',
        progress: 'L1 done'
      });
      expect(status.levels[4].steps.L2).toEqual({
        status: 'running',
        progress: 'L2 in progress'
      });
    });

    it('should derive levels[4].status as running when one step completed and another running', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L1',
        status: 'completed',
        progress: 'L1 done'
      });

      callback({
        level: 'consolidation-L2',
        status: 'running',
        progress: 'L2 in progress'
      });

      const status = activeAnalyses.get(analysisId);
      // Parent status should be 'running' because L2 is still running,
      // even though L1 already completed
      expect(status.levels[4].status).toBe('running');
    });

    it('should derive levels[4].status as completed only when all steps completed', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L1',
        status: 'completed',
        progress: 'L1 done'
      });

      callback({
        level: 'consolidation-L2',
        status: 'completed',
        progress: 'L2 done'
      });

      callback({
        level: 'orchestration',
        status: 'completed',
        progress: 'All done'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].status).toBe('completed');
    });

    it('should derive levels[4].status as failed when any step failed', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L1',
        status: 'completed',
        progress: 'L1 done'
      });

      callback({
        level: 'consolidation-L2',
        status: 'failed',
        progress: 'L2 failed'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].status).toBe('failed');
    });

    it('should derive levels[4].status as failed even when mixed with running', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L1',
        status: 'running',
        progress: 'L1 in progress'
      });

      callback({
        level: 'consolidation-L2',
        status: 'failed',
        progress: 'L2 failed'
      });

      const status = activeAnalyses.get(analysisId);
      // Failed takes precedence over running
      expect(status.levels[4].status).toBe('failed');
    });

    it('should derive levels[4].status as running for single running step', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L1',
        status: 'running',
        progress: 'L1 in progress'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].status).toBe('running');
    });

    it('should derive levels[4].status as completed for single completed step', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'orchestration',
        status: 'completed',
        progress: 'All done'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].status).toBe('completed');
    });

    it('should preserve consolidation steps when orchestration updates', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L1',
        status: 'completed',
        progress: 'L1 done'
      });

      callback({
        level: 'orchestration',
        status: 'running',
        progress: 'Orchestrating...'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].steps.L1).toEqual({
        status: 'completed',
        progress: 'L1 done'
      });
      expect(status.levels[4].steps.orchestration).toEqual({
        status: 'running',
        progress: 'Orchestrating...'
      });
      expect(status.levels[4].consolidationStep).toBe('orchestration');
    });

    it('should store stream events for consolidation-L* under levels[4]', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L1',
        streamEvent: { type: 'assistant_text', text: 'Consolidating...' }
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].streamEvent).toEqual({
        type: 'assistant_text',
        text: 'Consolidating...'
      });
      expect(status.levels[4].consolidationStep).toBe('L1');
    });

    it('should broadcast stream events for consolidation-L* levels', () => {
      const mockClient = { write: vi.fn() };
      progressClients.set(analysisId, new Set([mockClient]));

      const callback = createProgressCallback(analysisId);

      callback({
        level: 'consolidation-L1',
        streamEvent: { type: 'assistant_text', text: 'Working...' }
      });

      expect(mockClient.write).toHaveBeenCalledTimes(1);
      const written = mockClient.write.mock.calls[0][0];
      expect(written).toContain('"type":"progress"');
    });

    it('should set orchestration consolidationStep on stream events', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'orchestration',
        streamEvent: { type: 'assistant_text', text: 'Orchestrating...' }
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].consolidationStep).toBe('orchestration');
    });

    it('should track per-voice orchestration state in levels[4].voices', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'orchestration',
        status: 'running',
        progress: 'Consolidating voice results...',
        voiceId: 'claude-opus'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].voices).toBeDefined();
      expect(status.levels[4].voices['claude-opus']).toEqual({
        status: 'running',
        progress: 'Consolidating voice results...'
      });
      expect(status.levels[4].voiceId).toBe('claude-opus');
    });

    it('should track multiple per-voice orchestration states independently', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'orchestration',
        status: 'running',
        progress: 'Running...',
        voiceId: 'claude-opus'
      });

      callback({
        level: 'orchestration',
        status: 'running',
        progress: 'Running...',
        voiceId: 'gemini-pro-1'
      });

      callback({
        level: 'orchestration',
        status: 'completed',
        progress: 'Done',
        voiceId: 'claude-opus'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].voices['claude-opus']).toEqual({
        status: 'completed',
        progress: 'Done'
      });
      expect(status.levels[4].voices['gemini-pro-1']).toEqual({
        status: 'running',
        progress: 'Running...'
      });
    });

    it('should not create voices map on orchestration update without voiceId', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 'orchestration',
        status: 'running',
        progress: 'Cross-reviewer consolidation...'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].voices).toBeUndefined();
    });

    it('should preserve streamEvent when a different consolidation sub-step sends a status update', () => {
      const callback = createProgressCallback(analysisId);

      // Orchestration starts running (registers in steps map)
      callback({ level: 'orchestration', status: 'running' });

      // Orchestration streams text
      callback({
        level: 'orchestration',
        streamEvent: { type: 'assistant_text', text: 'Analyzing cross-level patterns...' }
      });

      // A different sub-step (L1 consolidation) completes — must not destroy the active stream
      callback({
        level: 'consolidation-L1',
        status: 'completed',
        progress: 'Done'
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[4].streamEvent).toEqual({
        type: 'assistant_text',
        text: 'Analyzing cross-level patterns...'
      });
      // Overall status should remain running since orchestration step is still running
      expect(status.levels[4].status).toBe('running');
    });
  });

  describe('Overall progress updates', () => {
    it('should update overall progress when level is not provided', () => {
      const callback = createProgressCallback(analysisId);

      callback({ progress: 'Overall progress message' });

      const status = activeAnalyses.get(analysisId);
      expect(status.progress).toBe('Overall progress message');
    });

    it('should not update overall progress when level is provided', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 1,
        progress: 'Level 1 progress'
      });

      const status = activeAnalyses.get(analysisId);
      // Overall progress should still be the original value
      expect(status.progress).toBe('Starting analysis...');
    });
  });

  describe('Stream event throttling', () => {
    it('should store stream event immediately', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'Hello' }
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].streamEvent).toEqual({
        type: 'assistant_text',
        text: 'Hello'
      });
    });

    it('should broadcast first stream event immediately', () => {
      const mockClient = { write: vi.fn() };
      progressClients.set(analysisId, new Set([mockClient]));

      const callback = createProgressCallback(analysisId);

      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'First message' }
      });

      expect(mockClient.write).toHaveBeenCalledTimes(1);
      const written = mockClient.write.mock.calls[0][0];
      expect(written).toContain('"type":"progress"');
    });

    it('should throttle stream events within 300ms window', () => {
      const mockClient = { write: vi.fn() };
      progressClients.set(analysisId, new Set([mockClient]));

      const callback = createProgressCallback(analysisId);

      // First event: should broadcast
      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'Message 1' }
      });

      expect(mockClient.write).toHaveBeenCalledTimes(1);

      // Advance time by 100ms (less than 300ms)
      vi.advanceTimersByTime(100);

      // Second event: should NOT broadcast (throttled)
      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'Message 2' }
      });

      expect(mockClient.write).toHaveBeenCalledTimes(1); // Still 1

      // Third event: should NOT broadcast (still within 300ms of first)
      vi.advanceTimersByTime(150); // Total 250ms
      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'Message 3' }
      });

      expect(mockClient.write).toHaveBeenCalledTimes(1); // Still 1

      // Fourth event: should broadcast (300ms elapsed since first)
      vi.advanceTimersByTime(100); // Total 350ms
      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'Message 4' }
      });

      expect(mockClient.write).toHaveBeenCalledTimes(2); // Now 2
    });

    it('should throttle stream events independently per level', () => {
      const mockClient = { write: vi.fn() };
      progressClients.set(analysisId, new Set([mockClient]));

      const callback = createProgressCallback(analysisId);

      // Level 1 event
      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'Level 1' }
      });

      expect(mockClient.write).toHaveBeenCalledTimes(1);

      // Level 2 event (should not be throttled, different level)
      callback({
        level: 2,
        streamEvent: { type: 'assistant_text', text: 'Level 2' }
      });

      expect(mockClient.write).toHaveBeenCalledTimes(2);

      // Level 3 event (should not be throttled, different level)
      callback({
        level: 3,
        streamEvent: { type: 'assistant_text', text: 'Level 3' }
      });

      expect(mockClient.write).toHaveBeenCalledTimes(3);
    });

    it('should ignore stream events when level does not exist in status', () => {
      // Create status with only level 1
      const minimalStatus = {
        status: 'running',
        levels: {
          1: { status: 'running', progress: 'Working...' }
        }
      };
      activeAnalyses.set(analysisId, minimalStatus);

      const callback = createProgressCallback(analysisId);

      // Try to send stream event for non-existent level 2
      callback({
        level: 2,
        streamEvent: { type: 'assistant_text', text: 'Should be ignored' }
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[2]).toBeUndefined();
    });
  });

  describe('Stream event assistant_text vs tool_use filtering', () => {
    it('should store assistant_text immediately', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'Thinking...' }
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].streamEvent.type).toBe('assistant_text');
    });

    it('should suppress tool_use within 2000ms of assistant_text', () => {
      const callback = createProgressCallback(analysisId);

      // First: assistant_text
      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'Thinking...' }
      });

      let status = activeAnalyses.get(analysisId);
      expect(status.levels[1].streamEvent.type).toBe('assistant_text');

      // Advance 500ms
      vi.advanceTimersByTime(500);

      // Try tool_use (should be suppressed)
      callback({
        level: 1,
        streamEvent: { type: 'tool_use', name: 'some_tool' }
      });

      status = activeAnalyses.get(analysisId);
      // Should still be assistant_text
      expect(status.levels[1].streamEvent.type).toBe('assistant_text');

      // Advance another 1000ms (total 1500ms)
      vi.advanceTimersByTime(1000);

      // Try tool_use again (still suppressed)
      callback({
        level: 1,
        streamEvent: { type: 'tool_use', name: 'another_tool' }
      });

      status = activeAnalyses.get(analysisId);
      expect(status.levels[1].streamEvent.type).toBe('assistant_text');
    });

    it('should allow tool_use after 2000ms gap from assistant_text', () => {
      const callback = createProgressCallback(analysisId);

      // First: assistant_text
      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'Thinking...' }
      });

      // Advance 2100ms (more than 2000ms)
      vi.advanceTimersByTime(2100);

      // Now tool_use should be allowed
      callback({
        level: 1,
        streamEvent: { type: 'tool_use', name: 'allowed_tool' }
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].streamEvent.type).toBe('tool_use');
      expect(status.levels[1].streamEvent.name).toBe('allowed_tool');
    });

    it('should allow tool_use if no prior assistant_text', () => {
      const callback = createProgressCallback(analysisId);

      // Send tool_use without any prior assistant_text
      callback({
        level: 1,
        streamEvent: { type: 'tool_use', name: 'first_tool' }
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].streamEvent.type).toBe('tool_use');
      expect(status.levels[1].streamEvent.name).toBe('first_tool');
    });

    it('should track assistant_text timing independently per level', () => {
      const callback = createProgressCallback(analysisId);

      // Level 1: assistant_text
      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'Level 1' }
      });

      // Level 2: tool_use (should be allowed, no prior assistant_text on this level)
      callback({
        level: 2,
        streamEvent: { type: 'tool_use', name: 'level2_tool' }
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].streamEvent.type).toBe('assistant_text');
      expect(status.levels[2].streamEvent.type).toBe('tool_use');
    });

    it('should reset assistant_text timestamp when new assistant_text arrives', () => {
      const callback = createProgressCallback(analysisId);

      // First assistant_text
      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'First' }
      });

      // Advance 1500ms
      vi.advanceTimersByTime(1500);

      // Second assistant_text (resets the timer)
      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'Second' }
      });

      // Advance 500ms (total 2000ms from first, but only 500ms from second)
      vi.advanceTimersByTime(500);

      // Tool_use should still be suppressed (less than 2000ms from second assistant_text)
      callback({
        level: 1,
        streamEvent: { type: 'tool_use', name: 'suppressed_tool' }
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].streamEvent.type).toBe('assistant_text');
      expect(status.levels[1].streamEvent.text).toBe('Second');
    });
  });

  describe('Stream event voiceId propagation', () => {
    it('should propagate voiceId from stream event to level', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 1,
        voiceId: 'voice-stream',
        streamEvent: { type: 'assistant_text', text: 'Speaking...' }
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].voiceId).toBe('voice-stream');
      expect(status.levels[1].streamEvent.type).toBe('assistant_text');
    });

    it('should not set voiceId if not provided in stream event', () => {
      const callback = createProgressCallback(analysisId);

      callback({
        level: 1,
        streamEvent: { type: 'assistant_text', text: 'No voice' }
      });

      const status = activeAnalyses.get(analysisId);
      expect(status.levels[1].voiceId).toBeUndefined();
    });
  });

  describe('Broadcasts to SSE clients', () => {
    it('should broadcast to connected clients', () => {
      const mockClient = { write: vi.fn() };
      progressClients.set(analysisId, new Set([mockClient]));

      const callback = createProgressCallback(analysisId);

      callback({ level: 1, status: 'running', progress: 'Testing broadcast' });

      expect(mockClient.write).toHaveBeenCalledTimes(1);
      const message = mockClient.write.mock.calls[0][0];
      expect(message).toContain('data: ');
      expect(message).toContain('"type":"progress"');
      expect(message).toContain('"status":"running"');
    });

    it('should broadcast to multiple clients', () => {
      const mockClient1 = { write: vi.fn() };
      const mockClient2 = { write: vi.fn() };
      const mockClient3 = { write: vi.fn() };
      progressClients.set(analysisId, new Set([mockClient1, mockClient2, mockClient3]));

      const callback = createProgressCallback(analysisId);

      callback({ level: 2, status: 'completed' });

      expect(mockClient1.write).toHaveBeenCalledTimes(1);
      expect(mockClient2.write).toHaveBeenCalledTimes(1);
      expect(mockClient3.write).toHaveBeenCalledTimes(1);
    });

    it('should not throw if no clients connected', () => {
      const callback = createProgressCallback(analysisId);

      expect(() => {
        callback({ level: 1, status: 'running' });
      }).not.toThrow();
    });

    it('should broadcast regular updates but not throttled stream events', () => {
      const mockClient = { write: vi.fn() };
      progressClients.set(analysisId, new Set([mockClient]));

      const callback = createProgressCallback(analysisId);

      // Regular update: should broadcast
      callback({ level: 1, status: 'running', progress: 'Regular update' });
      expect(mockClient.write).toHaveBeenCalledTimes(1);

      // Stream event: should broadcast first time
      callback({ level: 1, streamEvent: { type: 'assistant_text', text: 'Stream 1' } });
      expect(mockClient.write).toHaveBeenCalledTimes(2);

      // Another stream event within 300ms: should NOT broadcast
      vi.advanceTimersByTime(100);
      callback({ level: 1, streamEvent: { type: 'assistant_text', text: 'Stream 2' } });
      expect(mockClient.write).toHaveBeenCalledTimes(2); // Still 2

      // Regular update: should broadcast immediately even within throttle window
      callback({ level: 1, status: 'completed', progress: 'Done' });
      expect(mockClient.write).toHaveBeenCalledTimes(3);
    });
  });
});

describe('parseEnabledLevels', () => {
  describe('array format', () => {
    it('should convert array of enabled levels to config object', () => {
      const result = parseEnabledLevels([1, 3]);
      expect(result).toEqual({ 1: true, 2: false, 3: true });
    });

    it('should handle all levels enabled', () => {
      const result = parseEnabledLevels([1, 2, 3]);
      expect(result).toEqual({ 1: true, 2: true, 3: true });
    });

    it('should handle empty array (no levels enabled)', () => {
      const result = parseEnabledLevels([]);
      expect(result).toEqual({ 1: false, 2: false, 3: false });
    });

    it('should ignore unknown level numbers in array', () => {
      const result = parseEnabledLevels([1, 4, 5, 99]);
      expect(result).toEqual({ 1: true, 2: false, 3: false });
      // Keys 4, 5, 99 should NOT appear
      expect(result[4]).toBeUndefined();
      expect(result[5]).toBeUndefined();
      expect(result[99]).toBeUndefined();
    });
  });

  describe('object format', () => {
    it('should filter object to only known keys [1, 2, 3]', () => {
      const result = parseEnabledLevels({ 1: true, 2: false, 3: true });
      expect(result).toEqual({ 1: true, 2: false, 3: true });
    });

    it('should coerce truthy/falsy values to booleans', () => {
      const result = parseEnabledLevels({ 1: 1, 2: 0, 3: 'yes' });
      expect(result).toEqual({ 1: true, 2: false, 3: true });
    });

    it('should not copy unknown keys from the object', () => {
      const result = parseEnabledLevels({ 1: true, 2: true, 3: true, 4: true, __proto__: true, foo: 'bar' });
      expect(Object.keys(result).map(Number).sort()).toEqual([1, 2, 3]);
      expect(result[4]).toBeUndefined();
      expect(result.foo).toBeUndefined();
    });

    it('should handle missing keys as false', () => {
      const result = parseEnabledLevels({ 1: true });
      expect(result).toEqual({ 1: true, 2: false, 3: false });
    });
  });

  describe('null/undefined fallback', () => {
    it('should default to all levels enabled when no input provided', () => {
      const result = parseEnabledLevels(null);
      expect(result).toEqual({ 1: true, 2: true, 3: true });
    });

    it('should default to all levels enabled when undefined', () => {
      const result = parseEnabledLevels(undefined);
      expect(result).toEqual({ 1: true, 2: true, 3: true });
    });

    it('should respect skipLevel3 flag when no enabledLevels provided', () => {
      const result = parseEnabledLevels(null, true);
      expect(result).toEqual({ 1: true, 2: true, 3: false });
    });

    it('should ignore skipLevel3 when array format is provided', () => {
      const result = parseEnabledLevels([1, 2, 3], true);
      expect(result).toEqual({ 1: true, 2: true, 3: true });
    });

    it('should ignore skipLevel3 when object format is provided', () => {
      const result = parseEnabledLevels({ 1: true, 2: true, 3: true }, true);
      expect(result).toEqual({ 1: true, 2: true, 3: true });
    });
  });
});
