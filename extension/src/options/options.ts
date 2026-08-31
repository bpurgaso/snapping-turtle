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
 */

const root = document.getElementById('options');
if (root) void init(root);

type Tone = 'info' | 'ok' | 'error';

async function init(main: HTMLElement): Promise<void> {
  const heading = document.createElement('h1');
  heading.textContent = 'snapping-turtle settings';
  main.append(heading);

  const form = document.createElement('form');
  form.noValidate = true;
  main.append(form);

  const originInput = field(form, 'origin', 'Server address', 'url', {
    placeholder: 'https://shots.example.com',
    hint: `Default for this build: ${DEFAULT_SERVER_ORIGIN}. https only, except localhost / 127.0.0.1.`,
  });
  const tokenInput = field(form, 'token', 'API token', 'password', {
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
  form.append(accountRow);

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
  form.append(actions);

  const status = document.createElement('p');
  status.id = 'status';
  status.className = 'status';
  status.setAttribute('role', 'status');
  form.append(status);

  const show = (message: string, tone: Tone = 'info') => {
    status.textContent = message;
    status.className = `status ${tone}`;
  };

  const syncAccountLink = () => {
    const parsed = parseServerOrigin(originInput.value);
    accountLink.hidden = !parsed.ok;
    if (parsed.ok) accountLink.href = `${parsed.origin}/account`;
  };
  originInput.addEventListener('input', syncAccountLink);

  const settings = await loadSettings();
  originInput.value = settings.serverOrigin;
  tokenInput.value = settings.apiToken;
  syncAccountLink();

  /** Validate the form; on failure report and return null. Pure — safe before permissions.request. */
  const readForm = (): { origin: string; token: string } | null => {
    const parsed = parseServerOrigin(originInput.value);
    if (!parsed.ok) {
      show(parsed.reason, 'error');
      originInput.focus();
      return null;
    }
    const token = tokenInput.value.trim();
    if (!token || /\s/.test(token)) {
      show('Paste the API token from your account page (a single line, no spaces).', 'error');
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
      show(`Could not request access to ${origin}: ${why}.${httpHint} Nothing was saved.`, 'error');
      return false;
    }
    if (!granted) {
      show(
        `Access to ${origin} was not granted, so nothing was saved. The extension needs permission for that site to upload captures — try again and allow it.`,
        'error',
      );
    }
    return granted;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = readForm();
    if (!values) return;
    void (async () => {
      if (!(await ensureAccess(values.origin))) return;
      await saveSettings({ serverOrigin: values.origin, apiToken: values.token });
      originInput.value = values.origin;
      syncAccountLink();
      show(`Saved. Captures will upload to ${values.origin}.`, 'ok');
    })();
  });

  testButton.addEventListener('click', () => {
    const values = readForm();
    if (!values) return;
    void (async () => {
      if (!(await ensureAccess(values.origin))) return;
      testButton.disabled = true;
      show(`Contacting ${values.origin}…`);
      try {
        const outcome = await pingServer(values.origin, values.token);
        if (outcome.kind === 'ok') show('Connected: the server accepted this token.', 'ok');
        else if (outcome.kind === 'unauthorized') {
          show(
            'The server rejected this token. Create a new one on your account page and paste it here.',
            'error',
          );
        } else show(outcome.message, 'error');
      } finally {
        testButton.disabled = false;
      }
    })();
  });
}

function field(
  form: HTMLFormElement,
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
  form.append(wrapper);
  return input;
}
