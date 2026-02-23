import { randomUUID } from 'node:crypto';
import { getDb } from './connection.js';
import {
  type KnowledgeRow,
  type KnowledgeLinkRow,
  type KnowledgeType,
  type Scope,
  type Status,
  type LinkType,
  rowToEntry,
  rowToLink,
  type KnowledgeEntry,
  type KnowledgeLink,
} from '../types.js';

// === Knowledge CRUD ===

export interface InsertKnowledgeParams {
  type: KnowledgeType;
  title: string;
  content: string;
  tags?: string[];
  project?: string | null;
  scope?: Scope;
  source?: string;
  declaration?: string | null;
  parentPageId?: string | null;
}

export function insertKnowledge(params: InsertKnowledgeParams): KnowledgeEntry {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();

  const stmt = db.prepare(`
    INSERT INTO knowledge (id, type, title, content, tags, project, scope, source, created_at, updated_at, content_updated_at, last_accessed_at, access_count, strength, status, synced_at, declaration, parent_page_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0, 'active', NULL, ?, ?)
  `);

  stmt.run(
    id,
    params.type,
    params.title,
    params.content,
    JSON.stringify(params.tags ?? []),
    params.project ?? null,
    params.scope ?? 'company',
    params.source ?? 'unknown',
    now,
    now,
    now,
    now,
    params.declaration ?? null,
    params.parentPageId ?? null,
  );

  return getKnowledgeById(id)!;
}

export function getKnowledgeById(id: string): KnowledgeEntry | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM knowledge WHERE id = ?')
    .get(id) as KnowledgeRow | undefined;

  return row ? rowToEntry(row) : null;
}

export function updateKnowledgeFields(
  id: string,
  fields: Partial<{
    title: string;
    content: string;
    tags: string[];
    type: KnowledgeType;
    project: string | null;
    scope: Scope;
    declaration: string | null;
    parentPageId: string | null;
  }>,
): KnowledgeEntry | null {
  const db = getDb();
  const now = new Date().toISOString();

  const sets: string[] = ['updated_at = ?', 'content_updated_at = ?'];
  const values: unknown[] = [now, now];

  if (fields.title !== undefined) {
    sets.push('title = ?');
    values.push(fields.title);
  }
  if (fields.content !== undefined) {
    sets.push('content = ?');
    values.push(fields.content);
  }
  if (fields.tags !== undefined) {
    sets.push('tags = ?');
    values.push(JSON.stringify(fields.tags));
  }
  if (fields.type !== undefined) {
    sets.push('type = ?');
    values.push(fields.type);
  }
  if (fields.project !== undefined) {
    sets.push('project = ?');
    values.push(fields.project);
  }
  if (fields.scope !== undefined) {
    sets.push('scope = ?');
    values.push(fields.scope);
  }
  if (fields.declaration !== undefined) {
    sets.push('declaration = ?');
    values.push(fields.declaration);
  }
  if (fields.parentPageId !== undefined) {
    sets.push('parent_page_id = ?');
    values.push(fields.parentPageId);
  }

  values.push(id);

  db.prepare(`UPDATE knowledge SET ${sets.join(', ')} WHERE id = ?`).run(
    ...values,
  );

  return getKnowledgeById(id);
}

export function updateStrength(id: string, strength: number): void {
  const db = getDb();
  db.prepare('UPDATE knowledge SET strength = ? WHERE id = ?').run(
    strength,
    id,
  );
}

export function updateStatus(id: string, status: Status): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE knowledge SET status = ?, updated_at = ?, content_updated_at = ? WHERE id = ?',
  ).run(status, now, now, id);
}

/**
 * Deprecate a knowledge entry by setting its status to 'deprecated'.
 * Optionally stores the reason for deprecation.
 * Returns the updated entry, or null if not found.
 */
export function deprecateKnowledge(id: string, reason?: string): KnowledgeEntry | null {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(
    'UPDATE knowledge SET status = ?, updated_at = ?, content_updated_at = ?, deprecation_reason = ? WHERE id = ?',
  ).run('deprecated', now, now, reason ?? null, id);
  if (result.changes === 0) return null;
  return getKnowledgeById(id);
}

