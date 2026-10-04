import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, UnsupportedMarkdownError } from '../../src/markdown.js';

/**
 * The strict Markdown subset behind /privacy (E8). Two contracts: what it
 * supports renders exactly as written, and everything else throws rather
 * than degrading to literal text — so the canonical policy file can only
 * ever contain constructs the page shows correctly.
 */
const canonical = fileURLToPath(new URL('../../../web/content/privacy.md', import.meta.url));

describe('renderMarkdown', () => {
  it('renders headings, paragraphs and bullet lists', () => {
    const out = renderMarkdown(
      [
        '# Title',
        '',
        'One line',
        'and the next.',
        '',
        '## Section',
        '',
        '- a',
        '- b',
        '  continued',
        '',
      ].join('\n'),
    );
    expect(out).toBe(
      [
        '<h1>Title</h1>',
        '<p>One line and the next.</p>',
        '<h2>Section</h2>',
        '<ul><li>a</li><li>b continued</li></ul>',
      ].join('\n'),
    );
  });

  it('renders bold, code and https / same-origin links, escaping every piece of text', () => {
    const out = renderMarkdown(
      'A **bold & brave** `x<y` [link](https://example.com/a?b=1&c=2) [home](/).',
    );
    expect(out).toBe(
      '<p>A <strong>bold &amp; brave</strong> <code>x&lt;y</code> ' +
        '<a href="https://example.com/a?b=1&amp;c=2">link</a> <a href="/">home</a>.</p>',
    );
  });

  it('escapes HTML-significant characters in plain text', () => {
    expect(renderMarkdown('Tom & Jerry say "hi" > bye')).toBe(
      '<p>Tom &amp; Jerry say &quot;hi&quot; &gt; bye</p>',
    );
  });

  it.each([
    ['blockquote', '> quoted'],
    ['fenced code', '```\ncode\n```'],
    ['table', '| a | b |'],
    ['ordered list', '1. first'],
    ['level-4 heading', '#### deep'],
    ['raw HTML block', '<div>hi</div>'],
    ['inline HTML', 'text <b>bold</b>'],
    ['star emphasis', 'some *emphasis* here'],
    ['underscore emphasis', 'some _emphasis_ here'],
    ['unbalanced backtick', 'a ` b'],
    ['stray bracket', 'a [b'],
    ['http link', '[x](http://example.com)'],
    ['javascript link', '[x](javascript:alert(1))'],
    ['relative link', '[x](privacy)'],
    ['indented paragraph', '  indented'],
    ['list continuation without a list', 'para\n- item'],
  ])('throws on unsupported markdown: %s', (_name, source) => {
    expect(() => renderMarkdown(source)).toThrow(UnsupportedMarkdownError);
  });

  it('accepts a paragraph that starts with a digit', () => {
    expect(renderMarkdown('30 days by default.')).toBe('<p>30 days by default.</p>');
  });

  it('renders the canonical privacy policy without throwing, as headed sections', () => {
    const out = renderMarkdown(readFileSync(canonical, 'utf8'));
    expect(out).toMatch(/^<h1>snapping-turtle privacy policy<\/h1>/);
    expect(out.match(/<h2>/g)?.length).toBeGreaterThanOrEqual(3);
    expect(out).not.toMatch(/\*\*|\]\(/);
  });
});
