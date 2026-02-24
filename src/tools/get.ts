import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getKnowledgeById, recordAccess, getLinksForEntry } from '../db/queries.js';

export function registerGetTool(server: McpServer): void {
  server.registerTool(
    'get_knowledge',
    {
      description:
        'Retrieve the full content of a knowledge entry by ID. ' +
        'Use this after query_knowledge or list_knowledge to read the complete content ' +
        'of an entry (search results return truncated content). ' +
        'Accessing an entry automatically reinforces it.',
      inputSchema: {
        id: z.string().describe('ID of the knowledge entry to retrieve'),
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

        // Auto-reinforce: bump access count
        recordAccess(id, 1);

        // Fetch links
        const links = getLinksForEntry(id);

        const result: Record<string, unknown> = {
          id: entry.id,
          type: entry.type,
          title: entry.title,
          content: entry.content,
          tags: entry.tags,
          project: entry.project,
          scope: entry.scope,
          strength: Math.round(entry.strength * 1000) / 1000,
          status: entry.status,
          access_count: entry.access_count + 1,
          last_accessed_at: new Date().toISOString(),
          needs_revalidation: entry.status === 'needs_revalidation',
          link_count: links.length,
          links: links.map((l) => ({
            link_id: l.id,
            linked_entry_id: l.source_id === entry.id ? l.target_id : l.source_id,
            link_type: l.link_type,
            direction: l.source_id === entry.id ? 'outgoing' : 'incoming',
          })),
        };
        if (entry.declaration) {
          result.declaration = entry.declaration;
        }
        if (entry.deprecation_reason) {
          result.deprecation_reason = entry.deprecation_reason;
        }
        if (entry.flag_reason) {
          result.flag_reason = entry.flag_reason;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error retrieving knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
