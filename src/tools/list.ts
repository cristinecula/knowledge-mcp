import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KNOWLEDGE_TYPES, SCOPES } from '../types.js';
import { listKnowledge, countKnowledge, getLinksForEntries } from '../db/queries.js';

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
          .enum(['active', 'deprecated', 'needs_revalidation', 'all'])
          .optional()
          .describe('Filter by status (default: active + needs_revalidation)'),
        sort_by: z
          .enum(['strength', 'recent', 'created'])
          .optional()
          .describe('Sort order: strength (default), recent (last accessed), created'),
        limit: z.number().min(1).max(100).optional().describe('Max results (default: 20, max: 100)'),
        offset: z.number().min(0).optional().describe('Offset for pagination (default: 0). Use with limit to page through results.'),
      },
    },
    async ({ type, project, scope, status, sort_by, limit, offset }) => {
      try {
        const effectiveLimit = limit ?? 20;
        const effectiveOffset = offset ?? 0;

        const filterParams = {
          type,
          project,
          scope,
          status,
          includeWeak: status === 'all',
        };

        const total = countKnowledge(filterParams);

        const entries = listKnowledge({
          ...filterParams,
          sortBy: sort_by,
          limit: effectiveLimit,
          offset: effectiveOffset,
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

        // Fetch links to detect conflicts_with (batched in 1 query)
        const allLinks = getLinksForEntries(entries.map((e) => e.id));
        const warnings: string[] = [];

        const results = entries.map((entry) => {
          const links = allLinks.get(entry.id) ?? [];

          // Check for conflicts_with links (sync conflict indicators)
          const conflictLinks = links.filter((l) => l.link_type === 'conflicts_with');
          if (conflictLinks.length > 0) {
            for (const cl of conflictLinks) {
              const isConflictCopy = cl.source_id === entry.id;
              if (isConflictCopy) {
                warnings.push(
                  `Entry "${entry.title}" (${entry.id}) is a sync conflict copy. ` +
                  `The canonical version is ${cl.target_id}. ` +
                  `Review both versions, update the canonical entry if needed, then delete this conflict copy and its conflicts_with link.`,
                );
              } else {
                warnings.push(
                  `Entry "${entry.title}" (${entry.id}) has an unresolved sync conflict. ` +
                  `A conflict copy with local changes exists at ${cl.source_id}. ` +
                  `Review both versions, update this entry if the local changes should be kept, then delete the conflict copy and its conflicts_with link.`,
                );
              }
            }
          }

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
          if (entry.declaration) {
            result.declaration = entry.declaration;
          }
          if (entry.deprecation_reason) {
            result.deprecation_reason = entry.deprecation_reason;
          }
          return result;
        });

        const responseEnvelope: Record<string, unknown> = {
          count: results.length,
          total,
          offset: effectiveOffset,
          has_more: (effectiveOffset + results.length) < total,
          filter: { type, project, scope, status: status ?? 'active+needs_revalidation', sort_by },
          results,
        };
        if (warnings.length > 0) {
          responseEnvelope.warnings = warnings;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(responseEnvelope, null, 2),
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
