/**
 * Pull: import remote changes from the sync repo into the local SQLite database.
 *
 * For each remote entry:
 * - New → insert into local DB
 * - Existing, no conflict → apply remote changes or skip
 * - Existing, true conflict → keep both, create [Sync Conflict] entry
 *
 * For entries deleted remotely (in local DB with synced_at but not in repo):
 * - Delete from local DB
 */

import { existsSync } from 'node:fs';
import {
  getKnowledgeById,
  getAllEntries,
  getAllLinks,
  importKnowledge,
  importLink,
  updateKnowledgeContent,
  updateSyncedAt,
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
  getRepoEntryIds,
  getRepoLinkIds,
  ensureRepoStructure,
} from './fs.js';
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
export async function pull(repoPath: string): Promise<PullResult> {
  if (!existsSync(repoPath)) {
    throw new Error(`Sync repo not found: ${repoPath}`);
  }

  ensureRepoStructure(repoPath);

  const result: PullResult = {
    new_entries: 0,
    updated: 0,
    deleted: 0,
    conflicts: 0,
    conflict_details: [],
    new_links: 0,
    deleted_links: 0,
  };

  // === Pull entries ===

  const remoteEntries = readAllEntryFiles(repoPath);
  const remoteEntryMap = new Map<string, EntryJSON>();
  for (const re of remoteEntries) {
    remoteEntryMap.set(re.id, re);
  }

  for (const remote of remoteEntries) {
    const local = getKnowledgeById(remote.id);

    if (!local) {
      // New entry from remote — import it
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
          created_at: remote.created_at,
          updated_at: remote.updated_at,
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

    // Entry exists locally — check for conflicts
    const mergeResult = detectConflict(local, remote);

    switch (mergeResult.action) {
      case 'no_change':
        // Update synced_at to track that we've seen this version
        updateSyncedAt(local.id);
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
          updated_at: remote.updated_at,
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
        // Keep local content, just update synced_at
        updateSyncedAt(local.id);
        break;

      case 'conflict': {
        // Keep both versions:
        // 1. Local stays as-is but flagged needs_revalidation
        // 2. Create a new conflict entry with remote content + contradicts link

        // Flag local entry
        if (local.status !== 'deprecated' && local.status !== 'dormant') {
          updateStatus(local.id, 'needs_revalidation');
        }
        updateSyncedAt(local.id);

        // Create conflict entry with remote content
        const conflictEntry = insertKnowledge({
          type: remote.type as KnowledgeType,
          title: `[Sync Conflict] ${remote.title}`,
          content: remote.content,
          tags: remote.tags,
          project: remote.project,
          scope: remote.scope as Scope,
          source: 'sync:conflict',
        });

        // Flag conflict entry too
        updateStatus(conflictEntry.id, 'needs_revalidation');

        // Create contradicts link from conflict → original
        try {
          insertLink({
            sourceId: conflictEntry.id,
            targetId: local.id,
            linkType: 'contradicts',
            description: 'Sync conflict: both local and remote modified since last sync',
            source: 'sync:conflict',
          });
        } catch {
          // Link creation can fail if a contradicts link already exists
        }

        result.conflicts++;
        result.conflict_details.push({
          original_id: local.id,
          conflict_id: conflictEntry.id,
          title: remote.title,
          reason: 'Both local and remote modified since last sync',
        });
        break;
      }
    }
  }

  // === Detect remote deletions ===
  // Entries in local DB with synced_at set (previously synced) but not in the repo

  const repoEntryIds = getRepoEntryIds(repoPath);
  const localEntries = getAllEntries();

  for (const local of localEntries) {
    if (local.synced_at && !repoEntryIds.has(local.id)) {
      // Skip conflict entries — they're local-only and shouldn't be deleted
      if (local.title.startsWith('[Sync Conflict]')) continue;

      deleteKnowledge(local.id);
      result.deleted++;
    }
  }

  // === Pull links ===

  const remoteLinks = readAllLinkFiles(repoPath);

  for (const remote of remoteLinks) {
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
      // Skip links that can't be imported (e.g., FK constraint violations)
    }
  }

  // === Detect remote link deletions ===

  const repoLinkIds = getRepoLinkIds(repoPath);
  const localLinks = getAllLinks();

  for (const local of localLinks) {
    // Only delete links that were previously synced (exist in a synced entry context)
    // We can't track synced_at on links directly, so we check if the link ID was
    // known to the repo at some point by checking if both its entries are synced
    const sourceEntry = getKnowledgeById(local.source_id);
    const targetEntry = getKnowledgeById(local.target_id);

    const bothEntriesSynced = sourceEntry?.synced_at && targetEntry?.synced_at;

    if (bothEntriesSynced && !repoLinkIds.has(local.id)) {
      // Don't delete conflict-related links
      if (local.source === 'sync:conflict') continue;

      deleteLink(local.id);
      result.deleted_links++;
    }
  }

  return result;
}
