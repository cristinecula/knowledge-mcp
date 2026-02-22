/**
 * Sync configuration — manages the git repo path and enabled state.
 */

let syncRepoPath: string | null = null;

/** Set the sync repo path. Null disables sync. */
export function setSyncRepo(path: string | null): void {
  syncRepoPath = path;
}

/** Get the current sync repo path, or null if sync is disabled. */
export function getSyncRepo(): string | null {
  return syncRepoPath;
}

/** Check if sync is enabled. */
export function isSyncEnabled(): boolean {
  return syncRepoPath !== null;
}

/** Schema version for the sync repo metadata. */
export const SYNC_SCHEMA_VERSION = 1;
