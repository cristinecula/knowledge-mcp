// Wiki API helpers — browser-side fetch wrappers

export interface WikiEntry {
  id: string;
  title: string;
  content: string;
  type: string;
  status: string;
  scope: string;
  project: string | null;
  tags: string[];
  source: string;
  declaration: string | null;
  parent_page_id: string | null;
  strength: number;
  access_count: number;
  created_at: string;
  updated_at: string;
  content_updated_at: string;
}

export interface WikiLink {
  id: string;
  source_id: string;
  target_id: string;
  link_type: string;
  description: string | null;
}

export async function fetchWikiEntries(): Promise<WikiEntry[]> {
  const res = await fetch('/api/wiki');
  const data = await res.json();
  return data.entries || [];
}

export async function fetchEntry(
  id: string,
): Promise<{ entry: WikiEntry; links: WikiLink[] } | null> {
  const res = await fetch(`/api/entry/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return await res.json();
}

export async function createWikiEntry(body: {
  title: string;
  declaration?: string | null;
  tags?: string[];
  project?: string | null;
  scope?: string;
  parentPageId?: string | null;
}): Promise<{ entry?: WikiEntry }> {
  const res = await fetch('/api/wiki', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json();
}

export async function updateWikiEntry(
  id: string,
  body: {
    title?: string;
    declaration?: string | null;
    tags?: string[];
    project?: string | null;
    scope?: string;
    parentPageId?: string | null;
  },
): Promise<{ entry?: WikiEntry }> {
  const res = await fetch(`/api/wiki/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json();
}

export async function deleteWikiEntry(id: string): Promise<{ deleted?: boolean }> {
  const res = await fetch(`/api/wiki/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return await res.json();
}
