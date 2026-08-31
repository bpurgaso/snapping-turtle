import { MAX_PAGE_TITLE_LENGTH, MAX_SOURCE_URL_LENGTH } from '@snapping-turtle/shared';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/errors.js';
import { cleanTitle, validateSourceUrl } from '../../src/routes/captures.js';

describe('validateSourceUrl (§12)', () => {
  it('accepts http and https and normalises', () => {
    expect(validateSourceUrl('https://Example.com/path?x=1#frag')).toBe(
      'https://example.com/path?x=1#frag',
    );
    expect(validateSourceUrl(' http://localhost:8080/ ')).toBe('http://localhost:8080/');
  });

  it('rejects other schemes, relative URLs and over-long URLs with 400 invalid_source_url', () => {
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://x/y',
      'data:text/html,hi',
      '/relative',
      'not a url',
      `https://example.com/${'a'.repeat(MAX_SOURCE_URL_LENGTH)}`,
    ]) {
      let caught: unknown;
      try {
        validateSourceUrl(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).statusCode).toBe(400);
      expect((caught as HttpError).code).toBe('invalid_source_url');
    }
  });
});

describe('cleanTitle', () => {
  it('strips control characters, collapses whitespace and caps length by code point', () => {
    expect(cleanTitle(undefined)).toBe('');
    expect(cleanTitle('  Hello  \n world ')).toBe('Hello world');
    expect(cleanTitle('a' + String.fromCodePoint(0) + String.fromCodePoint(0x9b) + 'b')).toBe(
      'a b',
    );
    const long = '🐢'.repeat(MAX_PAGE_TITLE_LENGTH + 10);
    expect(Array.from(cleanTitle(long))).toHaveLength(MAX_PAGE_TITLE_LENGTH);
  });
});
