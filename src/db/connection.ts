import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { initSchema } from './schema.js';

let db: Database.Database | null = null;

const DEFAULT_DB_DIR = resolve(homedir(), '.knowledge-mcp');
const DEFAULT_DB_PATH = resolve(DEFAULT_DB_DIR, 'knowledge.db');

/**
 * Get or create the SQLite database connection.
 * Creates the directory and schema on first call.
 */
export function getDb(dbPath?: string): Database.Database {
  if (db) return db;

  const path = dbPath ?? DEFAULT_DB_PATH;
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(path);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  // Enable foreign keys
  db.pragma('foreign_keys = ON');
  // Performance: NORMAL is safe with WAL (no risk of DB corruption, only
  // last transaction can be lost on OS crash — acceptable for our use case)
  db.pragma('synchronous = NORMAL');
  // Increase page cache from default 2MB to 8MB
  db.pragma('cache_size = -8000');
  // Wait up to 5s on SQLITE_BUSY instead of failing immediately
  // (important when multiple MCP server processes share the same DB)
  db.pragma('busy_timeout = 5000');
  // Keep temp tables in memory
  db.pragma('temp_store = MEMORY');

  initSchema(db);

  return db;
}

/**
 * Close the database connection (for clean shutdown).
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Reset the database connection. Closes the existing connection (if any)
 * and creates a fresh one at the given path.
 *
 * Primarily used for testing — pass ':memory:' for an isolated in-memory DB.
 */
export function resetDb(dbPath?: string): Database.Database {
  closeDb();
  return getDb(dbPath ?? ':memory:');
}
