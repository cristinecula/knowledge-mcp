/**
 * Serialize/deserialize knowledge entries and links.
 *
 * Entries are stored as Markdown files with YAML frontmatter.
 * Links are stored as JSON files (small metadata-only records).
 *
 * Shared fields are included in files. Personal/local fields
 * (access_count, last_accessed_at, synced_at, embeddings)
 * are stripped on export and not expected on import.
 *
 * SECURITY: parseEntryJSON, parseEntryMarkdown, and parseLinkJSON validate
 * all fields from untrusted repo files — IDs must be valid UUIDs,
 * types/scopes/statuses must be from the allowed set, and tags must be
 * an array of strings. This prevents path traversal via crafted IDs and
 * invalid data injection.
 */

import matter from 'gray-matter';
import {
  KNOWLEDGE_TYPES,
  SCOPES,
  STATUSES,
  LINK_TYPES,
  type KnowledgeEntry,
  type KnowledgeLink,
  type KnowledgeType,
  type Scope,
  type Status,
} from '../types.js';

// UUID v4 pattern (case-insensitive, with hyphens)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TYPES = new Set<string>(KNOWLEDGE_TYPES);
const VALID_SCOPES = new Set<string>(SCOPES);
const VALID_STATUSES = new Set<string>(STATUSES);
const VALID_LINK_TYPES = new Set<string>(LINK_TYPES);

/** Shape of an entry as stored in a JSON file (shared fields only). */
export interface EntryJSON {
  id: string;
  type: KnowledgeType;
  title: string;
  content: string;
  tags: string[];
  project: string | null;
  scope: Scope;
  source: string;
  status: Status;
  deprecation_reason?: string | null;
  flag_reason?: string | null;
  declaration?: string | null;
  parent_page_id?: string | null;
  inaccuracy?: number;
  created_at: string;
  version: number;
}

/** Shape of a link as stored in a JSON file. */
export interface LinkJSON {
  id: string;
  source_id: string;
  target_id: string;
  link_type: string;
  description: string | null;
  source: string;
  created_at: string;
}

/**
 * Convert a KnowledgeEntry to its JSON file representation.
 * Strips local-only fields (access_count, etc.).
 */
export function entryToJSON(entry: KnowledgeEntry): EntryJSON {
  const json: EntryJSON = {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    content: entry.content,
    tags: entry.tags,
    project: entry.project,
    scope: entry.scope,
    source: entry.source,
    status: entry.status,
    created_at: entry.created_at,
    version: entry.version,
  };

  // Only include deprecation_reason when it has a value (keep JSON clean)
  if (entry.deprecation_reason) {
    json.deprecation_reason = entry.deprecation_reason;
  }

  // Only include flag_reason when it has a value (keep JSON clean)
  if (entry.flag_reason) {
    json.flag_reason = entry.flag_reason;
  }

  // Only include declaration when it has a value (keep JSON clean)
  if (entry.declaration) {
    json.declaration = entry.declaration;
  }

  // Only include parent_page_id when it has a value (keep JSON clean)
  if (entry.parent_page_id) {
    json.parent_page_id = entry.parent_page_id;
  }

  // Only include inaccuracy when non-zero (keep JSON clean)
  if (entry.inaccuracy > 0) {
    json.inaccuracy = Math.round(entry.inaccuracy * 1000) / 1000;
  }

  return json;
}

/**
 * Parse and validate a JSON object into an EntryJSON.
 *
 * Validates all fields strictly — this data comes from repo JSON files
 * which may be authored by untrusted parties (shared git repos).
 */
