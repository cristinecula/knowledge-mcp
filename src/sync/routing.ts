/**
 * Routing logic for multi-repo sync.
 *
 * Determine which repo an entry belongs to based on its scope and project.
 */

import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import type { KnowledgeEntry, Scope } from '../types.js';

/** Configuration for a single sync repo. */
export interface SyncRepoConfig {
  name: string;
  path: string;
  remote?: string;
  scope?: Scope; // Filter by scope (if present)
  project?: string; // Filter by project (if present)
}

/** Full sync configuration. */
export interface SyncConfig {
  repos: SyncRepoConfig[];
}

/** Zod schema for validation. */
const SyncConfigSchema = z.object({
  repos: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      remote: z.string().optional(),
      scope: z.enum(['company', 'project', 'repo']).optional(),
      project: z.string().optional(),
    }),
  ),
});

/** Load sync configuration from a JSON file. */
export function loadSyncConfig(path: string): SyncConfig {
  if (!existsSync(path)) {
    throw new Error(`Sync config file not found: ${path}`);
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const data = JSON.parse(content);
    return SyncConfigSchema.parse(data);
  } catch (error) {
    throw new Error(`Invalid sync config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolve the correct repo for a knowledge entry.
 *
 * Rules:
 * 1. Check repos with filters first (in config order).
 * 2. If scope matches AND project matches (if specified), use that repo.
 * 3. Fallback to the LAST repo in the list if no filter matches.
 */
export function resolveRepo(entry: KnowledgeEntry, config: SyncConfig): SyncRepoConfig {
  return resolveRepoForScope(entry.scope, entry.project, config);
}

/**
 * Resolve repo based on scope and project (e.g., for new entries).
 */
export function resolveRepoForScope(
  scope: Scope,
  project: string | null,
  config: SyncConfig,
): SyncRepoConfig {
  // Check filtered repos
  for (const repo of config.repos) {
    // Skip if repo has no filters (it's a catch-all)
    if (!repo.scope && !repo.project) continue;

    let matches = true;

    // Check scope filter
    if (repo.scope && repo.scope !== scope) {
      matches = false;
    }

    // Check project filter
    if (repo.project && repo.project !== project) {
      matches = false;
    }

    if (matches) {
      return repo;
    }
  }

  // Fallback to the last repo (catch-all)
  if (config.repos.length > 0) {
    return config.repos[config.repos.length - 1];
  }

  throw new Error('No sync repos configured');
}
