import { escapeHtml } from './html.js';

/**
 * A deliberately small Markdown subset for committed, trusted prose — the
 * privacy policy at /privacy (E8), whose canonical text lives in
 * web/content/privacy.md. No dependency: a general Markdown engine is attack
 * surface for a feature that renders one file the repository controls.
 *
 * Supported: `#`/`##`/`###` headings, paragraphs (consecutive lines joined
 * with a space), `- ` bullet lists (continuation lines indented by two
 * spaces, as Prettier writes them), and inline `**bold**`, `` `code` `` and
 * `[text](href)` where href is `https://…` or a same-origin `/path`.
 *
 * Everything else — blockquotes, fences, tables, ordered lists, deeper
 * headings, raw HTML, emphasis with `*`/`_`, other link schemes — throws
 * UnsupportedMarkdownError, so an unsupported construct fails the unit test
 * and the production boot instead of rendering as literal text. All text
 * passes through escapeHtml; nothing in the source is treated as markup.
 */
export class UnsupportedMarkdownError extends Error {
  constructor(line: number, detail: string) {
    super(`unsupported markdown at line ${line}: ${detail}`);
    this.name = 'UnsupportedMarkdownError';
  }
}

const HEADING = /^(#{1,3}) (\S.*)$/;
const LIST_ITEM = /^- (\S.*)$/;
const LIST_CONTINUATION = /^ {2,}(\S.*)$/;
const INLINE_TOKEN = /\*\*([^*]+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
const HREF = /^(https:\/\/[^\s)]+|\/[^\s)]*)$/;

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!, i + 1)}</h${level}>`);
      i++;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const item = LIST_ITEM.exec(lines[i]!);
        if (!item) break;
        let text = item[1]!;
        i++;
        for (let cont; (cont = LIST_CONTINUATION.exec(lines[i] ?? '')); i++) text += ` ${cont[1]}`;
        items.push(`<li>${inline(text, i)}</li>`);
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^[\s>|`~#<]/.test(line) || /^(\d+[.)]|[*+])\s/.test(line)) {
      throw new UnsupportedMarkdownError(i + 1, JSON.stringify(line));
    }
    const start = i;
    const chunks: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !HEADING.test(lines[i]!)) {
      if (/^[\s>|`~#<]/.test(lines[i]!) || LIST_ITEM.test(lines[i]!)) {
        throw new UnsupportedMarkdownError(i + 1, JSON.stringify(lines[i]));
      }
      chunks.push(lines[i]!.trim());
      i++;
    }
    out.push(`<p>${inline(chunks.join(' '), start + 1)}</p>`);
  }
  return out.join('\n');
}

/** Inline markup: bold, code and links; every character of text is escaped. */
function inline(text: string, line: number): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    out += plain(text.slice(last, match.index), line);
    const [, bold, code, label, href] = match;
    if (bold !== undefined) out += `<strong>${escapeHtml(bold)}</strong>`;
    else if (code !== undefined) out += `<code>${escapeHtml(code)}</code>`;
    else {
      if (!HREF.test(href!)) throw new UnsupportedMarkdownError(line, `link target ${href}`);
      out += `<a href="${escapeHtml(href!)}">${escapeHtml(label!)}</a>`;
    }
    last = match.index + match[0].length;
  }
  return out + plain(text.slice(last), line);
}

/** Text between tokens: anything that still looks like markup is a construct we do not render. */
function plain(text: string, line: number): string {
  if (/[*`[\]_]|<[a-zA-Z/!]/.test(text)) {
    throw new UnsupportedMarkdownError(line, `inline markup in ${JSON.stringify(text)}`);
  }
  return escapeHtml(text);
}
