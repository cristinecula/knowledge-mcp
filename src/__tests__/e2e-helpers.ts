/**
 * E2E test helpers for multi-agent sync testing.
 *
 * Provides utilities for:
 * - Creating bare git repos as shared "remotes" (like GitHub)
 * - Spawning MCP server processes with isolated DBs and sync repos
 * - Calling tools on servers via the MCP protocol
 * - Cleaning everything up after tests
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const SERVER_PATH = resolve(import.meta.dirname, '../../build/index.js');

/** Handle to a running MCP server agent. */
export interface AgentHandle {
  client: Client;
  transport: StdioClientTransport;
  dbPath: string;
  clonePath: string;
  name: string;
  tmpDir: string;
}

/**
 * Create a bare git repo in a temp directory.
 * This acts as a shared "remote" (like GitHub) that agents push/pull to.
 */
export function createBareRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-e2e-remote-'));
  execFileSync('git', ['init', '--bare'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

/**
 * Spawn an MCP server as a child process with its own DB and sync repo clone.
 *
 * The agent gets:
 * - A fresh SQLite database (file-based, in temp dir)
 * - A clone of the given bare remote
 * - No graph server, no embeddings
 *
 * The server is connected via MCP stdio protocol.
 */
export async function spawnAgent(remote: string, name: string): Promise<AgentHandle> {
  const tmpDir = mkdtempSync(join(tmpdir(), `knowledge-e2e-${name}-`));
  const dbPath = join(tmpDir, 'knowledge.db');
  const clonePath = join(tmpDir, 'sync');

  // Clone the bare remote
  execFileSync('git', ['clone', remote, clonePath], { stdio: 'pipe' });

  // Ensure basic git config for commits
  execFileSync('git', ['config', 'user.email', `${name}@test.local`], { cwd: clonePath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', name], { cwd: clonePath, stdio: 'pipe' });

  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      SERVER_PATH,
      '--db-path', dbPath,
      '--sync-repo', clonePath,
      '--embedding-provider', 'none',
      '--no-graph',
    ],
    stderr: 'pipe',
  });

  const client = new Client({ name: `e2e-${name}`, version: '1.0.0' });
  await client.connect(transport);

  return { client, transport, dbPath, clonePath, name, tmpDir };
}

/**
 * Spawn an MCP server with periodic sync enabled.
 *
 * Same as spawnAgent but with a configurable --sync-interval.
 */
export async function spawnAgentWithInterval(
  remote: string,
  name: string,
  syncIntervalSec: number,
): Promise<AgentHandle> {
  const tmpDir = mkdtempSync(join(tmpdir(), `knowledge-e2e-${name}-`));
  const dbPath = join(tmpDir, 'knowledge.db');
  const clonePath = join(tmpDir, 'sync');

  // Clone the bare remote
  execFileSync('git', ['clone', remote, clonePath], { stdio: 'pipe' });

  // Ensure basic git config for commits
  execFileSync('git', ['config', 'user.email', `${name}@test.local`], { cwd: clonePath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', name], { cwd: clonePath, stdio: 'pipe' });

  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      SERVER_PATH,
      '--db-path', dbPath,
      '--sync-repo', clonePath,
      '--sync-interval', String(syncIntervalSec),
      '--embedding-provider', 'none',
      '--no-graph',
    ],
    stderr: 'pipe',
  });

  const client = new Client({ name: `e2e-${name}`, version: '1.0.0' });
  await client.connect(transport);

  return { client, transport, dbPath, clonePath, name, tmpDir };
}

/**
 * Spawn an MCP server with a multi-repo sync config.
 *
 * @param configRepos - Array of { name, remote, scope?, project? } — each will be cloned
 * @param agentName - Name for the agent
 */
