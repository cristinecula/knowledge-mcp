#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb, closeDb } from './db/connection.js';
import { runMaintenanceSweep } from './memory/maintenance.js';
import { startGraphServer, stopGraphServer } from './graph/server.js';
import {
  createEmbeddingProvider,
  setEmbeddingProvider,
  type EmbeddingProviderType,
} from './embeddings/provider.js';
import { backfillEmbeddings } from './embeddings/similarity.js';
import { getAllEntries } from './db/queries.js';
import { INSTRUCTIONS } from './instructions.js';
import { registerStoreTool } from './tools/store.js';
import { registerQueryTool } from './tools/query.js';
import { registerGetTool } from './tools/get.js';
import { registerListTool } from './tools/list.js';
import { registerReinforceTool } from './tools/reinforce.js';
import { registerDeprecateTool } from './tools/deprecate.js';
import { registerLinkTool } from './tools/link.js';
import { registerUpdateTool } from './tools/update.js';
import { registerDeleteTool } from './tools/delete.js';
import { registerSyncTool } from './tools/sync.js';
import { registerHistoryTools } from './tools/history.js';
import { existsSync } from 'node:fs';
import {
  setSyncConfig,
  isSyncEnabled,
  isSyncInProgress,
  setSyncInProgress,
  tryAcquireSyncLock,
  releaseSyncLock,
  pull,
  push,
  flushCommit,
  loadSyncConfig,
  ensureRepoStructure,
  gitInit,
  gitPull,
  gitClone,
  hasRemote,
  gitAddRemote,
} from './sync/index.js';
import type { SyncConfig } from './sync/index.js';

// Parse CLI arguments
const args = process.argv.slice(2);
let dbPath: string | undefined;
let graphPort = 3333;
let noGraph = false;
let embeddingProviderType: EmbeddingProviderType = 'none';
let openaiApiKey: string | undefined;
let embeddingModel: string | undefined;
let backfill = false;
let syncRepoPath: string | undefined;
let syncConfigPath: string | undefined;
let syncIntervalSec = 300; // default: 5 minutes (0 = disabled)

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--db-path' && args[i + 1]) {
    dbPath = args[++i];
  } else if (args[i] === '--graph-port' && args[i + 1]) {
    graphPort = parseInt(args[++i], 10);
  } else if (args[i] === '--no-graph') {
    noGraph = true;
  } else if (args[i] === '--embedding-provider' && args[i + 1]) {
    embeddingProviderType = args[++i] as EmbeddingProviderType;
  } else if (args[i] === '--openai-api-key' && args[i + 1]) {
    openaiApiKey = args[++i];
  } else if (args[i] === '--embedding-model' && args[i + 1]) {
    embeddingModel = args[++i];
  } else if (args[i] === '--backfill-embeddings') {
    backfill = true;
  } else if (args[i] === '--sync-repo' && args[i + 1]) {
    syncRepoPath = args[++i];
  } else if (args[i] === '--sync-config' && args[i + 1]) {
    syncConfigPath = args[++i];
  } else if (args[i] === '--sync-interval' && args[i + 1]) {
    syncIntervalSec = parseInt(args[++i], 10);
  } else if (args[i] === '--help') {
    console.error(`
knowledge-mcp — Shared Agent Knowledge System (MCP Server)

Usage:
  knowledge-mcp [options]

Options:
  --db-path <path>              Path to SQLite database (default: ~/.knowledge-mcp/knowledge.db)
  --graph-port <port>           Port for knowledge graph visualization (default: 3333)
  --no-graph                    Disable the graph visualization server
  --embedding-provider <type>   Embedding provider: none (default), local, or openai
  --openai-api-key <key>        API key for OpenAI embeddings (or set OPENAI_API_KEY env var)
  --embedding-model <model>     Override the default embedding model
  --backfill-embeddings         Generate embeddings for all existing entries on startup
  --sync-repo <path>            Path to single git repo for knowledge sharing
  --sync-config <path>          Path to JSON config file for multi-repo sync
  --sync-interval <seconds>    Periodic sync interval in seconds (default: 300, 0 to disable)
  --help                        Show this help message
`);
    process.exit(0);
  }
}

