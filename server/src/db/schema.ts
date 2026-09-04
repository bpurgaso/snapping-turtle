import { emptyAnnotationDocument, type AnnotationDocument } from '@snapping-turtle/shared';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Data model (PLAN.md §5). M0 landed `users` and `settings`; M1 added
 * `api_tokens`, `captures` and `sessions`; M5 adds `audit_log`, `ip_bans`
 * and `account_links` (admin panel, guard, one-time links). All schema
 * changes go through `pnpm --filter server db:generate`.
 */

export const userRole = pgEnum('user_role', ['user', 'admin']);
export const accountLinkPurpose = pgEnum('account_link_purpose', ['setup', 'reset']);

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
    /** Page the capture came from (§7). NULL since M9: native desktop
     *  captures have no source page — the link requirement was specific to
     *  browser captures by construction. Browser uploads always set it. */
    sourceUrl: text('source_url'),
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
    /** RENDER_VERSION the cached flat file was drawn with (§10). The cache is
     *  valid only while this equals the current constant *and* flat_rev is
     *  current; 0 = rendered before versioning (pre-E1), always stale. */
    flatRenderVersion: integer('flat_render_version').notNull().default(0),
  },
  (t) => [
    index('captures_owner_id_idx').on(t.ownerId),
    index('captures_retention_until_idx').on(t.retentionUntil),
    index('captures_sha256_idx').on(t.sha256),
  ],
);

/**
 * Admin audit trail (§5, §11; CLAUDE.md rule 7). Append-only at the
 * database-grant level: the runtime role (`st_app`, migration 0002) has
 * INSERT and SELECT here but no UPDATE or DELETE. Every admin mutation
 * writes a row in the same transaction as the mutation itself. `detail`
 * never carries full secrets — 8-char prefixes only (rule 3) — and targets
 * are internal row ids, never `view_id`s.
 */
export const auditLog = pgTable('audit_log', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actorUserId: integer('actor_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  /** Dotted verb, e.g. `user.create`, `settings.registration`, `guard.unban`. */
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  /** Internal row id of the target; null when the target has none (settings). */
  targetId: integer('target_id'),
  detail: jsonb('detail')
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  ip: text('ip').notNull(),
});

/**
 * Guard bans (§12): one row per IPv4 address / IPv6 /64 prefix, persisted so
 * a restart never amnesties an attacker. `strikes` outlives `banned_until`
 * so escalation (15 min → 1 h → 24 h) carries across bans.
 */
export const ipBans = pgTable(
  'ip_bans',
  {
    ipPrefix: text('ip_prefix').primaryKey(),
    strikes: integer('strikes').notNull(),
    bannedUntil: timestamp('banned_until', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ip_bans_banned_until_idx').on(t.bannedUntil)],
);

/**
 * One-time set-password links (§11): admin-issued for account setup and
 * password reset. The URL carries the raw 20-byte token; only its sha256 is
 * stored, it expires after ACCOUNT_LINK_TTL_HOURS and is consumed on first
 * use. Invalid lookups on /reset/* count against the guard budget (§12).
 */
export const accountLinks = pgTable(
  'account_links',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: accountLinkPurpose('purpose').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('account_links_user_id_idx').on(t.userId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type Capture = typeof captures.$inferSelect;
export type NewCapture = typeof captures.$inferInsert;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type IpBan = typeof ipBans.$inferSelect;
export type AccountLink = typeof accountLinks.$inferSelect;
