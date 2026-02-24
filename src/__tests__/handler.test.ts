import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { handleRequest } from '../graph/handler.js';
import { insertKnowledge, getKnowledgeById } from '../db/queries.js';
import { Readable } from 'node:stream';

beforeEach(() => {
  setupTestDb();
});

afterAll(() => {
  teardownTestDb();
});

// --- Lightweight mock for IncomingMessage + ServerResponse ---

interface MockResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  json(): unknown;
}

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const readable = new Readable({ read() {} });
  if (body !== undefined) {
    readable.push(JSON.stringify(body));
  }
  readable.push(null);

  return Object.assign(readable, {
    method,
    url,
    headers: { host: 'localhost', 'content-type': 'application/json' },
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    connection: {} as never,
    socket: {} as never,
  }) as unknown as IncomingMessage;
}

function mockRes(): { res: ServerResponse; getResult(): MockResult } {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  let body = '';

  const res = {
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
      return res;
    },
    end(chunk?: string | Buffer) {
      if (chunk) body = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    },
    setHeader() { return res; },
    getHeader() { return undefined; },
  } as unknown as ServerResponse;

  return {
    res,
    getResult(): MockResult {
      return {
        statusCode,
        headers,
        body,
        json() { return JSON.parse(body); },
      };
    },
  };
}

async function request(method: string, url: string, body?: unknown): Promise<MockResult> {
  const req = mockReq(method, url, body);
  const { res, getResult } = mockRes();
  await handleRequest(req, res);
  return getResult();
}

// --- Tests ---

describe('Wiki API — GET /api/wiki', () => {
  it('should return empty list when no wiki entries exist', async () => {
    const resp = await request('GET', '/api/wiki');
    expect(resp.statusCode).toBe(200);
    const data = resp.json() as { entries: unknown[] };
    expect(data.entries).toEqual([]);
  });

  it('should return only wiki-type entries', async () => {
    insertKnowledge({ type: 'wiki', title: 'Wiki Page', content: 'wiki' });
    insertKnowledge({ type: 'fact', title: 'A Fact', content: 'fact' });

    const resp = await request('GET', '/api/wiki');
    const data = resp.json() as { entries: Array<{ title: string; type: string }> };
    expect(data.entries.length).toBe(1);
    expect(data.entries[0].title).toBe('Wiki Page');
    expect(data.entries[0].type).toBe('wiki');
  });
});

describe('Wiki API — POST /api/wiki', () => {
  it('should create a wiki entry', async () => {
    const resp = await request('POST', '/api/wiki', {
      title: 'New Page',
      declaration: 'Describe the architecture',
      tags: ['arch'],
      scope: 'project',
    });

    expect(resp.statusCode).toBe(201);
    const data = resp.json() as { entry: { title: string; type: string; declaration: string; scope: string } };
    expect(data.entry.title).toBe('New Page');
    expect(data.entry.type).toBe('wiki');
    expect(data.entry.declaration).toBe('Describe the architecture');
    expect(data.entry.scope).toBe('project');
  });

  it('should reject missing title', async () => {
    const resp = await request('POST', '/api/wiki', { declaration: 'No title' });
    expect(resp.statusCode).toBe(400);
    const data = resp.json() as { error: string };
    expect(data.error).toContain('title');
  });

  it('should create with parentPageId', async () => {
    const parent = insertKnowledge({ type: 'wiki', title: 'Parent', content: '' });

    const resp = await request('POST', '/api/wiki', {
      title: 'Child Page',
      parentPageId: parent.id,
    });

    expect(resp.statusCode).toBe(201);
    const data = resp.json() as { entry: { id: string; parent_page_id: string | null } };
    expect(data.entry.parent_page_id).toBe(parent.id);
  });

  it('should reject non-existent parentPageId', async () => {
    const resp = await request('POST', '/api/wiki', {
      title: 'Orphan',
      parentPageId: '00000000-0000-0000-0000-000000000000',
    });

    expect(resp.statusCode).toBe(400);
    const data = resp.json() as { error: string };
    expect(data.error).toContain('Parent page not found');
  });

  it('should reject non-wiki parentPageId', async () => {
    const fact = insertKnowledge({ type: 'fact', title: 'A Fact', content: 'fact' });

    const resp = await request('POST', '/api/wiki', {
      title: 'Bad Parent',
      parentPageId: fact.id,
    });

    expect(resp.statusCode).toBe(400);
    const data = resp.json() as { error: string };
    expect(data.error).toContain('Parent must be a wiki page');
  });

  it('should mark created entry with high inaccuracy', async () => {
    const resp = await request('POST', '/api/wiki', { title: 'Marked Page' });
    expect(resp.statusCode).toBe(201);
    const data = resp.json() as { entry: { id: string; status: string; inaccuracy: number } };
    expect(data.entry.status).toBe('active');
    expect(data.entry.inaccuracy).toBeGreaterThanOrEqual(1.0);
  });

  it('should default to company scope', async () => {
    const resp = await request('POST', '/api/wiki', { title: 'Default Scope' });
    expect(resp.statusCode).toBe(201);
    const data = resp.json() as { entry: { scope: string } };
    expect(data.entry.scope).toBe('company');
  });

  it('should default source to wiki-ui', async () => {
    const resp = await request('POST', '/api/wiki', { title: 'Default Source' });
    expect(resp.statusCode).toBe(201);
    const data = resp.json() as { entry: { source: string } };
    expect(data.entry.source).toBe('wiki-ui');
  });
});

