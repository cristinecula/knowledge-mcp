import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deprecateKnowledge } from '../db/queries.js';
import { syncWriteEntry, scheduleCommit } from '../sync/index.js';

export function registerDeprecateTool(server: McpServer): void {
  server.registerTool(
    'deprecate_knowledge',
    {
      description:
        'Mark a knowledge entry as deprecated. Deprecated entries decay 10x faster ' +
        'and will quickly fade from query results. Use this when knowledge is outdated, ' +
        'incorrect, or no longer applicable. The entry is not deleted — it becomes ' +
        'progressively harder to find, like a fading memory.',
      inputSchema: {
        id: z.string().uuid().describe('The UUID of the entry to deprecate'),
        reason: z.string().describe('The reason why this knowledge is being deprecated'),
      },
    },
    async ({ id, reason }) => {
      try {
        const deprecated = deprecateKnowledge(id, reason);
        if (deprecated) {
          syncWriteEntry(deprecated);
          
          // Schedule a debounced git commit
          scheduleCommit(`knowledge: deprecate ${deprecated.type} "${deprecated.title}"`);

          return {
            content: [
              {
                type: 'text',
                text: `Deprecated knowledge entry: ${deprecated.title} (ID: ${id})\nReason: ${reason}`,
              },
            ],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Entry not found: ${id}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to deprecate entry: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