export function recordAccess(id: string, boost: number = 1): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE knowledge
     SET access_count = access_count + ?,
         last_accessed_at = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(boost, now, now, id);
}

// === Search ===

export interface SearchParams {
  query?: string;
  type?: KnowledgeType;
  tags?: string[];
  project?: string;
  scope?: Scope;
  includeWeak?: boolean;
  includeDormant?: boolean;
  status?: string;
  sortBy?: 'strength' | 'recent' | 'created';
  limit?: number;
  offset?: number;
}

export function searchKnowledge(params: SearchParams): KnowledgeEntry[] {
  const db = getDb();

  let sql: string;
  const bindings: unknown[] = [];

  if (params.query) {
    // FTS5 search joined with the main table
    sql = `
      SELECT k.*, rank
      FROM knowledge k
      JOIN knowledge_fts fts ON k.rowid = fts.rowid
      WHERE knowledge_fts MATCH ?
    `;
    // FTS5 query: escape special chars and use prefix matching
    const ftsQuery = params.query
      .replace(/['"]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term}"*`)
      .join(' OR ');
    bindings.push(ftsQuery);
  } else {
    sql = `SELECT k.*, 0 as rank FROM knowledge k WHERE 1=1`;
  }

  // Filters
  if (params.type) {
    sql += ' AND k.type = ?';
    bindings.push(params.type);
  }

  if (params.project) {
    sql += ' AND k.project = ?';
    bindings.push(params.project);
  }

  if (params.scope) {
    // Hierarchical: repo queries get repo + project + company
    // project queries get project + company
    // company queries get only company
    const scopes: Scope[] = [];
    if (params.scope === 'repo') scopes.push('repo', 'project', 'company');
    else if (params.scope === 'project') scopes.push('project', 'company');
    else scopes.push('company');

    sql += ` AND k.scope IN (${scopes.map(() => '?').join(',')})`;
    bindings.push(...scopes);
  }

  if (params.tags && params.tags.length > 0) {
    // Match entries that contain any of the specified tags
    for (const tag of params.tags) {
      sql += ' AND k.tags LIKE ?';
      bindings.push(`%"${tag}"%`);
    }
  }

  // Status filter
  if (params.status && params.status !== 'all') {
    if (params.status === 'weak') {
      sql += ' AND k.status = ? AND k.strength >= 0.1 AND k.strength < 0.5';
      bindings.push('active');
    } else {
      sql += ' AND k.status = ?';
      bindings.push(params.status);
    }
  } else if (!params.includeDormant) {
    // By default, exclude dormant entries
    const includeStatuses = ['active', 'needs_revalidation'];
    if (params.includeWeak) {
      // weak entries are active entries with low strength — no extra status filter needed
    }
    sql += ` AND k.status IN (${includeStatuses.map(() => '?').join(',')})`;
    bindings.push(...includeStatuses);

    if (!params.includeWeak) {
      sql += ` AND k.strength >= 0.5`;
    }
  }

  // Sort
  const sortBy = params.sortBy ?? 'strength';
  if (sortBy === 'strength' && params.query) {
    sql += ' ORDER BY (k.strength * (-rank)) DESC';
  } else if (sortBy === 'strength') {
    sql += ' ORDER BY k.strength DESC';
  } else if (sortBy === 'recent') {
    sql += ' ORDER BY k.last_accessed_at DESC';
  } else {
    sql += ' ORDER BY k.created_at DESC';
  }

  sql += ' LIMIT ?';
  bindings.push(params.limit ?? 10);

  if (params.offset && params.offset > 0) {
    sql += ' OFFSET ?';
    bindings.push(params.offset);
  }

  const rows = db.prepare(sql).all(...bindings) as (KnowledgeRow & {
    rank?: number;
  })[];

  return rows.map(rowToEntry);
}

export function listKnowledge(params: SearchParams): KnowledgeEntry[] {
  return searchKnowledge({ ...params, query: undefined });
}

/**
 * Count total entries matching the given filters (no LIMIT/OFFSET).
 * Used for pagination to determine total result count.
 */
export function countKnowledge(params: SearchParams): number {
  const db = getDb();

  let sql = `SELECT COUNT(*) as total FROM knowledge k WHERE 1=1`;
  const bindings: unknown[] = [];

  // Filters (same logic as searchKnowledge, minus FTS/sorting/limit/offset)
  if (params.type) {
    sql += ' AND k.type = ?';
    bindings.push(params.type);
  }

  if (params.project) {
    sql += ' AND k.project = ?';
    bindings.push(params.project);
  }

  if (params.scope) {
    const scopes: Scope[] = [];
    if (params.scope === 'repo') scopes.push('repo', 'project', 'company');
    else if (params.scope === 'project') scopes.push('project', 'company');
    else scopes.push('company');

    sql += ` AND k.scope IN (${scopes.map(() => '?').join(',')})`;
    bindings.push(...scopes);
  }

  if (params.tags && params.tags.length > 0) {
    for (const tag of params.tags) {
      sql += ' AND k.tags LIKE ?';
      bindings.push(`%"${tag}"%`);
    }
  }

  // Status filter (same logic as searchKnowledge)
  if (params.status && params.status !== 'all') {
    if (params.status === 'weak') {
      sql += ' AND k.status = ? AND k.strength >= 0.1 AND k.strength < 0.5';
      bindings.push('active');
    } else {
      sql += ' AND k.status = ?';
      bindings.push(params.status);
    }
  } else if (!params.includeDormant) {
    const includeStatuses = ['active', 'needs_revalidation'];
    sql += ` AND k.status IN (${includeStatuses.map(() => '?').join(',')})`;
    bindings.push(...includeStatuses);

    if (!params.includeWeak) {
      sql += ` AND k.strength >= 0.5`;
    }
  }

  const row = db.prepare(sql).get(...bindings) as { total: number };
  return row.total;
}

export function getAllEntries(): KnowledgeEntry[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM knowledge').all() as KnowledgeRow[];
  return rows.map(rowToEntry);
}

// === Links ===

export interface InsertLinkParams {
  sourceId: string;
  targetId: string;
  linkType: LinkType;
  description?: string;
  source?: string;
}

export function insertLink(params: InsertLinkParams): KnowledgeLink {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO knowledge_links (id, source_id, target_id, link_type, description, created_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.sourceId,
    params.targetId,
    params.linkType,
    params.description ?? null,
    now,
    params.source ?? 'unknown',
  );

  return getLinkById(id)!;
}

export function getLinkById(id: string): KnowledgeLink | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM knowledge_links WHERE id = ?')
    .get(id) as KnowledgeLinkRow | undefined;

  return row ? rowToLink(row) : null;
}

export function getLinksForEntry(entryId: string): KnowledgeLink[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM knowledge_links WHERE source_id = ? OR target_id = ?',
    )
    .all(entryId, entryId) as KnowledgeLinkRow[];

  return rows.map(rowToLink);
}

