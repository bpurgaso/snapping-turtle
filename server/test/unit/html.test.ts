import { describe, expect, it } from 'vitest';
import { escapeHtml, html, NOT_FOUND_HTML, raw, renderCapturePage } from '../../src/html.js';

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

  it('renders without a bundle (buttons degrade to read-only inputs)', () => {
    const out = renderCapturePage({ ...base, assets: { css: [] } });
    expect(out).not.toContain('<script');
    expect(out).toContain('readonly');
  });
});

describe('NOT_FOUND_HTML', () => {
  it('is a fixed generic body with no dynamic content', () => {
    expect(NOT_FOUND_HTML).toContain('Not found');
    expect(NOT_FOUND_HTML).not.toMatch(/\$\{/);
  });
});
