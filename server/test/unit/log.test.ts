import { describe, expect, it } from 'vitest';
import { redactSecretPath } from '../../src/log.js';

const viewId = 'AbCdEfGhIjKlMnOpQrStUvWxYz1';

describe('redactSecretPath', () => {
  it('truncates view_ids to an 8-char prefix on page and image routes', () => {
    expect(redactSecretPath(`/s/${viewId}`)).toBe('/s/AbCdEfGh…');
    expect(redactSecretPath(`/s/${viewId}/image.png`)).toBe('/s/AbCdEfGh…/image.png');
  });

  it('truncates reset tokens and drops query strings on secret routes', () => {
    expect(redactSecretPath(`/reset/${viewId}?x=1`)).toBe('/reset/AbCdEfGh…');
  });

  it('truncates the view_id in the owner API routes (E12 route audit), including unknown sub-paths', () => {
    expect(redactSecretPath(`/api/v1/captures/${viewId}/annotations`)).toBe(
      '/api/v1/captures/AbCdEfGh…/annotations',
    );
    expect(redactSecretPath(`/api/v1/captures/${viewId}/original?x=1`)).toBe(
      '/api/v1/captures/AbCdEfGh…/original',
    );
    expect(redactSecretPath(`/api/v1/captures/${viewId}/rotate`)).toBe(
      '/api/v1/captures/AbCdEfGh…/rotate',
    );
    expect(redactSecretPath(`/api/v1/captures/${viewId}`)).toBe('/api/v1/captures/AbCdEfGh…');
    // Only the segment right after `captures` is a view_id; later ones are not guessed at.
    expect(redactSecretPath(`/api/v1/captures/${viewId}/nope/${viewId}`)).toBe(
      `/api/v1/captures/AbCdEfGh…/nope/${viewId}`,
    );
  });

  it('leaves non-secret routes untouched', () => {
    // The upload route has no id; the admin API is keyed by internal row ids.
    expect(redactSecretPath('/api/v1/captures')).toBe('/api/v1/captures');
    expect(redactSecretPath('/api/v1/admin/captures/123')).toBe('/api/v1/admin/captures/123');
    expect(redactSecretPath('/api/v1/admin/captures?userId=4&page=2')).toBe(
      '/api/v1/admin/captures?userId=4&page=2',
    );
    expect(redactSecretPath('/healthz')).toBe('/healthz');
    expect(redactSecretPath('/assets/index-abc123.js?v=2')).toBe('/assets/index-abc123.js?v=2');
    expect(redactSecretPath('/s/')).toBe('/s/');
  });
});
