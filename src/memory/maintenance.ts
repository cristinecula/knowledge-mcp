import {
  getAllActiveEntries,
  getAllLinks,
  updateStrength,
} from '../db/queries.js';
import { getDb } from '../db/connection.js';
import {
  type KnowledgeEntry,
  type KnowledgeLink,
} from '../types.js';
import { calculateNetworkStrength } from './strength.js';

/**
 * Run a maintenance sweep: recalculate strength for all active entries.
 *
 * Should be called on server startup and periodically (e.g., every hour).
 * Low-strength entries are naturally filtered out by the query layer
 * (strength >= 0.5 threshold) without needing a status transition.
 */
export function runMaintenanceSweep(): {
  processed: number;
} {
  // Wiki entries are exempt from decay — they represent curated documentation
  // that should persist indefinitely without strength degradation.
  const entries = getAllActiveEntries().filter((e) => e.type !== 'wiki');
  const allLinks = getAllLinks();

  // Build a link index: entryId → links involving that entry
  const linkIndex = new Map<string, KnowledgeLink[]>();
  for (const link of allLinks) {
    if (!linkIndex.has(link.source_id)) linkIndex.set(link.source_id, []);
    if (!linkIndex.has(link.target_id)) linkIndex.set(link.target_id, []);
    linkIndex.get(link.source_id)!.push(link);
    linkIndex.get(link.target_id)!.push(link);
  }

  // Build an entry map for quick lookups
  const entryMap = new Map<string, KnowledgeEntry>();
  for (const entry of entries) {
    entryMap.set(entry.id, entry);
  }

  // Wrap all updates in a single transaction for performance.
  // Without this, each updateStrength is its own implicit
  // transaction with journal overhead. Batching gives 10-100x speedup.
  const db = getDb();
  const applyUpdates = db.transaction(() => {
    for (const entry of entries) {
      const links = linkIndex.get(entry.id) ?? [];

      // Collect the linked entries
      const linkedEntries: KnowledgeEntry[] = [];
      for (const link of links) {
        const otherId =
          link.source_id === entry.id ? link.target_id : link.source_id;
        const other = entryMap.get(otherId);
        if (other) linkedEntries.push(other);
      }

      const newStrength = calculateNetworkStrength(entry, links, linkedEntries);

      // Update strength in DB (low-strength entries are filtered by query layer)
      updateStrength(entry.id, newStrength);
    }
  });
  applyUpdates();

  return { processed: entries.length };
}
