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
  const contentUpdatedAt = local.content_updated_at;

  // If never synced before, compare content
  if (!syncedAt) {
    if (contentEquals(local, remote)) {
      return { action: 'no_change' };
    }
    return { action: 'conflict' };
  }

  // Check if local changed since last sync
  // content_updated_at is updated when content changes.
  // If content_updated_at > synced_at, local has changes.
  const localChanged = contentUpdatedAt ? contentUpdatedAt > syncedAt : false;

  // Check if remote changed since last sync
  // remote.updated_at is the last time remote changed.
  // If remote.updated_at > synced_at, remote has changes.
  // Note: we trust remote timestamp to be roughly accurate or at least monotonic
  const remoteChanged = remote.updated_at > syncedAt;

  if (!localChanged && !remoteChanged) {
    return { action: 'no_change' };
  }

  if (remoteChanged && !localChanged) {
    // Guard: if only timestamps differ but content is identical, treat as no_change.
    // This prevents flip-flop when an older version of the code sets
    // content_updated_at = now() on every pull, producing spurious timestamp
    // differences with no semantic change.
    if (contentEquals(local, remote)) {
      return { action: 'no_change' };
    }
    return { action: 'remote_wins' };
  }

  if (localChanged && !remoteChanged) {
    if (contentEquals(local, remote)) {
      return { action: 'no_change' };
    }
    return { action: 'local_wins' };
  }

  // Both changed — check if the changes are identical
  if (contentEquals(local, remote)) {
    // Both changed to the same thing — just update synced_at (handled by no_change logic in pull)
    // Actually pull logic for no_change just updates synced_at, which is what we want.
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
