/**
 * Push: export local entries to the sync repo as Markdown files.
 *
 * Writes all local entries (except [Sync Conflict] entries) to the repo.
 * Also handles entries that were deleted locally — removes their files.
 * Cleans up redirect markers left by title renames.
 */

import { existsSync } from 'node:fs';
import {
  getAllEntries,
  getAllLinks,
  updateSyncedVersion,
  updateLinkSyncedAt,
} from '../db/queries.js';
import { getDb } from '../db/connection.js';
import { entryToJSON, entryToMarkdown, linkToJSON, id8 } from './serialize.js';
import {
  ensureRepoStructure,
  writeEntryFile,
  readEntryFileRaw,
  writeLinkFile,
  readLinkFileRaw,
  deleteEntryFile,
  deleteLinkFile,
  getRepoEntryIds,
  getRepoLinkIds,
  cleanupRedirectFiles,
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
export async function push(config: import('./routing.js').SyncConfig): Promise<PushResult> {
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
  const localEntryId8s = new Set<string>();

  // Track which repo each entry belongs to (for deletion logic)
  const entryRepoMap = new Map<string, string>();
  
  // Batch all entry processing in a transaction for performance.
  // Without this, each updateSyncedVersion is its own implicit transaction.
  const db = getDb();
  const processEntries = db.transaction(() => {
    for (const entry of localEntries) {
      // Skip conflict entries — they're local-only resolution artifacts
      if (entry.title.startsWith('[Sync Conflict]')) continue;

      localEntryId8s.add(id8(entry.id));

      // Resolve target repo
      const targetRepo = resolveRepoForScope(entry.scope, entry.project, config);
      const repoPath = targetRepo.path;
      entryRepoMap.set(entry.id, repoPath);

      // Serialize and compare against existing file to skip unnecessary writes.
      // This prevents spurious git commits when the entry hasn't actually changed
      // (e.g., after a pull→push cycle where only local metadata like access_count changed).
      const json = entryToJSON(entry);
      const serialized = entryToMarkdown(json);
      const existing = readEntryFileRaw(repoPath, entry.type, entry.id, entry.title);

      if (existing === serialized) {
        // File is byte-identical — skip write, just update synced_version
        updateSyncedVersion(entry.id, entry.version);
      } else {
        // File changed or is new — write it and set synced_version
        writeEntryFile(repoPath, json);
        updateSyncedVersion(entry.id, entry.version);
        touchedRepos.add(repoPath);

        // Count as new or updated
        if (existing === null) {
          result.new_entries++;
        } else {
          result.updated++;
        }
      }
    }
  });
  processEntries();

  // === Clean up old files (moves, type changes, deletions) ===

  for (const repo of config.repos) {
    if (!existsSync(repo.path)) continue;

    // getRepoEntryIds returns 8-char prefixes
    const repoIds = getRepoEntryIds(repo.path);
    for (const id8Prefix of repoIds) {
      // If entry no longer exists locally, delete it
      if (!localEntryId8s.has(id8Prefix)) {
        // We need to find and delete by ID prefix — deleteEntryFile uses findEntryFile
        // which matches on the suffix. We need to construct a fake full ID with the prefix.
        // Since deleteEntryFile uses id8() internally, any ID starting with this prefix works.
        deleteEntryFile(repo.path, id8Prefix);
        result.deleted++;
        touchedRepos.add(repo.path);
        continue;
      }
    }

    // Check entries that exist locally but belong to a DIFFERENT repo (move)
    for (const [fullId, correctRepo] of entryRepoMap) {
      if (correctRepo !== repo.path) {
        // Try to delete from this repo — deleteEntryFile is a no-op if file isn't there
        deleteEntryFile(repo.path, fullId);
        // Don't count as deleted since it's just moving; mark repo as touched if file existed
        touchedRepos.add(repo.path);
      }
    }

    // Clean up redirect markers — they've served their purpose
    const cleaned = cleanupRedirectFiles(repo.path);
    if (cleaned > 0) {
      touchedRepos.add(repo.path);
    }
  }

  // === Push links ===

  const localLinks = getAllLinks();
  const localLinkIds = new Set<string>();
  const linkRepoMap = new Map<string, string>();

  // Batch link processing in a transaction for performance.
  const processLinks = db.transaction(() => {
    for (const link of localLinks) {
      // Skip conflict-related links (never synced to repo)
      if (link.source === 'sync:conflict') continue;
      if (link.link_type === 'conflicts_with') continue;

      localLinkIds.add(link.id);

      // Resolve repo based on source entry's repo
      const sourceRepo = entryRepoMap.get(link.source_id);
      
      if (sourceRepo) {
        const json = linkToJSON(link);
        const serialized = JSON.stringify(json, null, 2) + '\n';
        const existing = readLinkFileRaw(sourceRepo, link.id);

        if (existing === serialized) {
          // File is byte-identical — skip write
          updateLinkSyncedAt(link.id);
        } else {
          writeLinkFile(sourceRepo, json);
          linkRepoMap.set(link.id, sourceRepo);
          touchedRepos.add(sourceRepo);

          // Count as new or updated
          if (existing === null) {
            result.new_links++;
          }

          // Mark link as synced
          updateLinkSyncedAt(link.id);
        }
      }
    }
  });
  processLinks();

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

    // Always push — there may be unpushed write-through commits (async — doesn't block)
    await gitPush(repo.path);
  }

  return result;
}
