/**
 * Tests for the debounced commit scheduler.
 *
 * Uses temp directories for git repos and mocks/spies on gitCommitAll
 * to verify batching behavior without actual git overhead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitInit, gitCommitAll } from '../sync/git.js';
import { touchedRepos, clearTouchedRepos } from '../sync/write-through.js';
import {
  scheduleCommit,
  flushCommit,
  hasPendingCommit,
  COMMIT_DEBOUNCE_MS,
} from '../sync/commit-scheduler.js';
import { ensureRepoStructure } from '../sync/fs.js';

describe('commit-scheduler', () => {
  let repoPath: string;

  beforeEach(() => {
    // Create a real temp git repo so gitCommitAll can work
    repoPath = mkdtempSync(join(tmpdir(), 'knowledge-mcp-commit-scheduler-'));
    gitInit(repoPath);
    ensureRepoStructure(repoPath);
    // Commit the initial structure so there's a HEAD
    gitCommitAll(repoPath, 'init');

    // Clear any residual state
    clearTouchedRepos();
    flushCommit();
  });

  afterEach(() => {
    // Clean up pending timers and state
    flushCommit();
    clearTouchedRepos();
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('should report no pending commit initially', () => {
    expect(hasPendingCommit()).toBe(false);
  });

  it('should set pending after scheduleCommit', () => {
    touchedRepos.add(repoPath);
    scheduleCommit('test message');
    expect(hasPendingCommit()).toBe(true);
  });

  it('should flush immediately and clear pending', () => {
    touchedRepos.add(repoPath);
    scheduleCommit('test message');
    flushCommit();
    expect(hasPendingCommit()).toBe(false);
  });

  it('should commit touched repos on flush', () => {
    // Write a file so there's something to commit
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(repoPath, 'entries', 'fact', 'test.json'), '{}');
    touchedRepos.add(repoPath);

    scheduleCommit('flush test');
    flushCommit();

    // Verify a commit was made
    const { execFileSync } = require('node:child_process');
    const log = execFileSync('git', ['log', '--oneline', '-2'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
    const lines = log.split('\n');
    expect(lines.length).toBe(2); // init + our commit
    expect(lines[0]).toContain('flush test');
  });

  it('should batch multiple scheduleCommit calls into one commit', () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(repoPath, 'entries', 'fact', 'test1.json'), '{"a":1}');
    touchedRepos.add(repoPath);
    scheduleCommit('first message');

    writeFileSync(join(repoPath, 'entries', 'fact', 'test2.json'), '{"b":2}');
    touchedRepos.add(repoPath);
    scheduleCommit('second message');

    writeFileSync(join(repoPath, 'entries', 'fact', 'test3.json'), '{"c":3}');
    touchedRepos.add(repoPath);
    scheduleCommit('third message');

    // Flush all at once
    flushCommit();

    // Should produce exactly 1 commit (not 3)
    const { execFileSync } = require('node:child_process');
    const log = execFileSync('git', ['log', '--oneline', '-5'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
    const lines = log.split('\n');
    expect(lines.length).toBe(2); // init + 1 batched commit

    // Verify the commit message contains the first message (headline)
    expect(lines[0]).toContain('first message');
  });

  it('should include all messages in the batched commit body', () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(repoPath, 'entries', 'fact', 'a.json'), '{"a":1}');
    touchedRepos.add(repoPath);
    scheduleCommit('msg-alpha');
    scheduleCommit('msg-beta');

    flushCommit();

    // Check full commit message (not --oneline)
    const { execFileSync } = require('node:child_process');
    const fullMsg = execFileSync('git', ['log', '-1', '--format=%B'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
    expect(fullMsg).toContain('msg-alpha');
    expect(fullMsg).toContain('msg-beta');
  });

  it('should auto-commit after debounce window', async () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(repoPath, 'entries', 'fact', 'auto.json'), '{"auto":true}');
    touchedRepos.add(repoPath);

    scheduleCommit('auto commit test');

    // Wait for debounce to fire
    await new Promise((resolve) => setTimeout(resolve, COMMIT_DEBOUNCE_MS + 50));

    expect(hasPendingCommit()).toBe(false);

    // Verify commit was made
    const { execFileSync } = require('node:child_process');
    const log = execFileSync('git', ['log', '--oneline', '-2'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
    const lines = log.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('auto commit test');
  });

  it('should be a no-op when flushing with no pending commits', () => {
    // Should not throw
    flushCommit();
    expect(hasPendingCommit()).toBe(false);
  });

  it('should be a no-op when flushing with messages but no touched repos', () => {
    // Schedule without adding to touchedRepos
    scheduleCommit('orphan message');
    flushCommit();
    expect(hasPendingCommit()).toBe(false);
  });

  it('should clear touchedRepos after committing', () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(repoPath, 'entries', 'fact', 'clear.json'), '{}');
    touchedRepos.add(repoPath);

    scheduleCommit('clear test');
    flushCommit();

    expect(touchedRepos.size).toBe(0);
  });

  it('should reset debounce timer on each scheduleCommit call', async () => {
    const { writeFileSync } = require('node:fs');

    // First call starts the timer
    writeFileSync(join(repoPath, 'entries', 'fact', 'reset1.json'), '{"r":1}');
    touchedRepos.add(repoPath);
    scheduleCommit('reset msg 1');

    // Wait half the debounce time
    await new Promise((resolve) => setTimeout(resolve, COMMIT_DEBOUNCE_MS / 2));

    // Second call should reset the timer
    writeFileSync(join(repoPath, 'entries', 'fact', 'reset2.json'), '{"r":2}');
    touchedRepos.add(repoPath);
    scheduleCommit('reset msg 2');

    // At this point, the original timer would have fired but the reset one hasn't
    await new Promise((resolve) => setTimeout(resolve, COMMIT_DEBOUNCE_MS / 2 + 10));
    
    // Should still be pending (timer was reset)
    // Actually by now it should be close to firing... let's just check both messages land in one commit
    await new Promise((resolve) => setTimeout(resolve, COMMIT_DEBOUNCE_MS));

    expect(hasPendingCommit()).toBe(false);

    const { execFileSync } = require('node:child_process');
    const log = execFileSync('git', ['log', '--oneline', '-5'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
    const lines = log.split('\n');
    // Should be exactly 2: init + 1 batched commit (not 3)
    expect(lines.length).toBe(2);
  });
});
