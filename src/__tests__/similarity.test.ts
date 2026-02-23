import { describe, it, expect } from 'vitest';
import { cosineSimilarity, reciprocalRankFusion, type ScoredEntry } from '../embeddings/similarity.js';
import type { KnowledgeEntry } from '../types.js';

// Helper to create a mock KnowledgeEntry
function mockEntry(id: string, title: string = 'Test'): KnowledgeEntry {
  return {
    id,
    type: 'fact',
    title,
    content: 'Content',
    tags: [],
    project: null,
    scope: 'company',
    source: 'test',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    content_updated_at: new Date().toISOString(),
    last_accessed_at: new Date().toISOString(),
    access_count: 0,
    strength: 1.0,
    status: 'active',
    synced_at: null,
    deprecation_reason: null,
    declaration: null,
  };
}

// === Cosine Similarity ===

describe('cosineSimilarity', () => {
  it('should return 1.0 for identical vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('should return 0.0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('should return -1.0 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('should handle non-unit vectors correctly', () => {
    const a = new Float32Array([3, 4]);
    const b = new Float32Array([4, 3]);
    // cos(θ) = (3*4 + 4*3) / (5 * 5) = 24/25 = 0.96
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.96, 2);
  });

  it('should return 0 for mismatched dimensions', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('should return 0 for zero vectors', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('should handle high-dimensional vectors', () => {
    const dim = 384; // Same as all-MiniLM-L6-v2
    const a = new Float32Array(dim).fill(1 / Math.sqrt(dim));
    const b = new Float32Array(dim).fill(1 / Math.sqrt(dim));
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 3);
  });
});

// === Reciprocal Rank Fusion ===

describe('reciprocalRankFusion', () => {
  it('should merge two ranked lists', () => {
    const entryA = mockEntry('a', 'Entry A');
    const entryB = mockEntry('b', 'Entry B');
    const entryC = mockEntry('c', 'Entry C');

    const ftsResults: ScoredEntry[] = [
      { entry: entryA, score: 10 },
      { entry: entryB, score: 5 },
    ];
    const vecResults: ScoredEntry[] = [
      { entry: entryB, score: 0.9 },
      { entry: entryC, score: 0.8 },
    ];

    const merged = reciprocalRankFusion(ftsResults, vecResults);

    // B should rank highest (appears in both lists)
    expect(merged[0].entry.id).toBe('b');
    expect(merged).toHaveLength(3);
  });

  it('should give higher scores to entries appearing in both lists', () => {
    const entryA = mockEntry('a');
    const entryB = mockEntry('b');

    const ftsResults: ScoredEntry[] = [
      { entry: entryA, score: 10 },
      { entry: entryB, score: 5 },
    ];
    const vecResults: ScoredEntry[] = [
      { entry: entryA, score: 0.9 },
    ];

    const merged = reciprocalRankFusion(ftsResults, vecResults);

    // A appears in both, B only in FTS
    const scoreA = merged.find((m) => m.entry.id === 'a')!.score;
    const scoreB = merged.find((m) => m.entry.id === 'b')!.score;
    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it('should handle empty lists', () => {
    const merged = reciprocalRankFusion([], []);
    expect(merged).toHaveLength(0);
  });

  it('should handle one empty list', () => {
    const entryA = mockEntry('a');
    const ftsResults: ScoredEntry[] = [{ entry: entryA, score: 10 }];

    const merged = reciprocalRankFusion(ftsResults, []);
    expect(merged).toHaveLength(1);
    expect(merged[0].entry.id).toBe('a');
  });

  it('should use the k parameter correctly', () => {
    const entryA = mockEntry('a');

    const ftsResults: ScoredEntry[] = [{ entry: entryA, score: 10 }];

    // With k=60 (default): score = 1/(60+1) ≈ 0.0164
    const mergedDefault = reciprocalRankFusion(ftsResults, []);
    expect(mergedDefault[0].score).toBeCloseTo(1 / 61, 4);

    // With k=1: score = 1/(1+1) = 0.5
    const mergedSmallK = reciprocalRankFusion(ftsResults, [], 1);
    expect(mergedSmallK[0].score).toBeCloseTo(0.5, 4);
  });
});
