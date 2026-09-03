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

/** Extra data the owner's editor page needs, carried as data attributes (§9). */
export interface EditorPageModel {
  viewId: string;
  createdAt: string;
  /** ISO timestamp, or '' for indefinite retention. */
  retentionUntil: string;
  retentionMaxDays: number;
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
  /** Present only for the authenticated owner: mounts the editor (§7). */
  editor?: EditorPageModel;
}

/** The screenshot, wrapped for the owner in the editor mount point (§7, §9). */
function stage(m: CapturePageModel, title: string): RawHtml {
  const shot = html`<img
    class="shot"
    src="${m.imageUrl}"
    width="${m.width}"
    height="${m.height}"
    alt="Screenshot of ${title}"
    decoding="async"
  />`;
  if (!m.editor) return raw(shot);
  return raw(html`<div
    id="editor-root"
    data-view-id="${m.editor.viewId}"
    data-width="${m.width}"
    data-height="${m.height}"
    data-image-url="${m.imageUrl}"
    data-page-url="${m.pageUrl}"
    data-created-at="${m.editor.createdAt}"
    data-retention-until="${m.editor.retentionUntil}"
    data-retention-max-days="${m.editor.retentionMaxDays}"
  >
    ${raw(shot)}
  </div>`);
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
        <main class="stage">${stage(m, title)}</main>
        <footer class="meta">
          <span>${host}</span> · <time datetime="${m.createdAt.toISOString()}">${day}</time> ·
          ${m.width}×${m.height}
        </footer>
      </body>
    </html> `;
}

/** What the home page's install section has to offer (E2). */
export interface HomePageModel {
  /**
   * Same-origin path of the stable Firefox install redirect, or undefined
   * until a signed build is published — the card then says so instead of
   * linking a dead download.
   */
  firefoxInstallHref?: string;
  /** The unlisted Chrome Web Store listing (CHROME_EXTENSION_URL), or undefined until it exists. */
  chromeExtensionUrl?: string;
  assets: PageAssets;
}

/**
 * Both install cards always render (E2): a visitor on either browser sees
 * both options, and a wrong user-agent guess by the optional client script
 * can only add emphasis, never hide one. Each card is either a real install
 * link or an honest "not yet" — never a button that 404s.
 */
function installCards(m: HomePageModel): RawHtml {
  const firefox = m.firefoxInstallHref
    ? html`<a class="button" href="${m.firefoxInstallHref}">Install for Firefox</a>
          <p class="hint">
            Firefox asks once to allow installs from this site. Updates arrive automatically.
          </p>`
    : html`<p class="unavailable">Not yet published</p>
          <p class="hint">The signed Firefox build has not been uploaded to this server yet.</p>`;
  const chrome = m.chromeExtensionUrl
    ? html`<a class="button" href="${m.chromeExtensionUrl}" rel="noopener noreferrer"
            >Install for Chrome</a
          >
          <p class="hint">Opens the Chrome Web Store listing.</p>`
    : html`<p class="unavailable">Coming soon</p>
          <p class="hint">The Chrome Web Store listing is not live yet.</p>`;
  return raw(html`<div class="browsers">
        <article class="browser" data-browser="firefox">
          <h3>Firefox</h3>
          ${raw(firefox)}
        </article>
        <article class="browser" data-browser="chrome">
          <h3>Chrome</h3>
          ${raw(chrome)}
        </article>
      </div>`);
}

/** The home page (E2): name, one line, install cards, the way in. Server-rendered so it needs no bundle. */
export function renderHomePage(m: HomePageModel): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>snapping-turtle</title>
        ${assetTags(m.assets)}
      </head>
      <body class="home">
        <main>
          <h1>snapping-turtle</h1>
          <p class="tagline">
            Capture a tab, annotate it, and share it at a private link on this server.
          </p>
          <section class="install" aria-labelledby="install-heading">
            <h2 id="install-heading">Install the extension</h2>
            ${installCards(m)}
            <p class="hint">
              After installing, create an API token on your account page and paste it into the
              extension's settings.
            </p>
          </section>
          <nav class="nav">
            <a href="/login">Sign in</a>
            <a href="/account">Account</a>
          </nav>
        </main>
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
