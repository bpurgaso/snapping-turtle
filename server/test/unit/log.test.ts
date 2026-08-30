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

  it('leaves non-secret routes untouched', () => {
    expect(redactSecretPath('/healthz')).toBe('/healthz');
    expect(redactSecretPath('/assets/index-abc123.js?v=2')).toBe('/assets/index-abc123.js?v=2');
    expect(redactSecretPath('/s/')).toBe('/s/');
  });
});
