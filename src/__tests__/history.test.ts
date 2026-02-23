/**
 * Tests for entry version history via git.
 *
 * Tests the git helpers (gitFileLog, gitShowFile) and the higher-level
 * history resolution functions (getEntryHistory, getEntryAtCommit).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { gitInit, gitCommitAll, gitFileLog, gitShowFile } from '../sync/git.js';
import { getEntryHistory, getEntryAtCommit } from '../sync/history.js';
import { setSyncConfig } from '../sync/config.js';
import { ensureRepoStructure, entryFilePath } from '../sync/fs.js';
import { insertKnowledge } from '../db/queries.js';
import type { SyncConfig } from '../sync/routing.js';

describe('entry version history', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'knowledge-mcp-history-'));
    gitInit(repoPath);
    // Configure git user for commits
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, stdio: 'ignore' });
  });

  afterEach(() => {
    try {
      if (existsSync(repoPath)) rmSync(repoPath, { recursive: true, force: true });
    } catch (e) {
      console.error('Failed to clean up temp dir:', e);
    }
  });

  describe('gitFileLog', () => {
    it('should return commits for a file with history', () => {
      const filePath = join(repoPath, 'test.json');
      writeFileSync(filePath, '{"v": 1}\n');
      gitCommitAll(repoPath, 'first commit');

      writeFileSync(filePath, '{"v": 2}\n');
      gitCommitAll(repoPath, 'second commit');

      const log = gitFileLog(repoPath, filePath);

      expect(log).toHaveLength(2);
      expect(log[0].message).toBe('second commit');
      expect(log[1].message).toBe('first commit');
      // Hashes should be 40-char hex strings
      expect(log[0].hash).toMatch(/^[0-9a-f]{40}$/);
      expect(log[1].hash).toMatch(/^[0-9a-f]{40}$/);
      // Dates should be ISO 8601
      expect(log[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should return empty array for non-existent file', () => {
      // Create at least one commit so the repo isn't empty
      writeFileSync(join(repoPath, 'other.txt'), 'hello');
      gitCommitAll(repoPath, 'initial');

      const log = gitFileLog(repoPath, join(repoPath, 'nonexistent.json'));
      expect(log).toEqual([]);
    });

    it('should return empty array for non-git directory', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'knowledge-mcp-nogit-'));
      try {
        const log = gitFileLog(tmpDir, join(tmpDir, 'test.json'));
        expect(log).toEqual([]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should respect limit parameter', () => {
      const filePath = join(repoPath, 'test.json');
      for (let i = 1; i <= 5; i++) {
        writeFileSync(filePath, `{"v": ${i}}\n`);
        gitCommitAll(repoPath, `commit ${i}`);
      }

      const log = gitFileLog(repoPath, filePath, 3);
      expect(log).toHaveLength(3);
      expect(log[0].message).toBe('commit 5');
      expect(log[2].message).toBe('commit 3');
    });

    it('should only return commits that touched the specific file', () => {
      const fileA = join(repoPath, 'a.json');
      const fileB = join(repoPath, 'b.json');

      writeFileSync(fileA, '{"a": 1}\n');
      gitCommitAll(repoPath, 'add a');

      writeFileSync(fileB, '{"b": 1}\n');
      gitCommitAll(repoPath, 'add b');

      writeFileSync(fileA, '{"a": 2}\n');
      gitCommitAll(repoPath, 'update a');

      const logA = gitFileLog(repoPath, fileA);
      expect(logA).toHaveLength(2);
      expect(logA[0].message).toBe('update a');
      expect(logA[1].message).toBe('add a');

      const logB = gitFileLog(repoPath, fileB);
      expect(logB).toHaveLength(1);
      expect(logB[0].message).toBe('add b');
    });
  });

  describe('gitShowFile', () => {
    it('should return file content at a specific commit', () => {
      const filePath = join(repoPath, 'test.json');
      writeFileSync(filePath, '{"v": 1}\n');
      gitCommitAll(repoPath, 'first');

      writeFileSync(filePath, '{"v": 2}\n');
      gitCommitAll(repoPath, 'second');

      const log = gitFileLog(repoPath, filePath);
      expect(log).toHaveLength(2);

      // Get content at first commit (older, index 1)
      const v1 = gitShowFile(repoPath, log[1].hash, 'test.json');
      expect(v1).toBe('{"v": 1}\n');

      // Get content at second commit (newer, index 0)
      const v2 = gitShowFile(repoPath, log[0].hash, 'test.json');
      expect(v2).toBe('{"v": 2}\n');
    });

    it('should return null for invalid commit hash', () => {
      writeFileSync(join(repoPath, 'test.json'), 'hello');
      gitCommitAll(repoPath, 'initial');

      const result = gitShowFile(repoPath, 'deadbeef1234567890deadbeef1234567890dead', 'test.json');
      expect(result).toBeNull();
    });

    it('should return null for file that did not exist at that commit', () => {
      writeFileSync(join(repoPath, 'first.txt'), 'first');
      gitCommitAll(repoPath, 'first commit');

      const log = gitFileLog(repoPath, join(repoPath, 'first.txt'));
      const firstHash = log[0].hash;

      writeFileSync(join(repoPath, 'second.txt'), 'second');
      gitCommitAll(repoPath, 'second commit');

      // second.txt did not exist at the first commit
      const result = gitShowFile(repoPath, firstHash, 'second.txt');
      expect(result).toBeNull();
    });

    it('should handle nested file paths', () => {
      mkdirSync(join(repoPath, 'entries', 'fact'), { recursive: true });
      const filePath = join(repoPath, 'entries', 'fact', 'test-id.json');
      writeFileSync(filePath, '{"id": "test-id"}\n');
      gitCommitAll(repoPath, 'add entry');

      const log = gitFileLog(repoPath, filePath);
      const content = gitShowFile(repoPath, log[0].hash, 'entries/fact/test-id.json');
      expect(content).toBe('{"id": "test-id"}\n');
    });
  });

  describe('getEntryHistory (integration)', () => {
    beforeEach(() => {
      setupTestDb();
      ensureRepoStructure(repoPath);

      const config: SyncConfig = {
        repos: [{ name: 'default', path: repoPath }],
      };
      setSyncConfig(config);
    });

    afterEach(() => {
      setSyncConfig(null);
      teardownTestDb();
    });

    it('should return history for a committed entry', () => {
      // Insert entry into DB
      const entry = insertKnowledge({
        type: 'fact',
        title: 'Test fact',
        content: 'Version 1',
      });

      // Write entry JSON and commit
      const filePath = entryFilePath(repoPath, entry.type, entry.id);
      writeFileSync(filePath, JSON.stringify({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        content: 'Version 1',
        tags: [],
        project: null,
        scope: 'company',
        source: 'unknown',
        status: 'active',
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      }, null, 2) + '\n');
      gitCommitAll(repoPath, 'knowledge: store fact "Test fact"');

      // Update and commit again
      writeFileSync(filePath, JSON.stringify({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        content: 'Version 2',
        tags: [],
        project: null,
        scope: 'company',
        source: 'unknown',
        status: 'active',
        created_at: entry.created_at,
        updated_at: new Date().toISOString(),
      }, null, 2) + '\n');
      gitCommitAll(repoPath, 'knowledge: update fact "Test fact"');

      const history = getEntryHistory(entry.id);
      expect(history).toHaveLength(2);
      expect(history[0].message).toBe('knowledge: update fact "Test fact"');
      expect(history[1].message).toBe('knowledge: store fact "Test fact"');
    });

    it('should return empty array when sync is not configured', () => {
      setSyncConfig(null);

      const entry = insertKnowledge({
        type: 'fact',
        title: 'Test fact',
        content: 'Some content',
      });

      const history = getEntryHistory(entry.id);
      expect(history).toEqual([]);
    });

    it('should return empty array for non-existent entry', () => {
      const history = getEntryHistory('00000000-0000-0000-0000-000000000000');
      expect(history).toEqual([]);
    });

    it('should return empty array for entry that was never committed', () => {
      const entry = insertKnowledge({
        type: 'fact',
        title: 'Uncommitted fact',
        content: 'Never written to git',
      });

      const history = getEntryHistory(entry.id);
      expect(history).toEqual([]);
    });
  });

  describe('getEntryAtCommit (integration)', () => {
    beforeEach(() => {
      setupTestDb();
      ensureRepoStructure(repoPath);

      const config: SyncConfig = {
        repos: [{ name: 'default', path: repoPath }],
      };
      setSyncConfig(config);
    });

    afterEach(() => {
      setSyncConfig(null);
      teardownTestDb();
    });

    it('should return parsed entry at a specific commit', () => {
      const entry = insertKnowledge({
        type: 'decision',
        title: 'Test decision',
        content: 'Original content',
      });

      const filePath = entryFilePath(repoPath, entry.type, entry.id);
      const entryJson = {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        content: 'Original content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'unknown',
        status: 'active',
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      };
      writeFileSync(filePath, JSON.stringify(entryJson, null, 2) + '\n');
      gitCommitAll(repoPath, 'add decision');

      // Update content
      const updatedJson = { ...entryJson, content: 'Updated content', updated_at: new Date().toISOString() };
      writeFileSync(filePath, JSON.stringify(updatedJson, null, 2) + '\n');
      gitCommitAll(repoPath, 'update decision');

      // Get history and retrieve the first version
      const history = getEntryHistory(entry.id);
      expect(history).toHaveLength(2);

      const oldVersion = getEntryAtCommit(entry.id, history[1].hash);
      expect(oldVersion).not.toBeNull();
      expect(oldVersion!.content).toBe('Original content');
      expect(oldVersion!.type).toBe('decision');

      const newVersion = getEntryAtCommit(entry.id, history[0].hash);
      expect(newVersion).not.toBeNull();
      expect(newVersion!.content).toBe('Updated content');
    });

    it('should return null for invalid commit hash', () => {
      const entry = insertKnowledge({
        type: 'fact',
        title: 'Test',
        content: 'Content',
      });

      const result = getEntryAtCommit(entry.id, 'deadbeef1234567890deadbeef1234567890dead');
      expect(result).toBeNull();
    });

    it('should return null when sync is not configured', () => {
      const entry = insertKnowledge({
        type: 'fact',
        title: 'Test',
        content: 'Content',
      });

      setSyncConfig(null);

      const result = getEntryAtCommit(entry.id, 'abc1234');
      expect(result).toBeNull();
    });

    it('should return null for non-existent entry', () => {
      const result = getEntryAtCommit('00000000-0000-0000-0000-000000000000', 'abc1234');
      expect(result).toBeNull();
    });
  });
});
