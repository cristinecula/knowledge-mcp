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
  updateKnowledgeContent,
  deprecateKnowledge,
  deleteKnowledge,
  deleteLink,
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
  getRepoLinkIds,
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
        updated_at: new Date().toISOString(),
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
        updated_at: new Date().toISOString(),
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
        updated_at: new Date().toISOString(),
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
        id: id1, type: 'fact', title: 'E1', content: '', tags: [], project: null, scope: 'company', source: 'remote', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });

      // Entry 2 in repo 2
      ensureRepoStructure(repoPath2);
      writeEntryFile(repoPath2, {
        id: id2, type: 'fact', title: 'E2', content: '', tags: [], project: null, scope: 'company', source: 'remote', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      });

      const result = await pull(multiConfig);
      expect(result.new_entries).toBe(2);
      expect(getKnowledgeById(id1)).toBeTruthy();
      expect(getKnowledgeById(id2)).toBeTruthy();
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

  describe('full conflict resolution flow', () => {
    it('should create conflict entry and contradicts link when both sides changed', async () => {
      const past = '2025-01-01T00:00:00.000Z';

      // 1. Create and sync an entry
      const entry = insertKnowledge({ title: 'Original', type: 'fact', content: 'Original content' });
      syncWriteEntry(entry);
      gitCommitAll(repoPath, 'initial');

      // 2. Set synced_at to a known past time so we can clearly distinguish local/remote changes
      updateSyncedAt(entry.id, past);

      // 3. Modify locally using updateKnowledgeFields (sets content_updated_at = now > past synced_at)
      updateKnowledgeFields(entry.id, {
        title: 'Local Version',
        content: 'Local content',
      });

      // Verify local entry state: content_updated_at > synced_at
      const local = getKnowledgeById(entry.id);
      expect(local!.content_updated_at! > local!.synced_at!).toBe(true);

      // 4. Simulate remote changes by writing a different version to repo
      //    Remote updated_at must also be > past synced_at
      const remoteTime = new Date().toISOString();
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
        updated_at: remoteTime,
      });

      // 5. Pull — should detect conflict (both local and remote changed since synced_at)
      const result = await pull(config);
      expect(result.conflicts).toBe(1);
      expect(result.conflict_details).toHaveLength(1);
      expect(result.conflict_details[0].original_id).toBe(entry.id);
      expect(result.conflict_details[0].title).toBe('Remote Version');

      // 6. Original entry should be flagged needs_revalidation
      const original = getKnowledgeById(entry.id);
      expect(original!.status).toBe('needs_revalidation');

      // 7. Conflict entry should exist with [Sync Conflict] prefix
      const conflictId = result.conflict_details[0].conflict_id;
      const conflict = getKnowledgeById(conflictId);
      expect(conflict).toBeTruthy();
      expect(conflict!.title).toBe('[Sync Conflict] Remote Version');
      expect(conflict!.content).toBe('Remote content');
      expect(conflict!.status).toBe('needs_revalidation');

      // 8. Should have a contradicts link from conflict → original
      const links = getAllLinks();
      const conflictLink = links.find(
        (l) => l.source_id === conflictId && l.target_id === entry.id && l.link_type === 'contradicts'
      );
      expect(conflictLink).toBeTruthy();
      expect(conflictLink!.source).toBe('sync:conflict');
    });

    it('should not conflict when both sides made identical changes', async () => {
      const past = '2025-01-01T00:00:00.000Z';

      // 1. Create and sync an entry
      const entry = insertKnowledge({ title: 'Same', type: 'fact', content: 'Same content' });
      syncWriteEntry(entry);
      gitCommitAll(repoPath, 'initial');

      // 2. Set synced_at to past so both sides appear changed
      updateSyncedAt(entry.id, past);

      // 3. Modify locally (content_updated_at = now > past)
      updateKnowledgeFields(entry.id, {
        title: 'Updated Same',
        content: 'Updated content',
      });

      // 4. Write identical remote changes (updated_at = now > past)
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
        updated_at: new Date().toISOString(),
      });

      // 5. Pull — should detect no conflict (identical content despite both sides changing)
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
      // Create synced entries and link
      const e1 = insertKnowledge({ title: 'E1', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'E2', type: 'fact', content: '' });
      syncWriteEntry(e1);
      syncWriteEntry(e2);

      const link = insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        source: 'user',
      });

      // Also write the link to the repo (simulates it was previously synced)
      syncWriteLink(link, e1);

      // Pull to establish sync baseline (entries + link all present in repo)
      await pull(config);

      // Verify link exists locally
      let links = getAllLinks();
      expect(links.find((l) => l.id === link.id)).toBeTruthy();

      // Remove link file from repo (simulate remote deletion)
      const linkPath = join(repoPath, 'links', `${link.id}.json`);
      if (existsSync(linkPath)) {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(linkPath);
      }

      // Pull again — should detect deletion
      const result = await pull(config);
      expect(result.deleted_links).toBe(1);

      links = getAllLinks();
      expect(links.find((l) => l.id === link.id)).toBeUndefined();
    });
  });

  describe('push with links', () => {
    it('should export links to repo', () => {
      const e1 = insertKnowledge({ title: 'A', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'B', type: 'fact', content: '' });
      insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        description: 'pushed link',
        source: 'user',
      });

      const result = push(config);
      expect(result.new_links).toBe(1);

      // Verify link file exists
      const linkIds = getRepoLinkIds(repoPath);
      expect(linkIds.size).toBe(1);
    });

    it('should clean up deleted links during push', () => {
      const e1 = insertKnowledge({ title: 'A', type: 'fact', content: '' });
      const e2 = insertKnowledge({ title: 'B', type: 'fact', content: '' });
      const link = insertLink({
        sourceId: e1.id,
        targetId: e2.id,
        linkType: 'related',
        source: 'user',
      });

      // First push — creates the link file
      push(config);
      expect(getRepoLinkIds(repoPath).has(link.id)).toBe(true);

      // Delete the link locally
      deleteLink(link.id);

      // Second push — should remove the link file
      const result = push(config);
      expect(result.deleted_links).toBe(1);
      expect(getRepoLinkIds(repoPath).has(link.id)).toBe(false);
    });

    it('should not push conflict-related links', () => {
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

      const result = push(config);
      // Should push entries but not the conflict link
      expect(result.new_links).toBe(0);
    });

    it('should not push [Sync Conflict] entries', () => {
      insertKnowledge({ title: '[Sync Conflict] Remote Version', type: 'fact', content: 'conflict' });
      insertKnowledge({ title: 'Normal Entry', type: 'fact', content: 'normal' });

      const result = push(config);
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
        updated_at: new Date().toISOString(),
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
        updated_at: new Date().toISOString(),
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
        updated_at: '2025-01-02T00:00:00.000Z',
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
});
