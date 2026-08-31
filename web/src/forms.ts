import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
} from '@snapping-turtle/shared/constants';
import type { CredentialsRequest } from '@snapping-turtle/shared/api';
import { describeError, ApiError } from './api.js';
import { el } from './dom.js';

export interface CredentialsFormOptions {
  heading: string;
  submitLabel: string;
  /** Extra hint under the password field (e.g. signup rules). */
  hint?: string;
  /** Link shown under the form, e.g. "Need an account? Sign up". */
  alternate?: { text: string; href: string; label: string };
  onSubmit: (creds: CredentialsRequest) => Promise<void>;
}

/** Username + password form shared by /login and /signup. */
export function credentialsForm(opts: CredentialsFormOptions): HTMLElement {
  const status = el('p', { className: 'status', attrs: { role: 'alert', 'aria-live': 'polite' } });
  const username = el('input', {
    attrs: {
      id: 'username',
      name: 'username',
      type: 'text',
      autocomplete: 'username',
      required: '',
      minlength: String(USERNAME_MIN_LENGTH),
      maxlength: String(USERNAME_MAX_LENGTH),
      pattern: USERNAME_PATTERN.replace(/^\^|\$$/g, ''),
      spellcheck: 'false',
      autocapitalize: 'none',
    },
  });
  const password = el('input', {
    attrs: {
      id: 'password',
      name: 'password',
      type: 'password',
      autocomplete: opts.heading.toLowerCase().includes('sign in')
        ? 'current-password'
        : 'new-password',
      required: '',
      minlength: String(PASSWORD_MIN_LENGTH),
      maxlength: String(PASSWORD_MAX_LENGTH),
    },
  });
  const submit = el('button', { text: opts.submitLabel, attrs: { type: 'submit' } });

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
      el('h1', { text: opts.heading }),
      el('label', { attrs: { for: 'username' } }, ['Username']),
      username,
      el('label', { attrs: { for: 'password' } }, ['Password']),
      password,
      ...(opts.hint ? [el('p', { className: 'hint', text: opts.hint })] : []),
      status,
      submit,
      ...(opts.alternate
        ? [
            el('p', { className: 'alternate' }, [
              `${opts.alternate.text} `,
              el('a', { text: opts.alternate.label, attrs: { href: opts.alternate.href } }),
            ]),
          ]
        : []),
    ],
  );

  async function run(): Promise<void> {
    status.textContent = '';
    status.className = 'status';
    if (!form.reportValidity()) return;
    submit.disabled = true;
    try {
      await opts.onSubmit({ username: username.value.trim(), password: password.value });
    } catch (err) {
      status.textContent = describeError(err);
      status.className = 'status error';
      if (err instanceof ApiError && err.status !== 429) password.value = '';
    } finally {
      submit.disabled = false;
    }
  }

  return form;
}
