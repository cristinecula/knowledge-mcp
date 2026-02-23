/**
 * Debounced git commit scheduler.
 *
 * Instead of calling `gitCommitAll()` synchronously after every tool call,
 * tools call `scheduleCommit(message)`. The scheduler waits for a short
 * debounce window (150 ms) to batch rapid-fire operations (e.g., store
 * entry + 3 links = 1 commit instead of 4).
 *
 * Call `flushCommit()` before any sync pull/push to ensure all pending
 * writes are committed first.
 */

import { touchedRepos, clearTouchedRepos } from './write-through.js';
import { gitCommitAll } from './git.js';

const DEBOUNCE_MS = 150;

/** Accumulated commit messages for the pending batch. */
let pendingMessages: string[] = [];

/** The active debounce timer (if any). */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Execute the pending commit immediately.
 * Commits all touched repos with a combined message, then clears state.
 */
function executeCommit(): void {
  debounceTimer = null;

  if (touchedRepos.size === 0 || pendingMessages.length === 0) {
    pendingMessages = [];
    return;
  }

  // Combine messages — use first message as headline, append extra lines if multiple
  const message =
    pendingMessages.length === 1
      ? pendingMessages[0]
      : pendingMessages[0] + '\n\n' + pendingMessages.slice(1).join('\n');

  for (const repoPath of touchedRepos) {
    gitCommitAll(repoPath, message);
  }
  clearTouchedRepos();
  pendingMessages = [];
}

/**
 * Schedule a git commit with debouncing. The actual commit fires after
 * DEBOUNCE_MS of inactivity, batching rapid consecutive calls.
 */
export function scheduleCommit(message: string): void {
  pendingMessages.push(message);

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(executeCommit, DEBOUNCE_MS);
}

/**
 * Flush any pending commit immediately. Call this before sync operations
 * to ensure all local changes are committed.
 *
 * No-op if nothing is pending.
 */
export function flushCommit(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  executeCommit();
}

/**
 * Check if there is a pending (not yet committed) batch.
 * Useful for testing.
 */
export function hasPendingCommit(): boolean {
  return debounceTimer !== null;
}

/**
 * Get the debounce window in milliseconds. Exported for tests.
 */
export const COMMIT_DEBOUNCE_MS = DEBOUNCE_MS;
