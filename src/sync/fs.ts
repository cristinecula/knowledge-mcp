/**
 * File system operations for the sync repo.
 *
 * Reads and writes JSON files organized as:
 *   entries/{type}/{id}.json
 *   links/{id}.json
 *   meta.json
 *
 * SECURITY: All file path construction validates that the resolved path
 * stays within the repo root directory. This prevents path traversal
 * attacks via crafted IDs or types in repo JSON files.
 */

import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { KNOWLEDGE_TYPES } from '../types.js';
import type { KnowledgeType } from '../types.js';
import { type EntryJSON, type LinkJSON, parseEntryJSON, parseLinkJSON } from './serialize.js';
import { SYNC_SCHEMA_VERSION } from './config.js';

/**
 * Verify that a resolved file path stays within the expected root directory.
 * Throws if the path escapes the root (path traversal attempt).
 */
function assertWithinRoot(filePath: string, rootPath: string): void {
  const resolvedRoot = resolve(rootPath);
  const resolvedFile = resolve(filePath);
  // Ensure the file path starts with the root path + separator (or is the root itself)
  if (!resolvedFile.startsWith(resolvedRoot + '/') && resolvedFile !== resolvedRoot) {
    throw new Error(`Path traversal detected: "${filePath}" escapes root "${rootPath}"`);
  }
}

// Cache of repo paths that have been verified to have correct structure.
// Avoids ~9 existsSync calls on every write-through after the first check.
const verifiedRepos = new Set<string>();

/** Invalidate the structure cache for a repo path. Call after operations
 *  that may remove directories (e.g., `git clean -fd`). */
export function invalidateRepoCache(repoPath: string): void {
  verifiedRepos.delete(repoPath);
}

/** Ensure the sync repo directory structure exists. Caches result per repo path. */
export function ensureRepoStructure(repoPath: string): void {
  if (verifiedRepos.has(repoPath)) return;

  // Create entries directories for each type
  for (const type of KNOWLEDGE_TYPES) {
    const dir = resolve(repoPath, 'entries', type);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Create links directory
  const linksDir = resolve(repoPath, 'links');
  if (!existsSync(linksDir)) {
    mkdirSync(linksDir, { recursive: true });
  }

  // Create meta.json if it doesn't exist
  const metaPath = resolve(repoPath, 'meta.json');
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, JSON.stringify({ schema_version: SYNC_SCHEMA_VERSION }, null, 2) + '\n');
  }

  verifiedRepos.add(repoPath);
}

/** Get the file path for an entry JSON file. Validates path stays within repo. */
export function entryFilePath(repoPath: string, type: KnowledgeType, id: string): string {
  const filePath = resolve(repoPath, 'entries', type, `${id}.json`);
  assertWithinRoot(filePath, repoPath);
  return filePath;
}

/** Get the file path for a link JSON file. Validates path stays within repo. */
export function linkFilePath(repoPath: string, id: string): string {
  const filePath = resolve(repoPath, 'links', `${id}.json`);
  assertWithinRoot(filePath, repoPath);
  return filePath;
}

/** Write an entry JSON file. */
export function writeEntryFile(repoPath: string, entry: EntryJSON): void {
  const filePath = entryFilePath(repoPath, entry.type, entry.id);
  writeFileSync(filePath, JSON.stringify(entry, null, 2) + '\n');
}

/** Read an entry JSON file and return its raw string content (for comparison). Returns null if the file doesn't exist. */
export function readEntryFileRaw(repoPath: string, type: KnowledgeType, id: string): string | null {
  const filePath = entryFilePath(repoPath, type, id);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

/** Read a link JSON file and return its raw string content (for comparison). Returns null if the file doesn't exist. */
export function readLinkFileRaw(repoPath: string, id: string): string | null {
  const filePath = linkFilePath(repoPath, id);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

/** Write a link JSON file. */
export function writeLinkFile(repoPath: string, link: LinkJSON): void {
  const filePath = linkFilePath(repoPath, link.id);
  writeFileSync(filePath, JSON.stringify(link, null, 2) + '\n');
}

/** Delete an entry JSON file. Handles type not being known by searching all type dirs. */
export function deleteEntryFile(repoPath: string, id: string, type?: KnowledgeType): void {
  if (type) {
    const filePath = entryFilePath(repoPath, type, id);
    if (existsSync(filePath)) unlinkSync(filePath);
    return;
  }

  // Search all type directories for the file
  for (const t of KNOWLEDGE_TYPES) {
    const filePath = entryFilePath(repoPath, t as KnowledgeType, id);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return;
    }
  }
}

/** Delete a link JSON file. */
export function deleteLinkFile(repoPath: string, id: string): void {
  const filePath = linkFilePath(repoPath, id);
  if (existsSync(filePath)) unlinkSync(filePath);
}

/** Read all entry JSON files from the repo. */
export function readAllEntryFiles(repoPath: string): EntryJSON[] {
  const entries: EntryJSON[] = [];
  const entriesDir = resolve(repoPath, 'entries');

  if (!existsSync(entriesDir)) return entries;

  for (const type of KNOWLEDGE_TYPES) {
    const typeDir = resolve(entriesDir, type);
    if (!existsSync(typeDir)) continue;

    const files = readdirSync(typeDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const filePath = join(typeDir, file);
        assertWithinRoot(filePath, repoPath);
        const content = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content);
        entries.push(parseEntryJSON(data));
      } catch (error) {
        console.error(`Warning: Failed to parse ${type}/${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return entries;
}

/** Read all link JSON files from the repo. */
export function readAllLinkFiles(repoPath: string): LinkJSON[] {
  const links: LinkJSON[] = [];
  const linksDir = resolve(repoPath, 'links');

  if (!existsSync(linksDir)) return links;

  const files = readdirSync(linksDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const filePath = join(linksDir, file);
      assertWithinRoot(filePath, repoPath);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      links.push(parseLinkJSON(data));
    } catch (error) {
      console.error(`Warning: Failed to parse link ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return links;
}

/** Get all entry IDs present in the repo (for detecting remote deletions). */
export function getRepoEntryIds(repoPath: string): Set<string> {
  const ids = new Set<string>();
  const entriesDir = resolve(repoPath, 'entries');

  if (!existsSync(entriesDir)) return ids;

  for (const type of KNOWLEDGE_TYPES) {
    const typeDir = resolve(entriesDir, type);
    if (!existsSync(typeDir)) continue;

    const files = readdirSync(typeDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      ids.add(file.replace('.json', ''));
    }
  }

  return ids;
}

/** Get all link IDs present in the repo. */
export function getRepoLinkIds(repoPath: string): Set<string> {
  const ids = new Set<string>();
  const linksDir = resolve(repoPath, 'links');

  if (!existsSync(linksDir)) return ids;

  const files = readdirSync(linksDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    ids.add(file.replace('.json', ''));
  }

  return ids;
}
