import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getGraphData,
  getKnowledgeById,
  getLinksForEntry,
  searchKnowledge,
  insertKnowledge,
  updateKnowledgeFields,
  deleteKnowledge,
  insertLink,
  updateStatus,
  flagForRevalidation,
} from '../db/queries.js';
import { getEmbeddingProvider } from '../embeddings/provider.js';
import { vectorSearch, reciprocalRankFusion, type ScoredEntry } from '../embeddings/similarity.js';
import { getEntryHistory, getEntryAtCommitWithParent } from '../sync/index.js';
import { SCOPES, type Scope } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(__dirname, 'static');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Parse JSON body, returning null on failure. */
async function parseJsonBody(req: IncomingMessage): Promise<unknown | null> {
  try {
    const raw = await readBody(req);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, message: string, status = 404): void {
  sendJson(res, { error: message }, status);
}

function serveStatic(res: ServerResponse, filePath: string): void {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? 'text/plain';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    sendError(res, 'File not found', 404);
  }
}

/**
 * Handle HTTP requests for the knowledge graph visualization.
 */
export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // API routes
  if (pathname === '/api/graph') {
    try {
      const data = getGraphData();
      sendJson(res, data);
    } catch (error) {
      sendError(
        res,
        `Error fetching graph data: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return;
  }

  // Search API — FTS5 + optional semantic search
  if (pathname === '/api/search') {
    const query = url.searchParams.get('q') ?? '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);

    if (!query) {
      sendJson(res, { results: [] });
      return;
    }

    try {
      // FTS5 keyword search (broad, includes all statuses)
      const ftsEntries = searchKnowledge({
        query,
        limit: limit * 2,
        includeWeak: true,
        status: 'all',
      });

      // Semantic vector search (if embedding provider is configured)
      let finalEntries = ftsEntries;
      const provider = getEmbeddingProvider();

      if (provider) {
        try {
          // Broad candidate pool for vector search
          const candidates = searchKnowledge({
            limit: 200,
            includeWeak: true,
            status: 'all',
          });

          const vecResults = await vectorSearch(query, candidates, limit * 2);

          if (vecResults.length > 0) {
            const ftsScored: ScoredEntry[] = ftsEntries.map((entry, i) => ({
              entry,
              score: 1 / (i + 1),
            }));

            const merged = reciprocalRankFusion(ftsScored, vecResults);
            finalEntries = merged.slice(0, limit).map((m) => m.entry);
          }
        } catch {
          // Fall back to FTS-only results
        }
      }

      finalEntries = finalEntries.slice(0, limit);

      sendJson(res, {
        results: finalEntries.map((entry, i) => ({
          id: entry.id,
          title: entry.title,
          type: entry.type,
          score: 1 / (i + 1), // rank-based score for the frontend
        })),
      });
    } catch (error) {
      sendError(
        res,
        `Error searching: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return;
  }

  // Entry history API — must be matched before the generic /api/entry/:id route
  const historyMatch = pathname.match(/^\/api\/entry\/([^/]+)\/history$/);
  if (historyMatch) {
    const id = decodeURIComponent(historyMatch[1]);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100);
    try {
      const history = getEntryHistory(id, limit);
      sendJson(res, { history });
    } catch (error) {
      sendError(
        res,
        `Error fetching entry history: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return;
  }

  const historyVersionMatch = pathname.match(/^\/api\/entry\/([^/]+)\/history\/([^/]+)$/);
  if (historyVersionMatch) {
    const id = decodeURIComponent(historyVersionMatch[1]);
    const hash = decodeURIComponent(historyVersionMatch[2]);
    try {
      const result = getEntryAtCommitWithParent(id, hash);
      if (!result) {
        sendError(res, `Version not found: ${hash}`);
        return;
      }
      sendJson(res, { entry: result.entry, parent: result.parent });
    } catch (error) {
      sendError(
        res,
        `Error fetching entry version: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return;
  }

  const entryMatch = pathname.match(/^\/api\/entry\/(.+)$/);
  if (entryMatch) {
    const id = decodeURIComponent(entryMatch[1]);
    try {
      const entry = getKnowledgeById(id);
      if (!entry) {
        sendError(res, `Entry not found: ${id}`);
        return;
      }
      const links = getLinksForEntry(id);
      sendJson(res, { entry, links });
    } catch (error) {
      sendError(
        res,
        `Error fetching entry: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return;
  }

  // --- Wiki API routes ---

  // GET /api/wiki — list all wiki entries
  if (pathname === '/api/wiki' && req.method === 'GET') {
    try {
      const entries = searchKnowledge({
        type: 'wiki',
        limit: 250,
        includeWeak: true,
        status: 'all',
        sortBy: 'recent',
      });
      sendJson(res, { entries });
    } catch (error) {
      sendError(
        res,
        `Error listing wiki entries: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return;
  }

  // POST /api/wiki — create a new wiki entry
  if (pathname === '/api/wiki' && req.method === 'POST') {
    const body = await parseJsonBody(req) as Record<string, unknown> | null;
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      sendError(res, 'Missing required field: title', 400);
      return;
    }

    const title = (body.title as string).trim();
    const declaration = typeof body.declaration === 'string' ? body.declaration.trim() || null : null;
    const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : [];
    const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : null;
    const scope = (typeof body.scope === 'string' && (SCOPES as readonly string[]).includes(body.scope) ? body.scope : 'company') as Scope;
    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'wiki-ui';
    const sourceLinks = Array.isArray(body.sourceLinks) ? body.sourceLinks.filter((id): id is string => typeof id === 'string') : [];

    // Validate parentPageId if provided
    let parentPageId: string | null = null;
    if (typeof body.parentPageId === 'string' && body.parentPageId.trim()) {
      const parentEntry = getKnowledgeById(body.parentPageId.trim());
      if (!parentEntry) {
        sendError(res, `Parent page not found: ${body.parentPageId}`, 400);
        return;
      }
      if (parentEntry.type !== 'wiki') {
        sendError(res, 'Parent must be a wiki page', 400);
        return;
      }
      parentPageId = parentEntry.id;
    }

    try {
      const entry = insertKnowledge({
        type: 'wiki',
        title,
        content: '',
        tags,
        project,
        scope,
        source,
        declaration,
        parentPageId,
      });

      // Mark as needs_revalidation so agents discover it
      updateStatus(entry.id, 'needs_revalidation');

      // Create source links (derived) if any
      for (const sourceId of sourceLinks) {
        const sourceEntry = getKnowledgeById(sourceId);
        if (sourceEntry) {
          insertLink({
            sourceId: entry.id,
            targetId: sourceId,
            linkType: 'derived',
            description: 'Wiki page source reference',
            source: 'wiki-ui',
          });
        }
      }

      const updated = getKnowledgeById(entry.id)!;
      sendJson(res, { entry: updated }, 201);
    } catch (error) {
      sendError(
        res,
        `Error creating wiki entry: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return;
  }

  // PUT /api/wiki/:id — update a wiki entry's declaration
  const wikiUpdateMatch = pathname.match(/^\/api\/wiki\/([^/]+)$/);
  if (wikiUpdateMatch && req.method === 'PUT') {
    const id = decodeURIComponent(wikiUpdateMatch[1]);
    const body = await parseJsonBody(req) as Record<string, unknown> | null;
    if (!body) {
      sendError(res, 'Invalid JSON body', 400);
      return;
    }

    try {
      const existing = getKnowledgeById(id);
      if (!existing) {
        sendError(res, `Wiki entry not found: ${id}`);
        return;
      }
      if (existing.type !== 'wiki') {
        sendError(res, 'Entry is not a wiki page', 400);
        return;
      }

      const fields: Record<string, unknown> = {};

      if (typeof body.title === 'string' && body.title.trim()) {
        fields.title = body.title.trim();
      }
      if (body.declaration !== undefined) {
        fields.declaration = typeof body.declaration === 'string' ? body.declaration.trim() || null : null;
      }
      if (Array.isArray(body.tags)) {
        fields.tags = body.tags.filter((t): t is string => typeof t === 'string');
      }
      if (body.project !== undefined) {
        fields.project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : null;
      }
      if (typeof body.scope === 'string' && (SCOPES as readonly string[]).includes(body.scope)) {
        fields.scope = body.scope;
      }
      if (body.parentPageId !== undefined) {
        if (body.parentPageId === null || body.parentPageId === '') {
          fields.parentPageId = null;
        } else if (typeof body.parentPageId === 'string') {
          const parentEntry = getKnowledgeById(body.parentPageId.trim());
          if (!parentEntry) {
            sendError(res, `Parent page not found: ${body.parentPageId}`, 400);
            return;
          }
          if (parentEntry.type !== 'wiki') {
            sendError(res, 'Parent must be a wiki page', 400);
            return;
          }
          if (parentEntry.id === id) {
            sendError(res, 'A page cannot be its own parent', 400);
            return;
          }
          fields.parentPageId = parentEntry.id;
        }
      }

      updateKnowledgeFields(id, fields as Parameters<typeof updateKnowledgeFields>[1]);

      // Re-mark as needs_revalidation so agents re-process it
      if (body.declaration !== undefined) {
        updateStatus(id, 'needs_revalidation');
      }

      const result = getKnowledgeById(id)!;
      sendJson(res, { entry: result });
    } catch (error) {
      sendError(
        res,
        `Error updating wiki entry: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return;
  }

  // POST /api/wiki/:id/flag — flag a wiki entry as inaccurate
  const wikiFlagMatch = pathname.match(/^\/api\/wiki\/([^/]+)\/flag$/);
  if (wikiFlagMatch && req.method === 'POST') {
    const id = decodeURIComponent(wikiFlagMatch[1]);
    const body = await parseJsonBody(req) as Record<string, unknown> | null;
    const reason = body && typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : undefined;

    try {
      const existing = getKnowledgeById(id);
      if (!existing) {
        sendError(res, `Wiki entry not found: ${id}`);
        return;
      }
      if (existing.type !== 'wiki') {
        sendError(res, 'Entry is not a wiki page', 400);
        return;
      }

      const updated = flagForRevalidation(id, reason);
      sendJson(res, { entry: updated });
    } catch (error) {
      sendError(
        res,
        `Error flagging wiki entry: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return;
  }

  // DELETE /api/wiki/:id — delete a wiki entry
  const wikiDeleteMatch = pathname.match(/^\/api\/wiki\/([^/]+)$/);
  if (wikiDeleteMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(wikiDeleteMatch[1]);
    try {
      const existing = getKnowledgeById(id);
      if (!existing) {
        sendError(res, `Wiki entry not found: ${id}`);
        return;
      }
      if (existing.type !== 'wiki') {
        sendError(res, 'Entry is not a wiki page', 400);
        return;
      }
      deleteKnowledge(id);
      sendJson(res, { deleted: true });
    } catch (error) {
      sendError(
        res,
        `Error deleting wiki entry: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    return;
  }

  // Static files
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(res, resolve(STATIC_DIR, 'index.html'));
    return;
  }

  if (pathname === '/graph.js') {
    serveStatic(res, resolve(STATIC_DIR, 'graph.js'));
    return;
  }

  if (pathname === '/wiki-app.js') {
    serveStatic(res, resolve(STATIC_DIR, 'wiki-app.js'));
    return;
  }

  if (pathname === '/style.css') {
    serveStatic(res, resolve(STATIC_DIR, 'style.css'));
    return;
  }

  if (pathname === '/wiki-style.css') {
    serveStatic(res, resolve(STATIC_DIR, 'wiki-style.css'));
    return;
  }

  // SPA catch-all: any /wiki* path (except /api/wiki*) serves the wiki shell
  if (pathname === '/wiki' || pathname.startsWith('/wiki/')) {
    serveStatic(res, resolve(STATIC_DIR, 'wiki.html'));
    return;
  }

  sendError(res, 'Not found', 404);
}
