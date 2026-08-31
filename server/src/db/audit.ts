import type { Db } from './client.js';
import { auditLog } from './schema.js';

/**
 * Audit trail writes (PLAN.md §11, CLAUDE.md rule 7). Callers pass the
 * transaction the mutation itself runs in, so a mutation that fails mid-way
 * leaves no audit row and an audit failure rolls the mutation back — the two
 * commit or abort together. The table is append-only at the grant level
 * (migration 0002), so nothing in the app can rewrite history.
 *
 * Rule 3 applies to `detail`: secrets appear only as 8-char prefixes
 * (`secretPrefix()`), and targets are internal row ids, never `view_id`s.
 */

/** A live connection or an open transaction — both expose `insert`. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface AuditInput {
  actorUserId: number;
  /** Dotted verb: `user.create`, `user.disable`, `user.enable`, `link.issue`,
   *  `auth.set_password`, `settings.registration`, `capture.retention`,
   *  `capture.delete`, `guard.unban`. */
  action: string;
  targetType: 'user' | 'capture' | 'settings' | 'account_link' | 'ip_ban';
  /** Internal row id; null when the target has none (settings). */
  targetId?: number | null;
  detail?: Record<string, unknown>;
  ip: string;
}

export async function writeAudit(db: DbOrTx, at: Date, input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    at,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    detail: input.detail ?? {},
    ip: input.ip,
  });
}
