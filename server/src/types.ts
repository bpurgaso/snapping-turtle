import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';

/** Fastify instance with the TypeBox type provider, as seen by route modules. */
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

/** Injectable clock; tests advance it instead of sleeping. */
export type Clock = () => Date;

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * An ordinary public page that search engines may index (E8: the privacy
     * policy is the only one). Every other response carries
     * `X-Robots-Tag: noindex, nofollow` (app.ts); the secret routes under
     * /s/* and /reset/* never set this, by design (PLAN.md §6).
     */
    indexable?: boolean;
  }
}
