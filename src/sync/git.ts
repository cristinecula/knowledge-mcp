/**
 * Git operations for sync repos.
 *
 * Wrappers around git CLI commands. All operations are synchronous and blocking.
 * Failures are logged to stderr but generally non-fatal (except where noted).
 *
 * SECURITY: All commands use execFileSync (not execSync) to avoid shell
 * interpretation of arguments. This prevents command injection via entry
 * titles, remote URLs, or any other interpolated values.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Check if a directory is a git repository. */
export function isGitRepo(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: path, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Initialize a git repository. */
export function gitInit(path: string): boolean {
  try {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
    execFileSync('git', ['init'], { cwd: path, stdio: 'ignore' });
    return true;
  } catch (error) {
    console.error(`Git init failed for ${path}:`, error);
    return false;
  }
}

/** Clone a repository. */
export function gitClone(remote: string, path: string): boolean {
  try {
    const parent = dirname(path);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    execFileSync('git', ['clone', remote, path], { stdio: 'pipe' });
    return true;
  } catch (error) {
    console.error(`Git clone failed for ${remote} -> ${path}:`, error);
    return false;
  }
}

/** Check if a remote exists. */
export function hasRemote(path: string, remote = 'origin'): boolean {
  try {
    execFileSync('git', ['remote', 'get-url', remote], { cwd: path, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Add a remote. */
export function gitAddRemote(path: string, url: string, remote = 'origin'): boolean {
  try {
    execFileSync('git', ['remote', 'add', remote, url], { cwd: path, stdio: 'ignore' });
    return true;
  } catch (error) {
    console.error(`Git remote add failed for ${path}:`, error);
    return false;
  }
}

/**
 * Commit all changes in the repo.
 * Returns true if changes were committed, false if clean or error.
 */
export function gitCommitAll(path: string, message: string): boolean {
  try {
    // Stage all changes (including deletions)
    execFileSync('git', ['add', '-A'], { cwd: path, stdio: 'ignore' });

    // Check if there are staged changes
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: path, stdio: 'ignore' });
      return false; // No changes to commit
    } catch {
      // Exit code 1 means differences exist -> proceed to commit
    }

    // Commit — message is passed as a single argument, no shell escaping needed
    execFileSync('git', ['commit', '-m', message], { cwd: path, stdio: 'ignore' });
    return true;
  } catch (error) {
    console.error(`Git commit failed for ${path}:`, error);
    return false;
  }
}

/** Pull changes from remote. Skips if no remote. */
export function gitPull(path: string, remote = 'origin'): boolean {
  if (!hasRemote(path, remote)) return false;

  try {
    // Fetch first to ensure we know about remote branches
    try {
      execFileSync('git', ['fetch', remote], { cwd: path, stdio: 'ignore' });
    } catch {
      // Fetch might fail if repo is empty or no network, but pull handles that
    }

    execFileSync('git', ['pull', remote], { cwd: path, stdio: 'pipe' });
    return true;
  } catch (error) {
    console.error(`Git pull failed for ${path}:`, error);
    return false;
  }
}

/** Push changes to remote. Skips if no remote. */
export function gitPush(path: string, remote = 'origin'): boolean {
  if (!hasRemote(path, remote)) return false;

  try {
    // Try simple push first
    try {
      execFileSync('git', ['push', remote], { cwd: path, stdio: 'pipe' });
    } catch {
      // If fails (e.g., first push), try setting upstream
      const currentBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: path,
        encoding: 'utf-8',
      }).trim();
      if (currentBranch) {
        execFileSync('git', ['push', '-u', remote, currentBranch], { cwd: path, stdio: 'pipe' });
      } else {
        throw new Error('Could not determine current branch');
      }
    }
    return true;
  } catch (error) {
    console.error(`Git push failed for ${path}:`, error);
    return false;
  }
}
