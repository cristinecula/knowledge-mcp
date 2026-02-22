import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KNOWLEDGE_TYPES, SCOPES } from '../types.js';
import { listKnowledge } from '../db/queries.js';

export function registerListTool(server: McpServer): void {
  server.registerTool(
    'list_knowledge',
    {
      description:
        'Browse and filter knowledge entries without a text search query. ' +
        'Use this to see what knowledge exists by type, project, scope, or status. ' +
        'Unlike query_knowledge, this does NOT auto-reinforce entries.',
      inputSchema: {
        type: z.enum(KNOWLEDGE_TYPES).optional().describe('Filter by knowledge type'),
        project: z.string().optional().describe('Filter by project name'),
        scope: z.enum(SCOPES).optional().describe('Filter by scope level'),
        status: z
          .enum(['active', 'dormant', 'deprecated', 'needs_revalidation', 'all'])
          .optional()
          .describe('Filter by status (default: active)'),
        sort_by: z
          .enum(['strength', 'recent', 'created'])
          .optional()
          .describe('Sort order: strength (default), recent (last accessed), created'),
        limit: z.number().min(1).max(100).optional().describe('Max results (default: 20, max: 100)'),
      },
    },
    async ({ type, project, scope, status, sort_by, limit }) => {
      try {
        const filterStatus = status ?? 'active';

        const entries = listKnowledge({
          type,
          project,
          scope,
          status: filterStatus,
          sortBy: sort_by,
          limit: limit ?? 20,
          includeWeak: filterStatus === 'all' || filterStatus === 'dormant',
          includeDormant: filterStatus === 'all' || filterStatus === 'dormant',
        });

        if (entries.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No knowledge entries found matching the specified filters.',
              },
            ],
          };
        }

        const results = entries.map((entry) => {
          const result: Record<string, unknown> = {
            id: entry.id,
            type: entry.type,
            title: entry.title,
            tags: entry.tags,
            project: entry.project,
            scope: entry.scope,
            strength: Math.round(entry.strength * 1000) / 1000,
            status: entry.status,
            access_count: entry.access_count,
            created_at: entry.created_at,
            last_accessed_at: entry.last_accessed_at,
          };
          if (entry.deprecation_reason) {
            result.deprecation_reason = entry.deprecation_reason;
          }
          return result;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  count: results.length,
                  filter: { type, project, scope, status: filterStatus, sort_by },
                  results,
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
              text: `Error listing knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
