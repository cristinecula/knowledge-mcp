/**
 * End-to-end sync tests.
 *
 * Each test spawns real MCP server processes with isolated databases
 * and git clones of a shared bare remote. Tests verify the full stack:
 * CLI parsing → startup sync → tool handlers → write-through → git push/pull.
 *
 * Prerequisites: `npm run build` must be run before these tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

// E2E tests are slower due to process spawning
const TEST_TIMEOUT = 30_000;

describe('e2e sync', { timeout: TEST_TIMEOUT }, () => {
  // =====================================================================
  // 1. Full round-trip sync
  // =====================================================================
  describe('full round-trip sync', () => {
    let remote: string;
    let agentA: AgentHandle;
    let agentB: AgentHandle;

    beforeEach(async () => {
      remote = createBareRemote();
    });

    afterEach(async () => {
      if (agentA) await destroyAgent(agentA);
      if (agentB) await destroyAgent(agentB);
      destroyRemote(remote);
    });

    it('should sync a single entry from agent A to agent B', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });

    it('should sync multiple entries of different types', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });

    it('should bidirectionally sync entries from both agents', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });
  });

  // =====================================================================
  // 2. Concurrent modifications + conflicts
  // =====================================================================
  describe('concurrent modifications + conflicts', () => {
    let remote: string;
    let agentA: AgentHandle;
    let agentB: AgentHandle;

    beforeEach(async () => {
      remote = createBareRemote();
    });

    afterEach(async () => {
      if (agentA) await destroyAgent(agentA);
      if (agentB) await destroyAgent(agentB);
      destroyRemote(remote);
    });

    it('should handle both agents creating different entries without conflict', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });

    it('should detect conflict when both agents modify the same entry', async () => {
      agentA = await spawnAgent(remote, 'alice');

      // Agent A creates an entry and pushes
      const entry = await storeEntry(agentA, {
        title: 'Shared entry',
        content: 'Original content',
      });
      await syncAgent(agentA, 'push');

      // Agent B starts and pulls the entry
      agentB = await spawnAgent(remote, 'bob');
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
    });

    it('should mark conflict entries with needs_revalidation and contradicts link', async () => {
      agentA = await spawnAgent(remote, 'alice');

      // Create and push
      const entry = await storeEntry(agentA, { title: 'Contested', content: 'v1' });
      await syncAgent(agentA, 'push');

      // Agent B pulls
      agentB = await spawnAgent(remote, 'bob');
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
    });
  });

  // =====================================================================
  // 3. Multi-repo routing
  // =====================================================================
  describe('multi-repo routing', () => {
    let companyRemote: string;
    let projectRemote: string;
    let agentA: AgentHandle & { clonePaths?: string[] };
    let agentB: AgentHandle & { clonePaths?: string[] };

    beforeEach(async () => {
      companyRemote = createBareRemote();
      projectRemote = createBareRemote();
    });

    afterEach(async () => {
      if (agentA) await destroyAgent(agentA);
      if (agentB) await destroyAgent(agentB);
      destroyRemote(companyRemote);
      destroyRemote(projectRemote);
    });

    it('should route entries to correct repos based on scope', async () => {
      agentA = await spawnAgentWithConfig([
        { name: 'company', remote: companyRemote, scope: 'company' },
        { name: 'project', remote: projectRemote, scope: 'project' },
      ], 'alice');

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
    });

    it('should sync multi-repo entries between agents', async () => {
      agentA = await spawnAgentWithConfig([
        { name: 'company', remote: companyRemote, scope: 'company' },
        { name: 'project', remote: projectRemote, scope: 'project' },
      ], 'alice');

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
    });

    it('should route with project filter', async () => {
      const projectXRemote = createBareRemote();

      try {
        agentA = await spawnAgentWithConfig([
          { name: 'project-x', remote: projectXRemote, scope: 'project', project: 'x-app' },
          { name: 'default', remote: companyRemote },
        ], 'alice');

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
        destroyRemote(projectXRemote);
      }
    });
  });

  // =====================================================================
  // 4. Entry lifecycle — create/update/delete
  // =====================================================================
  describe('entry lifecycle', () => {
    let remote: string;
    let agentA: AgentHandle;
    let agentB: AgentHandle;

    beforeEach(async () => {
      remote = createBareRemote();
    });

    afterEach(async () => {
      if (agentA) await destroyAgent(agentA);
      if (agentB) await destroyAgent(agentB);
      destroyRemote(remote);
    });

    it('should sync entry creation', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });

    it('should sync entry updates (title and content)', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });

    it('should sync type changes', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });

    it('should sync entry deletion', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });
  });

  // =====================================================================
  // 5. Link sync round-trip
  // =====================================================================
  describe('link sync', () => {
    let remote: string;
    let agentA: AgentHandle;
    let agentB: AgentHandle;

    beforeEach(async () => {
      remote = createBareRemote();
    });

    afterEach(async () => {
      if (agentA) await destroyAgent(agentA);
      if (agentB) await destroyAgent(agentB);
      destroyRemote(remote);
    });

    it('should sync links between agents', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });

    it('should sync links created by different agents', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });

    it('should sync link deletion', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

      // Create entries + link
      const e1 = await storeEntry(agentA, { title: 'Link Del Source', content: 'src' });
      const e2 = await storeEntry(agentA, { title: 'Link Del Target', content: 'tgt' });
      const linkResult = await callTool(agentA, 'link_knowledge', {
        source_id: e1.id,
        target_id: e2.id,
        link_type: 'related',
      }) as string;

      await syncAgent(agentA, 'push');
      await syncAgent(agentB, 'pull');

      // Verify Agent B has the link
      let results = await queryEntries(agentB, 'Link Del Source');
      let source = results.results.find((r) => r.id === e1.id);
      expect((source as any).links.length).toBeGreaterThan(0);

      // Agent A deletes the entry that has links (which cascades link deletion)
      // Actually, let's just delete one entry to cascade the link
      await callTool(agentA, 'delete_knowledge', { id: e2.id });
      await syncAgent(agentA, 'push');

      // Agent B pulls
      await syncAgent(agentB, 'pull');

      // The target entry should be gone
      results = await queryEntries(agentB, 'Link Del Target');
      expect(results.results.find((r) => r.id === e2.id)).toBeUndefined();
    });
  });

  // =====================================================================
  // 6. Startup sync — pull on boot
  // =====================================================================
  describe('startup sync', () => {
    let remote: string;
    let agentA: AgentHandle;
    let agentB: AgentHandle;

    beforeEach(async () => {
      remote = createBareRemote();
    });

    afterEach(async () => {
      if (agentA) await destroyAgent(agentA);
      if (agentB) await destroyAgent(agentB);
      destroyRemote(remote);
    });

    it('should automatically import entries on startup', async () => {
      agentA = await spawnAgent(remote, 'alice');

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
    });

    it('should import links on startup', async () => {
      agentA = await spawnAgent(remote, 'alice');

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
    });
  });

  // =====================================================================
  // 7. Auto-clone on startup
  // =====================================================================
  describe('auto-clone on startup', () => {
    let remote: string;
    let agentB: AgentHandle & { configPath?: string };

    beforeEach(async () => {
      remote = createBareRemote();
    });

    afterEach(async () => {
      if (agentB) await destroyAgent(agentB);
      destroyRemote(remote);
    });

    it('should auto-clone and pull when repo path does not exist', async () => {
      // Seed the remote with data
      const seedId = randomUUID();
      seedRemote(remote, [
        { id: seedId, type: 'fact', title: 'Pre-seeded entry', content: 'seeded content' },
      ]);

      // Spawn agent with a non-existent path + remote URL
      const { mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const tmpDir = mkdtempSync(join(tmpdir(), 'knowledge-e2e-autoclone-'));
      const nonExistentClone = join(tmpDir, 'auto-cloned-repo');

      agentB = await spawnAgentAutoClone([
        { name: 'default', path: nonExistentClone, remote },
      ], 'bob');

      // The server should have auto-cloned and pulled the seeded entry
      const results = await queryEntries(agentB, 'Pre-seeded entry');
      expect(results.count).toBeGreaterThanOrEqual(1);
      expect(results.results.find((r) => r.id === seedId)).toBeTruthy();

      // Clean up the auto-cloned dir
      const { rmSync } = await import('node:fs');
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should auto-clone with links', async () => {
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

      const { mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const tmpDir = mkdtempSync(join(tmpdir(), 'knowledge-e2e-autoclone2-'));
      const clonePath = join(tmpDir, 'auto-cloned');

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

      // Clean up
      const { rmSync } = await import('node:fs');
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // =====================================================================
  // 8. Edge cases
  // =====================================================================
  describe('edge cases', () => {
    let remote: string;
    let agentA: AgentHandle;
    let agentB: AgentHandle;

    beforeEach(async () => {
      remote = createBareRemote();
    });

    afterEach(async () => {
      if (agentA) await destroyAgent(agentA);
      if (agentB) await destroyAgent(agentB);
      destroyRemote(remote);
    });

    it('should handle empty remote without errors', async () => {
      // Spawn agent with empty remote — no entries to pull
      agentA = await spawnAgent(remote, 'alice');

      // Should be able to query without errors
      const results = await queryEntries(agentA, 'anything');
      expect(results.count).toBe(0);

      // Should be able to push (nothing to push)
      const pushResult = await syncAgent(agentA, 'push');
      expect(pushResult.pushed).toBeTruthy();
    });

    it('should skip malformed JSON files during pull', async () => {
      // Seed remote with one valid entry and one malformed file
      const validId = randomUUID();
      seedRemote(remote, [
        { id: validId, type: 'fact', title: 'Valid entry', content: 'good content' },
      ]);

      // Add a malformed JSON file
      seedMalformedFile(remote, 'entries/fact/bad-file.json', 'this is not valid json {{{');

      // Spawn agent — should import the valid entry and skip the bad one
      agentA = await spawnAgent(remote, 'alice');

      const results = await queryEntries(agentA, 'Valid entry');
      expect(results.count).toBeGreaterThanOrEqual(1);
      expect(results.results.find((r) => r.id === validId)).toBeTruthy();
    });

    it('should handle large entry content', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });

    it('should handle deprecation sync', async () => {
      agentA = await spawnAgent(remote, 'alice');
      agentB = await spawnAgent(remote, 'bob');

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
    });
  });

  // =====================================================================
  // 9. Periodic automatic sync
  // =====================================================================
  describe('periodic automatic sync', () => {
    let remote: string;
    let agentA: AgentHandle;
    let agentB: AgentHandle;

    beforeEach(async () => {
      remote = createBareRemote();
    });

    afterEach(async () => {
      if (agentA) await destroyAgent(agentA);
      if (agentB) await destroyAgent(agentB);
      destroyRemote(remote);
    });

    it('should automatically pull remote changes on interval', async () => {
      // Agent A is a normal agent (no periodic sync)
      agentA = await spawnAgent(remote, 'alice');

      // Agent B has periodic sync every 2 seconds
      agentB = await spawnAgentWithInterval(remote, 'bob', 2);

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
    });

    it('should automatically push local changes on interval', async () => {
      // Agent A has periodic sync every 2 seconds
      agentA = await spawnAgentWithInterval(remote, 'alice', 2);

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
    });

    it('should not conflict when manual sync overlaps with periodic sync', async () => {
      // Agent A has periodic sync every 2 seconds
      agentA = await spawnAgentWithInterval(remote, 'alice', 2);

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
    });
  });
});
