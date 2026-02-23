import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { calculateBaseStrength, calculateNetworkStrength } from '../memory/strength.js';
import { runMaintenanceSweep } from '../memory/maintenance.js';
import {
  insertKnowledge,
  insertLink,
  getKnowledgeById,
  updateStrength,
  updateStatus,
  recordAccess,
} from '../db/queries.js';
import { getDb } from '../db/connection.js';
import {
  HALF_LIFE_MS,
  DEPRECATED_DECAY_MULTIPLIER,
  LINK_WEIGHTS,
  MAX_NETWORK_BONUS_RATIO,
  type KnowledgeEntry,
  type KnowledgeLink,
} from '../types.js';

beforeEach(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

// === Base strength ===

describe('calculateBaseStrength', () => {
  it('should return ~1.0 for a freshly created entry (no decay, no access)', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    const strength = calculateBaseStrength(entry);

    // Fresh entry: decay ≈ 1.0, accessBoost = 1 + log2(1 + 0) = 1
    expect(strength).toBeCloseTo(1.0, 1);
  });

  it('should apply access boost (logarithmic)', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    recordAccess(entry.id, 7);
    const updated = getKnowledgeById(entry.id)!;

    const strength = calculateBaseStrength(updated);
    // accessBoost = 1 + log2(1 + 7) = 1 + 3 = 4
    expect(strength).toBeCloseTo(4.0, 1);
  });

  it('should decay over time based on half-life', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });

    // Simulate 14 days old (one half-life)
    const mockEntry: KnowledgeEntry = {
      ...entry,
      last_accessed_at: new Date(Date.now() - HALF_LIFE_MS).toISOString(),
    };

    const strength = calculateBaseStrength(mockEntry);
    // After one half-life: decay = 0.5, accessBoost = 1
    expect(strength).toBeCloseTo(0.5, 1);
  });

  it('should decay more after multiple half-lives', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });

    // Two half-lives: strength should be ~0.25
    const mockEntry: KnowledgeEntry = {
      ...entry,
      last_accessed_at: new Date(Date.now() - 2 * HALF_LIFE_MS).toISOString(),
    };

    const strength = calculateBaseStrength(mockEntry);
    expect(strength).toBeCloseTo(0.25, 1);
  });

  it('should decay 10x faster for deprecated entries', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });

    const deprecatedHalfLife = HALF_LIFE_MS / DEPRECATED_DECAY_MULTIPLIER;
    const mockEntry: KnowledgeEntry = {
      ...entry,
      status: 'deprecated',
      last_accessed_at: new Date(Date.now() - deprecatedHalfLife).toISOString(),
    };

    const strength = calculateBaseStrength(mockEntry);
    // After one deprecated half-life: decay = 0.5
    expect(strength).toBeCloseTo(0.5, 1);
  });

  it('should combine decay and access boost', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    recordAccess(entry.id, 3);
    const updated = getKnowledgeById(entry.id)!;

    const mockEntry: KnowledgeEntry = {
      ...updated,
      last_accessed_at: new Date(Date.now() - HALF_LIFE_MS).toISOString(),
    };

    const strength = calculateBaseStrength(mockEntry);
    // decay = 0.5, accessBoost = 1 + log2(4) = 1 + 2 = 3
    // strength ≈ 0.5 * 3 = 1.5
    expect(strength).toBeCloseTo(1.5, 1);
  });

  it('should have diminishing returns on access boost', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });

    // Use equal-sized increments to demonstrate log2 concavity
    // log2(1+n) grows slower as n increases
    const mockWith0 = { ...entry, access_count: 0 };
    const mockWith10 = { ...entry, access_count: 10 };
    const mockWith20 = { ...entry, access_count: 20 };

    const s0 = calculateBaseStrength(mockWith0 as KnowledgeEntry);
    const s10 = calculateBaseStrength(mockWith10 as KnowledgeEntry);
    const s20 = calculateBaseStrength(mockWith20 as KnowledgeEntry);

    // Each should be bigger
    expect(s10).toBeGreaterThan(s0);
    expect(s20).toBeGreaterThan(s10);

    // But each +10 access increment gives less additional strength
    const gain0to10 = s10 - s0;
    const gain10to20 = s20 - s10;
    expect(gain0to10).toBeGreaterThan(gain10to20);
  });
});

