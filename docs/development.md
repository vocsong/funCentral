# Local development

The current app is the TypeScript Worker and the `static/` frontend, not the
archived Python bot. Start with the [architecture](architecture.md) for game
boundaries and [testing](testing.md) for PR validation.

## Checkout and dependencies

```sh
git clone https://github.com/vocsong/funCentral.git
cd funCentral
npm ci --include=dev
```

Use Node.js 22.23.4+ (22.x), 24.22.1+ (24.x), or 26.12.1+;
`.nvmrc` pins the verified 22.x release. Upgrade your system Node before
installing dependencies or starting dev servers, and configure build/CI
runtimes to use a patched release too. `package.json` declares these floors.

These floors include the Node2Shell fix (CVE-2026-111497), an out-of-bounds
write in the bundled Brotli decoder. Updating npm packages or obtaining a
clean `npm audit` does **not** patch Node itself. See the
[Node.js October 2026 security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
Production runs on Cloudflare Workers/workerd, not this local Node binary;
Cloudflare's managed runtime patch status must be verified separately.

The scoped `gitnexus` → `glob` override selects glob 14.0.3+ and its patched
minimatch 11.x dependency for GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249.
Remove it when GitNexus's own dependency range includes patched versions,
then reinstall and repeat the audit and tooling checks.
All app tooling is in `devDependencies`: an environment that omits dev
packages must explicitly include them. Use the lockfile, not a global
Wrangler install, as the tooling source of truth.

The default branch is `master`. Work on a feature branch and merge via PR;
merging to `master` triggers a production build/deployment.

## Local-only configuration

Create `.dev.vars` at the repository root:

```dotenv
JWT_SECRET=local-development-only-not-a-production-secret
ALLOW_DEV_LOGIN=1
```

These are safe local placeholders, not production credentials. `.dev.vars`
is gitignored and must stay uncommitted. Do not copy production secrets into
examples or test commands. `.env.example` and `start_local.sh` belong to the
archived Python implementation and are not Worker setup instructions.

Telegram's Login Widget does not work on localhost. On `localhost` or
`127.0.0.1`, the Bridge, Regicide and Tai Di login screens expose **Dev Login**.
With `ALLOW_DEV_LOGIN=1`, `/api/auth/dev` creates a local profile and signed
token; the same display name maps to the same synthetic identity. Both
games share the sign-in token and profile. Production must have
`ALLOW_DEV_LOGIN` **absent**; never enable dev auth/debug routes there.

Local dev login does not require a real Telegram bot token. Do not exercise
real bot/webhook commands from local development unless intentionally
configured; automated bot coverage captures outbound requests instead.

## Initialize local D1 and run

Wrangler uses local D1 and Durable Object storage with the checked-in
configuration. On a fresh local database:

```sh
npx wrangler d1 migrations list sg-bridge-users --local
npx wrangler d1 migrations apply sg-bridge-users --local
npm run dev
```

For an existing local database, inspect its schema and migration ledger
before applying pending SQL. `0006_stats_reset.sql` resets statistics; do
not blindly replay SQL files against data you want to keep. The migration
ledger, not repeated `--file` commands, should determine what runs.
See [deployment](deployment.md) for the stricter remote workflow.

Open the localhost URL printed by Wrangler (normally port 8787):

| URL | Purpose |
| --- | --- |
| `/` | funCentral game hub and shared leaderboard |
| `/bridge/` | Bridge home, rooms, history/replay and statistics |
| `/regicide/` | Regicide home and rooms |
| `/regicide/?view=stats` | Regicide statistics |
| `/taidi/` | Tai Di home and rooms |
| `/taidi/?view=stats` | Tai Di statistics |
| `/omok/` | Omok home, practice and multiplayer rooms |
| `/omok/?view=stats` | Separate Omok statistics |

Create a room after signing in and open another browser context to join as
a different player. Separate contexts avoid sharing `localStorage` identity.
Wrangler's local state lives under `.wrangler/`; automated suites create
and clean their own temporary storage rather than using production D1.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local Worker, room Durable Objects and static assets |
| `npm run typecheck` | TypeScript check without emitting files |
| `npm test -- --maxWorkers=2` | Bounded Vitest rules/unit/runtime regressions |
| `npm run test:e2e` | Selected live-worker and browser interaction suites |
| `npm run test:ui` | Complete Chromium Playwright suite |
| `npm run test:pr` | Typecheck, bounded Vitest, full browser suite and repeated 2.5D hand suite |

A compatible browser must already be installed/configured; no test command
installs one. Use [testing](testing.md) for ports, coverage boundaries and
reporting. Do not run `npm run deploy` as a development or validation step.

For a new mini app, follow the [extension checklist](architecture.md#adding-another-game)
instead of moving Bridge's established files or copying its state machine.
