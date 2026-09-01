# Security events

Every security-relevant occurrence in the app is one pino JSON line with a
`tag` field in the `sec.<area>.<event>` namespace (PLAN.md §12, "structured
security events"). The source of truth is `server/src/security-events.ts`
(`SecurityEvent` and `SECURITY_EVENT_LEVEL`); a unit test fails if a tag is
added there without a row here.

Shape of a line (fields beyond the standard pino ones are listed per tag):

```json
{"level":40,"time":1756700000000,"pid":1,"hostname":"app","reqId":"req-1a","tag":"sec.ban.created","ipPrefix":"198.51.100.7","strikes":1,"banMinutes":15,"bannedUntil":"2026-09-01T03:15:00.000Z","msg":"sec.ban.created"}
```

`msg` always equals `tag`, so both plain-text and structured pipelines can key
on it. `reqId` is present when the event happened inside a request.

## Reading and alerting

```sh
# everything security-tagged
docker compose -f deploy/docker-compose.yml logs --no-log-prefix app | jq -c 'select(.tag? // "" | startswith("sec."))'

# bans and breaker transitions only
... | jq -c 'select(.tag? // "" | test("^sec\\.(ban|breaker)\\."))'

# count by tag over a log file
jq -r '.tag? // empty' app.log | sort | uniq -c | sort -rn
```

Suggested alert lines for a single friends-scale node (PLAN.md §2 — no
monitoring stack, just tagged logs): page on any `sec.breaker.opened`,
`sec.proxy.permissive_trust` or `sec.purge.failed`; review daily counts of
`sec.ban.created`, `sec.auth.token_rejected` and `sec.auth.forbidden`.

## Taxonomy

Levels: `info` = expected operational fact, `warn` = someone is misbehaving or
a limit tripped, `error` = something needs an operator.

### Guard — per-IP bans (§12)

| Tag | Level | Fields | When |
| --- | --- | --- | --- |
| `sec.ban.created` | warn | `ipPrefix`, `strikes`, `banMinutes`, `bannedUntil` | Invalid-lookup budget exceeded on `/s/*` or `/reset/*`; ban persisted to `ip_bans` |
| `sec.ban.expired` | info | `ipPrefix`, `strikes` | Ban lapsed (emitted lazily on the first request after expiry); strikes are retained |
| `sec.ban.lifted` | warn | `ipPrefix` | Admin unban dropped the in-memory ban; the paired `sec.admin.mutation` carries the actor |

### Guard — global breaker (§12)

| Tag | Level | Fields | When |
| --- | --- | --- | --- |
| `sec.breaker.opened` | error | `reason` (`invalid_rate` \| `half_open_failed`), `cooldownSeconds` | Aggregate invalid lookups exceeded `RATE_BREAKER_INVALID_PER_MIN`, or half-open probes kept missing |
| `sec.breaker.half_open` | warn | — | Cool-down elapsed; anonymous traffic admitted on probation |
| `sec.breaker.closed` | info | — | A clean minute in half-open |

### Throttles

| Tag | Level | Fields | When |
| --- | --- | --- | --- |
| `sec.throttle.general` | warn | `ipPrefix`, `retryAfterSeconds`, `path` | Anonymous per-IP general cap (`RATE_GENERAL_PER_MIN`) refused a request; `path` has secret segments truncated |
| `sec.throttle.login` | warn | `username`, `retryAfterSeconds`, `ip` | Per-account login backoff refused an attempt (keyed by the attempted username, real or not) |

### Authentication and authorization (§8, §11)

| Tag | Level | Fields | When |
| --- | --- | --- | --- |
| `sec.auth.login_failed` | info | `username`, `lockSeconds`, `ip` | Wrong password, unknown user or disabled account (indistinguishable by design) |
| `sec.auth.token_rejected` | warn | `ip`, `path` | Bearer route (`/api/v1/captures`, `/api/v1/ping`) saw a missing, unknown, revoked or disabled-user token |
| `sec.auth.session_rejected` | info | `ip`, `path` | Session-required route saw no valid session (expired cookies land here too) |
| `sec.auth.csrf_rejected` | warn | `userId`, `ip`, `path` | Signed-in request without a matching `x-csrf-token` |
| `sec.auth.forbidden` | warn | `reason` (`admin_required` \| `not_owner`), `userId`, `ip`, `path` | Authenticated user reached a route they may not use |
| `sec.auth.link_rejected` | warn | `ip` | `POST /api/v1/auth/set-password` with a malformed, unknown, consumed or expired token (counts against the invalid-lookup budget) |
| `sec.auth.link_consumed` | info | `userId`, `linkId`, `purpose`, `ip` | One-time link used; other sessions of the user were revoked |

### Admin panel (§11)

| Tag | Level | Fields | When |
| --- | --- | --- | --- |
| `sec.admin.mutation` | info | `action`, `actorUserId`, `targetType`, `targetId`, `ip` | Emitted after each audited transaction commits; `action` matches the `audit_log.action` value (`settings.registration`, `user.create`, `user.disable`, `user.enable`, `link.issue`, `capture.retention`, `capture.delete`, `guard.unban`) |

### Retention purge (§13)

| Tag | Level | Fields | When |
| --- | --- | --- | --- |
| `sec.purge.completed` | info | `expired`, `filesRemoved`, `sweptFiles`, `hardDeleted`, `errors`, `ms` | Every hourly pass (and the one at boot) |
| `sec.purge.file_error` | error | `captureId`, `err` | An unlink failed; the row is left for the next pass |
| `sec.purge.failed` | error | `err` | A pass aborted (database unreachable, …) |

### Server-side faults and configuration

| Tag | Level | Fields | When |
| --- | --- | --- | --- |
| `sec.image.missing_file` | error | `captureId` | A live capture's file is gone; the viewer got the uniform 404 and the guard was not charged |
| `sec.proxy.permissive_trust` | error | `trustProxy` | Boot with `TRUST_PROXY=true` (or a `/0` CIDR): any peer can choose the IP the guard keys on. Expected only under the loadtest compose profile — never in production |

## What never appears (CLAUDE.md rule 3)

- `view_id`s, API tokens, reset-link tokens, session cookies, passwords. Secret
  path segments are truncated to 8 characters (`/s/AbCdEfGh…`).
- Captures are referenced by internal row id (`captureId`), users by `userId`.
- pino redaction (`server/src/log.ts`, `REDACT_PATHS`) additionally censors
  `authorization` / `cookie` / `set-cookie` / `x-csrf-token` headers and any
  object logged with a `password`, `token`, `csrfToken`, `resetUrl`,
  `sessionSecret` or `databaseUrl` key at the top level or one level down.

The backup container (`deploy/backup/`) logs plain text with the same tag
words — `sec.backup.completed` / `sec.backup.failed` — and prints no
connection strings or repository URLs.
