import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KNOWLEDGE_TYPES, SCOPES } from '../types.js';
import { searchKnowledge, recordAccess, getLinksForEntry } from '../db/queries.js';

export function registerQueryTool(server: McpServer): void {
  server.registerTool(
    'query_knowledge',
    {
      description:
        'Search the shared knowledge base using free-text queries. ' +
        'Results are ranked by relevance multiplied by memory strength. ' +
        'Accessing knowledge automatically reinforces it (increases its strength), ' +
        'so frequently useful knowledge naturally persists. ' +
        'Use this to find conventions, decisions, patterns, pitfalls, and other team knowledge.',
      inputSchema: {
        query: z.string().describe('Free-text search query (searches title, content, and tags)'),
        type: z.enum(KNOWLEDGE_TYPES).optional().describe('Filter by knowledge type'),
        tags: z.array(z.string()).optional().describe('Filter by tags (entries must match ALL specified tags)'),
        project: z.string().optional().describe('Filter by project name'),
        scope: z.enum(SCOPES).optional().describe(
          'Scope filter with inheritance: repo returns repo+project+company, ' +
          'project returns project+company, company returns only company-wide',
        ),
        include_weak: z.boolean().optional().describe('Include weak entries (strength 0.1-0.5) in results. Default: false'),
        limit: z.number().min(1).max(50).optional().describe('Max results to return (default: 10, max: 50)'),
      },
    },
    async ({ query, type, tags, project, scope, include_weak, limit }) => {
      try {
        const entries = searchKnowledge({
          query,
          type,
          tags,
          project,
          scope,
          includeWeak: include_weak,
          limit,
        });

        if (entries.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No knowledge entries found matching your query.',
              },
            ],
          };
        }

        // Auto-reinforce: bump access count for returned entries
        for (const entry of entries) {
          recordAccess(entry.id, 1);
        }

        // Enrich with link info
        const results = entries.map((entry) => {
          const links = getLinksForEntry(entry.id);
          return {
            id: entry.id,
            type: entry.type,
            title: entry.title,
            content: entry.content,
            tags: entry.tags,
            project: entry.project,
            scope: entry.scope,
            strength: Math.round(entry.strength * 1000) / 1000,
            status: entry.status,
            access_count: entry.access_count + 1, // reflect the access we just recorded
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
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  count: results.length,
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
              text: `Error querying knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
