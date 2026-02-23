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
      strength REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'active',
      synced_at TEXT,
      deprecation_reason TEXT,
      declaration TEXT,
      parent_page_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge(status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_strength ON knowledge(strength);
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

  // Backfill: ensure content_updated_at is set for any rows where it's empty
  db.exec(`UPDATE knowledge SET content_updated_at = updated_at WHERE content_updated_at = ''`);
}
