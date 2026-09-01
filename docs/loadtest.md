# Guard load test (k6)

The k6 enumeration simulation PLAN.md §16 asks for: proof that the guard
(§12) bans a single enumerating IP without touching anyone else, that a
distributed crawl opens the global breaker, that authenticated sessions keep
working while it is open, that it recovers, and a latency baseline for
legitimate traffic. Scenarios live in `loadtest/scenarios/`, k6 runs as a
container (`grafana/k6:1.3.0`) — never an npm dependency — and none of this
runs in default CI: it takes ~4 minutes, needs Docker, and its purpose is to
re-measure after guard changes, not to gate every commit.

## Running it

```sh
pnpm loadtest                 # ban, breaker, baseline — ~4 min, tears down after
pnpm loadtest breaker         # one scenario
KEEP=1 pnpm loadtest ban      # leave the stack up (app on http://127.0.0.1:3100)
```

`loadtest/run.sh` brings up a **separate compose project**
(`deploy/docker-compose.loadtest.yml` layered over `deploy/docker-compose.yml`;
project name `snapping-turtle-loadtest`, its own volumes, fresh database),
seeds a throwaway admin with a fixed non-secret password, checks that the app
logged `sec.proxy.permissive_trust`, runs each scenario in the k6 container,
prints the security events the app emitted, and removes the project with its
volumes. Raw k6 output lands in `loadtest/results/<scenario>.txt`
(git-ignored).

### What the profile changes, and why it cannot leak

| Setting                         | Production          | Loadtest profile               | Why                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`                   | Caddy's subnet CIDR | `true`                         | k6 hits `app:3000` directly and asserts virtual client IPs with `X-Forwarded-For`. The app logs `sec.proxy.permissive_trust` at **error** level on every boot with this setting; `run.sh` refuses to continue unless it sees that line, and that line on a production box is an incident (`docs/security-events.md`). |
| `RATE_BREAKER_COOLDOWN_SECONDS` | 300                 | 30                             | So half-open recovery fits in a two-minute run. Every other `RATE_*` knob keeps its production default: budget 5 / 10 min, breaker 100/min, ladder 15,60,1440, general cap 60/min.                                                                                                                                    |
| Caddy, backup sidecar           | running             | parked behind compose profiles | k6 needs the app directly (Caddy would overwrite `X-Forwarded-For`); nothing to back up.                                                                                                                                                                                                                              |
| `web` network subnet            | 172.28.101.0/24     | 172.28.102.0/24                | Both projects can exist on one host.                                                                                                                                                                                                                                                                                  |

Nothing in the app changes: the override only sets environment variables the
production compose file already exposes, and there is no code path that
knows it is being load-tested (CLAUDE.md rule 9).

## Scenarios and thresholds

Each scenario's `setup()` signs in as the seeded admin, mints an API token,
uploads `loadtest/fixture.png` through the real upload route and uses the
returned capability path as "the valid link". Setup traffic comes from its
own IP so it never counts against a scenario's budget.

### (a) `ban.js` — single-IP enumeration is banned; a friend never notices

- **Attacker** `198.51.100.7`: 4 well-formed but non-existent `/s/<id>`
  lookups per second for 15 s.
- **Friend** `203.0.113.9`: the valid link every 1.5 s for 20 s (40/min —
  inside the anonymous general cap).

| Threshold                                           | Meaning                                                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attacker_404: count<=6`                            | Exactly budget+1 misses are answered with the uniform 404 (the 6th miss is the one that trips the ban and is itself a 404); nothing more leaks.                  |
| `attacker_429: count>0`, `time_to_ban_ms: max<5000` | The ban lands within the budget window.                                                                                                                          |
| `attacker_valid_link_blocked: count>0` + checks     | Once banned, the attacker's request for the **valid** link is the byte-identical guard 429 with `Retry-After` on the 15-minute rung — the ban closes the oracle. |
| `checks{scenario:friend}: rate==1`                  | Every friend request is a 200 throughout.                                                                                                                        |

### (b) `breaker.js` — distributed crawl opens the breaker; sessions pass; it recovers

- **Crawl**: 150 misses from 150 distinct virtual IPs (`10.66.x.y`), one
  each — no IP reaches its own budget, so only the aggregate rate can react.
- **Anonymous viewer** `203.0.113.20`: the valid link every 1.5 s for 130 s.
- **Owner** `203.0.113.21`: the same link with the owner's session cookie,
  same cadence.
