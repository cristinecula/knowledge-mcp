import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers.js';
import {
  insertKnowledge,
  getKnowledgeById,
  updateKnowledgeFields,
  updateStrength,
  updateStatus,
  recordAccess,
  searchKnowledge,
  listKnowledge,
  getAllEntries,
  getAllActiveEntries,
  insertLink,
  getLinkById,
  getLinksForEntry,
  getOutgoingLinks,
  getIncomingLinks,
  getLinkedEntries,
  deleteLink,
  deleteKnowledge,
  storeEmbedding,
  getEmbedding,
  getAllEmbeddings,
  deleteEmbedding,
  getGraphData,
} from '../db/queries.js';

beforeEach(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

// === Knowledge CRUD ===

describe('insertKnowledge', () => {
  it('should insert and return a knowledge entry with defaults', () => {
    const entry = insertKnowledge({
      type: 'fact',
      title: 'Test fact',
      content: 'Some content',
    });

    expect(entry.id).toBeDefined();
    expect(entry.type).toBe('fact');
    expect(entry.title).toBe('Test fact');
    expect(entry.content).toBe('Some content');
    expect(entry.tags).toEqual([]);
    expect(entry.project).toBeNull();
    expect(entry.scope).toBe('company');
    expect(entry.source).toBe('unknown');
    expect(entry.strength).toBe(1.0);
    expect(entry.status).toBe('active');
    expect(entry.access_count).toBe(0);
  });

  it('should insert with all optional fields', () => {
    const entry = insertKnowledge({
      type: 'convention',
      title: 'Naming convention',
      content: 'Use camelCase',
      tags: ['style', 'naming'],
      project: 'my-project',
      scope: 'repo',
      source: 'alice',
    });

    expect(entry.tags).toEqual(['style', 'naming']);
    expect(entry.project).toBe('my-project');
    expect(entry.scope).toBe('repo');
    expect(entry.source).toBe('alice');
  });

  it('should generate unique IDs', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('getKnowledgeById', () => {
  it('should return entry by ID', () => {
    const inserted = insertKnowledge({
      type: 'fact',
      title: 'Test',
      content: 'Content',
    });
    const found = getKnowledgeById(inserted.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(inserted.id);
    expect(found!.title).toBe('Test');
  });

  it('should return null for nonexistent ID', () => {
    const found = getKnowledgeById('nonexistent-id');
    expect(found).toBeNull();
  });
});

describe('updateKnowledgeFields', () => {
  it('should update title', () => {
    const entry = insertKnowledge({
      type: 'fact',
      title: 'Old title',
      content: 'Content',
    });

    const updated = updateKnowledgeFields(entry.id, { title: 'New title' });
    expect(updated!.title).toBe('New title');
    expect(updated!.content).toBe('Content'); // unchanged
  });

  it('should update multiple fields at once', () => {
    const entry = insertKnowledge({
      type: 'fact',
      title: 'Title',
      content: 'Content',
      tags: ['old'],
    });

    const updated = updateKnowledgeFields(entry.id, {
      content: 'New content',
      tags: ['new', 'tags'],
      type: 'convention',
      scope: 'project',
    });

    expect(updated!.content).toBe('New content');
    expect(updated!.tags).toEqual(['new', 'tags']);
    expect(updated!.type).toBe('convention');
    expect(updated!.scope).toBe('project');
  });

  it('should set the updated_at timestamp', () => {
    const entry = insertKnowledge({
      type: 'fact',
      title: 'Title',
      content: 'Content',
    });

    const updated = updateKnowledgeFields(entry.id, { title: 'New' });
    // updated_at should be a valid ISO timestamp
    expect(updated!.updated_at).toBeTruthy();
    expect(new Date(updated!.updated_at).getTime()).not.toBeNaN();
    // updated_at should be >= created_at
    expect(new Date(updated!.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(entry.created_at).getTime(),
    );
  });
});

describe('updateStrength', () => {
  it('should update strength value', () => {
    const entry = insertKnowledge({
      type: 'fact',
      title: 'Test',
      content: 'Content',
    });
    expect(entry.strength).toBe(1.0);

    updateStrength(entry.id, 0.75);
    const found = getKnowledgeById(entry.id);
    expect(found!.strength).toBe(0.75);
  });
});

describe('updateStatus', () => {
  it('should update status', () => {
    const entry = insertKnowledge({
      type: 'fact',
      title: 'Test',
      content: 'Content',
    });

    updateStatus(entry.id, 'deprecated');
    const found = getKnowledgeById(entry.id);
    expect(found!.status).toBe('deprecated');
  });
});

describe('recordAccess', () => {
  it('should increment access count by default boost of 1', () => {
    const entry = insertKnowledge({
      type: 'fact',
      title: 'Test',
      content: 'Content',
    });
    expect(entry.access_count).toBe(0);

    recordAccess(entry.id);
    const found = getKnowledgeById(entry.id);
    expect(found!.access_count).toBe(1);
  });

  it('should increment by custom boost', () => {
    const entry = insertKnowledge({
      type: 'fact',
      title: 'Test',
      content: 'Content',
    });

    recordAccess(entry.id, 3);
    const found = getKnowledgeById(entry.id);
    expect(found!.access_count).toBe(3);
  });

  it('should set last_accessed_at to a valid timestamp', () => {
    const entry = insertKnowledge({
      type: 'fact',
      title: 'Test',
      content: 'Content',
    });

    recordAccess(entry.id);
    const found = getKnowledgeById(entry.id)!;
    // last_accessed_at should be a valid ISO timestamp
    expect(found.last_accessed_at).toBeTruthy();
    expect(new Date(found.last_accessed_at).getTime()).not.toBeNaN();
    // Should be >= created_at
    expect(new Date(found.last_accessed_at).getTime()).toBeGreaterThanOrEqual(
      new Date(entry.created_at).getTime(),
    );
  });
});

// === Search ===

describe('searchKnowledge (FTS)', () => {
  it('should find entries by title text', () => {
    insertKnowledge({ type: 'fact', title: 'React hooks guide', content: 'Use hooks for state' });
    insertKnowledge({ type: 'fact', title: 'SQL optimization', content: 'Use indexes' });

    const results = searchKnowledge({ query: 'React' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('React hooks guide');
  });

  it('should find entries by content text', () => {
    insertKnowledge({ type: 'fact', title: 'Guide', content: 'Use PostgreSQL for relational data' });
    insertKnowledge({ type: 'fact', title: 'Other', content: 'Use Redis for caching' });

    const results = searchKnowledge({ query: 'PostgreSQL' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Guide');
  });

  it('should return empty for no matches', () => {
    insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    const results = searchKnowledge({ query: 'nonexistent' });
    expect(results).toHaveLength(0);
  });

  it('should respect limit', () => {
    for (let i = 0; i < 20; i++) {
      insertKnowledge({ type: 'fact', title: `Entry ${i}`, content: 'common keyword' });
    }

    const results = searchKnowledge({ query: 'common', limit: 5 });
    expect(results).toHaveLength(5);
  });
});

describe('searchKnowledge (filters)', () => {
  it('should filter by type', () => {
    insertKnowledge({ type: 'fact', title: 'A', content: 'test' });
    insertKnowledge({ type: 'convention', title: 'B', content: 'test' });

    const results = searchKnowledge({ query: 'test', type: 'convention' });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('convention');
  });

  it('should filter by project', () => {
    insertKnowledge({ type: 'fact', title: 'A', content: 'test', project: 'proj-a' });
    insertKnowledge({ type: 'fact', title: 'B', content: 'test', project: 'proj-b' });

    const results = searchKnowledge({ query: 'test', project: 'proj-a' });
    expect(results).toHaveLength(1);
    expect(results[0].project).toBe('proj-a');
  });

  it('should filter by scope with inheritance (repo gets repo+project+company)', () => {
    insertKnowledge({ type: 'fact', title: 'Company', content: 'test', scope: 'company' });
    insertKnowledge({ type: 'fact', title: 'Project', content: 'test', scope: 'project' });
    insertKnowledge({ type: 'fact', title: 'Repo', content: 'test', scope: 'repo' });

    const results = searchKnowledge({ query: 'test', scope: 'repo' });
    expect(results).toHaveLength(3);
  });

  it('should filter by scope (company gets only company)', () => {
    insertKnowledge({ type: 'fact', title: 'Company', content: 'test', scope: 'company' });
    insertKnowledge({ type: 'fact', title: 'Repo', content: 'test', scope: 'repo' });

    const results = searchKnowledge({ query: 'test', scope: 'company' });
    expect(results).toHaveLength(1);
    expect(results[0].scope).toBe('company');
  });

  it('should filter by tags (all tags must match)', () => {
    insertKnowledge({ type: 'fact', title: 'A', content: 'test', tags: ['react', 'auth'] });
    insertKnowledge({ type: 'fact', title: 'B', content: 'test', tags: ['react', 'api'] });
    insertKnowledge({ type: 'fact', title: 'C', content: 'test', tags: ['vue'] });

    const results = searchKnowledge({ query: 'test', tags: ['react', 'auth'] });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('A');
  });

  it('should exclude weak entries by default (strength < 0.5)', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Weak', content: 'test' });
    updateStrength(entry.id, 0.3);

    const results = searchKnowledge({ query: 'test' });
    expect(results).toHaveLength(0);

    const resultsWithWeak = searchKnowledge({ query: 'test', includeWeak: true });
    expect(resultsWithWeak).toHaveLength(1);
  });

  it('should exclude dormant entries by default', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Dormant', content: 'test' });
    updateStatus(entry.id, 'dormant');

    const results = searchKnowledge({ query: 'test' });
    expect(results).toHaveLength(0);
  });
});

describe('listKnowledge', () => {
  it('should list entries without a search query', () => {
    insertKnowledge({ type: 'fact', title: 'A', content: 'Content A' });
    insertKnowledge({ type: 'convention', title: 'B', content: 'Content B' });

    const results = listKnowledge({});
    expect(results).toHaveLength(2);
  });

  it('should respect filters', () => {
    insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    insertKnowledge({ type: 'convention', title: 'B', content: 'Content' });

    const results = listKnowledge({ type: 'fact' });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('fact');
  });
});

describe('getAllEntries', () => {
  it('should return all entries regardless of status', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    updateStatus(a.id, 'deprecated');

    const all = getAllEntries();
    expect(all).toHaveLength(2);
  });
});

describe('getAllActiveEntries', () => {
  it('should return active and needs_revalidation entries', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    insertKnowledge({ type: 'fact', title: 'C', content: 'c' });

    updateStatus(a.id, 'deprecated');
    updateStatus(b.id, 'needs_revalidation');

    const active = getAllActiveEntries();
    expect(active).toHaveLength(2); // B (needs_revalidation) and C (active)
  });
});

// === Links ===

describe('insertLink', () => {
  it('should create a link between two entries', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });

    const link = insertLink({
      sourceId: a.id,
      targetId: b.id,
      linkType: 'related',
      description: 'A relates to B',
    });

    expect(link.id).toBeDefined();
    expect(link.source_id).toBe(a.id);
    expect(link.target_id).toBe(b.id);
    expect(link.link_type).toBe('related');
    expect(link.description).toBe('A relates to B');
  });

  it('should enforce unique constraint (source, target, type)', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });

    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });
    expect(() =>
      insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' }),
    ).toThrow();
  });

  it('should allow different link types between same entries', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });

    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });
    const link2 = insertLink({ sourceId: a.id, targetId: b.id, linkType: 'depends' });
    expect(link2.link_type).toBe('depends');
  });
});

