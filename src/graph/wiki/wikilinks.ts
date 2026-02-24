// Resolve [[Page Title]] wiki links in markdown content
//
// Replaces [[Title]] with clickable <a> links for pages that exist,
// or <span class="wiki-link-broken"> for unresolved titles.
// Supports auto-fallback: wiki pages are matched first, then KB entries.

import type { WikiEntry } from './api.js';
import { slugify } from './util.js';

/**
 * Resolve `[[Page Title]]` patterns in raw markdown content.
 * Must be called BEFORE markdown rendering (marked.parse) so the
 * generated HTML anchors survive the markdown pass.
 *
 * When `kbEntries` is provided, unresolved titles are matched against
 * KB entries as a fallback. KB entry links get a distinct CSS class
 * (`wiki-link wiki-link-kb`) for visual differentiation.
 */
export function resolveWikiLinks(
  content: string,
  entries: WikiEntry[],
  kbEntries: WikiEntry[] = [],
): string {
  // Build case-insensitive title → entry lookups
  const wikiByTitle = new Map<string, WikiEntry>();
  for (const entry of entries) {
    wikiByTitle.set(entry.title.toLowerCase(), entry);
  }

  const kbByTitle = new Map<string, WikiEntry>();
  for (const entry of kbEntries) {
    kbByTitle.set(entry.title.toLowerCase(), entry);
  }

  return content.replace(/\[\[([^\]]+)\]\]/g, (_match, title: string) => {
    const trimmed = title.trim();
    const key = trimmed.toLowerCase();

    // Try wiki pages first
    const wikiEntry = wikiByTitle.get(key);
    if (wikiEntry) {
      const href = `/wiki/${wikiEntry.id}/${slugify(wikiEntry.title)}`;
      return `<a href="${href}" class="wiki-link" data-wiki-id="${wikiEntry.id}">${trimmed}</a>`;
    }

    // Fallback to KB entries
    const kbEntry = kbByTitle.get(key);
    if (kbEntry) {
      const href = `/wiki/${kbEntry.id}/${slugify(kbEntry.title)}`;
      return `<a href="${href}" class="wiki-link wiki-link-kb" data-wiki-id="${kbEntry.id}">${trimmed}</a>`;
    }

    return `<span class="wiki-link-broken" title="Page not found">${trimmed}</span>`;
  });
}
