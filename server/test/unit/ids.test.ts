import { API_TOKEN_PREFIX, VIEW_ID_LENGTH } from '@snapping-turtle/shared';
import { describe, expect, it } from 'vitest';
import {
  newApiToken,
  newSessionToken,
  newViewId,
  safeEqual,
  secretPrefix,
  sha256Hex,
  VIEW_ID_PATTERN,
} from '../../src/ids.js';

describe('identifiers (CLAUDE.md rule 1)', () => {
  it('view ids are 27-char base64url with ≈160 bits of entropy', () => {
    const ids = new Set(Array.from({ length: 2000 }, newViewId));
    expect(ids.size).toBe(2000);
    for (const id of ids) {
      expect(id).toHaveLength(VIEW_ID_LENGTH);
      expect(VIEW_ID_PATTERN.test(id)).toBe(true);
      expect(Buffer.from(id, 'base64url')).toHaveLength(20);
    }
  });

  it('view ids use the whole alphabet (not a hex or digit subset)', () => {
    const chars = new Set(Array.from({ length: 500 }, newViewId).join(''));
    expect(chars.size).toBeGreaterThan(60);
  });

  it('api tokens carry the prefix and 20 random bytes; sessions 32', () => {
    const t = newApiToken();
    expect(t.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(Buffer.from(t.slice(API_TOKEN_PREFIX.length), 'base64url')).toHaveLength(20);
    expect(Buffer.from(newSessionToken(), 'base64url')).toHaveLength(32);
    expect(newApiToken()).not.toBe(newApiToken());
  });

  it('pattern rejects malformed ids', () => {
    expect(VIEW_ID_PATTERN.test('short')).toBe(false);
    expect(VIEW_ID_PATTERN.test('+bCdEfGhIjKlMnOpQrStUvWxYz1')).toBe(false);
    expect(VIEW_ID_PATTERN.test('AbCdEfGhIjKlMnOpQrStUvWxYz12')).toBe(false);
  });

  it('sha256Hex, safeEqual and secretPrefix behave', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(safeEqual('same', 'same')).toBe(true);
    expect(safeEqual('same', 'sam')).toBe(false);
    expect(safeEqual('same', 'sane')).toBe(false);
    expect(secretPrefix('AbCdEfGhIjKlMnOpQrStUvWxYz1')).toBe('AbCdEfGh…');
  });
});
