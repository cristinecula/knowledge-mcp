/**
 * File system operations for the sync repo.
 *
 * Reads and writes entry files organized as:
 *   entries/{type}/{slug}_{id8}.md    (markdown with YAML frontmatter)
 *   links/{id}.json                   (JSON)
 *   meta.json
 *
 * When an entry's title changes, the file is renamed (new slug). The old
 * file is overwritten with a redirect marker so git sees a "modify" instead
 * of a "delete", preventing delete-modify merge conflicts.
 *
 * SECURITY: All file path construction validates that the resolved path
 * stays within the repo root directory. This prevents path traversal
 * attacks via crafted IDs or types in repo files.
 */

import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { KNOWLEDGE_TYPES } from '../types.js';
import type { KnowledgeType } from '../types.js';
import {
  type EntryJSON,
  type LinkJSON,
  parseEntryJSON,
  parseEntryMarkdown,
  parseLinkJSON,
  entryFileName,
  entryToMarkdown,
  buildRedirectMarker,
  parseRedirect,
  id8,
  ENTRY_FILENAME_RE,
} from './serialize.js';
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

  // Create or update meta.json
  const metaPath = resolve(repoPath, 'meta.json');
  const metaContent = JSON.stringify({ schema_version: SYNC_SCHEMA_VERSION }, null, 2) + '\n';
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, metaContent);
  } else {
    try {
      const existing = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (existing.schema_version !== SYNC_SCHEMA_VERSION) {
        writeFileSync(metaPath, metaContent);
      }
    } catch {
      writeFileSync(metaPath, metaContent);
    }
  }

  verifiedRepos.add(repoPath);
}

// ---------------------------------------------------------------------------
// Entry file paths (slug-based .md files)
// ---------------------------------------------------------------------------

/**
 * Get the deterministic file path for an entry. Requires the title to compute
 * the slug. Validates path stays within repo.
 */
export function entryFilePath(repoPath: string, type: KnowledgeType, id: string, title: string): string {
  const fileName = entryFileName(title, id);
  const filePath = resolve(repoPath, 'entries', type, fileName);
  assertWithinRoot(filePath, repoPath);
  return filePath;
}

/**
 * Find an entry file by its ID suffix, scanning the type directory.
 * Returns the full path if found, null otherwise.
 *
 * O(n) where n = number of files in the type directory.
 * Use when the title is unknown or may have changed.
 */