async function main(): Promise<void> {
  // Initialize database
  getDb(dbPath);
  console.error('Database initialized');

  // Run maintenance sweep (recalculate strengths)
  const sweep = runMaintenanceSweep();
  console.error(
    `Maintenance sweep: ${sweep.processed} entries processed`,
  );

  // Initialize sync (if configured)
  let config: SyncConfig | null = null;

  if (syncRepoPath && syncConfigPath) {
    console.error('Error: Cannot use both --sync-repo and --sync-config');
    process.exit(1);
  }

  if (syncRepoPath) {
    config = {
      repos: [
        {
          name: 'default',
          path: syncRepoPath,
        },
      ],
    };
  } else if (syncConfigPath) {
    try {
      config = loadSyncConfig(syncConfigPath);
    } catch (error) {
      console.error(`Error loading sync config: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  if (config) {
    setSyncConfig(config);
    console.error(`Sync enabled with ${config.repos.length} repo(s)`);

    // Initialize each repo
    for (const repo of config.repos) {
      // 1. Auto-clone if needed
      if (!existsSync(repo.path)) {
        if (repo.remote) {
          console.error(`Cloning ${repo.name} from ${repo.remote}...`);
          if (!gitClone(repo.remote, repo.path)) {
            console.error(`Failed to clone ${repo.name}. Skipping sync for this repo.`);
            continue;
          }
        } else {
          // Initialize empty repo
          console.error(`Initializing new repo for ${repo.name}...`);
          gitInit(repo.path);
        }
      } else {
        // Ensure it is a git repo
        gitInit(repo.path);
      }

      // 2. Configure remote if needed
      if (repo.remote) {
        if (!hasRemote(repo.path)) {
          gitAddRemote(repo.path, repo.remote);
        } else {
          // Remote exists — we assume it's correct or user manages it
        }
      }

      // 3. Pull changes
      console.error(`Pulling ${repo.name}...`);
      await gitPull(repo.path);

      // 4. Ensure structure
      ensureRepoStructure(repo.path);
    }

    // Pull import
    try {
      const pullResult = await pull(config);
      console.error(
        `Sync pull: ${pullResult.new_entries} new, ${pullResult.updated} updated, ` +
        `${pullResult.deleted} deleted, ${pullResult.conflicts} conflicts, ` +
        `${pullResult.new_links} new links, ${pullResult.deleted_links} deleted links`,
      );
      if (pullResult.conflicts > 0) {
        console.error(`  Conflicts need resolution — check entries with needs_revalidation status`);
      }
    } catch (error) {
      console.error(
        `Warning: Sync pull failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error('Continuing without sync pull.');
    }
  }

  // Initialize embedding provider (if configured)
  if (embeddingProviderType !== 'none') {
    try {
      const provider = await createEmbeddingProvider(embeddingProviderType, {
        apiKey: openaiApiKey,
        model: embeddingModel,
      });
      setEmbeddingProvider(provider);
      console.error(
        `Embedding provider: ${provider!.name} (model: ${provider!.model}, ${provider!.dimensions}d)`,
      );

      // Backfill embeddings for existing entries if requested
      if (backfill) {
        console.error('Backfilling embeddings for existing entries...');
        const entries = getAllEntries();
        const result = await backfillEmbeddings(entries);
        console.error(
          `Backfill complete: ${result.processed} generated, ${result.skipped} already existed`,
        );
      }
    } catch (error) {
      console.error(
        `Warning: Failed to initialize embedding provider: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error('Continuing without semantic search.');
    }
  }

  // Create MCP server
  const server = new McpServer(
    { name: 'knowledge-mcp', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );

  // Register all tools
  registerStoreTool(server);
  registerQueryTool(server);
  registerGetTool(server);
  registerListTool(server);
  registerReinforceTool(server);
  registerDeprecateTool(server);
  registerLinkTool(server);
  registerUpdateTool(server);
  registerDeleteTool(server);
  registerSyncTool(server);
  registerHistoryTools(server);

  const toolCount = isSyncEnabled() ? '12 tools registered (sync enabled)' : '12 tools registered (sync disabled)';
  console.error(toolCount);

  // Start graph visualization server
  if (!noGraph) {
    try {
      const actualPort = await startGraphServer(graphPort);
      console.error(
        `Knowledge graph UI: http://localhost:${actualPort}`,
      );
    } catch (error) {
      console.error(
        `Warning: Could not start graph server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Set up periodic maintenance (every hour)
  const maintenanceInterval = setInterval(() => {
    try {
      runMaintenanceSweep();
    } catch (error) {
      console.error('Maintenance sweep error:', error);
    }
  }, 60 * 60 * 1000);

  // Set up periodic sync (if enabled and interval > 0)
  let syncInterval: ReturnType<typeof setInterval> | null = null;
  if (config && syncIntervalSec > 0) {
    syncInterval = setInterval(async () => {
      if (isSyncInProgress()) return;       // in-process re-entrancy guard
      if (!tryAcquireSyncLock()) return;     // cross-process coordinator lock
      setSyncInProgress(true);
      try {
        // Flush any pending debounced commits before syncing
        flushCommit();
        const pullResult = await pull(config);
        const pushResult = await push(config);
        const total = pullResult.new_entries + pullResult.updated + pullResult.deleted +
          pullResult.conflicts + pushResult.new_entries + pushResult.updated + pushResult.deleted;
        if (total > 0) {
          console.error(
            `Periodic sync: pulled ${pullResult.new_entries} new, ${pullResult.updated} updated, ${pullResult.deleted} deleted, ${pullResult.conflicts} conflicts; ` +
            `pushed ${pushResult.new_entries} new, ${pushResult.updated} updated, ${pushResult.deleted} deleted`,
          );
        }
      } catch (error) {
        console.error(`Periodic sync error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setSyncInProgress(false);
        releaseSyncLock();
      }
    }, syncIntervalSec * 1000);

    console.error(`Periodic sync: every ${syncIntervalSec}s`);
  }

  // Clean shutdown
  const shutdown = async () => {
    clearInterval(maintenanceInterval);
    if (syncInterval) clearInterval(syncInterval);
    // Flush any pending debounced commits before shutting down
    flushCommit();
    await stopGraphServer();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('knowledge-mcp server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