describe('getLinksForEntry', () => {
  it('should return both incoming and outgoing links', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'c' });

    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });
    insertLink({ sourceId: c.id, targetId: a.id, linkType: 'depends' });

    const links = getLinksForEntry(a.id);
    expect(links).toHaveLength(2);
  });
});

describe('getOutgoingLinks', () => {
  it('should return only outgoing links', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'c' });

    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });
    insertLink({ sourceId: c.id, targetId: a.id, linkType: 'depends' });

    const outgoing = getOutgoingLinks(a.id);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].target_id).toBe(b.id);
  });

  it('should filter by link types', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'c' });

    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });
    insertLink({ sourceId: a.id, targetId: c.id, linkType: 'depends' });

    const deps = getOutgoingLinks(a.id, ['depends']);
    expect(deps).toHaveLength(1);
    expect(deps[0].link_type).toBe('depends');
  });
});

describe('getIncomingLinks', () => {
  it('should return only incoming links', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'c' });

    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });
    insertLink({ sourceId: c.id, targetId: b.id, linkType: 'depends' });

    const incoming = getIncomingLinks(b.id);
    expect(incoming).toHaveLength(2);
  });

  it('should filter by link types', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'c' });

    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });
    insertLink({ sourceId: c.id, targetId: b.id, linkType: 'depends' });

    const deps = getIncomingLinks(b.id, ['depends']);
    expect(deps).toHaveLength(1);
    expect(deps[0].source_id).toBe(c.id);
  });
});

