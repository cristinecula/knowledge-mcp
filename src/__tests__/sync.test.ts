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
import { getDb } from '../db/connection.js';
import {
  insertKnowledge,
  insertLink,
  getKnowledgeById,
  getAllEntries,
  getAllLinks,
  updateKnowledgeFields,
  updateSyncedAt,
  deprecateKnowledge,
  deleteLink,
  flagForRevalidation,
} from '../db/queries.js';
import {
  entryToJSON,
  parseEntryJSON,
  linkToJSON,
  ensureRepoStructure,
  writeEntryFile,
  readEntryFileRaw,
  writeLinkFile,
  push,
  pull,
  detectConflict,
  setSyncConfig,
  syncWriteEntry,
  syncWriteLink,
  syncDeleteEntry,
  syncDeleteLink,
  touchedRepos,
  clearTouchedRepos,
  getRepoLinkIds,
  tryAcquireSyncLock,
  releaseSyncLock,
} from '../sync/index.js';
import { gitInit, gitCommitAll, isGitRepo } from '../sync/git.js';
import type { EntryJSON } from '../sync/serialize.js';
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
      const testId = '00000000-0000-4000-a000-000000000001';
      const raw: EntryJSON = {
        id: testId,
        type: 'fact',
        title: 'Title',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: new Date().toISOString(),
        version: 1,
      };

      const entry = parseEntryJSON(raw);
      expect(entry.id).toBe(testId);
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
      const testId = '00000000-0000-4000-a000-000000000002';
      const entry: EntryJSON = {
        id: testId,
        type: 'fact',
        title: 'Title',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: new Date().toISOString(),
        version: 1,
      };

      writeEntryFile(repoPath, entry);
      expect(existsSync(join(repoPath, 'entries', 'fact', `${testId}.json`))).toBe(true);
    });
  });

  describe('git integration', () => {
    it('should initialize a git repo', () => {
      expect(isGitRepo(repoPath)).toBe(true);
    });

    it('should commit changes', () => {
      ensureRepoStructure(repoPath);
      const entry: EntryJSON = {
        id: '00000000-0000-4000-a000-000000000003',
        type: 'fact',
        title: 'Title',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: new Date().toISOString(),
        version: 1,
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
      const remoteId = '00000000-0000-4000-a000-000000000010';
      const entry: EntryJSON = {
        id: remoteId,
        type: 'fact',
        title: 'Remote Title',
        content: 'Remote Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'remote',
        status: 'active',
        created_at: new Date().toISOString(),
        version: 1,
      };

      ensureRepoStructure(repoPath);
      writeEntryFile(repoPath, entry);

      const result = await pull(config);
      expect(result.new_entries).toBe(1);

      const local = getKnowledgeById(remoteId);
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
      const id1 = '00000000-0000-4000-a000-000000000011';
      const id2 = '00000000-0000-4000-a000-000000000012';

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
        id: id1, type: 'fact', title: 'E1', content: '', tags: [], project: null, scope: 'company', source: 'remote', status: 'active', created_at: new Date().toISOString(), version: 1
      });

      // Entry 2 in repo 2
      ensureRepoStructure(repoPath2);
      writeEntryFile(repoPath2, {
        id: id2, type: 'fact', title: 'E2', content: '', tags: [], project: null, scope: 'company', source: 'remote', status: 'active', created_at: new Date().toISOString(), version: 1
      });

      const result = await pull(multiConfig);
      expect(result.new_entries).toBe(2);
      expect(getKnowledgeById(id1)).toBeTruthy();
      expect(getKnowledgeById(id2)).toBeTruthy();
    });
  });

  describe('push', () => {
    it('should export all local entries to repo', async () => {
      insertKnowledge({ title: 'A', type: 'fact', content: '' });
      insertKnowledge({ title: 'B', type: 'decision', content: '' });

      const result = await push(config);
      expect(result.new_entries).toBe(2);

      const files = getAllEntries(); // Just checking we have 2
      expect(files.length).toBe(2);
    });

    it('should route entries to correct repos during push', async () => {
      // Setup multi-repo config
      const multiConfig: SyncConfig = {
        repos: [
          { name: 'company', path: repoPath, scope: 'company' },
          { name: 'project', path: repoPath2, scope: 'project' },
        ],
      };

      const e1 = insertKnowledge({ title: 'Company', type: 'fact', content: '', scope: 'company' });
      const e2 = insertKnowledge({ title: 'Project', type: 'fact', content: '', scope: 'project' });

      const result = await push(multiConfig);
      expect(result.new_entries).toBe(2);

      // Check files in correct repos
      expect(existsSync(join(repoPath, 'entries', 'fact', `${e1.id}.json`))).toBe(true);
      expect(existsSync(join(repoPath2, 'entries', 'fact', `${e2.id}.json`))).toBe(true);

      // Check files NOT in wrong repos
      expect(existsSync(join(repoPath2, 'entries', 'fact', `${e1.id}.json`))).toBe(false);
      expect(existsSync(join(repoPath, 'entries', 'fact', `${e2.id}.json`))).toBe(false);
    });
  });

  describe('conflict detection (version-based)', () => {
    it('should return no_change when neither side changed', () => {
      // Both at version 1, synced_version = 1
      const local: any = { version: 1, synced_version: 1 };
      const remote: any = { version: 1 };
      
      const result = detectConflict(local, remote);
      expect(result.action).toBe('no_change');
    });

    it('should return remote_wins when only remote advanced', () => {
      // local at version 1 (not changed since sync), remote at version 2
      const local: any = { version: 1, synced_version: 1, content: 'old' };
      const remote: any = { version: 2, content: 'new' };

      const result = detectConflict(local, remote);
      expect(result.action).toBe('remote_wins');
    });

    it('should return local_wins when only local advanced', () => {
      // local at version 2 (changed since sync), remote still at 1
      const local: any = { version: 2, synced_version: 1, content: 'new' };
      const remote: any = { version: 1, content: 'old' };

      const result = detectConflict(local, remote);
      expect(result.action).toBe('local_wins');
    });

    it('should return conflict when both changed with different content', () => {
      // Both advanced beyond synced_version=1
      const local: any = { version: 2, synced_version: 1, content: 'local' };
      const remote: any = { version: 3, content: 'remote' };

      const result = detectConflict(local, remote);
      expect(result.action).toBe('conflict');
    });

    it('should return no_change when remote version advanced but content is identical', () => {
      // remote version advanced but content fields all match
      const local: any = {
        type: 'fact',
        title: 'Test entry',
        content: 'Same content',
        tags: ['a', 'b'],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        version: 1,
        synced_version: 1,
      };
      const remote: any = {
        type: 'fact',
        title: 'Test entry',
        content: 'Same content',
        tags: ['a', 'b'],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        version: 2,
      };

      const result = detectConflict(local, remote);
      expect(result.action).toBe('no_change');
    });

    it('should return no_change when local version advanced but content is identical', () => {
      const local: any = {
        type: 'fact',
        title: 'Test entry',
        content: 'Same content',
        tags: ['a'],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        version: 2,
        synced_version: 1,
      };
      const remote: any = {
        type: 'fact',
        title: 'Test entry',
        content: 'Same content',
        tags: ['a'],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        version: 1,
      };

      const result = detectConflict(local, remote);
      expect(result.action).toBe('no_change');
    });

    it('should return remote_wins when content actually differs', () => {
      const local: any = {
        type: 'fact',
        title: 'Old title',
        content: 'Old content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        version: 1,
        synced_version: 1,
      };
      const remote: any = {
        type: 'fact',
        title: 'New title',
        content: 'New content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        version: 2,
      };

      const result = detectConflict(local, remote);
      expect(result.action).toBe('remote_wins');
    });

    it('should treat synced_version=null as 0 (never synced)', () => {
      // Entry was never synced (synced_version = null), local at version 1
      const local: any = { version: 1, synced_version: null, content: 'local' };
      const remote: any = { version: 1, content: 'remote' };

      // Both changed (1 > 0 for both) + content differs → conflict
      const result = detectConflict(local, remote);
      expect(result.action).toBe('conflict');
    });

    it('should return no_change when both sides advanced to identical content', () => {
      const local: any = {
        type: 'fact',
        title: 'Converged',
        content: 'Same final content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        version: 3,
        synced_version: 1,
      };
      const remote: any = {
        type: 'fact',
        title: 'Converged',
        content: 'Same final content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        version: 2,
      };

      const result = detectConflict(local, remote);
      expect(result.action).toBe('no_change');
    });
  });

  describe('link write-through', () => {
    it('should write link to repo on save', () => {
      const e1 = insertKnowledge({ title: 'Source', type: 'fact', content: 'S' });
      const e2 = insertKnowledge({ title: 'Target', type: 'fact', content: 'T' });
      const link = insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        description: 'test link',
        source: 'user',
      });

      syncWriteLink(link, e1);

      expect(existsSync(join(repoPath, 'links', `${link.id}.json`))).toBe(true);
      expect(touchedRepos.has(repoPath)).toBe(true);

      // Verify contents
      const raw = JSON.parse(readFileSync(join(repoPath, 'links', `${link.id}.json`), 'utf-8'));
      expect(raw.source_id).toBe(e1.id);
      expect(raw.target_id).toBe(e2.id);
      expect(raw.link_type).toBe('related');
    });

    it('should route link to source entry repo in multi-repo config', () => {
      const multiConfig: SyncConfig = {
        repos: [
          { name: 'company', path: repoPath, scope: 'company' },
          { name: 'project', path: repoPath2, scope: 'project' },
        ],
      };
      setSyncConfig(multiConfig);

      const e1 = insertKnowledge({ title: 'Source', type: 'fact', content: 'S', scope: 'project' });
      const e2 = insertKnowledge({ title: 'Target', type: 'fact', content: 'T', scope: 'company' });
      const link = insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        description: 'cross-repo link',
        source: 'user',
      });

      // Link should go to source entry's repo (project = repoPath2)
      syncWriteLink(link, e1);

      expect(existsSync(join(repoPath2, 'links', `${link.id}.json`))).toBe(true);
      expect(existsSync(join(repoPath, 'links', `${link.id}.json`))).toBe(false);
    });
  });

  describe('syncDeleteEntry', () => {
    it('should delete entry file from repo', () => {
      const entry = insertKnowledge({ title: 'Delete Me', type: 'fact', content: '' });
      syncWriteEntry(entry);
      expect(existsSync(join(repoPath, 'entries', 'fact', `${entry.id}.json`))).toBe(true);

      clearTouchedRepos();
      syncDeleteEntry(entry.id, 'fact');

      expect(existsSync(join(repoPath, 'entries', 'fact', `${entry.id}.json`))).toBe(false);
      expect(touchedRepos.has(repoPath)).toBe(true);
    });

    it('should search all repos when type is unknown', () => {
      const entry = insertKnowledge({ title: 'Delete Me', type: 'decision', content: '' });
      syncWriteEntry(entry);

      clearTouchedRepos();
      syncDeleteEntry(entry.id); // no type hint

      expect(existsSync(join(repoPath, 'entries', 'decision', `${entry.id}.json`))).toBe(false);
    });

    it('should delete from correct repo in multi-repo config', () => {
      const multiConfig: SyncConfig = {
        repos: [
          { name: 'company', path: repoPath, scope: 'company' },
          { name: 'project', path: repoPath2, scope: 'project' },
        ],
      };
      setSyncConfig(multiConfig);

      const entry = insertKnowledge({ title: 'Project Entry', type: 'fact', content: '', scope: 'project' });
      syncWriteEntry(entry);
      expect(existsSync(join(repoPath2, 'entries', 'fact', `${entry.id}.json`))).toBe(true);

      clearTouchedRepos();
      syncDeleteEntry(entry.id, 'fact');

      // Should be deleted from project repo
      expect(existsSync(join(repoPath2, 'entries', 'fact', `${entry.id}.json`))).toBe(false);
      expect(touchedRepos.has(repoPath2)).toBe(true);
    });
  });

  describe('syncDeleteLink', () => {
    it('should delete link file from repo', () => {
      const e1 = insertKnowledge({ title: 'A', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'B', type: 'fact', content: '' });
      const link = insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        source: 'user',
      });

      syncWriteLink(link, e1);
      expect(existsSync(join(repoPath, 'links', `${link.id}.json`))).toBe(true);

      clearTouchedRepos();
      syncDeleteLink(link.id);

      expect(existsSync(join(repoPath, 'links', `${link.id}.json`))).toBe(false);
      expect(touchedRepos.has(repoPath)).toBe(true);
    });

    it('should search all repos for the link', () => {
      const multiConfig: SyncConfig = {
        repos: [
          { name: 'r1', path: repoPath },
          { name: 'r2', path: repoPath2 },
        ],
      };
      setSyncConfig(multiConfig);

      // Create link in repo2
      const e1 = insertKnowledge({ title: 'A', type: 'fact', content: '', scope: 'company' });
      const e2 = insertKnowledge({ title: 'B', type: 'fact', content: '' });
      const link = insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        source: 'user',
      });

      // Manually write link to repo2
      ensureRepoStructure(repoPath2);
      writeLinkFile(repoPath2, linkToJSON(link));
      expect(existsSync(join(repoPath2, 'links', `${link.id}.json`))).toBe(true);

      clearTouchedRepos();
      syncDeleteLink(link.id);

      // Should find and delete from repo2
      expect(existsSync(join(repoPath2, 'links', `${link.id}.json`))).toBe(false);
    });
  });

  describe('full conflict resolution flow (flipped — remote wins)', () => {
    it('should save local as conflict copy and accept remote as canonical', async () => {
      // 1. Create and sync an entry (version=1, synced_version=1 after push)
      const entry = insertKnowledge({ title: 'Original', type: 'fact', content: 'Original content' });
      await push(config);

      // Verify synced_version is set after push
      const afterPush = getKnowledgeById(entry.id);
      expect(afterPush!.synced_version).toBe(1);

      // 2. Modify locally using updateKnowledgeFields (bumps version to 2)
      updateKnowledgeFields(entry.id, {
        title: 'Local Version',
        content: 'Local content',
      });

      // Verify local version advanced
      const local = getKnowledgeById(entry.id);
      expect(local!.version).toBe(2);
      expect(local!.synced_version).toBe(1); // synced_version stays at 1

      // 3. Simulate remote changes by writing a different version to repo
      //    Remote version must also be > synced_version (1)
      writeEntryFile(repoPath, {
        id: entry.id,
        type: 'fact',
        title: 'Remote Version',
        content: 'Remote content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: entry.created_at,
        version: 3,
      });

      // 4. Pull — should detect conflict (both local and remote advanced beyond synced_version=1)
      const result = await pull(config);
      expect(result.conflicts).toBe(1);
      expect(result.conflict_details).toHaveLength(1);
      expect(result.conflict_details[0].original_id).toBe(entry.id);
      expect(result.conflict_details[0].title).toBe('Remote Version');

      // 5. Original entry should now have REMOTE content (remote wins as canonical)
      const canonical = getKnowledgeById(entry.id);
      expect(canonical!.title).toBe('Remote Version');
      expect(canonical!.content).toBe('Remote content');
      // Canonical should NOT be flagged needs_revalidation
      expect(canonical!.status).toBe('active');

      // 6. Conflict entry should exist with [Sync Conflict] prefix and LOCAL content
      const conflictId = result.conflict_details[0].conflict_id;
      const conflict = getKnowledgeById(conflictId);
      expect(conflict).toBeTruthy();
      expect(conflict!.title).toBe('[Sync Conflict] Local Version');
      expect(conflict!.content).toBe('Local content');
      // Conflict copy gets needs_revalidation status so agents know to resolve it
      expect(conflict!.status).toBe('needs_revalidation');
      expect(conflict!.source).toBe('sync:conflict');

      // 7. Should have a conflicts_with link from conflict copy → canonical
      const links = getAllLinks();
      const conflictLink = links.find(
        (l) => l.source_id === conflictId && l.target_id === entry.id && l.link_type === 'conflicts_with'
      );
      expect(conflictLink).toBeTruthy();
      expect(conflictLink!.source).toBe('sync:conflict');
    });

    it('should not conflict when both sides made identical changes', async () => {
      // 1. Create and sync an entry
      const entry = insertKnowledge({ title: 'Same', type: 'fact', content: 'Same content' });
      await push(config);

      // 2. Modify locally (bumps version to 2)
      updateKnowledgeFields(entry.id, {
        title: 'Updated Same',
        content: 'Updated content',
      });

      // 3. Write identical remote changes with advanced version
      //    Must match all content fields (including source='unknown' default)
      const localEntry = getKnowledgeById(entry.id)!;
      writeEntryFile(repoPath, {
        id: entry.id,
        type: localEntry.type,
        title: localEntry.title,
        content: localEntry.content,
        tags: localEntry.tags,
        project: localEntry.project,
        scope: localEntry.scope,
        source: localEntry.source,
        status: localEntry.status,
        created_at: entry.created_at,
        version: 5, // remote advanced but content is identical
      });

      // 4. Pull — should detect no conflict (identical content despite both sides changing)
      const result = await pull(config);
      expect(result.conflicts).toBe(0);
    });
  });

  describe('pull with links', () => {
    it('should import links from repo', async () => {
      // Create entries first (links need both endpoints)
      const e1 = insertKnowledge({ title: 'E1', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'E2', type: 'fact', content: '' });
      syncWriteEntry(e1);
      syncWriteEntry(e2);

      // Simulate remote link by writing directly to repo
      const linkId = '00000000-0000-4000-a000-000000000020';
      writeLinkFile(repoPath, {
        id: linkId,
        source_id: e1.id,
        target_id: e2.id,
        link_type: 'related',
        description: 'remote link',
        source: 'remote-agent',
        created_at: new Date().toISOString(),
      });

      const result = await pull(config);
      expect(result.new_links).toBe(1);

      const links = getAllLinks();
      const imported = links.find((l) => l.id === linkId);
      expect(imported).toBeTruthy();
      expect(imported!.link_type).toBe('related');
      expect(imported!.source).toBe('remote-agent');
      expect(imported!.synced_at).toBeTruthy();
    });

    it('should skip links where source/target missing locally', async () => {
      const missingSourceId = '00000000-0000-4000-a000-000000000030';
      const missingTargetId = '00000000-0000-4000-a000-000000000031';

      ensureRepoStructure(repoPath);
      writeLinkFile(repoPath, {
        id: '00000000-0000-4000-a000-000000000032',
        source_id: missingSourceId,
        target_id: missingTargetId,
        link_type: 'related',
        description: 'orphan link',
        source: 'remote',
        created_at: new Date().toISOString(),
      });

      const result = await pull(config);
      expect(result.new_links).toBe(0);
    });

    it('should detect remote link deletions', async () => {
      // Create entries and link, then push to establish sync baseline
      const e1 = insertKnowledge({ title: 'E1', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'E2', type: 'fact', content: '' });

      const link = insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        source: 'user',
      });

      // Push to sync everything — this sets synced_at on links
      await push(config);

      // Verify link exists locally and has synced_at set
      let links = getAllLinks();
      const syncedLink = links.find((l) => l.id === link.id);
      expect(syncedLink).toBeTruthy();
      expect(syncedLink!.synced_at).toBeTruthy();

      // Remove link file from repo (simulate remote deletion)
      const linkPath = join(repoPath, 'links', `${link.id}.json`);
      if (existsSync(linkPath)) {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(linkPath);
      }

      // Pull again — should detect deletion because link has synced_at
      const result = await pull(config);
      expect(result.deleted_links).toBe(1);

      links = getAllLinks();
      expect(links.find((l) => l.id === link.id)).toBeUndefined();
    });
    it('should preserve locally-created links that have not been pushed', async () => {
      // Create entries and push them to establish sync baseline
      const e1 = insertKnowledge({ title: 'E1', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'E2', type: 'fact', content: '' });
      await push(config);

      // Now create a link locally (NOT pushed — synced_at should be null)
      const link = insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        description: 'local-only link',
        source: 'user',
      });

      // Verify link has no synced_at
      let links = getAllLinks();
      const localLink = links.find((l) => l.id === link.id);
      expect(localLink).toBeTruthy();
      expect(localLink!.synced_at).toBeNull();

      // Pull — should NOT delete the local link (it was never synced)
      const result = await pull(config);
      expect(result.deleted_links).toBe(0);

      links = getAllLinks();
      expect(links.find((l) => l.id === link.id)).toBeTruthy();
    });
  });

  describe('push with links', () => {
    it('should export links to repo', async () => {
      const e1 = insertKnowledge({ title: 'A', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'B', type: 'fact', content: '' });
      insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        description: 'pushed link',
        source: 'user',
      });

      const result = await push(config);
      expect(result.new_links).toBe(1);

      // Verify link file exists
      const linkIds = getRepoLinkIds(repoPath);
      expect(linkIds.size).toBe(1);
    });

    it('should set synced_at on links after push', async () => {
      const e1 = insertKnowledge({ title: 'A', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'B', type: 'fact', content: '' });
      const link = insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        source: 'user',
      });

      // Before push — synced_at should be null
      let links = getAllLinks();
      expect(links.find((l) => l.id === link.id)!.synced_at).toBeNull();

      await push(config);

      // After push — synced_at should be set
      links = getAllLinks();
      expect(links.find((l) => l.id === link.id)!.synced_at).toBeTruthy();
    });

    it('should clean up deleted links during push', async () => {
      const e1 = insertKnowledge({ title: 'A', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'B', type: 'fact', content: '' });
      const link = insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        source: 'user',
      });

      // First push — creates the link file
      await push(config);
      expect(getRepoLinkIds(repoPath).has(link.id)).toBe(true);

      // Delete the link locally
      deleteLink(link.id);

      // Second push — should remove the link file
      const result = await push(config);
      expect(result.deleted_links).toBe(1);
      expect(getRepoLinkIds(repoPath).has(link.id)).toBe(false);
    });

    it('should not push conflict-related links (sync:conflict source)', async () => {
      const e1 = insertKnowledge({ title: 'A', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'B', type: 'fact', content: '' });

      // Create a sync:conflict link (normally created during conflict resolution)
      insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'contradicts',
        description: 'conflict link',
        source: 'sync:conflict',
      });

      const result = await push(config);
      // Should push entries but not the conflict link
      expect(result.new_links).toBe(0);
    });

    it('should not push conflicts_with links', async () => {
      const e1 = insertKnowledge({ title: 'A2', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'B2', type: 'fact', content: '' });

      // Create a conflicts_with link (new link type for sync conflicts)
      insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'conflicts_with',
        description: 'sync conflict link',
        source: 'sync:conflict',
      });

      const result = await push(config);
      // Should push entries but not the conflicts_with link
      expect(result.new_links).toBe(0);
    });

    it('should not push [Sync Conflict] entries', async () => {
      insertKnowledge({ title: '[Sync Conflict] Remote Version', type: 'fact', content: 'conflict' });
      insertKnowledge({ title: 'Normal Entry', type: 'fact', content: 'normal' });

      const result = await push(config);
      expect(result.new_entries).toBe(1); // Only the normal one
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

    it('should start with version 1 and synced_version null', () => {
      const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'content' });
      expect(entry.version).toBe(1);
      expect(entry.synced_version).toBeNull();
    });

    it('should increment version on updateKnowledgeFields', () => {
      const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'content' });
      expect(entry.version).toBe(1);

      const updated = updateKnowledgeFields(entry.id, { title: 'Updated' });
      expect(updated!.version).toBe(2);

      const updated2 = updateKnowledgeFields(entry.id, { content: 'New content' });
      expect(updated2!.version).toBe(3);
    });

    it('should increment version on deprecateKnowledge', () => {
      const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'content' });
      const deprecated = deprecateKnowledge(entry.id, 'outdated');
      expect(deprecated!.version).toBe(2);
    });

    it('should set synced_version after push', async () => {
      const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'content' });
      expect(entry.synced_version).toBeNull();

      await push(config);

      const afterPush = getKnowledgeById(entry.id);
      expect(afterPush!.synced_version).toBe(1);
    });
  });

  describe('deprecation_reason serialization', () => {
    it('should include deprecation_reason in entryToJSON when set', () => {
      const entry = insertKnowledge({ type: 'fact', title: 'Old fact', content: 'outdated' });
      const deprecated = deprecateKnowledge(entry.id, 'Superseded by new research');

      const json = entryToJSON(deprecated!);
      expect(json.deprecation_reason).toBe('Superseded by new research');
      expect(json.status).toBe('deprecated');
    });

    it('should omit deprecation_reason in entryToJSON when null', () => {
      const entry = insertKnowledge({ type: 'fact', title: 'Active fact', content: 'current' });

      const json = entryToJSON(entry);
      expect(json.deprecation_reason).toBeUndefined();
    });

    it('should parse deprecation_reason from entry JSON', () => {
      const raw = {
        id: '00000000-0000-4000-a000-000000000099',
        type: 'fact',
        title: 'Parsed entry',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'deprecated',
        deprecation_reason: 'No longer relevant',
        created_at: new Date().toISOString(),
        version: 1,
      };

      const parsed = parseEntryJSON(raw);
      expect(parsed.deprecation_reason).toBe('No longer relevant');
      expect(parsed.status).toBe('deprecated');
    });

    it('should handle missing deprecation_reason in parsed JSON', () => {
      const raw = {
        id: '00000000-0000-4000-a000-000000000098',
        type: 'fact',
        title: 'No reason entry',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: new Date().toISOString(),
        version: 1,
      };

      const parsed = parseEntryJSON(raw);
      expect(parsed.deprecation_reason).toBeUndefined();
    });

    it('should round-trip deprecation_reason through serialize/deserialize', () => {
      const entry = insertKnowledge({ type: 'decision', title: 'Old decision', content: 'We chose X' });
      const deprecated = deprecateKnowledge(entry.id, 'X was sunset, migrated to Y');

      const json = entryToJSON(deprecated!);
      const parsed = parseEntryJSON(json);

      expect(parsed.deprecation_reason).toBe('X was sunset, migrated to Y');
      expect(parsed.status).toBe('deprecated');
    });

    it('should write and read deprecation_reason through file sync', () => {
      const entry = insertKnowledge({ type: 'fact', title: 'Deprecated via file', content: 'stuff' });
      const deprecated = deprecateKnowledge(entry.id, 'Moved to docs');

      // Write to file
      ensureRepoStructure(repoPath);
      writeEntryFile(repoPath, deprecated!);

      // Read file back
      const filePath = join(repoPath, 'entries', 'fact', `${entry.id}.json`);
      const fileContent = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(fileContent.deprecation_reason).toBe('Moved to docs');
      expect(fileContent.status).toBe('deprecated');
    });

    it('should import deprecation_reason during pull', async () => {
      ensureRepoStructure(repoPath);
      gitCommitAll(repoPath, 'init structure');

      const entryId = '00000000-0000-4000-a000-000000000097';
      const entryJSON: EntryJSON = {
        id: entryId,
        type: 'convention',
        title: 'Deprecated convention',
        content: 'Old way of doing things',
        tags: ['old'],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'deprecated',
        deprecation_reason: 'Replaced by automated linting',
        created_at: '2025-01-01T00:00:00.000Z',
        version: 1,
      };

      // Write entry file to repo
      const entryDir = join(repoPath, 'entries', 'convention');
      mkdirSync(entryDir, { recursive: true });
      writeFileSync(join(entryDir, `${entryId}.json`), JSON.stringify(entryJSON));
      gitCommitAll(repoPath, 'add deprecated entry');

      // Pull
      const result = await pull(config);
      expect(result.new_entries).toBe(1);

      const imported = getKnowledgeById(entryId);
      expect(imported).not.toBeNull();
      expect(imported!.status).toBe('deprecated');
      expect(imported!.deprecation_reason).toBe('Replaced by automated linting');
    });
  });

  describe('declaration serialization', () => {
    it('should include declaration in entryToJSON when set', () => {
      const entry = insertKnowledge({
        type: 'wiki',
        title: 'Architecture Wiki',
        content: 'Agent-filled content',
        declaration: 'Write about our system architecture',
      });

      const json = entryToJSON(entry);
      expect(json.declaration).toBe('Write about our system architecture');
      expect(json.type).toBe('wiki');
    });

    it('should omit declaration in entryToJSON when null', () => {
      const entry = insertKnowledge({ type: 'fact', title: 'Regular fact', content: 'content' });

      const json = entryToJSON(entry);
      expect(json.declaration).toBeUndefined();
    });

    it('should parse declaration from entry JSON', () => {
      const raw = {
        id: '00000000-0000-4000-a000-000000000080',
        type: 'wiki',
        title: 'Parsed wiki entry',
        content: 'Filled by agent',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        declaration: 'Describe the API layer',
        created_at: new Date().toISOString(),
        version: 1,
      };

      const parsed = parseEntryJSON(raw);
      expect(parsed.declaration).toBe('Describe the API layer');
      expect(parsed.type).toBe('wiki');
    });

    it('should handle missing declaration in parsed JSON', () => {
      const raw = {
        id: '00000000-0000-4000-a000-000000000081',
        type: 'fact',
        title: 'No declaration entry',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: new Date().toISOString(),
        version: 1,
      };

      const parsed = parseEntryJSON(raw);
      expect(parsed.declaration).toBeUndefined();
    });

    it('should round-trip declaration through serialize/deserialize', () => {
      const entry = insertKnowledge({
        type: 'wiki',
        title: 'Round-trip wiki',
        content: 'Agent content here',
        declaration: 'Explain how authentication works end-to-end',
      });

      const json = entryToJSON(entry);
      const parsed = parseEntryJSON(json);

      expect(parsed.declaration).toBe('Explain how authentication works end-to-end');
      expect(parsed.type).toBe('wiki');
    });

    it('should write and read declaration through file sync', () => {
      const entry = insertKnowledge({
        type: 'wiki',
        title: 'File-synced wiki',
        content: 'Content here',
        declaration: 'Document the deployment process',
      });

      // Write to file
      ensureRepoStructure(repoPath);
      writeEntryFile(repoPath, entry);

      // Read file back
      const filePath = join(repoPath, 'entries', 'wiki', `${entry.id}.json`);
      const fileContent = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(fileContent.declaration).toBe('Document the deployment process');
      expect(fileContent.type).toBe('wiki');
    });

    it('should import declaration during pull', async () => {
      ensureRepoStructure(repoPath);
      gitCommitAll(repoPath, 'init structure');

      const entryId = '00000000-0000-4000-a000-000000000082';
      const entryJSON: EntryJSON = {
        id: entryId,
        type: 'wiki',
        title: 'Imported wiki page',
        content: 'Agent-generated content',
        tags: ['architecture'],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        declaration: 'Write about our microservices architecture',
        created_at: '2025-01-01T00:00:00.000Z',
        version: 1,
      };

      // Write entry file to repo
      const entryDir = join(repoPath, 'entries', 'wiki');
      mkdirSync(entryDir, { recursive: true });
      writeFileSync(join(entryDir, `${entryId}.json`), JSON.stringify(entryJSON));
      gitCommitAll(repoPath, 'add wiki entry');

      // Pull
      const result = await pull(config);
      expect(result.new_entries).toBe(1);

      const imported = getKnowledgeById(entryId);
      expect(imported).not.toBeNull();
      expect(imported!.type).toBe('wiki');
      expect(imported!.declaration).toBe('Write about our microservices architecture');
    });
  });

  describe('parent_page_id serialization', () => {
    it('should include parent_page_id in entryToJSON when set', () => {
      const parent = insertKnowledge({
        type: 'wiki',
        title: 'Parent Wiki',
        content: 'Parent content',
      });

      const child = insertKnowledge({
        type: 'wiki',
        title: 'Child Wiki',
        content: 'Child content',
        parentPageId: parent.id,
      });

      const json = entryToJSON(child);
      expect(json.parent_page_id).toBe(parent.id);
    });

    it('should omit parent_page_id in entryToJSON when null', () => {
      const entry = insertKnowledge({ type: 'wiki', title: 'Root Page', content: 'content' });

      const json = entryToJSON(entry);
      expect(json.parent_page_id).toBeUndefined();
    });

    it('should parse parent_page_id from entry JSON', () => {
      const parentId = '00000000-0000-4000-a000-000000000090';
      const raw = {
        id: '00000000-0000-4000-a000-000000000091',
        type: 'wiki',
        title: 'Parsed child page',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        parent_page_id: parentId,
        created_at: new Date().toISOString(),
        version: 1,
      };

      const parsed = parseEntryJSON(raw);
      expect(parsed.parent_page_id).toBe(parentId);
    });

    it('should reject invalid parent_page_id UUID', () => {
      const raw = {
        id: '00000000-0000-4000-a000-000000000092',
        type: 'wiki',
        title: 'Bad parent ref',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        parent_page_id: 'not-a-uuid',
        created_at: new Date().toISOString(),
        version: 1,
      };

      expect(() => parseEntryJSON(raw)).toThrow('Invalid parent_page_id');
    });

    it('should handle missing parent_page_id in parsed JSON', () => {
      const raw = {
        id: '00000000-0000-4000-a000-000000000093',
        type: 'wiki',
        title: 'No parent',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: new Date().toISOString(),
        version: 1,
      };

      const parsed = parseEntryJSON(raw);
      expect(parsed.parent_page_id).toBeUndefined();
    });

    it('should round-trip parent_page_id through serialize/deserialize', () => {
      const parent = insertKnowledge({
        type: 'wiki',
        title: 'Round-trip parent',
        content: 'Parent content',
      });

      const child = insertKnowledge({
        type: 'wiki',
        title: 'Round-trip child',
        content: 'Child content',
        parentPageId: parent.id,
      });

      const json = entryToJSON(child);
      const parsed = parseEntryJSON(json);

      expect(parsed.parent_page_id).toBe(parent.id);
    });

    it('should import parent_page_id during pull', async () => {
      ensureRepoStructure(repoPath);
      gitCommitAll(repoPath, 'init structure');

      const parentId = '00000000-0000-4000-a000-000000000094';
      const childId = '00000000-0000-4000-a000-000000000095';

      // Write parent entry
      const parentJSON: EntryJSON = {
        id: parentId,
        type: 'wiki',
        title: 'Imported parent',
        content: 'Parent content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: '2025-01-01T00:00:00.000Z',
        version: 1,
      };

      // Write child entry with parent_page_id
      const childJSON: EntryJSON = {
        id: childId,
        type: 'wiki',
        title: 'Imported child',
        content: 'Child content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        parent_page_id: parentId,
        created_at: '2025-01-01T00:00:00.000Z',
        version: 1,
      };

      const entryDir = join(repoPath, 'entries', 'wiki');
      mkdirSync(entryDir, { recursive: true });
      writeFileSync(join(entryDir, `${parentId}.json`), JSON.stringify(parentJSON));
      writeFileSync(join(entryDir, `${childId}.json`), JSON.stringify(childJSON));
      gitCommitAll(repoPath, 'add wiki entries');

      const result = await pull(config);
      expect(result.new_entries).toBe(2);

      const importedChild = getKnowledgeById(childId);
      expect(importedChild).not.toBeNull();
      expect(importedChild!.parent_page_id).toBe(parentId);
    });

    it('should detect content change when parent_page_id differs', () => {
      const parent1 = insertKnowledge({ type: 'wiki', title: 'Parent 1', content: '' });
      const parent2 = insertKnowledge({ type: 'wiki', title: 'Parent 2', content: '' });

      const child = insertKnowledge({
        type: 'wiki',
        title: 'Child',
        content: 'Content',
        parentPageId: parent1.id,
      });

      // Simulate synced state — set synced_version = 1 (entry was just synced, not locally modified)
      getDb().prepare('UPDATE knowledge SET synced_version = 1 WHERE id = ?').run(child.id);

      // Re-fetch so we have the updated state
      const localChild = getKnowledgeById(child.id)!;

      // Remote has different parent_page_id and version advanced beyond synced_version
      const remoteJSON: EntryJSON = {
        id: child.id,
        type: 'wiki',
        title: 'Child',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'unknown',
        status: 'active',
        parent_page_id: parent2.id,
        created_at: child.created_at,
        version: 2,
      };

      const result = detectConflict(localChild, remoteJSON);
      expect(result.action).toBe('remote_wins');
    });
  });

  describe('flag_reason serialization', () => {
    it('should include flag_reason in entryToJSON when set', () => {
      const entry = insertKnowledge({ type: 'wiki', title: 'Flagged page', content: 'content' });
      const flagged = flagForRevalidation(entry.id, 'Statistics are outdated');

      const json = entryToJSON(flagged!);
      expect(json.flag_reason).toBe('Statistics are outdated');
      expect(json.status).toBe('needs_revalidation');
    });

    it('should omit flag_reason in entryToJSON when null', () => {
      const entry = insertKnowledge({ type: 'wiki', title: 'Active page', content: 'current' });

      const json = entryToJSON(entry);
      expect(json.flag_reason).toBeUndefined();
    });

    it('should parse flag_reason from entry JSON', () => {
      const raw = {
        id: '00000000-0000-4000-a000-000000000089',
        type: 'wiki',
        title: 'Parsed flagged entry',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'needs_revalidation',
        flag_reason: 'Numbers are wrong',
        created_at: new Date().toISOString(),
        version: 1,
      };

      const parsed = parseEntryJSON(raw);
      expect(parsed.flag_reason).toBe('Numbers are wrong');
      expect(parsed.status).toBe('needs_revalidation');
    });

    it('should handle missing flag_reason in parsed JSON', () => {
      const raw = {
        id: '00000000-0000-4000-a000-000000000088',
        type: 'wiki',
        title: 'No flag entry',
        content: 'Content',
        tags: [],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: new Date().toISOString(),
        version: 1,
      };

      const parsed = parseEntryJSON(raw);
      expect(parsed.flag_reason).toBeUndefined();
    });

    it('should round-trip flag_reason through serialize/deserialize', () => {
      const entry = insertKnowledge({ type: 'wiki', title: 'Flagged wiki', content: 'We document X' });
      const flagged = flagForRevalidation(entry.id, 'X was changed, numbers stale');

      const json = entryToJSON(flagged!);
      const parsed = parseEntryJSON(json);

      expect(parsed.flag_reason).toBe('X was changed, numbers stale');
      expect(parsed.status).toBe('needs_revalidation');
    });

    it('should write and read flag_reason through file sync', () => {
      const entry = insertKnowledge({ type: 'wiki', title: 'Flagged via file', content: 'stuff' });
      const flagged = flagForRevalidation(entry.id, 'Needs review');

      // Write to file
      ensureRepoStructure(repoPath);
      writeEntryFile(repoPath, entryToJSON(flagged!));

      // Read file back
      const filePath = join(repoPath, 'entries', 'wiki', `${entry.id}.json`);
      const fileContent = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(fileContent.flag_reason).toBe('Needs review');
      expect(fileContent.status).toBe('needs_revalidation');
    });

    it('should import flag_reason during pull', async () => {
      ensureRepoStructure(repoPath);
      gitCommitAll(repoPath, 'init structure');

      const entryId = '00000000-0000-4000-a000-000000000087';
      const entryJSON: EntryJSON = {
        id: entryId,
        type: 'wiki',
        title: 'Flagged wiki page',
        content: 'Content that may be inaccurate',
        tags: ['review'],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'needs_revalidation',
        flag_reason: 'User reported incorrect data',
        created_at: '2025-01-01T00:00:00.000Z',
        version: 1,
      };

      // Write entry file to repo
      const entryDir = join(repoPath, 'entries', 'wiki');
      mkdirSync(entryDir, { recursive: true });
      writeFileSync(join(entryDir, `${entryId}.json`), JSON.stringify(entryJSON));
      gitCommitAll(repoPath, 'add flagged entry');

      // Pull
      const result = await pull(config);
      expect(result.new_entries).toBe(1);

      const imported = getKnowledgeById(entryId);
      expect(imported).not.toBeNull();
      expect(imported!.status).toBe('needs_revalidation');
      expect(imported!.flag_reason).toBe('User reported incorrect data');
    });
  });

  describe('pull→push roundtrip stability', () => {
    it('should produce byte-identical JSON after pull→push roundtrip', async () => {
      // updated_at is no longer serialized — the JSON should be stable across roundtrips
      const remoteId = '00000000-0000-4000-a000-000000000098';
      const remoteJSON: EntryJSON = {
        id: remoteId,
        type: 'fact',
        title: 'Roundtrip test',
        content: 'Test content',
        tags: ['tag1'],
        project: null,
        scope: 'company',
        source: 'agent',
        status: 'active',
        created_at: '2025-01-01T00:00:00.000Z',
        version: 1,
      };
      ensureRepoStructure(repoPath);
      writeEntryFile(repoPath, remoteJSON);
      gitCommitAll(repoPath, 'add entry');

      // Pull — imports the entry
      const pullResult = await pull(config);
      expect(pullResult.new_entries).toBe(1);

      // Push — should write byte-identical JSON (no updated_at drift)
      await push(config);

      // Read the file back and compare
      const fileContent = readEntryFileRaw(repoPath, 'fact', remoteId);
      const expected = JSON.stringify(remoteJSON, null, 2) + '\n';
      expect(fileContent).toBe(expected);
    });
  });

  describe('push skip for unchanged entries', () => {
    it('should not write file when entry JSON is byte-identical', async () => {
      insertKnowledge({
        type: 'fact',
        title: 'Stable entry',
        content: 'Content that does not change',
      });

      // First push — creates the file
      const result1 = await push(config);
      expect(result1.new_entries).toBe(1);

      // Commit the initial push
      gitCommitAll(repoPath, 'initial push');

      // Second push — file should be skipped (no write, no git change)
      await push(config);

      // gitCommitAll returns false when there's nothing to commit
      const committed = gitCommitAll(repoPath, 'second push');
      expect(committed).toBe(false);
    });

    it('should write file when entry content changes between pushes', async () => {
      const entry = insertKnowledge({
        type: 'fact',
        title: 'Changing entry',
        content: 'Original content',
      });

      // First push
      await push(config);
      gitCommitAll(repoPath, 'initial push');

      // Modify the entry
      updateKnowledgeFields(entry.id, { content: 'Updated content' });

      // Second push — push() commits internally, so we verify via file content
      await push(config);

      // Verify file has new content
      const fileContent = readEntryFileRaw(repoPath, 'fact', entry.id);
      expect(fileContent).not.toBeNull();
      const parsed = JSON.parse(fileContent!);
      expect(parsed.content).toBe('Updated content');
    });
  });

  describe('sync coordinator lock', () => {
    afterEach(() => {
      // Clean up any locks left by tests
      const db = getDb();
      db.prepare('DELETE FROM sync_lock').run();
    });

    it('should acquire lock when no lock exists', () => {
      expect(tryAcquireSyncLock()).toBe(true);
    });

    it('should allow same PID to re-acquire its own lock', () => {
      expect(tryAcquireSyncLock()).toBe(true);
      expect(tryAcquireSyncLock()).toBe(true);
    });

    it('should block acquisition when another PID holds the lock', () => {
      const db = getDb();
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      // Simulate another process holding the lock — use PID 1 (init, always alive)
      db.prepare('INSERT INTO sync_lock (lock_name, holder_pid, acquired_at, expires_at) VALUES (?, ?, ?, ?)')
        .run('sync', 1, now, future);

      expect(tryAcquireSyncLock()).toBe(false);
    });

    it('should steal lock when holder PID is dead', () => {
      const db = getDb();
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      // Use a PID that almost certainly doesn't exist
      const deadPid = 2_000_000_000;
      db.prepare('INSERT INTO sync_lock (lock_name, holder_pid, acquired_at, expires_at) VALUES (?, ?, ?, ?)')
        .run('sync', deadPid, now, future);

      expect(tryAcquireSyncLock()).toBe(true);

      // Verify we now hold the lock
      const row = db.prepare('SELECT holder_pid FROM sync_lock WHERE lock_name = ?').get('sync') as { holder_pid: number };
      expect(row.holder_pid).toBe(process.pid);
    });

    it('should steal lock when it has expired', () => {
      const db = getDb();
      const past = new Date(Date.now() - 60_000).toISOString();
      // Use PID 1 (alive) but with expired timestamp
      db.prepare('INSERT INTO sync_lock (lock_name, holder_pid, acquired_at, expires_at) VALUES (?, ?, ?, ?)')
        .run('sync', 1, past, past);

      expect(tryAcquireSyncLock()).toBe(true);

      const row = db.prepare('SELECT holder_pid FROM sync_lock WHERE lock_name = ?').get('sync') as { holder_pid: number };
      expect(row.holder_pid).toBe(process.pid);
    });

    it('should release only our own lock', () => {
      const db = getDb();
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      // Another process holds the lock
      db.prepare('INSERT INTO sync_lock (lock_name, holder_pid, acquired_at, expires_at) VALUES (?, ?, ?, ?)')
        .run('sync', 1, now, future);

      // Releasing should not affect another process's lock
      releaseSyncLock();

      const row = db.prepare('SELECT holder_pid FROM sync_lock WHERE lock_name = ?').get('sync') as { holder_pid: number } | undefined;
      expect(row).toBeDefined();
      expect(row!.holder_pid).toBe(1);
    });

    it('should release our lock successfully', () => {
      expect(tryAcquireSyncLock()).toBe(true);

      releaseSyncLock();

      const db = getDb();
      const row = db.prepare('SELECT * FROM sync_lock WHERE lock_name = ?').get('sync');
      expect(row).toBeUndefined();
    });

    it('should allow acquisition after release', () => {
      expect(tryAcquireSyncLock()).toBe(true);
      releaseSyncLock();
      expect(tryAcquireSyncLock()).toBe(true);
    });
  });
});
