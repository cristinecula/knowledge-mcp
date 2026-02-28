import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  insertKnowledge,
  insertLink,
  getKnowledgeById,
  updateKnowledgeFields,
  resetInaccuracy,
  computeDiffFactor,
  propagateInaccuracy,
  flagSupersededEntries,
  getOutgoingLinks,
  deleteLink,
  deleteKnowledge,
  deprecateKnowledge,
} from '../db/queries.js';
import { getDb } from '../db/connection.js';
import { syncWriteEntry, syncWriteEntryWithLinks, syncDeleteEntry, scheduleCommit } from '../sync/index.js';
import { KNOWLEDGE_TYPES, LINK_TYPES, SCOPES } from '../types.js';
import type { KnowledgeType, LinkType, KnowledgeEntry } from '../types.js';
import { embedAndStore } from '../embeddings/similarity.js';

const linkSchema = z.object({
  target_id: z.string().uuid(),
  link_type: z.enum(LINK_TYPES.filter((t) => t !== 'conflicts_with') as [string, ...string[]]),
  description: z.string().optional(),
});

const storeOp = z.object({
  operation: z.literal('store'),
  title: z.string().describe('Short summary of the knowledge (1-2 sentences)'),
  content: z.string().describe('Full content in markdown format'),
  type: z
    .enum(KNOWLEDGE_TYPES)
    .describe('Type of knowledge'),
  tags: z.array(z.string()).optional().describe('Tags for categorization'),
  scope: z.enum(SCOPES).optional().describe('Scope level: company (default), project, or repo'),
  project: z.string().optional().describe('Project name'),
  source: z.string().optional().describe('Who or what created this'),
  links: z.array(linkSchema).optional().describe('Links to existing entries'),
});

const updateOp = z.object({
  operation: z.literal('update'),
  id: z.string().uuid().describe('ID of the entry to update'),
  title: z.string().optional().describe('Updated title'),
  content: z.string().optional().describe('Updated content (markdown)'),
  tags: z.array(z.string()).optional().describe('Updated tags (replaces existing)'),
  type: z.enum(KNOWLEDGE_TYPES).optional().describe('Updated knowledge type'),
  project: z.string().optional().describe('Updated project scope'),
  scope: z.enum(SCOPES).optional().describe('Updated scope level'),
  links: z.array(linkSchema).optional().describe('Declarative outgoing links (replaces all non-conflict). Omit to keep, [] to clear.'),
});

const deleteOp = z.object({
  operation: z.literal('delete'),
  id: z.string().uuid().describe('UUID of the entry to delete'),
});

const deprecateOp = z.object({
  operation: z.literal('deprecate'),
  id: z.string().uuid().describe('UUID of the entry to deprecate'),
  reason: z.string().describe('Reason for deprecation'),
});

interface BatchResult {
  index: number;
  operation: string;
  id: string;
  title?: string;
}

