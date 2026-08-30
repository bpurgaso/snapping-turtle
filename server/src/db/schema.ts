import { integer, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Data model (PLAN.md §5). M0 lands `users` and `settings`; api_tokens,
 * captures, audit_log and ip_bans arrive with the features that use them.
 * All schema changes go through `pnpm --filter server db:generate`.
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Setting = typeof settings.$inferSelect;
