# deploy/caddy.d — extra Caddy site blocks

Every `*.caddy` file here is bind-mounted into the Caddy container at
`/etc/caddy/sites.d/` and imported after the main `{$PUBLIC_HOST}` site block
(both `Caddyfile` and `Caddyfile.local`). The directory is normally empty.

Its one intended use is the **old-domain redirect during a domain migration**
(`docs/runbooks/domain-migration.md`): copy `old-domain.caddy.example` to
`old-domain.caddy`, put the previous hostname in it, and `docker compose up -d`.
Caddy then obtains and renews a certificate for the old name too and answers
every request on it with a `308` to the same path and query on `PUBLIC_HOST`.

`*.caddy` files are git-ignored (they are deployment state, like `.env`);
`caddy validate` runs on the whole config, so a typo here stops Caddy from
starting — the rehearsal script `deploy/test-domain-migration.sh` exercises
the exact block shape.
