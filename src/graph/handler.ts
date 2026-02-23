import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGraphData, getKnowledgeById, getLinksForEntry, searchKnowledge } from '../db/queries.js';
import { getEmbeddingProvider } from '../embeddings/provider.js';
import { vectorSearch, reciprocalRankFusion, type ScoredEntry } from '../embeddings/similarity.js';

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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
        includeDormant: true,
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
            includeDormant: true,
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

  // Static files
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(res, resolve(STATIC_DIR, 'index.html'));
    return;
  }

  if (pathname === '/graph.js') {
    serveStatic(res, resolve(STATIC_DIR, 'graph.js'));
    return;
  }

  if (pathname === '/style.css') {
    serveStatic(res, resolve(STATIC_DIR, 'style.css'));
    return;
  }

  sendError(res, 'Not found', 404);
}
