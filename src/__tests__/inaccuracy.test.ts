import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers.js';
import {
  insertKnowledge,
  getKnowledgeById,
  insertLink,
  computeDiffFactor,
  resetInaccuracy,
  setInaccuracy,
  propagateInaccuracy,
  updateStatus,
  searchKnowledge,
  countKnowledge,
} from '../db/queries.js';
import {
  INACCURACY_THRESHOLD,
  INACCURACY_CAP,
} from '../types.js';

beforeEach(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

// === computeDiffFactor ===

describe('computeDiffFactor', () => {
  it('should return 0 when nothing changed', () => {
    const old = { title: 'Hello', content: 'World', tags: ['a', 'b'] };
    const result = computeDiffFactor(old, {});
    expect(result).toBe(0);
  });

  it('should return 0 when new fields are identical to old', () => {
    const old = { title: 'Hello', content: 'World', tags: ['a', 'b'] };
    const result = computeDiffFactor(old, {
      title: 'Hello',
      content: 'World',
      tags: ['a', 'b'],
    });
    expect(result).toBe(0);
  });

  it('should return minimum 0.1 for a tiny change', () => {
    const old = {
      title: 'This is a very long title to ensure ratio stays small',
      content: 'And this is very long content that should make the change ratio minimal',
      tags: ['tag1', 'tag2', 'tag3'],
    };
    // Change a single character in content
    const result = computeDiffFactor(old, {
      content: 'And this is very long content that should make the change ratio minima!',
    });
    expect(result).toBe(0.1);
  });

  it('should return 1.0 for a complete rewrite', () => {
    const old = { title: 'AAAA', content: 'BBBB', tags: ['CC'] };
    const result = computeDiffFactor(old, {
      title: 'XXXX',
      content: 'YYYY',
      tags: ['ZZ'],
    });
    expect(result).toBe(1.0);
  });

  it('should return a value between 0.1 and 1.0 for a partial change', () => {
    const old = { title: 'My Title', content: 'Some content here that is medium length', tags: [] };
    const result = computeDiffFactor(old, {
      content: 'Some completely different content',
    });
    expect(result).toBeGreaterThanOrEqual(0.1);
    expect(result).toBeLessThanOrEqual(1.0);
  });

  it('should handle empty old entry', () => {
    const old = { title: '', content: '', tags: [] };
    const result = computeDiffFactor(old, {
      title: 'New title',
      content: 'New content',
    });
    // max(oldLen, 1) protects against division by zero
    expect(result).toBeGreaterThanOrEqual(0.1);
    expect(result).toBeLessThanOrEqual(1.0);
  });

  it('should detect tag-only changes', () => {
    const old = { title: 'Title', content: 'Content', tags: ['a'] };
    const result = computeDiffFactor(old, { tags: ['b'] });
    expect(result).toBeGreaterThanOrEqual(0.1);
  });

  it('should detect title-only changes', () => {
    const old = { title: 'Old Title', content: 'Content', tags: [] };
    const result = computeDiffFactor(old, { title: 'New Title' });
    expect(result).toBeGreaterThanOrEqual(0.1);
  });

  it('should have higher diff factor for larger changes', () => {
    const old = { title: 'Title', content: 'The quick brown fox jumps over the lazy dog', tags: [] };
    const smallChange = computeDiffFactor(old, { content: 'The quick brown fox jumps over the lazy cat' });
    const bigChange = computeDiffFactor(old, { content: 'Completely different text about something else entirely' });
    expect(bigChange).toBeGreaterThanOrEqual(smallChange);
  });
});

// === resetInaccuracy / setInaccuracy ===

describe('resetInaccuracy', () => {
  it('should reset inaccuracy to 0', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    setInaccuracy(entry.id, 1.5);
    let updated = getKnowledgeById(entry.id)!;
    expect(updated.inaccuracy).toBe(1.5);

    resetInaccuracy(entry.id);
    updated = getKnowledgeById(entry.id)!;
    expect(updated.inaccuracy).toBe(0);
  });
});

