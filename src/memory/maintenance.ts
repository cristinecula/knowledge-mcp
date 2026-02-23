import {
  getAllActiveEntries,
  getAllLinks,
  updateStrength,
  updateStatus,
} from '../db/queries.js';
import {
  STRENGTH_DORMANT_THRESHOLD,
  type KnowledgeEntry,
  type KnowledgeLink,
} from '../types.js';
import { calculateNetworkStrength } from './strength.js';

/**
 * Run a maintenance sweep: recalculate strength for all active entries,
 * and transition entries below thresholds to appropriate statuses.
 *
 * Should be called on server startup and periodically (e.g., every hour).
 */
export function runMaintenanceSweep(): {
  processed: number;
  transitioned: number;
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

  let transitioned = 0;

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

    // Update strength in DB
    updateStrength(entry.id, newStrength);

    // Transition status based on strength (but don't touch 'needs_revalidation' or 'deprecated')
    if (entry.status === 'active') {
      if (newStrength < STRENGTH_DORMANT_THRESHOLD) {
        updateStatus(entry.id, 'dormant');
        transitioned++;
      }
    }
  }

  return { processed: entries.length, transitioned };
}
