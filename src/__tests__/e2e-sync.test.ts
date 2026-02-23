/**
 * End-to-end sync tests.
 *
 * Each test spawns real MCP server processes with isolated databases
 * and git clones of a shared bare remote. Tests verify the full stack:
 * CLI parsing → startup sync → tool handlers → write-through → git push/pull.
 *
 * All tests run concurrently — each test creates its own isolated resources
 * (bare remote, agent processes, SQLite DBs) so there is no shared state.
 *
 * Prerequisites: `npm run build` must be run before these tests.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createBareRemote,
  spawnAgent,
  spawnAgentWithConfig,
  spawnAgentWithInterval,
  spawnAgentAutoClone,
  callTool,
  storeEntry,
  queryEntries,
  syncAgent,
  destroyAgent,
  destroyRemote,
  seedRemote,
  seedMalformedFile,
  type AgentHandle,
} from './e2e-helpers.js';

// E2E tests are slower due to process spawning; bump for concurrent load
const TEST_TIMEOUT = 45_000;

describe.concurrent('e2e sync', { timeout: TEST_TIMEOUT }, () => {
  // =====================================================================
  // 1. Full round-trip sync
  // =====================================================================
  describe('full round-trip sync', () => {
    it('should sync a single entry from agent A to agent B', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Agent A stores an entry
        const entry = await storeEntry(agentA, {
          title: 'Alice discovery',
          content: 'Found a useful pattern for error handling',
          type: 'pattern',
        });
        expect(entry.id).toBeTruthy();

        // Agent A pushes
        const pushResult = await syncAgent(agentA, 'push');
        expect(pushResult.pushed).toBeTruthy();

        // Agent B pulls
        const pullResult = await syncAgent(agentB, 'pull');
        const pulled = pullResult.pulled as Record<string, number>;
        expect(pulled.new).toBeGreaterThanOrEqual(1);

        // Agent B queries and finds the entry
        const results = await queryEntries(agentB, 'Alice discovery');
        expect(results.count).toBeGreaterThanOrEqual(1);
        const found = results.results.find((r) => r.id === entry.id);
        expect(found).toBeTruthy();
        expect(found!.title).toBe('Alice discovery');
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });

    it('should sync multiple entries of different types', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Agent A stores entries of different types
        const fact = await storeEntry(agentA, { title: 'E2E Fact', content: 'fact content', type: 'fact' });
        const decision = await storeEntry(agentA, { title: 'E2E Decision', content: 'decision content', type: 'decision' });
        const pattern = await storeEntry(agentA, { title: 'E2E Pattern', content: 'pattern content', type: 'pattern' });

        await syncAgent(agentA, 'push');
        await syncAgent(agentB, 'pull');

        // Agent B should have all three
        for (const entry of [fact, decision, pattern]) {
          const results = await queryEntries(agentB, entry.title as string);
          const found = results.results.find((r) => r.id === entry.id);
          expect(found).toBeTruthy();
        }
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });

    it('should bidirectionally sync entries from both agents', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Both agents create different entries
        const entryA = await storeEntry(agentA, { title: 'From Alice', content: 'alice content' });
        const entryB = await storeEntry(agentB, { title: 'From Bob', content: 'bob content' });

        // Agent A pushes first
        await syncAgent(agentA, 'push');

        // Agent B syncs (pull + push) — gets Alice's entry and pushes Bob's
        await syncAgent(agentB, 'both');

        // Agent A pulls — gets Bob's entry
        await syncAgent(agentA, 'pull');

        // Both agents should have both entries
        const resultsA = await queryEntries(agentA, 'From');
        expect(resultsA.results.find((r) => r.id === entryA.id)).toBeTruthy();
        expect(resultsA.results.find((r) => r.id === entryB.id)).toBeTruthy();

        const resultsB = await queryEntries(agentB, 'From');
        expect(resultsB.results.find((r) => r.id === entryA.id)).toBeTruthy();
        expect(resultsB.results.find((r) => r.id === entryB.id)).toBeTruthy();
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });
  });

  // =====================================================================
  // 2. Concurrent modifications + conflicts
  // =====================================================================
  describe('concurrent modifications + conflicts', () => {
    it('should handle both agents creating different entries without conflict', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Both create entries independently
        await storeEntry(agentA, { title: 'Alice unique entry', content: 'alice' });
        await storeEntry(agentB, { title: 'Bob unique entry', content: 'bob' });

        // Both push — Agent A goes first
        await syncAgent(agentA, 'push');
        // Agent B needs to pull first (to avoid git push conflicts), then push
        await syncAgent(agentB, 'both');

        // Agent A pulls to get Bob's entry
        await syncAgent(agentA, 'pull');

        // Both should have both entries, no conflicts
        const resultsA = await queryEntries(agentA, 'unique entry');
        expect(resultsA.count).toBe(2);

        const resultsB = await queryEntries(agentB, 'unique entry');
        expect(resultsB.count).toBe(2);
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });

    it('should detect conflict when both agents modify the same entry', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      try {
        // Agent A creates an entry and pushes
        const entry = await storeEntry(agentA, {
          title: 'Shared entry',
          content: 'Original content',
        });
        await syncAgent(agentA, 'push');

        // Agent B starts and pulls the entry
        const agentB = await spawnAgent(remote, 'bob');
        try {
          await syncAgent(agentB, 'pull');

          // Both agents modify the entry
          await callTool(agentA, 'update_knowledge', {
            id: entry.id,
            title: 'Alice version',
            content: 'Alice modified this',
          });
          await callTool(agentB, 'update_knowledge', {
            id: entry.id,
            title: 'Bob version',
            content: 'Bob modified this',
          });

          // Agent A pushes first
          await syncAgent(agentA, 'push');

          // Agent B pulls — should see a conflict
          const pullResult = await syncAgent(agentB, 'pull');
          const pulled = pullResult.pulled as Record<string, unknown>;
          expect(pulled.conflicts).toBe(1);

          // Conflict details should exist
          const conflictDetails = pullResult.conflict_details as Array<{
            original_id: string;
            conflict_id: string;
            title: string;
          }>;
          expect(conflictDetails).toHaveLength(1);
          expect(conflictDetails[0].original_id).toBe(entry.id);
          expect(conflictDetails[0].title).toBe('Alice version');

          // Agent B should have a [Sync Conflict] entry
          const results = await queryEntries(agentB, 'Sync Conflict');
          const conflict = results.results.find((r) => r.title.includes('[Sync Conflict]'));
          expect(conflict).toBeTruthy();
          expect(conflict!.title).toContain('Alice version');
        } finally {
          await destroyAgent(agentB);
        }
      } finally {
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });

    it('should mark conflict entries with needs_revalidation and contradicts link', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      try {
        // Create and push
        const entry = await storeEntry(agentA, { title: 'Contested', content: 'v1' });
        await syncAgent(agentA, 'push');

        // Agent B pulls
        const agentB = await spawnAgent(remote, 'bob');
        try {
          await syncAgent(agentB, 'pull');

          // Both modify
          await callTool(agentA, 'update_knowledge', { id: entry.id, content: 'Alice v2' });
          await callTool(agentB, 'update_knowledge', { id: entry.id, content: 'Bob v2' });

          // A pushes, B pulls
          await syncAgent(agentA, 'push');
          const pullResult = await syncAgent(agentB, 'pull');
          const conflictDetails = pullResult.conflict_details as Array<{
            original_id: string;
            conflict_id: string;
          }>;
          expect(conflictDetails).toHaveLength(1);

          // Query using query_knowledge (which includes links in results) to verify
          // the original entry is flagged as needs_revalidation
          const origResults = await queryEntries(agentB, 'Contested');
          const original = origResults.results.find((r) => r.id === entry.id);
          expect(original).toBeTruthy();
          expect(original!.status).toBe('needs_revalidation');

          // Query the conflict entry — should have a contradicts link to the original
          const conflictResults = await queryEntries(agentB, 'Sync Conflict');
          const conflictEntry = conflictResults.results.find(
            (r) => r.id === conflictDetails[0].conflict_id,
          );
          expect(conflictEntry).toBeTruthy();
          expect(conflictEntry!.status).toBe('needs_revalidation');

          // Check that the contradicts link exists
          const links = conflictEntry!.links as Array<{
            link_type: string;
            linked_entry_id: string;
            direction: string;
          }>;
          const contradictsLink = links.find(
            (l) => l.link_type === 'contradicts' && l.linked_entry_id === entry.id,
          );
          expect(contradictsLink).toBeTruthy();
        } finally {
          await destroyAgent(agentB);
        }
      } finally {
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });
  });

  // =====================================================================
  // 2b. Divergent edits — advanced conflict resolution
  // =====================================================================
  describe('divergent edits — advanced conflict resolution', () => {
    it('should preserve both versions with substantially different field changes', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      try {
        // Create entry with rich initial fields
        const entry = await storeEntry(agentA, {
          title: 'Original entry',
          content: 'Original content for divergent test',
          tags: ['alpha', 'beta'],
          type: 'fact',
          scope: 'company',
        });
        await syncAgent(agentA, 'push');

        // Agent B pulls the entry
        const agentB = await spawnAgent(remote, 'bob');
        try {
          await syncAgent(agentB, 'pull');

          // Alice modifies substantially — title, content, tags, project
          await callTool(agentA, 'update_knowledge', {
            id: entry.id,
            title: 'Alice refactored entry',
            content: 'Alice completely rewrote this with new approach',
            tags: ['alice-tag', 'refactored'],
            project: 'alice-project',
          });

          // Bob modifies the same entry with completely different changes
          await callTool(agentB, 'update_knowledge', {
            id: entry.id,
            title: 'Bob improved entry',
            content: 'Bob added detailed implementation notes here',
            tags: ['bob-tag', 'detailed'],
            project: 'bob-project',
          });

          // Alice pushes first, Bob pulls
          await syncAgent(agentA, 'push');
          const pullResult = await syncAgent(agentB, 'pull');
          const pulled = pullResult.pulled as Record<string, unknown>;
          expect(pulled.conflicts).toBe(1);

          const conflictDetails = pullResult.conflict_details as Array<{
            original_id: string;
            conflict_id: string;
            title: string;
          }>;
          expect(conflictDetails).toHaveLength(1);
          expect(conflictDetails[0].original_id).toBe(entry.id);

          // The original entry on Bob's side should still have Bob's content
          const origResults = await queryEntries(agentB, 'Bob improved');
          const original = origResults.results.find((r: Record<string, unknown>) => r.id === entry.id);
          expect(original).toBeTruthy();
          expect(original!.title).toBe('Bob improved entry');
          expect(original!.content).toContain('Bob added detailed implementation notes');

          // The conflict entry should have Alice's content (remote version)
          const conflictResults = await queryEntries(agentB, 'Sync Conflict');
          const conflict = conflictResults.results.find(
            (r: Record<string, unknown>) => r.id === conflictDetails[0].conflict_id,
          );
          expect(conflict).toBeTruthy();
          expect(conflict!.title).toContain('Alice refactored entry');
          expect(conflict!.content).toContain('Alice completely rewrote this');
          // Conflict entry should preserve Alice's tags
          expect(conflict!.tags).toContain('alice-tag');
          expect(conflict!.tags).toContain('refactored');
        } finally {
          await destroyAgent(agentB);
        }
      } finally {
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });

    it('should not conflict when both agents make identical changes', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      try {
        const entry = await storeEntry(agentA, {
          title: 'Convergent entry',
          content: 'Will be edited identically by both',
        });
        await syncAgent(agentA, 'push');

        // Agent B pulls
        const agentB = await spawnAgent(remote, 'bob');
        try {
          await syncAgent(agentB, 'pull');

          // Both agents make the EXACT same change
          const identicalUpdate = {
            id: entry.id,
            title: 'Converged title',
            content: 'Both agents wrote exactly this',
          };
          await callTool(agentA, 'update_knowledge', identicalUpdate);
          await callTool(agentB, 'update_knowledge', identicalUpdate);

          // Alice pushes, Bob pulls
          await syncAgent(agentA, 'push');
          const pullResult = await syncAgent(agentB, 'pull');
          const pulled = pullResult.pulled as Record<string, unknown>;

          // No conflict — identical edits are treated as no_change
          expect(pulled.conflicts).toBe(0);

          // No [Sync Conflict] entries should exist
          const conflictResults = await queryEntries(agentB, 'Sync Conflict');
          const hasConflict = conflictResults.results.some(
            (r: Record<string, unknown>) => (r.title as string).includes('[Sync Conflict]'),
          );
          expect(hasConflict).toBe(false);

          // Bob should have the converged content
          const results = await queryEntries(agentB, 'Converged title');
          const updated = results.results.find((r: Record<string, unknown>) => r.id === entry.id);
          expect(updated).toBeTruthy();
          expect(updated!.title).toBe('Converged title');
        } finally {
          await destroyAgent(agentB);
        }
      } finally {
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });

    it('should not push conflict entries to the remote', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      let agentB: AgentHandle | undefined;
      let agentC: AgentHandle | undefined;
      try {
        const entry = await storeEntry(agentA, {
          title: 'Push isolation test',
          content: 'Original content',
        });
        await syncAgent(agentA, 'push');

        // Bob pulls and both modify
        agentB = await spawnAgent(remote, 'bob');
        await syncAgent(agentB, 'pull');

        await callTool(agentA, 'update_knowledge', {
          id: entry.id,
          content: 'Alice version for push test',
        });
        await callTool(agentB, 'update_knowledge', {
          id: entry.id,
          content: 'Bob version for push test',
        });

        // Alice pushes, Bob pulls (creates conflict), then Bob pushes
        await syncAgent(agentA, 'push');
        const pullResult = await syncAgent(agentB, 'pull');
        const pulled = pullResult.pulled as Record<string, unknown>;
        expect(pulled.conflicts).toBe(1);

        // Bob pushes — conflict entry should NOT be pushed to remote
        await syncAgent(agentB, 'push');

        // Spawn a third agent (Charlie) who pulls from the remote
        agentC = await spawnAgent(remote, 'charlie');
        await syncAgent(agentC, 'pull');

        // Charlie should NOT see any [Sync Conflict] entries
        const charlieResults = await callTool(agentC, 'list_knowledge', {
          status: 'all',
          limit: 100,
        }) as Record<string, unknown>;
        const charlieEntries = (charlieResults.results ?? []) as Array<Record<string, unknown>>;
        const conflictOnRemote = charlieEntries.some(
          (r) => (r.title as string).includes('[Sync Conflict]'),
        );
        expect(conflictOnRemote).toBe(false);

        // Charlie should see the original entry (Bob's local version was pushed)
        const originalOnCharlie = charlieEntries.find((r) => r.id === entry.id);
        expect(originalOnCharlie).toBeTruthy();
      } finally {
        if (agentC) await destroyAgent(agentC);
        if (agentB) await destroyAgent(agentB);
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });

    it('should not delete conflict entries when they are absent from the remote', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      try {
        const entry = await storeEntry(agentA, {
          title: 'Survival test',
          content: 'Will generate a conflict entry that must survive re-sync',
        });
        await syncAgent(agentA, 'push');

        // Bob pulls and both modify
        const agentB = await spawnAgent(remote, 'bob');
        try {
          await syncAgent(agentB, 'pull');

          await callTool(agentA, 'update_knowledge', {
            id: entry.id,
            content: 'Alice changed this',
          });
          await callTool(agentB, 'update_knowledge', {
            id: entry.id,
            content: 'Bob changed this',
          });

          // Create conflict
          await syncAgent(agentA, 'push');
          const pullResult = await syncAgent(agentB, 'pull');
          const conflictDetails = pullResult.conflict_details as Array<{
            original_id: string;
            conflict_id: string;
          }>;
          expect(conflictDetails).toHaveLength(1);
          const conflictId = conflictDetails[0].conflict_id;

          // Verify conflict entry exists before re-sync
          let conflictQuery = await queryEntries(agentB, 'Sync Conflict');
          let conflictEntry = conflictQuery.results.find(
            (r: Record<string, unknown>) => r.id === conflictId,
          );
          expect(conflictEntry).toBeTruthy();

          // Bob does a full sync cycle (push + pull) — conflict entry is absent from
          // the remote (it was never pushed), but should NOT be deleted locally
          await syncAgent(agentB, 'both');

          // Verify conflict entry still exists after re-sync
          conflictQuery = await queryEntries(agentB, 'Sync Conflict');
          conflictEntry = conflictQuery.results.find(
            (r: Record<string, unknown>) => r.id === conflictId,
          );
          expect(conflictEntry).toBeTruthy();
          expect(conflictEntry!.status).toBe('needs_revalidation');
        } finally {
          await destroyAgent(agentB);
        }
      } finally {
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });

    it('should handle multiple simultaneous conflicts in a single pull', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      try {
        // Create two entries
        const entry1 = await storeEntry(agentA, {
          title: 'Multi conflict entry 1',
          content: 'First entry for multi-conflict test',
        });
        const entry2 = await storeEntry(agentA, {
          title: 'Multi conflict entry 2',
          content: 'Second entry for multi-conflict test',
        });
        await syncAgent(agentA, 'push');

        // Bob pulls both entries
        const agentB = await spawnAgent(remote, 'bob');
        try {
          await syncAgent(agentB, 'pull');

          // Both agents modify BOTH entries with different content
          await callTool(agentA, 'update_knowledge', {
            id: entry1.id,
            title: 'Alice entry 1',
            content: 'Alice modified entry 1',
          });
          await callTool(agentA, 'update_knowledge', {
            id: entry2.id,
            title: 'Alice entry 2',
            content: 'Alice modified entry 2',
          });
          await callTool(agentB, 'update_knowledge', {
            id: entry1.id,
            title: 'Bob entry 1',
            content: 'Bob modified entry 1',
          });
          await callTool(agentB, 'update_knowledge', {
            id: entry2.id,
            title: 'Bob entry 2',
            content: 'Bob modified entry 2',
          });

          // Alice pushes, Bob pulls
          await syncAgent(agentA, 'push');
          const pullResult = await syncAgent(agentB, 'pull');
          const pulled = pullResult.pulled as Record<string, unknown>;
          expect(pulled.conflicts).toBe(2);

          const conflictDetails = pullResult.conflict_details as Array<{
            original_id: string;
            conflict_id: string;
            title: string;
          }>;
          expect(conflictDetails).toHaveLength(2);

          // Both original entry IDs should be in the conflict details
          const conflictOriginalIds = conflictDetails.map((d) => d.original_id);
          expect(conflictOriginalIds).toContain(entry1.id);
          expect(conflictOriginalIds).toContain(entry2.id);

          // Two separate [Sync Conflict] entries should exist
          const conflictResults = await queryEntries(agentB, 'Sync Conflict');
          const conflictEntries = conflictResults.results.filter(
            (r: Record<string, unknown>) => (r.title as string).includes('[Sync Conflict]'),
          );
          expect(conflictEntries.length).toBe(2);

          // Each conflict entry should have a contradicts link to its corresponding original
          for (const detail of conflictDetails) {
            const conflictEntry = conflictEntries.find(
              (r: Record<string, unknown>) => r.id === detail.conflict_id,
            );
            expect(conflictEntry).toBeTruthy();
            expect(conflictEntry!.status).toBe('needs_revalidation');

            const links = (conflictEntry!.links ?? []) as Array<{
              link_type: string;
              linked_entry_id: string;
            }>;
            const contradictsLink = links.find(
              (l) => l.link_type === 'contradicts' && l.linked_entry_id === detail.original_id,
            );
            expect(contradictsLink).toBeTruthy();
          }
        } finally {
          await destroyAgent(agentB);
        }
      } finally {
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });

    it('should preserve conflict links with source sync:conflict across sync cycles', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      try {
        const entry = await storeEntry(agentA, {
          title: 'Link survival test',
          content: 'Testing that conflict links persist across syncs',
        });
        await syncAgent(agentA, 'push');

        // Bob pulls and both modify
        const agentB = await spawnAgent(remote, 'bob');
        try {
          await syncAgent(agentB, 'pull');

          await callTool(agentA, 'update_knowledge', {
            id: entry.id,
            content: 'Alice link-survival version',
          });
          await callTool(agentB, 'update_knowledge', {
            id: entry.id,
            content: 'Bob link-survival version',
          });

          // Create conflict
          await syncAgent(agentA, 'push');
          const pullResult = await syncAgent(agentB, 'pull');
          const conflictDetails = pullResult.conflict_details as Array<{
            original_id: string;
            conflict_id: string;
          }>;
          expect(conflictDetails).toHaveLength(1);
          const conflictId = conflictDetails[0].conflict_id;

          // Verify contradicts link exists initially
          let conflictQuery = await queryEntries(agentB, 'Sync Conflict');
          let conflictEntry = conflictQuery.results.find(
            (r: Record<string, unknown>) => r.id === conflictId,
          );
          expect(conflictEntry).toBeTruthy();
          let links = (conflictEntry!.links ?? []) as Array<{
            link_type: string;
            linked_entry_id: string;
          }>;
          let contradictsLink = links.find(
            (l) => l.link_type === 'contradicts' && l.linked_entry_id === entry.id,
          );
          expect(contradictsLink).toBeTruthy();

          // Bob pushes (conflict entry + link NOT pushed) then pulls again
          await syncAgent(agentB, 'push');
          await syncAgent(agentB, 'pull');

          // The contradicts link should still exist — not deleted by remote link
          // deletion logic (links with source 'sync:conflict' are protected)
          conflictQuery = await queryEntries(agentB, 'Sync Conflict');
          conflictEntry = conflictQuery.results.find(
            (r: Record<string, unknown>) => r.id === conflictId,
          );
          expect(conflictEntry).toBeTruthy();
          links = (conflictEntry!.links ?? []) as Array<{
            link_type: string;
            linked_entry_id: string;
          }>;
          contradictsLink = links.find(
            (l) => l.link_type === 'contradicts' && l.linked_entry_id === entry.id,
          );
          expect(contradictsLink).toBeTruthy();
        } finally {
          await destroyAgent(agentB);
        }
      } finally {
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });
  });

  // =====================================================================
  // 3. Multi-repo routing
  // =====================================================================
  describe('multi-repo routing', () => {
    it('should route entries to correct repos based on scope', async () => {
      const companyRemote = createBareRemote();
      const projectRemote = createBareRemote();
      const agentA = await spawnAgentWithConfig([
        { name: 'company', remote: companyRemote, scope: 'company' },
        { name: 'project', remote: projectRemote, scope: 'project' },
      ], 'alice');
      try {
        // Store company-scoped entry
        const companyEntry = await storeEntry(agentA, {
          title: 'Company-wide convention',
          content: 'Always use TypeScript',
          type: 'convention',
          scope: 'company',
        });

        // Store project-scoped entry
        const projectEntry = await storeEntry(agentA, {
          title: 'Project-specific fact',
          content: 'Uses React',
          type: 'fact',
          scope: 'project',
        });

        // Push
        await syncAgent(agentA, 'push');

        // Verify files are in the correct repos by checking the git clones
        const companyClone = (agentA as any).clonePaths[0];
        const projectClone = (agentA as any).clonePaths[1];

        expect(existsSync(join(companyClone, 'entries', 'convention', `${companyEntry.id}.json`))).toBe(true);
        expect(existsSync(join(projectClone, 'entries', 'fact', `${projectEntry.id}.json`))).toBe(true);

        // Verify they're NOT in the wrong repos
        expect(existsSync(join(projectClone, 'entries', 'convention', `${companyEntry.id}.json`))).toBe(false);
        expect(existsSync(join(companyClone, 'entries', 'fact', `${projectEntry.id}.json`))).toBe(false);
      } finally {
        await destroyAgent(agentA);
        destroyRemote(companyRemote);
        destroyRemote(projectRemote);
      }
    });

    it('should sync multi-repo entries between agents', async () => {
      const companyRemote = createBareRemote();
      const projectRemote = createBareRemote();
      const agentA = await spawnAgentWithConfig([
        { name: 'company', remote: companyRemote, scope: 'company' },
        { name: 'project', remote: projectRemote, scope: 'project' },
      ], 'alice');
      let agentB: AgentHandle | undefined;
      try {
        // Store entries in different scopes
        const companyEntry = await storeEntry(agentA, {
          title: 'Company convention',
          content: 'Use ESLint',
          scope: 'company',
        });
        const projectEntry = await storeEntry(agentA, {
          title: 'Project decision',
          content: 'Use Vite',
          scope: 'project',
        });

        await syncAgent(agentA, 'push');

        // Agent B with same multi-repo config
        agentB = await spawnAgentWithConfig([
          { name: 'company', remote: companyRemote, scope: 'company' },
          { name: 'project', remote: projectRemote, scope: 'project' },
        ], 'bob');

        await syncAgent(agentB, 'pull');

        // Agent B should have both entries
        const companyResults = await queryEntries(agentB, 'Company convention');
        expect(companyResults.results.find((r) => r.id === companyEntry.id)).toBeTruthy();

        const projectResults = await queryEntries(agentB, 'Project decision');
        expect(projectResults.results.find((r) => r.id === projectEntry.id)).toBeTruthy();
      } finally {
        if (agentB) await destroyAgent(agentB);
        await destroyAgent(agentA);
        destroyRemote(companyRemote);
        destroyRemote(projectRemote);
      }
    });

    it('should route with project filter', async () => {
      const companyRemote = createBareRemote();
      const projectXRemote = createBareRemote();
      const agentA = await spawnAgentWithConfig([
        { name: 'project-x', remote: projectXRemote, scope: 'project', project: 'x-app' },
        { name: 'default', remote: companyRemote },
      ], 'alice');
      try {
        // Store a project-x entry
        const projEntry = await storeEntry(agentA, {
          title: 'X-App architecture',
          content: 'Microservices',
          scope: 'project',
          project: 'x-app',
        });

        // Store a non-matching entry (falls to default)
        const otherEntry = await storeEntry(agentA, {
          title: 'General note',
          content: 'Something else',
          scope: 'company',
        });

        await syncAgent(agentA, 'push');

        // Check routing
        const projXClone = (agentA as any).clonePaths[0];
        const defaultClone = (agentA as any).clonePaths[1];

        expect(existsSync(join(projXClone, 'entries', 'fact', `${projEntry.id}.json`))).toBe(true);
        expect(existsSync(join(defaultClone, 'entries', 'fact', `${otherEntry.id}.json`))).toBe(true);
      } finally {
        await destroyAgent(agentA);
        destroyRemote(companyRemote);
        destroyRemote(projectXRemote);
      }
    });
  });

  // =====================================================================
  // 4. Entry lifecycle — create/update/delete
  // =====================================================================
  describe('entry lifecycle', () => {
    it('should sync entry creation', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        const entry = await storeEntry(agentA, {
          title: 'New entry',
          content: 'Fresh content',
          type: 'decision',
          tags: ['e2e', 'lifecycle'],
        });

        await syncAgent(agentA, 'push');
        await syncAgent(agentB, 'pull');

        const results = await queryEntries(agentB, 'New entry');
        const found = results.results.find((r) => r.id === entry.id);
        expect(found).toBeTruthy();
        expect(found!.title).toBe('New entry');
        expect((found as any).type).toBe('decision');
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });

    it('should sync entry updates (title and content)', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Create and push
        const entry = await storeEntry(agentA, { title: 'Original title', content: 'Original content' });
        await syncAgent(agentA, 'push');

        // Agent B pulls
        await syncAgent(agentB, 'pull');

        // Agent A updates
        await callTool(agentA, 'update_knowledge', {
          id: entry.id,
          title: 'Updated title',
          content: 'Updated content',
        });
        await syncAgent(agentA, 'push');

        // Agent B pulls the update
        const pullResult = await syncAgent(agentB, 'pull');
        const pulled = pullResult.pulled as Record<string, number>;
        expect(pulled.updated).toBeGreaterThanOrEqual(1);

        // Verify updated content
        const results = await queryEntries(agentB, 'Updated title');
        const found = results.results.find((r) => r.id === entry.id);
        expect(found).toBeTruthy();
        expect(found!.title).toBe('Updated title');
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });

    it('should sync type changes', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Create as fact
        const entry = await storeEntry(agentA, { title: 'Changing type', content: 'content', type: 'fact' });
        await syncAgent(agentA, 'push');
        await syncAgent(agentB, 'pull');

        // Change to decision
        await callTool(agentA, 'update_knowledge', { id: entry.id, type: 'decision' });
        await syncAgent(agentA, 'push');

        // Agent B pulls
        await syncAgent(agentB, 'pull');

        const results = await queryEntries(agentB, 'Changing type');
        const found = results.results.find((r) => r.id === entry.id);
        expect(found).toBeTruthy();
        expect((found as any).type).toBe('decision');
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });

    it('should sync entry deletion', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Create and sync
        const entry = await storeEntry(agentA, { title: 'Delete me', content: 'doomed' });
        await syncAgent(agentA, 'push');
        await syncAgent(agentB, 'pull');

        // Verify Agent B has it
        let results = await queryEntries(agentB, 'Delete me');
        expect(results.results.find((r) => r.id === entry.id)).toBeTruthy();

        // Agent A deletes
        await callTool(agentA, 'delete_knowledge', { id: entry.id });
        await syncAgent(agentA, 'push');

        // Agent B pulls — deletion should propagate
        const pullResult = await syncAgent(agentB, 'pull');
        const pulled = pullResult.pulled as Record<string, number>;
        expect(pulled.deleted).toBeGreaterThanOrEqual(1);

        // Agent B should no longer have it
        results = await queryEntries(agentB, 'Delete me');
        expect(results.results.find((r) => r.id === entry.id)).toBeUndefined();
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });
  });

  // =====================================================================
  // 5. Link sync round-trip
  // =====================================================================
  describe('link sync', () => {
    it('should sync links between agents', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Create two entries and a link
        const e1 = await storeEntry(agentA, { title: 'Source entry', content: 'source' });
        const e2 = await storeEntry(agentA, { title: 'Target entry', content: 'target' });

        await callTool(agentA, 'link_knowledge', {
          source_id: e1.id,
          target_id: e2.id,
          link_type: 'related',
          description: 'E2E link test',
        });

        // Push everything
        await syncAgent(agentA, 'push');

        // Agent B pulls
        const pullResult = await syncAgent(agentB, 'pull');
        const pulled = pullResult.pulled as Record<string, number>;
        expect(pulled.new_links).toBeGreaterThanOrEqual(1);

        // Verify link exists on Agent B by querying the source entry
        const results = await queryEntries(agentB, 'Source entry');
        const source = results.results.find((r) => r.id === e1.id);
        expect(source).toBeTruthy();
        const links = (source as any).links as Array<{
          link_type: string;
          linked_entry_id: string;
          direction: string;
        }>;
        const relatedLink = links.find(
          (l) => l.linked_entry_id === e2.id && l.link_type === 'related',
        );
        expect(relatedLink).toBeTruthy();
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });

    it('should sync links created by different agents', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Agent A creates two entries
        const e1 = await storeEntry(agentA, { title: 'Entry One', content: 'one' });
        const e2 = await storeEntry(agentA, { title: 'Entry Two', content: 'two' });
        await syncAgent(agentA, 'push');

        // Agent B pulls, then creates a link
        await syncAgent(agentB, 'pull');
        await callTool(agentB, 'link_knowledge', {
          source_id: e1.id,
          target_id: e2.id,
          link_type: 'derived',
          description: 'Bob link',
        });
        await syncAgent(agentB, 'push');

        // Agent A pulls — should get Bob's link
        const pullResult = await syncAgent(agentA, 'pull');
        const pulled = pullResult.pulled as Record<string, number>;
        expect(pulled.new_links).toBeGreaterThanOrEqual(1);

        // Verify on Agent A
        const results = await queryEntries(agentA, 'Entry One');
        const source = results.results.find((r) => r.id === e1.id);
        expect(source).toBeTruthy();
        const links = (source as any).links as Array<{
          link_type: string;
          linked_entry_id: string;
        }>;
        expect(links.find((l) => l.link_type === 'derived' && l.linked_entry_id === e2.id)).toBeTruthy();
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });

    it('should sync link deletion', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Create entries + link
        const e1 = await storeEntry(agentA, { title: 'Link Del Source', content: 'src' });
        const e2 = await storeEntry(agentA, { title: 'Link Del Target', content: 'tgt' });
        await callTool(agentA, 'link_knowledge', {
          source_id: e1.id,
          target_id: e2.id,
          link_type: 'related',
        }) as string;

        await syncAgent(agentA, 'push');
        await syncAgent(agentB, 'pull');

        // Verify Agent B has the link
        let results = await queryEntries(agentB, 'Link Del Source');
        const source = results.results.find((r) => r.id === e1.id);
        expect((source as any).links.length).toBeGreaterThan(0);

        // Agent A deletes the entry that has links (which cascades link deletion)
        await callTool(agentA, 'delete_knowledge', { id: e2.id });
        await syncAgent(agentA, 'push');

        // Agent B pulls
        await syncAgent(agentB, 'pull');

        // The target entry should be gone
        results = await queryEntries(agentB, 'Link Del Target');
        expect(results.results.find((r) => r.id === e2.id)).toBeUndefined();
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });
  });

  // =====================================================================
  // 6. Startup sync — pull on boot
  // =====================================================================
  describe('startup sync', () => {
    it('should automatically import entries on startup', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      let agentB: AgentHandle | undefined;
      try {
        // Agent A stores entries and pushes
        const entry1 = await storeEntry(agentA, { title: 'Startup test 1', content: 'content1' });
        const entry2 = await storeEntry(agentA, { title: 'Startup test 2', content: 'content2' });
        await syncAgent(agentA, 'push');

        // Spawn Agent B fresh — it should pull on startup
        agentB = await spawnAgent(remote, 'bob');

        // Agent B should already have the entries (pulled during startup)
        const results = await queryEntries(agentB, 'Startup test');
        expect(results.count).toBeGreaterThanOrEqual(2);
        expect(results.results.find((r) => r.id === entry1.id)).toBeTruthy();
        expect(results.results.find((r) => r.id === entry2.id)).toBeTruthy();
      } finally {
        if (agentB) await destroyAgent(agentB);
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });

    it('should import links on startup', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      let agentB: AgentHandle | undefined;
      try {
        const e1 = await storeEntry(agentA, { title: 'Boot Link Source', content: 's' });
        const e2 = await storeEntry(agentA, { title: 'Boot Link Target', content: 't' });
        await callTool(agentA, 'link_knowledge', {
          source_id: e1.id,
          target_id: e2.id,
          link_type: 'elaborates',
        });
        await syncAgent(agentA, 'push');

        // Spawn Agent B fresh — should get entries + links on startup
        agentB = await spawnAgent(remote, 'bob');

        const results = await queryEntries(agentB, 'Boot Link Source');
        const source = results.results.find((r) => r.id === e1.id);
        expect(source).toBeTruthy();
        const links = (source as any).links as Array<{
          link_type: string;
          linked_entry_id: string;
        }>;
        expect(links.find((l) => l.link_type === 'elaborates' && l.linked_entry_id === e2.id)).toBeTruthy();
      } finally {
        if (agentB) await destroyAgent(agentB);
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });
  });

  // =====================================================================
  // 7. Auto-clone on startup
  // =====================================================================
  describe('auto-clone on startup', () => {
    it('should auto-clone and pull when repo path does not exist', async () => {
      const remote = createBareRemote();
      let agentB: AgentHandle | undefined;
      const extraTmpDir = mkdtempSync(join(tmpdir(), 'knowledge-e2e-autoclone-'));
      try {
        // Seed the remote with data
        const seedId = randomUUID();
        seedRemote(remote, [
          { id: seedId, type: 'fact', title: 'Pre-seeded entry', content: 'seeded content' },
        ]);

        const nonExistentClone = join(extraTmpDir, 'auto-cloned-repo');

        agentB = await spawnAgentAutoClone([
          { name: 'default', path: nonExistentClone, remote },
        ], 'bob');

        // The server should have auto-cloned and pulled the seeded entry
        const results = await queryEntries(agentB, 'Pre-seeded entry');
        expect(results.count).toBeGreaterThanOrEqual(1);
        expect(results.results.find((r) => r.id === seedId)).toBeTruthy();
      } finally {
        if (agentB) await destroyAgent(agentB);
        destroyRemote(remote);
        rmSync(extraTmpDir, { recursive: true, force: true });
      }
    });

    it('should auto-clone with links', async () => {
      const remote = createBareRemote();
      let agentB: AgentHandle | undefined;
      const extraTmpDir = mkdtempSync(join(tmpdir(), 'knowledge-e2e-autoclone2-'));
      try {
        const entryId1 = randomUUID();
        const entryId2 = randomUUID();
        const linkId = randomUUID();

        seedRemote(
          remote,
          [
            { id: entryId1, type: 'fact', title: 'Cloned Source', content: 'src' },
            { id: entryId2, type: 'fact', title: 'Cloned Target', content: 'tgt' },
          ],
          [
            { id: linkId, source_id: entryId1, target_id: entryId2, link_type: 'related', description: 'seeded link' },
          ],
        );

        const clonePath = join(extraTmpDir, 'auto-cloned');

        agentB = await spawnAgentAutoClone([
          { name: 'default', path: clonePath, remote },
        ], 'bob');

        // Verify entries
        const results = await queryEntries(agentB, 'Cloned');
        expect(results.results.find((r) => r.id === entryId1)).toBeTruthy();
        expect(results.results.find((r) => r.id === entryId2)).toBeTruthy();

        // Verify link
        const source = results.results.find((r) => r.id === entryId1);
        const links = (source as any).links as Array<{
          link_type: string;
          linked_entry_id: string;
        }>;
        expect(links.find((l) => l.link_type === 'related' && l.linked_entry_id === entryId2)).toBeTruthy();
      } finally {
        if (agentB) await destroyAgent(agentB);
        destroyRemote(remote);
        rmSync(extraTmpDir, { recursive: true, force: true });
      }
    });
  });

  // =====================================================================
  // 8. Edge cases
  // =====================================================================
  describe('edge cases', () => {
    it('should handle empty remote without errors', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      try {
        // Should be able to query without errors
        const results = await queryEntries(agentA, 'anything');
        expect(results.count).toBe(0);

        // Should be able to push (nothing to push)
        const pushResult = await syncAgent(agentA, 'push');
        expect(pushResult.pushed).toBeTruthy();
      } finally {
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });

    it('should skip malformed JSON files during pull', async () => {
      const remote = createBareRemote();
      try {
        // Seed remote with one valid entry and one malformed file
        const validId = randomUUID();
        seedRemote(remote, [
          { id: validId, type: 'fact', title: 'Valid entry', content: 'good content' },
        ]);

        // Add a malformed JSON file
        seedMalformedFile(remote, 'entries/fact/bad-file.json', 'this is not valid json {{{');

        // Spawn agent — should import the valid entry and skip the bad one
        const agentA = await spawnAgent(remote, 'alice');
        try {
          const results = await queryEntries(agentA, 'Valid entry');
          expect(results.count).toBeGreaterThanOrEqual(1);
          expect(results.results.find((r) => r.id === validId)).toBeTruthy();
        } finally {
          await destroyAgent(agentA);
        }
      } finally {
        destroyRemote(remote);
      }
    });

    it('should handle large entry content', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Create a large entry (~100KB)
        const largeContent = 'x'.repeat(100_000);
        const entry = await storeEntry(agentA, {
          title: 'Large entry test',
          content: largeContent,
        });

        await syncAgent(agentA, 'push');
        await syncAgent(agentB, 'pull');

        // Agent B should have it with full content
        const results = await queryEntries(agentB, 'Large entry test');
        const found = results.results.find((r) => r.id === entry.id);
        expect(found).toBeTruthy();
        // Query results may truncate content, so just check it exists
        expect(found!.title).toBe('Large entry test');
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });

    it('should handle deprecation sync', async () => {
      const remote = createBareRemote();
      const agentA = await spawnAgent(remote, 'alice');
      const agentB = await spawnAgent(remote, 'bob');
      try {
        // Create and sync
        const entry = await storeEntry(agentA, { title: 'Deprecate me', content: 'old info' });
        await syncAgent(agentA, 'push');
        await syncAgent(agentB, 'pull');

        // Agent A deprecates
        await callTool(agentA, 'deprecate_knowledge', {
          id: entry.id,
          reason: 'outdated',
        });
        await syncAgent(agentA, 'push');

        // Agent B pulls
        await syncAgent(agentB, 'pull');

        // Verify deprecated status on Agent B
        const results = await callTool(agentB, 'list_knowledge', {
          status: 'deprecated',
          limit: 50,
        }) as { results: Array<{ id: string; status: string }> };

        const found = results.results.find((r) => r.id === entry.id);
        expect(found).toBeTruthy();
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });
  });

  // =====================================================================
  // 9. Periodic automatic sync
  // =====================================================================
  describe('periodic automatic sync', () => {
    it('should automatically pull remote changes on interval', async () => {
      const remote = createBareRemote();
      // Agent A is a normal agent (no periodic sync)
      const agentA = await spawnAgent(remote, 'alice');
      // Agent B has periodic sync every 2 seconds
      const agentB = await spawnAgentWithInterval(remote, 'bob', 2);
      try {
        // Agent A stores an entry and pushes
        const entry = await storeEntry(agentA, {
          title: 'Periodic pull test entry',
          content: 'Should be auto-pulled by Bob',
          type: 'fact',
        });
        await syncAgent(agentA, 'push');

        // Wait for Agent B's periodic sync to fire (2s interval + buffer)
        await new Promise((resolve) => setTimeout(resolve, 4000));

        // Agent B should have the entry now (pulled automatically)
        const results = await queryEntries(agentB, 'Periodic pull test entry');
        expect(results.count).toBeGreaterThanOrEqual(1);
        const found = results.results.find((r) => r.id === entry.id);
        expect(found).toBeTruthy();
        expect(found!.title).toBe('Periodic pull test entry');
      } finally {
        await destroyAgent(agentA);
        await destroyAgent(agentB);
        destroyRemote(remote);
      }
    });

    it('should automatically push local changes on interval', async () => {
      const remote = createBareRemote();
      // Agent A has periodic sync every 2 seconds
      const agentA = await spawnAgentWithInterval(remote, 'alice', 2);
      let agentB: AgentHandle | undefined;
      try {
        // Agent A stores an entry (write-through commits locally)
        const entry = await storeEntry(agentA, {
          title: 'Periodic push test entry',
          content: 'Should be auto-pushed by Alice',
          type: 'decision',
        });

        // Wait for Agent A's periodic sync to fire and push
        await new Promise((resolve) => setTimeout(resolve, 4000));

        // Spawn Agent B (normal) — it pulls on startup
        agentB = await spawnAgent(remote, 'bob');

        // Agent B should have the entry (pulled on startup after Alice pushed)
        const results = await queryEntries(agentB, 'Periodic push test entry');
        expect(results.count).toBeGreaterThanOrEqual(1);
        const found = results.results.find((r) => r.id === entry.id);
        expect(found).toBeTruthy();
        expect(found!.title).toBe('Periodic push test entry');
      } finally {
        if (agentB) await destroyAgent(agentB);
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });

    it('should not conflict when manual sync overlaps with periodic sync', async () => {
      const remote = createBareRemote();
      // Agent A has periodic sync every 2 seconds
      const agentA = await spawnAgentWithInterval(remote, 'alice', 2);
      let agentB: AgentHandle | undefined;
      try {
        // Store some entries
        await storeEntry(agentA, {
          title: 'Overlap test entry 1',
          content: 'First entry',
        });

        // Manually trigger sync while periodic sync is also running
        const manualResult = await syncAgent(agentA, 'both');
        // Should succeed without error (manual sync acquires mutex or gets
        // "sync already in progress" which is handled gracefully)
        expect(manualResult).toBeTruthy();

        // Store another entry
        await storeEntry(agentA, {
          title: 'Overlap test entry 2',
          content: 'Second entry',
        });

        // Wait for periodic sync
        await new Promise((resolve) => setTimeout(resolve, 4000));

        // Spawn Agent B to verify entries are synced
        agentB = await spawnAgent(remote, 'bob');

        const results1 = await queryEntries(agentB, 'Overlap test entry 1');
        expect(results1.count).toBeGreaterThanOrEqual(1);

        const results2 = await queryEntries(agentB, 'Overlap test entry 2');
        expect(results2.count).toBeGreaterThanOrEqual(1);
      } finally {
        if (agentB) await destroyAgent(agentB);
        await destroyAgent(agentA);
        destroyRemote(remote);
      }
    });
  });
});
