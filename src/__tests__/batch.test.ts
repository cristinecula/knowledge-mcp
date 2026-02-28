/**
 * Integration tests for batch tools (batch_get_knowledge and batch_operations).
 *
 * These tests exercise the same DB-level operations that the batch tool handlers
 * use, following the same pattern as tools.test.ts.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers.js';
import {
  insertKnowledge,
  getKnowledgeById,
  insertLink,
  getLinksForEntry,
  getLinksForEntries,
  batchRecordAccess,
  resolveKnowledgeId,
  updateKnowledgeFields,
  deleteKnowledge,
  deprecateKnowledge,
  resetInaccuracy,
  computeDiffFactor,
  propagateInaccuracy,
  flagSupersededEntries,
  getOutgoingLinks,
  deleteLink,
  setInaccuracy,
} from '../db/queries.js';
import { INACCURACY_THRESHOLD } from '../types.js';
import type { LinkType } from '../types.js';
import { getDb } from '../db/connection.js';

beforeEach(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

// === batch_get_knowledge workflow ===

describe('batch_get_knowledge workflow', () => {
  it('should retrieve multiple entries by full UUID', () => {
    const e1 = insertKnowledge({ type: 'fact', title: 'Entry One', content: 'Content 1' });
    const e2 = insertKnowledge({ type: 'decision', title: 'Entry Two', content: 'Content 2' });
    const e3 = insertKnowledge({ type: 'pattern', title: 'Entry Three', content: 'Content 3' });

    const ids = [e1.id, e2.id, e3.id];

    // Resolve all IDs
    const resolved: Array<{ requestedId: string; resolvedId: string }> = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const result = resolveKnowledgeId(id);
      if (result === null) {
        notFound.push(id);
      } else if ('error' in result) {
        notFound.push(id);
      } else {
        resolved.push({ requestedId: id, resolvedId: result.id });
      }
    }

    expect(resolved).toHaveLength(3);
    expect(notFound).toHaveLength(0);

    // Fetch entries
    const entries = resolved.map((r) => getKnowledgeById(r.resolvedId)!);
    expect(entries).toHaveLength(3);
    expect(entries[0].title).toBe('Entry One');
    expect(entries[1].title).toBe('Entry Two');
    expect(entries[2].title).toBe('Entry Three');
  });

  it('should resolve short ID prefixes', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Short ID Test', content: 'Content' });
    const shortId = entry.id.slice(0, 8);

    const result = resolveKnowledgeId(shortId);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    expect((result as { id: string }).id).toBe(entry.id);
  });

  it('should return partial results: found entries + not-found IDs', () => {
    const e1 = insertKnowledge({ type: 'fact', title: 'Exists', content: 'Content' });
    const fakeId = '00000000-0000-0000-0000-000000000000';

    const ids = [e1.id, fakeId];
    const resolved: Array<{ resolvedId: string }> = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const result = resolveKnowledgeId(id);
      if (result === null) {
        notFound.push(id);
      } else if ('error' in result) {
        notFound.push(id);
      } else {
        const entry = getKnowledgeById(result.id);
        if (entry) {
          resolved.push({ resolvedId: result.id });
        } else {
          notFound.push(id);
        }
      }
    }

    expect(resolved).toHaveLength(1);
    // The fake UUID resolves via resolveKnowledgeId (it's valid UUID format)
    // but getKnowledgeById returns null, so it ends up in notFound
    expect(notFound).toHaveLength(1);
  });

  it('should batch-record access for all found entries', () => {
    const e1 = insertKnowledge({ type: 'fact', title: 'Access 1', content: 'Content' });
    const e2 = insertKnowledge({ type: 'fact', title: 'Access 2', content: 'Content' });

    expect(getKnowledgeById(e1.id)!.access_count).toBe(0);
    expect(getKnowledgeById(e2.id)!.access_count).toBe(0);

    batchRecordAccess([e1.id, e2.id], 1);

    expect(getKnowledgeById(e1.id)!.access_count).toBe(1);
    expect(getKnowledgeById(e2.id)!.access_count).toBe(1);
  });

  it('should batch-fetch links for all found entries', () => {
    const e1 = insertKnowledge({ type: 'fact', title: 'Source', content: 'Content' });
    const e2 = insertKnowledge({ type: 'fact', title: 'Target', content: 'Content' });
    insertLink({
      sourceId: e1.id,
      targetId: e2.id,
      linkType: 'related' as LinkType,
    });

    const linksMap = getLinksForEntries([e1.id, e2.id]);

    expect(linksMap.get(e1.id)).toHaveLength(1);
    expect(linksMap.get(e2.id)).toHaveLength(1);
    // Same link appears in both directions
    expect(linksMap.get(e1.id)![0].id).toBe(linksMap.get(e2.id)![0].id);
  });

  it('should include revalidation warnings for inaccurate entries', () => {
    const e1 = insertKnowledge({ type: 'fact', title: 'Good entry', content: 'Content' });
    const e2 = insertKnowledge({ type: 'fact', title: 'Stale entry', content: 'Content' });
    setInaccuracy(e2.id, INACCURACY_THRESHOLD + 0.5);

    const entries = [getKnowledgeById(e1.id)!, getKnowledgeById(e2.id)!];
    const warnings: string[] = [];
    for (const entry of entries) {
      if (entry.inaccuracy >= INACCURACY_THRESHOLD) {
        warnings.push(`Entry "${entry.title}" (${entry.id}) may be inaccurate`);
      }
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Stale entry');
  });

  it('should handle all invalid IDs gracefully', () => {
    const fakeId1 = '00000000-0000-0000-0000-000000000001';
    const fakeId2 = '00000000-0000-0000-0000-000000000002';

    const notFound: string[] = [];
    for (const id of [fakeId1, fakeId2]) {
      const result = resolveKnowledgeId(id);
      if (result === null) {
        notFound.push(id);
      } else if ('error' in result) {
        notFound.push(id);
      } else {
        const entry = getKnowledgeById(result.id);
        if (!entry) notFound.push(id);
      }
    }

    expect(notFound).toHaveLength(2);
  });
});

// === batch_operations workflow ===

describe('batch_operations workflow', () => {
  it('should store multiple entries atomically', () => {
    const db = getDb();
    const results: Array<{ id: string; title: string }> = [];

    const runTransaction = db.transaction(() => {
      const e1 = insertKnowledge({ type: 'fact', title: 'Batch Store 1', content: 'Content 1' });
      const e2 = insertKnowledge({ type: 'decision', title: 'Batch Store 2', content: 'Content 2' });
      const e3 = insertKnowledge({ type: 'pattern', title: 'Batch Store 3', content: 'Content 3' });
      results.push({ id: e1.id, title: e1.title }, { id: e2.id, title: e2.title }, { id: e3.id, title: e3.title });
    });
    runTransaction();

    expect(results).toHaveLength(3);
    for (const { id, title } of results) {
      const entry = getKnowledgeById(id);
      expect(entry).not.toBeNull();
      expect(entry!.title).toBe(title);
    }
  });

  it('should perform mixed operations (store + update + deprecate) atomically', () => {
    // Create an entry to update and one to deprecate
    const toUpdate = insertKnowledge({ type: 'fact', title: 'Will Update', content: 'Old content' });
    const toDeprecate = insertKnowledge({ type: 'fact', title: 'Will Deprecate', content: 'Content' });

    const db = getDb();
    let storedId: string | undefined;

    const runTransaction = db.transaction(() => {
      // Store
      const stored = insertKnowledge({ type: 'convention', title: 'New Convention', content: 'Convention content' });
      storedId = stored.id;

      // Update
      updateKnowledgeFields(toUpdate.id, { title: 'Updated Title', content: 'New content' });

      // Deprecate
      deprecateKnowledge(toDeprecate.id, 'No longer relevant');
    });
    runTransaction();

    // Verify store
    expect(getKnowledgeById(storedId!)).not.toBeNull();
    expect(getKnowledgeById(storedId!)!.title).toBe('New Convention');

    // Verify update
    const updated = getKnowledgeById(toUpdate.id)!;
    expect(updated.title).toBe('Updated Title');
    expect(updated.content).toBe('New content');

    // Verify deprecate
    const deprecated = getKnowledgeById(toDeprecate.id)!;
    expect(deprecated.status).toBe('deprecated');
    expect(deprecated.deprecation_reason).toBe('No longer relevant');
  });

  it('should delete multiple entries in a batch', () => {
    const e1 = insertKnowledge({ type: 'fact', title: 'Delete Me 1', content: 'Content' });
    const e2 = insertKnowledge({ type: 'fact', title: 'Delete Me 2', content: 'Content' });

    const db = getDb();
    const runTransaction = db.transaction(() => {
      deleteKnowledge(e1.id);
      deleteKnowledge(e2.id);
    });
    runTransaction();

    expect(getKnowledgeById(e1.id)).toBeNull();
    expect(getKnowledgeById(e2.id)).toBeNull();
  });

  it('should roll back all operations if one fails (all-or-nothing)', () => {
    insertKnowledge({ type: 'fact', title: 'Existing', content: 'Content' });

    const db = getDb();
    let threwError = false;

    try {
      const runTransaction = db.transaction(() => {
        // This should succeed
        insertKnowledge({ type: 'fact', title: 'Should Not Persist', content: 'Content' });

        // This should fail — duplicate primary key by manipulating DB directly
        // Simulate a failure during the transaction
        throw new Error('Simulated failure for entry not found');
      });
      runTransaction();
    } catch {
      threwError = true;
    }

    expect(threwError).toBe(true);

    // The "Should Not Persist" entry should not exist because the transaction rolled back
    // We verify by searching — there should only be the original entry
    const allEntries = db
      .prepare('SELECT COUNT(*) as count FROM knowledge')
      .get() as { count: number };
    expect(allEntries.count).toBe(1);
  });

  it('should handle store with links in a batch', () => {
    const target = insertKnowledge({ type: 'fact', title: 'Link Target', content: 'Content' });

    const db = getDb();
    let sourceId: string | undefined;

    const runTransaction = db.transaction(() => {
      const source = insertKnowledge({ type: 'decision', title: 'Linked Source', content: 'Content' });
      sourceId = source.id;
      insertLink({
        sourceId: source.id,
        targetId: target.id,
        linkType: 'related' as LinkType,
        description: 'Batch link test',
      });
    });
    runTransaction();

    const links = getLinksForEntry(sourceId!);
    expect(links).toHaveLength(1);
    expect(links[0].link_type).toBe('related');
    expect(links[0].description).toBe('Batch link test');
  });

  it('should handle update with declarative links in a batch', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Entry', content: 'Content' });
    const target1 = insertKnowledge({ type: 'fact', title: 'Target 1', content: 'Content' });
    const target2 = insertKnowledge({ type: 'fact', title: 'Target 2', content: 'Content' });

    // Add initial link
    insertLink({
      sourceId: entry.id,
      targetId: target1.id,
      linkType: 'related' as LinkType,
    });

    const db = getDb();
    const runTransaction = db.transaction(() => {
      updateKnowledgeFields(entry.id, { title: 'Updated Entry' });

      // Declarative link diff: remove target1, add target2
      const currentOutgoing = getOutgoingLinks(entry.id).filter(
        (l) => l.link_type !== 'conflicts_with',
      );
      const desired = [{ target_id: target2.id, link_type: 'derived' }];
      const desiredMap = new Map(desired.map((l) => [`${l.target_id}:${l.link_type}`, l]));
      const currentMap = new Map(currentOutgoing.map((l) => [`${l.target_id}:${l.link_type}`, l.id]));

      // Remove old links not in desired
      for (const [key, linkId] of currentMap) {
        if (!desiredMap.has(key)) {
          deleteLink(linkId);
        }
      }

      // Add new links not in current
      for (const [key, link] of desiredMap) {
        if (!currentMap.has(key)) {
          insertLink({
            sourceId: entry.id,
            targetId: link.target_id,
            linkType: link.link_type as LinkType,
          });
        }
      }
    });
    runTransaction();

    const outgoing = getOutgoingLinks(entry.id);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].target_id).toBe(target2.id);
    expect(outgoing[0].link_type).toBe('derived');
  });

  it('should propagate inaccuracy after batch updates', () => {
    const source = insertKnowledge({ type: 'fact', title: 'Source', content: 'Original content about the architecture' });
    const dependent = insertKnowledge({ type: 'decision', title: 'Dependent', content: 'Decision based on source' });
    insertLink({
      sourceId: dependent.id,
      targetId: source.id,
      linkType: 'derived' as LinkType,
    });

    const db = getDb();
    const bumps: Array<{ id: string; newInaccuracy: number }> = [];

    const runTransaction = db.transaction(() => {
      const oldEntry = getKnowledgeById(source.id)!;
      const diffFactor = computeDiffFactor(oldEntry, { content: 'Completely rewritten architecture content' });
      updateKnowledgeFields(source.id, { content: 'Completely rewritten architecture content' });
      resetInaccuracy(source.id);

      // Collect propagation input (but propagate after transaction)
      const propagated = propagateInaccuracy(source.id, diffFactor);
      bumps.push(...propagated);
    });
    runTransaction();

    // Verify inaccuracy was propagated to the dependent
    expect(bumps.length).toBeGreaterThanOrEqual(1);
    const dependentBump = bumps.find((b) => b.id === dependent.id);
    expect(dependentBump).toBeDefined();
    expect(dependentBump!.newInaccuracy).toBeGreaterThan(0);

    // Verify in DB
    const refreshed = getKnowledgeById(dependent.id)!;
    expect(refreshed.inaccuracy).toBeGreaterThan(0);
  });

  it('should handle supersedes link flagging in a batch', () => {
    const oldEntry = insertKnowledge({ type: 'fact', title: 'Old Fact', content: 'Old content' });

    const db = getDb();
    let newId: string | undefined;

    const runTransaction = db.transaction(() => {
      const newEntry = insertKnowledge({ type: 'fact', title: 'New Fact', content: 'New content' });
      newId = newEntry.id;
      insertLink({
        sourceId: newEntry.id,
        targetId: oldEntry.id,
        linkType: 'supersedes' as LinkType,
      });
    });
    runTransaction();

    // Flag superseded entries after transaction
    const bumps = flagSupersededEntries([
      { sourceId: newId!, targetId: oldEntry.id, linkType: 'supersedes' },
    ]);

    expect(bumps.length).toBeGreaterThanOrEqual(1);
    const oldBump = bumps.find((b) => b.id === oldEntry.id);
    expect(oldBump).toBeDefined();

    const refreshed = getKnowledgeById(oldEntry.id)!;
    expect(refreshed.inaccuracy).toBeGreaterThanOrEqual(INACCURACY_THRESHOLD);
  });

  it('should validate entries exist before mutation operations', () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';

    // update on missing entry returns null
    const updated = updateKnowledgeFields(fakeId, { title: 'Nope' });
    expect(updated).toBeNull();

    // delete on missing entry returns false
    const deleted = deleteKnowledge(fakeId);
    expect(deleted).toBe(false);

    // deprecate on missing entry returns null
    const deprecated = deprecateKnowledge(fakeId, 'reason');
    expect(deprecated).toBeNull();
  });

  it('should clear flag_reason on update within a batch', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Flagged', content: 'Content' });

    // Simulate flagging
    const db = getDb();
    db.prepare('UPDATE knowledge SET flag_reason = ? WHERE id = ?').run('Needs review', entry.id);
    expect(getKnowledgeById(entry.id)!.flag_reason).toBe('Needs review');

    const runTransaction = db.transaction(() => {
      const oldEntry = getKnowledgeById(entry.id)!;
      updateKnowledgeFields(entry.id, {
        content: 'Updated content',
        ...(oldEntry.flag_reason ? { flag_reason: null } : {}),
      });
    });
    runTransaction();

    const refreshed = getKnowledgeById(entry.id)!;
    expect(refreshed.flag_reason).toBeNull();
    expect(refreshed.content).toBe('Updated content');
  });
});
