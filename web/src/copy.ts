import { copyText, flash } from './dom.js';

/**
 * The two copy buttons on the capture page (§7), shared by the view-only
 * bundle and the owner's editor bundle. URLs come from data attributes the
 * server wrote from its own config — never from user-supplied content.
 */
export function wireCopyButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
    const input = button.parentElement?.querySelector('input') ?? undefined;
    button.addEventListener('click', async () => {
      const text = button.dataset['copy'];
      if (!text) return;
      const ok = await copyText(text, input);
      flash(button, ok ? 'Copied' : 'Select & copy');
    });
  }
}
