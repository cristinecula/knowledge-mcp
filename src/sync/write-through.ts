/**
 * Write-through: after every local SQLite write, also update the sync repo.
 *
 * This module provides thin wrappers that tools call after their normal
 * DB operations. If sync is disabled, these are no-ops.
 *
 * Multi-repo aware: routes writes to the correct repo based on entry scope/project.
 */

import { getSyncConfig, isSyncEnabled } from './config.js';
import { entryToJSON } from './serialize.js';
import type { FrontmatterLink } from './serialize.js';
import {
  writeEntryFile,
  deleteEntryFile,
  ensureRepoStructure,
} from './fs.js';
import { getOutgoingLinks } from '../db/queries.js';
import { resolveRepoForScope } from './routing.js';
import type { KnowledgeEntry, KnowledgeType, Scope } from '../types.js';

/**
 * Track which repos have pending changes that need a git commit.
 * The tools read this set to trigger gitCommitAll() for touched repos.
 */
export const touchedRepos = new Set<string>();

/**
 * Clear the touched repos set (after a commit).
 */
export function clearTouchedRepos(): void {
  touchedRepos.clear();
}

/**
 * Build FrontmatterLink[] from the entry's current outgoing links in the DB.
 * Filters out conflict-related links (sync:conflict source, conflicts_with type).
 */
function getEntryFrontmatterLinks(entryId: string): FrontmatterLink[] | undefined {
  const outgoing = getOutgoingLinks(entryId);
  const links: FrontmatterLink[] = [];
  for (const link of outgoing) {
    // Skip conflict-related links — they're local-only
    if (link.source === 'sync:conflict') continue;
    if (link.link_type === 'conflicts_with') continue;

    const fmLink: FrontmatterLink = { target: link.target_id, type: link.link_type };
    if (link.description) fmLink.description = link.description;
    links.push(fmLink);
  }
  return links.length > 0 ? links : undefined;
}

/**
 * Write-through an entry to the sync repo after a local write.
 * Includes outgoing links in the entry's frontmatter.
 *
 * Handles:
 * 1. Type changes (delete old file if needed)
 * 2. Scope/Project changes (move to new repo if needed)
 */
export function syncWriteEntry(
  entry: KnowledgeEntry,
  oldType?: KnowledgeType,
  oldScope?: string,
  oldProject?: string | null,
): void {
  if (!isSyncEnabled()) return;

  const config = getSyncConfig()!;

  // 1. Resolve target repo for current entry
  const targetRepo = resolveRepoForScope(entry.scope, entry.project, config);
  const repoPath = targetRepo.path;

  try {
    ensureRepoStructure(repoPath);

    // 2. Check if moved from another repo (scope/project changed)
    if (oldScope && oldProject !== undefined) {
      const oldRepo = resolveRepoForScope(oldScope as Scope, oldProject, config);
      if (oldRepo.path !== repoPath) {
        // Entry moved between repos — delete from old repo
        deleteEntryFile(oldRepo.path, entry.id, oldType);
        touchedRepos.add(oldRepo.path);
      }
    }

    // 3. Check if type changed within same repo (delete old file)
    if (oldType && oldType !== entry.type) {
      deleteEntryFile(repoPath, entry.id, oldType);
    }

    // 4. Write entry file with links in frontmatter
    // NOTE: Do NOT call updateSyncedAt here. synced_at tracks when the entry
    // was last reconciled with the remote (import or push). Write-through puts
    // the file on disk but it hasn't been pushed yet. Updating synced_at here
    // would cause detectConflict to miss local changes (content_updated_at
    // would equal synced_at, so localChanged would be false).
    const json = entryToJSON(entry);
    json.links = getEntryFrontmatterLinks(entry.id);
    writeEntryFile(repoPath, json);
    touchedRepos.add(repoPath);

  } catch (error) {
    console.error(`Warning: sync write-through failed for entry ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Write-through an entry with its links after a link mutation.
 *
 * Called after insertLink/deleteLink — rewrites the source entry's .md file
 * with the current set of outgoing links in the frontmatter.
 */
export function syncWriteEntryWithLinks(sourceEntry: KnowledgeEntry): void {
  // Delegate to syncWriteEntry which now always includes links
  syncWriteEntry(sourceEntry);
}

/**
 * Delete an entry file from the sync repo after a local delete.
 * Since we don't know which repo it was in (without querying local DB before delete),
 * we search all configured repos and delete if found.
 */
export function syncDeleteEntry(id: string, type?: KnowledgeType): void {
  if (!isSyncEnabled()) return;

  const config = getSyncConfig()!;

  for (const repo of config.repos) {
    try {
      // deleteEntryFile returns true if it deleted something? No, void.
      // But we can check existence first if we cared. deleteEntryFile handles "not found" gracefully.
      deleteEntryFile(repo.path, id, type);
      touchedRepos.add(repo.path);
    } catch {
      // Ignore errors (e.g., file not found in this repo)
    }
  }
}
