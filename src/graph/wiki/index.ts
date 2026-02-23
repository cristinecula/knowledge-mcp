// Wiki SPA entry point — defines <wiki-shell> with sidebar + content layout

import { component, html, useState } from '@pionjs/pion';
import { useRouter, navigate, href } from '@neovici/cosmoz-router';

// Side-effect imports: register child custom elements
import './sidebar.js';
import './views/wiki-list.js';
import './views/wiki-detail.js';
import './views/wiki-create.js';
import './views/wiki-edit.js';

const routes = [
  {
    rule: href(/^\/wiki\/new$/),
    handle: () => ({ view: html`<wiki-create></wiki-create>`, activeId: null }),
  },
  {
    rule: href(/^\/wiki\/(?<id>[0-9a-f-]{36})\/edit$/),
    handle: ({ match }: { match: { result: RegExpMatchArray } }) => {
      const id = match.result.groups!.id;
      return {
        view: html`<wiki-edit .entryId=${id}></wiki-edit>`,
        activeId: id,
      };
    },
  },
  {
    rule: href(/^\/wiki\/(?<id>[0-9a-f-]{36})(?:\/[^/]*)?$/),
    handle: ({ match }: { match: { result: RegExpMatchArray } }) => {
      const id = match.result.groups!.id;
      return {
        view: html`<wiki-detail .entryId=${id}></wiki-detail>`,
        activeId: id,
      };
    },
  },
  {
    rule: href(/^\/wiki\/?$/),
    handle: () => ({
      view: html`<wiki-list></wiki-list>`,
      activeId: null,
    }),
  },
];

function WikiShell() {
  const { result } = useRouter(routes as any);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const r = result as any;
  const activeId = r?.activeId ?? null;
  const view = r?.view ?? html`<wiki-list></wiki-list>`;

  const toggleSidebar = () => setSidebarOpen(!sidebarOpen);
  const closeSidebar = () => setSidebarOpen(false);

  return html`
    <div class="wiki-shell">
      <!-- Mobile header -->
      <div class="wiki-mobile-header">
        <button class="wiki-mobile-menu-btn" @click=${toggleSidebar}>
          &#9776;
        </button>
        <span class="wiki-mobile-title">Wiki</span>
      </div>

      <!-- Sidebar overlay (mobile) -->
      <div
        class="wiki-sidebar-overlay ${sidebarOpen ? 'visible' : ''}"
        @click=${closeSidebar}
      ></div>

      <!-- Sidebar -->
      <aside class="wiki-sidebar ${sidebarOpen ? 'open' : ''}">
        <wiki-sidebar .activeId=${activeId}></wiki-sidebar>
      </aside>

      <!-- Main content -->
      <main class="wiki-main" @click=${closeSidebar}>${view}</main>
    </div>
  `;
}

customElements.define(
  'wiki-shell',
  component(WikiShell, { useShadowDOM: false }),
);
