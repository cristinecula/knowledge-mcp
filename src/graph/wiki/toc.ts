// Table of Contents generator — extracts headings from rendered HTML
// and injects `id` attributes for anchor linking.

export interface TocEntry {
  id: string;
  text: string;
  level: number;
}

/**
 * Slugify a heading text into a URL-safe anchor ID.
 */
function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '') // strip HTML tags
    .replace(/[^\w\s-]/g, '') // remove non-word chars
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Parse rendered HTML string to extract h1-h4 headings.
 * Returns the list of TOC entries and the modified HTML with `id` attributes added.
 */
export function extractToc(html: string): { toc: TocEntry[]; html: string } {
  const toc: TocEntry[] = [];
  const usedIds = new Set<string>();

  const modifiedHtml = html.replace(
    /<(h[1-4])([^>]*)>(.*?)<\/\1>/gi,
    (_match, tag: string, attrs: string, content: string) => {
      const level = parseInt(tag[1], 10);
      // Strip HTML from content for the TOC text
      const text = content.replace(/<[^>]+>/g, '').trim();
      if (!text) return _match;

      let id = headingSlug(text);
      // Ensure uniqueness
      if (usedIds.has(id)) {
        let counter = 1;
        while (usedIds.has(`${id}-${counter}`)) counter++;
        id = `${id}-${counter}`;
      }
      usedIds.add(id);

      toc.push({ id, text, level });

      // If there's already an id attribute, replace it; otherwise add one
      if (/\bid=/.test(attrs)) {
        attrs = attrs.replace(/\bid="[^"]*"/, `id="${id}"`);
      } else {
        attrs = ` id="${id}"${attrs}`;
      }

      return `<${tag}${attrs}>${content}</${tag}>`;
    },
  );

  return { toc, html: modifiedHtml };
}

/**
 * Build nested TOC HTML string from flat TocEntry list.
 */
export function renderTocHtml(entries: TocEntry[]): string {
  if (entries.length === 0) return '';

  // Find the minimum level to normalize indentation
  const minLevel = Math.min(...entries.map((e) => e.level));

  let html = '<nav class="wiki-toc"><div class="wiki-toc-title">Contents</div>';

  let currentLevel = minLevel;
  html += '<ul class="wiki-toc-list">';

  for (const entry of entries) {
    while (currentLevel < entry.level) {
      html += '<ul class="wiki-toc-list">';
      currentLevel++;
    }
    while (currentLevel > entry.level) {
      html += '</li></ul>';
      currentLevel--;
    }
    html += `<li class="wiki-toc-item"><a class="wiki-toc-link" href="#${entry.id}">${entry.text}</a>`;
  }

  // Close remaining open tags
  while (currentLevel >= minLevel) {
    html += '</li></ul>';
    currentLevel--;
  }

  html += '</nav>';
  return html;
}