export async function spawnAgentWithConfig(
  configRepos: Array<{ name: string; remote: string; scope?: string; project?: string }>,
  agentName: string,
): Promise<AgentHandle & { configPath: string; clonePaths: string[] }> {
  const tmpDir = mkdtempSync(join(tmpdir(), `knowledge-e2e-${agentName}-`));
  const dbPath = join(tmpDir, 'knowledge.db');
  const clonePaths: string[] = [];

  // Clone each remote and build the config
  const repos = configRepos.map((r) => {
    const clonePath = join(tmpDir, `sync-${r.name}`);
    execFileSync('git', ['clone', r.remote, clonePath], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', `${agentName}@test.local`], { cwd: clonePath, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', agentName], { cwd: clonePath, stdio: 'pipe' });
    clonePaths.push(clonePath);

    const repo: Record<string, string> = { name: r.name, path: clonePath, remote: r.remote };
    if (r.scope) repo.scope = r.scope;
    if (r.project) repo.project = r.project;
    return repo;
  });

  const configPath = join(tmpDir, 'sync-config.json');
  writeFileSync(configPath, JSON.stringify({ repos }, null, 2));

  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      SERVER_PATH,
      '--db-path', dbPath,
      '--sync-config', configPath,
      '--embedding-provider', 'none',
      '--no-graph',
    ],
    stderr: 'pipe',
  });

  const client = new Client({ name: `e2e-${agentName}`, version: '1.0.0' });
  await client.connect(transport);

  return { client, transport, dbPath, clonePath: clonePaths[0], clonePaths, name: agentName, tmpDir, configPath };
}

/**
 * Spawn an agent that uses --sync-config with a pre-written config file.
 * Does NOT pre-clone repos — relies on the server's auto-clone.
 */
export async function spawnAgentAutoClone(
  configRepos: Array<{ name: string; path: string; remote: string; scope?: string; project?: string }>,
  agentName: string,
): Promise<AgentHandle & { configPath: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), `knowledge-e2e-${agentName}-`));
  const dbPath = join(tmpDir, 'knowledge.db');

  const configPath = join(tmpDir, 'sync-config.json');
  writeFileSync(configPath, JSON.stringify({ repos: configRepos }, null, 2));

  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      SERVER_PATH,
      '--db-path', dbPath,
      '--sync-config', configPath,
      '--embedding-provider', 'none',
      '--no-graph',
    ],
    stderr: 'pipe',
  });

  const client = new Client({ name: `e2e-${agentName}`, version: '1.0.0' });
  await client.connect(transport);

  return { client, transport, dbPath, clonePath: configRepos[0].path, name: agentName, tmpDir, configPath };
}

/**
 * Call a knowledge tool on an agent and return the parsed JSON response.
 * Throws if the tool returns an error.
 */
export async function callTool(
  agent: AgentHandle,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await agent.client.callTool({ name: tool, arguments: args });

  // Extract text content
  const content = result.content as Array<{ type: string; text?: string }>;
  const textContent = content.find((c) => c.type === 'text');

  if (!textContent || !textContent.text) {
    throw new Error(`Tool ${tool} returned no text content`);
  }

  if (result.isError) {
    throw new Error(`Tool ${tool} error: ${textContent.text}`);
  }

  // Try to parse as JSON, fall back to raw text
  try {
    return JSON.parse(textContent.text);
  } catch {
    return textContent.text;
  }
}

/**
 * Store a knowledge entry on an agent. Returns the entry ID.
 */
export async function storeEntry(
  agent: AgentHandle,
  opts: {
    title: string;
    content: string;
    type?: string;
    scope?: string;
    project?: string;
    tags?: string[];
  },
): Promise<{ id: string; [key: string]: unknown }> {
  const result = await callTool(agent, 'store_knowledge', {
    title: opts.title,
    content: opts.content,
    type: opts.type ?? 'fact',
    scope: opts.scope ?? 'company',
    project: opts.project,
    tags: opts.tags ?? [],
    source: `e2e-${agent.name}`,
  });
  return result as { id: string; [key: string]: unknown };
}

/**
 * Query knowledge entries on an agent. Returns the results array.
 */
export async function queryEntries(
  agent: AgentHandle,
  query: string,
  limit = 50,
): Promise<{ count: number; results: Array<{ id: string; title: string; [key: string]: unknown }> }> {
  const result = await callTool(agent, 'query_knowledge', {
    query,
    limit,
  });

  // query_knowledge returns a plain text string when no results are found
  if (typeof result === 'string') {
    return { count: 0, results: [] };
  }

  return result as { count: number; results: Array<{ id: string; title: string; [key: string]: unknown }> };
}