export function registerBatchTool(server: McpServer): void {
  server.registerTool(
    'batch_operations',
    {
      description:
        'Execute multiple knowledge base operations (store, update, delete, deprecate) in a single atomic call. ' +
        'All operations succeed or all fail — if any operation encounters an error, the entire batch is rolled back. ' +
        'Use this to reduce round-trips when managing multiple entries at once (e.g., bulk cleanup, migrations, ' +
        'creating related entries). Maximum 50 operations per call.',
      inputSchema: {
        operations: z
          .array(z.discriminatedUnion('operation', [storeOp, updateOp, deleteOp, deprecateOp]))
          .min(1)
          .max(50)
          .describe('Array of operations to execute atomically'),
      },
    },
    async ({ operations }) => {
      try {
        const db = getDb();

        // Phase 1: Pre-validate all operations that reference existing entries
        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];
          if (op.operation === 'update' || op.operation === 'delete' || op.operation === 'deprecate') {
            const entry = getKnowledgeById(op.id);
            if (!entry) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Operation ${i} (${op.operation}) failed: Entry not found: ${op.id}`,
                  },
                ],
                isError: true,
              };
            }
          }
        }

        // Phase 2: Execute all DB mutations in a single transaction
        const results: BatchResult[] = [];

        // Track entries that need post-transaction sync
        const entriesToSync: Array<{ entry: KnowledgeEntry; oldType?: KnowledgeType; oldScope?: string; oldProject?: string | null }> = [];
        const entriesToSyncWithLinks: KnowledgeEntry[] = [];
        const entriesToDelete: Array<{ id: string; type?: KnowledgeType }> = [];
        const entriesToEmbed: Array<{ id: string; title: string; content: string; tags: string[] }> = [];
        const allInsertedLinks: Array<{ sourceId: string; targetId: string; linkType: string }> = [];

        // Track inaccuracy propagation inputs (collected, executed once after transaction)
        const inaccuracyPropagations: Array<{ id: string; diffFactor: number }> = [];

        const runTransaction = db.transaction(() => {
          for (let i = 0; i < operations.length; i++) {
            const op = operations[i];

            switch (op.operation) {
              case 'store': {
                const entry = insertKnowledge({
                  title: op.title,
                  content: op.content,
                  type: op.type,
                  tags: op.tags || [],
                  scope: op.scope || 'company',
                  project: op.project || null,
                  source: op.source || 'agent',
                });

                entriesToSync.push({ entry });
                entriesToEmbed.push({ id: entry.id, title: entry.title, content: entry.content, tags: entry.tags });

                if (op.links && op.links.length > 0) {
                  for (const link of op.links) {
                    insertLink({
                      sourceId: entry.id,
                      targetId: link.target_id,
                      linkType: link.link_type as LinkType,
                      description: link.description,
                      source: op.source || 'agent',
                    });
                    allInsertedLinks.push({ sourceId: entry.id, targetId: link.target_id, linkType: link.link_type });
                  }
                  entriesToSyncWithLinks.push(entry);
                }

                results.push({ index: i, operation: 'store', id: entry.id, title: entry.title });
                break;
              }

              case 'update': {
                const oldEntry = getKnowledgeById(op.id)!;
                const diffFactor = computeDiffFactor(oldEntry, { title: op.title, content: op.content, tags: op.tags });

                const updated = updateKnowledgeFields(op.id, {
                  title: op.title,
                  content: op.content,
                  tags: op.tags,
                  type: op.type,
                  project: op.project,
                  scope: op.scope,
                  ...(oldEntry.flag_reason ? { flag_reason: null } : {}),
                });

                if (!updated) {
                  throw new Error(`Operation ${i} (update) failed: Entry not found after update: ${op.id}`);
                }

                if (oldEntry.inaccuracy > 0) {
                  resetInaccuracy(op.id);
                }

                entriesToSync.push({ entry: updated, oldType: oldEntry.type, oldScope: oldEntry.scope, oldProject: oldEntry.project });

                if (op.title !== undefined || op.content !== undefined || op.tags !== undefined) {
                  entriesToEmbed.push({ id: updated.id, title: updated.title, content: updated.content, tags: updated.tags });
                }

                // Handle declarative links
                if (op.links !== undefined) {
                  const currentOutgoing = getOutgoingLinks(op.id).filter(
                    (l) => l.link_type !== 'conflicts_with' && l.source !== 'sync:conflict',
                  );

                  const desiredMap = new Map<string, { target_id: string; link_type: string; description?: string }>();
                  for (const link of op.links) {
                    desiredMap.set(`${link.target_id}:${link.link_type}`, link);
                  }

                  const currentMap = new Map<string, string>();
                  for (const link of currentOutgoing) {
                    currentMap.set(`${link.target_id}:${link.link_type}`, link.id);
                  }

                  for (const [key, linkId] of currentMap) {
                    if (!desiredMap.has(key)) {
                      deleteLink(linkId);
                    }
                  }

                  for (const [key, link] of desiredMap) {
                    if (!currentMap.has(key)) {
                      try {
                        insertLink({
                          sourceId: op.id,
                          targetId: link.target_id,
                          linkType: link.link_type as LinkType,
                          description: link.description,
                          source: updated.source || 'agent',
                        });
                        allInsertedLinks.push({ sourceId: op.id, targetId: link.target_id, linkType: link.link_type });
                      } catch {
                        // Skip duplicates or FK violations
                      }
                    }
                  }

                  // Re-fetch to get latest state with links
                  const refreshed = getKnowledgeById(op.id);
                  if (refreshed) {
                    entriesToSyncWithLinks.push(refreshed);
                  }
                }

                if (diffFactor > 0) {
                  inaccuracyPropagations.push({ id: op.id, diffFactor });
                }

                results.push({ index: i, operation: 'update', id: updated.id, title: updated.title });
                break;
              }

              case 'delete': {
                const entry = getKnowledgeById(op.id);
                const deleted = deleteKnowledge(op.id);
                if (!deleted) {
                  throw new Error(`Operation ${i} (delete) failed: Entry not found: ${op.id}`);
                }

                entriesToDelete.push({ id: op.id, type: entry?.type as KnowledgeType });
                results.push({ index: i, operation: 'delete', id: op.id, title: entry?.title });
                break;
              }

              case 'deprecate': {
                const deprecated = deprecateKnowledge(op.id, op.reason);
                if (!deprecated) {
                  throw new Error(`Operation ${i} (deprecate) failed: Entry not found: ${op.id}`);
                }

                entriesToSync.push({ entry: deprecated });
                results.push({ index: i, operation: 'deprecate', id: deprecated.id, title: deprecated.title });
                break;
              }
            }
          }
        });

        runTransaction();

        // Phase 3: Post-transaction sync write-through
        for (const { entry, oldType, oldScope, oldProject } of entriesToSync) {
          syncWriteEntry(entry, oldType, oldScope, oldProject);
        }
        for (const entry of entriesToSyncWithLinks) {
          syncWriteEntryWithLinks(entry);
        }
        for (const { id, type } of entriesToDelete) {
          syncDeleteEntry(id, type);
        }

        // Phase 4: Inaccuracy propagation (once, after all mutations)
        const allBumps: Array<{ id: string }> = [];
        for (const { id, diffFactor } of inaccuracyPropagations) {
          const bumps = propagateInaccuracy(id, diffFactor);
          allBumps.push(...bumps);
        }

        // Flag superseded entries from all newly created links
        const supersedeBumps = flagSupersededEntries(allInsertedLinks);
        allBumps.push(...supersedeBumps);

        // Sync bumped entries
        const syncedBumpIds = new Set<string>();
        for (const bump of allBumps) {
          if (!syncedBumpIds.has(bump.id)) {
            const bumpedEntry = getKnowledgeById(bump.id);
            if (bumpedEntry) {
              syncWriteEntry(bumpedEntry);
            }
            syncedBumpIds.add(bump.id);
          }
        }

        // Phase 5: Single commit for all changes
        const summary = operations.map((op) => op.operation).reduce(
          (acc, op) => {
            acc[op] = (acc[op] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        );
        const summaryParts = Object.entries(summary).map(([op, count]) => `${count} ${op}${count > 1 ? 's' : ''}`);
        scheduleCommit(`knowledge: batch ${summaryParts.join(', ')}`);

        if (allBumps.length > 0) {
          scheduleCommit(`knowledge: propagate inaccuracy from batch operations`);
        }

        // Phase 6: Fire-and-forget embedding generation
        for (const { id, title, content, tags } of entriesToEmbed) {
          embedAndStore(id, title, content, tags).catch(() => {
            // Embedding generation can fail
          });
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ count: results.length, results }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Batch operation failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