export function getOutgoingLinks(
  entryId: string,
  linkTypes?: LinkType[],
): KnowledgeLink[] {
  const db = getDb();

  if (linkTypes && linkTypes.length > 0) {
    const placeholders = linkTypes.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT * FROM knowledge_links WHERE source_id = ? AND link_type IN (${placeholders})`,
      )
      .all(entryId, ...linkTypes) as KnowledgeLinkRow[];
    return rows.map(rowToLink);
  }

  const rows = db
    .prepare('SELECT * FROM knowledge_links WHERE source_id = ?')
    .all(entryId) as KnowledgeLinkRow[];

  return rows.map(rowToLink);
}

export function getIncomingLinks(
  entryId: string,
  linkTypes?: LinkType[],
): KnowledgeLink[] {
  const db = getDb();

  if (linkTypes && linkTypes.length > 0) {
    const placeholders = linkTypes.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT * FROM knowledge_links WHERE target_id = ? AND link_type IN (${placeholders})`,
      )
      .all(entryId, ...linkTypes) as KnowledgeLinkRow[];
    return rows.map(rowToLink);
  }

  const rows = db
    .prepare('SELECT * FROM knowledge_links WHERE target_id = ?')
    .all(entryId) as KnowledgeLinkRow[];

  return rows.map(rowToLink);
}

