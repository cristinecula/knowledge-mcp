/**
 * Write-through: after every local SQLite write, also update the sync repo.
 *
 * This module provides thin wrappers that tools call after their normal
 * DB operations. If sync is disabled, these are no-ops.
 */

import { getSyncRepo, isSyncEnabled } from './config.js';
import { entryToJSON, linkToJSON } from './serialize.js';
import {
  writeEntryFile,
  writeLinkFile,
  deleteEntryFile,
  deleteLinkFile,
  ensureRepoStructure,
} from './fs.js';
import { updateSyncedAt } from '../db/queries.js';
import type { KnowledgeEntry, KnowledgeLink, KnowledgeType } from '../types.js';

/**
 * Write-through an entry to the sync repo after a local write.
 * Handles type changes by cleaning up old files.
 */
export function syncWriteEntry(entry: KnowledgeEntry, oldType?: KnowledgeType): void {
  if (!isSyncEnabled()) return;

  const repoPath = getSyncRepo()!;

  try {
    ensureRepoStructure(repoPath);

    // If type changed, delete the old file first
    if (oldType && oldType !== entry.type) {
      deleteEntryFile(repoPath, entry.id, oldType);
    }

    const json = entryToJSON(entry);
    writeEntryFile(repoPath, json);
    updateSyncedAt(entry.id);
  } catch (error) {
    console.error(`Warning: sync write-through failed for entry ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Write-through a link to the sync repo after a local write.
 */
export function syncWriteLink(link: KnowledgeLink): void {
  if (!isSyncEnabled()) return;

  const repoPath = getSyncRepo()!;

  try {
    ensureRepoStructure(repoPath);
    const json = linkToJSON(link);
    writeLinkFile(repoPath, json);
  } catch (error) {
    console.error(`Warning: sync write-through failed for link ${link.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Delete an entry file from the sync repo after a local delete.
 */
export function syncDeleteEntry(id: string, type?: KnowledgeType): void {
  if (!isSyncEnabled()) return;

  const repoPath = getSyncRepo()!;

  try {
    deleteEntryFile(repoPath, id, type);
  } catch (error) {
    console.error(`Warning: sync delete failed for entry ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Delete a link file from the sync repo after a local delete.
 */
export function syncDeleteLink(id: string): void {
  if (!isSyncEnabled()) return;

  const repoPath = getSyncRepo()!;

  try {
    deleteLinkFile(repoPath, id);
  } catch (error) {
    console.error(`Warning: sync delete failed for link ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