describe('Wiki API — PUT /api/wiki/:id', () => {
  it('should update title and declaration', async () => {
    const entry = insertKnowledge({ type: 'wiki', title: 'Old Title', content: '' });

    const resp = await request('PUT', `/api/wiki/${entry.id}`, {
      title: 'New Title',
      declaration: 'Updated declaration',
    });

    expect(resp.statusCode).toBe(200);
    const data = resp.json() as { entry: { title: string; declaration: string } };
    expect(data.entry.title).toBe('New Title');
    expect(data.entry.declaration).toBe('Updated declaration');
  });

  it('should set parentPageId', async () => {
    const parent = insertKnowledge({ type: 'wiki', title: 'Parent', content: '' });
    const child = insertKnowledge({ type: 'wiki', title: 'Child', content: '' });

    const resp = await request('PUT', `/api/wiki/${child.id}`, {
      parentPageId: parent.id,
    });

    expect(resp.statusCode).toBe(200);
    const data = resp.json() as { entry: { parent_page_id: string | null } };
    expect(data.entry.parent_page_id).toBe(parent.id);
  });

  it('should clear parentPageId with null', async () => {
    const parent = insertKnowledge({ type: 'wiki', title: 'Parent', content: '' });
    const child = insertKnowledge({
      type: 'wiki',
      title: 'Child',
      content: '',
      parentPageId: parent.id,
    });

    expect(child.parent_page_id).toBe(parent.id);

    const resp = await request('PUT', `/api/wiki/${child.id}`, {
      parentPageId: null,
    });

    expect(resp.statusCode).toBe(200);
    const data = resp.json() as { entry: { parent_page_id: string | null } };
    expect(data.entry.parent_page_id).toBeNull();
  });

  it('should clear parentPageId with empty string', async () => {
    const parent = insertKnowledge({ type: 'wiki', title: 'Parent', content: '' });
    const child = insertKnowledge({
      type: 'wiki',
      title: 'Child',
      content: '',
      parentPageId: parent.id,
    });

    const resp = await request('PUT', `/api/wiki/${child.id}`, {
      parentPageId: '',
    });

    expect(resp.statusCode).toBe(200);
    const data = resp.json() as { entry: { parent_page_id: string | null } };
    expect(data.entry.parent_page_id).toBeNull();
  });

  it('should reject self-referencing parentPageId', async () => {
    const entry = insertKnowledge({ type: 'wiki', title: 'Self Ref', content: '' });

    const resp = await request('PUT', `/api/wiki/${entry.id}`, {
      parentPageId: entry.id,
    });

    expect(resp.statusCode).toBe(400);
    const data = resp.json() as { error: string };
    expect(data.error).toContain('cannot be its own parent');
  });

  it('should reject non-existent parentPageId on update', async () => {
    const entry = insertKnowledge({ type: 'wiki', title: 'Orphan', content: '' });

    const resp = await request('PUT', `/api/wiki/${entry.id}`, {
      parentPageId: '00000000-0000-0000-0000-000000000000',
    });

    expect(resp.statusCode).toBe(400);
    const data = resp.json() as { error: string };
    expect(data.error).toContain('Parent page not found');
  });

  it('should reject non-wiki parentPageId on update', async () => {
    const entry = insertKnowledge({ type: 'wiki', title: 'Wiki', content: '' });
    const fact = insertKnowledge({ type: 'fact', title: 'Fact', content: '' });

    const resp = await request('PUT', `/api/wiki/${entry.id}`, {
      parentPageId: fact.id,
    });

    expect(resp.statusCode).toBe(400);
    const data = resp.json() as { error: string };
    expect(data.error).toContain('Parent must be a wiki page');
  });

  it('should return 404 for non-existent wiki entry', async () => {
    const resp = await request('PUT', '/api/wiki/00000000-0000-0000-0000-000000000000', {
      title: 'Ghost',
    });

    expect(resp.statusCode).toBe(404);
  });

  it('should reject updating a non-wiki entry', async () => {
    const fact = insertKnowledge({ type: 'fact', title: 'A Fact', content: '' });

    const resp = await request('PUT', `/api/wiki/${fact.id}`, {
      title: 'Hacked',
    });

    expect(resp.statusCode).toBe(400);
    const data = resp.json() as { error: string };
    expect(data.error).toContain('not a wiki page');
  });

  it('should update tags', async () => {
    const entry = insertKnowledge({ type: 'wiki', title: 'Tagged', content: '' });

    const resp = await request('PUT', `/api/wiki/${entry.id}`, {
      tags: ['a', 'b', 'c'],
    });

    expect(resp.statusCode).toBe(200);
    const data = resp.json() as { entry: { tags: string[] } };
    expect(data.entry.tags).toEqual(['a', 'b', 'c']);
  });

  it('should update scope', async () => {
    const entry = insertKnowledge({ type: 'wiki', title: 'Scoped', content: '' });

    const resp = await request('PUT', `/api/wiki/${entry.id}`, {
      scope: 'repo',
    });

    expect(resp.statusCode).toBe(200);
    const data = resp.json() as { entry: { scope: string } };
    expect(data.entry.scope).toBe('repo');
  });
});

