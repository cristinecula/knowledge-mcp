import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateKnowledgeFields, getKnowledgeById, getIncomingLinks, getOutgoingLinks, getLinksForEntry, updateStatus, updateKnowledgeContent } from '../db/queries.js';
import { syncWriteEntry, scheduleCommit } from '../sync/index.js';
import { KNOWLEDGE_TYPES, SCOPES, REVALIDATION_LINK_TYPES } from '../types.js';
import { embedAndStore } from '../embeddings/similarity.js';

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
        id: z.string().uuid().describe('ID of the knowledge entry to update'),
        title: z.string().optional().describe('Updated title'),
        content: z.string().optional().describe('Updated content (markdown)'),
        tags: z.array(z.string()).optional().describe('Updated tags (replaces existing tags)'),
        type: z
          .enum(KNOWLEDGE_TYPES)
          .optional()
          .describe(
            'Updated knowledge type: convention, decision, pattern, pitfall, fact, debug_note, process',
          ),
        project: z.string().optional().describe('Updated project scope'),
        scope: z
          .enum(SCOPES)
          .optional()
          .describe('Updated scope level: company, project, repo'),
      },
    },
    async ({ id, title, content, tags, type, project, scope }) => {
      try {
        const oldEntry = getKnowledgeById(id);
        const updated = updateKnowledgeFields(id, {
          title,
          content,
          tags,
          type,
          project,
          scope,
        });

        if (updated) {
          // Clear needs_revalidation — updating the entry IS the revalidation
          if (oldEntry && oldEntry.status === 'needs_revalidation') {
            updateStatus(id, 'active');
            // Clear any human flag_reason since the agent has now addressed it
            if (oldEntry.flag_reason) {
              updateKnowledgeContent(id, { flag_reason: null });
            }
          }

          syncWriteEntry(updated, oldEntry?.type, oldEntry?.scope, oldEntry?.project);
          
          // Schedule a debounced git commit
          scheduleCommit(`knowledge: update ${updated.type} "${updated.title}"`);

          // Regenerate embedding in background (fire-and-forget — non-fatal, non-blocking)
          if (title !== undefined || content !== undefined || tags !== undefined) {
            embedAndStore(updated.id, updated.title, updated.content, updated.tags).catch(() => {
              // Embedding generation can fail (e.g., no provider configured)
            });
          }

          // Cascade revalidation: flag entries linked via 'derived' or 'depends'
          const revalidated: string[] = [];
          const incomingLinks = getIncomingLinks(id, REVALIDATION_LINK_TYPES);
          for (const link of incomingLinks) {
            const linkedEntry = getKnowledgeById(link.source_id);
            if (linkedEntry && linkedEntry.status !== 'deprecated') {
              updateStatus(link.source_id, 'needs_revalidation');
              revalidated.push(link.source_id);
            }
          }

          let responseText = `Updated knowledge entry: ${updated.title} (ID: ${id})`;
          if (revalidated.length > 0) {
            responseText += `\n\nCascade revalidation: flagged ${revalidated.length} linked entries as needs_revalidation:\n${revalidated.map((rid) => `  - ${rid}`).join('\n')}`;
          }

          // Surface the declaration for wiki entries so agents know the intent
          if (updated.type === 'wiki' && updated.declaration) {
            responseText +=
              `\n\n📋 DECLARATION: "${updated.declaration}"\n` +
              'Ensure the content you wrote aligns with this declaration (tone, length, focus).';
          }

          // Warn if a wiki entry has no outgoing links to non-wiki knowledge entries
          if (updated.type === 'wiki') {
            const outgoing = getOutgoingLinks(id);
            const hasSourceLink = outgoing.some((link) => {
              const target = getKnowledgeById(link.target_id);
              return target !== null && target.type !== 'wiki';
            });
            if (!hasSourceLink) {
              responseText +=
                '\n\n⚠ WARNING: This wiki entry has no links to source knowledge entries. ' +
                'Wiki pages should reference the knowledge entries they are derived from. ' +
                'Use link_knowledge to create links (e.g., "derived", "elaborates", or "related") ' +
                'from this wiki entry to the relevant source entries.';
            }
          }

          // Warn if this entry has unresolved sync conflicts
          const entryLinks = getLinksForEntry(id);
          const conflictLinks = entryLinks.filter((l) => l.link_type === 'conflicts_with');
          if (conflictLinks.length > 0) {
            for (const cl of conflictLinks) {
              const isConflictCopy = cl.source_id === id;
              if (isConflictCopy) {
                responseText +=
                  `\n\n⚠ SYNC CONFLICT: This entry is a sync conflict copy. ` +
                  `The canonical version is ${cl.target_id}. ` +
                  `If you are resolving the conflict, update the canonical entry instead, ` +
                  `then delete this conflict copy with delete_knowledge and remove the conflicts_with link.`;
              } else {
                responseText +=
                  `\n\n⚠ SYNC CONFLICT: This entry has an unresolved sync conflict. ` +
                  `A conflict copy with local changes exists at ${cl.source_id}. ` +
                  `If the local changes in the conflict copy should be preserved, merge them into this entry. ` +
                  `Then delete the conflict copy with delete_knowledge and remove the conflicts_with link.`;
              }
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: responseText,
              },
            ],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Entry not found: ${id}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to update entry: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
