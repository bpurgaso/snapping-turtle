import { describe, expect, it } from 'vitest';
import { busyMessage, createCaptureLock } from '../src/lib/capture-lock.js';

describe('createCaptureLock', () => {
  it('lets one capture in and refuses the next until release', () => {
    const lock = createCaptureLock();
    const release = lock.acquire('full page');
    expect(release).toBeTypeOf('function');
    expect(lock.current()).toBe('full page');
    expect(lock.acquire('region')).toBeNull();
    release!();
    expect(lock.current()).toBeNull();
    expect(lock.acquire('region')).toBeTypeOf('function');
  });

  it('a stale release cannot free a later holder', () => {
    const lock = createCaptureLock();
    const first = lock.acquire('a')!;
    first();
    const second = lock.acquire('b');
    expect(second).toBeTypeOf('function');
    first(); // stale
    expect(lock.current()).toBe('b');
    first();
    expect(lock.acquire('c')).toBeNull();
    second!();
    expect(lock.current()).toBeNull();
  });

  it('the refusal names the running capture and how to cancel it', () => {
    expect(busyMessage('full page')).toMatch(/^A full page capture is already running/);
    expect(busyMessage('full page')).toMatch(/Esc/);
  });
});
