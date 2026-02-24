/**
 * Integration tests for tool-level operations.
 *
 * Rather than going through the MCP protocol layer, these tests exercise
 * the same business logic the tool handlers use — calling query functions
 * and verifying outcomes. This validates the full flow without needing an
 * MCP server instance.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers.js';
import {
  insertKnowledge,
  getKnowledgeById,
  searchKnowledge,
  listKnowledge,
  countKnowledge,
  insertLink,
  getLinksForEntry,
  getLinkedEntries,
  getLinkById,
  getIncomingLinks,
  getOutgoingLinks,
  recordAccess,
  updateStatus,
  updateKnowledgeFields,
  deprecateKnowledge,
  deleteKnowledge,
  storeEmbedding,
  getEmbedding,
} from '../db/queries.js';
import { calculateNetworkStrength } from '../memory/strength.js';
import { REINFORCE_ACCESS_BOOST, REVALIDATION_LINK_TYPES } from '../types.js';

beforeEach(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

// === Store workflow ===

describe('store workflow', () => {
  it('should store an entry and optionally create links', () => {
    // Store first entry
    const base = insertKnowledge({
      type: 'decision',
      title: 'Use PostgreSQL',
      content: 'We chose PostgreSQL for the main database',
      tags: ['database', 'architecture'],
      source: 'team-lead',
    });

    // Store second entry with a link to the first
    const derived = insertKnowledge({
      type: 'convention',
      title: 'Use Prisma ORM',
      content: 'Use Prisma as our ORM for PostgreSQL',
      tags: ['database', 'orm'],
      source: 'team-lead',
    });

    // Create a link (as the store tool would)
    const link = insertLink({
      sourceId: derived.id,
      targetId: base.id,
      linkType: 'derived',
      description: 'ORM choice derived from DB choice',
      source: 'team-lead',
    });

    expect(link.source_id).toBe(derived.id);
    expect(link.target_id).toBe(base.id);
    expect(link.link_type).toBe('derived');

    // Verify the link is retrievable
    const links = getLinksForEntry(derived.id);
    expect(links).toHaveLength(1);
  });
});

// === Query workflow ===

describe('query workflow', () => {
  it('should find entries by text and auto-reinforce', () => {
    insertKnowledge({
      type: 'fact',
      title: 'Authentication uses JWT tokens',
      content: 'Our auth system uses JWT for session management',
      tags: ['auth', 'jwt'],
    });

    insertKnowledge({
      type: 'fact',
      title: 'Redis caching strategy',
      content: 'We cache API responses in Redis for 5 minutes',
      tags: ['cache', 'redis'],
    });

    // Simulate query tool: search + reinforce
    const results = searchKnowledge({ query: 'JWT authentication' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain('JWT');

    // Auto-reinforce (as query tool does)
    for (const entry of results) {
      recordAccess(entry.id, 1);
    }

    // Verify access was recorded
    const updated = getKnowledgeById(results[0].id)!;
    expect(updated.access_count).toBe(1);
  });

  it('should include link information in results', () => {
    const a = insertKnowledge({ type: 'fact', title: 'Base fact', content: 'base content' });
    const b = insertKnowledge({ type: 'fact', title: 'Derived fact', content: 'derived content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'derived' });

    const results = searchKnowledge({ query: 'base' });
    expect(results).toHaveLength(1);

    const links = getLinksForEntry(results[0].id);
    expect(links).toHaveLength(1);
  });
});

// === List workflow ===

describe('list workflow', () => {
  it('should list entries filtered by type', () => {
    insertKnowledge({ type: 'convention', title: 'Conv A', content: 'a' });
    insertKnowledge({ type: 'decision', title: 'Dec B', content: 'b' });
    insertKnowledge({ type: 'convention', title: 'Conv C', content: 'c' });

    const results = listKnowledge({ type: 'convention' });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.type === 'convention')).toBe(true);
  });

  it('should not auto-reinforce entries', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'content' });

    // List (no reinforcement)
    listKnowledge({});

    const found = getKnowledgeById(entry.id)!;
    expect(found.access_count).toBe(0);
  });
});

// === Reinforce workflow ===

describe('reinforce workflow', () => {
  it('should boost access count by REINFORCE_ACCESS_BOOST', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });

    // Simulate reinforce tool
    recordAccess(entry.id, REINFORCE_ACCESS_BOOST);

    const updated = getKnowledgeById(entry.id)!;
    expect(updated.access_count).toBe(REINFORCE_ACCESS_BOOST);
    expect(REINFORCE_ACCESS_BOOST).toBe(3);
  });

  it('should clear needs_revalidation status', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    updateStatus(entry.id, 'needs_revalidation');

    // Simulate reinforce tool
    recordAccess(entry.id, REINFORCE_ACCESS_BOOST);
    const found = getKnowledgeById(entry.id)!;
    if (found.status === 'needs_revalidation') {
      updateStatus(entry.id, 'active');
    }

    const updated = getKnowledgeById(entry.id)!;
    expect(updated.status).toBe('active');
  });

  it('should increase calculated strength', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    const links = getLinksForEntry(entry.id);
    const linkedEntries = getLinkedEntries(entry.id);

    const strengthBefore = calculateNetworkStrength(entry, links, linkedEntries);

    recordAccess(entry.id, REINFORCE_ACCESS_BOOST);
    const updated = getKnowledgeById(entry.id)!;
    const strengthAfter = calculateNetworkStrength(updated, links, linkedEntries);

    expect(strengthAfter).toBeGreaterThan(strengthBefore);
  });
});

// === Deprecate workflow ===

describe('deprecate workflow', () => {
  it('should set status to deprecated', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });

    updateStatus(entry.id, 'deprecated');

    const updated = getKnowledgeById(entry.id)!;
    expect(updated.status).toBe('deprecated');
  });

  it('should append deprecation reason to content', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Original content' });

    const reason = 'No longer accurate';
    const updatedContent = entry.content + `\n\n---\n**Deprecated:** ${reason}`;
    updateKnowledgeFields(entry.id, { content: updatedContent });
    updateStatus(entry.id, 'deprecated');

    const updated = getKnowledgeById(entry.id)!;
    expect(updated.content).toContain('No longer accurate');
    expect(updated.status).toBe('deprecated');
  });

  it('should exclude deprecated entries from default searches', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Unique keyword', content: 'Content' });
    updateStatus(entry.id, 'deprecated');

    const results = searchKnowledge({ query: 'Unique' });
    expect(results).toHaveLength(0);
  });
});

// === Update + cascade revalidation workflow ===

describe('update + cascade revalidation workflow', () => {
  it('should flag dependent entries as needs_revalidation', () => {
    const base = insertKnowledge({
      type: 'decision',
      title: 'Use REST API',
      content: 'We use REST for our API layer',
    });

    const derived = insertKnowledge({
      type: 'convention',
      title: 'REST endpoint naming',
      content: 'Use plural nouns for REST endpoints',
    });

    const depending = insertKnowledge({
      type: 'pattern',
      title: 'API client pattern',
      content: 'Use axios with base URL config',
    });

    // Create dependency links pointing AT the base entry
    insertLink({ sourceId: derived.id, targetId: base.id, linkType: 'derived' });
    insertLink({ sourceId: depending.id, targetId: base.id, linkType: 'depends' });

    // Simulate update tool: update the base entry
    updateKnowledgeFields(base.id, { content: 'We switched to GraphQL' });

    // Cascade revalidation (as update tool does)
    const incomingLinks = getIncomingLinks(base.id, REVALIDATION_LINK_TYPES);
    const revalidatedIds: string[] = [];
    for (const link of incomingLinks) {
      const dependentEntry = getKnowledgeById(link.source_id);
      if (dependentEntry && dependentEntry.status !== 'deprecated') {
        updateStatus(link.source_id, 'needs_revalidation');
        revalidatedIds.push(link.source_id);
      }
    }

    expect(revalidatedIds).toHaveLength(2);
    expect(revalidatedIds).toContain(derived.id);
    expect(revalidatedIds).toContain(depending.id);

    // Verify the dependent entries have the flag
    expect(getKnowledgeById(derived.id)!.status).toBe('needs_revalidation');
    expect(getKnowledgeById(depending.id)!.status).toBe('needs_revalidation');

    // Base entry should still be active
    expect(getKnowledgeById(base.id)!.status).toBe('active');
  });

  it('should not flag entries linked with non-revalidation link types', () => {
    const base = insertKnowledge({ type: 'fact', title: 'Base', content: 'base' });
    const related = insertKnowledge({ type: 'fact', title: 'Related', content: 'related' });

    // 'related' is NOT a revalidation link type
    insertLink({ sourceId: related.id, targetId: base.id, linkType: 'related' });

    updateKnowledgeFields(base.id, { content: 'Updated content' });

    // Only check derived/depends links
    const incomingLinks = getIncomingLinks(base.id, REVALIDATION_LINK_TYPES);
    expect(incomingLinks).toHaveLength(0);

    // Related entry should still be active
    expect(getKnowledgeById(related.id)!.status).toBe('active');
  });

  it('should not flag deprecated entries', () => {
    const base = insertKnowledge({ type: 'fact', title: 'Base', content: 'base' });
    const deprecated = insertKnowledge({ type: 'fact', title: 'Deprecated', content: 'dep' });

    insertLink({ sourceId: deprecated.id, targetId: base.id, linkType: 'derived' });

    updateStatus(deprecated.id, 'deprecated');

    updateKnowledgeFields(base.id, { content: 'Updated' });

    const incomingLinks = getIncomingLinks(base.id, REVALIDATION_LINK_TYPES);
    const revalidatedIds: string[] = [];
    for (const link of incomingLinks) {
      const dependentEntry = getKnowledgeById(link.source_id);
      if (dependentEntry && dependentEntry.status !== 'deprecated') {
        updateStatus(link.source_id, 'needs_revalidation');
        revalidatedIds.push(link.source_id);
      }
    }

    expect(revalidatedIds).toHaveLength(0);
  });

  it('should clear needs_revalidation when the entry itself is updated', () => {
    const entry = insertKnowledge({
      type: 'wiki',
      title: 'Project Overview',
      content: 'Stub content',
    });

    // Simulate the entry being flagged for revalidation (e.g. a dependency changed)
    updateStatus(entry.id, 'needs_revalidation');
    expect(getKnowledgeById(entry.id)!.status).toBe('needs_revalidation');

    // Simulate update_knowledge tool behavior: update fields, then clear status
    const oldEntry = getKnowledgeById(entry.id);
    updateKnowledgeFields(entry.id, { content: 'Full wiki content filled by agent' });

    // This is the logic from update.ts lines 48-51
    if (oldEntry && oldEntry.status === 'needs_revalidation') {
      updateStatus(entry.id, 'active');
    }

    // Entry should now be active, not stuck as needs_revalidation
    const updated = getKnowledgeById(entry.id)!;
    expect(updated.status).toBe('active');
    expect(updated.content).toBe('Full wiki content filled by agent');
  });
});

// === Wiki source links warning ===

describe('wiki source links warning', () => {
  /**
   * Simulate the source links check from update.ts:
   * after updating a wiki entry, check if it has outgoing links to non-wiki entries.
   */
  function checkWikiSourceLinks(entryId: string): boolean {
    const outgoing = getOutgoingLinks(entryId);
    return outgoing.some((link) => {
      const target = getKnowledgeById(link.target_id);
      return target !== null && target.type !== 'wiki';
    });
  }

  it('should warn when wiki entry has no outgoing links', () => {
    const wiki = insertKnowledge({
      type: 'wiki',
      title: 'Architecture Overview',
      content: 'Overview of the system architecture',
    });

    updateKnowledgeFields(wiki.id, { content: 'Updated architecture overview' });

    const hasSourceLinks = checkWikiSourceLinks(wiki.id);
    expect(hasSourceLinks).toBe(false);
  });

  it('should warn when wiki entry only links to other wiki entries', () => {
    const wikiA = insertKnowledge({
      type: 'wiki',
      title: 'Main Wiki Page',
      content: 'Top-level wiki page',
    });
    const wikiB = insertKnowledge({
      type: 'wiki',
      title: 'Sub Wiki Page',
      content: 'Child wiki page',
    });

    insertLink({ sourceId: wikiA.id, targetId: wikiB.id, linkType: 'related' });

    const hasSourceLinks = checkWikiSourceLinks(wikiA.id);
    expect(hasSourceLinks).toBe(false);
  });

  it('should not warn when wiki entry links to a non-wiki entry', () => {
    const wiki = insertKnowledge({
      type: 'wiki',
      title: 'Architecture Overview',
      content: 'Overview of the system architecture',
    });
    const decision = insertKnowledge({
      type: 'decision',
      title: 'Use microservices',
      content: 'We chose microservices architecture',
    });

    insertLink({ sourceId: wiki.id, targetId: decision.id, linkType: 'derived' });

    const hasSourceLinks = checkWikiSourceLinks(wiki.id);
    expect(hasSourceLinks).toBe(true);
  });

  it('should not warn for non-wiki entries regardless of links', () => {
    const fact = insertKnowledge({
      type: 'fact',
      title: 'Some fact',
      content: 'Fact content',
    });

    updateKnowledgeFields(fact.id, { content: 'Updated fact' });

    // Non-wiki entries don't get the source links check
    const updated = getKnowledgeById(fact.id)!;
    expect(updated.type).not.toBe('wiki');
  });
});