describe('Wiki API — DELETE /api/wiki/:id', () => {
  it('should delete a wiki entry', async () => {
    const entry = insertKnowledge({ type: 'wiki', title: 'Doomed', content: '' });

    const resp = await request('DELETE', `/api/wiki/${entry.id}`);
    expect(resp.statusCode).toBe(200);
    const data = resp.json() as { deleted: boolean };
    expect(data.deleted).toBe(true);

    const gone = getKnowledgeById(entry.id);
    expect(gone).toBeFalsy();
  });

  it('should return 404 for non-existent entry', async () => {
    const resp = await request('DELETE', '/api/wiki/00000000-0000-0000-0000-000000000000');
    expect(resp.statusCode).toBe(404);
  });

  it('should reject deleting a non-wiki entry', async () => {
    const fact = insertKnowledge({ type: 'fact', title: 'Fact', content: '' });

    const resp = await request('DELETE', `/api/wiki/${fact.id}`);
    expect(resp.statusCode).toBe(400);
    const data = resp.json() as { error: string };
    expect(data.error).toContain('not a wiki page');
  });
});

describe('Wiki API — GET /api/entry/:id', () => {
  it('should return entry with links', async () => {
    const entry = insertKnowledge({ type: 'wiki', title: 'Detail Page', content: 'Hello' });

    const resp = await request('GET', `/api/entry/${entry.id}`);
    expect(resp.statusCode).toBe(200);
    const data = resp.json() as { entry: { id: string; title: string }; links: unknown[] };
    expect(data.entry.id).toBe(entry.id);
    expect(data.entry.title).toBe('Detail Page');
    expect(data.links).toEqual([]);
  });

  it('should return 404 for non-existent entry', async () => {
    const resp = await request('GET', '/api/entry/00000000-0000-0000-0000-000000000000');
    expect(resp.statusCode).toBe(404);
  });
});

