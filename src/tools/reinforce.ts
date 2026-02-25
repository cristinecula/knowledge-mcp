import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getKnowledgeById,
  recordAccess,
  resetInaccuracy,
} from '../db/queries.js';
import { INACCURACY_THRESHOLD } from '../types.js';
import { syncWriteEntry } from '../sync/write-through.js';
import { scheduleCommit } from '../sync/commit-scheduler.js';

export function registerReinforceTool(server: McpServer): void {
  server.registerTool(
    'reinforce_knowledge',
    {
      description:
        'Explicitly reinforce a knowledge entry, confirming it is still accurate and useful. ' +
        'This resets the entry\'s inaccuracy score to 0, clearing any revalidation need. ' +
        'Also records an access to keep the entry\'s last_accessed_at current.',
      inputSchema: {
        id: z.string().describe('ID of the knowledge entry to reinforce'),
      },
    },
    async ({ id }) => {
      try {
        const entry = getKnowledgeById(id);
        if (!entry) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Knowledge entry not found: ${id}`,
              },
            ],
            isError: true,
          };
        }

        // Record access
        recordAccess(id, 1);

        // Reset inaccuracy (reinforcing confirms entry is accurate)
        const previousInaccuracy = entry.inaccuracy;
        if (previousInaccuracy > 0) {
          resetInaccuracy(id);
        }

        const updated = getKnowledgeById(id)!;

        // Sync the change (inaccuracy reset now bumps version)
        if (previousInaccuracy > 0) {
          syncWriteEntry(updated);
          scheduleCommit(`knowledge: reinforce "${updated.title}"`);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  id: updated.id,
                  title: updated.title,
                  access_count: updated.access_count,
                  status: updated.status,
                  previous_inaccuracy: Math.round(previousInaccuracy * 1000) / 1000,
                  new_inaccuracy: 0,
                  revalidation_cleared: previousInaccuracy >= INACCURACY_THRESHOLD,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error reinforcing knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