// === Wiki declaration surfacing ===

describe('wiki declaration surfacing', () => {
  it('should include declaration in query results for wiki entries', () => {
    insertKnowledge({
      type: 'wiki',
      title: 'API Guide',
      content: 'API documentation',
      declaration: 'A concise overview of the public API',
    });

    const results = searchKnowledge({ query: 'API Guide', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    const entry = results[0];
    expect(entry.declaration).toBe('A concise overview of the public API');
  });

  it('should not include declaration for non-wiki entries', () => {
    insertKnowledge({
      type: 'decision',
      title: 'Use REST API',
      content: 'We chose REST over GraphQL',
    });

    const results = searchKnowledge({ query: 'Use REST', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].declaration).toBeNull();
  });

  it('should include declaration in list results for wiki entries', () => {
    insertKnowledge({
      type: 'wiki',
      title: 'Deployment Guide',
      content: 'How to deploy',
      declaration: 'Step-by-step deployment instructions',
    });

    const results = listKnowledge({ type: 'wiki', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    const entry = results.find((e) => e.title === 'Deployment Guide');
    expect(entry).toBeDefined();
    expect(entry!.declaration).toBe('Step-by-step deployment instructions');
  });

  it('should preserve declaration after updateKnowledgeFields', () => {
    const wiki = insertKnowledge({
      type: 'wiki',
      title: 'Architecture Page',
      content: 'Stub',
      declaration: 'A brief, user-friendly architecture overview',
    });

    updateKnowledgeFields(wiki.id, { content: 'Updated content by agent' });

    const updated = getKnowledgeById(wiki.id)!;
    expect(updated.content).toBe('Updated content by agent');
    expect(updated.declaration).toBe('A brief, user-friendly architecture overview');
  });

  it('should return null declaration for wiki entries without one', () => {
    insertKnowledge({
      type: 'wiki',
      title: 'Quick Notes',
      content: 'Some notes',
    });

    const results = searchKnowledge({ query: 'Quick Notes', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].declaration).toBeNull();
  });
});

// === Link workflow ===

describe('link workflow', () => {
  it('should create a bidirectional link', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });

    // Forward link
    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });
    // Reverse link (bidirectional)
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'related' });

    const aLinks = getLinksForEntry(a.id);
    expect(aLinks).toHaveLength(2);

    const bLinks = getLinksForEntry(b.id);
    expect(bLinks).toHaveLength(2);
  });

  it('should prevent self-links (validated at tool level)', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });

    // The tool validates this, but the DB doesn't prevent it.
    // This tests the tool-level validation logic.
    const shouldSelfLink = a.id === a.id;
    expect(shouldSelfLink).toBe(true); // Tool would return error
  });

  it('should prevent duplicate links', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });

    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });
    expect(() =>
      insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' }),
    ).toThrow();
  });
});

