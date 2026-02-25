/**
 * Entry version history via git.
 *
 * Resolves a knowledge entry ID to its git file path and retrieves
 * commit history and historical versions. Bridges the DB (entry lookup),
 * sync routing (repo resolution), and git layer (log/show).
 *
 * Note: After the JSON→Markdown migration, history for old JSON-era commits
 * is not available (files were at different paths with a different format).
 */

import { relative } from 'node:path';
import { getKnowledgeById } from '../db/queries.js';
import { getSyncConfig } from './config.js';
import { resolveRepo } from './routing.js';
import { entryFilePath, findEntryFile } from './fs.js';
import { gitFileLog, gitShowFile, type GitLogEntry } from './git.js';
import { parseEntryMarkdown, type EntryJSON } from './serialize.js';

export type { GitLogEntry as HistoryCommit } from './git.js';

/**
 * Get the git commit history for a knowledge entry.
 *
 * Returns an array of commits (newest first) that modified the entry's Markdown file.
 * Returns [] if sync is not configured, the entry doesn't exist, or the file
 * has never been committed.
 */
export function getEntryHistory(id: string, limit = 20): GitLogEntry[] {
  const entry = getKnowledgeById(id);
  if (!entry) return [];

  const config = getSyncConfig();
  if (!config) return [];

  const repo = resolveRepo(entry, config);

  // Try deterministic path first, fall back to directory scan
  const filePath = entryFilePath(repo.path, entry.type, entry.id, entry.title);
  const foundPath = findEntryFile(repo.path, entry.type, entry.id);
  const actualPath = foundPath ?? filePath;

  return gitFileLog(repo.path, actualPath, limit);
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

  // Try deterministic path first, fall back to directory scan
  const filePath = entryFilePath(repo.path, entry.type, entry.id, entry.title);
  const foundPath = findEntryFile(repo.path, entry.type, entry.id);
  const actualPath = foundPath ?? filePath;
  const relPath = relative(repo.path, actualPath);

  const content = gitShowFile(repo.path, commitHash, relPath);
  if (!content) return null;

  try {
    return parseEntryMarkdown(content);
  } catch {
    return null;
  }
}

/** Result of getEntryAtCommitWithParent — the entry at a commit and optionally its parent version. */
export interface CommitWithParent {
  entry: EntryJSON;
  parent: EntryJSON | null;
}

/**
 * Get the entry content at a specific commit and at its parent commit.
 *
 * Used for diff rendering: `entry` is the version at `commitHash`,
 * `parent` is the version at `commitHash~1` (null for the first commit).
 */
export function getEntryAtCommitWithParent(id: string, commitHash: string): CommitWithParent | null {
  const entry = getKnowledgeById(id);
  if (!entry) return null;

  const config = getSyncConfig();
  if (!config) return null;

  const repo = resolveRepo(entry, config);

  // Try deterministic path first, fall back to directory scan
  const filePath = entryFilePath(repo.path, entry.type, entry.id, entry.title);
  const foundPath = findEntryFile(repo.path, entry.type, entry.id);
  const actualPath = foundPath ?? filePath;
  const relPath = relative(repo.path, actualPath);

  // Fetch entry at the requested commit
  const content = gitShowFile(repo.path, commitHash, relPath);
  if (!content) return null;

  let parsedEntry: EntryJSON;
  try {
    parsedEntry = parseEntryMarkdown(content);
  } catch {
    return null;
  }

  // Fetch entry at parent commit (commitHash~1)
  let parsedParent: EntryJSON | null = null;
  const parentContent = gitShowFile(repo.path, `${commitHash}~1`, relPath);
  if (parentContent) {
    try {
      parsedParent = parseEntryMarkdown(parentContent);
    } catch {
      // Parent version can't be parsed — treat as no parent (new file)
    }
  }

  return { entry: parsedEntry, parent: parsedParent };
}
