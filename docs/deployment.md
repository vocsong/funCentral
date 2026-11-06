# Deployment and migrations

## Production identity and release path

- Repository: <https://github.com/vocsong/funCentral>; default/release branch:
  **`master`**.
- Merge a reviewed PR to `master` to trigger **Cloudflare Workers Builds**.
  **Never run `npm run deploy` manually.** Its script exists, but it is not
  the release or validation workflow.
- Existing Worker/service: **`sgbridgegame`**.
- Public URL: <https://funcentral.vocs.io>, a Workers Custom Domain declared
  in `wrangler.toml` (`[[routes]]`, `custom_domain = true`; zone `vocs.io`).
- Legacy URL: <https://sgbridgegame.vocs.workers.dev> stays enabled
  (`workers_dev = true`; without it, adding routes would disable it). It still
  serves `/api/*`, so older webhooks/sockets keep working, while its pages
  forward to the public URL with path and `#ROOM` intact (`static/fc-host.js`).
- Existing D1 database: **`sg-bridge-users`**, binding **`DB`**.
- Existing secrets: **`JWT_SECRET`** and **`TELEGRAM_BOT_TOKEN`**.
- Public variable: **`TELEGRAM_BOT_USERNAME=funCentral_bot`**.
- **`ALLOW_DEV_LOGIN` must be absent in production.** It also gates Regicide
  seed/debug conveniences; it is not just a UI switch.

funCentral is the product/repository name, not a reason to rename existing
Cloudflare resources. Keep the service/database names, binding identities,
secrets and the legacy workers.dev URL so existing data, Telegram integration
and links survive.
Never put credential values in documentation, shell arguments or commits.

Run [PR validation](testing.md) before opening/updating a PR. Tests use local
storage, never deploy and do not establish production or real Telegram
compatibility. After merge, inspect the Workers Builds result and verify the
hub, game links, sign-in and relevant room/leaderboard flows on the deployed
version; do not treat a successful build alone as application verification.

## Durable Object migrations are part of deployment

`wrangler.toml` retains:

| Binding | Class | Migration |
| --- | --- | --- |
| `GAME_ROOM` | `GameRoom` | `v1` creates the existing SQLite-backed Bridge class |
| `REGICIDE_ROOM` | `RegicideRoom` | `v2` adds the separate SQLite-backed Regicide class |
| `TAIDI_ROOM` | `TaiDiRoom` | `v3` adds the separate SQLite-backed Tai Di class |
| `CONNECT4_ROOM` | `Connect4Room` | `v4` adds the separate SQLite-backed Connect 4 class |

Workers deployment applies the configured class migration. Keep `v1` and
`GAME_ROOM` intact; `v2`, `v3` and `v4` do not replace Bridge. Future games append a new
migration tag, binding and exported class. These are **not D1 SQL migrations**.

## D1 migrations are a separate controlled step

Do not assume Workers Builds runs D1 SQL migrations. Before any remote
change, confirm the target/account, inspect the actual schema **and** ledger,
read pending SQL and review its data impact. Historical environments may have
had SQL applied manually, so a missing ledger entry alone does not prove the
schema change is missing.

Read-only inspection from the repository root:

```sh
npx wrangler d1 migrations list sg-bridge-users --remote
npx wrangler d1 execute sg-bridge-users --remote --command "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name"
npx wrangler d1 execute sg-bridge-users --remote --command "SELECT id, name, applied_at FROM d1_migrations ORDER BY id"
```

If the ledger table does not exist or does not match the schema, stop and
reconcile that discrepancy before using the migration runner. Do not rerun
historical files to make the ledger appear complete. In particular,
**`0006_stats_reset.sql` resets ELO/wins/game counts and deletes history,
game records and group statistics**. It must not be replayed against existing
production data. `0010` also contains non-repeatable `ALTER TABLE` operations.

Only after inspecting/reconciling the ledger, confirming the pending list and
reviewing a recovery plan, an authorized maintainer applies migrations:

```sh
npx wrangler d1 migrations apply sg-bridge-users --remote
npx wrangler d1 migrations list sg-bridge-users --remote
```

Verify the resulting schema, ledger and affected application flows afterwards.
Use `--local` for ordinary development; never substitute `--remote` merely to
unblock a local test.

### Hub/Regicide rollout checkpoint

At the verified hub/Regicide rollout checkpoint, remote migrations
`0010_practice_in_history.sql` and `0011_regicide.sql` had been applied
successfully and the ledger showed no pending migrations. This is a
historical checkpoint, **not a permanent assertion about any environment**;
repeat the read-only inspection before future changes.

- `0010` adds participant identity to Bridge hand logs and practice metadata
  so practice games appear in participant history without affecting ratings.
- `0011` creates four Regicide tables (`regicide_ratings`, `regicide_games`,
  `regicide_rating_history`, `regicide_group_stats`) and two indexes, using
  `CREATE … IF NOT EXISTS`. It neither resets nor renames Bridge data.
- With Regicide tables missing, its gameplay remains available and
  leaderboard/stat APIs return empty data; completion persistence retries
  from its durable outbox. Bridge, including the bot's Bridge board, remains
  independent. Apply the migration rather than relying on this fallback.

### Bridge rating foundation (`0013`)

`0013_bridge_rating_foundation.sql` adds the Bridge season, archive, hand
ledger, deal-feature and shadow-rating tables (`bridge_*`) and seeds Season 1
as active. It is additive (`CREATE … IF NOT EXISTS`, one `INSERT OR IGNORE`)
and changes no existing row. Either order with the code is safe: earlier code
never reads these tables, and without them Bridge plays and records legacy
Elo, stats and history as before, only skipping the trial data (logged as a
warning per hand). Once both are live, check that new hands appear in
`bridge_game_ledger`.

