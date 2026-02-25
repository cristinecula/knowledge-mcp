import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateKnowledgeFields, getKnowledgeById, getOutgoingLinks, getLinksForEntry, updateKnowledgeContent, resetInaccuracy, computeDiffFactor, propagateInaccuracy, flagSupersededEntries, insertLink, deleteLink } from '../db/queries.js';
import { syncWriteEntry, syncWriteEntryWithLinks, scheduleCommit } from '../sync/index.js';
import { KNOWLEDGE_TYPES, SCOPES, LINK_TYPES, INACCURACY_THRESHOLD } from '../types.js';
import type { LinkType } from '../types.js';
import { embedAndStore } from '../embeddings/similarity.js';

export function registerUpdateTool(server: McpServer): void {
  server.registerTool(
    'update_knowledge',
    {
      description:
        'Update an existing knowledge entry\'s content, title, tags, or type. ' +
        'When an entry is updated, inaccuracy is propagated through the knowledge graph — ' +
        'linked entries accumulate inaccuracy based on how much changed and how closely they are linked. ' +
        'Updating an entry also resets its own inaccuracy to 0 (updating IS revalidation).',
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
        links: z
          .array(
            z.object({
              target_id: z.string().uuid(),
              link_type: z.enum(LINK_TYPES.filter((t) => t !== 'conflicts_with') as [string, ...string[]]),
              description: z.string().optional(),
            }),
          )
          .optional()
          .describe(
            'Declarative outgoing links (replaces all existing non-conflict links). ' +
            'Omit to keep links unchanged. Set to [] to remove all links.',
          ),
      },
    },
    async ({ id, title, content, tags, type, project, scope, links }) => {
      try {
        const oldEntry = getKnowledgeById(id);
        if (!oldEntry) {
          return {
            content: [{ type: 'text', text: `Entry not found: ${id}` }],
            isError: true,
          };
        }

        // Compute diff factor BEFORE applying the update
        const diffFactor = computeDiffFactor(oldEntry, { title, content, tags });

        const updated = updateKnowledgeFields(id, {
          title,
          content,
          tags,
          type,
          project,
          scope,
        });

        if (updated) {
          // Reset inaccuracy — updating the entry IS revalidation
          if (oldEntry.inaccuracy > 0) {
            resetInaccuracy(id);
            // Clear any human flag_reason since the agent has now addressed it
            if (oldEntry.flag_reason) {
              updateKnowledgeContent(id, { flag_reason: null });
            }
          }

          syncWriteEntry(updated, oldEntry.type, oldEntry.scope, oldEntry.project);

          // Handle declarative links (set-based: replaces all non-conflict outgoing links)
          let linksAdded = 0;
          let linksRemoved = 0;
          const newlyInsertedLinks: Array<{ sourceId: string; targetId: string; linkType: string }> = [];
          if (links !== undefined) {
            // Get current outgoing links (excluding conflict-related ones)
            const currentOutgoing = getOutgoingLinks(id).filter(
              (l) => l.link_type !== 'conflicts_with' && l.source !== 'sync:conflict',
            );

            // Build a map of desired links: key = "target_id:link_type"
            const desiredMap = new Map<string, { target_id: string; link_type: string; description?: string }>();
            for (const link of links) {
              const key = `${link.target_id}:${link.link_type}`;
              desiredMap.set(key, link);
            }

            // Build a map of current links: key = "target_id:link_type"
            const currentMap = new Map<string, string>(); // key -> link.id
            for (const link of currentOutgoing) {
              const key = `${link.target_id}:${link.link_type}`;
              currentMap.set(key, link.id);
            }

            // Delete links that are no longer desired
            for (const [key, linkId] of currentMap) {
              if (!desiredMap.has(key)) {
                deleteLink(linkId);
                linksRemoved++;
              }
            }

            // Insert links that don't exist yet
            for (const [key, link] of desiredMap) {
              if (!currentMap.has(key)) {
                try {
                  insertLink({
                    sourceId: id,
                    targetId: link.target_id,
                    linkType: link.link_type as LinkType,
                    description: link.description,
                    source: updated.source || 'agent',
                  });
                  newlyInsertedLinks.push({ sourceId: id, targetId: link.target_id, linkType: link.link_type });
                  linksAdded++;
                } catch {
                  // Skip duplicates or FK violations
                }
              }
            }

            // If links changed, rewrite the entry file with updated frontmatter
            if (linksAdded > 0 || linksRemoved > 0) {
              // Re-fetch the entry to get latest state
              const refreshed = getKnowledgeById(id);
              if (refreshed) {
                syncWriteEntryWithLinks(refreshed);
              }
            }
          }

          // Schedule a debounced git commit
          scheduleCommit(`knowledge: update ${updated.type} "${updated.title}"`);

          // Regenerate embedding in background (fire-and-forget — non-fatal, non-blocking)
          if (title !== undefined || content !== undefined || tags !== undefined) {
            embedAndStore(updated.id, updated.title, updated.content, updated.tags).catch(() => {
              // Embedding generation can fail (e.g., no provider configured)
            });
          }

          // Propagate inaccuracy through the knowledge graph
          const bumps = propagateInaccuracy(id, diffFactor);

          // Flag superseded entries (if any supersedes links were just created)
          const supersedeBumps = flagSupersededEntries(newlyInsertedLinks);
          // Merge supersede bumps into the main bumps array
          for (const sb of supersedeBumps) {
            const existing = bumps.find((b) => b.id === sb.id);
            if (existing) {
              existing.newInaccuracy = Math.max(existing.newInaccuracy, sb.newInaccuracy);
            } else {
              bumps.push(sb);
            }
          }

          // Sync bumped entries so inaccuracy changes are shared
          for (const bump of bumps) {
            const bumpedEntry = getKnowledgeById(bump.id);
            if (bumpedEntry) {
              syncWriteEntry(bumpedEntry);
            }
          }
          if (bumps.length > 0) {
            scheduleCommit(`knowledge: propagate inaccuracy from "${updated.title}"`);
          }

          let responseText = `Updated knowledge entry: ${updated.title} (ID: ${id})`;

          if (linksAdded > 0 || linksRemoved > 0) {
            responseText += `\nLinks: ${linksAdded} added, ${linksRemoved} removed`;
          }

          if (bumps.length > 0) {
            const aboveThreshold = bumps.filter((b) => b.newInaccuracy >= INACCURACY_THRESHOLD);
            responseText += `\n\nInaccuracy propagated to ${bumps.length} entries`;
            if (aboveThreshold.length > 0) {
              responseText += ` (${aboveThreshold.length} now above threshold)`;
            }
            responseText += ':';
            for (const bump of bumps) {
              const marker = bump.newInaccuracy >= INACCURACY_THRESHOLD ? ' (above threshold!)' : '';
              responseText += `\n  - ${bump.id} inaccuracy: ${bump.previousInaccuracy.toFixed(2)} → ${bump.newInaccuracy.toFixed(2)}${marker}`;
            }
          }

          // Surface the declaration for wiki entries so agents know the intent
          if (updated.type === 'wiki' && updated.declaration) {
            responseText +=
              `\n\nDECLARATION: "${updated.declaration}"\n` +
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
                '\n\nWARNING: This wiki entry has no links to source knowledge entries. ' +
                'Wiki pages should reference the knowledge entries they are derived from. ' +
                'Use update_knowledge with the links parameter to add links (e.g., "derived", "elaborates", or "related") ' +
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
                  `\n\nSYNC CONFLICT: This entry is a sync conflict copy. ` +
                  `The canonical version is ${cl.target_id}. ` +
                  `If you are resolving the conflict, update the canonical entry instead, ` +
                  `then delete this conflict copy with delete_knowledge.`;
              } else {
                responseText +=
                  `\n\nSYNC CONFLICT: This entry has an unresolved sync conflict. ` +
                  `A conflict copy with local changes exists at ${cl.source_id}. ` +
                  `If the local changes in the conflict copy should be preserved, merge them into this entry. ` +
                  `Then delete the conflict copy with delete_knowledge.`;
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
