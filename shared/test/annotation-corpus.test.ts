import { Value } from 'typebox/value';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BeaconAnnotationsRequest,
  isAnnotationDocument,
  validateAnnotationDocument,
} from '../src/index.js';
import { CORPUS, IMAGE } from './fixtures/annotation-corpus.js';

/**
 * Validator-independence guard for the annotation wire format: every corpus
 * case must reproduce the row recorded in the expected table (generated under
 * @sinclair/typebox 0.34): accept/reject, reason category, and the sanitised
 * document that would be persisted, all exact. The one thing not compared
 * byte-for-byte is the validator-supplied error *path* inside `reason`
 * (`… at /shapes/0/id`): TypeBox 1.x reports deeper paths for union members
 * and none for root-level missing/extra keys, which changes the message, not
 * the outcome. The schema library is an implementation detail; the contract
 * is not. See fixtures/annotation-corpus.ts.
 */

type Category = 'ok' | 'schema' | 'bounds';

interface Row {
  /** `isAnnotationDocument(input)` — the schema layer alone, before bounds. */
  schema: boolean;
  /** `validateAnnotationDocument(input, image)` outcome. */
  ok: boolean;
  category: Category;
  reason?: string;
  /** The sanitised document that would be persisted, JSON-serialised. */
  persisted?: string;
}

const EXPECTED_PATH = fileURLToPath(
  new URL('./fixtures/annotation-corpus.expected.json', import.meta.url),
);

function categorise(reason: string): Category {
  if (reason.startsWith('invalid annotation document')) return 'schema';
  if (/outside the image bounds$/.test(reason)) return 'bounds';
  throw new Error(`unclassified rejection reason: ${reason}`);
}

function row(input: unknown, image: { width: number; height: number }): Row {
  const schema = isAnnotationDocument(input);
  const res = validateAnnotationDocument(input, image);
  if (res.ok) return { schema, ok: true, category: 'ok', persisted: JSON.stringify(res.doc) };
  return { schema, ok: false, category: categorise(res.reason), reason: res.reason };
}

const actual: Record<string, Row> = {};
for (const c of CORPUS) actual[c.name] = row(c.input, c.image ?? IMAGE);

describe('annotation validation corpus', () => {
  it('has unique case names', () => {
    expect(Object.keys(actual)).toHaveLength(CORPUS.length);
  });

  it('schema rejections are validate() rejections of category "schema"; bounds rejections pass the schema', () => {
    for (const [name, r] of Object.entries(actual)) {
      if (!r.schema) {
        expect({ name, ok: r.ok, category: r.category }).toEqual({
          name,
          ok: false,
          category: 'schema',
        });
      }
      if (r.category === 'bounds') expect({ name, schema: r.schema }).toEqual({ name, schema: true });
    }
  });

  if (process.env['UPDATE_CORPUS']) {
    it('regenerates the expected table (UPDATE_CORPUS is set — review the diff)', () => {
      writeFileSync(EXPECTED_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    });
    return;
  }

  const expected = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8')) as Record<string, Row>;

  it('covers exactly the recorded cases', () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  });

  /** The reason minus the validator's error path — the part that is ours. */
  const withoutPath = (reason: string | undefined) => reason?.replace(/ at \/.*$/, '');

  for (const c of CORPUS) {
    it(`matches the recorded outcome: ${c.name}`, () => {
      const got = actual[c.name]!;
      const want = expected[c.name]!;
      expect({ ...got, reason: withoutPath(got.reason) }).toEqual({
        ...want,
        reason: withoutPath(want.reason),
      });
    });
  }
});

describe('beacon envelope corpus', () => {
  const cases: Array<[name: string, input: unknown, accepted: boolean]> = [
    ['token and document', { csrfToken: 'x', document: { anything: true } }, true],
    ['document may be any JSON value', { csrfToken: 'x', document: null }, true],
    ['empty token', { csrfToken: '', document: {} }, false],
    ['missing token', { document: {} }, false],
    ['missing document', { csrfToken: 'x' }, false],
    ['extra key', { csrfToken: 'x', document: {}, viewId: 'y' }, false],
    ['token as number', { csrfToken: 1, document: {} }, false],
    ['not an object', 'x', false],
  ];
  for (const [name, input, accepted] of cases) {
    it(name, () => {
      expect(Value.Check(BeaconAnnotationsRequest, input)).toBe(accepted);
    });
  }
});