- **Teardown**: reads `/api/v1/admin/guard` and fails the run unless the
  breaker is `closed`.

| Threshold                                            | Meaning                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `anon_429_while_open: count>0`                       | The breaker opened and anonymous traffic to a valid link got the guard 429.                                                     |
| `checks{check:retry-after within cooldown}: rate==1` | Every such 429 carried `Retry-After` ≤ the cool-down.                                                                           |
| `checks{scenario:owner}: rate==1`                    | The authenticated owner was never collateral damage.                                                                            |
| `anon_200_after_open: count>0`                       | After the cool-down the first anonymous request half-opened the breaker and was served.                                         |
| `checks{phase:after}: rate==1`                       | In the last 20 s (≥ 110 s in, after the clean minute) anonymous traffic is 100 % 200s; teardown confirms the state is `closed`. |

### (c) `baseline.js` — legitimate traffic latency budget

- 30 viewer IPs (`10.77.0.<vu>`), combined 10 iterations/s for 60 s; each
  iteration fetches the capture page and `image.png` (20 req/min per IP, well
  inside the general cap). Setup saves one rectangle and one text
  annotation so the first image request goes through the flat renderer and
  the rest hit the per-capture cache — the production shape.

| Threshold                                                       | Meaning                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `http_req_duration{name:page}: p(95)<150`                       | Capture page p95 budget (ms).                                                           |
| `http_req_duration{name:image}: p(95)<150`                      | Flat image p95 budget (ms).                                                             |
| `http_req_failed{scenario:viewers}: rate==0`, `checks: rate==1` | No viewer was throttled or banned; teardown prints the guard state as a second witness. |

The budgets are for a laptop running Docker Desktop with k6 in a sibling
container; they are deliberately loose enough to survive CPU noise and tight
enough to catch a regression that puts a database round-trip or a render on
the hot path. Re-measure and adjust them when the deployment target changes.

## Results (2026-09-01, MacBook, Docker Desktop, k6 1.3.0, guard defaults except cool-down 30 s)

`pnpm loadtest` — all three scenarios PASS; the app emitted exactly one
`sec.ban.created`, one `sec.breaker.opened`, one `sec.breaker.half_open`, one
`sec.breaker.closed`, plus the boot-time `sec.proxy.permissive_trust` and
`sec.purge.completed`.

**(a) ban** — `attacker_404 = 6` (budget 5 + the trip), first 429 after
**1.5 s**; 54 further attacker requests blocked, the attacker's valid-link
fetch was the byte-identical guard 429 with `Retry-After` on the 900 s rung;
friend: 77/77 checks, 100 % 200s. Overall `http_req_failed` 77 % is the
attacker being refused, as intended.

**(b) breaker** — 150 misses from 150 IPs (delivered in ~1 s) opened the
breaker; the anonymous viewer saw **20 × 429** for the valid link, every one
with `Retry-After ≤ 30`; the owner's session **100 % 200** throughout; after
the cool-down the anonymous viewer was served again (**66 × 200** after the
open phase), the last 20 s were 100 % clean and teardown read the breaker as
`closed`. The un-tagged "anon valid link served" check reads 77 % overall —
that is the 20 blocked requests during the open phase, which is the behaviour
under test; the thresholds are on the phase-tagged checks.

**(c) baseline** — 1,200 viewer requests at 20 req/s over 60 s, 0 failures,
no bans, breaker `closed`: page **p95 8.6 ms** (avg 5.6, max 18), image
**p95 4.5 ms** (avg 3.2, max 23.5 — the max is the one flat render on first
request; every later one is the cache hit). Budgets stay at 150 ms: ~17× the
measured page p95, loose enough for CI-class noise, tight enough that a
render or database round-trip added to the hot path (~50–100 ms here) would
fail it.

**Threshold tuning:** none. The production defaults (`RATE_INVALID_LOOKUP_BUDGET=5`,
`RATE_BREAKER_INVALID_PER_MIN=100`, `RATE_BAN_LADDER_MINUTES=15,60,1440`,
`RATE_GENERAL_PER_MIN=60`) behaved exactly as PLAN.md §12 specifies; the only
non-default value in the run is the loadtest profile's 30 s breaker cool-down
(production keeps 300 s). PLAN.md §12 is unchanged.
