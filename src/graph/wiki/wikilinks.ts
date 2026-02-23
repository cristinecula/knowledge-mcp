// Resolve [[Page Title]] wiki links in markdown content
//
// Replaces [[Title]] with clickable <a> links for pages that exist,
// or <span class="wiki-link-broken"> for unresolved titles.

import type { WikiEntry } from './api.js';
import { slugify } from './util.js';

/**
 * Resolve `[[Page Title]]` patterns in raw markdown content.
 * Must be called BEFORE markdown rendering (marked.parse) so the
 * generated HTML anchors survive the markdown pass.
 */
export function resolveWikiLinks(content: string, entries: WikiEntry[]): string {
  // Build a case-insensitive title → entry lookup
  const byTitle = new Map<string, WikiEntry>();
  for (const entry of entries) {
    byTitle.set(entry.title.toLowerCase(), entry);
  }

  return content.replace(/\[\[([^\]]+)\]\]/g, (_match, title: string) => {
    const trimmed = title.trim();
    const entry = byTitle.get(trimmed.toLowerCase());
    if (entry) {
      const href = `/wiki/${entry.id}/${slugify(entry.title)}`;
      return `<a href="${href}" class="wiki-link" data-wiki-id="${entry.id}">${trimmed}</a>`;
    }
    return `<span class="wiki-link-broken" title="Page not found">${trimmed}</span>`;
  });
}