export function parseEntryJSON(data: unknown): EntryJSON {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Entry JSON must be a non-null object');
  }

  const obj = data as Record<string, unknown>;

  // ID must be a valid UUID
  if (typeof obj.id !== 'string' || !UUID_RE.test(obj.id)) {
    throw new Error(`Invalid or missing id: must be a valid UUID, got "${String(obj.id)}"`);
  }

  // Type must be one of the allowed knowledge types
  if (typeof obj.type !== 'string' || !VALID_TYPES.has(obj.type)) {
    throw new Error(`Invalid type: "${String(obj.type)}", must be one of: ${KNOWLEDGE_TYPES.join(', ')}`);
  }

  // Title must be a non-empty string
  if (typeof obj.title !== 'string' || obj.title.length === 0) {
    throw new Error('Missing or invalid title');
  }

  // Content must be a string (can be empty)
  if (typeof obj.content !== 'string') {
    throw new Error('Missing or invalid content');
  }

  // Timestamps must be non-empty strings
  if (typeof obj.created_at !== 'string' || obj.created_at.length === 0) {
    throw new Error('Missing or invalid created_at');
  }
  // updated_at is no longer serialized (removed to prevent spurious sync commits
  // from timestamp drift). Silently ignored if present in old JSON files.

  // Scope must be valid (default to 'company' if missing)
  const scope = typeof obj.scope === 'string' && VALID_SCOPES.has(obj.scope)
    ? (obj.scope as Scope)
    : 'company';

  // Status must be valid (default to 'active' if missing)
  const status = typeof obj.status === 'string' && VALID_STATUSES.has(obj.status)
    ? (obj.status as Status)
    : 'active';

  // Tags must be an array of strings (filter out non-strings for safety)
  let tags: string[] = [];
  if (Array.isArray(obj.tags)) {
    tags = obj.tags.filter((t): t is string => typeof t === 'string');
  }

  // Project must be a string or null
  const project = typeof obj.project === 'string' ? obj.project : null;

  // Source must be a string (default to 'unknown')
  const source = typeof obj.source === 'string' ? obj.source : 'unknown';

  // Deprecation reason must be a string or null/undefined
  const deprecation_reason = typeof obj.deprecation_reason === 'string' ? obj.deprecation_reason : null;

  // Flag reason must be a string or null/undefined
  const flag_reason = typeof obj.flag_reason === 'string' ? obj.flag_reason : null;

  // Declaration must be a string or null/undefined
  const declaration = typeof obj.declaration === 'string' ? obj.declaration : null;

  // Parent page ID must be a valid UUID or null/undefined
  let parent_page_id: string | null = null;
  if (typeof obj.parent_page_id === 'string') {
    if (!UUID_RE.test(obj.parent_page_id)) {
      throw new Error(`Invalid parent_page_id: must be a valid UUID, got "${obj.parent_page_id}"`);
    }
    parent_page_id = obj.parent_page_id;
  }

  // Version must be a positive integer (default to 1 for backward compat with pre-version JSON files)
  const version = typeof obj.version === 'number' && Number.isInteger(obj.version) && obj.version >= 1
    ? obj.version
    : 1;

  // Inaccuracy must be a non-negative number (default to 0 for backward compat)
  const inaccuracy = typeof obj.inaccuracy === 'number' && obj.inaccuracy >= 0
    ? obj.inaccuracy
    : 0;

  const result: EntryJSON = {
    id: obj.id,
    type: obj.type as KnowledgeType,
    title: obj.title,
    content: obj.content,
    tags,
    project,
    scope,
    source,
    status,
    created_at: obj.created_at,
    version,
  };

  // Only include deprecation_reason when it has a value
  if (deprecation_reason) {
    result.deprecation_reason = deprecation_reason;
  }

  // Only include flag_reason when it has a value
  if (flag_reason) {
    result.flag_reason = flag_reason;
  }

  // Only include declaration when it has a value
  if (declaration) {
    result.declaration = declaration;
  }

  // Only include parent_page_id when it has a value
  if (parent_page_id) {
    result.parent_page_id = parent_page_id;
  }

  // Only include inaccuracy when non-zero
  if (inaccuracy > 0) {
    result.inaccuracy = inaccuracy;
  }

  return result;
}

/**
 * Convert a KnowledgeLink to its JSON file representation.
 */
export function linkToJSON(link: KnowledgeLink): LinkJSON {
  return {
    id: link.id,
    source_id: link.source_id,
    target_id: link.target_id,
    link_type: link.link_type,
    description: link.description,
    source: link.source,
    created_at: link.created_at,
  };
}

/**
 * Parse and validate a JSON object into a LinkJSON.
 *
 * Validates all fields strictly — IDs must be valid UUIDs,
 * link_type must be from the allowed set.
 */
export function parseLinkJSON(data: unknown): LinkJSON {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Link JSON must be a non-null object');
  }

  const obj = data as Record<string, unknown>;

  // All IDs must be valid UUIDs
  if (typeof obj.id !== 'string' || !UUID_RE.test(obj.id)) {
    throw new Error(`Invalid or missing link id: must be a valid UUID, got "${String(obj.id)}"`);
  }
  if (typeof obj.source_id !== 'string' || !UUID_RE.test(obj.source_id)) {
    throw new Error(`Invalid or missing source_id: must be a valid UUID, got "${String(obj.source_id)}"`);
  }
  if (typeof obj.target_id !== 'string' || !UUID_RE.test(obj.target_id)) {
    throw new Error(`Invalid or missing target_id: must be a valid UUID, got "${String(obj.target_id)}"`);
  }

  // Link type must be valid
  if (typeof obj.link_type !== 'string' || !VALID_LINK_TYPES.has(obj.link_type)) {
    throw new Error(`Invalid link_type: "${String(obj.link_type)}", must be one of: ${LINK_TYPES.join(', ')}`);
  }

  // Timestamp must be present
  if (typeof obj.created_at !== 'string' || obj.created_at.length === 0) {
    throw new Error('Missing or invalid created_at');
  }

  return {
    id: obj.id,
    source_id: obj.source_id,
    target_id: obj.target_id,
    link_type: obj.link_type,
    description: typeof obj.description === 'string' ? obj.description : null,
    source: typeof obj.source === 'string' ? obj.source : 'unknown',
    created_at: obj.created_at,
  };
}

