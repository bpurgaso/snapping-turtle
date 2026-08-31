/**
 * Server-rendered HTML for the secret routes. Everything interpolated goes
 * through escapeHtml — titles and source URLs are user data, never markup
 * (CLAUDE.md rule 5). No inline scripts or styles: the page must satisfy the
 * strict CSP (rule 6), so behaviour comes from the Vite bundle in web/.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string);
}

class RawHtml {
  constructor(readonly value: string) {}
}
/** Mark a string as already-safe markup (only for server-built fragments). */
export const raw = (value: string): RawHtml => new RawHtml(value);

/** Tagged template: interpolations are escaped unless wrapped in `raw()`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  strings.forEach((chunk, i) => {
    out += chunk;
    if (i < values.length) {
      const v = values[i];
      out += v instanceof RawHtml ? v.value : escapeHtml(String(v ?? ''));
    }
  });
  return out;
}

export interface PageAssets {
  js?: string;
  css: string[];
}

function assetTags(assets: PageAssets): RawHtml {
  const tags = assets.css.map((href) => html`<link rel="stylesheet" href="${href}" />`);
  if (assets.js) tags.push(html`<script type="module" src="${assets.js}"></script>`);
  return raw(tags.join('\n    '));
}

export interface CapturePageModel {
  title: string;
  sourceUrl: string;
  pageUrl: string;
  imageUrl: string;
  width: number;
  height: number;
  createdAt: Date;
  assets: PageAssets;
}

/** The view-only capture page (§7). Owner tooling arrives in M3. */
export function renderCapturePage(m: CapturePageModel): string {
  // Defence in depth: ingest already enforced http(s); never emit anything else as an href.
  const sourceHref = /^https?:\/\//i.test(m.sourceUrl) ? m.sourceUrl : '';
  let host = '';
  try {
    host = new URL(m.sourceUrl).host;
  } catch {
    /* unreachable after ingest validation; leave host blank */
  }
  const title = m.title || host || 'Capture';
  const day = m.createdAt.toISOString().slice(0, 10);
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="no-referrer" />
        <title>${title} · snapping-turtle</title>
        ${assetTags(m.assets)}
      </head>
      <body class="capture">
        <header class="bar">
          <h1 class="title">${title}</h1>
          <a
            class="source"
            href="${sourceHref}"
            rel="noopener noreferrer"
            referrerpolicy="no-referrer"
            target="_blank"
            >Open original page<span aria-hidden="true"> ↗</span></a
          >
          <div class="links">
            <label class="link">
              <span>Page link</span>
              <input type="text" readonly value="${m.pageUrl}" />
              <button type="button" data-copy="${m.pageUrl}">Copy page link</button>
            </label>
            <label class="link">
              <span>Image link</span>
              <input type="text" readonly value="${m.imageUrl}" />
              <button type="button" data-copy="${m.imageUrl}">Copy image link</button>
            </label>
          </div>
        </header>
        <main class="stage">
          <img
            class="shot"
            src="${m.imageUrl}"
            width="${m.width}"
            height="${m.height}"
            alt="Screenshot of ${title}"
            decoding="async"
          />
        </main>
        <footer class="meta">
          <span>${host}</span> · <time datetime="${m.createdAt.toISOString()}">${day}</time> ·
          ${m.width}×${m.height}
        </footer>
      </body>
    </html> `;
}

/**
 * The single not-found body for every miss under /s/* (§6, CLAUDE.md rule 2).
 * Byte-identical for never-existed, expired, deleted and malformed ids.
 */
export const NOT_FOUND_HTML = html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <title>Not found · snapping-turtle</title>
    </head>
    <body>
      <main>
        <h1>Not found</h1>
        <p>There is nothing at this address.</p>
      </main>
    </body>
  </html> `;
