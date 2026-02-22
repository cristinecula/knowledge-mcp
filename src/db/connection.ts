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
