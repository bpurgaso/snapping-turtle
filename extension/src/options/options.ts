import browser from 'webextension-polyfill';
import { pingServer } from '../lib/api.js';
import { hostPattern, parseServerOrigin } from '../lib/origin.js';
import {
  BROWSER_TARGET,
  DEFAULT_SERVER_ORIGIN,
  loadSettings,
  saveSettings,
} from '../lib/settings.js';

/**
 * Options page (PLAN.md §15): server origin (pre-filled from the build-time
 * PUBLIC_ORIGIN), API token (storage.local only), Test connection.
 *
 * Saving or testing a server first asks for host permission on exactly that
 * origin. Chrome grants the built-in default silently; Firefox treats every
 * MV3 host permission as optional and prompts once; a custom domain prompts
 * on both. A refusal leaves the settings untouched and says so. The
 * permissions.request call is the first await in each click handler so the
 * user gesture is still live when it runs.
 *
 * Lifecycle is observable through `data-state` on the root `<main>` so tests
 * (and anyone debugging) can wait on real transitions instead of sleeping:
 *
 *   loading → ready → saving → saved | error
 *                   → testing → connected | error
 *
 * Until `ready` the form is disabled — the handlers are attached before the
 * stored settings are awaited, so nothing a user does early can fall through
 * to a native form submission or be overwritten by the late prefill.
 */

export type OptionsState =
  | 'loading'
  | 'ready'
  | 'saving'
  | 'saved'
  | 'testing'
  | 'connected'
  | 'error';

const root = document.getElementById('options');
if (root) void init(root);

type Tone = 'info' | 'ok' | 'error';

