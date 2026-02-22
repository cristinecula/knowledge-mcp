/**
 * File system operations for the sync repo.
 *
 * Reads and writes JSON files organized as:
 *   entries/{type}/{id}.json
 *   links/{id}.json
 *   meta.json
 */

import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { KNOWLEDGE_TYPES } from '../types.js';
import type { KnowledgeType } from '../types.js';
import { type EntryJSON, type LinkJSON, parseEntryJSON, parseLinkJSON, SYNC_SCHEMA_VERSION } from './index.js';

/** Ensure the sync repo directory structure exists. */
export function ensureRepoStructure(repoPath: string): void {
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
}

/** Get the file path for an entry JSON file. */
export function entryFilePath(repoPath: string, type: KnowledgeType, id: string): string {
  return resolve(repoPath, 'entries', type, `${id}.json`);
}

/** Get the file path for a link JSON file. */
export function linkFilePath(repoPath: string, id: string): string {
  return resolve(repoPath, 'links', `${id}.json`);
}

/** Write an entry JSON file. */
export function writeEntryFile(repoPath: string, entry: EntryJSON): void {
  const filePath = entryFilePath(repoPath, entry.type, entry.id);
  writeFileSync(filePath, JSON.stringify(entry, null, 2) + '\n');
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
        const content = readFileSync(join(typeDir, file), 'utf-8');
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
      const content = readFileSync(join(linksDir, file), 'utf-8');
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
