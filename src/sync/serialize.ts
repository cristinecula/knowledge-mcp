/**
 * Serialize/deserialize knowledge entries and links to/from JSON.
 *
 * Shared fields are included in JSON files. Personal/local fields
 * (strength, access_count, last_accessed_at, synced_at, embeddings)
 * are stripped on export and not expected on import.
 */

import type { KnowledgeEntry, KnowledgeLink, KnowledgeType, Scope, Status } from '../types.js';

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
  created_at: string;
  updated_at: string;
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
 * Strips local-only fields (strength, access_count, etc.).
 */
export function entryToJSON(entry: KnowledgeEntry): EntryJSON {
  return {
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
    updated_at: entry.content_updated_at || entry.updated_at,
  };
}

/**
 * Parse a JSON object into an EntryJSON.
 * Validates required fields are present.
 */
export function parseEntryJSON(data: unknown): EntryJSON {
  const obj = data as Record<string, unknown>;

  if (!obj.id || typeof obj.id !== 'string') throw new Error('Missing or invalid id');
  if (!obj.type || typeof obj.type !== 'string') throw new Error('Missing or invalid type');
  if (!obj.title || typeof obj.title !== 'string') throw new Error('Missing or invalid title');
  if (typeof obj.content !== 'string') throw new Error('Missing or invalid content');
  if (!obj.created_at || typeof obj.created_at !== 'string') throw new Error('Missing or invalid created_at');
  if (!obj.updated_at || typeof obj.updated_at !== 'string') throw new Error('Missing or invalid updated_at');

  return {
    id: obj.id as string,
    type: obj.type as KnowledgeType,
    title: obj.title as string,
    content: obj.content as string,
    tags: Array.isArray(obj.tags) ? (obj.tags as string[]) : [],
    project: (obj.project as string | null) ?? null,
    scope: (obj.scope as Scope) ?? 'company',
    source: (obj.source as string) ?? 'unknown',
    status: (obj.status as Status) ?? 'active',
    created_at: obj.created_at as string,
    updated_at: obj.updated_at as string,
  };
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
 * Parse a JSON object into a LinkJSON.
 */
export function parseLinkJSON(data: unknown): LinkJSON {
  const obj = data as Record<string, unknown>;

  if (!obj.id || typeof obj.id !== 'string') throw new Error('Missing or invalid id');
  if (!obj.source_id || typeof obj.source_id !== 'string') throw new Error('Missing or invalid source_id');
  if (!obj.target_id || typeof obj.target_id !== 'string') throw new Error('Missing or invalid target_id');
  if (!obj.link_type || typeof obj.link_type !== 'string') throw new Error('Missing or invalid link_type');
  if (!obj.created_at || typeof obj.created_at !== 'string') throw new Error('Missing or invalid created_at');

  return {
    id: obj.id as string,
    source_id: obj.source_id as string,
    target_id: obj.target_id as string,
    link_type: obj.link_type as string,
    description: (obj.description as string | null) ?? null,
    source: (obj.source as string) ?? 'unknown',
    created_at: obj.created_at as string,
  };
}
