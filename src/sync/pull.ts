/**
 * Pull: import remote changes from the sync repo into the local SQLite database.
 *
 * For each remote entry:
 * - New -> insert into local DB with synced_version = remote.version
 * - Existing, no conflict -> apply remote changes or skip, update synced_version
 * - Existing, true conflict -> remote wins as canonical, local saved as [Sync Conflict]
 *
 * For entries deleted remotely (in local DB with synced_at but not in repo):
 * - Delete from local DB
 *
 * Conflict resolution is "remote wins": the remote version overwrites the local
 * entry (stays active), and the local content is preserved as a new [Sync Conflict]
 * entry with a 'conflicts_with' link for the agent to resolve.
 */

import { existsSync } from 'node:fs';
import {
  getKnowledgeById,
  getAllEntries,
  getAllLinks,
  importKnowledge,
  importLink,
  updateKnowledgeContent,
  updateSyncedVersion,
  updateStatus,
  deleteKnowledge,
  deleteLink,
  insertKnowledge,
  insertLink,
} from '../db/queries.js';
import { embedAndStore } from '../embeddings/similarity.js';
import { detectConflict } from './merge.js';
import {
  readAllEntryFiles,
  readAllLinkFiles,
  ensureRepoStructure,
} from './fs.js';
import { gitPull } from './git.js';
import type { EntryJSON } from './serialize.js';
import type { KnowledgeType, LinkType, Scope, Status } from '../types.js';

export interface PullResult {
  new_entries: number;
  updated: number;
  deleted: number;
  conflicts: number;
  conflict_details: ConflictDetail[];
  new_links: number;
  deleted_links: number;
}

export interface ConflictDetail {
  original_id: string;
  conflict_id: string;
  title: string;
  reason: string;
}

/**
 * Pull changes from the sync repo into the local database.
 */
