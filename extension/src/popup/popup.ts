import browser from 'webextension-polyfill';
import { clearFailureFlag, readLastError } from '../lib/failure-flag.js';
import { describeLastError } from '../lib/last-error.js';
import {
  CAPTURE_MODES,
  type CaptureMode,
  type CaptureRequest,
  type CaptureResponse,
} from '../lib/messages.js';
import { restrictedReason } from '../lib/restricted.js';
import { loadSettings } from '../lib/settings.js';

/**
 * Toolbar popup (PLAN.md §15): Visible / Region / Full page, all live since
 * M6, with the last-used mode outlined. Visible waits for the upload and
 * reports inline; Region and Full page close the popup as soon as the
 * background confirms it has started, so the page has focus for the drag /
 * Esc and the badge shows progress. Built with DOM APIs only — extension
 * pages run under a strict CSP and CLAUDE.md rule 5 forbids innerHTML.
 */

const LABELS: Record<CaptureMode, string> = {
  visible: 'Visible',
  region: 'Region',
  full: 'Full page',
};
const HINTS: Record<CaptureMode, string> = {
  visible: 'what is on screen',
  region: 'drag to select',
  full: 'scrolls the whole page',
};

const root = document.getElementById('popup');
if (root) void init(root);

async function init(main: HTMLElement): Promise<void> {
  const heading = document.createElement('h1');
  heading.textContent = 'snapping-turtle';
  main.append(heading);

  const lastErrorLine = document.createElement('p');
  lastErrorLine.className = 'status error last-error';
  lastErrorLine.id = 'last-error';
  lastErrorLine.hidden = true;
  main.append(lastErrorLine);

  const status = document.createElement('p');
  status.className = 'status';
  status.id = 'status';
  status.setAttribute('role', 'status');
  main.append(status);

  const list = document.createElement('div');
  list.className = 'modes';
  main.append(list);

  const buttons = new Map<CaptureMode, HTMLButtonElement>();
  for (const mode of CAPTURE_MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset['mode'] = mode;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = LABELS[mode];
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = HINTS[mode];
    button.append(label, hint);
    buttons.set(mode, button);
    list.append(button);
  }

  const footer = document.createElement('p');
  footer.className = 'footer';
  const settingsLink = document.createElement('button');
  settingsLink.type = 'button';
  settingsLink.className = 'link';
  settingsLink.textContent = 'Settings';
  settingsLink.addEventListener('click', () => {
    void browser.runtime.openOptionsPage().then(() => window.close());
  });
  footer.append(settingsLink);
  main.append(footer);

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const settings = await loadSettings();

  // A failure that happened while no popup was open (shortcut path, or the OS
  // swallowed the notification): show it once, then clear the badge and store.
  const lastError = await readLastError();
  if (lastError) {
    lastErrorLine.textContent = describeLastError(lastError, Date.now());
    lastErrorLine.hidden = false;
    void clearFailureFlag();
  }

  if (settings.lastMode) {
    const last = buttons.get(settings.lastMode);
    if (last) {
      last.classList.add('last-used');
      last.setAttribute('aria-current', 'true');
    }
  }

  const restricted = restrictedReason(tab?.url);
  if (restricted) {
    status.textContent = restricted;
    status.classList.add('error');
    for (const button of buttons.values()) button.disabled = true;
    return;
  }
  if (!settings.apiToken) {
    status.textContent = 'Set your server address and API token in Settings first.';
    status.classList.add('warn');
  }

  for (const [mode, button] of buttons) {
    button.addEventListener('click', () => {
      if (tab?.id === undefined || tab.windowId === undefined) {
        status.textContent = "Can't capture: no active tab.";
        status.className = 'status error';
        return;
      }
      void capture({ type: 'capture', mode, tabId: tab.id, windowId: tab.windowId });
    });
  }

  async function capture(request: CaptureRequest): Promise<void> {
    for (const button of buttons.values()) button.disabled = true;
    status.className = 'status';
    status.textContent = request.mode === 'full' ? 'Capturing the whole page…' : 'Capturing…';
    let response: CaptureResponse;
    try {
      response = (await browser.runtime.sendMessage(request)) as CaptureResponse;
    } catch (err) {
      response = {
        ok: false,
        code: 'failed',
        message: `The extension background did not answer: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (response.ok) {
      status.textContent =
        response.status === 'uploaded' ? 'Opened your capture page.' : 'Started — see the page.';
      window.close();
      return;
    }
    status.textContent = response.message;
    status.className = 'status error';
    for (const button of buttons.values()) button.disabled = false;
  }
}
