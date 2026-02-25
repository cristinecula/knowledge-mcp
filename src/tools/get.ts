import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getKnowledgeById, resolveKnowledgeId, recordAccess, getLinksForEntry } from '../db/queries.js';
import { INACCURACY_THRESHOLD } from '../types.js';

export function registerGetTool(server: McpServer): void {
  server.registerTool(
    'get_knowledge',
    {
      description:
        'Retrieve the full content of a knowledge entry by ID. ' +
        'Supports short ID prefixes (minimum 4 characters) — if the prefix uniquely identifies an entry, it will be resolved automatically. ' +
        'Use this after query_knowledge or list_knowledge to read the complete content ' +
        'of an entry (search results return truncated content). ' +
        'Accessing an entry automatically reinforces it. ' +
        'If the entry has needs_revalidation=true, it may be stale due to changes in linked entries — ' +
        'verify its accuracy before relying on it, then use `reinforce_knowledge` if still correct ' +
        'or `update_knowledge` to fix outdated content.',
      inputSchema: {
        id: z.string().describe('Full or short ID (minimum 4 characters) of the knowledge entry to retrieve'),
      },
    },
    async ({ id }) => {
      try {
        // Resolve short ID prefixes to full UUIDs
        const resolved = resolveKnowledgeId(id);
        if (resolved === null) {
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
        if ('error' in resolved) {
          return {
            content: [
              {
                type: 'text' as const,
                text: resolved.error,
              },
            ],
            isError: true,
          };
        }

        const resolvedId = resolved.id;
        const entry = getKnowledgeById(resolvedId);
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
        recordAccess(resolvedId, 1);

        // Fetch links
        const links = getLinksForEntry(resolvedId);

        const result: Record<string, unknown> = {
          id: entry.id,
          type: entry.type,
          title: entry.title,
          content: entry.content,
          tags: entry.tags,
          project: entry.project,
          scope: entry.scope,
          status: entry.status,
          access_count: entry.access_count + 1,
          last_accessed_at: new Date().toISOString(),
          needs_revalidation: entry.inaccuracy >= INACCURACY_THRESHOLD,
          inaccuracy: Math.round(entry.inaccuracy * 1000) / 1000,
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

        // Add warning if entry needs revalidation
        const warnings: string[] = [];
        if (entry.inaccuracy >= INACCURACY_THRESHOLD) {
          warnings.push(
            `This entry may be inaccurate due to changes in linked entries (inaccuracy: ${Math.round(entry.inaccuracy * 1000) / 1000}). ` +
            'Verify accuracy before relying on this information. ' +
            'Use `reinforce_knowledge` if the entry is still correct, or `update_knowledge` to fix outdated content.',
          );
        }
        if (warnings.length > 0) {
          result.warnings = warnings;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result),
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
