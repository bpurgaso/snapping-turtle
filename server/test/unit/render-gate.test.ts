import { describe, expect, it } from 'vitest';
import { RenderGate } from '../../src/images/flat.js';

/** A job that resolves when told to, recording concurrency as it runs. */
function controlledJobs() {
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const job = (result: string) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return result;
  };
  return { job, releases, peak: () => peak, active: () => active };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RenderGate', () => {
  it('coalesces concurrent calls for the same key onto one job', async () => {
    const gate = new RenderGate<string>(2);
    const { job, releases } = controlledJobs();
    const p1 = gate.run(7, job('first'));
    const p2 = gate.run(7, job('second'));
    await tick();
    expect(releases).toHaveLength(1); // one render started, not two
    releases[0]!();
    await expect(p1).resolves.toBe('first');
    await expect(p2).resolves.toBe('first'); // the coalesced caller shares it
    expect(gate.started).toBe(1);
  });

  it('runs at most `limit` jobs in parallel across keys', async () => {
    const gate = new RenderGate<string>(2);
    const { job, releases, peak } = controlledJobs();
    const all = [1, 2, 3, 4].map((k) => gate.run(k, job(`r${k}`)));
    await tick();
    expect(peak()).toBe(2);
    expect(releases).toHaveLength(2);
    releases[0]!();
    releases[1]!();
    await tick();
    expect(releases).toHaveLength(4);
    releases[2]!();
    releases[3]!();
    await expect(Promise.all(all)).resolves.toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(peak()).toBe(2);
    expect(gate.started).toBe(4);
  });

  it('a fresh call after completion starts a fresh job', async () => {
    const gate = new RenderGate<number>(1);
    let calls = 0;
    const run = () =>
      gate.run(1, async () => {
        calls += 1;
        return calls;
      });
    await expect(run()).resolves.toBe(1);
    await expect(run()).resolves.toBe(2);
  });

  it('propagates failure to every coalesced caller, then recovers', async () => {
    const gate = new RenderGate<string>(2);
    let attempts = 0;
    const failing = () =>
      gate.run(5, async () => {
        attempts += 1;
        await tick();
        throw new Error('render failed');
      });
    const a = failing();
    const b = failing();
    await expect(a).rejects.toThrow('render failed');
    await expect(b).rejects.toThrow('render failed');
    expect(attempts).toBe(1);
    await expect(gate.run(5, async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects a nonsensical limit', () => {
    expect(() => new RenderGate(0)).toThrow('invalid render concurrency');
  });
});
