import { describe, expect, it } from 'vitest';
import { deriveOrigin, PLACEHOLDER_ORIGIN, resolveBuildInputs } from '../scripts/lib/env.js';

/**
 * The baked-in default server must equal the deployment's PUBLIC_ORIGIN, which
 * compose derives as https://$PUBLIC_HOST:$PUBLIC_PORT (PLAN.md §14). The
 * build reads the same deploy/.env, so the derivation has to match compose's.
 */
describe('resolveBuildInputs / deriveOrigin', () => {
  it('derives https://host:port from PUBLIC_HOST + PUBLIC_PORT, like compose', () => {
    expect(deriveOrigin('shots.real.net', '28443')).toBe('https://shots.real.net:28443');
    expect(resolveBuildInputs({ PUBLIC_HOST: 'shots.real.net', PUBLIC_PORT: '28443' }).publicOrigin).toBe(
      'https://shots.real.net:28443',
    );
  });

  it('omits the port only when it is the https default or unset', () => {
    expect(deriveOrigin('shots.real.net', '443')).toBe('https://shots.real.net');
    expect(deriveOrigin('shots.real.net', undefined)).toBe('https://shots.real.net');
    expect(deriveOrigin('shots.real.net', '')).toBe('https://shots.real.net');
    expect(deriveOrigin(undefined, '28443')).toBe(PLACEHOLDER_ORIGIN);
  });

  it('an explicit PUBLIC_ORIGIN wins verbatim (the server refuses one that disagrees with PUBLIC_PORT)', () => {
    expect(
      resolveBuildInputs({
        PUBLIC_ORIGIN: 'https://shots.real.net:28443',
        PUBLIC_HOST: 'other.example.net',
        PUBLIC_PORT: '8443',
      }).publicOrigin,
    ).toBe('https://shots.real.net:28443');
  });

  it('rejects a PUBLIC_PORT that is not a port number', () => {
    expect(() => deriveOrigin('shots.real.net', 'https')).toThrow(/PUBLIC_PORT/);
    expect(() => deriveOrigin('shots.real.net', '0')).toThrow(/PUBLIC_PORT/);
  });
});
