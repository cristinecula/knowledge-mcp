// <wiki-list> — displays all wiki pages as a card list

import { component, html, useState, useEffect } from '@pionjs/pion';
import { navigate } from '@neovici/cosmoz-router';
import { fetchWikiEntries, type WikiEntry } from '../api.js';
import { escapeHtml, timeAgo, statusBadge, slugify } from '../util.js';

function WikiList() {
  const [entries, setEntries] = useState<WikiEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchWikiEntries().then((e) => {
      if (!cancelled) {
        setEntries(e);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return html`<div class="wiki-empty">Loading...</div>`;
  }

  if (entries.length === 0) {
    return html`
      <div class="wiki-empty">
        <h3>No wiki pages yet</h3>
        <p>
          Create your first wiki page to get started. Define a title and a
          declaration (prompt) — agents will fill in the content.
        </p>
      </div>
    `;
  }

  return html`
    <div class="wiki-list">
      ${entries.map(
        (entry) => html`
          <div
            class="wiki-card"
            @click=${(e: Event) => {
              e.preventDefault();
              navigate(`/wiki/${entry.id}/${slugify(entry.title)}`, null, {
                replace: false,
              });
            }}
          >
            <div class="wiki-card-main">
              <div class="wiki-card-title">${entry.title}</div>
              <div
                class="wiki-card-meta"
                .innerHTML=${`
                ${statusBadge(entry.status)}
                ${entry.project ? `<span>${escapeHtml(entry.project)}</span>` : ''}
                <span>${entry.scope}</span>
                <span>Updated ${timeAgo(entry.updated_at)}</span>
              `}
              ></div>
              ${entry.tags && entry.tags.length > 0
                ? html`<div class="wiki-card-tags">
                    ${entry.tags.map(
                      (t) => html`<span class="wiki-tag">${t}</span>`,
                    )}
                  </div>`
                : null}
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

customElements.define(
  'wiki-list',
  component(WikiList, { useShadowDOM: false }),
);
