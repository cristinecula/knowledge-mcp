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
  readEntryFileRaw,
  writeLinkFile,
  deleteEntryFile,
  deleteLinkFile,
  getRepoEntryIds,
  getRepoLinkIds,
} from './fs.js';
import { resolveRepoForScope } from './routing.js';
import { gitCommitAll, gitPush } from './git.js';

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
export function push(config: import('./routing.js').SyncConfig): PushResult {
  const result: PushResult = {
    new_entries: 0,
    updated: 0,
    deleted: 0,
    new_links: 0,
    deleted_links: 0,
  };

  const touchedRepos = new Set<string>();

  // Ensure repo structure for all configured repos
  for (const repo of config.repos) {
    if (existsSync(repo.path)) {
      ensureRepoStructure(repo.path);
    }
  }

  // === Push entries ===

  const localEntries = getAllEntries();
  const localEntryIds = new Set<string>();

  // Track which repo each entry belongs to (for deletion logic)
  const entryRepoMap = new Map<string, string>();
  
  // Pre-load all repo states to correctly calculate new vs updated
  const initialRepoState = new Map<string, Set<string>>(); // repoPath -> Set<id>
  for (const repo of config.repos) {
    if (existsSync(repo.path)) {
      initialRepoState.set(repo.path, getRepoEntryIds(repo.path));
    } else {
      initialRepoState.set(repo.path, new Set());
    }
  }

  for (const entry of localEntries) {
    // Skip conflict entries — they're local-only resolution artifacts
    if (entry.title.startsWith('[Sync Conflict]')) continue;

    localEntryIds.add(entry.id);

    // Resolve target repo
    const targetRepo = resolveRepoForScope(entry.scope, entry.project, config);
    const repoPath = targetRepo.path;
    entryRepoMap.set(entry.id, repoPath);

    // Serialize and compare against existing file to skip unnecessary writes.
    // This prevents spurious git commits when the entry hasn't actually changed
    // (e.g., after a pull→push cycle where only local metadata like access_count changed).
    const json = entryToJSON(entry);
    const serialized = JSON.stringify(json, null, 2) + '\n';
    const existing = readEntryFileRaw(repoPath, entry.type, entry.id);

    if (existing === serialized) {
      // File is byte-identical — skip write
      updateSyncedAt(entry.id);
    } else {
      // File changed or is new — write it
      writeEntryFile(repoPath, json);
      updateSyncedAt(entry.id);
      touchedRepos.add(repoPath);
    }
    
    // Check if new or updated
    const existingInTarget = initialRepoState.get(repoPath)?.has(entry.id);
    if (existingInTarget) {
      result.updated++;
    } else {
      // Check if it existed in ANY repo (moved = updated, not new)
      let existedAnywhere = false;
      for (const ids of initialRepoState.values()) {
        if (ids.has(entry.id)) {
          existedAnywhere = true;
          break;
        }
      }
      if (existedAnywhere) {
        result.updated++;
      } else {
        result.new_entries++;
      }
    }
  }

  // === Clean up old files (moves, type changes, deletions) ===

  for (const repo of config.repos) {
    if (!existsSync(repo.path)) continue;

    const repoIds = getRepoEntryIds(repo.path);
    for (const id of repoIds) {
      // If entry no longer exists locally, delete it
      if (!localEntryIds.has(id)) {
        deleteEntryFile(repo.path, id);
        result.deleted++;
        touchedRepos.add(repo.path);
        continue;
      }

      // If entry exists locally but belongs to a DIFFERENT repo, delete it here (move)
      const correctRepo = entryRepoMap.get(id);
      if (correctRepo && correctRepo !== repo.path) {
        deleteEntryFile(repo.path, id);
        // Don't count as deleted since it's just moving
        touchedRepos.add(repo.path);
      }
    }
  }

  // === Push links ===

  const localLinks = getAllLinks();
  const localLinkIds = new Set<string>();
  const linkRepoMap = new Map<string, string>();

  // Pre-load existing link IDs from all repos for new vs existing tracking
  const initialLinkState = new Set<string>();
  for (const repo of config.repos) {
    if (existsSync(repo.path)) {
      for (const id of getRepoLinkIds(repo.path)) {
        initialLinkState.add(id);
      }
    }
  }

  for (const link of localLinks) {
    // Skip conflict-related links
    if (link.source === 'sync:conflict') continue;

    localLinkIds.add(link.id);

    // Resolve repo based on source entry's repo
    const sourceRepo = entryRepoMap.get(link.source_id);
    
    if (sourceRepo) {
      const json = linkToJSON(link);
      writeLinkFile(sourceRepo, json);
      linkRepoMap.set(link.id, sourceRepo);
      touchedRepos.add(sourceRepo);

      if (!initialLinkState.has(link.id)) {
        result.new_links++;
      }
    }
  }

  // === Clean up old link files ===

  for (const repo of config.repos) {
    if (!existsSync(repo.path)) continue;

    const repoLinkIds = getRepoLinkIds(repo.path);
    for (const id of repoLinkIds) {
      if (!localLinkIds.has(id)) {
        deleteLinkFile(repo.path, id);
        result.deleted_links++;
        touchedRepos.add(repo.path);
        continue;
      }

      const correctRepo = linkRepoMap.get(id);
      if (correctRepo && correctRepo !== repo.path) {
        deleteLinkFile(repo.path, id);
        touchedRepos.add(repo.path);
      }
    }
  }

  // === Commit and Push ===

  // Push ALL configured repos, not just touched ones. Write-through may have
  // created commits (e.g., store or delete) that haven't been pushed yet.
  // If we only push touchedRepos, deletions that were already committed by
  // write-through (and thus didn't touch the repo during push()) would never
  // be pushed to the remote.
  for (const repo of config.repos) {
    if (!existsSync(repo.path)) continue;

    // Commit any remaining changes in touched repos
    if (touchedRepos.has(repo.path)) {
      gitCommitAll(repo.path, 'knowledge: sync push');
    }

    // Always push — there may be unpushed write-through commits
    gitPush(repo.path);
  }

  return result;
}
