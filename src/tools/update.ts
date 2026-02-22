import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KNOWLEDGE_TYPES, SCOPES, REVALIDATION_LINK_TYPES } from '../types.js';
import {
  getKnowledgeById,
  updateKnowledgeFields,
  getIncomingLinks,
  updateStatus,
} from '../db/queries.js';

export function registerUpdateTool(server: McpServer): void {
  server.registerTool(
    'update_knowledge',
    {
      description:
        'Update an existing knowledge entry\'s content, title, tags, or type. ' +
        'When an entry is updated, entries that are linked to it via "derived" or "depends" ' +
        'links are automatically flagged as "needs_revalidation" — they may need to be ' +
        'reviewed to ensure they\'re still accurate given the change.',
      inputSchema: {
        id: z.string().describe('ID of the knowledge entry to update'),
        title: z.string().optional().describe('Updated title'),
        content: z.string().optional().describe('Updated content (markdown)'),
        tags: z.array(z.string()).optional().describe('Updated tags (replaces existing tags)'),
        type: z.enum(KNOWLEDGE_TYPES).optional().describe('Updated knowledge type'),
        project: z.string().optional().describe('Updated project scope'),
        scope: z.enum(SCOPES).optional().describe('Updated scope level'),
      },
    },
    async ({ id, title, content, tags, type, project, scope }) => {
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

        // Check that at least one field is being updated
        if (!title && !content && !tags && !type && !project && !scope) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No fields specified to update. Provide at least one of: title, content, tags, type, project, scope.',
              },
            ],
            isError: true,
          };
        }

        // Apply updates
        const updated = updateKnowledgeFields(id, {
          title,
          content,
          tags,
          type,
          project,
          scope,
        });

        // Cascade revalidation: flag entries that derived from or depend on the updated entry.
        // These are entries where the updated entry is the TARGET of a derived/depends link
        // (i.e., other entries point at this one saying "I depend on / am derived from this").
        const revalidatedIds: string[] = [];
        const incomingLinks = getIncomingLinks(id, REVALIDATION_LINK_TYPES);

        for (const link of incomingLinks) {
          const dependentEntry = getKnowledgeById(link.source_id);
          if (
            dependentEntry &&
            dependentEntry.status !== 'deprecated' &&
            dependentEntry.status !== 'dormant'
          ) {
            updateStatus(link.source_id, 'needs_revalidation');
            revalidatedIds.push(link.source_id);
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  id: updated!.id,
                  title: updated!.title,
                  type: updated!.type,
                  updated_fields: [
                    title !== undefined && 'title',
                    content !== undefined && 'content',
                    tags !== undefined && 'tags',
                    type !== undefined && 'type',
                    project !== undefined && 'project',
                    scope !== undefined && 'scope',
                  ].filter(Boolean),
                  revalidation_triggered: revalidatedIds,
                  revalidation_count: revalidatedIds.length,
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
              text: `Error updating knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