export function getLinkedEntries(entryId: string): KnowledgeEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT k.* FROM knowledge k
       JOIN knowledge_links l ON (k.id = l.target_id OR k.id = l.source_id)
       WHERE (l.source_id = ? OR l.target_id = ?) AND k.id != ?`,
    )
    .all(entryId, entryId, entryId) as KnowledgeRow[];

  return rows.map(rowToEntry);
}

export function deleteKnowledge(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM knowledge WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteLink(id: string): boolean {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM knowledge_links WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

// === Bulk operations for maintenance ===

export function getAllActiveEntries(): KnowledgeEntry[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM knowledge WHERE status IN ('active', 'needs_revalidation')")
    .all() as KnowledgeRow[];
  return rows.map(rowToEntry);
}

export function getAllLinks(): KnowledgeLink[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM knowledge_links')
    .all() as KnowledgeLinkRow[];
  return rows.map(rowToLink);
}

// === Embeddings ===

export interface EmbeddingRow {
  entry_id: string;
  embedding: Buffer;
  model: string;
  dimensions: number;
  created_at: string;
}

export function storeEmbedding(
  entryId: string,
  embedding: Buffer,
  model: string,
  dimensions: number,
): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT OR REPLACE INTO knowledge_embeddings (entry_id, embedding, model, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(entryId, embedding, model, dimensions, now);
}

export function getEmbedding(entryId: string): EmbeddingRow | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM knowledge_embeddings WHERE entry_id = ?')
    .get(entryId) as EmbeddingRow | undefined;
  return row ?? null;
}

export function getAllEmbeddings(): EmbeddingRow[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM knowledge_embeddings')
    .all() as EmbeddingRow[];
}

export function deleteEmbedding(entryId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM knowledge_embeddings WHERE entry_id = ?').run(
    entryId,
  );
}

// === Graph data ===

export interface GraphData {
  nodes: Array<{
    id: string;
    title: string;
    type: string;
    scope: string;
    project: string | null;
    strength: number;
    status: string;
    access_count: number;
    tags: string[];
    created_at: string;
    last_accessed_at: string;
    declaration: string | null;
    parent_page_id: string | null;
  }>;
  links: Array<{
    id: string;
    source: string;
    target: string;
    link_type: string;
    description: string | null;
  }>;
}

export function getGraphData(): GraphData {
  const db = getDb();

  const entries = db
    .prepare('SELECT * FROM knowledge')
    .all() as KnowledgeRow[];

  const links = db
    .prepare('SELECT * FROM knowledge_links')
    .all() as KnowledgeLinkRow[];

  return {
    nodes: entries.map((e) => ({
      id: e.id,
      title: e.title,
      type: e.type,
      scope: e.scope,
      project: e.project,
      strength: e.strength,
      status: e.status,
      access_count: e.access_count,
      tags: JSON.parse(e.tags),
      created_at: e.created_at,
      last_accessed_at: e.last_accessed_at,
      declaration: e.declaration ?? null,
      parent_page_id: e.parent_page_id ?? null,
    })),
    links: links.map((l) => ({
      id: l.id,
      source: l.source_id,
      target: l.target_id,
      link_type: l.link_type,
      description: l.description,
    })),
  };
}

// === Sync helpers ===

/** Update synced_at timestamp for an entry */
export function updateSyncedAt(id: string, timestamp?: string): void {
  const db = getDb();
  const ts = timestamp ?? new Date().toISOString();
  db.prepare('UPDATE knowledge SET synced_at = ? WHERE id = ?').run(ts, id);
}

/**
 * Align content_updated_at with the remote's updated_at and set synced_at.
 * Used during pull when content is identical but timestamps differ (e.g., the
 * remote was pushed by an older version that set content_updated_at = now()).
 * Aligning the timestamp prevents push from re-serializing a different
 * updated_at and creating a spurious commit.
 */
export function alignContentTimestamp(id: string, remoteUpdatedAt: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE knowledge SET content_updated_at = ?, synced_at = ? WHERE id = ?',
  ).run(remoteUpdatedAt, now, id);
}

/** Insert a knowledge entry with a specific ID (used during sync import) */
export interface ImportKnowledgeParams {
  id: string;
  type: KnowledgeType;
  title: string;
  content: string;
  tags?: string[];
  project?: string | null;
  scope?: Scope;
  source?: string;
  status?: Status;
  deprecation_reason?: string | null;
  declaration?: string | null;
  parent_page_id?: string | null;
  created_at: string;
  updated_at: string;
}

export function importKnowledge(params: ImportKnowledgeParams): KnowledgeEntry {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO knowledge (id, type, title, content, tags, project, scope, source, created_at, updated_at, content_updated_at, last_accessed_at, access_count, strength, status, synced_at, deprecation_reason, declaration, parent_page_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.0, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    params.id,
    params.type,
    params.title,
    params.content,
    JSON.stringify(params.tags ?? []),
    params.project ?? null,
    params.scope ?? 'company',
    params.source ?? 'unknown',
    params.created_at,
    params.updated_at,
    params.updated_at,   // content_updated_at = updated_at for imports
    now,                  // last_accessed_at = now (personal)
    params.status ?? 'active',
    now,                  // synced_at = now
    params.deprecation_reason ?? null,
    params.declaration ?? null,
    params.parent_page_id ?? null,
  );

  return getKnowledgeById(params.id)!;
}

/** Insert a link with a specific ID (used during sync import) */
export interface ImportLinkParams {
  id: string;
  sourceId: string;
  targetId: string;
  linkType: LinkType;
  description?: string;
  source?: string;
  created_at: string;
}

export function importLink(params: ImportLinkParams): KnowledgeLink | null {
  const db = getDb();

  try {
    db.prepare(
      `INSERT INTO knowledge_links (id, source_id, target_id, link_type, description, created_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.id,
      params.sourceId,
      params.targetId,
      params.linkType,
      params.description ?? null,
      params.created_at,
      params.source ?? 'unknown',
    );
    return getLinkById(params.id);
  } catch (error) {
    // Silently skip duplicate links (UNIQUE constraint violation)
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('UNIQUE constraint')) {
      return null;
    }
    throw error;
  }
}

