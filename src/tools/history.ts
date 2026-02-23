/**
 * MCP tools for entry version history.
 *
 * get_entry_history — list git commits that modified an entry
 * get_entry_at_version — retrieve the full entry content at a specific commit
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getEntryHistory, getEntryAtCommit } from '../sync/index.js';

export function registerHistoryTools(server: McpServer): void {
  server.registerTool(
    'get_entry_history',
    {
      description:
        'Get the git commit history for a knowledge entry. Returns a list of commits ' +
        '(newest first) that modified the entry. Use this to see when an entry was ' +
        'created, how many times it has been updated, and what changes were made. ' +
        'Requires sync to be configured. Returns empty if sync is disabled or the ' +
        'entry has never been committed.',
      inputSchema: {
        id: z.string().uuid().describe('The UUID of the knowledge entry'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum number of commits to return (default: 20, max: 100)'),
      },
    },
    async ({ id, limit }) => {
      try {
        const history = getEntryHistory(id, limit ?? 20);

        if (history.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No version history available for entry ${id}.\nThis could mean sync is not configured, the entry doesn't exist, or it has never been committed to git.`,
              },
            ],
          };
        }

        const lines = history.map(
          (commit, i) =>
            `${i + 1}. [${commit.hash.slice(0, 7)}] ${commit.date} — ${commit.message}`,
        );

        return {
          content: [
            {
              type: 'text',
              text: `Version history for entry ${id} (${history.length} commit${history.length !== 1 ? 's' : ''}):\n\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get entry history: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'get_entry_at_version',
    {
      description:
        'Retrieve the full content of a knowledge entry at a specific git commit. ' +
        'Use this after get_entry_history to inspect what an entry looked like at a ' +
        'particular point in time. Returns the entry JSON as it was stored at that commit.',
      inputSchema: {
        id: z.string().uuid().describe('The UUID of the knowledge entry'),
        hash: z
          .string()
          .min(4)
          .describe('The git commit hash (full or abbreviated, minimum 4 characters)'),
      },
    },
    async ({ id, hash }) => {
      try {
        const entry = getEntryAtCommit(id, hash);

        if (!entry) {
          return {
            content: [
              {
                type: 'text',
                text: `Version not found: could not retrieve entry ${id} at commit ${hash}.\nThe commit hash may be invalid, sync may not be configured, or the entry may not exist at that commit.`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(entry, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get entry at version: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
