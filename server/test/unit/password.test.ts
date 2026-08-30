import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/password.js';

describe('password hashing', () => {
  it('produces argon2id hashes that verify and reject wrong passwords', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery stapl')).toBe(false);
  });

  it('salts: the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([
      hashPassword('another-long-password'),
      hashPassword('another-long-password'),
    ]);
    expect(a).not.toBe(b);
  });

  it('refuses short passwords and does not throw on garbage hashes', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/characters/);
    expect(await verifyPassword('not-a-hash', 'whatever-password-1')).toBe(false);
  });
});
