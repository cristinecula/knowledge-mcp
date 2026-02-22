import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getKnowledgeById, deleteKnowledge } from '../db/queries.js';
import { deleteEmbedding } from '../db/queries.js';

export function registerDeleteTool(server: McpServer): void {
  server.registerTool(
    'delete_knowledge',
    {
      description:
        'Permanently delete a knowledge entry and all its associated links and embeddings. ' +
        'This is irreversible. Use deprecate_knowledge for outdated knowledge that should ' +
        'fade naturally; use delete only for entries created by mistake or containing errors.',
      inputSchema: {
        id: z.string().describe('ID of the knowledge entry to delete'),
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

        // Delete embedding first (before CASCADE removes the foreign key target)
        deleteEmbedding(id);

        // Delete the entry (CASCADE handles links, FTS trigger handles search index)
        const deleted = deleteKnowledge(id);

        if (!deleted) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to delete knowledge entry: ${id}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  id: entry.id,
                  title: entry.title,
                  type: entry.type,
                  message: 'Entry permanently deleted along with all associated links and embeddings.',
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
              text: `Error deleting knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
