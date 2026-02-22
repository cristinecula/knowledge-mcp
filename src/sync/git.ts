/**
 * Git operations for sync repos.
 *
 * Wrappers around git CLI commands. All operations are synchronous and blocking.
 * Failures are logged to stderr but generally non-fatal (except where noted).
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

/** Check if a directory is a git repository. */
export function isGitRepo(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    execSync('git rev-parse --is-inside-work-tree', { cwd: path, stdio: 'ignore' });
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
    execSync('git init', { cwd: path, stdio: 'ignore' });
    return true;
  } catch (error) {
    console.error(`Git init failed for ${path}:`, error);
    return false;
  }
}

/** Clone a repository. */
export function gitClone(remote: string, path: string): boolean {
  try {
    // Parent directory must exist
    const parent = path.substring(0, path.lastIndexOf('/'));
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    execSync(`git clone "${remote}" "${path}"`, { stdio: 'pipe' });
    return true;
  } catch (error) {
    console.error(`Git clone failed for ${remote} -> ${path}:`, error);
    return false;
  }
}

/** Check if a remote exists. */
export function hasRemote(path: string, remote = 'origin'): boolean {
  try {
    execSync(`git remote get-url ${remote}`, { cwd: path, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Add a remote. */
export function gitAddRemote(path: string, url: string, remote = 'origin'): boolean {
  try {
    execSync(`git remote add ${remote} "${url}"`, { cwd: path, stdio: 'ignore' });
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
    execSync('git add -A', { cwd: path, stdio: 'ignore' });

    // Check if there are staged changes
    try {
      execSync('git diff --cached --quiet', { cwd: path, stdio: 'ignore' });
      return false; // No changes to commit
    } catch {
      // Exit code 1 means differences exist -> proceed to commit
    }

    // Commit
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: path, stdio: 'ignore' });
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
    // Check if branch exists on remote
    try {
        // Fetch first to ensure we know about remote branches
        execSync(`git fetch ${remote}`, { cwd: path, stdio: 'ignore' });
    } catch {
        // Fetch might fail if repo is empty or no network, but pull handles that
    }
    
    // Try to pull. Use --rebase to keep history clean? No, let's stick to standard merge for now.
    // If it's a fresh repo, we might be on 'main' or 'master'.
    // We'll rely on git's default behavior for the current branch.
    execSync(`git pull ${remote}`, { cwd: path, stdio: 'pipe' });
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
      execSync(`git push ${remote}`, { cwd: path, stdio: 'pipe' });
    } catch {
      // If fails (e.g., first push), try setting upstream
      // We need to know the current branch name
      const currentBranch = execSync('git branch --show-current', { cwd: path, encoding: 'utf-8' }).trim();
      if (currentBranch) {
        execSync(`git push -u ${remote} ${currentBranch}`, { cwd: path, stdio: 'pipe' });
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
