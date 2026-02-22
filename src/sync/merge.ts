/**
 * Merge logic for sync conflicts.
 *
 * Compares local and remote entries to detect conflicts.
 * When a true conflict is detected (both sides changed since last sync),
 * both versions are kept: the local stays in place, and the remote is
 * stored as a new [Sync Conflict] entry with a 'contradicts' link.
 * Both are flagged as needs_revalidation.
 */

import type { KnowledgeEntry } from '../types.js';
import type { EntryJSON } from './serialize.js';

export type MergeResult =
  | { action: 'no_change' }
  | { action: 'remote_wins' }
  | { action: 'local_wins' }
  | { action: 'conflict' };

/**
 * Determine the merge action for an entry that exists both locally and remotely.
 *
 * Uses content_updated_at and synced_at to detect true conflicts:
 * - If only remote changed since last sync → remote_wins (apply remote)
 * - If only local changed since last sync → local_wins (keep local)
 * - If both changed since last sync → conflict (keep both)
 * - If neither changed → no_change
 *
 * For entries that have never been synced (synced_at is null),
 * treat as a conflict if both exist with different content.
 */
export function detectConflict(
  local: KnowledgeEntry,
  remote: EntryJSON,
): MergeResult {
  const syncedAt = local.synced_at;

  // If never synced before, this is a first-time merge.
  // Compare content to see if they differ.
  if (!syncedAt) {
    if (contentEquals(local, remote)) {
      return { action: 'no_change' };
    }
    // Both have content but different — this is a conflict
    return { action: 'conflict' };
  }

  // Check if local changed since last sync
  const localChanged = local.content_updated_at > syncedAt;

  // Check if remote changed since last sync
  const remoteChanged = remote.updated_at > syncedAt;

  if (!localChanged && !remoteChanged) {
    return { action: 'no_change' };
  }

  if (remoteChanged && !localChanged) {
    return { action: 'remote_wins' };
  }

  if (localChanged && !remoteChanged) {
    return { action: 'local_wins' };
  }

  // Both changed — check if the changes are identical
  if (contentEquals(local, remote)) {
    return { action: 'no_change' };
  }

  // True conflict: both sides changed with different content
  return { action: 'conflict' };
}

/**
 * Check if the shared content fields of a local entry match a remote entry.
 */
function contentEquals(local: KnowledgeEntry, remote: EntryJSON): boolean {
  return (
    local.type === remote.type &&
    local.title === remote.title &&
    local.content === remote.content &&
    local.scope === remote.scope &&
    local.source === remote.source &&
    local.status === remote.status &&
    (local.project ?? null) === (remote.project ?? null) &&
    JSON.stringify(local.tags) === JSON.stringify(remote.tags)
  );
}