/** Update shared content fields of an entry (used during sync merge) */
export function updateKnowledgeContent(
  id: string,
  fields: {
    type?: KnowledgeType;
    title?: string;
    content?: string;
    tags?: string[];
    project?: string | null;
    scope?: Scope;
    source?: string;
    status?: Status;
    updated_at?: string;
    deprecation_reason?: string | null;
    declaration?: string | null;
    parent_page_id?: string | null;
  },
  /** When set, use this value for content_updated_at instead of now(). Used by pull to preserve remote timestamps and prevent drift. */
  contentUpdatedAtOverride?: string,
): KnowledgeEntry | null {
  const db = getDb();
  const now = new Date().toISOString();

  const sets: string[] = ['content_updated_at = ?', 'synced_at = ?'];
  const values: unknown[] = [contentUpdatedAtOverride ?? now, now];

  if (fields.type !== undefined) {
    sets.push('type = ?');
    values.push(fields.type);
  }
  if (fields.title !== undefined) {
    sets.push('title = ?');
    values.push(fields.title);
  }
  if (fields.content !== undefined) {
    sets.push('content = ?');
    values.push(fields.content);
  }
  if (fields.tags !== undefined) {
    sets.push('tags = ?');
    values.push(JSON.stringify(fields.tags));
  }
  if (fields.project !== undefined) {
    sets.push('project = ?');
    values.push(fields.project);
  }
  if (fields.scope !== undefined) {
    sets.push('scope = ?');
    values.push(fields.scope);
  }
  if (fields.source !== undefined) {
    sets.push('source = ?');
    values.push(fields.source);
  }
  if (fields.status !== undefined) {
    sets.push('status = ?');
    values.push(fields.status);
  }
  if (fields.updated_at !== undefined) {
    sets.push('updated_at = ?');
    values.push(fields.updated_at);
  }
  if (fields.deprecation_reason !== undefined) {
    sets.push('deprecation_reason = ?');
    values.push(fields.deprecation_reason);
  }
  if (fields.declaration !== undefined) {
    sets.push('declaration = ?');
    values.push(fields.declaration);
  }
  if (fields.parent_page_id !== undefined) {
    sets.push('parent_page_id = ?');
    values.push(fields.parent_page_id);
  }

  values.push(id);

  db.prepare(`UPDATE knowledge SET ${sets.join(', ')} WHERE id = ?`).run(
    ...values,
  );

  return getKnowledgeById(id);
}
