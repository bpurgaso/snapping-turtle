import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, USERNAME_PATTERN } from '@snapping-turtle/shared/constants';
import type {
  AdminCaptureSummary,
  AdminUserSummary,
  AuditEntry,
  GuardStatusResponse,
  IssuedLinkResponse,
  SessionInfo,
} from '@snapping-turtle/shared/api';
import { admin, currentSession, describeError } from './api.js';
import { copyText, el, flash, mount } from './dom.js';

/**
 * Admin panel (§11). The page is only a client: every check that matters is
 * enforced server-side (CLAUDE.md rule 8) — this script simply redirects
 * non-admins away. All text lands via textContent (rule 5); one-time link
 * URLs are rendered once, on issuance, and never fetched again.
 */

const root = document.getElementById('app');
if (root) void main(root);

async function main(root: HTMLElement): Promise<void> {
  const session = await currentSession();
  if (!session) {
    window.location.replace('/login');
    return;
  }
  if (session.role !== 'admin') {
    window.location.replace('/account');
    return;
  }
  await new AdminPage(root, session).render();
}

const fmt = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '—');

class AdminPage {
  private readonly status = el('p', {
    className: 'status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  private readonly registrationBox = el('section', { className: 'admin-registration' });
  private readonly usersBox = el('section', { className: 'admin-users' });
  private readonly linkReveal = el('section', { className: 'reveal', attrs: { hidden: '' } });
  private readonly capturesBox = el('section', { className: 'admin-captures' });
  private readonly auditBox = el('section', { className: 'admin-audit' });
  private readonly guardBox = el('section', { className: 'admin-guard' });
  private users: AdminUserSummary[] = [];
  private capturesUser: AdminUserSummary | null = null;
  private capturesPage = 1;
  private auditPage = 1;

  constructor(
    private readonly root: HTMLElement,
    private readonly session: SessionInfo,
  ) {}

  async render(): Promise<void> {
    mount(
      this.root,
      el('header', { className: 'account-header' }, [
        el('h1', { text: 'Admin' }),
        el('p', { className: 'whoami' }, [
          'Signed in as ',
          el('strong', { text: this.session.username }),
        ]),
        el('a', { text: 'Account', className: 'secondary', attrs: { href: '/account' } }),
      ]),
      this.status,
      this.registrationBox,
      el('section', {}, [el('h2', { text: 'Users' })]),
      this.linkReveal,
      this.usersBox,
      this.capturesBox,
      el('section', {}, [el('h2', { text: 'Guard' })]),
      this.guardBox,
      el('section', {}, [el('h2', { text: 'Audit log' })]),
      this.auditBox,
    );
    await Promise.all([
      this.refreshRegistration(),
      this.refreshUsers(),
      this.refreshGuard(),
      this.refreshAudit(),
    ]);
  }

  // ---- registration ---------------------------------------------------------

  private async refreshRegistration(): Promise<void> {
    try {
      const { enabled } = await admin.settings();
      const checkbox = el('input', {
        attrs: { type: 'checkbox', id: 'registration-toggle' },
        on: {
          change: () => {
            void this.run(async () => {
              const next = await admin.setRegistration(checkbox.checked, this.session.csrfToken);
              this.ok(`Registration is now ${next.enabled ? 'open' : 'closed'}.`);
            }, this.refreshRegistration.bind(this));
          },
        },
      });
      checkbox.checked = enabled;
      mount(
        this.registrationBox,
        el('h2', { text: 'Registration' }),
        el('label', { className: 'toggle', attrs: { for: 'registration-toggle' } }, [
          checkbox,
          ` Allow new signups (currently ${enabled ? 'open' : 'closed'})`,
        ]),
      );
    } catch (err) {
      this.fail(err);
    }
  }

  // ---- users ----------------------------------------------------------------

  private async refreshUsers(): Promise<void> {
    try {
      ({ users: this.users } = await admin.users());
      const nameInput = el('input', {
        attrs: {
          id: 'new-username',
          type: 'text',
          required: '',
          minlength: String(USERNAME_MIN_LENGTH),
          maxlength: String(USERNAME_MAX_LENGTH),
          pattern: USERNAME_PATTERN.replace(/^\^|\$$/g, ''),
          placeholder: 'username',
          spellcheck: 'false',
          autocapitalize: 'none',
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
              const username = nameInput.value.trim();
              if (!username) return;
              void this.run(async () => {
                const issued = await admin.createUser(username, this.session.csrfToken);
                nameInput.value = '';
                this.showLink('Account created', issued);
                this.ok(`User “${issued.username}” created — hand over the link below.`);
              }, this.refreshUsers.bind(this));
            },
          },
        },
        [
          el('label', { attrs: { for: 'new-username' } }, ['Create user']),
          nameInput,
          el('button', { text: 'Create + link', attrs: { type: 'submit' } }),
        ],
      );

      const table = el('table', {}, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'User' }),
            el('th', { text: 'Role' }),
            el('th', { text: 'Created' }),
            el('th', { text: 'Captures' }),
            el('th', { text: 'Status' }),
            el('th', { text: '' }),
          ]),
        ]),
        el('tbody', {}, this.users.map((u) => this.userRow(u))),
      ]);
      mount(
        this.usersBox,
        el('p', {
          className: 'hint',
          text: 'Accounts are handed out via one-time set-password links: create a user or reset a password, then send the link over any channel. Each link works once and expires after 24 hours.',
        }),
        createForm,
        table,
      );
    } catch (err) {
      this.fail(err);
    }
  }

  private userRow(u: AdminUserSummary): HTMLElement {
    const self = u.username === this.session.username;
    const actions: Array<Node | string> = [
      el('button', {
        text: 'Reset password',
        className: 'secondary',
        attrs: { type: 'button' },
        on: {
          click: () => {
            void this.run(async () => {
              const issued = await admin.resetLink(u.id, this.session.csrfToken);
              this.showLink('Password reset', issued);
              this.ok(`Reset link for “${issued.username}” issued — shown once, below.`);
            });
          },
        },
      }),
      ' ',
      el('button', {
        text: 'Captures',
        className: 'secondary',
        attrs: { type: 'button' },
        on: {
          click: () => {
            this.capturesUser = u;
            this.capturesPage = 1;
            void this.refreshCaptures();
          },
        },
      }),
    ];
    if (!self) {
      actions.push(
        ' ',
        u.disabledAt
          ? el('button', {
              text: 'Enable',
              attrs: { type: 'button' },
              on: {
                click: () => {
                  void this.run(async () => {
                    await admin.enableUser(u.id, this.session.csrfToken);
                    this.ok(`User “${u.username}” enabled.`);
                  }, this.refreshUsers.bind(this));
                },
              },
            })
          : el('button', {
              text: 'Disable',
              className: 'danger',
              attrs: { type: 'button' },
              on: {
                click: () => {
                  if (
                    !window.confirm(
                      `Disable “${u.username}”? Their sessions end immediately and their tokens stop working.`,
                    )
                  ) {
                    return;
                  }
                  void this.run(async () => {
                    await admin.disableUser(u.id, this.session.csrfToken);
                    this.ok(`User “${u.username}” disabled.`);
                  }, this.refreshUsers.bind(this));
                },
              },
            }),
      );
    }
    return el('tr', { className: u.disabledAt ? 'revoked' : '' }, [
      el('td', { text: u.username }),
      el('td', { text: u.role }),
      el('td', { text: fmt(u.createdAt) }),
      el('td', { text: String(u.captureCount) }),
      el('td', { text: u.disabledAt ? `disabled ${fmt(u.disabledAt)}` : 'active' }),
      el('td', {}, actions),
    ]);
  }

  /** One-time link reveal (§11): rendered once; never retrievable again. */
  private showLink(heading: string, issued: IssuedLinkResponse): void {
    const field = el('input', {
      className: 'secret',
      attrs: { type: 'text', readonly: '', value: issued.resetUrl, 'aria-label': 'one-time link' },
    });
    const copyBtn = el('button', {
      text: 'Copy link',
      attrs: { type: 'button' },
      on: {
        click: async (ev) => {
          const ok = await copyText(issued.resetUrl, field);
          flash(ev.currentTarget as HTMLButtonElement, ok ? 'Copied' : 'Select & copy');
        },
      },
    });
    mount(
      this.linkReveal,
      el('h3', { text: `${heading}: ${issued.username}` }),
      el('p', {
        className: 'warning',
        text: `Copy this link now — it will not be shown again. It works once and expires ${fmt(issued.expiresAt)}.`,
      }),
      el('div', { className: 'secret-row' }, [field, copyBtn]),
      el('button', {
        text: 'Done — hide link',
        className: 'secondary',
        attrs: { type: 'button' },
        on: {
          click: () => {
            this.linkReveal.hidden = true;
            mount(this.linkReveal);
          },
        },
      }),
    );
    this.linkReveal.hidden = false;
  }

  // ---- captures -------------------------------------------------------------

  private async refreshCaptures(): Promise<void> {
    const user = this.capturesUser;
    if (!user) return;
    try {
      const res = await admin.captures(user.id, this.capturesPage);
      const rows = res.captures.map((c) => this.captureRow(c));
      const pages = Math.max(1, Math.ceil(res.total / res.pageSize));
      mount(
        this.capturesBox,
        el('h2', { text: `Captures — ${user.username}` }),
        el('p', { className: 'hint', text: `${res.total} capture${res.total === 1 ? '' : 's'} (tombstones included).` }),
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Capture' }),
              el('th', { text: 'Created' }),
              el('th', { text: 'Retention' }),
              el('th', { text: 'Keep indefinitely' }),
              el('th', { text: '' }),
            ]),
          ]),
          el('tbody', {}, rows),
        ]),
        this.pager(res.page, pages, (p) => {
          this.capturesPage = p;
          void this.refreshCaptures();
        }),
      );
    } catch (err) {
      this.fail(err);
    }
  }

  private captureRow(c: AdminCaptureSummary): HTMLElement {
    const deleted = c.deletedAt !== null;
    const indefinite = el('input', {
      attrs: { type: 'checkbox', 'aria-label': 'keep indefinitely' },
      on: {
        change: () => {
          void this.run(async () => {
            await admin.setIndefinite(c.id, indefinite.checked, this.session.csrfToken);
            this.ok(
              indefinite.checked
                ? 'Capture kept indefinitely.'
                : 'Capture back on the default retention window.',
            );
          }, this.refreshCaptures.bind(this));
        },
      },
    });
    indefinite.checked = c.retentionUntil === null;
    if (deleted) indefinite.disabled = true;
    return el('tr', { className: deleted ? 'revoked' : '' }, [
      el('td', {}, [
        deleted
          ? el('span', { text: c.pageTitle || 'capture' })
          : el('a', {
              text: c.pageTitle || 'capture',
              attrs: { href: c.pageUrl, target: '_blank', rel: 'noopener noreferrer' },
            }),
        el('span', { className: 'hint', text: ` ${c.width}×${c.height}` }),
      ]),
      el('td', { text: fmt(c.createdAt) }),
      el('td', {
        text: deleted
          ? `deleted ${fmt(c.deletedAt)}`
          : c.retentionUntil === null
            ? 'indefinite'
            : `until ${fmt(c.retentionUntil)}`,
      }),
      el('td', {}, [indefinite]),
      el('td', {}, [
        deleted
          ? ''
          : el('button', {
              text: 'Delete',
              className: 'danger',
              attrs: { type: 'button' },
              on: {
                click: () => {
                  if (!window.confirm('Delete this capture? The image is removed immediately.')) {
                    return;
                  }
                  void this.run(async () => {
                    await admin.deleteCapture(c.id, this.session.csrfToken);
                    this.ok('Capture deleted.');
                  }, this.refreshCaptures.bind(this));
                },
              },
            }),
      ]),
    ]);
  }

  // ---- guard ----------------------------------------------------------------

  private async refreshGuard(): Promise<void> {
    try {
      const res: GuardStatusResponse = await admin.guard();
      const active = res.bans.filter((b) => b.active);
      const breakerLine =
        res.breaker.state === 'open'
          ? `open — anonymous secret-link traffic is refused for another ${res.breaker.retryAfterSeconds ?? '?'} s`
          : res.breaker.state === 'half_open'
            ? 'half-open — probing recovery'
            : 'closed — normal service';
      mount(
        this.guardBox,
        el('p', {}, [el('strong', { text: 'Breaker: ' }), breakerLine]),
        active.length === 0
          ? el('p', { className: 'empty', text: 'No active bans.' })
          : el('table', {}, [
              el('thead', {}, [
                el('tr', {}, [
                  el('th', { text: 'IP / prefix' }),
                  el('th', { text: 'Strikes' }),
                  el('th', { text: 'Banned until' }),
                  el('th', { text: 'Reason' }),
                  el('th', { text: '' }),
                ]),
              ]),
              el(
                'tbody',
                {},
                active.map((b) =>
                  el('tr', {}, [
                    el('td', { text: b.ipPrefix }),
                    el('td', { text: String(b.strikes) }),
                    el('td', { text: fmt(b.bannedUntil) }),
                    el('td', { text: b.reason }),
                    el('td', {}, [
                      el('button', {
                        text: 'Unban',
                        className: 'secondary',
                        attrs: { type: 'button' },
                        on: {
                          click: () => {
                            void this.run(async () => {
                              await admin.unban(b.ipPrefix, this.session.csrfToken);
                              this.ok(`Unbanned ${b.ipPrefix}.`);
                            }, this.refreshGuard.bind(this));
                          },
                        },
                      }),
                    ]),
                  ]),
                ),
              ),
            ]),
        el('button', {
          text: 'Refresh',
          className: 'secondary',
          attrs: { type: 'button' },
          on: { click: () => void this.refreshGuard() },
        }),
      );
    } catch (err) {
      this.fail(err);
    }
  }

  // ---- audit ----------------------------------------------------------------

  private async refreshAudit(): Promise<void> {
    try {
      const res = await admin.audit(this.auditPage);
      const pages = Math.max(1, Math.ceil(res.total / res.pageSize));
      mount(
        this.auditBox,
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'When' }),
              el('th', { text: 'Actor' }),
              el('th', { text: 'Action' }),
              el('th', { text: 'Target' }),
              el('th', { text: 'Detail' }),
              el('th', { text: 'IP' }),
            ]),
          ]),
          el(
            'tbody',
            {},
            res.entries.map((e: AuditEntry) =>
              el('tr', {}, [
                el('td', { text: fmt(e.at) }),
                el('td', { text: e.actor ?? `#${e.actorUserId}` }),
                el('td', { text: e.action }),
                el('td', {
                  text: e.targetId === null ? e.targetType : `${e.targetType} #${e.targetId}`,
                }),
                el('td', { className: 'detail', text: JSON.stringify(e.detail) }),
                el('td', { text: e.ip }),
              ]),
            ),
          ),
        ]),
        this.pager(res.page, pages, (p) => {
          this.auditPage = p;
          void this.refreshAudit();
        }),
      );
    } catch (err) {
      this.fail(err);
    }
  }

  // ---- plumbing -------------------------------------------------------------

  private pager(page: number, pages: number, go: (page: number) => void): HTMLElement {
    return el('p', { className: 'pager' }, [
      el('button', {
        text: '← Newer',
        className: 'secondary',
        attrs: { type: 'button', ...(page <= 1 ? { disabled: '' } : {}) },
        on: { click: () => go(page - 1) },
      }),
      ` page ${page} of ${pages} `,
      el('button', {
        text: 'Older →',
        className: 'secondary',
        attrs: { type: 'button', ...(page >= pages ? { disabled: '' } : {}) },
        on: { click: () => go(page + 1) },
      }),
    ]);
  }

  /** Run a mutation, surface errors, then refresh whatever it touched. */
  private async run(action: () => Promise<void>, refresh?: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.fail(err);
    } finally {
      await refresh?.().catch(() => undefined);
      // Any mutation lands in the audit log; keep that view current too.
      await this.refreshAudit().catch(() => undefined);
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
