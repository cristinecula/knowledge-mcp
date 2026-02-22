import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getKnowledgeById, updateStatus, updateKnowledgeFields } from '../db/queries.js';

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
        id: z.string().describe('ID of the knowledge entry to deprecate'),
        reason: z.string().optional().describe('Why this knowledge is being deprecated'),
      },
    },
    async ({ id, reason }) => {
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

        if (entry.status === 'deprecated') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    id: entry.id,
                    title: entry.title,
                    message: 'Entry is already deprecated',
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Mark as deprecated
        updateStatus(id, 'deprecated');

        // Append deprecation reason to content if provided
        if (reason) {
          const updatedContent =
            entry.content + `\n\n---\n**Deprecated:** ${reason}`;
          updateKnowledgeFields(id, { content: updatedContent });
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  id: entry.id,
                  title: entry.title,
                  status: 'deprecated',
                  reason: reason ?? null,
                  message:
                    'Entry marked as deprecated. It will decay 10x faster and fade from results.',
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
              text: `Error deprecating knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