describe('getLinkedEntries', () => {
  it('should return linked entries (not the entry itself)', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'c' });

    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });
    insertLink({ sourceId: c.id, targetId: a.id, linkType: 'depends' });

    const linked = getLinkedEntries(a.id);
    expect(linked).toHaveLength(2);
    const linkedIds = linked.map((e) => e.id);
    expect(linkedIds).toContain(b.id);
    expect(linkedIds).toContain(c.id);
    expect(linkedIds).not.toContain(a.id);
  });
});

describe('deleteLink', () => {
  it('should delete a link and return true', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const link = insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });

    const deleted = deleteLink(link.id);
    expect(deleted).toBe(true);
    expect(getLinkById(link.id)).toBeNull();
  });

  it('should return false for nonexistent link', () => {
    expect(deleteLink('nonexistent')).toBe(false);
  });
});

// === Delete Knowledge (with CASCADE) ===

describe('deleteKnowledge', () => {
  it('should delete an entry and return true', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    const deleted = deleteKnowledge(entry.id);
    expect(deleted).toBe(true);
    expect(getKnowledgeById(entry.id)).toBeNull();
  });

  it('should return false for nonexistent entry', () => {
    expect(deleteKnowledge('nonexistent')).toBe(false);
  });

  it('should cascade delete links when entry is deleted', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const link = insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });

    deleteKnowledge(a.id);

    // Link should be gone
    expect(getLinkById(link.id)).toBeNull();
    // B should still exist
    expect(getKnowledgeById(b.id)).not.toBeNull();
  });

  it('should cascade delete links when target entry is deleted', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const link = insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });

    deleteKnowledge(b.id);
    expect(getLinkById(link.id)).toBeNull();
    expect(getKnowledgeById(a.id)).not.toBeNull();
  });

  it('should cascade delete embeddings when entry is deleted', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    const fakeEmbedding = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    storeEmbedding(entry.id, fakeEmbedding, 'test-model', 3);

    expect(getEmbedding(entry.id)).not.toBeNull();

    deleteKnowledge(entry.id);
    expect(getEmbedding(entry.id)).toBeNull();
  });

  it('should remove entry from FTS index after deletion', () => {
    insertKnowledge({ type: 'fact', title: 'UniqueSearchTerm', content: 'Content' });

    // Verify it's searchable
    let results = searchKnowledge({ query: 'UniqueSearchTerm' });
    expect(results).toHaveLength(1);

    deleteKnowledge(results[0].id);

    // Should no longer be searchable
    results = searchKnowledge({ query: 'UniqueSearchTerm' });
    expect(results).toHaveLength(0);
  });
});