export async function pull(config: import('./routing.js').SyncConfig): Promise<PullResult> {
  const result: PullResult = {
    new_entries: 0,
    updated: 0,
    deleted: 0,
    conflicts: 0,
    conflict_details: [],
    new_links: 0,
    deleted_links: 0,
  };

  // 1. Git pull + read all entries from all repos
  const remoteEntries = new Map<string, EntryJSON>();
  const remoteLinks = new Map<string, import('./serialize.js').LinkJSON>();
  const repoEntryIds = new Set<string>();
  const repoLinkIds = new Set<string>();

  for (const repo of config.repos) {
    if (!existsSync(repo.path)) continue;

    // Pull remote changes (async -- doesn't block the event loop)
    await gitPull(repo.path);

    ensureRepoStructure(repo.path);

    // Read entries
    const entries = readAllEntryFiles(repo.path);
    for (const entry of entries) {
      // First repo wins for duplicates (based on config order)
      if (!remoteEntries.has(entry.id)) {
        remoteEntries.set(entry.id, entry);
        repoEntryIds.add(entry.id);
      }
    }

    // Read links
    const links = readAllLinkFiles(repo.path);
    for (const link of links) {
      if (!remoteLinks.has(link.id)) {
        remoteLinks.set(link.id, link);
        repoLinkIds.add(link.id);
      }
    }
  }

  // 2. Process entries (new, updated, conflict)
  for (const remote of remoteEntries.values()) {
    const local = getKnowledgeById(remote.id);

    if (!local) {
      // New entry from remote -- import it with synced_version = remote.version
      try {
        importKnowledge({
          id: remote.id,
          type: remote.type,
          title: remote.title,
          content: remote.content,
          tags: remote.tags,
          project: remote.project,
          scope: remote.scope,
          source: remote.source,
          status: remote.status,
          deprecation_reason: remote.deprecation_reason ?? null,
          flag_reason: remote.flag_reason ?? null,
          declaration: remote.declaration ?? null,
          parent_page_id: remote.parent_page_id ?? null,
          created_at: remote.created_at,
          version: remote.version,
        });
        result.new_entries++;

        // Generate embedding for new entry
        try {
          await embedAndStore(remote.id, remote.title, remote.content, remote.tags);
        } catch {
          // Non-fatal: embedding generation can fail
        }
      } catch (error) {
        console.error(`Warning: Failed to import entry ${remote.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    // Entry exists locally -- check for conflicts
    const mergeResult = detectConflict(local, remote);

    switch (mergeResult.action) {
      case 'no_change':
        // Update synced_version to reflect we're in sync
        updateSyncedVersion(local.id, remote.version);
        break;

      case 'remote_wins':
        // Apply remote changes to local (keep local memory fields)
        updateKnowledgeContent(local.id, {
          type: remote.type as KnowledgeType,
          title: remote.title,
          content: remote.content,
          tags: remote.tags,
          project: remote.project,
          scope: remote.scope as Scope,
          source: remote.source,
          status: remote.status as Status,
          deprecation_reason: remote.deprecation_reason ?? null,
          flag_reason: remote.flag_reason ?? null,
          declaration: remote.declaration ?? null,
          parent_page_id: remote.parent_page_id ?? null,
          version: remote.version,
        });
        result.updated++;

        // Re-generate embedding
        try {
          await embedAndStore(local.id, remote.title, remote.content, remote.tags);
        } catch {
          // Non-fatal
        }
        break;

      case 'local_wins':
        // Keep local content, update synced_version to remote.version
        // This marks us as "aware" of the remote state but keeping local changes
        updateSyncedVersion(local.id, remote.version);
        break;

      case 'conflict': {
        // Flipped conflict resolution: REMOTE wins as canonical, LOCAL saved as conflict copy.
        //
        // 1. Save LOCAL content as [Sync Conflict] entry with needs_revalidation
        // 2. Accept REMOTE as canonical -- overwrite local entry, stays active
        // 3. Create conflicts_with link (conflict copy -> canonical, source: 'sync:conflict')
        // 4. No needs_revalidation on the canonical entry

        // Step 1: Save local content as conflict entry
        const conflictEntry = insertKnowledge({
          type: local.type,
          title: `[Sync Conflict] ${local.title}`,
          content: local.content,
          tags: local.tags,
          project: local.project,
          scope: local.scope,
          source: 'sync:conflict',
        });

        // Mark conflict copy as needs_revalidation so agents know to resolve it
        updateStatus(conflictEntry.id, 'needs_revalidation');

        // Step 2: Accept remote as canonical -- overwrite local entry
        updateKnowledgeContent(local.id, {
          type: remote.type as KnowledgeType,
          title: remote.title,
          content: remote.content,
          tags: remote.tags,
          project: remote.project,
          scope: remote.scope as Scope,
          source: remote.source,
          status: remote.status as Status,
          deprecation_reason: remote.deprecation_reason ?? null,
          flag_reason: remote.flag_reason ?? null,
          declaration: remote.declaration ?? null,
          parent_page_id: remote.parent_page_id ?? null,
          version: remote.version,
        });

        // Step 3: Create conflicts_with link from conflict copy -> canonical
        try {
          insertLink({
            sourceId: conflictEntry.id,
            targetId: local.id,
            linkType: 'conflicts_with',
            description: 'Sync conflict: both local and remote modified since last sync. This entry contains the local version; the linked entry has the remote (canonical) version.',
            source: 'sync:conflict',
          });
        } catch {
          // Link creation can fail if a link already exists
        }

        result.conflicts++;
        result.conflict_details.push({
          original_id: local.id,
          conflict_id: conflictEntry.id,
          title: remote.title,
          reason: 'Both local and remote modified since last sync. Remote accepted as canonical; local saved as conflict copy.',
        });

        // Re-generate embedding for the canonical entry
        try {
          await embedAndStore(local.id, remote.title, remote.content, remote.tags);
        } catch {
          // Non-fatal
        }
        break;
      }
    }
  }

  // 3. Detect remote deletions (entries synced before but missing from repo)
  const localEntries = getAllEntries();

  for (const local of localEntries) {
    if (local.synced_at && !repoEntryIds.has(local.id)) {
      // Skip conflict entries -- they're local-only resolution artifacts
      if (local.title.startsWith('[Sync Conflict]')) continue;

      deleteKnowledge(local.id);
      result.deleted++;
    }
  }

  // 4. Process links (new)
  for (const remote of remoteLinks.values()) {
    // Check both referenced entries exist locally
    const sourceExists = getKnowledgeById(remote.source_id);
    const targetExists = getKnowledgeById(remote.target_id);

    if (!sourceExists || !targetExists) {
      // Skip links where either end is missing locally
      continue;
    }

    try {
      const imported = importLink({
        id: remote.id,
        sourceId: remote.source_id,
        targetId: remote.target_id,
        linkType: remote.link_type as LinkType,
        description: remote.description ?? undefined,
        source: remote.source,
        created_at: remote.created_at,
      });
      if (imported) {
        result.new_links++;
      }
    } catch {
      // Skip links that can't be imported (e.g., duplicate or FK issue)
    }
  }

  // 5. Detect remote link deletions
  // Only delete links that have been synced before (synced_at is set).
  // Links created locally (synced_at IS NULL) are preserved -- they haven't
  // been pushed yet, so their absence from the repo doesn't mean they were
  // deleted remotely.
  const localLinks = getAllLinks();

  for (const local of localLinks) {
    if (local.synced_at && !repoLinkIds.has(local.id)) {
      // Don't delete conflict-related links
      if (local.source === 'sync:conflict') continue;

      deleteLink(local.id);
      result.deleted_links++;
    }
  }

  return result;
}
