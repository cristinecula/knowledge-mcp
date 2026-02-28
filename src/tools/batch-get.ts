import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getKnowledgeById, resolveKnowledgeId, batchRecordAccess, getLinksForEntries } from '../db/queries.js';
import { INACCURACY_THRESHOLD } from '../types.js';

export function registerBatchGetTool(server: McpServer): void {
  server.registerTool(
    'batch_get_knowledge',
    {
      description:
        'Retrieve the full content of multiple knowledge entries by ID in a single call. ' +
        'Supports short ID prefixes (minimum 4 characters). ' +
        'Returns partial results — found entries are returned, missing IDs are listed separately. ' +
        'Use this instead of multiple get_knowledge calls when you need to read several entries. ' +
        'Accessing entries automatically reinforces them.',
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe('Array of full or short IDs (minimum 4 characters each) of knowledge entries to retrieve'),
      },
    },
    async ({ ids }) => {
      try {
        // Phase 1: Resolve all IDs (supports short prefixes)
        const resolved: Array<{ requestedId: string; resolvedId: string }> = [];
        const notFound: string[] = [];
        const errors: Array<{ id: string; error: string }> = [];

        for (const id of ids) {
          const result = resolveKnowledgeId(id);
          if (result === null) {
            notFound.push(id);
          } else if ('error' in result) {
            errors.push({ id, error: result.error });
          } else {
            resolved.push({ requestedId: id, resolvedId: result.id });
          }
        }

        // Phase 2: Fetch all resolved entries
        const entries: Array<{ requestedId: string; entry: NonNullable<ReturnType<typeof getKnowledgeById>> }> = [];
        for (const { requestedId, resolvedId } of resolved) {
          const entry = getKnowledgeById(resolvedId);
          if (entry) {
            entries.push({ requestedId, entry });
          } else {
            notFound.push(requestedId);
          }
        }

        if (entries.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  count: 0,
                  results: [],
                  not_found: notFound,
                  ...(errors.length > 0 ? { errors } : {}),
                }),
              },
            ],
          };
        }

        // Phase 3: Batch-record access for all found entries
        const foundIds = entries.map((e) => e.entry.id);
        batchRecordAccess(foundIds, 1);

        // Phase 4: Batch-fetch links for all found entries
        const linksByEntryId = getLinksForEntries(foundIds);

        // Phase 5: Build results with full content + links + warnings
        const warnings: string[] = [];
        const results = entries.map(({ entry }) => {
          const entryLinks = linksByEntryId.get(entry.id) || [];

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
            link_count: entryLinks.length,
            links: entryLinks.map((l) => ({
              link_id: l.id,
              linked_entry_id: l.source_id === entry.id ? l.target_id : l.source_id,
              link_type: l.link_type,
              direction: l.source_id === entry.id ? 'outgoing' : 'incoming',
              ...(l.description ? { description: l.description } : {}),
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

          // Collect revalidation warnings
          if (entry.inaccuracy >= INACCURACY_THRESHOLD) {
            warnings.push(
              `Entry "${entry.title}" (${entry.id}) may be inaccurate (inaccuracy: ${Math.round(entry.inaccuracy * 1000) / 1000}). ` +
              'Verify accuracy before relying on it.',
            );
          }

          return result;
        });

        const response: Record<string, unknown> = {
          count: results.length,
          results,
        };
        if (notFound.length > 0) {
          response.not_found = notFound;
        }
        if (errors.length > 0) {
          response.errors = errors;
        }
        if (warnings.length > 0) {
          response.warnings = warnings;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(response),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error retrieving knowledge entries: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
