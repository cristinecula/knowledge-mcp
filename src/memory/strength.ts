import {
  HALF_LIFE_MS,
  DEPRECATED_DECAY_MULTIPLIER,
  LINK_WEIGHTS,
  MAX_NETWORK_BONUS_RATIO,
  type KnowledgeEntry,
  type KnowledgeLink,
  type LinkType,
} from '../types.js';

/**
 * Calculate base strength for a single entry (without network effects).
 *
 * Formula:
 *   baseStrength = decayFactor × accessBoost
 *
 *   decayFactor = 0.5 ^ (timeSinceLastAccess / HALF_LIFE)
 *   accessBoost = 1 + log2(1 + accessCount)
 *
 * Deprecated entries have their decay accelerated by DEPRECATED_DECAY_MULTIPLIER.
 */
export function calculateBaseStrength(entry: KnowledgeEntry): number {
  const now = Date.now();
  const lastAccessed = new Date(entry.last_accessed_at).getTime();
  const age = Math.max(0, now - lastAccessed);

  // For deprecated entries, accelerate decay
  const effectiveHalfLife =
    entry.status === 'deprecated'
      ? HALF_LIFE_MS / DEPRECATED_DECAY_MULTIPLIER
      : HALF_LIFE_MS;

  const decayFactor = Math.pow(0.5, age / effectiveHalfLife);

  // Logarithmic access boost (diminishing returns)
  const accessBoost = 1 + Math.log2(1 + entry.access_count);

  return decayFactor * accessBoost;
}

/**
 * Calculate network-enhanced strength for an entry, factoring in
 * the strength of linked entries (spreading activation).
 *
 * Each linked entry contributes a weighted bonus based on its own
 * base strength and the link type weight. The total bonus is capped
 * at MAX_NETWORK_BONUS_RATIO × baseStrength.
 */
export function calculateNetworkStrength(
  entry: KnowledgeEntry,
  links: KnowledgeLink[],
  linkedEntries: KnowledgeEntry[],
): number {
  const baseStrength = calculateBaseStrength(entry);

  if (links.length === 0) {
    return baseStrength;
  }

  // Build a map of linked entry strengths
  const entryMap = new Map<string, KnowledgeEntry>();
  for (const e of linkedEntries) {
    entryMap.set(e.id, e);
  }

  let networkBonus = 0;

  for (const link of links) {
    // Determine which end of the link is the "other" entry
    const otherId =
      link.source_id === entry.id ? link.target_id : link.source_id;
    const linkedEntry = entryMap.get(otherId);

    if (!linkedEntry) continue;

    const linkedBase = calculateBaseStrength(linkedEntry);
    const weight = LINK_WEIGHTS[link.link_type as LinkType] ?? 0.1;

    networkBonus += linkedBase * weight;
  }

  // Cap the network bonus
  const cappedBonus = Math.min(
    networkBonus,
    baseStrength * MAX_NETWORK_BONUS_RATIO,
  );

  return baseStrength + cappedBonus;
}
