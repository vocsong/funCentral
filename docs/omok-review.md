# Omok independent implementation review — 6 November 2026

Reviewed the completed local change against base `593f33c`, with emphasis on
shared routing/leaderboard impact, game correctness, identity boundaries,
result durability, migrations and other-game regressions. No push, merge,
production migration, deployment or live Telegram message was performed.

## Verified defects fixed

1. **A delayed Omok leaderboard blocked existing boards.** The shared mount
   awaited Omok before its first render. A captured, held Omok response left a
   ready Bridge leaderboard blank. Omok now loads independently, while the
   existing boards render and the caller can continue. Late results preserve
   the selected tab and keyboard focus. Mount revisions also discard stale
   Omok and Bridge-season responses after a newer mount.
2. **Old rating I/O could stall a new practice bot turn.** The room alarm
   awaited a pending result before processing a due bot move. A real local
   workerd test held the previous human result's rating read, started the next
   practice round, and observed the bot remain at zero moves. Alarms now
   trigger the durable rating work in the background, process due gameplay
   immediately, and retain the existing retry/cleanup safeguards. Tests poll
   the durable result instead of assuming alarm responses await external I/O.

Both reproductions failed before the fixes and passed after them. They are
retained in `tests/omok-room.test.ts` and `tests/ui/omok-review.pw.js`.

## Security, rules and migration findings

- Real Worker/JWT checks with `ALLOW_DEV_LOGIN=0` confirm profile names and
  verified IDs override URL/message names and IDs. Missing, tampered and
  expired credentials remain guests, cannot take seats, and do not displace
  the authenticated player's socket.
- Production-like flags reject `/api/auth/dev` and Omok debug patches with
  404; an attempted patch leaves the active game unchanged. Bad room codes
  return 400. Move coordinates, turns, duplicate/stale submissions, spectators
  and resignation stay server-authoritative.
- Engine review found no further rules defect: black starts independently of
  seat order, the four line directions handle edges/gaps and overlines, a
  winning last move outranks a draw, and completed games reject further moves.
- Exact `/api/omok/*` routes use only `OMOK_ROOM`. Existing game routes and
  rating tables retain their identities. Separate Omok D1 batches guard both
  players' snapshots and completion idempotence; prior persistence/concurrency
  and lost-acknowledgement regressions remain required.
- Only new `0016_omok.sql` is added to migrations. It creates four `omok_*`
  tables and two indexes with `IF NOT EXISTS`; existing SQL files, including
  the historical reset, are unchanged. `v5` adds `OmokRoom` without changing
  prior bindings/tags. Production schema/ledger must be inspected before an
  independently authorized migration/release.

## Pre-existing security consideration outside the Omok delta

The Worker source at `src/index.ts`'s `/api/telegram` handler accepts and parses
POST bodies without validating a webhook secret. This is also present in
unchanged base `593f33c`; local captured-webhook tests deliberately send
unsigned fixture updates. External edge protection and production webhook
configuration were not inspected, so this is a verified source-level gap,
not a claim that production perimeter controls were tested.

Consider a coordinated hardening change before expanding public Telegram use:
configure a shared webhook secret and verify the
`X-Telegram-Bot-Api-Secret-Token` header before dispatch. Telegram supports that
header through `setWebhook.secret_token` in its
[official Bot API](https://core.telegram.org/bots/api#setwebhook). This review
does not change the existing bot's authentication/configuration or register a
new webhook; doing so requires separate release coordination.

## Verification and visual delivery

- Focused post-fix room suite: **9 passed**.
- Targeted browser regression (Bridge seasons, shared splash, Omok live,
  missing schema and review/security cases): **21 passed**, zero failures/skips.
- Final complete `npm run test:pr` runner: typecheck passed; **470 unit/runtime
  tests in 45 files passed**; **259 Chromium tests passed, 6 intentional capture
  skips**; **57 additional 2.5D hand-layout tests passed, 3 intentional capture
  skips**. Zero failed tests; runner exit code 0. The complete output is saved
  in [the reviewed check log](evidence/omok/review-pr-checks.txt).
- Desktop/mobile game and main-lobby screenshots were saved as native Library
  images: `funCentral-Omok-desktop.png`, `funCentral-Omok-mobile.png`,
  `funCentral-lobby-desktop.png`, `funCentral-lobby-mobile.png`.

The upload confirmation succeeded for all four images. Their native Library
links are included in the review handoff; the repository retains the local
screenshots for portable visual evidence.

Full command counts, viewport/touch/browser versions, earlier failures and
remaining physical-device/assistive-technology gaps are in
[Omok verification](omok-verification.md). The aggregate GitNexus impact
classification remains a reason for careful shared-path review, not a substitute
for the observed failures/fixes and full regression checks.
