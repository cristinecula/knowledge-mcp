/**
 * Tests for the git-based sync layer with multi-repo support and git operations.
 *
 * Uses temp directories for the sync repos and in-memory SQLite for isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupTestDb, teardownTestDb } from './helpers.js';
import {
  insertKnowledge,
  insertLink,
  getKnowledgeById,
  getAllEntries,
  getAllLinks,
  updateKnowledgeFields,
  updateSyncedAt,
  deleteKnowledge,
  importKnowledge,
  importLink,
} from '../db/queries.js';
import {
  entryToJSON,
  parseEntryJSON,
  linkToJSON,
  parseLinkJSON,
  ensureRepoStructure,
  writeEntryFile,
  writeLinkFile,
  push,
  pull,
  detectConflict,
  setSyncConfig,
  getSyncConfig,
  syncWriteEntry,
  syncWriteLink,
  syncDeleteEntry,
  syncDeleteLink,
  touchedRepos,
  clearTouchedRepos,
} from '../sync/index.js';
import { gitInit, gitCommitAll, isGitRepo } from '../sync/git.js';
import type { EntryJSON, LinkJSON } from '../sync/serialize.js';
import type { SyncConfig } from '../sync/routing.js';

describe('sync layer', () => {
  let repoPath: string;
  let repoPath2: string;
  let config: SyncConfig;

  beforeEach(() => {
    setupTestDb();
    repoPath = mkdtempSync(join(tmpdir(), 'knowledge-mcp-sync-'));
    repoPath2 = mkdtempSync(join(tmpdir(), 'knowledge-mcp-sync-2-'));
    
    // Initialize git repos
    gitInit(repoPath);
    gitInit(repoPath2);
    
    config = {
      repos: [
        { name: 'default', path: repoPath },
      ],
    };
    setSyncConfig(config);
    clearTouchedRepos();
  });

  afterEach(() => {
    teardownTestDb();
    setSyncConfig(null);
    try {
      if (existsSync(repoPath)) rmSync(repoPath, { recursive: true, force: true });
      if (existsSync(repoPath2)) rmSync(repoPath2, { recursive: true, force: true });
    } catch (e) {
      console.error('Failed to clean up temp dir:', e);
    }
  });

  describe('serialization', () => {
    it('should serialize entry to JSON excluding local fields', () => {
      const entry = insertKnowledge({
        type: 'decision',
        title: 'Test Decision',
        content: 'Content',
        tags: ['a', 'b'],
        project: 'myproject',
        scope: 'project',
      });

      const json = entryToJSON(entry);

      expect(json.id).toBe(entry.id);
      expect(json.title).toBe('Test Decision');
      expect(json.tags).toEqual(['a', 'b']);
      expect(json.project).toBe('myproject');

      // Local fields should NOT be in the JSON
      const raw = json as unknown as Record<string, unknown>;
      expect(raw.strength).toBeUndefined();
      expect(raw.access_count).toBeUndefined();
      expect(raw.last_accessed_at).toBeUndefined();
      expect(raw.synced_at).toBeUndefined();
    });

    it('should parse valid entry JSON', () => {
      const raw: EntryJSON = {
        id: 'test-id',
        type: 'fact',
        title: 'Title',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const entry = parseEntryJSON(raw);
      expect(entry.id).toBe('test-id');
      expect(entry.title).toBe('Title');
    });

    it('should serialize link to JSON', () => {
      const e1 = insertKnowledge({ title: 'A', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'B', type: 'fact', content: '' });
      const link = insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        description: 'desc',
        source: 'user',
      });

      const json = linkToJSON(link);
      expect(json.id).toBe(link.id);
      expect(json.source_id).toBe(e1.id);
      expect(json.target_id).toBe(e2.id);
      expect(json.link_type).toBe('related');
    });
  });

  describe('fs', () => {
    it('should create repo structure', () => {
      ensureRepoStructure(repoPath);
      expect(existsSync(join(repoPath, 'entries', 'fact'))).toBe(true);
      expect(existsSync(join(repoPath, 'entries', 'decision'))).toBe(true);
      expect(existsSync(join(repoPath, 'links'))).toBe(true);
      expect(existsSync(join(repoPath, 'meta.json'))).toBe(true);
    });

    it('should write and read entry files', () => {
      ensureRepoStructure(repoPath);
      const entry: EntryJSON = {
        id: 'test-id',
        type: 'fact',
        title: 'Title',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      writeEntryFile(repoPath, entry);
      expect(existsSync(join(repoPath, 'entries', 'fact', 'test-id.json'))).toBe(true);
    });
  });

  describe('git integration', () => {
    it('should initialize a git repo', () => {
      expect(isGitRepo(repoPath)).toBe(true);
    });

    it('should commit changes', () => {
      ensureRepoStructure(repoPath);
      const entry: EntryJSON = {
        id: 'test-id',
        type: 'fact',
        title: 'Title',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      writeEntryFile(repoPath, entry);
      
      const committed = gitCommitAll(repoPath, 'test commit');
      expect(committed).toBe(true);
      
      // Second commit with no changes should return false
      const committedAgain = gitCommitAll(repoPath, 'empty commit');
      expect(committedAgain).toBe(false);
    });
  });

  describe('write-through', () => {
    it('should write entry to repo on save', () => {
      const entry = insertKnowledge({ title: 'Test', type: 'fact', content: 'Content' });
      syncWriteEntry(entry);

      expect(existsSync(join(repoPath, 'entries', 'fact', `${entry.id}.json`))).toBe(true);
      expect(touchedRepos.has(repoPath)).toBe(true);
    });

    it('should handle type changes by moving file', () => {
      const entry = insertKnowledge({ title: 'Test', type: 'fact', content: 'Content' });
      syncWriteEntry(entry);

      // Change type
      const updated = updateKnowledgeFields(entry.id, { type: 'pattern' });
      syncWriteEntry(updated!, 'fact'); // oldType='fact'

      expect(existsSync(join(repoPath, 'entries', 'fact', `${entry.id}.json`))).toBe(false);
      expect(existsSync(join(repoPath, 'entries', 'pattern', `${entry.id}.json`))).toBe(true);
    });

    it('should route to correct repo based on config', () => {
      // Setup multi-repo config
      const multiConfig: SyncConfig = {
        repos: [
          { name: 'company', path: repoPath, scope: 'company' },
          { name: 'project', path: repoPath2, scope: 'project' },
        ],
      };
      setSyncConfig(multiConfig);

      // Company entry -> repoPath
      const companyEntry = insertKnowledge({ title: 'Company', type: 'fact', content: 'C', scope: 'company' });
      syncWriteEntry(companyEntry);
      expect(existsSync(join(repoPath, 'entries', 'fact', `${companyEntry.id}.json`))).toBe(true);
      expect(existsSync(join(repoPath2, 'entries', 'fact', `${companyEntry.id}.json`))).toBe(false);

      // Project entry -> repoPath2
      const projectEntry = insertKnowledge({ title: 'Project', type: 'fact', content: 'P', scope: 'project' });
      syncWriteEntry(projectEntry);
      expect(existsSync(join(repoPath2, 'entries', 'fact', `${projectEntry.id}.json`))).toBe(true);
      expect(existsSync(join(repoPath, 'entries', 'fact', `${projectEntry.id}.json`))).toBe(false);
    });

    it('should move entry between repos when scope changes', () => {
      // Setup multi-repo config
      const multiConfig: SyncConfig = {
        repos: [
          { name: 'company', path: repoPath, scope: 'company' },
          { name: 'project', path: repoPath2, scope: 'project' },
        ],
      };
      setSyncConfig(multiConfig);

      // Start as project
      const entry = insertKnowledge({ title: 'Move Me', type: 'fact', content: 'C', scope: 'project' });
      syncWriteEntry(entry);
      expect(existsSync(join(repoPath2, 'entries', 'fact', `${entry.id}.json`))).toBe(true);

      // Change to company
      const updated = updateKnowledgeFields(entry.id, { scope: 'company' });
      syncWriteEntry(updated!, 'fact', 'project', null); // oldScope='project'

      // Should be gone from project repo, present in company repo
      expect(existsSync(join(repoPath2, 'entries', 'fact', `${entry.id}.json`))).toBe(false);
      expect(existsSync(join(repoPath, 'entries', 'fact', `${entry.id}.json`))).toBe(true);
      
      expect(touchedRepos.has(repoPath)).toBe(true);
      expect(touchedRepos.has(repoPath2)).toBe(true);
    });
  });

  describe('pull', () => {
    it('should import new entries from repo', async () => {
      const entry: EntryJSON = {
        id: 'remote-1',
        type: 'fact',
        title: 'Remote Title',
        content: 'Remote Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'remote',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      ensureRepoStructure(repoPath);
      writeEntryFile(repoPath, entry);

      const result = await pull(config);
      expect(result.new_entries).toBe(1);

      const local = getKnowledgeById('remote-1');
      expect(local).toBeTruthy();
      expect(local?.title).toBe('Remote Title');
    });

    it('should detect remote deletions', async () => {
      // Create local entry that thinks it was synced
      const entry = insertKnowledge({ title: 'Deleted Remote', type: 'fact', content: '' });
      updateSyncedAt(entry.id);

      // It doesn't exist in repo (repo is empty)
      ensureRepoStructure(repoPath);

      const result = await pull(config);
      expect(result.deleted).toBe(1);

      const local = getKnowledgeById(entry.id);
      expect(local).toBeNull();
    });

    it('should aggregate entries from multiple repos', async () => {
      // Setup multi-repo config
      const multiConfig: SyncConfig = {
        repos: [
          { name: 'r1', path: repoPath },
          { name: 'r2', path: repoPath2 },
        ],
      };

      // Entry 1 in repo 1
      ensureRepoStructure(repoPath);
      writeEntryFile(repoPath, {
        id: 'e1', type: 'fact', title: 'E1', content: '', tags: [], project: null, scope: 'company', source: 'remote', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });

      // Entry 2 in repo 2
      ensureRepoStructure(repoPath2);
      writeEntryFile(repoPath2, {
        id: 'e2', type: 'fact', title: 'E2', content: '', tags: [], project: null, scope: 'company', source: 'remote', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });

      const result = await pull(multiConfig);
      expect(result.new_entries).toBe(2);
      expect(getKnowledgeById('e1')).toBeTruthy();
      expect(getKnowledgeById('e2')).toBeTruthy();
    });
  });

  describe('push', () => {
    it('should export all local entries to repo', () => {
      insertKnowledge({ title: 'A', type: 'fact', content: '' });
      insertKnowledge({ title: 'B', type: 'decision', content: '' });

      const result = push(config);
      expect(result.new_entries).toBe(2);

      const files = getAllEntries(); // Just checking we have 2
      expect(files.length).toBe(2);
    });

    it('should route entries to correct repos during push', () => {
      // Setup multi-repo config
      const multiConfig: SyncConfig = {
        repos: [
          { name: 'company', path: repoPath, scope: 'company' },
          { name: 'project', path: repoPath2, scope: 'project' },
        ],
      };

      const e1 = insertKnowledge({ title: 'Company', type: 'fact', content: '', scope: 'company' });
      const e2 = insertKnowledge({ title: 'Project', type: 'fact', content: '', scope: 'project' });

      const result = push(multiConfig);
      expect(result.new_entries).toBe(2);

      // Check files in correct repos
      expect(existsSync(join(repoPath, 'entries', 'fact', `${e1.id}.json`))).toBe(true);
      expect(existsSync(join(repoPath2, 'entries', 'fact', `${e2.id}.json`))).toBe(true);

      // Check files NOT in wrong repos
      expect(existsSync(join(repoPath2, 'entries', 'fact', `${e1.id}.json`))).toBe(false);
      expect(existsSync(join(repoPath, 'entries', 'fact', `${e2.id}.json`))).toBe(false);
    });
  });

  describe('conflict detection', () => {
    it('should return no_change when timestamps match', () => {
      const now = new Date().toISOString();
      const local: any = { content_updated_at: now, synced_at: now };
      const remote: any = { updated_at: now };
      
      const result = detectConflict(local, remote);
      expect(result.action).toBe('no_change');
    });

    it('should return remote_wins when remote is newer', () => {
      const past = '2020-01-01T00:00:00.000Z';
      const now = new Date().toISOString();
      // local hasn't changed since sync (synced_at >= content_updated_at)
      const local: any = { content_updated_at: past, synced_at: past };
      // remote has changed (updated_at > synced_at)
      const remote: any = { updated_at: now };

      const result = detectConflict(local, remote);
      expect(result.action).toBe('remote_wins');
    });

    it('should return local_wins when local is newer', () => {
      const past = '2020-01-01T00:00:00.000Z';
      const now = new Date().toISOString();
      // local changed since sync (content_updated_at > synced_at)
      const local: any = { content_updated_at: now, synced_at: past };
      // remote hasn't changed since sync (updated_at <= synced_at)
      const remote: any = { updated_at: past };

      const result = detectConflict(local, remote);
      expect(result.action).toBe('local_wins');
    });

    it('should return conflict when both changed', () => {
      const past = '2020-01-01T00:00:00.000Z';
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 1000).toISOString();
      
      // Both changed since sync
      const local: any = { content_updated_at: now, synced_at: past, content: 'local' };
      const remote: any = { updated_at: future, content: 'remote' };

      const result = detectConflict(local, remote);
      expect(result.action).toBe('conflict');
    });
  });

  describe('schema migration', () => {
    it('should update content_updated_at on field changes', () => {
      const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'content' });

      // Set synced_at to a known past time so we can verify content_updated_at advances past it
      updateSyncedAt(entry.id, '2026-01-01T00:00:00.000Z');

      const updated = updateKnowledgeFields(entry.id, { title: 'Updated' });
      expect(updated!.content_updated_at).toBeTruthy();
      // content_updated_at should equal updated_at (both set to now during update)
      expect(updated!.content_updated_at).toBe(updated!.updated_at);
      // content_updated_at should be after our past synced_at, proving it was refreshed
      expect(updated!.content_updated_at! > '2026-01-01T00:00:00.000Z').toBe(true);
    });

    it('should have synced_at as null on new entries', () => {
      const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'content' });
      expect(entry.synced_at).toBeNull();
    });
  });
});
