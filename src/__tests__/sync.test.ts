/**
 * Tests for the git-based sync layer.
 *
 * Uses a temp directory for the sync repo and in-memory SQLite for isolation.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
  readAllEntryFiles,
  readAllLinkFiles,
  getRepoEntryIds,
  deleteEntryFile,
  detectConflict,
} from '../sync/index.js';
import { pull } from '../sync/pull.js';
import { push } from '../sync/push.js';

let repoPath: string;

beforeEach(() => {
  setupTestDb();
  // Create a fresh temp directory for each test
  repoPath = mkdtempSync(join(tmpdir(), 'knowledge-sync-test-'));
  ensureRepoStructure(repoPath);
});

afterEach(() => {
  // Clean up temp directory
  if (repoPath && existsSync(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

afterAll(() => {
  teardownTestDb();
});

// === Serialize / Deserialize ===

describe('serialize', () => {
  it('should convert entry to JSON stripping local fields', () => {
    const entry = insertKnowledge({
      type: 'decision',
      title: 'Test Decision',
      content: 'Content here',
      tags: ['a', 'b'],
      project: 'myproject',
      scope: 'project',
      source: 'agent',
    });

    const json = entryToJSON(entry);

    expect(json.id).toBe(entry.id);
    expect(json.type).toBe('decision');
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
    const raw = {
      id: 'test-id',
      type: 'fact',
      title: 'A Fact',
      content: 'Fact content',
      tags: ['x'],
      project: null,
      scope: 'company',
      source: 'test',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    };

    const parsed = parseEntryJSON(raw);
    expect(parsed.id).toBe('test-id');
    expect(parsed.type).toBe('fact');
    expect(parsed.tags).toEqual(['x']);
  });

  it('should throw on invalid entry JSON', () => {
    expect(() => parseEntryJSON({})).toThrow('Missing or invalid id');
    expect(() => parseEntryJSON({ id: 123 })).toThrow('Missing or invalid id');
  });

  it('should convert link to JSON', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const link = insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });

    const json = linkToJSON(link);
    expect(json.id).toBe(link.id);
    expect(json.source_id).toBe(a.id);
    expect(json.target_id).toBe(b.id);
    expect(json.link_type).toBe('related');
  });

  it('should parse valid link JSON', () => {
    const raw = {
      id: 'link-id',
      source_id: 'src',
      target_id: 'tgt',
      link_type: 'derived',
      description: null,
      source: 'test',
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const parsed = parseLinkJSON(raw);
    expect(parsed.id).toBe('link-id');
    expect(parsed.link_type).toBe('derived');
  });
});

// === File system ===

describe('file system', () => {
  it('should create repo directory structure', () => {
    expect(existsSync(join(repoPath, 'entries', 'decision'))).toBe(true);
    expect(existsSync(join(repoPath, 'entries', 'fact'))).toBe(true);
    expect(existsSync(join(repoPath, 'entries', 'convention'))).toBe(true);
    expect(existsSync(join(repoPath, 'links'))).toBe(true);
    expect(existsSync(join(repoPath, 'meta.json'))).toBe(true);
  });

  it('should write and read entry files', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'FS Test', content: 'fs content', tags: ['test'] });
    const json = entryToJSON(entry);

    writeEntryFile(repoPath, json);

    const entries = readAllEntryFiles(repoPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(entry.id);
    expect(entries[0].title).toBe('FS Test');
  });

  it('should write and read link files', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const link = insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });
    const json = linkToJSON(link);

    writeLinkFile(repoPath, json);

    const links = readAllLinkFiles(repoPath);
    expect(links).toHaveLength(1);
    expect(links[0].id).toBe(link.id);
  });

  it('should delete entry files', () => {
    const entry = insertKnowledge({ type: 'decision', title: 'Delete Me', content: 'content' });
    const json = entryToJSON(entry);
    writeEntryFile(repoPath, json);

    const ids = getRepoEntryIds(repoPath);
    expect(ids.has(entry.id)).toBe(true);

    deleteEntryFile(repoPath, entry.id, 'decision');

    const idsAfter = getRepoEntryIds(repoPath);
    expect(idsAfter.has(entry.id)).toBe(false);
  });

  it('should find entry file when type is unknown', () => {
    const entry = insertKnowledge({ type: 'pattern', title: 'Find Me', content: 'content' });
    const json = entryToJSON(entry);
    writeEntryFile(repoPath, json);

    // Delete without specifying type — should search all type dirs
    deleteEntryFile(repoPath, entry.id);

    const ids = getRepoEntryIds(repoPath);
    expect(ids.has(entry.id)).toBe(false);
  });
});

// === Merge logic ===

describe('merge / conflict detection', () => {
  it('should detect no_change when content is identical', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Same', content: 'same content' });
    updateSyncedAt(entry.id);
    const local = getKnowledgeById(entry.id)!;

    const remote = entryToJSON(local);
    const result = detectConflict(local, remote);

    expect(result.action).toBe('no_change');
  });

  it('should detect remote_wins when only remote changed', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Original', content: 'original' });
    updateSyncedAt(entry.id);
    const local = getKnowledgeById(entry.id)!;

    // Remote has newer content
    const remote = {
      ...entryToJSON(local),
      title: 'Updated Remotely',
      updated_at: new Date(Date.now() + 10000).toISOString(),
    };

    const result = detectConflict(local, remote);
    expect(result.action).toBe('remote_wins');
  });

  it('should detect local_wins when only local changed', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Original', content: 'original' });

    // Set synced_at to a past time
    const pastSync = '2026-02-01T00:00:00.000Z';
    updateSyncedAt(entry.id, pastSync);

    // Now update locally (this bumps content_updated_at to "now", which is after pastSync)
    updateKnowledgeFields(entry.id, { title: 'Updated Locally' });
    const local = getKnowledgeById(entry.id)!;

    // Remote has NOT changed since last sync (updated_at is before synced_at)
    const remote = {
      ...entryToJSON(entry),
      title: 'Original',
      updated_at: '2026-01-31T00:00:00.000Z',
    };

    const result = detectConflict(local, remote);
    expect(result.action).toBe('local_wins');
  });

  it('should detect conflict when both sides changed', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Original', content: 'original' });

    // Set synced_at to a past time
    const pastSync = '2026-02-01T00:00:00.000Z';
    updateSyncedAt(entry.id, pastSync);

    // Update locally (bumps content_updated_at to "now", after pastSync)
    updateKnowledgeFields(entry.id, { content: 'local changes' });
    const local = getKnowledgeById(entry.id)!;

    // Remote also changed after sync time
    const remote = {
      ...entryToJSON(entry),
      content: 'remote changes',
      updated_at: new Date(Date.now() + 10000).toISOString(),
    };

    const result = detectConflict(local, remote);
    expect(result.action).toBe('conflict');
  });

  it('should detect conflict for never-synced entries with different content', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Never Synced', content: 'local content' });
    const local = getKnowledgeById(entry.id)!;
    // synced_at is null

    const remote = {
      ...entryToJSON(local),
      content: 'different remote content',
    };

    const result = detectConflict(local, remote);
    expect(result.action).toBe('conflict');
  });

  it('should detect no_change for never-synced entries with same content', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Same', content: 'same' });
    const local = getKnowledgeById(entry.id)!;

    const remote = entryToJSON(local);
    const result = detectConflict(local, remote);

    expect(result.action).toBe('no_change');
  });
});

// === Push ===

describe('push', () => {
  it('should export all local entries to the repo', () => {
    insertKnowledge({ type: 'fact', title: 'Fact 1', content: 'content 1' });
    insertKnowledge({ type: 'decision', title: 'Decision 1', content: 'content 2' });

    const result = push(repoPath);

    expect(result.new_entries).toBe(2);
    expect(result.updated).toBe(0);

    const repoEntries = readAllEntryFiles(repoPath);
    expect(repoEntries).toHaveLength(2);
  });

  it('should export links to the repo', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });

    const result = push(repoPath);

    expect(result.new_links).toBe(1);

    const repoLinks = readAllLinkFiles(repoPath);
    expect(repoLinks).toHaveLength(1);
  });

  it('should skip [Sync Conflict] entries', () => {
    insertKnowledge({ type: 'fact', title: '[Sync Conflict] Something', content: 'conflict version' });
    insertKnowledge({ type: 'fact', title: 'Normal Entry', content: 'normal' });

    const result = push(repoPath);

    expect(result.new_entries).toBe(1);
    const repoEntries = readAllEntryFiles(repoPath);
    expect(repoEntries).toHaveLength(1);
    expect(repoEntries[0].title).toBe('Normal Entry');
  });

  it('should update synced_at after push', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'content' });
    expect(getKnowledgeById(entry.id)!.synced_at).toBeNull();

    push(repoPath);

    expect(getKnowledgeById(entry.id)!.synced_at).not.toBeNull();
  });

  it('should remove entries from repo that were deleted locally', () => {
    const a = insertKnowledge({ type: 'fact', title: 'Keep', content: 'keep' });
    const b = insertKnowledge({ type: 'fact', title: 'Delete', content: 'delete' });

    // First push
    push(repoPath);
    expect(getRepoEntryIds(repoPath).size).toBe(2);

    // Delete locally
    deleteKnowledge(b.id);

    // Second push
    const result = push(repoPath);
    expect(result.deleted).toBe(1);
    expect(getRepoEntryIds(repoPath).size).toBe(1);
    expect(getRepoEntryIds(repoPath).has(a.id)).toBe(true);
  });
});

// === Pull ===

describe('pull', () => {
  it('should import new entries from the repo', async () => {
    // Write entry directly to repo (simulating another user's push)
    const remoteEntry = {
      id: 'remote-entry-1',
      type: 'convention' as const,
      title: 'Remote Convention',
      content: 'Convention from teammate',
      tags: ['remote'],
      project: null,
      scope: 'company' as const,
      source: 'teammate',
      status: 'active' as const,
      created_at: '2026-02-20T10:00:00.000Z',
      updated_at: '2026-02-20T10:00:00.000Z',
    };
    writeEntryFile(repoPath, remoteEntry);

    const result = await pull(repoPath);

    expect(result.new_entries).toBe(1);

    const imported = getKnowledgeById('remote-entry-1');
    expect(imported).not.toBeNull();
    expect(imported!.title).toBe('Remote Convention');
    expect(imported!.synced_at).not.toBeNull();
  });

  it('should import new links from the repo', async () => {
    // Create entries locally first
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });

    // Write a link to the repo (simulating another user)
    writeLinkFile(repoPath, {
      id: 'remote-link-1',
      source_id: a.id,
      target_id: b.id,
      link_type: 'related',
      description: 'Remote link',
      source: 'teammate',
      created_at: '2026-02-20T10:00:00.000Z',
    });

    const result = await pull(repoPath);
    expect(result.new_links).toBe(1);

    const links = getAllLinks();
    expect(links.some((l) => l.id === 'remote-link-1')).toBe(true);
  });

  it('should apply remote_wins when only remote changed', async () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Original', content: 'original content' });
    updateSyncedAt(entry.id);

    // Write updated version to repo
    writeEntryFile(repoPath, {
      id: entry.id,
      type: 'fact',
      title: 'Updated by Remote',
      content: 'remote content',
      tags: [],
      project: null,
      scope: 'company',
      source: 'unknown',
      status: 'active',
      created_at: entry.created_at,
      updated_at: new Date(Date.now() + 10000).toISOString(),
    });

    const result = await pull(repoPath);
    expect(result.updated).toBe(1);

    const updated = getKnowledgeById(entry.id)!;
    expect(updated.title).toBe('Updated by Remote');
    expect(updated.content).toBe('remote content');
  });

  it('should create conflict entry when both sides changed', async () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Original', content: 'original' });

    // Set synced_at to past so both local and remote changes appear "after sync"
    const pastSync = '2026-02-01T00:00:00.000Z';
    updateSyncedAt(entry.id, pastSync);

    // Update locally (bumps content_updated_at to "now", which is after pastSync)
    updateKnowledgeFields(entry.id, { content: 'local edit' });

    // Write different version to repo (also after pastSync)
    writeEntryFile(repoPath, {
      id: entry.id,
      type: 'fact',
      title: 'Original',
      content: 'remote edit',
      tags: [],
      project: null,
      scope: 'company',
      source: 'unknown',
      status: 'active',
      created_at: entry.created_at,
      updated_at: new Date(Date.now() + 10000).toISOString(),
    });

    const result = await pull(repoPath);
    expect(result.conflicts).toBe(1);
    expect(result.conflict_details).toHaveLength(1);
    expect(result.conflict_details[0].original_id).toBe(entry.id);

    // Local entry should be flagged
    const local = getKnowledgeById(entry.id)!;
    expect(local.status).toBe('needs_revalidation');
    expect(local.content).toBe('local edit'); // Content preserved

    // Conflict entry should exist
    const conflictId = result.conflict_details[0].conflict_id;
    const conflict = getKnowledgeById(conflictId)!;
    expect(conflict.title).toContain('[Sync Conflict]');
    expect(conflict.content).toBe('remote edit');
    expect(conflict.status).toBe('needs_revalidation');

    // Should have a contradicts link
    const links = getAllLinks();
    const contradicts = links.find(
      (l) => l.source_id === conflictId && l.target_id === entry.id && l.link_type === 'contradicts',
    );
    expect(contradicts).toBeDefined();
  });

  it('should delete entries that were removed from the repo', async () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Will be deleted remotely', content: 'content' });

    // Push so it's in the repo and has synced_at
    push(repoPath);
    expect(getKnowledgeById(entry.id)!.synced_at).not.toBeNull();

    // Remove from repo (simulating another user deleting it)
    deleteEntryFile(repoPath, entry.id, 'fact');

    const result = await pull(repoPath);
    expect(result.deleted).toBe(1);
    expect(getKnowledgeById(entry.id)).toBeNull();
  });

  it('should NOT delete local-only entries (never synced) that are not in repo', async () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Local Only', content: 'never pushed' });
    // synced_at is null — this was never pushed

    const result = await pull(repoPath);
    expect(result.deleted).toBe(0);
    expect(getKnowledgeById(entry.id)).not.toBeNull();
  });
});

// === Full round-trip ===

describe('round-trip push + pull', () => {
  it('should round-trip entries through push and pull', async () => {
    const entry = insertKnowledge({
      type: 'decision',
      title: 'Round Trip Test',
      content: 'Testing full round-trip',
      tags: ['test', 'sync'],
      project: 'myproject',
      scope: 'project',
      source: 'agent',
    });

    // Push to repo
    push(repoPath);

    // Verify JSON file exists and has correct content
    const repoEntries = readAllEntryFiles(repoPath);
    expect(repoEntries).toHaveLength(1);
    expect(repoEntries[0].title).toBe('Round Trip Test');
    expect(repoEntries[0].tags).toEqual(['test', 'sync']);

    // Verify the JSON doesn't have local-only fields
    const filePath = join(repoPath, 'entries', 'decision', `${entry.id}.json`);
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(raw.strength).toBeUndefined();
    expect(raw.access_count).toBeUndefined();
  });

  it('should handle type changes correctly in round-trip', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Type Change', content: 'content' });

    // Push as fact
    push(repoPath);
    expect(existsSync(join(repoPath, 'entries', 'fact', `${entry.id}.json`))).toBe(true);

    // Change type locally
    updateKnowledgeFields(entry.id, { type: 'decision' });

    // Push again — should move file
    push(repoPath);
    expect(existsSync(join(repoPath, 'entries', 'fact', `${entry.id}.json`))).toBe(false);
    expect(existsSync(join(repoPath, 'entries', 'decision', `${entry.id}.json`))).toBe(true);
  });
});

// === Schema migration ===

describe('schema migration', () => {
  it('should have content_updated_at set on new entries', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'content' });
    expect(entry.content_updated_at).toBeTruthy();
    expect(entry.content_updated_at).toBe(entry.updated_at);
  });

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