/**
 * Sync an agent (push, pull, or both). Returns the sync result.
 */
export async function syncAgent(
  agent: AgentHandle,
  direction: 'push' | 'pull' | 'both' = 'both',
): Promise<Record<string, unknown>> {
  return (await callTool(agent, 'sync_knowledge', { direction })) as Record<string, unknown>;
}

/**
 * Destroy an agent: close the MCP connection and clean up temp files.
 */
export async function destroyAgent(agent: AgentHandle): Promise<void> {
  try {
    await agent.transport.close();
  } catch {
    // Process may already be dead
  }

  try {
    if (existsSync(agent.tmpDir)) {
      rmSync(agent.tmpDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`Failed to clean up temp dir for ${agent.name}:`, e);
  }
}

/**
 * Clean up a bare remote directory.
 */
export function destroyRemote(remotePath: string): void {
  try {
    if (existsSync(remotePath)) {
      rmSync(remotePath, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Failed to clean up remote:', e);
  }
}

/**
 * Push entries into a bare remote by creating a temp clone, adding files, and pushing.
 * Useful for seeding data in the remote before agents clone it.
 */
export function seedRemote(
  remotePath: string,
  entries: Array<{
    id: string;
    type: string;
    title: string;
    content: string;
    scope?: string;
    project?: string;
    tags?: string[];
  }>,
  links?: Array<{
    id: string;
    source_id: string;
    target_id: string;
    link_type: string;
    description?: string;
  }>,
): void {
  const tmpDir = mkdtempSync(join(tmpdir(), 'knowledge-e2e-seed-'));

  try {
    execFileSync('git', ['clone', remotePath, tmpDir], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'seed@test.local'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'seed'], { cwd: tmpDir, stdio: 'pipe' });

    // Create directory structure
    const types = ['convention', 'decision', 'pattern', 'pitfall', 'fact', 'debug_note', 'process'];
    for (const t of types) {
      const dir = join(tmpDir, 'entries', t);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    const linksDir = join(tmpDir, 'links');
    if (!existsSync(linksDir)) mkdirSync(linksDir, { recursive: true });

    // Write meta.json
    writeFileSync(join(tmpDir, 'meta.json'), JSON.stringify({ schema_version: 1 }, null, 2) + '\n');

    // Write entries
    const now = new Date().toISOString();
    for (const e of entries) {
      const json = {
        id: e.id,
        type: e.type,
        title: e.title,
        content: e.content,
        tags: e.tags ?? [],
        project: e.project ?? null,
        scope: e.scope ?? 'company',
        source: 'seed',
        status: 'active',
        created_at: now,
        version: 1,
      };
      writeFileSync(join(tmpDir, 'entries', e.type, `${e.id}.json`), JSON.stringify(json, null, 2) + '\n');
    }

    // Write links
    if (links) {
      for (const l of links) {
        const json = {
          id: l.id,
          source_id: l.source_id,
          target_id: l.target_id,
          link_type: l.link_type,
          description: l.description ?? null,
          source: 'seed',
          created_at: now,
        };
        writeFileSync(join(tmpDir, 'links', `${l.id}.json`), JSON.stringify(json, null, 2) + '\n');
      }
    }

    execFileSync('git', ['add', '-A'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'seed data'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: tmpDir, stdio: 'pipe' });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Write a malformed JSON file directly into a bare remote.
 */
export function seedMalformedFile(
  remotePath: string,
  relativePath: string,
  content: string,
): void {
  const tmpDir = mkdtempSync(join(tmpdir(), 'knowledge-e2e-malform-'));

  try {
    execFileSync('git', ['clone', remotePath, tmpDir], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'seed@test.local'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'seed'], { cwd: tmpDir, stdio: 'pipe' });

    const filePath = join(tmpDir, relativePath);
    const dir = join(filePath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);

    execFileSync('git', ['add', '-A'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'add malformed file'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: tmpDir, stdio: 'pipe' });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
