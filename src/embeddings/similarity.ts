import type { KnowledgeEntry } from '../types.js';
import { getEmbeddingProvider } from './provider.js';
import { getAllEmbeddings, storeEmbedding } from '../db/queries.js';

/**
 * Compute cosine similarity between two vectors.
 * Assumes both vectors are already normalized (which they should be from the providers).
 * For normalized vectors, cosine similarity = dot product.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

export interface ScoredEntry {
  entry: KnowledgeEntry;
  score: number;
}

/**
 * Search for entries similar to the query using vector similarity.
 * Returns entries sorted by cosine similarity (descending).
 */
export async function vectorSearch(
  queryText: string,
  entries: KnowledgeEntry[],
  limit: number = 10,
): Promise<ScoredEntry[]> {
  const provider = getEmbeddingProvider();
  if (!provider) return [];

  // Generate query embedding
  const queryEmbedding = await provider.embed(queryText);

  // Get all stored embeddings
  const storedEmbeddings = getAllEmbeddings();

  // Build a lookup from entry ID to entry
  const entryMap = new Map<string, KnowledgeEntry>();
  for (const entry of entries) {
    entryMap.set(entry.id, entry);
  }

  // Score each entry
  const scored: ScoredEntry[] = [];

  for (const stored of storedEmbeddings) {
    const entry = entryMap.get(stored.entry_id);
    if (!entry) continue;

    const embedding = new Float32Array(stored.embedding.buffer, stored.embedding.byteOffset, stored.embedding.byteLength / 4);
    const similarity = cosineSimilarity(queryEmbedding, embedding);

    scored.push({ entry, score: similarity });
  }

  // Sort by similarity descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}

/**
 * Reciprocal Rank Fusion (RRF) — merges two ranked lists into one.
 *
 * For each result, its RRF score is:
 *   score = Σ 1/(k + rank_i)
 * where k=60 is the standard constant and rank_i is the 1-based rank in each list.
 *
 * Results that appear in both lists get contributions from both.
 */
export function reciprocalRankFusion(
  ftsResults: ScoredEntry[],
  vecResults: ScoredEntry[],
  k: number = 60,
): ScoredEntry[] {
  const scoreMap = new Map<string, { entry: KnowledgeEntry; rrfScore: number }>();

  // Score FTS results
  for (let i = 0; i < ftsResults.length; i++) {
    const { entry } = ftsResults[i];
    const existing = scoreMap.get(entry.id);
    const contribution = 1 / (k + i + 1); // rank is 1-based
    if (existing) {
      existing.rrfScore += contribution;
    } else {
      scoreMap.set(entry.id, { entry, rrfScore: contribution });
    }
  }

  // Score vector results
  for (let i = 0; i < vecResults.length; i++) {
    const { entry } = vecResults[i];
    const existing = scoreMap.get(entry.id);
    const contribution = 1 / (k + i + 1);
    if (existing) {
      existing.rrfScore += contribution;
    } else {
      scoreMap.set(entry.id, { entry, rrfScore: contribution });
    }
  }

  // Convert to array and sort by RRF score
  const merged = Array.from(scoreMap.values());
  merged.sort((a, b) => b.rrfScore - a.rrfScore);

  return merged.map((m) => ({ entry: m.entry, score: m.rrfScore }));
}

/**
 * Generate and store an embedding for a knowledge entry.
 * Called when storing or updating knowledge.
 */
export async function embedAndStore(
  entryId: string,
  title: string,
  content: string,
  tags: string[],
): Promise<void> {
  const provider = getEmbeddingProvider();
  if (!provider) return;

  // Combine title, content, and tags into a single text for embedding
  const text = `${title}\n\n${content}\n\nTags: ${tags.join(', ')}`;
  const embedding = await provider.embed(text);

  storeEmbedding(
    entryId,
    Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    provider.model,
    provider.dimensions,
  );
}

/**
 * Backfill embeddings for all entries that don't have one.
 */
export async function backfillEmbeddings(
  entries: KnowledgeEntry[],
): Promise<{ processed: number; skipped: number }> {
  const provider = getEmbeddingProvider();
  if (!provider) return { processed: 0, skipped: 0 };

  const existing = new Set(getAllEmbeddings().map((e) => e.entry_id));

  let processed = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (existing.has(entry.id)) {
      skipped++;
      continue;
    }

    await embedAndStore(entry.id, entry.title, entry.content, entry.tags);
    processed++;
  }

  return { processed, skipped };
}