async function init(main: HTMLElement): Promise<void> {
  const setState = (state: OptionsState) => {
    main.dataset['state'] = state;
  };
  setState('loading');

  const heading = document.createElement('h1');
  heading.textContent = 'snapping-turtle settings';
  main.append(heading);

  const form = document.createElement('form');
  form.noValidate = true;
  main.append(form);

  // Everything interactive sits in one fieldset, disabled until the stored
  // settings are in the inputs (see the lifecycle note above).
  const fields = document.createElement('fieldset');
  fields.disabled = true;
  form.append(fields);

  const originInput = field(fields, 'origin', 'Server address', 'url', {
    placeholder: 'https://shots.example.com',
    hint: `Default for this build: ${DEFAULT_SERVER_ORIGIN}. https only, except localhost / 127.0.0.1.`,
  });
  const tokenInput = field(fields, 'token', 'API token', 'password', {
    placeholder: 'st_…',
    hint: 'Create one on your account page; it is stored only in this browser (storage.local).',
    autocomplete: 'off',
  });

  const accountLink = document.createElement('a');
  accountLink.textContent = 'Open account page';
  accountLink.target = '_blank';
  accountLink.rel = 'noopener noreferrer';
  accountLink.className = 'account-link';
  const accountRow = document.createElement('p');
  accountRow.className = 'hint';
  accountRow.append(accountLink);
  fields.append(accountRow);

  const showToggle = document.createElement('button');
  showToggle.type = 'button';
  showToggle.className = 'link';
  showToggle.textContent = 'Show token';
  showToggle.addEventListener('click', () => {
    const hidden = tokenInput.type === 'password';
    tokenInput.type = hidden ? 'text' : 'password';
    showToggle.textContent = hidden ? 'Hide token' : 'Show token';
  });
  tokenInput.insertAdjacentElement('afterend', showToggle);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.textContent = 'Save';
  const testButton = document.createElement('button');
  testButton.type = 'button';
  testButton.textContent = 'Test connection';
  actions.append(saveButton, testButton);
  fields.append(actions);

  const status = document.createElement('p');
  status.id = 'status';
  status.className = 'status';
  status.setAttribute('role', 'status');
  form.append(status);

  const show = (message: string, tone: Tone = 'info') => {
    status.textContent = message;
    status.className = `status ${tone}`;
  };
  const fail = (message: string) => {
    show(message, 'error');
    setState('error');
  };

  const syncAccountLink = () => {
    const parsed = parseServerOrigin(originInput.value);
    accountLink.hidden = !parsed.ok;
    if (parsed.ok) accountLink.href = `${parsed.origin}/account`;
  };
  originInput.addEventListener('input', syncAccountLink);

  /** Validate the form; on failure report and return null. Pure — safe before permissions.request. */
  const readForm = (): { origin: string; token: string } | null => {
    const parsed = parseServerOrigin(originInput.value);
    if (!parsed.ok) {
      fail(parsed.reason);
      originInput.focus();
      return null;
    }
    const token = tokenInput.value.trim();
    if (!token || /\s/.test(token)) {
      fail('Paste the API token from your account page (a single line, no spaces).');
      tokenInput.focus();
      return null;
    }
    return { origin: parsed.origin, token };
  };

  /** Ask for host permission on exactly this origin; false = not granted (nothing saved). */
  const ensureAccess = async (origin: string): Promise<boolean> => {
    let granted: boolean;
    try {
      granted = await browser.permissions.request({
        origins: [hostPattern(origin, BROWSER_TARGET)],
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const httpHint = origin.startsWith('http:')
        ? ' Browsers only allow https servers to be added after install; for a plain-http local server, rebuild the extension with PUBLIC_ORIGIN set to it.'
        : '';
      fail(`Could not request access to ${origin}: ${why}.${httpHint} Nothing was saved.`);
      return false;
    }
    if (!granted) {
      fail(
        `Access to ${origin} was not granted, so nothing was saved. The extension needs permission for that site to upload captures — try again and allow it.`,
      );
    }
    return granted;
  };

  // Handlers go on before anything is awaited: a submit can never reach the
  // browser's native form submission (which would put the token in a URL).
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = readForm();
    if (!values) return;
    setState('saving');
    void (async () => {
      if (!(await ensureAccess(values.origin))) return;
      await saveSettings({ serverOrigin: values.origin, apiToken: values.token });
      originInput.value = values.origin;
      syncAccountLink();
      show(`Saved. Captures will upload to ${values.origin}.`, 'ok');
      setState('saved');
    })();
  });

  testButton.addEventListener('click', () => {
    const values = readForm();
    if (!values) return;
    setState('testing');
    void (async () => {
      if (!(await ensureAccess(values.origin))) return;
      testButton.disabled = true;
      show(`Contacting ${values.origin}…`);
      try {
        const outcome = await pingServer(values.origin, values.token);
        if (outcome.kind === 'ok') {
          show('Connected: the server accepted this token.', 'ok');
          setState('connected');
        } else if (outcome.kind === 'unauthorized') {
          fail(
            'The server rejected this token. Create a new one on your account page and paste it here.',
          );
        } else fail(outcome.message);
      } finally {
        testButton.disabled = false;
      }
    })();
  });

  let settings;
  try {
    settings = await loadSettings();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    fail(`Could not read the stored settings: ${why}. Reload this page to try again.`);
    return;
  }
  originInput.value = settings.serverOrigin;
  tokenInput.value = settings.apiToken;
  syncAccountLink();
  fields.disabled = false;
  setState('ready');
}

function field(
  parent: HTMLElement,
  id: string,
  labelText: string,
  type: string,
  opts: { placeholder: string; hint: string; autocomplete?: string },
): HTMLInputElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  const input = document.createElement('input');
  input.id = id;
  input.name = id;
  input.type = type;
  input.placeholder = opts.placeholder;
  input.spellcheck = false;
  input.autocomplete = (opts.autocomplete ?? 'off') as AutoFill;
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.id = `${id}-hint`;
  hint.textContent = opts.hint;
  input.setAttribute('aria-describedby', hint.id);
  wrapper.append(label, input, hint);
  parent.append(wrapper);
  return input;
}
