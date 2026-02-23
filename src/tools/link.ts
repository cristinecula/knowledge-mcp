import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { insertLink, getKnowledgeById } from '../db/queries.js';
import { syncWriteLink, scheduleCommit } from '../sync/index.js';
import type { LinkType } from '../types.js';

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
        'supersedes (replaces source), elaborates (adds detail to source).',
      inputSchema: {
        source_id: z.string().uuid().describe('ID of the source knowledge entry (the "from" side)'),
        target_id: z.string().uuid().describe('ID of the target knowledge entry (the "to" side)'),
        link_type: z
          .enum([
            'related',
            'derived',
            'depends',
            'contradicts',
            'supersedes',
            'elaborates',
          ] as const)
          .describe(
            'Type of relationship: related, derived, depends, contradicts, supersedes, elaborates',
          ),
        description: z.string().optional().describe('Why these entries are linked'),
        bidirectional: z
          .boolean()
          .optional()
          .describe(
            'Create the reverse link too (e.g., A related B also creates B related A). Default: false',
          ),
      },
    },
    async ({ source_id, target_id, link_type, description, bidirectional }) => {
      try {
        const sourceEntry = getKnowledgeById(source_id);
        const targetEntry = getKnowledgeById(target_id);

        if (!sourceEntry) {
          return { content: [{ type: 'text', text: `Source entry not found: ${source_id}` }], isError: true };
        }
        if (!targetEntry) {
          return { content: [{ type: 'text', text: `Target entry not found: ${target_id}` }], isError: true };
        }

        const link = insertLink({
          sourceId: source_id,
          targetId: target_id,
          linkType: link_type as LinkType,
          description,
          source: 'agent',
        });
        syncWriteLink(link, sourceEntry);

        let reverseLink;
        if (bidirectional) {
          reverseLink = insertLink({
            sourceId: target_id,
            targetId: source_id,
            linkType: link_type as LinkType,
            description,
            source: 'agent',
          });
          syncWriteLink(reverseLink, targetEntry);
        }

        // Schedule a debounced git commit
        let msg = `knowledge: link ${link_type} "${sourceEntry.title}" -> "${targetEntry.title}"`;
        if (reverseLink) msg += ` (bidirectional)`;
        scheduleCommit(msg);

        return {
          content: [
            {
              type: 'text',
              text: bidirectional
                ? `Created bidirectional link between "${sourceEntry.title}" and "${targetEntry.title}"`
                : `Created link: "${sourceEntry.title}" ${link_type} "${targetEntry.title}"`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to create link: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
