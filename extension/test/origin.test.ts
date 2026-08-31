import { describe, expect, it } from 'vitest';
import { hostPattern, parseServerOrigin } from '../src/lib/origin.js';

const ok = (input: string) => {
  const r = parseServerOrigin(input);
  if (!r.ok) throw new Error(`expected ok for ${input}: ${r.reason}`);
  return r.origin;
};
const reason = (input: string) => {
  const r = parseServerOrigin(input);
  if (r.ok) throw new Error(`expected rejection for ${input}`);
  return r.reason;
};

describe('parseServerOrigin (fails closed)', () => {
  it('accepts bare https origins and normalises them', () => {
    expect(ok('https://shots.example.com')).toBe('https://shots.example.com');
    expect(ok('  https://Shots.Example.com/  ')).toBe('https://shots.example.com');
    expect(ok('https://shots.example.com:8443')).toBe('https://shots.example.com:8443');
    expect(ok('https://shots.example.com:443')).toBe('https://shots.example.com');
  });

  it('allows plain http only for loopback hosts', () => {
    expect(ok('http://localhost:3000')).toBe('http://localhost:3000');
    expect(ok('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
    expect(ok('http://[::1]:3000')).toBe('http://[::1]:3000');
    expect(reason('http://shots.example.com')).toMatch(/must use https/);
    expect(reason('http://192.168.1.10:3000')).toMatch(/must use https/);
    expect(reason('http://localhost.example.com')).toMatch(/must use https/);
    expect(reason('http://127.0.0.1.nip.io')).toMatch(/must use https/);
  });

  it('rejects anything that is not a bare origin', () => {
    expect(reason('')).toMatch(/Enter your server address/);
    expect(reason('   ')).toMatch(/Enter your server address/);
    expect(reason('shots.example.com')).toMatch(/Not a valid URL/);
    expect(reason('https://shots.example.com/app')).toMatch(/bare origin/);
    expect(reason('https://shots.example.com/?x=1')).toMatch(/bare origin/);
    expect(reason('https://shots.example.com/#frag')).toMatch(/bare origin/);
    expect(reason('https://user:pw@shots.example.com')).toMatch(/credentials/);
    expect(reason('ftp://shots.example.com')).toMatch(/https/);
    expect(reason('javascript:alert(1)')).toMatch(/https/);
    expect(reason('chrome-extension://abc')).toMatch(/https/);
    expect(reason('https://')).toMatch(/Not a valid URL/);
  });

  it('never echoes credentials back in the reason', () => {
    expect(reason('https://user:hunter2@shots.example.com')).not.toContain('hunter2');
  });

  it('builds a host pattern covering every path on the origin', () => {
    expect(hostPattern('https://shots.example.com')).toBe('https://shots.example.com/*');
    expect(hostPattern('http://localhost:3000')).toBe('http://localhost:3000/*');
  });
});
