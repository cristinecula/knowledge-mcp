/**
 * Git operations for sync repos.
 *
 * Wrappers around git CLI commands. Local-only operations (init, commit, etc.)
 * are synchronous. Network operations (pull, push) are async to avoid blocking
 * the event loop during remote I/O.
 *
 * SECURITY: All commands use execFile/execFileSync (not execSync) to avoid
 * shell interpretation of arguments. This prevents command injection via entry
 * titles, remote URLs, or any other interpolated values.
 */

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const execFileAsync = promisify(execFile);

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

/** Check if the local repo has any commits. */
function hasLocalCommits(path: string): boolean {
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Pull changes from remote. Skips if no remote or if remote is empty. */
export async function gitPull(path: string, remote = 'origin'): Promise<boolean> {
  if (!hasRemote(path, remote)) return false;

  try {
    // Fetch first to ensure we know about remote branches
    try {
      await execFileAsync('git', ['fetch', remote], { cwd: path });
    } catch {
      // Fetch might fail if repo is empty or no network
      return false;
    }

    // Check if the remote has any branches — skip pull on empty repos
    let remoteBranch: string;
    try {
      const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', remote], {
        cwd: path,
        encoding: 'utf-8',
      });
      const refs = stdout.trim();
      if (!refs) {
        // Remote has no branches yet (empty repo) — nothing to pull
        return false;
      }
      // Extract the first branch name (e.g., "refs/heads/master" -> "master")
      const match = refs.match(/refs\/heads\/(\S+)/);
      remoteBranch = match ? match[1] : 'master';
    } catch {
      return false;
    }

    if (!hasLocalCommits(path)) {
      // Local repo has no commits (e.g., empty clone where ensureRepoStructure
      // created untracked files). Use checkout to adopt the remote branch
      // instead of pull, which would fail on untracked file conflicts.
      try {
        // Clean up any untracked files that might conflict
        await execFileAsync('git', ['clean', '-fd'], { cwd: path });
        await execFileAsync('git', ['checkout', '-B', remoteBranch, `${remote}/${remoteBranch}`], {
          cwd: path,
        });
      } catch (checkoutError) {
        console.error(`Git checkout from remote failed for ${path}:`, checkoutError);
        return false;
      }
    } else {
      // Use --no-rebase to merge (not rebase) and --allow-unrelated-histories
      // to handle the case where both sides created independent root commits
      // (e.g., both agents cloned an empty remote and committed independently).
      try {
        await execFileAsync(
          'git',
          ['pull', '--no-rebase', '--allow-unrelated-histories', remote, remoteBranch],
          { cwd: path },
        );
      } catch {
        // Pull failed — likely a merge conflict. For knowledge sync, we resolve
        // git-level conflicts by accepting the REMOTE version of all conflicting
        // files. The application-level merge logic in pull() will then see the
        // remote content on disk and the local content in the DB, and correctly
        // detect and handle conflicts (creating [Sync Conflict] entries).
        try {
          // Check if we're in a merge state
          execFileSync('git', ['rev-parse', 'MERGE_HEAD'], { cwd: path, stdio: 'ignore' });

          // Accept "theirs" (remote) for all conflicting files
          await execFileAsync('git', ['checkout', '--theirs', '.'], { cwd: path });
          await execFileAsync('git', ['add', '-A'], { cwd: path });
          await execFileAsync('git', ['commit', '--no-edit'], { cwd: path });
        } catch (mergeError) {
          // If we can't resolve, abort the merge to leave repo in clean state
          try {
            execFileSync('git', ['merge', '--abort'], { cwd: path, stdio: 'ignore' });
          } catch {
            // Already clean
          }
          console.error(`Git pull merge conflict resolution failed for ${path}:`, mergeError);
          return false;
        }
      }
    }

    return true;
  } catch (error) {
    console.error(`Git pull failed for ${path}:`, error);
    return false;
  }
}

/** Commit metadata from git log. */
export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
}

/**
 * Get the git log for a specific file.
 * Returns an array of commits that touched the file, newest first.
 * Returns [] if the file has no history, the repo has no commits, or on any error.
 */
export function gitFileLog(repoPath: string, filePath: string, limit = 20): GitLogEntry[] {
  try {
    const output = execFileSync(
      'git',
      ['log', `--pretty=format:%H|%aI|%s`, `-n`, String(limit), '--', filePath],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    if (!output.trim()) return [];

    return output
      .trim()
      .split('\n')
      .map((line) => {
        const firstPipe = line.indexOf('|');
        const secondPipe = line.indexOf('|', firstPipe + 1);
        if (firstPipe === -1 || secondPipe === -1) return null;
        return {
          hash: line.slice(0, firstPipe),
          date: line.slice(firstPipe + 1, secondPipe),
          message: line.slice(secondPipe + 1),
        };
      })
      .filter((entry): entry is GitLogEntry => entry !== null);
  } catch {
    return [];
  }
}

/**
 * Get the content of a file at a specific git commit.
 * The filePath must be relative to the repo root (e.g., "entries/fact/uuid.json").
 * Returns the file content as a string, or null if the file/commit doesn't exist.
 */
export function gitShowFile(repoPath: string, commitHash: string, relativeFilePath: string): string | null {
  try {
    return execFileSync(
      'git',
      ['show', `${commitHash}:${relativeFilePath}`],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    return null;
  }
}

/** Push changes to remote. Skips if no remote. */
export async function gitPush(path: string, remote = 'origin'): Promise<boolean> {
  if (!hasRemote(path, remote)) return false;

  try {
    // Try simple push first
    try {
      await execFileAsync('git', ['push', remote], { cwd: path });
    } catch {
      // If fails (e.g., first push), try setting upstream
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: path,
        encoding: 'utf-8',
      });
      const currentBranch = stdout.trim();
      if (currentBranch) {
        await execFileAsync('git', ['push', '-u', remote, currentBranch], { cwd: path });
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