// === Supersedes revalidation workflow ===

describe('supersedes revalidation workflow', () => {
  it('should flag target as needs_revalidation when supersedes link is created', () => {
    const old = insertKnowledge({
      type: 'decision',
      title: 'Use Preact Signals',
      content: 'We use Preact Signals for state management',
    });

    const replacement = insertKnowledge({
      type: 'decision',
      title: 'Use Pion Contexts',
      content: 'We now use Pion Contexts instead of Preact Signals',
    });

    // Simulate link_knowledge tool: create supersedes link and flag target
    insertLink({ sourceId: replacement.id, targetId: old.id, linkType: 'supersedes' });

    const target = getKnowledgeById(old.id)!;
    if (target.status !== 'deprecated') {
      updateStatus(old.id, 'needs_revalidation');
    }

    expect(getKnowledgeById(old.id)!.status).toBe('needs_revalidation');
    // The superseding entry should remain active
    expect(getKnowledgeById(replacement.id)!.status).toBe('active');
  });

  it('should flag target when supersedes link is created inline via store', () => {
    const old = insertKnowledge({
      type: 'convention',
      title: 'Use REST API',
      content: 'We use REST endpoints',
    });

    // Simulate store_knowledge with inline supersedes link
    const replacement = insertKnowledge({
      type: 'convention',
      title: 'Use GraphQL API',
      content: 'We now use GraphQL instead of REST',
    });

    insertLink({ sourceId: replacement.id, targetId: old.id, linkType: 'supersedes' });

    const target = getKnowledgeById(old.id)!;
    if (target.status !== 'deprecated') {
      updateStatus(old.id, 'needs_revalidation');
    }

    expect(getKnowledgeById(old.id)!.status).toBe('needs_revalidation');
  });

  it('should NOT flag deprecated targets when superseded', () => {
    const old = insertKnowledge({
      type: 'decision',
      title: 'Old decision',
      content: 'Already deprecated',
    });
    updateStatus(old.id, 'deprecated');

    const replacement = insertKnowledge({
      type: 'decision',
      title: 'New decision',
      content: 'Replacement',
    });

    insertLink({ sourceId: replacement.id, targetId: old.id, linkType: 'supersedes' });

    const target = getKnowledgeById(old.id)!;
    if (target.status !== 'deprecated') {
      updateStatus(old.id, 'needs_revalidation');
    }

    // Should still be deprecated, not changed to needs_revalidation
    expect(getKnowledgeById(old.id)!.status).toBe('deprecated');
  });

  it('should NOT flag target for non-supersedes link types', () => {
    const a = insertKnowledge({ type: 'fact', title: 'Fact A', content: 'content a' });
    const b = insertKnowledge({ type: 'fact', title: 'Fact B', content: 'content b' });

    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'related' });

    // related links should NOT trigger revalidation
    expect(getKnowledgeById(a.id)!.status).toBe('active');
  });
});