// ---------------------------------------------------------------------------
// Markdown with YAML frontmatter — entry serialization (schema v2)
// ---------------------------------------------------------------------------

/**
 * Convert a title to a URL-friendly slug.
 * Lowercase, non-alphanumeric chars replaced with hyphens, max 60 chars.
 *
 * Examples:
 *   "Use React Query for Server State" → "use-react-query-for-server-state"
 *   "[Sync Conflict] My Entry" → "sync-conflict-my-entry"
 *   "  Lots   of---spaces  " → "lots-of-spaces"
 */
export function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // Replace non-alphanumeric runs with single hyphen
    .replace(/^-+|-+$/g, '')        // Trim leading/trailing hyphens
    .slice(0, 60)                   // Truncate to 60 chars
    .replace(/-+$/, '');            // Trim trailing hyphen if truncation split a word
}

/**
 * Get the first 8 characters of a UUID (the prefix before the first hyphen).
 * Used as a short ID suffix in filenames.
 */
export function id8(id: string): string {
  return id.slice(0, 8);
}

/**
 * Build the filename for an entry: {slug}_{id8}.md
 */
export function entryFileName(title: string, id: string): string {
  const slug = titleToSlug(title);
  return `${slug}_${id8(id)}.md`;
}

/** Regex to extract the 8-char ID suffix from an entry filename. */
export const ENTRY_FILENAME_RE = /_([0-9a-f]{8})\.md$/i;

/**
 * Convert an EntryJSON to a Markdown file with YAML frontmatter.
 *
 * Frontmatter contains all metadata fields (everything except content).
 * The body is the content field verbatim.
 */
export function entryToMarkdown(entry: EntryJSON): string {
  // Build frontmatter data — only include optional fields when set
  const fm: Record<string, unknown> = {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    tags: entry.tags,
    project: entry.project,
    scope: entry.scope,
    source: entry.source,
    status: entry.status,
    created_at: entry.created_at,
    version: entry.version,
  };

  if (entry.deprecation_reason) fm.deprecation_reason = entry.deprecation_reason;
  if (entry.flag_reason) fm.flag_reason = entry.flag_reason;
  if (entry.declaration) fm.declaration = entry.declaration;
  if (entry.parent_page_id) fm.parent_page_id = entry.parent_page_id;
  if (entry.inaccuracy && entry.inaccuracy > 0) fm.inaccuracy = entry.inaccuracy;

  return matter.stringify(entry.content + '\n', fm);
}

/**
 * Build a redirect marker file content. Written to the old path when an entry
 * is renamed (title change causes slug change). The redirect points to the
 * new filename so other machines can follow it during merge.
 */
export function buildRedirectMarker(newFileName: string): string {
  return matter.stringify('', { redirect: newFileName });
}

/**
 * Check if a raw file string is a redirect marker.
 * Returns the target filename if it is, null otherwise.
 */
export function parseRedirect(raw: string): string | null {
  try {
    const { data } = matter(raw);
    if (typeof data.redirect === 'string' && data.redirect.length > 0) {
      return data.redirect;
    }
  } catch {
    // Not valid frontmatter — not a redirect
  }
  return null;
}

/**
 * Parse a Markdown file with YAML frontmatter into an EntryJSON.
 *
 * Validates all fields strictly — this data comes from repo files
 * which may be authored by untrusted parties (shared git repos).
 *
 * Throws if the file is a redirect marker (has a `redirect` field).
 */
export function parseEntryMarkdown(raw: string): EntryJSON {
  const { data, content } = matter(raw);

  // Check for redirect marker
  if (data.redirect) {
    throw new Error(`File is a redirect marker pointing to "${data.redirect}"`);
  }

  // Reuse the same validation logic as parseEntryJSON by delegating to it.
  // The frontmatter `data` object has the same shape as EntryJSON minus content.
  // We inject the body as `content`.
  const obj = { ...data, content: content.trim() };
  return parseEntryJSON(obj);
}
