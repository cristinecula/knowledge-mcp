/**
 * Sync configuration — manages the sync configuration, enabled state, and sync mutex.
 */

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

/** Schema version for the sync repo metadata. */
export const SYNC_SCHEMA_VERSION = 1;
