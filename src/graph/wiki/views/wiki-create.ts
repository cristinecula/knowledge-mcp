// <wiki-create> — form to create a new wiki page

import { component, html, useState, useEffect } from '@pionjs/pion';
import { navigate } from '@neovici/cosmoz-router';
import { createWikiEntry, fetchWikiEntries, type WikiEntry } from '../api.js';
import { slugify } from '../util.js';

function WikiCreate() {
  const [title, setTitle] = useState('');
  const [declaration, setDeclaration] = useState('');
  const [tags, setTags] = useState('');
  const [project, setProject] = useState('');
  const [scope, setScope] = useState('company');
  const [parentPageId, setParentPageId] = useState<string | null>(null);
  const [allEntries, setAllEntries] = useState<WikiEntry[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchWikiEntries().then((entries) => {
      if (!cancelled) setAllEntries(entries);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      alert('Title is required');
      return;
    }
    setSaving(true);
    const result = await createWikiEntry({
      title: trimmedTitle,
      declaration: declaration.trim() || null,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      project: project.trim() || null,
      scope,
      parentPageId,
    });
    if (result.entry) {
      navigate(`/wiki/${result.entry.id}/${slugify(result.entry.title)}`, null, {
        replace: false,
      });
    } else {
      alert('Failed to create wiki page');
      setSaving(false);
    }
  };

  return html`
    <div class="wiki-form">
      <h3 style="color:#f0f6fc;margin-bottom:8px">New Wiki Page</h3>

      <div class="wiki-form-group">
        <label>Title *</label>
        <input
          type="text"
          placeholder="Page title"
          .value=${title}
          @input=${(e: Event) =>
            setTitle((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="wiki-form-group">
        <label>Declaration</label>
        <textarea
          placeholder="Describe what this page should contain. Agents will use this to generate the content."
          .value=${declaration}
          @input=${(e: Event) =>
            setDeclaration((e.target as HTMLTextAreaElement).value)}
        ></textarea>
        <div class="wiki-form-hint">
          This prompt tells agents what content to produce for this page.
        </div>
      </div>

      <div class="wiki-form-group">
        <label>Parent Page</label>
        <select
          @change=${(e: Event) => {
            const val = (e.target as HTMLSelectElement).value;
            setParentPageId(val || null);
          }}
        >
          <option value="">None (top-level)</option>
          ${allEntries.map(
            (entry) =>
              html`<option value=${entry.id}>${entry.title}</option>`,
          )}
        </select>
        <div class="wiki-form-hint">
          Place this page under another wiki page in the hierarchy.
        </div>
      </div>

      <div class="wiki-form-group">
        <label>Tags</label>
        <input
          type="text"
          placeholder="Comma-separated tags"
          .value=${tags}
          @input=${(e: Event) =>
            setTags((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="wiki-form-group">
        <label>Project</label>
        <input
          type="text"
          placeholder="Optional project name"
          .value=${project}
          @input=${(e: Event) =>
            setProject((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="wiki-form-group">
        <label>Scope</label>
        <select
          .value=${scope}
          @change=${(e: Event) =>
            setScope((e.target as HTMLSelectElement).value)}
        >
          <option value="company">Company</option>
          <option value="project">Project</option>
          <option value="repo">Repo</option>
        </select>
      </div>

      <div class="wiki-form-actions">
        <button
          class="wiki-btn"
          @click=${() => navigate('/wiki', null, { replace: false })}
        >
          Cancel
        </button>
        <button
          class="wiki-btn wiki-btn-primary"
          ?disabled=${saving}
          @click=${handleSave}
        >
          ${saving ? 'Creating...' : 'Create Page'}
        </button>
      </div>
    </div>
  `;
}

customElements.define(
  'wiki-create',
  component(WikiCreate, { useShadowDOM: false }),
);