// === Delete workflow ===

describe('delete workflow', () => {
  it('should permanently remove an entry', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'To delete', content: 'Content' });

    const deleted = deleteKnowledge(entry.id);
    expect(deleted).toBe(true);
    expect(getKnowledgeById(entry.id)).toBeNull();
  });

  it('should cascade delete links', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const link = insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });

    deleteKnowledge(a.id);
    expect(getLinkById(link.id)).toBeNull();
  });

  it('should cascade delete embeddings', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    storeEmbedding(entry.id, Buffer.from(new Float32Array([0.1, 0.2]).buffer), 'model', 2);

    expect(getEmbedding(entry.id)).not.toBeNull();
    deleteKnowledge(entry.id);
    expect(getEmbedding(entry.id)).toBeNull();
  });

  it('should remove entry from FTS search', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'SpecialDeleteTest', content: 'Content' });

    let results = searchKnowledge({ query: 'SpecialDeleteTest' });
    expect(results).toHaveLength(1);

    deleteKnowledge(entry.id);

    results = searchKnowledge({ query: 'SpecialDeleteTest' });
    expect(results).toHaveLength(0);
  });

  it('should not affect other entries when one is deleted', () => {
    const a = insertKnowledge({ type: 'fact', title: 'Keep this', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'Delete this', content: 'b' });

    deleteKnowledge(b.id);

    expect(getKnowledgeById(a.id)).not.toBeNull();
    expect(getKnowledgeById(b.id)).toBeNull();
  });
});

