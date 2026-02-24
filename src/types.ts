// === Knowledge Types ===

export const KNOWLEDGE_TYPES = [
  'convention',
  'decision',
  'pattern',
  'pitfall',
  'fact',
  'debug_note',
  'process',
  'wiki',
] as const;

export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

// === Scope ===

export const SCOPES = ['company', 'project', 'repo'] as const;

export type Scope = (typeof SCOPES)[number];

// === Status ===

export const STATUSES = [
  'active',
  'deprecated',
] as const;

export type Status = (typeof STATUSES)[number];

// === Link Types ===

export const LINK_TYPES = [
  'related',
  'derived',
  'depends',
  'contradicts',
  'supersedes',
  'elaborates',
  'conflicts_with',
] as const;

export type LinkType = (typeof LINK_TYPES)[number];

// === Interfaces ===

export interface KnowledgeEntry {
  id: string;
  type: KnowledgeType;
  title: string;
  content: string;
  tags: string[];
  project: string | null;
  scope: Scope;
  source: string;
  created_at: string;
  updated_at: string;
  content_updated_at: string;
  last_accessed_at: string;
  access_count: number;
  status: Status;
  synced_at: string | null;
  deprecation_reason: string | null;
  flag_reason: string | null;
  declaration: string | null;
  parent_page_id: string | null;
  inaccuracy: number;
  version: number;
  synced_version: number | null;
}

/** Row shape as stored in SQLite (tags is a JSON string) */
export interface KnowledgeRow {
  id: string;
  type: string;
  title: string;
  content: string;
  tags: string; // JSON array
  project: string | null;
  scope: string;
  source: string;
  created_at: string;
  updated_at: string;
  content_updated_at: string;
  last_accessed_at: string;
  access_count: number;
  status: string;
  synced_at: string | null;
  deprecation_reason: string | null;
  flag_reason: string | null;
  declaration: string | null;
  parent_page_id: string | null;
  inaccuracy: number;
  version: number;
  synced_version: number | null;
}
export interface KnowledgeLink {
  id: string;
  source_id: string;
  target_id: string;
  link_type: LinkType;
  description: string | null;
  created_at: string;
  source: string;
  synced_at: string | null;
}

export interface KnowledgeLinkRow {
  id: string;
  source_id: string;
  target_id: string;
  link_type: string;
  description: string | null;
  created_at: string;
  source: string;
  synced_at: string | null;
}

// === Constants ===

// === Inaccuracy Propagation Constants ===

/** Inaccuracy threshold — entry needs revalidation when inaccuracy >= this value */
export const INACCURACY_THRESHOLD = 1.0;

/** Decay factor per hop during BFS propagation */
export const INACCURACY_HOP_DECAY = 0.5;

/** Maximum inaccuracy value (prevents unbounded growth) */
export const INACCURACY_CAP = 2.0;

/** Minimum bump to continue propagation */
export const INACCURACY_FLOOR = 0.001;

/** Link type weights for inaccuracy propagation (how much a linked entry is affected) */
export const INACCURACY_LINK_WEIGHTS: Record<LinkType, number> = {
  derived: 1.0,
  contradicts: 0.7,
  depends: 0.6,
  elaborates: 0.4,
  supersedes: 0.3,
  related: 0.1,
  conflicts_with: 0,
};

// === Helpers ===

export function rowToEntry(row: KnowledgeRow): KnowledgeEntry {
  return {
    ...row,
    type: row.type as KnowledgeType,
    scope: row.scope as Scope,
    status: row.status as Status,
    tags: JSON.parse(row.tags),
  };
}

export function rowToLink(row: KnowledgeLinkRow): KnowledgeLink {
  return {
    ...row,
    link_type: row.link_type as LinkType,
  };
}
