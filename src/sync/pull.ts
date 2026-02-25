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
  getOutgoingLinks,
  importKnowledge,
  importLink,
  updateKnowledgeContent,
  updateSyncedVersion,
  setInaccuracy,
  deleteKnowledge,
  deleteLink,
  insertKnowledge,
  insertLink,
} from '../db/queries.js';
import { embedAndStore } from '../embeddings/similarity.js';
import { detectConflict } from './merge.js';
import {
  readAllEntryFiles,
  ensureRepoStructure,
} from './fs.js';
import { gitPull } from './git.js';
import { deterministicLinkId } from './serialize.js';
import type { EntryJSON } from './serialize.js';
import type { KnowledgeType, LinkType, Scope, Status } from '../types.js';
import { INACCURACY_THRESHOLD } from '../types.js';

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
  const repoEntryIds = new Set<string>();

  for (const repo of config.repos) {
    if (!existsSync(repo.path)) continue;

    // Pull remote changes (async -- doesn't block the event loop)
    await gitPull(repo.path);

    ensureRepoStructure(repo.path);

    // Read entries (links are embedded in entry frontmatter)
    const entries = readAllEntryFiles(repo.path);
    for (const entry of entries) {
      // First repo wins for duplicates (based on config order)
      if (!remoteEntries.has(entry.id)) {
        remoteEntries.set(entry.id, entry);
        repoEntryIds.add(entry.id);
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
          inaccuracy: remote.inaccuracy ?? 0,
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
          inaccuracy: remote.inaccuracy ?? 0,
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

        // Mark conflict copy with high inaccuracy so agents know to resolve it
        setInaccuracy(conflictEntry.id, INACCURACY_THRESHOLD);

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
          inaccuracy: remote.inaccuracy ?? 0,
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

  // 4. Import links from entry frontmatter
  //
  // Each remote entry may have a `links` array in its frontmatter (outgoing links).
  // We import these using deterministic IDs so the same link always gets the same
  // UUID across machines, preventing duplicates.
  //
  // We also track which link IDs should exist (from remote entries) so we can
  // clean up orphaned links in step 5.
  const remoteLinkIds = new Set<string>();

  for (const remote of remoteEntries.values()) {
    if (!remote.links || remote.links.length === 0) continue;

    for (const fmLink of remote.links) {
      const linkId = deterministicLinkId(remote.id, fmLink.target, fmLink.type);
      remoteLinkIds.add(linkId);

      // Check target entry exists locally
      const targetExists = getKnowledgeById(fmLink.target);
      if (!targetExists) continue;

      try {
        const imported = importLink({
          id: linkId,
          sourceId: remote.id,
          targetId: fmLink.target,
          linkType: fmLink.type as LinkType,
          description: fmLink.description,
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
  }

  // 5. Clean up orphaned links
  //
  // For each synced entry that exists in the remote, check its local outgoing
  // links. If a link was previously synced (synced_at is set) but its
  // deterministic ID is no longer in the remote set, it was deleted remotely.
  // Don't touch conflict-related links (local-only) or un-synced links.
  for (const remote of remoteEntries.values()) {
    const localOutgoing = getOutgoingLinks(remote.id);
    for (const local of localOutgoing) {
      // Don't touch conflict-related links
      if (local.source === 'sync:conflict') continue;
      if (local.link_type === 'conflicts_with') continue;

      // Only clean up links that have been synced before
      if (!local.synced_at) continue;

      // If the deterministic ID for this link isn't in the remote set, delete it
      const expectedId = deterministicLinkId(local.source_id, local.target_id, local.link_type);
      if (!remoteLinkIds.has(expectedId) && !remoteLinkIds.has(local.id)) {
        deleteLink(local.id);
        result.deleted_links++;
      }
    }
  }

  return result;
}
