import { Type, type Static } from '@sinclair/typebox';

/**
 * Wire types for the JSON API (PLAN.md §8). Only what exists so far; each
 * route adds its request/response schemas here when it lands.
 */

export const HealthzResponse = Type.Object(
  {
    status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
    /** Which dependencies were checked and whether each passed. */
    checks: Type.Record(Type.String(), Type.Boolean()),
  },
  { additionalProperties: false, $id: 'HealthzResponse' },
);
export type HealthzResponse = Static<typeof HealthzResponse>;

export const ApiErrorResponse = Type.Object(
  {
    error: Type.String(),
    /** Short machine-readable code; never contains secrets or row internals. */
    code: Type.Optional(Type.String()),
  },
  { additionalProperties: false, $id: 'ApiErrorResponse' },
);
export type ApiErrorResponse = Static<typeof ApiErrorResponse>;
