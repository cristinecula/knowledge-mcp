import type Database from 'better-sqlite3';

/**
 * Initialize the database schema.
 * Creates tables, indexes, and FTS5 virtual table if they don't exist.
 */
export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      project TEXT,
      scope TEXT NOT NULL DEFAULT 'company',
      source TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      content_updated_at TEXT NOT NULL DEFAULT '',
      last_accessed_at TEXT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      synced_at TEXT,
      deprecation_reason TEXT,
      declaration TEXT,
      parent_page_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge(status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project);
    CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge(scope);

    CREATE TABLE IF NOT EXISTS knowledge_links (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'unknown',

      FOREIGN KEY (source_id) REFERENCES knowledge(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES knowledge(id) ON DELETE CASCADE,
      UNIQUE(source_id, target_id, link_type)
    );

    CREATE INDEX IF NOT EXISTS idx_links_source ON knowledge_links(source_id);
    CREATE INDEX IF NOT EXISTS idx_links_target ON knowledge_links(target_id);
    CREATE INDEX IF NOT EXISTS idx_links_type ON knowledge_links(link_type);

    CREATE TABLE IF NOT EXISTS knowledge_embeddings (
      entry_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at TEXT NOT NULL,

      FOREIGN KEY (entry_id) REFERENCES knowledge(id) ON DELETE CASCADE
    );
  `);

  // Migrate existing databases: add content_updated_at if missing
  migrateSchema(db);

  // FTS5 virtual table — check if it exists first
  const ftsExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'",
    )
    .get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        title,
        content,
        tags,
        content='knowledge',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync with the main table
      CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts(rowid, title, content, tags)
        VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
      END;

      CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags)
        VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
      END;

      CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags)
        VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
        INSERT INTO knowledge_fts(rowid, title, content, tags)
        VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
      END;
    `);
  }
}

/**
 * Run schema migrations for existing databases.
 * Each migration checks if it's needed before applying.
 */
