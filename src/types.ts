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
  'needs_revalidation',
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
  strength: number;
  status: Status;
  synced_at: string | null;
  deprecation_reason: string | null;
  declaration: string | null;
  parent_page_id: string | null;
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
  strength: number;
  status: string;
  synced_at: string | null;
  deprecation_reason: string | null;
  declaration: string | null;
  parent_page_id: string | null;
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

/** Half-life in milliseconds (14 days) */
export const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** Deprecated entries decay 10x faster */
export const DEPRECATED_DECAY_MULTIPLIER = 10;

/** Strength thresholds */
export const STRENGTH_ACTIVE_THRESHOLD = 0.5;

/** Link type weights for network strength calculation */
export const LINK_WEIGHTS: Record<LinkType, number> = {
  depends: 0.3,
  derived: 0.2,
  elaborates: 0.2,
  contradicts: 0.15,
  supersedes: 0.15,
  related: 0.1,
  conflicts_with: 0,
};

/** Maximum network bonus as a fraction of base strength */
export const MAX_NETWORK_BONUS_RATIO = 0.5;

/** Access count boost for explicit reinforcement */
export const REINFORCE_ACCESS_BOOST = 3;

/** Link types that trigger revalidation on update */
export const REVALIDATION_LINK_TYPES: LinkType[] = ['derived', 'depends'];

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
