import { describe, expect, it } from 'vitest';
import {
  failureReason,
  fullPageFailureMessage,
  INTERNAL_FAILURE_TEXT,
  isInternalFailure,
} from '../src/lib/failure-text.js';

describe('failure text', () => {
  it('hides program diagnostics behind a fixed phrase', () => {
    const leaked = new TypeError('f.default.tabs.captureTab is not a function');
    expect(isInternalFailure(leaked)).toBe(true);
    expect(fullPageFailureMessage(leaked)).toBe(
      `Full-page capture failed: ${INTERNAL_FAILURE_TEXT}. Try Visible or Region instead.`,
    );
    expect(fullPageFailureMessage(leaked)).not.toMatch(/f\.default|captureTab/);
    for (const err of [
      new ReferenceError('x is not defined'),
      new RangeError('Invalid array length'),
      new SyntaxError('Unexpected token'),
      new Error('e.tabs.captureTab is not a function'),
      new Error("Cannot read properties of undefined (reading 'id')"),
      new Error(''),
      undefined,
      null,
      { some: 'object' },
    ]) {
      expect(failureReason(err)).toBe(INTERNAL_FAILURE_TEXT);
    }
  });

  it('passes human-written reasons through, whitespace-collapsed and capped', () => {
    expect(failureReason(new Error('the page did not answer "st:page:begin" in time'))).toBe(
      'the page did not answer "st:page:begin" in time',
    );
    expect(failureReason(new Error('Missing activeTab permission'))).toBe(
      'Missing activeTab permission',
    );
    expect(
      failureReason(
        new Error("Either the '<all_urls>' or 'activeTab' permission is required to capture"),
      ),
    ).toMatch(/activeTab/);
    expect(failureReason('tab   was\n closed')).toBe('tab was closed');
    const long = failureReason(new Error('x'.repeat(500)));
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps the message shape the popup and smoke tests key on', () => {
    expect(fullPageFailureMessage(new Error('the tab was switched away'))).toMatch(
      /^Full-page capture failed: the tab was switched away\. Try Visible or Region instead\.$/,
    );
  });
});