// === Embeddings ===

describe('storeEmbedding', () => {
  it('should store and retrieve an embedding', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    const vec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const buf = Buffer.from(vec.buffer);

    storeEmbedding(entry.id, buf, 'test-model', 4);

    const stored = getEmbedding(entry.id);
    expect(stored).not.toBeNull();
    expect(stored!.model).toBe('test-model');
    expect(stored!.dimensions).toBe(4);
  });

  it('should replace existing embedding (UPSERT)', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });

    storeEmbedding(entry.id, Buffer.from(new Float32Array([0.1]).buffer), 'model-a', 1);
    storeEmbedding(entry.id, Buffer.from(new Float32Array([0.2]).buffer), 'model-b', 1);

    const stored = getEmbedding(entry.id);
    expect(stored!.model).toBe('model-b');
  });
});

describe('getAllEmbeddings', () => {
  it('should return all stored embeddings', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });

    storeEmbedding(a.id, Buffer.from(new Float32Array([0.1]).buffer), 'model', 1);
    storeEmbedding(b.id, Buffer.from(new Float32Array([0.2]).buffer), 'model', 1);

    const all = getAllEmbeddings();
    expect(all).toHaveLength(2);
  });
});

describe('deleteEmbedding', () => {
  it('should delete an embedding', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    storeEmbedding(entry.id, Buffer.from(new Float32Array([0.1]).buffer), 'model', 1);

    deleteEmbedding(entry.id);
    expect(getEmbedding(entry.id)).toBeNull();
  });
});

