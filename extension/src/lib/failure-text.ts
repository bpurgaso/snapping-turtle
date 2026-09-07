/**
 * User-facing wording for a failed capture. A notification or badge tooltip
 * says what failed and what to try; it never carries a program detail. The
 * 0.1.0 Firefox build told users "f.default.tabs.captureTab is not a
 * function" — a minified internal that means nothing to them. Such errors
 * (native error types, or a message shaped like an engine diagnostic) become a
 * fixed phrase; the detail goes to the extension console via `console.error`
 * at the call site. Messages we or the browser wrote for people — "the page
 * did not answer … in time", "Missing activeTab permission" — pass through.
 */
export const INTERNAL_FAILURE_TEXT = 'an internal error (details are in the extension console)';

const ENGINE_DIAGNOSTIC =
  /is not a function|is not defined|is not iterable|is not a constructor|Cannot (read|set) propert|(undefined|null) has no properties|\b(reading|of) (undefined|null)\b/i;

const MAX_REASON = 200;

/** Whether the failure reads as a program defect rather than something a user can act on. */
export function isInternalFailure(err: unknown): boolean {
  if (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof RangeError ||
    err instanceof SyntaxError
  ) {
    return true;
  }
  const text = rawText(err);
  return !text || ENGINE_DIAGNOSTIC.test(text);
}

/** The reason clause of a failure message: a human sentence fragment, never a stack or a minified name. */
export function failureReason(err: unknown): string {
  if (isInternalFailure(err)) return INTERNAL_FAILURE_TEXT;
  const text = rawText(err).replace(/\s+/g, ' ').trim();
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

export function fullPageFailureMessage(err: unknown): string {
  return `Full-page capture failed: ${failureReason(err)}. Try Visible or Region instead.`;
}

function rawText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '';
}
