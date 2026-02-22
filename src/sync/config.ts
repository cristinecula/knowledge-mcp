/**
 * Sync configuration — manages the sync configuration and enabled state.
 */

import type { SyncConfig } from './routing.js';

let syncConfig: SyncConfig | null = null;

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

/** Schema version for the sync repo metadata. */
export const SYNC_SCHEMA_VERSION = 1;
