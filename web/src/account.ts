import { MAX_TOKEN_NAME_LENGTH } from '@snapping-turtle/shared/constants';
import type { SessionInfo, TokenSummary } from '@snapping-turtle/shared/api';
import { auth, currentSession, describeError, tokens } from './api.js';
import { copyText, el, flash, mount } from './dom.js';

/**
 * Account page (§11): who you are, your API tokens (create / revoke), and a
 * ready-to-paste upload example for the token you just created. The token
 * plaintext exists only in this page's memory after creation.
 */

const root = document.getElementById('app');
if (root) void main(root);

async function main(root: HTMLElement): Promise<void> {
  const session = await currentSession();
  if (!session) {
    window.location.replace('/login');
    return;
  }
  const page = new AccountPage(root, session);
  await page.render();
}

const fmt = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : 'never');

class AccountPage {
  private readonly status = el('p', {
    className: 'status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  private readonly list = el('div', { className: 'tokens' });
  private readonly reveal = el('section', { className: 'reveal', attrs: { hidden: '' } });

  constructor(
    private readonly root: HTMLElement,
    private readonly session: SessionInfo,
  ) {}

  async render(): Promise<void> {
    const nameInput = el('input', {
      attrs: {
        id: 'token-name',
        name: 'name',
        type: 'text',
        required: '',
        maxlength: String(MAX_TOKEN_NAME_LENGTH),
        placeholder: 'e.g. work laptop',
      },
    });
    const createForm = el(
      'form',
      {
        className: 'create-token',
        attrs: { action: '#', method: 'post' },
        on: {
          submit: (ev) => {
            ev.preventDefault();
            void this.create(nameInput);
          },
        },
      },
      [
        el('label', { attrs: { for: 'token-name' } }, ['New token name']),
        nameInput,
        el('button', { text: 'Create token', attrs: { type: 'submit' } }),
      ],
    );

    mount(
      this.root,
      el('header', { className: 'account-header' }, [
        el('h1', { text: 'Account' }),
        el('p', { className: 'whoami' }, [
          'Signed in as ',
          el('strong', { text: this.session.username }),
          this.session.role === 'admin' ? ' (admin)' : '',
        ]),
        el('button', {
          text: 'Sign out',
          className: 'secondary',
          attrs: { type: 'button' },
          on: { click: () => void this.logout() },
        }),
      ]),
      this.status,
      el('section', { className: 'tokens-section' }, [
        el('h2', { text: 'API tokens' }),
        el('p', {
          className: 'hint',
          text: 'The browser extension and any other uploader authenticate with one of these. Each token is shown once when created and can be revoked at any time.',
        }),
        createForm,
        this.reveal,
        this.list,
      ]),
    );
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const { tokens: rows } = await tokens.list();
      this.renderList(rows);
    } catch (err) {
      this.fail(err);
    }
  }

  private renderList(rows: TokenSummary[]): void {
    if (rows.length === 0) {
      mount(this.list, el('p', { className: 'empty', text: 'No tokens yet.' }));
      return;
    }
    const table = el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Name' }),
          el('th', { text: 'Created' }),
          el('th', { text: 'Last used' }),
          el('th', { text: 'Status' }),
          el('th', { text: '' }),
        ]),
      ]),
      el(
        'tbody',
        {},
        rows.map((t) =>
          el('tr', { className: t.revokedAt ? 'revoked' : '' }, [
            el('td', { text: t.name }),
            el('td', { text: fmt(t.createdAt) }),
            el('td', { text: fmt(t.lastUsedAt) }),
            el('td', { text: t.revokedAt ? `revoked ${fmt(t.revokedAt)}` : 'active' }),
            el('td', {}, [
              t.revokedAt
                ? ''
                : el('button', {
                    text: 'Revoke',
                    className: 'danger',
                    attrs: { type: 'button' },
                    on: { click: () => void this.revoke(t) },
                  }),
            ]),
          ]),
        ),
      ),
    ]);
    mount(this.list, table);
  }

  private async create(nameInput: HTMLInputElement): Promise<void> {
    const name = nameInput.value.trim();
    if (!name) return;
    try {
      const created = await tokens.create({ name }, this.session.csrfToken);
      nameInput.value = '';
      this.showReveal(created.name, created.token);
      this.ok(`Token “${created.name}” created.`);
      await this.refresh();
    } catch (err) {
      this.fail(err);
    }
  }

  private showReveal(name: string, token: string): void {
    const tokenField = el('input', {
      className: 'secret',
      attrs: { type: 'text', readonly: '', value: token, 'aria-label': 'API token' },
    });
    const copyBtn = el('button', {
      text: 'Copy token',
      attrs: { type: 'button' },
      on: {
        click: async (ev) => {
          const ok = await copyText(token, tokenField);
          flash(ev.currentTarget as HTMLButtonElement, ok ? 'Copied' : 'Select & copy');
        },
      },
    });
    const origin = window.location.origin;
    const curl = [
      `curl -sS -X POST ${origin}/api/v1/captures \\`,
      `  -H "Authorization: Bearer ${token}" \\`,
      `  -F "image=@screenshot.png" \\`,
      `  -F "sourceUrl=https://example.com/page" \\`,
      `  -F "title=Example page"`,
    ].join('\n');
    const curlField = el('textarea', {
      className: 'curl',
      attrs: { readonly: '', rows: '5', 'aria-label': 'curl upload example' },
    });
    curlField.value = curl;

    mount(
      this.reveal,
      el('h3', { text: `Token “${name}”` }),
      el('p', {
        className: 'warning',
        text: 'Copy it now — it will not be shown again. Paste it into the extension options, or upload from a terminal:',
      }),
      el('div', { className: 'secret-row' }, [tokenField, copyBtn]),
      curlField,
      el('button', {
        text: 'Done — hide token',
        className: 'secondary',
        attrs: { type: 'button' },
        on: {
          click: () => {
            this.reveal.hidden = true;
            mount(this.reveal);
          },
        },
      }),
    );
    this.reveal.hidden = false;
  }

  private async revoke(t: TokenSummary): Promise<void> {
    if (!window.confirm(`Revoke token “${t.name}”? Anything using it stops working immediately.`)) {
      return;
    }
    try {
      await tokens.revoke(t.id, this.session.csrfToken);
      this.ok(`Token “${t.name}” revoked.`);
      await this.refresh();
    } catch (err) {
      this.fail(err);
    }
  }

  private async logout(): Promise<void> {
    try {
      await auth.logout(this.session.csrfToken);
    } finally {
      window.location.replace('/login');
    }
  }

  private ok(message: string): void {
    this.status.textContent = message;
    this.status.className = 'status';
  }

  private fail(err: unknown): void {
    this.status.textContent = describeError(err);
    this.status.className = 'status error';
  }
}