function migrateSchema(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(knowledge)').all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  // Migration 1: Add content_updated_at column
  if (!columnNames.has('content_updated_at')) {
    db.exec(`
      ALTER TABLE knowledge ADD COLUMN content_updated_at TEXT NOT NULL DEFAULT '';
      UPDATE knowledge SET content_updated_at = updated_at WHERE content_updated_at = '';
    `);
  }

  // Migration 2: Add synced_at column
  if (!columnNames.has('synced_at')) {
    db.exec(`ALTER TABLE knowledge ADD COLUMN synced_at TEXT`);
  }

  // Migration 3: Add deprecation_reason column
  if (!columnNames.has('deprecation_reason')) {
    db.exec(`ALTER TABLE knowledge ADD COLUMN deprecation_reason TEXT`);
  }

  // Migration 4: Add declaration column (for wiki entries)
  if (!columnNames.has('declaration')) {
    db.exec(`ALTER TABLE knowledge ADD COLUMN declaration TEXT`);
  }

  // Migration 5: Add parent_page_id column (for wiki page hierarchy)
  if (!columnNames.has('parent_page_id')) {
    db.exec(`ALTER TABLE knowledge ADD COLUMN parent_page_id TEXT`);
  }

  // Migration 6: Add synced_at column to knowledge_links
  const linkColumns = db.prepare('PRAGMA table_info(knowledge_links)').all() as Array<{
    name: string;
  }>;
  const linkColumnNames = new Set(linkColumns.map((c) => c.name));

  if (!linkColumnNames.has('synced_at')) {
    db.exec(`ALTER TABLE knowledge_links ADD COLUMN synced_at TEXT`);
  }

  // Migration 7: Add sync_lock table for cross-process sync coordination
  const syncLockExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_lock'")
    .get();

  if (!syncLockExists) {
    db.exec(`
      CREATE TABLE sync_lock (
        lock_name TEXT PRIMARY KEY,
        holder_pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }

  // Migration 8: Composite index for status — strength column removed in migration 13.
  // This migration is now a no-op but kept for historical continuity.
  // (Previously created idx_knowledge_status_strength which is dropped in migration 13.)

  // Migration 9: Add version and synced_version columns for version-based conflict detection
  if (!columnNames.has('version')) {
    db.exec(`
      ALTER TABLE knowledge ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE knowledge ADD COLUMN synced_version INTEGER;
      UPDATE knowledge SET synced_version = 1 WHERE synced_at IS NOT NULL;
    `);
  }

  // Migration 10: Remove dormant status — convert existing dormant entries back to active.
  // This prevents memory decay from leaking into the sync layer (dormant transitions
  // bumped version numbers, causing spurious sync pushes that overwrote other users' status).
  const hasDormant = db.prepare(
    `SELECT 1 FROM knowledge WHERE status = 'dormant' LIMIT 1`,
  ).get();
  if (hasDormant) {
    db.exec(`UPDATE knowledge SET status = 'active' WHERE status = 'dormant'`);
  }

  // Migration 11: Add flag_reason column (for human "flag as inaccurate" on wiki pages)
  if (!columnNames.has('flag_reason')) {
    db.exec(`ALTER TABLE knowledge ADD COLUMN flag_reason TEXT`);
  }

  // Migration 12: Add inaccuracy column and remove needs_revalidation status.
  // Inaccuracy is a continuous score (0.0 = accurate, >= 1.0 = needs revalidation).
  // Existing needs_revalidation entries get inaccuracy = 1.0 and status = 'active'.
  if (!columnNames.has('inaccuracy')) {
    db.exec(`
      ALTER TABLE knowledge ADD COLUMN inaccuracy REAL NOT NULL DEFAULT 0.0;
      UPDATE knowledge SET inaccuracy = 1.0, status = 'active' WHERE status = 'needs_revalidation';
    `);
  }

  // Backfill: ensure content_updated_at is set for any rows where it's empty.
  // Only run if there are actually rows to fix (avoids full-table scan on every startup).
  const needsBackfill = db.prepare(
    `SELECT 1 FROM knowledge WHERE content_updated_at = '' LIMIT 1`,
  ).get();
  if (needsBackfill) {
    db.exec(`UPDATE knowledge SET content_updated_at = updated_at WHERE content_updated_at = ''`);
  }

  // Migration 13: Remove strength column and associated indexes.
  // Strength (brain-inspired memory decay) has been replaced by the explicit inaccuracy
  // propagation system for tracking content staleness. Access tracking (access_count,
  // last_accessed_at) is preserved for sorting and analytics.
  // SQLite doesn't support DROP COLUMN on older versions, so we recreate the table.
  if (columnNames.has('strength')) {
    db.exec(`
      DROP INDEX IF EXISTS idx_knowledge_strength;
      DROP INDEX IF EXISTS idx_knowledge_status_strength;

      CREATE TABLE knowledge_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        project TEXT,
        scope TEXT NOT NULL DEFAULT 'company',
        source TEXT NOT NULL DEFAULT 'unknown',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        content_updated_at TEXT NOT NULL DEFAULT '',
        last_accessed_at TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        synced_at TEXT,
        deprecation_reason TEXT,
        declaration TEXT,
        parent_page_id TEXT,
        flag_reason TEXT,
        inaccuracy REAL NOT NULL DEFAULT 0.0,
        version INTEGER NOT NULL DEFAULT 1,
        synced_version INTEGER
      );

      INSERT INTO knowledge_new
        SELECT id, type, title, content, tags, project, scope, source,
               created_at, updated_at, content_updated_at, last_accessed_at,
               access_count, status, synced_at, deprecation_reason,
               declaration, parent_page_id, flag_reason, inaccuracy,
               version, synced_version
        FROM knowledge;

      DROP TABLE knowledge;
      ALTER TABLE knowledge_new RENAME TO knowledge;

      -- Recreate indexes (excluding strength-related ones)
      CREATE INDEX idx_knowledge_type ON knowledge(type);
      CREATE INDEX idx_knowledge_status ON knowledge(status);
      CREATE INDEX idx_knowledge_project ON knowledge(project);
      CREATE INDEX idx_knowledge_scope ON knowledge(scope);
    `);

    // Recreate FTS triggers (they reference the old table which was dropped)
    const ftsExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'",
      )
      .get();

    if (ftsExists) {
      db.exec(`
        DROP TRIGGER IF EXISTS knowledge_ai;
        DROP TRIGGER IF EXISTS knowledge_ad;
        DROP TRIGGER IF EXISTS knowledge_au;

        DROP TABLE knowledge_fts;

        CREATE VIRTUAL TABLE knowledge_fts USING fts5(
          title,
          content,
          tags,
          content='knowledge',
          content_rowid='rowid'
        );

        -- Rebuild FTS index from current data
        INSERT INTO knowledge_fts(rowid, title, content, tags)
          SELECT rowid, title, content, tags FROM knowledge;

        CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
          INSERT INTO knowledge_fts(rowid, title, content, tags)
          VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
        END;

        CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
          INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags)
          VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
        END;

        CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
          INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags)
          VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
          INSERT INTO knowledge_fts(rowid, title, content, tags)
          VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
        END;
      `);
    }
  }
}
