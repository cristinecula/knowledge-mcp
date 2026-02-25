import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getSyncConfig, isSyncEnabled, isSyncInProgress, setSyncInProgress, tryAcquireSyncLock, releaseSyncLock, pull, push, flushCommit } from '../sync/index.js';

export function registerSyncTool(server: McpServer): void {
  server.registerTool(
    'sync_knowledge',
    {
      description:
        'Sync knowledge with the shared team git repository. ' +
        '"pull" imports remote changes into your local knowledge base. ' +
        '"push" exports your local changes to JSON files in the git repo. ' +
        '"both" does pull then push. ' +
        'Conflicts (both sides changed) create a [Sync Conflict] entry linked via ' +
        '"contradicts" — review both versions and keep the correct one. ' +
        'Your local access counts and last_accessed_at are never affected by sync.',
      inputSchema: {
        direction: z
          .enum(['pull', 'push', 'both'])
          .optional()
          .describe('Sync direction: pull (import remote), push (export local), both (default)'),
      },
    },
    async ({ direction }) => {
      try {
        if (!isSyncEnabled()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Sync is not enabled. Start the server with --sync-repo <path> or --sync-config <path> to enable git-based knowledge sharing.',
              },
            ],
            isError: true,
          };
        }

        if (isSyncInProgress()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'A sync operation is already in progress in this process. Try again shortly.',
              },
            ],
            isError: true,
          };
        }

        if (!tryAcquireSyncLock()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Another process is currently syncing. Try again shortly.',
              },
            ],
            isError: true,
          };
        }

        setSyncInProgress(true);
        try {
          // Flush any pending debounced commits before pulling/pushing
          flushCommit();
          const config = getSyncConfig()!;
          const dir = direction ?? 'both';
          const result: Record<string, unknown> = { direction: dir };

          if (dir === 'pull' || dir === 'both') {
            const pullResult = await pull(config);
            result.pulled = {
              new: pullResult.new_entries,
              updated: pullResult.updated,
              deleted: pullResult.deleted,
              conflicts: pullResult.conflicts,
              new_links: pullResult.new_links,
              deleted_links: pullResult.deleted_links,
            };
            if (pullResult.conflict_details.length > 0) {
              result.conflict_details = pullResult.conflict_details;
            }
          }

          if (dir === 'push' || dir === 'both') {
            const pushResult = await push(config);
            result.pushed = {
              new: pushResult.new_entries,
              updated: pushResult.updated,
              deleted: pushResult.deleted,
            };
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result),
              },
            ],
          };
        } finally {
          setSyncInProgress(false);
          releaseSyncLock();
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error syncing knowledge: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
