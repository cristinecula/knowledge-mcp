import { resetDb, closeDb } from '../db/connection.js';

/**
 * Initialize a fresh in-memory database for testing.
 * Call in beforeEach() to get full test isolation.
 */
export function setupTestDb(): void {
  resetDb(':memory:');
}

/**
 * Clean up the database connection after tests.
 * Call in afterAll() or afterEach().
 */
export function teardownTestDb(): void {
  closeDb();
}