// === Graph data ===

describe('getGraphData', () => {
  it('should return nodes and links', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a', tags: ['tag1'] });
    const b = insertKnowledge({ type: 'convention', title: 'B', content: 'b' });
    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });

    const graph = getGraphData();
    expect(graph.nodes).toHaveLength(2);
    expect(graph.links).toHaveLength(1);

    const nodeA = graph.nodes.find((n) => n.id === a.id);
    expect(nodeA).toBeDefined();
    expect(nodeA!.title).toBe('A');
    expect(nodeA!.type).toBe('fact');
    expect(nodeA!.tags).toEqual(['tag1']);

    expect(graph.links[0].source).toBe(a.id);
    expect(graph.links[0].target).toBe(b.id);
    expect(graph.links[0].link_type).toBe('related');
  });
});

// === Wiki type and declaration field ===

describe('wiki knowledge type', () => {
  it('should insert a wiki entry with declaration', () => {
    const entry = insertKnowledge({
      type: 'wiki',
      title: 'Architecture Overview',
      content: '',
      declaration: 'Write a comprehensive overview of our system architecture',
    });

    expect(entry.type).toBe('wiki');
    expect(entry.declaration).toBe('Write a comprehensive overview of our system architecture');
    expect(entry.content).toBe('');
  });

  it('should default declaration to null when not provided', () => {
    const entry = insertKnowledge({
      type: 'wiki',
      title: 'No declaration wiki',
      content: 'Some content',
    });

    expect(entry.declaration).toBeNull();
  });

  it('should search wiki entries by type filter', () => {
    insertKnowledge({ type: 'wiki', title: 'Wiki Page', content: 'wiki test content' });
    insertKnowledge({ type: 'fact', title: 'Regular Fact', content: 'fact test content' });

    const results = searchKnowledge({ query: 'test', type: 'wiki' });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('wiki');
    expect(results[0].title).toBe('Wiki Page');
  });

  it('should list wiki entries by type filter', () => {
    insertKnowledge({ type: 'wiki', title: 'Wiki A', content: 'a' });
    insertKnowledge({ type: 'wiki', title: 'Wiki B', content: 'b' });
    insertKnowledge({ type: 'fact', title: 'Fact C', content: 'c' });

    const results = listKnowledge({ type: 'wiki' });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.type === 'wiki')).toBe(true);
  });

  it('should include needs_revalidation wiki entries in default list', () => {
    const wiki = insertKnowledge({ type: 'wiki', title: 'Wiki Page', content: 'content' });
    updateStatus(wiki.id, 'needs_revalidation');

    // Default (no status) should include needs_revalidation
    const defaultResults = listKnowledge({ type: 'wiki' });
    expect(defaultResults).toHaveLength(1);
    expect(defaultResults[0].status).toBe('needs_revalidation');

    // Explicit status: 'active' should exclude needs_revalidation
    const activeOnly = listKnowledge({ type: 'wiki', status: 'active' });
    expect(activeOnly).toHaveLength(0);

    // Explicit status: 'needs_revalidation' should include it
    const revalOnly = listKnowledge({ type: 'wiki', status: 'needs_revalidation' });
    expect(revalOnly).toHaveLength(1);
  });
});