Rollout checkpoint (historical, not a permanent assertion): on 2026-11-04 the
remote ledger showed `0001`–`0012` applied with `0013` as the only pending
migration; `0013` was applied ahead of the code and verified (seven `bridge_*`
tables, Season 1 seeded from the first rated hand, no pending migrations).
Time Travel bookmark before the change:
`000007bb-00000000-00005119-6a5364c238f6aa3a54cc2707f7ef028a`.

### Bridge Season 2 (`0014`)

`0014_bridge_season_2.sql` adds the Season 2 row (`season-2`, starting
2026-12-01 00:00 SGT, status `planned`) and `bridge_season_group_stats`. It
is additive and depends on `0013`. Code before the Season 2 change ignores
both; the Season 2 code needs them from the start time (until then it reads
only Season 1 data). Apply it before 1 December 2026. The season-close
runbook later marks Season 1 closed and Season 2 active.

Rollout checkpoint (historical): `0014` was applied to production on
2026-11-04, ahead of the code, as the only pending migration, and verified
(Season 2 row `planned` from 2026-11-30 16:00 UTC, the group table present,
no pending migrations). Bookmark before the change:
`000007be-00000000-00005119-b3c794481068eeb41042911c76dc9c0a`.

The Season 1 close (`docs/bridge-season-close.sql`) is **not** a migration.
It is a separate, scheduled step in the [Bridge rating](bridge-rating.md)
runbook.

## Telegram integration

The existing bot is **[@funCentral_bot](https://t.me/funCentral_bot)**. Its
webhook is `/api/telegram` on the Worker. Bot-owner webhook or domain changes
are separate intentional operations, not prerequisites for each game addition
or each release. Never include a bot-token-bearing URL in the repository.

Two bot settings follow the public URL `funcentral.vocs.io`:

- **Login Widget domain** (BotFather `/setdomain`). The widget works on one
  domain only, so sign-in on the legacy workers.dev host stops once this
  points at the public URL; that host's pages forward there anyway.
- **Webhook URL** (`https://funcentral.vocs.io/api/telegram`). Join links in
  bot messages use the origin the webhook was called on. A webhook still on
  workers.dev keeps working, but its links rely on the page forward.

`/newgame` offers inline game choices; a callback creates the chosen room in
the same group. The registered command menu (`newgame`, `leaderboard`,
`help`) is managed in code with `setMyCommands`, not a manual BotFather menu
update. Typed game shortcuts remain supported. See
[architecture](architecture.md#shared-services-and-game-boundaries) for the
catalog and static hub responsibilities.

### Connect 4 (`0015` SQL and `v4` Durable Object)

`0015_connect4.sql` creates `connect4_ratings`, `connect4_games`,
`connect4_rating_history`, `connect4_group_stats` and two indexes. It uses only
`CREATE … IF NOT EXISTS`, touches no Bridge ratings or existing game data, and
requires the existing `groups` table for group-stat foreign keys. `0013` and
`0014` belong to Bridge on this branch; do not use the older feature branch's
`0013_connect4.sql` name or replay old migrations to reconcile the ledger.

The `CONNECT4_ROOM` binding and exported `Connect4Room` class are created by the
separate `v4` SQLite DO migration during normal Workers deployment. D1 SQL is
NOT automatically applied by that class migration. Inspect the remote schema,
ledger and pending list with the read-only commands above, reconcile any manual
changes, then have an authorized maintainer apply the reviewed pending SQL in
ledger order before enabling rated Connect 4. Never replay `0006_stats_reset.sql`.
The earlier `0014` production checkpoint is historical, not evidence that `0015`
is applied in the current environment.

The host-repair, optimistic Elo concurrency, results-route and accessibility
review fixes add **no further D1 or DO migrations**. Existing stored rooms repair
on load; rating snapshots are validated inside the existing D1 batch. Missing
Connect 4 tables leave results in the durable outbox for retry; empty boards are
not a substitute for migrating. After rollout, verify schema/ledger, a human
and practice room, reconnect/rematch, separate Connect 4 ratings and group stats.
Do not deploy as part of test verification.

### Omok (`0016` SQL and `v5` Durable Object)

`0016_omok.sql` adds four independent Omok tables and two indexes. The new
`OMOK_ROOM` binding/`OmokRoom` class has an appended `v5` SQLite class migration;
existing class tags and data are preserved. These are separate migration
systems: deploying the Worker does not apply the D1 SQL. Inspect schema,
ledger and pending migrations using the workflow above, then obtain release
authorization before applying reviewed pending SQL. Never replay
`0006_stats_reset.sql`. No production migration or deployment was performed
as part of Omok implementation/testing. See [Omok](omok.md) for behavior and
verification, including the missing-schema fallback.

### Tai Di migration (inspect current pending list)

`0012_taidi.sql` creates four Tai Di tables (`taidi_ratings`, `taidi_games`,
`taidi_rating_history`, `taidi_group_stats`) and two indexes, using
`CREATE … IF NOT EXISTS`; it touches no existing data. Like `0011`, apply it
as the separate controlled D1 step after inspecting the remote schema, ledger
and pending list. Until it is applied, Tai Di gameplay still works: results
stay in the room's durable outbox and retry every minute, and the Tai Di
leaderboard and stats APIs return empty data. Do not rely on that fallback in
place of applying the migration.
