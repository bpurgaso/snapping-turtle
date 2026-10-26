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

/**
 * Point the header's link fields and copy buttons at new URLs (E12): after a
 * rotation the server-rendered page still shows the dead link until this
 * runs. The buttons read `data-copy` at click time, so updating the
 * attribute is enough; values come from the server's response, never from
 * user-supplied content.
 */
export function setLinkTargets(urls: { pageUrl: string; imageUrl: string }): void {
  const apply = (kind: 'page' | 'image', url: string) => {
    for (const input of document.querySelectorAll<HTMLInputElement>(`input[data-link="${kind}"]`)) {
      input.value = url;
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      `button[data-link="${kind}"]`,
    )) {
      button.dataset['copy'] = url;
    }
  };
  apply('page', urls.pageUrl);
  apply('image', urls.imageUrl);
}
