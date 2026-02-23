/**
 * Entry version history via git.
 *
 * Resolves a knowledge entry ID to its git file path and retrieves
 * commit history and historical versions. Bridges the DB (entry lookup),
 * sync routing (repo resolution), and git layer (log/show).
 */

import { relative } from 'node:path';
import { getKnowledgeById } from '../db/queries.js';
import { getSyncConfig } from './config.js';
import { resolveRepo } from './routing.js';
import { entryFilePath } from './fs.js';
import { gitFileLog, gitShowFile, type GitLogEntry } from './git.js';
import { parseEntryJSON, type EntryJSON } from './serialize.js';

export type { GitLogEntry as HistoryCommit } from './git.js';

/**
 * Get the git commit history for a knowledge entry.
 *
 * Returns an array of commits (newest first) that modified the entry's JSON file.
 * Returns [] if sync is not configured, the entry doesn't exist, or the file
 * has never been committed.
 */
export function getEntryHistory(id: string, limit = 20): GitLogEntry[] {
  const entry = getKnowledgeById(id);
  if (!entry) return [];

  const config = getSyncConfig();
  if (!config) return [];

  const repo = resolveRepo(entry, config);
  const filePath = entryFilePath(repo.path, entry.type, entry.id);

  return gitFileLog(repo.path, filePath, limit);
}

/**
 * Get the full entry content at a specific git commit.
 *
 * Returns the parsed EntryJSON as it existed at that commit, or null if
 * the entry/commit doesn't exist or the content can't be parsed.
 */
export function getEntryAtCommit(id: string, commitHash: string): EntryJSON | null {
  const entry = getKnowledgeById(id);
  if (!entry) return null;

  const config = getSyncConfig();
  if (!config) return null;

  const repo = resolveRepo(entry, config);
  const filePath = entryFilePath(repo.path, entry.type, entry.id);
  const relPath = relative(repo.path, filePath);

  const content = gitShowFile(repo.path, commitHash, relPath);
  if (!content) return null;

  try {
    const data = JSON.parse(content);
    return parseEntryJSON(data);
  } catch {
    return null;
  }
}
