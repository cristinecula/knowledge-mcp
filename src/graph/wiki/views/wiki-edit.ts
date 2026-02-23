// <wiki-edit> — form to edit an existing wiki page

import { component, html, useState, useEffect } from '@pionjs/pion';
import { navigate } from '@neovici/cosmoz-router';
import { fetchEntry, updateWikiEntry, type WikiEntry } from '../api.js';
import { slugify } from '../util.js';

function WikiEdit(this: HTMLElement & { entryId: string }) {
  const entryId = this.entryId;
  const [entry, setEntry] = useState<WikiEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [declaration, setDeclaration] = useState('');
  const [tags, setTags] = useState('');
  const [project, setProject] = useState('');
  const [scope, setScope] = useState('company');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    fetchEntry(entryId).then((data) => {
      if (cancelled) return;
      if (data && data.entry) {
        const e = data.entry;
        setEntry(e);
        setTitle(e.title);
        setDeclaration(e.declaration || '');
        setTags((e.tags || []).join(', '));
        setProject(e.project || '');
        setScope(e.scope);
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

  if (!entry) {
    return html`<div class="wiki-empty">Entry not found</div>`;
  }

  const handleSave = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      alert('Title is required');
      return;
    }
    setSaving(true);
    const result = await updateWikiEntry(entry.id, {
      title: trimmedTitle,
      declaration: declaration.trim() || null,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      project: project.trim() || null,
      scope,
    });
    if (result.entry) {
      navigate(
        `/wiki/${result.entry.id}/${slugify(result.entry.title)}`,
        null,
        { replace: false },
      );
    } else {
      alert('Failed to update wiki page');
      setSaving(false);
    }
  };

  return html`
    <div class="wiki-form">
      <h3 style="color:#f0f6fc;margin-bottom:8px">Edit Wiki Page</h3>

      <div class="wiki-form-group">
        <label>Title</label>
        <input
          type="text"
          .value=${title}
          @input=${(e: Event) =>
            setTitle((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="wiki-form-group">
        <label>Declaration</label>
        <textarea
          .value=${declaration}
          @input=${(e: Event) =>
            setDeclaration((e.target as HTMLTextAreaElement).value)}
        ></textarea>
        <div class="wiki-form-hint">
          Updating the declaration will re-mark this page for agent processing.
        </div>
      </div>

      <div class="wiki-form-group">
        <label>Tags</label>
        <input
          type="text"
          .value=${tags}
          @input=${(e: Event) =>
            setTags((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="wiki-form-group">
        <label>Project</label>
        <input
          type="text"
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
          <option value="company" ?selected=${scope === 'company'}>
            Company
          </option>
          <option value="project" ?selected=${scope === 'project'}>
            Project
          </option>
          <option value="repo" ?selected=${scope === 'repo'}>Repo</option>
        </select>
      </div>

      <div class="wiki-form-actions">
        <button
          class="wiki-btn"
          @click=${() =>
            navigate(
              `/wiki/${entry.id}/${slugify(entry.title)}`,
              null,
              { replace: false },
            )}
        >
          Cancel
        </button>
        <button
          class="wiki-btn wiki-btn-primary"
          ?disabled=${saving}
          @click=${handleSave}
        >
          ${saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  `;
}

WikiEdit.observedAttributes = ['entry-id'] as const;

customElements.define(
  'wiki-edit',
  component<{ entryId: string }>(WikiEdit, { useShadowDOM: false }),
);
