// Wiki SPA entry point — defines <wiki-shell> with client-side routing

import { component, html } from '@pionjs/pion';
import { useRouter, navigate, href } from '@neovici/cosmoz-router';

// Side-effect imports: register child custom elements
import './views/wiki-list.js';
import './views/wiki-detail.js';
import './views/wiki-create.js';
import './views/wiki-edit.js';

const routes = [
  {
    rule: href(/^\/wiki\/new$/),
    handle: () => html`<wiki-create></wiki-create>`,
  },
  {
    rule: href(/^\/wiki\/(?<id>[0-9a-f-]{36})\/edit$/),
    handle: ({ match }: { match: { result: RegExpMatchArray } }) => {
      const id = match.result.groups!.id;
      return html`<wiki-edit .entryId=${id}></wiki-edit>`;
    },
  },
  {
    rule: href(/^\/wiki\/(?<id>[0-9a-f-]{36})(?:\/[^/]*)?$/),
    handle: ({ match }: { match: { result: RegExpMatchArray } }) => {
      const id = match.result.groups!.id;
      return html`<wiki-detail .entryId=${id}></wiki-detail>`;
    },
  },
  {
    rule: href(/^\/wiki\/?$/),
    handle: () => html`<wiki-list></wiki-list>`,
  },
];

function WikiShell() {
  const { result } = useRouter(routes);

  return html`
    <div class="wiki-layout">
      <div class="wiki-header">
        <h1>Wiki</h1>
        <div class="wiki-header-actions">
          <a href="/" class="wiki-btn">Graph</a>
          <button
            class="wiki-btn wiki-btn-primary"
            @click=${() => navigate('/wiki/new', null, { replace: false })}
          >
            New Page
          </button>
        </div>
      </div>
      ${result ?? html`<wiki-list></wiki-list>`}
    </div>
  `;
}

customElements.define(
  'wiki-shell',
  component(WikiShell, { useShadowDOM: false }),
);