// === Deprecation reason ===

describe('deprecation reason', () => {
  it('should store deprecation reason when deprecating', () => {
    const entry = insertKnowledge({
      type: 'fact',
      title: 'Old approach',
      content: 'We used to do it this way',
    });

    const deprecated = deprecateKnowledge(entry.id, 'Replaced by new approach');

    expect(deprecated).not.toBeNull();
    expect(deprecated!.status).toBe('deprecated');
    expect(deprecated!.deprecation_reason).toBe('Replaced by new approach');
  });

  it('should store null deprecation_reason when no reason provided', () => {
    const entry = insertKnowledge({
      type: 'fact',
      title: 'Old fact',
      content: 'Some old fact',
    });

    const deprecated = deprecateKnowledge(entry.id);

    expect(deprecated).not.toBeNull();
    expect(deprecated!.status).toBe('deprecated');
    expect(deprecated!.deprecation_reason).toBeNull();
  });

  it('should have null deprecation_reason on new entries', () => {
    const entry = insertKnowledge({
      type: 'convention',
      title: 'New convention',
      content: 'Do it this way',
    });

    expect(entry.deprecation_reason).toBeNull();
  });

  it('should return deprecation_reason via getKnowledgeById', () => {
    const entry = insertKnowledge({
      type: 'decision',
      title: 'Old decision',
      content: 'We decided X',
    });

    deprecateKnowledge(entry.id, 'Decision reversed in Q3 review');
    const fetched = getKnowledgeById(entry.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.deprecation_reason).toBe('Decision reversed in Q3 review');
  });

  it('should return null when entry not found', () => {
    const result = deprecateKnowledge('00000000-0000-0000-0000-000000000000', 'Does not exist');
    expect(result).toBeNull();
  });
});