describe('declaration field', () => {
  it('should update declaration via updateKnowledgeFields', () => {
    const entry = insertKnowledge({
      type: 'wiki',
      title: 'Wiki Page',
      content: '',
      declaration: 'Original prompt',
    });

    const updated = updateKnowledgeFields(entry.id, {
      declaration: 'Updated prompt with more detail',
    });

    expect(updated!.declaration).toBe('Updated prompt with more detail');
    expect(updated!.title).toBe('Wiki Page'); // unchanged
  });

  it('should clear declaration by setting to null', () => {
    const entry = insertKnowledge({
      type: 'wiki',
      title: 'Wiki Page',
      content: '',
      declaration: 'Some prompt',
    });

    const updated = updateKnowledgeFields(entry.id, { declaration: null });
    expect(updated!.declaration).toBeNull();
  });

  it('should not affect declaration when updating other fields', () => {
    const entry = insertKnowledge({
      type: 'wiki',
      title: 'Wiki Page',
      content: '',
      declaration: 'Keep this prompt',
    });

    const updated = updateKnowledgeFields(entry.id, { title: 'New Title' });
    expect(updated!.title).toBe('New Title');
    expect(updated!.declaration).toBe('Keep this prompt');
  });

  it('should include declaration in getGraphData nodes', () => {
    insertKnowledge({
      type: 'wiki',
      title: 'Wiki With Declaration',
      content: 'Agent-filled content',
      declaration: 'Describe the auth system',
    });
    insertKnowledge({
      type: 'fact',
      title: 'Regular Fact',
      content: 'Content',
    });

    const graph = getGraphData();
    const wikiNode = graph.nodes.find((n) => n.type === 'wiki');
    const factNode = graph.nodes.find((n) => n.type === 'fact');

    expect(wikiNode).toBeDefined();
    expect(wikiNode!.declaration).toBe('Describe the auth system');
    expect(factNode).toBeDefined();
    expect(factNode!.declaration).toBeNull();
  });

  it('should persist declaration through delete and re-insert', () => {
    const entry = insertKnowledge({
      type: 'wiki',
      title: 'Deletable Wiki',
      content: '',
      declaration: 'A prompt',
    });

    deleteKnowledge(entry.id);
    expect(getKnowledgeById(entry.id)).toBeNull();

    // Re-insert with same declaration
    const reinserted = insertKnowledge({
      type: 'wiki',
      title: 'Deletable Wiki',
      content: '',
      declaration: 'A prompt',
    });
    expect(reinserted.declaration).toBe('A prompt');
  });
});

describe('parent_page_id field', () => {
  it('should default parent_page_id to null', () => {
    const entry = insertKnowledge({
      type: 'wiki',
      title: 'Root Wiki Page',
      content: 'Top-level page',
    });

    expect(entry.parent_page_id).toBeNull();
  });

  it('should store parent_page_id on insert', () => {
    const parent = insertKnowledge({
      type: 'wiki',
      title: 'Parent Page',
      content: 'Parent content',
    });

    const child = insertKnowledge({
      type: 'wiki',
      title: 'Child Page',
      content: 'Child content',
      parentPageId: parent.id,
    });

    expect(child.parent_page_id).toBe(parent.id);
  });

  it('should update parent_page_id via updateKnowledgeFields', () => {
    const parent = insertKnowledge({
      type: 'wiki',
      title: 'Parent Page',
      content: '',
    });

    const child = insertKnowledge({
      type: 'wiki',
      title: 'Child Page',
      content: '',
    });

    const updated = updateKnowledgeFields(child.id, {
      parentPageId: parent.id,
    });

    expect(updated!.parent_page_id).toBe(parent.id);
  });

  it('should clear parent_page_id by setting to null', () => {
    const parent = insertKnowledge({
      type: 'wiki',
      title: 'Parent',
      content: '',
    });

    const child = insertKnowledge({
      type: 'wiki',
      title: 'Child',
      content: '',
      parentPageId: parent.id,
    });

    expect(child.parent_page_id).toBe(parent.id);

    const updated = updateKnowledgeFields(child.id, { parentPageId: null });
    expect(updated!.parent_page_id).toBeNull();
  });

  it('should not affect parent_page_id when updating other fields', () => {
    const parent = insertKnowledge({
      type: 'wiki',
      title: 'Parent',
      content: '',
    });

    const child = insertKnowledge({
      type: 'wiki',
      title: 'Child',
      content: '',
      parentPageId: parent.id,
    });

    const updated = updateKnowledgeFields(child.id, { title: 'Renamed Child' });
    expect(updated!.title).toBe('Renamed Child');
    expect(updated!.parent_page_id).toBe(parent.id);
  });

  it('should include parent_page_id in getGraphData nodes', () => {
    const parent = insertKnowledge({
      type: 'wiki',
      title: 'Graph Parent',
      content: '',
    });

    insertKnowledge({
      type: 'wiki',
      title: 'Graph Child',
      content: '',
      parentPageId: parent.id,
    });

    const graph = getGraphData();
    const parentNode = graph.nodes.find((n) => n.title === 'Graph Parent');
    const childNode = graph.nodes.find((n) => n.title === 'Graph Child');

    expect(parentNode!.parent_page_id).toBeNull();
    expect(childNode!.parent_page_id).toBe(parent.id);
  });
});
