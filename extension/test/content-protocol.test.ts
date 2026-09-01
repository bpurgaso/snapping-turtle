import { describe, expect, it } from 'vitest';
import {
  isContentCommand,
  isContentReply,
  isRegionResult,
  isRegionSelection,
} from '../src/lib/content-protocol.js';

const selection = {
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  devicePixelRatio: 2,
  viewportWidth: 1265,
  viewportHeight: 800,
  innerWidth: 1280,
  innerHeight: 800,
};

describe('content protocol guards', () => {
  it('accepts every command and rejects unknown or malformed ones', () => {
    for (const type of [
      'st:region:select',
      'st:page:measure',
      'st:page:begin',
      'st:page:hide-fixed',
      'st:page:restore',
    ]) {
      expect(isContentCommand({ type })).toBe(true);
    }
    expect(isContentCommand({ type: 'st:page:scroll', y: 800 })).toBe(true);
    expect(isContentCommand({ type: 'st:page:scroll' })).toBe(false);
    expect(isContentCommand({ type: 'st:page:scroll', y: -1 })).toBe(false);
    expect(isContentCommand({ type: 'st:page:scroll', y: '800' })).toBe(false);
    expect(isContentCommand({ type: 'capture', mode: 'visible' })).toBe(false);
    expect(isContentCommand(null)).toBe(false);
    expect(isContentCommand('st:page:begin')).toBe(false);
  });

  it('validates region selections field by field', () => {
    expect(isRegionSelection(selection)).toBe(true);
    expect(isRegionSelection({ ...selection, width: 0 })).toBe(false);
    expect(isRegionSelection({ ...selection, height: NaN })).toBe(false);
    expect(isRegionSelection({ ...selection, devicePixelRatio: 0 })).toBe(false);
    expect(isRegionSelection({ ...selection, innerWidth: undefined })).toBe(false);
    expect(isRegionSelection({ ...selection, x: '10' })).toBe(false);
    expect(isRegionResult({ type: 'st:region:selected', selection })).toBe(true);
    expect(isRegionResult({ type: 'st:region:selected', selection: {} })).toBe(false);
    expect(isRegionResult({ type: 'st:region:cancelled' })).toBe(true);
    expect(isRegionResult({ type: 'st:region:started' })).toBe(false);
  });

  it('validates replies, including the metrics payload', () => {
    const metrics = {
      documentWidth: 1280,
      documentHeight: 3000,
      viewportWidth: 1265,
      viewportHeight: 800,
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 2,
      scrollX: 0,
      scrollY: 120,
    };
    expect(isContentReply({ type: 'st:page:metrics', metrics })).toBe(true);
    expect(
      isContentReply({ type: 'st:page:metrics', metrics: { ...metrics, innerHeight: 0 } }),
    ).toBe(false);
    expect(isContentReply({ type: 'st:page:metrics' })).toBe(false);
    expect(
      isContentReply({ type: 'st:page:scrolled', scrollX: 0, scrollY: 800, cancelled: false }),
    ).toBe(true);
    expect(isContentReply({ type: 'st:page:scrolled', scrollY: 800 })).toBe(false);
    expect(isContentReply({ type: 'st:page:hidden', count: 3 })).toBe(true);
    expect(isContentReply({ type: 'st:page:restored' })).toBe(true);
    expect(isContentReply({ type: 'st:region:started' })).toBe(true);
    expect(isContentReply({ type: 'st:error', message: 'nope' })).toBe(true);
    expect(isContentReply({ type: 'st:error' })).toBe(false);
    expect(isContentReply({ type: 'st:region:selected', selection })).toBe(false);
    expect(isContentReply(undefined)).toBe(false);
  });
});