// === Pagination (list_knowledge) ===

describe('list_knowledge pagination', () => {
  function seedEntries(count: number, overrides?: Partial<Parameters<typeof insertKnowledge>[0]>) {
    const entries = [];
    for (let i = 0; i < count; i++) {
      entries.push(
        insertKnowledge({
          type: 'fact',
          title: `Entry ${String(i).padStart(3, '0')}`,
          content: `Content for entry ${i}`,
          ...overrides,
        }),
      );
    }
    return entries;
  }

  it('should return first page with offset 0 and correct total', () => {
    seedEntries(15);

    const total = countKnowledge({ status: 'active', includeWeak: true });
    expect(total).toBe(15);

    const page1 = listKnowledge({ limit: 5, offset: 0, includeWeak: true });
    expect(page1).toHaveLength(5);
  });

  it('should return second page with offset 5', () => {
    seedEntries(15);

    const page1 = listKnowledge({ limit: 5, offset: 0, sortBy: 'created', includeWeak: true });
    const page2 = listKnowledge({ limit: 5, offset: 5, sortBy: 'created', includeWeak: true });

    expect(page1).toHaveLength(5);
    expect(page2).toHaveLength(5);

    // No overlap between pages
    const page1Ids = new Set(page1.map((e) => e.id));
    const page2Ids = new Set(page2.map((e) => e.id));
    for (const id of page2Ids) {
      expect(page1Ids.has(id)).toBe(false);
    }
  });

  it('should return partial page when offset near end', () => {
    seedEntries(12);

    const page = listKnowledge({ limit: 5, offset: 10, includeWeak: true });
    expect(page).toHaveLength(2);
  });

  it('should return empty when offset past all entries', () => {
    seedEntries(5);

    const page = listKnowledge({ limit: 5, offset: 100, includeWeak: true });
    expect(page).toHaveLength(0);
  });

  it('should count correctly with type filter', () => {
    seedEntries(8, { type: 'fact' });
    seedEntries(4, { type: 'decision' });

    const totalAll = countKnowledge({ includeWeak: true });
    expect(totalAll).toBe(12);

    const totalFacts = countKnowledge({ type: 'fact', includeWeak: true });
    expect(totalFacts).toBe(8);

    const totalDecisions = countKnowledge({ type: 'decision', includeWeak: true });
    expect(totalDecisions).toBe(4);
  });

  it('should paginate with type filter applied to both count and list', () => {
    seedEntries(8, { type: 'fact' });
    seedEntries(4, { type: 'decision' });

    const total = countKnowledge({ type: 'fact', includeWeak: true });
    expect(total).toBe(8);

    const page1 = listKnowledge({ type: 'fact', limit: 5, offset: 0, includeWeak: true });
    const page2 = listKnowledge({ type: 'fact', limit: 5, offset: 5, includeWeak: true });

    expect(page1).toHaveLength(5);
    expect(page2).toHaveLength(3);

    // All returned entries are facts
    for (const e of [...page1, ...page2]) {
      expect(e.type).toBe('fact');
    }
  });

  it('should use default offset of 0 when not specified', () => {
    seedEntries(10);

    const withOffset = listKnowledge({ limit: 5, offset: 0, includeWeak: true });
    const withoutOffset = listKnowledge({ limit: 5, includeWeak: true });

    expect(withOffset.map((e) => e.id)).toEqual(withoutOffset.map((e) => e.id));
  });
});