// === Network strength ===

describe('calculateNetworkStrength', () => {
  it('should equal base strength when no links exist', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    const networkStr = calculateNetworkStrength(entry, [], []);
    const baseStr = calculateBaseStrength(entry);
    expect(networkStr).toBe(baseStr);
  });

  it('should add bonus from linked entries', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const link = insertLink({ sourceId: a.id, targetId: b.id, linkType: 'related' });

    const networkStr = calculateNetworkStrength(a, [link], [b]);
    const baseStr = calculateBaseStrength(a);
    expect(networkStr).toBeGreaterThan(baseStr);
  });

  it('should cap bonus at MAX_NETWORK_BONUS_RATIO', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });

    const linkedEntries: KnowledgeEntry[] = [];
    const links: KnowledgeLink[] = [];

    for (let i = 0; i < 10; i++) {
      const linked = insertKnowledge({ type: 'fact', title: `L${i}`, content: `l${i}` });
      recordAccess(linked.id, 100);
      const updatedLinked = getKnowledgeById(linked.id)!;
      linkedEntries.push(updatedLinked);
      links.push(insertLink({ sourceId: a.id, targetId: linked.id, linkType: 'depends' }));
    }

    const networkStr = calculateNetworkStrength(a, links, linkedEntries);
    const baseStr = calculateBaseStrength(a);
    const maxAllowed = baseStr + baseStr * MAX_NETWORK_BONUS_RATIO;

    expect(networkStr).toBeLessThanOrEqual(maxAllowed + 0.001);
  });

  it('should weight depends higher than related', () => {
    const a = insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    const b = insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'c' });

    const dependsLink = insertLink({ sourceId: a.id, targetId: b.id, linkType: 'depends' });
    const relatedLink = insertLink({ sourceId: a.id, targetId: c.id, linkType: 'related' });

    expect(LINK_WEIGHTS.depends).toBeGreaterThan(LINK_WEIGHTS.related);

    const withDepends = calculateNetworkStrength(a, [dependsLink], [b]);
    const withRelated = calculateNetworkStrength(a, [relatedLink], [c]);

    expect(withDepends).toBeGreaterThan(withRelated);
  });
});

// === Maintenance sweep ===

describe('runMaintenanceSweep', () => {
  it('should recalculate strength for active entries', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    updateStrength(entry.id, 999);

    const result = runMaintenanceSweep();
    expect(result.processed).toBe(1);

    const updated = getKnowledgeById(entry.id);
    expect(updated!.strength).toBeCloseTo(1.0, 0);
  });

  it('should not process deprecated entries', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    updateStatus(entry.id, 'deprecated');

    const result = runMaintenanceSweep();
    expect(result.processed).toBe(0);
  });

  it('should process needs_revalidation entries', () => {
    const entry = insertKnowledge({ type: 'fact', title: 'Test', content: 'Content' });
    updateStatus(entry.id, 'needs_revalidation');

    const result = runMaintenanceSweep();
    expect(result.processed).toBe(1);
  });

  it('should return correct counts', () => {
    insertKnowledge({ type: 'fact', title: 'A', content: 'a' });
    insertKnowledge({ type: 'fact', title: 'B', content: 'b' });
    const c = insertKnowledge({ type: 'fact', title: 'C', content: 'c' });
    updateStatus(c.id, 'deprecated');

    const result = runMaintenanceSweep();
    expect(result.processed).toBe(2); // A and B (C is deprecated)
    expect(typeof result.transitioned).toBe('number');
  });

  it('should not process wiki entries (exempt from decay)', () => {
    const wiki = insertKnowledge({ type: 'wiki', title: 'Wiki Page', content: 'Wiki content' });

    // Simulate an old last_accessed_at (4 half-lives ago → normally strength ~0.0625)
    const oldDate = new Date(Date.now() - 4 * HALF_LIFE_MS).toISOString();
    getDb().prepare('UPDATE knowledge SET last_accessed_at = ?').run(oldDate);

    const result = runMaintenanceSweep();
    expect(result.processed).toBe(0); // wiki entries are skipped entirely

    const updated = getKnowledgeById(wiki.id)!;
    expect(updated.status).toBe('active');
    // Strength should be unchanged (still 1.0 from initial insert)
    expect(updated.strength).toBeCloseTo(1.0, 1);
  });
});
