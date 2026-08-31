import { emptyAnnotationDocument, type AnnotationDocument } from '@snapping-turtle/shared';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Data model (PLAN.md §5). M0 landed `users` and `settings`; M1 adds
 * `api_tokens`, `captures` and `sessions`. `audit_log` and `ip_bans` arrive
 * with the admin panel and guard in M5. All schema changes go through
 * `pnpm --filter server db:generate`.
 */

export const userRole = pgEnum('user_role', ['user', 'admin']);

export const users = pgTable('users', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('user'),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Runtime-togglable settings, e.g. `registration_enabled` (§11). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Browser sessions (§11). Server-side so that disabling a user or completing
 * a password reset revokes access immediately. The cookie carries the random
 * token; only its sha256 is stored, so a database read cannot mint sessions.
 */
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

/** Personal API tokens used by the extension (§11). Plaintext is shown once. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Revoked tokens are kept (not deleted) so captures stay attributable. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_tokens_user_id_idx').on(t.userId)],
);

/** One row per upload (§5). `view_id` is the only public identifier. */
export const captures = pgTable(
  'captures',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    /** 20 CSPRNG bytes, base64url. Public capability — a secret everywhere but as the lookup key. */
    viewId: text('view_id').notNull().unique(),
    ownerId: integer('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sourceUrl: text('source_url').notNull(),
    pageTitle: text('page_title').notNull().default(''),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** Size of the re-encoded PNG on disk. */
    bytes: integer('bytes').notNull(),
    /** sha256 (hex) of the re-encoded PNG — dedup checks and abuse tracking. */
    sha256: text('sha256').notNull(),
    uploadIp: text('upload_ip').notNull(),
    uploadTokenId: integer('upload_token_id').references(() => apiTokens.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** NULL = keep indefinitely (admin only). */
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
    /** Set when deleted; the row stays as a tombstone for TOMBSTONE_RETENTION_DAYS (§5). */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    annotations: jsonb('annotations')
      .$type<AnnotationDocument>()
      .notNull()
      .$defaultFn(() => emptyAnnotationDocument()),
    annotationsRev: integer('annotations_rev').notNull().default(0),
    flatRev: integer('flat_rev').notNull().default(0),
  },
  (t) => [
    index('captures_owner_id_idx').on(t.ownerId),
    index('captures_retention_until_idx').on(t.retentionUntil),
    index('captures_sha256_idx').on(t.sha256),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type Capture = typeof captures.$inferSelect;
export type NewCapture = typeof captures.$inferInsert;