describe('setInaccuracy', () => {
  it('should set inaccuracy to the given value', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    setInaccuracy(entry.id, 0.75);
    const updated = getKnowledgeById(entry.id)!;
    expect(updated.inaccuracy).toBe(0.75);
  });

  it('should cap inaccuracy at INACCURACY_CAP', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    setInaccuracy(entry.id, 999);
    const updated = getKnowledgeById(entry.id)!;
    expect(updated.inaccuracy).toBe(INACCURACY_CAP);
  });

  it('should allow setting to 0', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    setInaccuracy(entry.id, 1.0);
    setInaccuracy(entry.id, 0);
    const updated = getKnowledgeById(entry.id)!;
    expect(updated.inaccuracy).toBe(0);
  });

  it('should not modify status when setting inaccuracy', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    setInaccuracy(entry.id, INACCURACY_THRESHOLD);
    const updated = getKnowledgeById(entry.id)!;
    expect(updated.status).toBe('active');
    expect(updated.inaccuracy).toBe(INACCURACY_THRESHOLD);
  });
});

// === propagateInaccuracy — simple cases ===

describe('propagateInaccuracy', () => {
  it('should return empty array when diffFactor is 0', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    const bumps = propagateInaccuracy(entry.id, 0);
    expect(bumps).toEqual([]);
  });

  it('should return empty array when diffFactor is negative', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    const bumps = propagateInaccuracy(entry.id, -0.5);
    expect(bumps).toEqual([]);
  });

  it('should return empty array when entry has no incoming links', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    const bumps = propagateInaccuracy(entry.id, 1.0);
    expect(bumps).toEqual([]);
  });

  it('should bump direct dependents via derived link', () => {
    // F is a fact, W is derived from F  (link: source=W, target=F, type=derived)
    const f = insertKnowledge({ type: 'fact', title: 'Fact', content: 'Fact content' });
    const w = insertKnowledge({ type: 'wiki', title: 'Wiki', content: 'Wiki content' });
    insertLink({ sourceId: w.id, targetId: f.id, linkType: 'derived' });

    const bumps = propagateInaccuracy(f.id, 1.0);

    expect(bumps).toHaveLength(1);
    expect(bumps[0].id).toBe(w.id);
    expect(bumps[0].previousInaccuracy).toBe(0);
    // derived weight = 1.0, so bump = 1.0 * 1.0 = 1.0
    expect(bumps[0].newInaccuracy).toBe(1.0);

    const updated = getKnowledgeById(w.id)!;
    expect(updated.inaccuracy).toBe(1.0);
  });

  it('should apply link type weight', () => {
    const f = insertKnowledge({ type: 'fact', title: 'Source', content: 'Content' });
    const e = insertKnowledge({ type: 'fact', title: 'Elaboration', content: 'Content' });
    insertLink({ sourceId: e.id, targetId: f.id, linkType: 'elaborates' });

    const bumps = propagateInaccuracy(f.id, 1.0);

    expect(bumps).toHaveLength(1);
    // elaborates weight = 0.4
    expect(bumps[0].newInaccuracy).toBeCloseTo(0.4, 4);
  });

  it('should skip links with weight 0 (conflicts_with)', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'conflicts_with' });

    const bumps = propagateInaccuracy(a.id, 1.0);
    expect(bumps).toEqual([]);

    const updated = getKnowledgeById(b.id)!;
    expect(updated.inaccuracy).toBe(0);
  });

  it('should bump the updated entry via self-link but not re-queue it', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'derived' });
    // Also link A back to itself (pathological case)
    insertLink({ sourceId: a.id, targetId: a.id, linkType: 'related' });

    const bumps = propagateInaccuracy(a.id, 1.0);
    // Self-link: getIncoming(A) finds source_id=A. The bump IS applied (related=0.1),
    // but A won't be re-queued since it's already in the visited set.
    // B is NOT reached because the a->b link has target_id=b, which only appears
    // in getIncoming(b). B never enters the queue since nobody links to A from B.
    expect(bumps).toHaveLength(1);
    expect(bumps[0].id).toBe(a.id);
    expect(bumps[0].newInaccuracy).toBeCloseTo(0.1, 4);
  });

  // === Multi-hop propagation ===

  it('should propagate through multiple hops with decay', () => {
    // Chain: C -> B -> A (all derived links)
    // C derived from B, B derived from A
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'derived' });
    insertLink({ sourceId: c.id, targetId: b.id, linkType: 'derived' });

    const bumps = propagateInaccuracy(a.id, 1.0);

    expect(bumps).toHaveLength(2);

    const bBump = bumps.find((b_) => b_.id === b.id)!;
    const cBump = bumps.find((b_) => b_.id === c.id)!;

    // B: diffFactor=1.0, derived weight=1.0 => bump=1.0
    expect(bBump.newInaccuracy).toBeCloseTo(1.0, 4);

    // C: hop 2, bump = 1.0 * 1.0 (B's outgoing) * 0.5 (hop decay) * 1.0 (derived weight) = 0.5
    expect(cBump.newInaccuracy).toBeCloseTo(0.5, 4);
  });

  it('should apply hop decay correctly across 3 hops', () => {
    // D -> C -> B -> A (all derived)
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'Content' });
    const d = insertKnowledge({ type: 'fact', title: 'D', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'derived' });
    insertLink({ sourceId: c.id, targetId: b.id, linkType: 'derived' });
    insertLink({ sourceId: d.id, targetId: c.id, linkType: 'derived' });

    const bumps = propagateInaccuracy(a.id, 1.0);

    expect(bumps).toHaveLength(3);

    const bBump = bumps.find((x) => x.id === b.id)!;
    const cBump = bumps.find((x) => x.id === c.id)!;
    const dBump = bumps.find((x) => x.id === d.id)!;

    // B: 1.0 * 1.0 = 1.0
    expect(bBump.newInaccuracy).toBeCloseTo(1.0, 4);
    // C: 1.0 * 0.5 * 1.0 = 0.5
    expect(cBump.newInaccuracy).toBeCloseTo(0.5, 4);
    // D: 0.5 * 0.5 * 1.0 = 0.25
    expect(dBump.newInaccuracy).toBeCloseTo(0.25, 4);
  });

  it('should accumulate inaccuracy on top of existing value', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'derived' });

    // Set B's existing inaccuracy
    setInaccuracy(b.id, 0.5);

    const bumps = propagateInaccuracy(a.id, 1.0);

    expect(bumps).toHaveLength(1);
    expect(bumps[0].previousInaccuracy).toBe(0.5);
    // 0.5 + 1.0 = 1.5
    expect(bumps[0].newInaccuracy).toBeCloseTo(1.5, 4);
  });

  it('should cap accumulated inaccuracy at INACCURACY_CAP', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'derived' });

    // Set B near the cap
    setInaccuracy(b.id, 1.8);

    const bumps = propagateInaccuracy(a.id, 1.0);

    expect(bumps).toHaveLength(1);
    // 1.8 + 1.0 = 2.8, but capped at INACCURACY_CAP (2.0)
    expect(bumps[0].newInaccuracy).toBe(INACCURACY_CAP);
  });

  // === Cycle protection ===

  it('should handle cycles without infinite loops', () => {
    // A -> B -> A (cycle)
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'derived' });
    insertLink({ sourceId: a.id, targetId: b.id, linkType: 'derived' });

    // Should not hang — BFS visited set prevents infinite re-queuing
    const bumps = propagateInaccuracy(a.id, 1.0);

    // B gets bumped from A's outgoing (1.0 * 1.0 = 1.0).
    // Then B's incoming links include A→B, so A gets bumped too (1.0 * 0.5 * 1.0 = 0.5).
    // A is already visited so it won't be re-queued, preventing infinite loops.
    expect(bumps).toHaveLength(2);

    const bBump = bumps.find((x) => x.id === b.id)!;
    const aBump = bumps.find((x) => x.id === a.id)!;
    expect(bBump.newInaccuracy).toBeCloseTo(1.0, 4);
    expect(aBump.newInaccuracy).toBeCloseTo(0.5, 4);
  });

  it('should handle a triangle cycle', () => {
    // A -> B -> C -> A
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'derived' });
    insertLink({ sourceId: c.id, targetId: b.id, linkType: 'derived' });
    insertLink({ sourceId: a.id, targetId: c.id, linkType: 'derived' });

    const bumps = propagateInaccuracy(a.id, 1.0);

    // B gets bumped (1.0), C gets bumped (0.5 after hop decay), and A gets bumped
    // back via the C→A edge (0.25 after two hops of decay). A is already visited
    // so it won't be re-queued, preventing infinite loops.
    expect(bumps.length).toBe(3);

    const bBump = bumps.find((x) => x.id === b.id)!;
    const cBump = bumps.find((x) => x.id === c.id)!;
    const aBump = bumps.find((x) => x.id === a.id)!;
    expect(bBump.newInaccuracy).toBeCloseTo(1.0, 4);
    expect(cBump.newInaccuracy).toBeCloseTo(0.5, 4);
    expect(aBump.newInaccuracy).toBeCloseTo(0.25, 4);
  });

  // === Skip deprecated entries ===

  it('should skip deprecated entries during propagation', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B (deprecated)', content: 'Content' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'derived' });
    insertLink({ sourceId: c.id, targetId: b.id, linkType: 'derived' });

    // Deprecate B
    updateStatus(b.id, 'deprecated');

    const bumps = propagateInaccuracy(a.id, 1.0);

    // B is deprecated, so it's skipped. C shouldn't be reached either
    // (B is skipped during bump, so it won't be added to the BFS queue).
    expect(bumps).toEqual([]);
    expect(getKnowledgeById(b.id)!.inaccuracy).toBe(0);
    expect(getKnowledgeById(c.id)!.inaccuracy).toBe(0);
  });

  // === Multiple incoming links ===

  it('should bump all entries with incoming links to the updated entry', () => {
    // B, C, D all derived from A
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'Content' });
    const d = insertKnowledge({ type: 'fact', title: 'D', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'derived' });
    insertLink({ sourceId: c.id, targetId: a.id, linkType: 'depends' });
    insertLink({ sourceId: d.id, targetId: a.id, linkType: 'elaborates' });

    const bumps = propagateInaccuracy(a.id, 1.0);

    expect(bumps).toHaveLength(3);

    const bBump = bumps.find((x) => x.id === b.id)!;
    const cBump = bumps.find((x) => x.id === c.id)!;
    const dBump = bumps.find((x) => x.id === d.id)!;

    // derived: 1.0 * 1.0 = 1.0
    expect(bBump.newInaccuracy).toBeCloseTo(1.0, 4);
    // depends: 1.0 * 0.6 = 0.6
    expect(cBump.newInaccuracy).toBeCloseTo(0.6, 4);
    // elaborates: 1.0 * 0.4 = 0.4
    expect(dBump.newInaccuracy).toBeCloseTo(0.4, 4);
  });

  it('should apply diffFactor as a multiplier', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'derived' });

    // Small diff factor
    const bumps = propagateInaccuracy(a.id, 0.3);

    expect(bumps).toHaveLength(1);
    // 0.3 * 1.0 (derived) = 0.3
    expect(bumps[0].newInaccuracy).toBeCloseTo(0.3, 4);
  });

  // === INACCURACY_FLOOR threshold ===

  it('should stop propagation when bump falls below INACCURACY_FLOOR', () => {
    // Long chain: each hop decays by 0.5. With 'related' weight (0.1),
    // even hop 1 = 0.1 * 0.1 = 0.01, hop 2 = 0.01 * 0.5 * 0.1 = 0.0005 < FLOOR
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'related' });
    insertLink({ sourceId: c.id, targetId: b.id, linkType: 'related' });

    const bumps = propagateInaccuracy(a.id, 0.1);

    // Hop 1: 0.1 * 0.1 = 0.01 >= FLOOR (0.001), so B is bumped
    // Hop 2: 0.01 * 0.5 * 0.1 = 0.0005 < FLOOR, so C is not bumped
    expect(bumps).toHaveLength(1);
    expect(bumps[0].id).toBe(b.id);
    expect(bumps[0].newInaccuracy).toBeCloseTo(0.01, 4);
  });

  // === Diamond graph ===

  it('should handle diamond graph without double-bumping', () => {
    //     A
    //    / \
    //   B   C  (both derived from A)
    //    \ /
    //     D    (derived from both B and C)
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'Content' });
    const d = insertKnowledge({ type: 'fact', title: 'D', content: 'Content' });
    insertLink({ sourceId: b.id, targetId: a.id, linkType: 'derived' });
    insertLink({ sourceId: c.id, targetId: a.id, linkType: 'derived' });
    insertLink({ sourceId: d.id, targetId: b.id, linkType: 'derived' });
    insertLink({ sourceId: d.id, targetId: c.id, linkType: 'derived' });

    const bumps = propagateInaccuracy(a.id, 1.0);

    // B and C each get bump = 1.0 * 1.0 = 1.0
    // D: first path via B -> D (0.5 * 1.0 = 0.5), but visited prevents BFS from re-queueing D
    // However, D may be bumped via B's queue entry first, and then C's queue entry sees D is visited.
    // But the link from D to C means getIncoming(C) includes D... so D IS bumped from C too?
    // Actually: BFS processes A's incoming links (B, C), then B's incoming (D), D is visited.
    // When C's incoming is processed, D is already visited so it won't be re-queued.
    // But the bump IS applied (bump happens before the visited check for queueing).
    // Actually let's re-read the code:
    //   - For each incoming link, compute bump. If bump >= FLOOR, get the row.
    //   - If meaningful change, update DB. Then if NOT visited, add to queue.
    // So D gets bumped TWICE — once from B's context, once from C's context.
    // The second bump adds on top of the first.

    const dBump = bumps.find((x) => x.id === d.id)!;
    expect(dBump).toBeDefined();

    // First bump from B: 1.0 * 0.5 * 1.0 = 0.5
    // Second bump from C: 1.0 * 0.5 * 1.0 = 0.5
    // Total: 0.5 + 0.5 = 1.0
    expect(dBump.newInaccuracy).toBeCloseTo(1.0, 4);

    expect(bumps).toHaveLength(3); // B, C, D
  });
});