describe('Wiki API — hierarchy integration', () => {
  it('should support multi-level hierarchy via API', async () => {
    // Create grandparent -> parent -> child via POST
    const gpResp = await request('POST', '/api/wiki', { title: 'Grandparent' });
    const gp = (gpResp.json() as { entry: { id: string } }).entry;

    const pResp = await request('POST', '/api/wiki', {
      title: 'Parent',
      parentPageId: gp.id,
    });
    const parent = (pResp.json() as { entry: { id: string; parent_page_id: string } }).entry;
    expect(parent.parent_page_id).toBe(gp.id);

    const cResp = await request('POST', '/api/wiki', {
      title: 'Child',
      parentPageId: parent.id,
    });
    const child = (cResp.json() as { entry: { id: string; parent_page_id: string } }).entry;
    expect(child.parent_page_id).toBe(parent.id);

    // Verify list returns all with correct parent_page_id
    const listResp = await request('GET', '/api/wiki');
    const list = (listResp.json() as { entries: Array<{ id: string; parent_page_id: string | null }> }).entries;
    expect(list.length).toBe(3);

    const gpEntry = list.find((e) => e.id === gp.id)!;
    const parentEntry = list.find((e) => e.id === parent.id)!;
    const childEntry = list.find((e) => e.id === child.id)!;

    expect(gpEntry.parent_page_id).toBeNull();
    expect(parentEntry.parent_page_id).toBe(gp.id);
    expect(childEntry.parent_page_id).toBe(parent.id);
  });

  it('should allow re-parenting via PUT', async () => {
    const a = insertKnowledge({ type: 'wiki', title: 'A', content: '' });
    const b = insertKnowledge({ type: 'wiki', title: 'B', content: '' });
    const child = insertKnowledge({
      type: 'wiki',
      title: 'Child',
      content: '',
      parentPageId: a.id,
    });

    expect(child.parent_page_id).toBe(a.id);

    // Re-parent to B
    const resp = await request('PUT', `/api/wiki/${child.id}`, {
      parentPageId: b.id,
    });

    expect(resp.statusCode).toBe(200);
    const data = resp.json() as { entry: { parent_page_id: string } };
    expect(data.entry.parent_page_id).toBe(b.id);
  });
});

describe('Wiki API — POST /api/wiki/:id/flag', () => {
  it('should flag a wiki entry successfully', async () => {
    const entry = insertKnowledge({ type: 'wiki', title: 'Flaggable Page', content: 'some content' });

    const resp = await request('POST', `/api/wiki/${entry.id}/flag`);
    expect(resp.statusCode).toBe(200);

    const data = resp.json() as { entry: { id: string; status: string; inaccuracy: number } };
    expect(data.entry.id).toBe(entry.id);
    expect(data.entry.status).toBe('active');
    expect(data.entry.inaccuracy).toBeGreaterThanOrEqual(1.0);
  });

  it('should flag with a reason', async () => {
    const entry = insertKnowledge({ type: 'wiki', title: 'Needs Review', content: 'outdated info' });

    const resp = await request('POST', `/api/wiki/${entry.id}/flag`, {
      reason: 'Statistics are incorrect',
    });
    expect(resp.statusCode).toBe(200);

    const data = resp.json() as { entry: { id: string; status: string; inaccuracy: number; flag_reason: string } };
    expect(data.entry.status).toBe('active');
    expect(data.entry.inaccuracy).toBeGreaterThanOrEqual(1.0);
    expect(data.entry.flag_reason).toBe('Statistics are incorrect');
  });

  it('should flag without a reason', async () => {
    const entry = insertKnowledge({ type: 'wiki', title: 'No Reason', content: 'content' });

    const resp = await request('POST', `/api/wiki/${entry.id}/flag`, {});
    expect(resp.statusCode).toBe(200);

    const updated = getKnowledgeById(entry.id)!;
    expect(updated.status).toBe('active');
    expect(updated.inaccuracy).toBeGreaterThanOrEqual(1.0);
    expect(updated.flag_reason).toBeNull();
  });

  it('should return 404 for nonexistent entry', async () => {
    const resp = await request('POST', '/api/wiki/nonexistent-id/flag');
    expect(resp.statusCode).toBe(404);
  });

  it('should return 400 for non-wiki entry', async () => {
    const entry = insertKnowledge({ type: 'fact', title: 'A Fact', content: 'factual' });

    const resp = await request('POST', `/api/wiki/${entry.id}/flag`);
    expect(resp.statusCode).toBe(400);
  });
});
