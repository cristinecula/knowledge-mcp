// <wiki-detail> — shows a single wiki page with content rendered as markdown

import { component, html, useState, useEffect } from '@pionjs/pion';
import { navigate } from '@neovici/cosmoz-router';
import { marked } from 'marked';
import {
  fetchEntry,
  deleteWikiEntry,
  type WikiEntry,
  type WikiLink,
} from '../api.js';
import { escapeHtml, timeAgo, statusBadge } from '../util.js';

function WikiDetail(this: HTMLElement & { entryId: string }) {
  const entryId = this.entryId;
  const [entry, setEntry] = useState<WikiEntry | null>(null);
  const [links, setLinks] = useState<WikiLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    fetchEntry(entryId).then((data) => {
      if (cancelled) return;
      if (!data || !data.entry) {
        setNotFound(true);
      } else {
        setEntry(data.entry);
        setLinks(data.links || []);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  if (loading) {
    return html`<div class="wiki-empty">Loading...</div>`;
  }

  if (notFound || !entry) {
    return html`<div class="wiki-empty">Entry not found</div>`;
  }

  const contentHtml =
    entry.content && entry.content.trim()
      ? (marked.parse(entry.content) as string)
      : '<div class="wiki-content-empty">No content yet. An agent will fill this in based on the declaration.</div>';

  const handleDelete = async () => {
    if (confirm(`Delete wiki page "${entry.title}"?`)) {
      await deleteWikiEntry(entry.id);
      navigate('/wiki', null, { replace: false });
    }
  };

  return html`
    <div class="wiki-detail">
      <div class="wiki-detail-header">
        <div>
          <div class="wiki-detail-title">${entry.title}</div>
          <div
            class="wiki-detail-meta"
            .innerHTML=${`
            ${statusBadge(entry.status)}
            ${entry.project ? `<span>${escapeHtml(entry.project)}</span>` : ''}
            <span>${entry.scope}</span>
            <span>Source: ${escapeHtml(entry.source)}</span>
            <span>Updated ${timeAgo(entry.updated_at)}</span>
          `}
          ></div>
        </div>
        <div class="wiki-detail-actions">
          <button
            class="wiki-btn"
            @click=${() => navigate('/wiki', null, { replace: false })}
          >
            Back
          </button>
          <button
            class="wiki-btn"
            @click=${() =>
              navigate(`/wiki/${entry.id}/edit`, null, { replace: false })}
          >
            Edit
          </button>
          <button class="wiki-btn wiki-btn-danger" @click=${handleDelete}>
            Delete
          </button>
        </div>
      </div>

      ${entry.tags && entry.tags.length > 0
        ? html`<div class="wiki-card-tags" style="margin-bottom:16px">
            ${entry.tags.map(
              (t) => html`<span class="wiki-tag">${t}</span>`,
            )}
          </div>`
        : null}
      ${entry.declaration
        ? html`<div class="wiki-declaration">
            <div class="wiki-declaration-label">Declaration</div>
            ${entry.declaration}
          </div>`
        : null}

      <div class="wiki-content" .innerHTML=${contentHtml}></div>

      ${links.length > 0
        ? html`<div style="margin-top:16px">
            <h4 style="font-size:13px;color:#8b949e;margin-bottom:8px">
              Links (${links.length})
            </h4>
            ${links.map((link) => {
              const isOutgoing = link.source_id === entry.id;
              const otherId = isOutgoing ? link.target_id : link.source_id;
              const direction = isOutgoing ? '\u2192' : '\u2190';
              return html`<div
                style="font-size:12px;color:#8b949e;padding:4px 0"
              >
                <span style="color:#f778ba">${link.link_type}</span>
                ${direction}
                <code>${otherId.slice(0, 8)}...</code>
              </div>`;
            })}
          </div>`
        : null}

      <div class="wiki-detail-id">ID: ${entry.id}</div>
    </div>
  `;
}

WikiDetail.observedAttributes = ['entry-id'] as const;

customElements.define(
  'wiki-detail',
  component<{ entryId: string }>(WikiDetail, { useShadowDOM: false }),
);