// === Search/count with inaccuracy filters ===

describe('search and count with inaccuracy filters', () => {
  it('should filter needs_revalidation as inaccuracy >= threshold', () => {
    insertKnowledge({ type: 'fact', title: 'Low inaccuracy', content: 'Content' });
    const high = insertKnowledge({ type: 'fact', title: 'High inaccuracy', content: 'Content' });
    setInaccuracy(high.id, INACCURACY_THRESHOLD);

    const results = searchKnowledge({ query: '', status: 'needs_revalidation' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(high.id);
  });

  it('should count needs_revalidation entries correctly', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'Content' });
    insertKnowledge({ type: 'fact', title: 'C', content: 'Content' });
    setInaccuracy(a.id, 1.5);
    setInaccuracy(b.id, 1.0);

    const count = countKnowledge({ status: 'needs_revalidation' });
    expect(count).toBe(2);
  });

  it('should support above_threshold in search', () => {
    const a = insertKnowledge({ type: 'fact', title: 'Alpha search term', content: 'Content' });
    insertKnowledge({ type: 'fact', title: 'Alpha another', content: 'Content' });
    setInaccuracy(a.id, 1.5);

    const results = searchKnowledge({ query: 'Alpha', aboveThreshold: true });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(a.id);
  });

  it('should not include deprecated entries in needs_revalidation filter', () => {
    const a = insertKnowledge({ type: 'fact', title: 'Deprecated entry', content: 'Content' });
    setInaccuracy(a.id, 1.5);
    updateStatus(a.id, 'deprecated');

    const results = searchKnowledge({ query: '', status: 'needs_revalidation' });
    expect(results).toHaveLength(0);
  });

  it('should default to active filter (includes high-inaccuracy active entries)', () => {
    insertKnowledge({ type: 'fact', title: 'Normal', content: 'Content' });
    const b = insertKnowledge({ type: 'fact', title: 'High inaccuracy but active', content: 'Content' });
    setInaccuracy(b.id, 1.5);

    const results = searchKnowledge({ query: '', status: 'active' });
    expect(results).toHaveLength(2);
  });
});
