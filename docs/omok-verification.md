# Omok implementation verification — 6 November 2026

Implementation is local on branch `codex/omok`, based on master commit
`593f33c` (the merged Connect 4 PR #86). No push, PR, merge, production SQL
migration or deployment was performed.

## Delivered experience

- Original wood-board/black-and-white-stone presentation inside the shared
  funCentral shell, responsive lobby/home/results, and a fifth main-lobby tile.
  Desktop uses a balanced three-card row followed by the two board games.
- Complete freestyle 15×15 rules, practice bot, live human games, public
  spectators, shared sign-in, room codes/invites, move log, optional sound,
  alternating black on rematch, resignation and independent ratings/stats.
- Touch preview/confirmation, optional enlarged scrollable board, stable
  roving keyboard grid, coordinates, last-move/winning-run labels, reduced
  motion and focus-contained dialogs.
- Game-id/move-number validation, server-timed opening reveal, automatic
  ordinary reconnect and explicit duplicate-window takeover. Durable bot
  scheduling, transactional ratings and an outbox survive faults/restarts.

See [the game guide](omok.md) for rules and product assumptions, including
overlines, no forbidden moves/turn clock and the bot's intentionally casual
strength. Migration requirements are documented there and in
[deployment](deployment.md).

## Checks

The verification runtime is Node **24.22.1**, Vitest **4.1.12**, Playwright
**1.64.1**, headless system Chrome **156.0.8078.79**, on Windows.
`npm ci --include=dev` installed the locked tooling (zero audit findings).

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| Omok rules, room, ratings, persistence and concurrency in the final runner | 64 tests passed across 6 files |
| Omok browser suites in the final runner | 13 passed, 0 failed, 0 skipped |
| Pre-review targeted Chromium: Connect 4 splash, Omok live/missing-schema, Tai Di live | 24 passed, 0 failed, 0 skipped |
| Review targeted Chromium: Bridge seasons, Connect 4 splash, Omok live/missing-schema/review | 21 passed, 0 failed, 0 skipped |
| `PLAYWRIGHT_CHANNEL=chrome npm run test:pr` — final reviewed typecheck/Vitest | Passed; 45 files, 470 tests passed, 0 failed/skipped |
| Same runner — complete Chromium suite | 259 passed, 0 failed, 6 intentional capture-only skips |
| Same runner — complete 2.5D hand-layout repeat | 57 passed, 0 failed, 3 intentional capture-only skips |
| `git diff --check` | Passed |

The initial focused runs found a cold-restart cleanup bug and a missing
duplicate-window pause handler; both were fixed and the affected tests passed.
An additional shared-board assertion was updated to handle multiple ranked
players. These failures were investigated, not hidden with test retries.

The first full runner passed all 469 unit tests, then reported 247 browser
passes, 8 failures and 6 intentional capture-only skips. Seven failures used
four-game assertions already loaded before their correction. The eighth was
Tai Di startup: Chrome reported `ERR_NO_BUFFER_SPACE` while loading
`fc-auth.js`, then `FunAuth is not defined`. Its trace was inspected and
preserved. The corrected splash, Omok and complete Tai Di suites passed in
a fresh 24-test targeted run; a clean full run verifies the final revision.
The original clean full runner completed successfully with 469 unit tests,
255 Chromium passes (6 skips) and 57 2.5D passes (3 skips). Its
[original check log](evidence/omok/pr-checks.txt) is retained.

An [independent review](omok-review.md) then reproduced and repaired two timing
defects: delayed Omok leaderboard I/O blocked existing boards, and old rating
I/O could hold up a new practice bot turn. The review adds real Worker identity
and production-flag checks plus stale-response/focus coverage. The final
reviewed full runner completed with exit code 0 and the updated counts above;
its [reviewed check log](evidence/omok/review-pr-checks.txt) is also retained.
The review separately records a pre-existing webhook-secret validation concern
that is unchanged from the base revision.

GitNexus indexed the checkout and checked changed execution flows. Its initial
shared-path check was high impact. The final whole-change sweep, including the
new game and independent review, rates the aggregate scope **critical**: 57 files, 560 symbols and
45 affected flows. This impact finding should be considered during review;
the shared router/leaderboard paths retain the full application regression
run rather than relying only on Omok checks. Changes remain uncommitted.

## Browser and visual coverage

Omok's live browser tests use **1366×900 desktop**, **390×844 touch emulation**
and **320×844 touch emulation**. Mobile contexts set `isMobile` and `hasTouch`
and invoke Playwright's real touchscreen `tap()` input. Tests use the actual
bundled Worker, SQLite D1, Durable Objects, auth and WebSockets. Two-client
human wins are played with nine legal moves, including client reloads, guest
watching, a persisted result and an alternating-colour rematch. Practice is
tested through real human placement, an alarm-driven reply and resignation.

Keyboard tests verify one grid Tab stop, arrow navigation, preview/cancel/
commit, Chromium's accessibility tree, modal focus containment and focus return.
Stats sorting is also keyboard-operable, exposes sort direction and retains
focus. Malformed invite hashes return safely to home. The mobile played round
also runs with reduced-motion preference enabled.
Narrow-screen tests place a stone at O15 in the enlarged scrollable board and
check page containment. Missing-schema tests deliberately omit 0016 and retain
working gameplay, empty Omok boards/stats and Bridge creation. Separate room
tests restore the schema and verify durable results recover.

The following screenshots were generated from that local Worker and visually
reviewed; test credentials and leaderboard seed rows are local fixtures.

| Screen | Desktop | Mobile |
| --- | --- | --- |
| Main lobby | [Hub](evidence/omok/hub-desktop.png) | [Hub](evidence/omok/hub-mobile.png) |
| Omok home | [Home](evidence/omok/home-desktop.png) | [Home](evidence/omok/home-mobile.png) |
| Room lobby | [Lobby](evidence/omok/lobby-desktop.png) | [Lobby](evidence/omok/lobby-mobile.png) |
| Live board | [Game](evidence/omok/game-desktop.png) | [Game](evidence/omok/game-mobile.png) |
| Results | [Results](evidence/omok/results-desktop.png) | [Results](evidence/omok/results-mobile.png) |

[320px board](evidence/omok/game-320px.png) is also retained. Screenshots disable
animations to capture settled states; interactive tests exercise the normal
motion path. Shared lobby/Connect 4 regression coverage also checks 320, 390,
490, 768 and 1366px layouts.

## Limits and release work

No physical phone, Safari/WebKit, Firefox, Telegram WebView, manual screen
reader, production networking or authenticated production game was tested.
External fonts and Telegram are blocked/captured in browser tests. Chromium
accessibility-tree assertions do not establish manual assistive-technology
compatibility. Group chooser tests capture outbound Bot API calls locally.

Before rollout, review/apply additive D1 migration `0016_omok.sql` separately
from the appended `v5` Durable Object class migration, through an authorized
release. Verify live auth, human/practice play, reconnect/rematch and group
boards after deployment. No production resource or credential changed here.
