import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LINK_TYPES } from '../types.js';
import { getKnowledgeById, insertLink, updateStatus } from '../db/queries.js';
import { syncWriteLink } from '../sync/index.js';

export function registerLinkTool(server: McpServer): void {
  server.registerTool(
    'link_knowledge',
    {
      description:
        'Create a typed link between two knowledge entries. Links form an associative ' +
        'knowledge graph where connected entries reinforce each other\'s memory strength. ' +
        'Well-connected knowledge is more robust and harder to forget. ' +
        'Link types: related (general association), derived (deduced from source), ' +
        'depends (requires source to be true), contradicts (conflicts with source), ' +
        'supersedes (replaces source), elaborates (adds detail to source). ' +
        'When a "supersedes" link is created, the target entry is automatically flagged ' +
        'as "needs_revalidation" since it has been replaced.',
      inputSchema: {
        source_id: z.string().describe('ID of the source knowledge entry (the "from" side)'),
        target_id: z.string().describe('ID of the target knowledge entry (the "to" side)'),
        link_type: z.enum(LINK_TYPES).describe(
          'Type of relationship: related, derived, depends, contradicts, supersedes, elaborates',
        ),
        description: z.string().optional().describe('Why these entries are linked'),
        bidirectional: z
          .boolean()
          .optional()
          .describe(
            'Create the reverse link too (e.g., A related B also creates B related A). Default: false',
          ),
        source: z.string().optional().describe('Who is creating this link'),
      },
    },
    async ({ source_id, target_id, link_type, description, bidirectional, source }) => {
      try {
        // Validate both entries exist
        const sourceEntry = getKnowledgeById(source_id);
        if (!sourceEntry) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Source entry not found: ${source_id}`,
              },
            ],
            isError: true,
          };
        }

        const targetEntry = getKnowledgeById(target_id);
        if (!targetEntry) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Target entry not found: ${target_id}`,
              },
            ],
            isError: true,
          };
        }

        if (source_id === target_id) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Cannot link an entry to itself',
              },
            ],
            isError: true,
          };
        }

        // Create the primary link
        const link = insertLink({
          sourceId: source_id,
          targetId: target_id,
          linkType: link_type,
          description,
          source,
        });

        // Write-through to sync repo
        syncWriteLink(link);

        // Flag target for revalidation when superseded
        let targetRevalidated = false;
        if (link_type === 'supersedes') {
          if (
            targetEntry.status !== 'deprecated' &&
            targetEntry.status !== 'dormant'
          ) {
            updateStatus(target_id, 'needs_revalidation');
            targetRevalidated = true;
          }
        }

        const result: Record<string, unknown> = {
          link_id: link.id,
          source: { id: sourceEntry.id, title: sourceEntry.title },
          target: { id: targetEntry.id, title: targetEntry.title },
          link_type,
          description: description ?? null,
          ...(targetRevalidated && { target_revalidated: true }),
        };

        // Create reverse link if bidirectional
        if (bidirectional) {
          try {
            const reverseLink = insertLink({
              sourceId: target_id,
              targetId: source_id,
              linkType: link_type,
              description,
              source,
            });
            syncWriteLink(reverseLink);
            result.reverse_link_id = reverseLink.id;
            result.bidirectional = true;
          } catch {
            result.reverse_link_error =
              'Reverse link already exists or could not be created';
          }
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
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('UNIQUE constraint')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `A ${link_type} link already exists between these entries`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error creating link: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
