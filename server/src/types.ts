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
