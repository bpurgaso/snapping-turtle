import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@snapping-turtle/shared/constants';
import { auth, describeError } from './api.js';
import { el, mount } from './dom.js';

/**
 * Set-password page served at /reset/:token (§11). The server only serves
 * this page for a live link; the token itself comes from the URL and goes
 * straight to the API — it is never rendered into the page or logged.
 */

const root = document.getElementById('app');
if (root) {
  const token = window.location.pathname.split('/')[2] ?? '';
  mount(root, buildForm(token));
}

function buildForm(token: string): HTMLElement {
  const status = el('p', { className: 'status', attrs: { role: 'alert', 'aria-live': 'polite' } });
  const password = el('input', {
    attrs: {
      id: 'password',
      name: 'password',
      type: 'password',
      autocomplete: 'new-password',
      required: '',
      minlength: String(PASSWORD_MIN_LENGTH),
      maxlength: String(PASSWORD_MAX_LENGTH),
    },
  });
  const confirm = el('input', {
    attrs: {
      id: 'confirm',
      name: 'confirm',
      type: 'password',
      autocomplete: 'new-password',
      required: '',
      minlength: String(PASSWORD_MIN_LENGTH),
      maxlength: String(PASSWORD_MAX_LENGTH),
    },
  });
  const submit = el('button', { text: 'Set password', attrs: { type: 'submit' } });

  const form = el(
    'form',
    {
      className: 'credentials',
      attrs: { method: 'post', action: '#', novalidate: '' },
      on: {
        submit: (ev) => {
          ev.preventDefault();
          void run();
        },
      },
    },
    [
      el('h1', { text: 'Set your password' }),
      el('p', {
        className: 'hint',
        text: 'This link works once. After you set a password you will be signed in.',
      }),
      el('label', { attrs: { for: 'password' } }, ['New password']),
      password,
      el('label', { attrs: { for: 'confirm' } }, ['Repeat password']),
      confirm,
      el('p', {
        className: 'hint',
        text: `At least ${PASSWORD_MIN_LENGTH} characters.`,
      }),
      status,
      submit,
    ],
  );

  async function run(): Promise<void> {
    status.textContent = '';
    status.className = 'status';
    if (!form.reportValidity()) return;
    if (password.value !== confirm.value) {
      status.textContent = 'Passwords do not match.';
      status.className = 'status error';
      return;
    }
    submit.disabled = true;
    try {
      await auth.setPassword({ token, password: password.value });
      window.location.replace('/account');
    } catch (err) {
      status.textContent = describeError(err);
      status.className = 'status error';
      submit.disabled = false;
    }
  }

  return form;
}
