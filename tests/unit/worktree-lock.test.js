// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest';

const { WorktreeLockManager } = require('../../src/git/worktree-lock');

describe('WorktreeLockManager', () => {
  let lockManager;

  beforeEach(() => {
    lockManager = new WorktreeLockManager();
  });

  describe('acquire/release lifecycle', () => {
    it('should acquire a lock and report it as locked', () => {
      const result = lockManager.acquire('/tmp/worktree/pr-1', 'analysis-1');
      expect(result).toBe(true);

      const status = lockManager.isLocked('/tmp/worktree/pr-1');
      expect(status).toEqual({ locked: true, holderId: 'analysis-1' });
    });

    it('should release a lock and report it as unlocked', () => {
      lockManager.acquire('/tmp/worktree/pr-1', 'analysis-1');

      const released = lockManager.release('/tmp/worktree/pr-1', 'analysis-1');
      expect(released).toBe(true);

      const status = lockManager.isLocked('/tmp/worktree/pr-1');
      expect(status).toEqual({ locked: false });
    });
  });

  describe('reject double-acquire by different holder', () => {
    it('should deny acquisition by a second holder', () => {
      lockManager.acquire('/tmp/worktree/pr-1', 'holder-A');

      const result = lockManager.acquire('/tmp/worktree/pr-1', 'holder-B');
      expect(result).toBe(false);

      const status = lockManager.isLocked('/tmp/worktree/pr-1');
      expect(status).toEqual({ locked: true, holderId: 'holder-A' });
    });
  });

  describe('allow re-acquire by same holder', () => {
    it('should allow the same holder to re-acquire', () => {
      const first = lockManager.acquire('/tmp/worktree/pr-1', 'holder-A');
      expect(first).toBe(true);

      const second = lockManager.acquire('/tmp/worktree/pr-1', 'holder-A');
      expect(second).toBe(true);

      const status = lockManager.isLocked('/tmp/worktree/pr-1');
      expect(status).toEqual({ locked: true, holderId: 'holder-A' });
    });
  });

  describe('release by wrong holder', () => {
    it('should deny release by a different holder', () => {
      lockManager.acquire('/tmp/worktree/pr-1', 'holder-A');

      const released = lockManager.release('/tmp/worktree/pr-1', 'holder-B');
      expect(released).toBe(false);

      const status = lockManager.isLocked('/tmp/worktree/pr-1');
      expect(status).toEqual({ locked: true, holderId: 'holder-A' });
    });
  });

  describe('release when not locked', () => {
    it('should return false when releasing an unlocked path', () => {
      const result = lockManager.release('/tmp/worktree/pr-1', 'holder-A');
      expect(result).toBe(false);
    });
  });

  describe('isLocked when not locked', () => {
    it('should return locked: false for an unknown path', () => {
      const status = lockManager.isLocked('/tmp/worktree/pr-1');
      expect(status).toEqual({ locked: false });
    });
  });

  describe('multiple worktrees', () => {
    it('should manage locks on different paths independently', () => {
      lockManager.acquire('/tmp/worktree/pr-1', 'holder-A');
      lockManager.acquire('/tmp/worktree/pr-2', 'holder-B');

      expect(lockManager.isLocked('/tmp/worktree/pr-1')).toEqual({ locked: true, holderId: 'holder-A' });
      expect(lockManager.isLocked('/tmp/worktree/pr-2')).toEqual({ locked: true, holderId: 'holder-B' });

      lockManager.release('/tmp/worktree/pr-1', 'holder-A');

      expect(lockManager.isLocked('/tmp/worktree/pr-1')).toEqual({ locked: false });
      expect(lockManager.isLocked('/tmp/worktree/pr-2')).toEqual({ locked: true, holderId: 'holder-B' });
    });
  });
});
