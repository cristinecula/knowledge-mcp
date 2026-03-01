/**
 * Merge logic for sync conflicts.
 *
 * Uses version numbers to detect conflicts. Each content-changing operation
 * increments the entry's version. synced_version tracks the last version
 * that was reconciled with the remote. If both local and remote have
 * advanced beyond synced_version, it's a true conflict.
 *
 * When a conflict is detected, the remote version wins as canonical (stays
 * active), and the local content is saved as a [Sync Conflict] entry with
 * a 'conflicts_with' link for the agent to resolve.
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
 * Uses version numbers instead of timestamps for conflict detection:
 * - synced_version: the version number at last successful sync
 * - local.version: current local version (incremented on every content change)
 * - remote.version: current remote version (from the JSON file)
 *
 * Logic:
 * - If neither side advanced beyond synced_version -> no_change
 * - If only remote advanced -> remote_wins (unless content is identical)
 * - If only local advanced -> local_wins (unless content is identical)
 * - If both advanced and content differs -> conflict
 * - If both advanced but content is identical -> no_change
 */
export function detectConflict(
  local: KnowledgeEntry,
  remote: EntryJSON,
): MergeResult {
  const syncedVersion = local.synced_version ?? 0;
  const localChanged = local.version > syncedVersion;
  const remoteChanged = remote.version > syncedVersion;

  if (!localChanged && !remoteChanged) {
    return { action: 'no_change' };
  }

  if (remoteChanged && !localChanged) {
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
    return { action: 'no_change' };
  }

  // True conflict: both sides changed with different content
  return { action: 'conflict' };
}

/**
 * Check if the shared content fields of a local entry match a remote entry.
 *
 * Uses epsilon comparison for `inaccuracy` because entryToJSON() rounds to
 * 3 decimal places while SQLite stores full-precision floats. Without this,
 * values like 0.30000000000000004 (local) vs 0.3 (round-tripped) would fail
 * strict === and cause false conflicts.
 */
export function contentEquals(local: KnowledgeEntry, remote: EntryJSON): boolean {
  return (
    local.type === remote.type &&
    local.title === remote.title &&
    local.content.trimEnd() === remote.content.trimEnd() &&
    local.scope === remote.scope &&
    local.source === remote.source &&
    local.status === remote.status &&
    (local.project ?? null) === (remote.project ?? null) &&
    JSON.stringify(local.tags) === JSON.stringify(remote.tags) &&
    (local.declaration ?? null) === (remote.declaration ?? null) &&
    (local.parent_page_id ?? null) === (remote.parent_page_id ?? null) &&
    (local.deprecation_reason ?? null) === (remote.deprecation_reason ?? null) &&
    (local.flag_reason ?? null) === (remote.flag_reason ?? null) &&
    Math.abs((local.inaccuracy ?? 0) - (remote.inaccuracy ?? 0)) < 0.001
  );
}