export function findEntryFile(repoPath: string, type: KnowledgeType, id: string): string | null {
  const typeDir = resolve(repoPath, 'entries', type);
  if (!existsSync(typeDir)) return null;

  const suffix = `_${id8(id)}.md`;
  const files = readdirSync(typeDir);
  for (const file of files) {
    if (file.endsWith(suffix)) {
      const filePath = join(typeDir, file);
      assertWithinRoot(filePath, repoPath);
      return filePath;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Link file paths (JSON, unchanged)
// ---------------------------------------------------------------------------

/** Get the file path for a link JSON file. Validates path stays within repo. */
export function linkFilePath(repoPath: string, id: string): string {
  const filePath = resolve(repoPath, 'links', `${id}.json`);
  assertWithinRoot(filePath, repoPath);
  return filePath;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Write an entry as a Markdown file with YAML frontmatter.
 *
 * If the entry's slug changed (title change), the old file is overwritten
 * with a redirect marker pointing to the new filename. This prevents
 * delete-modify merge conflicts in git.
 */
export function writeEntryFile(repoPath: string, entry: EntryJSON): void {
  const newPath = entryFilePath(repoPath, entry.type, entry.id, entry.title);
  const markdown = entryToMarkdown(entry);

  // Check if an existing file for this ID has a different slug (title changed)
  const existingPath = findEntryFile(repoPath, entry.type, entry.id);
  if (existingPath && existingPath !== newPath) {
    // Title changed — overwrite old file with redirect marker
    const newFileName = entryFileName(entry.title, entry.id);
    writeFileSync(existingPath, buildRedirectMarker(newFileName));
  }

  writeFileSync(newPath, markdown);
}

/** Write a link JSON file. */
export function writeLinkFile(repoPath: string, link: LinkJSON): void {
  const filePath = linkFilePath(repoPath, link.id);
  writeFileSync(filePath, JSON.stringify(link, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Read an entry Markdown file and return its raw string content (for comparison).
 * Returns null if the file doesn't exist.
 *
 * If title is provided, tries the deterministic path first (O(1)).
 * Falls back to findEntryFile (O(n)) if the file isn't at the expected path.
 */
export function readEntryFileRaw(repoPath: string, type: KnowledgeType, id: string, title?: string): string | null {
  // Try deterministic path first if we have a title
  if (title) {
    const filePath = entryFilePath(repoPath, type, id, title);
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf-8');
    }
  }

  // Fall back to directory scan
  const filePath = findEntryFile(repoPath, type, id);
  if (!filePath) return null;
  return readFileSync(filePath, 'utf-8');
}

/** Read a link JSON file and return its raw string content (for comparison). Returns null if the file doesn't exist. */
export function readLinkFileRaw(repoPath: string, id: string): string | null {
  const filePath = linkFilePath(repoPath, id);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

// ---------------------------------------------------------------------------
// Delete operations
// ---------------------------------------------------------------------------

/**
 * Delete an entry file. Finds it by ID suffix (handles slug changes).
 * Also deletes any redirect files for the same ID.
 *
 * If type is provided, only searches that directory. Otherwise searches all type dirs.
 */
export function deleteEntryFile(repoPath: string, id: string, type?: KnowledgeType): void {
  const typesToSearch = type ? [type] : KNOWLEDGE_TYPES;

  for (const t of typesToSearch) {
    const typeDir = resolve(repoPath, 'entries', t);
    if (!existsSync(typeDir)) continue;

    const suffix = `_${id8(id)}.md`;
    const files = readdirSync(typeDir);
    for (const file of files) {
      if (file.endsWith(suffix)) {
        const filePath = join(typeDir, file);
        assertWithinRoot(filePath, repoPath);
        unlinkSync(filePath);
        // Don't return — there may be a redirect file with the same ID suffix
      }
    }

    if (type) return; // Only searched the specified type
  }
}

/** Delete a link JSON file. */
export function deleteLinkFile(repoPath: string, id: string): void {
  const filePath = linkFilePath(repoPath, id);
  if (existsSync(filePath)) unlinkSync(filePath);
}

// ---------------------------------------------------------------------------
// Bulk read operations
// ---------------------------------------------------------------------------

/**
 * Read all entry Markdown files from the repo.
 *
 * Skips redirect marker files. Deduplicates by entry ID — if two files
 * parse to the same ID (can happen after a merge with rename conflicts),
 * the entry with the higher version is kept and a warning is logged.
 */
export function readAllEntryFiles(repoPath: string): EntryJSON[] {
  const entriesDir = resolve(repoPath, 'entries');
  if (!existsSync(entriesDir)) return [];

  // Map for dedup: id -> { entry, source file }
  const seen = new Map<string, { entry: EntryJSON; file: string }>();

  for (const type of KNOWLEDGE_TYPES) {
    const typeDir = resolve(entriesDir, type);
    if (!existsSync(typeDir)) continue;

    const files = readdirSync(typeDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      try {
        const filePath = join(typeDir, file);
        assertWithinRoot(filePath, repoPath);
        const content = readFileSync(filePath, 'utf-8');

        // Skip redirect markers
        if (parseRedirect(content) !== null) continue;

        const entry = parseEntryMarkdown(content);
        const existing = seen.get(entry.id);

        if (existing) {
          // Duplicate ID — keep higher version
          if (entry.version > existing.entry.version) {
            console.error(`Warning: Duplicate entry ID ${entry.id} found in ${existing.file} and ${type}/${file}, keeping version ${entry.version} from ${type}/${file}`);
            seen.set(entry.id, { entry, file: `${type}/${file}` });
          } else {
            console.error(`Warning: Duplicate entry ID ${entry.id} found in ${existing.file} and ${type}/${file}, keeping version ${existing.entry.version} from ${existing.file}`);
          }
        } else {
          seen.set(entry.id, { entry, file: `${type}/${file}` });
        }
      } catch (error) {
        console.error(`Warning: Failed to parse ${type}/${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return Array.from(seen.values()).map((v) => v.entry);
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

// ---------------------------------------------------------------------------
// ID extraction (for detecting remote deletions)
// ---------------------------------------------------------------------------

/**
 * Get all entry ID prefixes (8-char) present in the repo.
 *
 * Extracts ID from filename suffix via regex. Returns 8-char prefixes,
 * so callers must compare using id8(fullId).
 *
 * Skips redirect markers — their IDs are already accounted for by
 * the canonical file they point to.
 */
export function getRepoEntryIds(repoPath: string): Set<string> {
  const ids = new Set<string>();
  const entriesDir = resolve(repoPath, 'entries');

  if (!existsSync(entriesDir)) return ids;

  for (const type of KNOWLEDGE_TYPES) {
    const typeDir = resolve(entriesDir, type);
    if (!existsSync(typeDir)) continue;

    const files = readdirSync(typeDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      // Check if it's a redirect marker — skip it
      const filePath = join(typeDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (parseRedirect(content) !== null) continue;
      } catch {
        continue;
      }

      const match = file.match(ENTRY_FILENAME_RE);
      if (match) {
        ids.add(match[1]);
      }
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

// ---------------------------------------------------------------------------
// Redirect cleanup
// ---------------------------------------------------------------------------

/**
 * Remove all redirect marker files from the repo.
 * Called during push() after all canonical entry files have been written.
 * Returns the number of redirect files removed.
 */
export function cleanupRedirectFiles(repoPath: string): number {
  let cleaned = 0;
  const entriesDir = resolve(repoPath, 'entries');
  if (!existsSync(entriesDir)) return cleaned;

  for (const type of KNOWLEDGE_TYPES) {
    const typeDir = resolve(entriesDir, type);
    if (!existsSync(typeDir)) continue;

    const files = readdirSync(typeDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = join(typeDir, file);
      try {
        assertWithinRoot(filePath, repoPath);
        const content = readFileSync(filePath, 'utf-8');
        if (parseRedirect(content) !== null) {
          unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // Skip files we can't read
      }
    }
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Migration: JSON → Markdown
// ---------------------------------------------------------------------------

/**
 * Migrate all entry JSON files in a repo to Markdown with YAML frontmatter.
 *
 * For each .json file in entries/{type}/:
 *   1. Parse as EntryJSON
 *   2. Write as .md with entryToMarkdown()
 *   3. Delete the .json file
 *
 * Called once on server startup, before the first pull.
 * Idempotent — skips if no .json files exist.
 *
 * Returns the number of files migrated.
 */
export function migrateJsonToMarkdown(repoPath: string): number {
  let migrated = 0;
  const entriesDir = resolve(repoPath, 'entries');
  if (!existsSync(entriesDir)) return migrated;

  for (const type of KNOWLEDGE_TYPES) {
    const typeDir = resolve(entriesDir, type);
    if (!existsSync(typeDir)) continue;

    const jsonFiles = readdirSync(typeDir).filter((f) => f.endsWith('.json'));
    for (const file of jsonFiles) {
      try {
        const jsonPath = join(typeDir, file);
        assertWithinRoot(jsonPath, repoPath);
        const content = readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(content);
        const entry = parseEntryJSON(data);

        // Write as markdown
        const mdPath = entryFilePath(repoPath, entry.type as KnowledgeType, entry.id, entry.title);
        writeFileSync(mdPath, entryToMarkdown(entry));

        // Delete old JSON file
        unlinkSync(jsonPath);
        migrated++;
      } catch (error) {
        console.error(`Warning: Failed to migrate ${type}/${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return migrated;
}
