#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb, closeDb } from './db/connection.js';
import { runMaintenanceSweep } from './memory/maintenance.js';
import { startGraphServer, stopGraphServer } from './graph/server.js';
import { registerStoreTool } from './tools/store.js';
import { registerQueryTool } from './tools/query.js';
import { registerListTool } from './tools/list.js';
import { registerReinforceTool } from './tools/reinforce.js';
import { registerDeprecateTool } from './tools/deprecate.js';
import { registerLinkTool } from './tools/link.js';
import { registerUpdateTool } from './tools/update.js';

// Parse CLI arguments
const args = process.argv.slice(2);
let dbPath: string | undefined;
let graphPort = 3333;
let noGraph = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--db-path' && args[i + 1]) {
    dbPath = args[++i];
  } else if (args[i] === '--graph-port' && args[i + 1]) {
    graphPort = parseInt(args[++i], 10);
  } else if (args[i] === '--no-graph') {
    noGraph = true;
  } else if (args[i] === '--help') {
    console.error(`
knowledge-mcp — Shared Agent Knowledge System (MCP Server)

Usage:
  knowledge-mcp [options]

Options:
  --db-path <path>     Path to SQLite database (default: ~/.knowledge-mcp/knowledge.db)
  --graph-port <port>  Port for knowledge graph visualization (default: 3333)
  --no-graph           Disable the graph visualization server
  --help               Show this help message
`);
    process.exit(0);
  }
}

async function main(): Promise<void> {
  // Initialize database
  getDb(dbPath);
  console.error('Database initialized');

  // Run maintenance sweep (recalculate strengths, transition dormant entries)
  const sweep = runMaintenanceSweep();
  console.error(
    `Maintenance sweep: ${sweep.processed} entries processed, ${sweep.transitioned} transitioned to dormant`,
  );

  // Create MCP server
  const server = new McpServer({
    name: 'knowledge-mcp',
    version: '1.0.0',
  });

  // Register all tools
  registerStoreTool(server);
  registerQueryTool(server);
  registerListTool(server);
  registerReinforceTool(server);
  registerDeprecateTool(server);
  registerLinkTool(server);
  registerUpdateTool(server);

  console.error('7 tools registered');

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

  // Clean shutdown
  const shutdown = async () => {
    clearInterval(maintenanceInterval);
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
