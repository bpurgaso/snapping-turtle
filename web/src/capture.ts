import './capture.css';
import { copyText, flash } from './dom.js';

/**
 * Behaviour for the server-rendered capture page (§7): the two copy buttons.
 * Everything else on the page works without script. The URLs come from the
 * buttons' data attributes, which the server wrote from its own config —
 * nothing here reads or interprets user-supplied content.
 */
for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
  const input = button.parentElement?.querySelector('input') ?? undefined;
  button.addEventListener('click', async () => {
    const text = button.dataset['copy'];
    if (!text) return;
    const ok = await copyText(text, input);
    flash(button, ok ? 'Copied' : 'Select & copy');
  });
}
