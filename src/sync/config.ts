/**
 * Sync configuration — manages the sync configuration, enabled state, sync mutex,
 * and cross-process sync coordinator lock.
 */

import { getDb } from '../db/connection.js';
import type { SyncConfig } from './routing.js';

let syncConfig: SyncConfig | null = null;
let syncInProgress = false;

/** Set the sync configuration. Null disables sync. */
export function setSyncConfig(config: SyncConfig | null): void {
  syncConfig = config;
}

/** Get the current sync configuration, or null if sync is disabled. */
export function getSyncConfig(): SyncConfig | null {
  return syncConfig;
}

/** Check if sync is enabled. */
export function isSyncEnabled(): boolean {
  return syncConfig !== null;
}

/** Check if a sync operation is currently in progress. */
export function isSyncInProgress(): boolean {
  return syncInProgress;
}

/** Set the sync-in-progress mutex. */
export function setSyncInProgress(value: boolean): void {
  syncInProgress = value;
}

/** Schema version for the sync repo metadata.
 * v1: JSON entry files ({uuid}.json)
 * v2: Markdown with YAML frontmatter ({slug}_{id8}.md)
 */
export const SYNC_SCHEMA_VERSION = 2;

/** Default lock TTL in seconds. */
const LOCK_TTL_SECONDS = 90;

/** Check if a process with the given PID is alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to acquire the cross-process sync lock.
 * Returns true if the lock was acquired, false if another process holds it.
 *
 * The lock is stored in the shared SQLite database. It expires after LOCK_TTL_SECONDS
 * and can be stolen if the holder PID is dead.
 */
export function tryAcquireSyncLock(): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + LOCK_TTL_SECONDS * 1000).toISOString();
  const pid = process.pid;

  const acquire = db.transaction(() => {
    const existing = db
      .prepare('SELECT holder_pid, expires_at FROM sync_lock WHERE lock_name = ?')
      .get('sync') as { holder_pid: number; expires_at: string } | undefined;

    if (!existing) {
      // No lock held — acquire it
      db.prepare('INSERT INTO sync_lock (lock_name, holder_pid, acquired_at, expires_at) VALUES (?, ?, ?, ?)')
        .run('sync', pid, now, expiresAt);
      return true;
    }

    // Lock exists — check if we can steal it
    if (existing.holder_pid === pid) {
      // We already hold it (shouldn't happen with isSyncInProgress guard, but handle gracefully)
      db.prepare('UPDATE sync_lock SET acquired_at = ?, expires_at = ? WHERE lock_name = ?')
        .run(now, expiresAt, 'sync');
      return true;
    }

    const expired = existing.expires_at < now;
    const holderDead = !isPidAlive(existing.holder_pid);

    if (expired || holderDead) {
      // Steal the lock
      db.prepare('UPDATE sync_lock SET holder_pid = ?, acquired_at = ?, expires_at = ? WHERE lock_name = ?')
        .run(pid, now, expiresAt, 'sync');
      return true;
    }

    // Another live process holds a non-expired lock
    return false;
  });

  return acquire();
}

/**
 * Release the cross-process sync lock.
 * Only releases if this process is the current holder.
 */
export function releaseSyncLock(): void {
  const db = getDb();
  db.prepare('DELETE FROM sync_lock WHERE lock_name = ? AND holder_pid = ?')
    .run('sync', process.pid);
}
