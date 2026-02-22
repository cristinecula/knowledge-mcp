/**
 * Push: export local entries to the sync repo as JSON files.
 *
 * Writes all local entries (except [Sync Conflict] entries) to the repo.
 * Also handles entries that were deleted locally — removes their JSON files.
 */

import { existsSync } from 'node:fs';
import {
  getAllEntries,
  getAllLinks,
  updateSyncedAt,
} from '../db/queries.js';
import { entryToJSON, linkToJSON } from './serialize.js';
import {
  ensureRepoStructure,
  writeEntryFile,
  writeLinkFile,
  deleteEntryFile,
  deleteLinkFile,
  getRepoEntryIds,
  getRepoLinkIds,
} from './fs.js';

export interface PushResult {
  new_entries: number;
  updated: number;
  deleted: number;
  new_links: number;
  deleted_links: number;
}

/**
 * Push local entries to the sync repo.
 */
export function push(repoPath: string): PushResult {
  if (!existsSync(repoPath)) {
    throw new Error(`Sync repo not found: ${repoPath}`);
  }

  ensureRepoStructure(repoPath);

  const result: PushResult = {
    new_entries: 0,
    updated: 0,
    deleted: 0,
    new_links: 0,
    deleted_links: 0,
  };

  // Get all entries in the repo before push (to detect what's new vs updated)
  const existingRepoIds = getRepoEntryIds(repoPath);

  // === Push entries ===

  const localEntries = getAllEntries();
  const localEntryIds = new Set<string>();

  for (const entry of localEntries) {
    // Skip conflict entries — they're local-only resolution artifacts
    if (entry.title.startsWith('[Sync Conflict]')) continue;

    localEntryIds.add(entry.id);

    const json = entryToJSON(entry);

    // If the entry type changed, delete the old file first
    // (it might be in a different type directory)
    if (existingRepoIds.has(entry.id)) {
      deleteEntryFile(repoPath, entry.id);
    }

    writeEntryFile(repoPath, json);
    updateSyncedAt(entry.id);

    if (existingRepoIds.has(entry.id)) {
      result.updated++;
    } else {
      result.new_entries++;
    }
  }

  // Delete entries from repo that no longer exist locally
  for (const repoId of existingRepoIds) {
    if (!localEntryIds.has(repoId)) {
      deleteEntryFile(repoPath, repoId);
      result.deleted++;
    }
  }

  // === Push links ===

  const existingLinkIds = getRepoLinkIds(repoPath);
  const localLinks = getAllLinks();
  const localLinkIds = new Set<string>();

  for (const link of localLinks) {
    // Skip conflict-related links
    if (link.source === 'sync:conflict') continue;

    localLinkIds.add(link.id);

    const json = linkToJSON(link);
    writeLinkFile(repoPath, json);

    if (!existingLinkIds.has(link.id)) {
      result.new_links++;
    }
  }

  // Delete links from repo that no longer exist locally
  for (const repoLinkId of existingLinkIds) {
    if (!localLinkIds.has(repoLinkId)) {
      deleteLinkFile(repoPath, repoLinkId);
      result.deleted_links++;
    }
  }

  return result;
}
