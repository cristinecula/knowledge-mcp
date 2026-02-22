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
      last_accessed_at TEXT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      strength REAL NOT NULL DEFAULT 1.0,
      status TEXT NOT NULL DEFAULT 'active'
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
