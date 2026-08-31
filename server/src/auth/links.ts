import { ACCOUNT_LINK_TTL_HOURS } from '@snapping-turtle/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/audit.js';
import type { Db } from '../db/client.js';
import { accountLinks, users } from '../db/schema.js';
import { newLinkToken, sha256Hex } from '../ids.js';
import type { Clock } from '../types.js';

/**
 * One-time set-password links (§11): 20-byte CSPRNG tokens stored hashed,
 * 24 h expiry, consumed on first use. The raw token exists only in the URL
 * handed to the admin (or, on completion, in the requester's POST body) —
 * never in the database, logs, or audit detail (CLAUDE.md rules 1 & 3).
 */

export type LinkPurpose = 'setup' | 'reset';

export interface IssuedLink {
  id: number;
  /** Raw token — surface exactly once, to the issuing admin. */
  token: string;
  expiresAt: Date;
}

/** Insert a new link row (call within the issuing mutation's transaction). */
export async function issueAccountLink(
  tx: DbOrTx,
  now: Clock,
  input: { userId: number; purpose: LinkPurpose; createdBy: number },
): Promise<IssuedLink> {
  const token = newLinkToken();
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + ACCOUNT_LINK_TTL_HOURS * 3_600_000);
  const [row] = await tx
    .insert(accountLinks)
    .values({
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: sha256Hex(token),
      expiresAt,
      createdBy: input.createdBy,
      createdAt,
    })
    .returning({ id: accountLinks.id });
  return { id: row!.id, token, expiresAt };
}

/**
 * A link that would currently be accepted: unconsumed, unexpired, and for an
 * enabled user. Used by GET /reset/:token to decide page-or-404; the POST
 * consumes atomically in its own transaction instead of trusting this read.
 */
export async function findLiveLink(
  db: Db,
  now: Clock,
  token: string,
): Promise<{ id: number; userId: number; purpose: LinkPurpose } | undefined> {
  const [row] = await db
    .select({ id: accountLinks.id, userId: accountLinks.userId, purpose: accountLinks.purpose })
    .from(accountLinks)
    .innerJoin(users, eq(users.id, accountLinks.userId))
    .where(
      and(
        eq(accountLinks.tokenHash, sha256Hex(token)),
        isNull(accountLinks.consumedAt),
        gt(accountLinks.expiresAt, now()),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  return row;
}
