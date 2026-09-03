import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  html,
  NOT_FOUND_HTML,
  raw,
  renderCapturePage,
  renderHomePage,
} from '../../src/html.js';

describe('html escaping (CLAUDE.md rule 5)', () => {
  it('escapes the five significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('tagged template escapes interpolations unless raw()', () => {
    expect(html`<p>${'<b>'}</p>`).toBe('<p>&lt;b&gt;</p>');
    expect(html`<p>${raw('<b>')}</p>`).toBe('<p><b></p>');
    expect(html`<p>${undefined}${null}</p>`).toBe('<p></p>');
  });
});

describe('renderCapturePage (§7)', () => {
  const base = {
    title: 'Hello <script>alert(1)</script>',
    sourceUrl: 'https://example.com/a?b=1&c="2"',
    pageUrl: 'https://shots.example.com/s/AbCdEfGhIjKlMnOpQrStUvWxYz1',
    imageUrl: 'https://shots.example.com/s/AbCdEfGhIjKlMnOpQrStUvWxYz1/image.png',
    width: 800,
    height: 600,
    createdAt: new Date('2026-08-30T12:00:00Z'),
    assets: { js: '/assets/capture-abc.js', css: ['/assets/capture-abc.css'] },
  };

  it('treats the title and URL as data, never markup', () => {
    const out = renderCapturePage(base);
    expect(out).not.toContain('<script>alert');
    expect(out).toContain('Hello &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('href="https://example.com/a?b=1&amp;c=&quot;2&quot;"');
  });

  it('has the source link with noopener noreferrer and both copy targets', () => {
    const out = renderCapturePage(base);
    expect(out).toMatch(/<a[^>]*class="source"[^>]*rel="noopener noreferrer"/);
    expect(out).toContain('Open original page');
    expect(out).toContain(`data-copy="${base.pageUrl}"`);
    expect(out).toContain(`data-copy="${base.imageUrl}"`);
    expect(out).toContain(`src="${base.imageUrl}"`);
    expect(out).toContain('width="800"');
    expect(out).toContain('height="600"');
  });

  it('never emits a non-http(s) href even if a bad URL reached it', () => {
    const out = renderCapturePage({ ...base, sourceUrl: 'javascript:alert(1)' });
    expect(out).not.toContain('javascript:');
    expect(out).toContain('href=""');
  });

  it('contains no inline script or style (CSP rule 6) and links the bundle', () => {
    const out = renderCapturePage(base);
    expect(out).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(out).not.toMatch(/<style\b/);
    expect(out).not.toMatch(/\sstyle=/);
    expect(out).not.toMatch(/\son[a-z]+=/i);
    expect(out).toContain('<script type="module" src="/assets/capture-abc.js"></script>');
    expect(out).toContain('<link rel="stylesheet" href="/assets/capture-abc.css" />');
  });

  describe('link-preview tags (E3)', () => {
    it('emits Open Graph + Twitter card tags with absolute URLs and the row dimensions', () => {
      const out = renderCapturePage({ ...base, title: 'Plain title' });
      for (const tag of [
        '<meta property="og:type" content="website" />',
        '<meta property="og:site_name" content="snapping-turtle" />',
        '<meta property="og:title" content="Plain title" />',
        '<meta property="og:description" content="Annotated screenshot" />',
        `<meta property="og:url" content="${base.pageUrl}" />`,
        `<meta property="og:image" content="${base.imageUrl}" />`,
        '<meta property="og:image:type" content="image/png" />',
        '<meta property="og:image:width" content="800" />',
        '<meta property="og:image:height" content="600" />',
        '<meta name="twitter:card" content="summary_large_image" />',
      ]) {
        expect(out).toContain(tag);
      }
      // The tags live in <head>, before any script.
      expect(out.indexOf('og:image')).toBeLessThan(out.indexOf('</head>'));
    });

    it('escapes a hostile title inside the attribute (rule 5) — checked on the raw HTML', () => {
      const hostile = `Q&A "quoted" <b>bold</b> 'single' &amp; \u0022done`;
      const out = renderCapturePage({ ...base, title: hostile });
      expect(out).toContain(
        '<meta property="og:title" content="Q&amp;A &quot;quoted&quot; &lt;b&gt;bold&lt;/b&gt; &#39;single&#39; &amp;amp; &quot;done" />',
      );
      // Neither the raw text nor a way out of the attribute survives anywhere.
      expect(out).not.toContain(hostile);
      expect(out).not.toContain('<b>bold');
      expect(out).not.toMatch(/content="[^"]*"[^>]*"[^>]*\/>/); // no stray quote in a content value
      const contents = [...out.matchAll(/content="([^"]*)"/g)].map((m) => m[1] as string);
      for (const value of contents) {
        expect(value).not.toMatch(/[<>"]/);
        expect(value).not.toMatch(/&(?!(amp|lt|gt|quot|#39);)/); // only our named escapes
      }
    });

    it('falls back to the source host, then a generic word, for an empty title', () => {
      expect(renderCapturePage({ ...base, title: '' })).toContain(
        '<meta property="og:title" content="example.com" />',
      );
      expect(renderCapturePage({ ...base, title: '', sourceUrl: 'not a url' })).toContain(
        '<meta property="og:title" content="Capture" />',
      );
    });
  });

  it('renders without a bundle (buttons degrade to read-only inputs)', () => {
    const out = renderCapturePage({ ...base, assets: { css: [] } });
    expect(out).not.toContain('<script');
    expect(out).toContain('readonly');
  });
});

describe('renderHomePage (E2)', () => {
  const assets = { js: '/assets/home-abc.js', css: ['/assets/home-abc.css'] };

  it('always renders both install cards, the description and the sign-in link', () => {
    for (const model of [
      { assets },
      { assets, firefoxInstallHref: '/ext/firefox-latest' },
      { assets, chromeExtensionUrl: 'https://chromewebstore.google.com/detail/abc' },
    ]) {
      const out = renderHomePage(model);
      expect(out).toContain('<h1>snapping-turtle</h1>');
      expect(out).toContain('data-browser="firefox"');
      expect(out).toContain('data-browser="chrome"');
      expect(out).toContain('href="/login"');
      expect(out).toMatch(/<p class="tagline">/);
    }
  });

  it('links the stable Firefox redirect when published, says so when not', () => {
    const published = renderHomePage({ assets, firefoxInstallHref: '/ext/firefox-latest' });
    expect(published).toContain('href="/ext/firefox-latest"');
    expect(published).not.toContain('Not yet published');
    const bare = renderHomePage({ assets });
    expect(bare).toContain('Not yet published');
    expect(bare).not.toContain('firefox-latest');
  });

  it('links the Chrome listing when configured, says coming soon when not', () => {
    const live = renderHomePage({ assets, chromeExtensionUrl: 'https://chromewebstore.google.com/detail/abc' });
    expect(live).toMatch(
      /<a class="button" href="https:\/\/chromewebstore\.google\.com\/detail\/abc" rel="noopener noreferrer"/,
    );
    expect(live).not.toContain('Coming soon');
    const bare = renderHomePage({ assets });
    expect(bare).toContain('Coming soon');
    expect(bare).not.toContain('chromewebstore');
  });

  it('escapes the configured Chrome URL like any other attribute value', () => {
    const out = renderHomePage({ assets, chromeExtensionUrl: 'https://x.test/a?b=1&c="2"<s>' });
    expect(out).toContain('href="https://x.test/a?b=1&amp;c=&quot;2&quot;&lt;s&gt;"');
    expect(out).not.toContain('<s>');
  });

  it('contains no inline script or style (CSP rule 6) and renders without a bundle', () => {
    const out = renderHomePage({ assets, firefoxInstallHref: '/ext/firefox-latest' });
    expect(out).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(out).not.toMatch(/<style\b/);
    expect(out).not.toMatch(/\sstyle=/);
    expect(out).not.toMatch(/\son[a-z]+=/i);
    expect(out).toContain('<script type="module" src="/assets/home-abc.js"></script>');
    expect(renderHomePage({ assets: { css: [] } })).not.toContain('<script');
  });
});

describe('NOT_FOUND_HTML', () => {
  it('is a fixed generic body with no dynamic content', () => {
    expect(NOT_FOUND_HTML).toContain('Not found');
    expect(NOT_FOUND_HTML).not.toMatch(/\$\{/);
  });

  it('carries no link-preview tags (E3 leaves the uniform 404 untouched)', () => {
    expect(NOT_FOUND_HTML).not.toMatch(/og:|twitter:|<meta property/);
  });
});
