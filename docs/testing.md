# funCentral PR validation

Run `npm ci --include=dev` using the locked dependencies, then use an already
available Playwright browser. All app tooling is in `devDependencies`. No
test command installs a browser, requires a Cloudflare account, accesses
production D1 or deploys the app. See [development](development.md) for manual
local setup; suites create their own local bindings/data.

## Required runner

For an installed system Chrome, in PowerShell:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm run test:pr
```

Or in a POSIX shell:

```sh
PLAYWRIGHT_CHANNEL=chrome npm run test:pr
```

If the matching Playwright Chromium is already installed, omit the environment
variable. Firefox/WebKit require their own supported installed engines and
appropriate test adaptations; CDP touch tests specifically require Chromium.
Changing only the user agent does not establish cross-engine coverage.

`package.json`, `tests/run-pr-checks.cjs` and `playwright.config.js` are the
source of truth. The PR runner stops on failure and runs, in order:

1. `tsc --noEmit`.
2. Vitest with `--maxWorkers=2`.
3. The **complete Chromium Playwright suite**, one browser worker, with
   `HAND_TABLE_VIEW=classic`.
4. The complete `tests/ui/hand-layout.pw.js` suite again with
   `HAND_TABLE_VIEW=25d`.

Some live Bridge cases explicitly exercise both views within the main suite.
The final repeat is the hand-layout suite, not every browser test in 2.5D.

## Coverage and boundaries

| Layer | What is checked |
| --- | --- |
| TypeScript / Vitest | Bridge rules/bots, shared auth/names, statistics/history, persistent chat and storage ordering/lifecycle; Regicide and Tai Di rules, rating calculations and database behavior |
| Regicide runtime persistence | Eight focused regressions in `tests/regicide-persistence.test.ts` and `tests/regicide-concurrency.test.ts`, using `regicide-persistence-harness.ts`: real Miniflare/workerd, D1/SQLite transactions, rollback/retry, overlapping duplicate completions, additive cross-room rating updates, delayed group joins, delayed rating acknowledgements, durable outbox recovery across restart and retention through idle cleanup/retry. `tests/regicide-spectators.test.ts` uses the same harness for the watcher list (guest and signed-in arrivals/departures broadcast, no hand, no mid-game seat or action) |
| Bridge completion persistence | `tests/bridge-persistence.test.ts` with `bridge-persistence-harness.ts` (real Miniflare/workerd and D1): a finished hand recorded once across legacy stats, group stats, replay log, rating trial and one group post; a failed rated transaction rolling back and retrying once after restart; committed hands not reapplied; concurrent hands adding Elo for a shared player; Bridge without migration `0013`; the all-pass redeal hand log; abandoned hands. `tests/bridge-rating-queries.test.ts` runs every documented trial query and the Season 1 close statements. `tests/bridge-season-2.test.ts`: Season 2 hands rated fresh without touching Season 1 tables, boards/stats/rating changes per season, leavers charged, a missing snapshot rated from current ratings, bot-dealt hands unrated, and the season assigned at the deal |
| Bridge seasons live E2E | `tests/ui/bridge-seasons.pw.js` with the clock pinned inside Season 2 (`TEST_NOW_MS`, dev-only): fresh Season 2 board with provisional markers, the Season 1 final board through the card's season switch and the stats screen's season menu, and the bot's season-named group board, at desktop and 390px mobile emulation |
| Bridge live game E2E | Local Worker + SQLite Durable Object + actual WebSockets: four-player create/join, bid/pass, partner selection, legal mouse/touch play until the contract resolves, keyboard illegality guards, results, refresh/reconnect and live view switching |
| Bridge live update recovery | `tests/bridge-sync.test.ts` checks timeouts, foreground/network wakeups, correlated snapshots, input locks, pending-card recovery and private read-only views. `tests/ui/bridge-sync.pw.js` runs real four-player deals in Classic/2.5D, suppresses selected incoming state broadcasts while a legal card is played, and verifies periodic recovery on the same open socket. It also blackholes an open connection, verifies automatic replacement and late-frame rejection, refreshes on page return, and checks intentional leave cancels recovery. Uses real local Worker/auth/SQLite/WebSockets with controlled browser transport faults and time; this is not production network or physical-device evidence. |
| Bridge creator regression | A creator with stale spectator state is seated as a player; leaving spectator mode does not contaminate the next created room, including reload/reconnect |
| Identity live E2E | Real profile endpoints, database, signed synthetic auth and WebSockets: name recovery, delayed/stale responses, invalid credentials, reconnect/session replacement; a bare or invalid-token `tg_` ID neither replaces the signed-in owner's socket nor takes a seat |
| Router authentication | `tests/request-auth.test.ts` runs the real Worker router under Vitest with inert room exports, real JWT helpers and spied Telegram/D1/room side effects: Bridge `/api/ws` grants `tg_` only from a valid JWT (missing/empty/malformed/wrong-key/expired tokens become `guest_`), always strips the token, keeps guest IDs stable and bounded and preserves the upgrade request; `/api/telegram` returns 503/401 before reading the update or any side effect when the secret is unset or the header is missing/wrong (dev login enabled), and processes a matching command. Not live WebSocket or Telegram evidence. |
| Connect 4 review smoke | `tests/ui/connect4-review.pw.js` and `connect4-modal-stack.pw.js`: real legal human/bot games, both humans dismissing results, same-player rematch, explicit leave after a completed practice game and next-human management after reload; offline/reload/replacement during play; malformed frames; all six chosen-colour names exposed in Chromium's accessibility tree without 42 tab stops; rules/confirmation/results focus trapping, inert background and nested-modal restoration |
| Connect 4 fault/concurrency chaos | `tests/connect4-concurrency.test.ts` compares actual D1 tables with a sequential oracle after forced overlapping input snapshots, at game 30, with a shared second-seat player and draws; bounded retry exhaustion, rollback at the last write, duplicates, reordered completions and lost acknowledgements. `tests/connect4-review-room.test.ts` uses real workerd rooms for two-object game-30 contention, host repair after restart, malformed/repeated messages, socket replacement, delayed rating acknowledgements across a new round/disconnect, durable retry after D1 failure/restart and no idle purge while results remain pending. Fixtures shorten opening timers and seed legacy/idle states; they are not browser E2E. |
| Tai Di persistence | Eight regressions in `tests/taidi-persistence.test.ts` (harness `taidi-persistence-harness.ts`): real Miniflare D1 completion, idempotent repeats, rollback on late failures, overlapping duplicates, additive cross-game ratings, tied places and leaderboard/stats/group boards |
| Tai Di live E2E | Hub tile; two-player minimum lobby; sign-in/watch-only guests; exact opening/pass/going-out scenarios via the dev patch hook; full seeded 2/3/4-player UI games with hidden hands, spectator, reload mid-game, results and rating changes; early end unrated; full-room spectators |
| Bridge and hub refresh | `tests/ui/bridge-ux.pw.js` (live Worker, views injected through the page globals): the contract strip shows the bid, a secret partner, trumps and trick progress, and names the partner and both sides' progress once revealed (No trump spelled out); lobby open-seat rows appear without touching `.player-item` rows and the bot group hides when full; errors are toasts (any native dialog fails the test), the abandon vote is a focused alert dialog that sends one response, the partner notice is a banner; at 320×740, 390×844, 844×390 and 1366×900 Classic seat plates clear all four trick cards, the last-trick panel and each other; the hub links each game once, builds the Telegram group link from `/api/config` and greets a signed-in player |
| Tai Di table UX | `tests/ui/taidi-ux.pw.js`: Hint cycles every legal answer weakest-first (five-card leads first) and a hand that cannot answer is told to pass; rank/suit sort persists; slide-to-select picks and drops cards; a play lined up while waiting survives to your turn; the log is a phone sheet / desktop column; results show each loser's remaining cards; at 360×640, 390×844, 844×390, 820×1180 and 1366×900 the felt never overlaps the hand dock, nothing scrolls sideways and all 17 card indices stay tappable. `tests/taidi-view.test.ts` checks other hands stay hidden during play and are revealed only once the game is over |
| Regicide live E2E | Hub links and legacy Bridge redirects; shared leaderboard entry points; dev login and seat authorization; seeded complete 1–4-player UI games with animations running; exact rule scenarios and their forecasts (real heal/draw counts, immunity, exact/fatal outcomes), named yield blocks, styled leave confirmation, desktop keys, reduced motion, spectators (signed-out link visitors watching the lobby or a running game, the 👁 count players see, sign-in back to the room, no auto-seat after a watched game until "Take a Seat"), reloads, results/ratings and stats filters |
| Telegram local integration | Actual local webhook with captured outbound Bot API calls, authenticated with a synthetic `TELEGRAM_WEBHOOK_SECRET` header (updates without it are rejected with no Bot API call): `/newgame` choices/callbacks, acknowledgement before same-group room creation, unsupported/private selection rejection, typed shortcuts, command registration, membership, lobby/start/result posts and separate group boards. No calls reach Telegram. |
| Missing Tai Di schema | `0012_taidi.sql` deliberately skipped: gameplay still finishes, Tai Di board/stats stay empty and Bridge remains available |
| Missing Regicide schema | `0011_regicide.sql` deliberately skipped: gameplay still finishes, Regicide board/stats stay empty and Bridge room creation/bot board remain available |
| Real local chat | Two browser clients, desktop/mobile, composer send, reconnect replay, order, duplicate joins, empty messages, latest 50, room changes and delayed old-socket frames |
| Browser input / layout | Classic/2.5D, CDP dragging on a scrollable page, finger attachment and damped swing, felt-edge hit testing, single table drop, hand/outside return, pending/illegal/out-of-turn guards, cancellation, resize/blur/scroll, reconnect while dragging, stable hand DOM, typography, keyboard focus, reduced motion and responsive lobby actions |
| Chat fixtures | Snapshot/live races, duplicate replay, scroll position while trimming, newest-message following, long names/text, IME/repeat/offline drafts and synthetic captures; these are not live-server evidence |

Bridge's recovery suite also opens two clients with the same verified identity:
the displaced client stays paused through timer and foreground/network events,
can explicitly choose **Reconnect here**, and retains its seat without starting
a replacement loop. Ordinary network failures still reconnect automatically.

The persistence harness uses real local D1 SQL and room code, with test-only
inspection/retry hooks and controlled I/O timing; it is not a full browser
journey. Regicide's targeted rule scenarios use a fixed seed and dev-only
state patching; distinguish these from complete seeded games. Bridge chat
E2E substitutes unrelated auth/leaderboard HTTP requests, not gameplay or
chat frames. Identity and Regicide suites exercise their actual local auth
endpoints with synthetic credentials. `tests/ui/regicide-capture.cjs`
regenerates the Regicide review screenshots and clips; it is not part of any
suite, and its images are not test results.

For Telegram chooser changes, keep captured-webhook regressions for
`/newgame`'s inline Bridge/Regicide/Tai Di choices, callback validation and room
creation in the originating group, as well as the typed game shortcuts and
the `newgame`/`leaderboard`/`help` command menu. Static hub tiles and the typed
`src/games.ts` catalog must remain consistent.

## Local ports and storage

| Port | Suite / server |
| --- | --- |
| 4184 | Hand-layout static interaction server |
| 4186 | Table-view static interaction server |
| 4208 | Chat/hand fixture server |
| 4210 | Bridge live games/chat (`live-worker.cjs` default) |
| 4212 | Card-drag interaction server |
| 4214 | UI-polish interaction server |
| 4216 | Identity live Worker |
| 4217 | Bridge creator/spectator-role live Worker |
| 4218 | Regicide live Worker |
| 4219 | Tai Di live Worker |
| 4222 | Live Worker without Regicide tables |
| 4223 | Live Worker without Tai Di tables |
| 4230 | Telegram chooser/live webhook with outbound capture (replaces the earlier suite's 4220) |
| 4232 | Bridge seasons live Worker (clock pinned inside Season 2) |
| 4234 | Bridge live update recovery Worker |
| 4242 | Connect 4 review smoke and reconnect cases |
| 4243 | Connect 4 nested-modal live Worker |
| 4245 | Omok live game, touch/keyboard, recovery and lobby integration |
| 4246 | Omok live Worker without Omok tables |
| 4247 | Omok review: isolated leaderboard timing and real production-like auth/debug gates |

Keep these ports free and run one suite at a time. `tests/ui/live-worker.cjs`
bundles the current checked-out Worker and assets, binds both room classes,
applies local migrations (except deliberate skip scenarios) and creates
isolated temporary D1/room storage under `.wrangler/`. The persistence
harness creates its own OS-temporary SQLite storage and can restart workerd
against it. Helpers dispose their runtimes and remove only their own data.
No production database or real Telegram credentials are needed.

## Focused iteration and reporting

```sh
npm run typecheck
npm test -- --maxWorkers=2
npm run test:e2e
npm run test:ui
PLAYWRIGHT_CHANNEL=chrome npm run test:connect4:smoke
npm run test:connect4:chaos
```

The Connect 4 chaos command is deterministic, local-only fault injection, not a
production load or availability claim. Repeat it to detect lifecycle leaks; do
not use `--retry` to hide failures. The smoke command includes existing layout
and splash suites as well as the review cases; the complete PR runner discovers
all these files too. For repeatability evidence, record the exact number of
independent passes and attach the output. Accessibility-tree checks are not a
substitute for manual screen-reader use; physical phones, Safari and real
assistive technology remain release verification gaps until tested explicitly.

`test:e2e` selects the live game/chat/identity/creator/Regicide/Tai Di/Connect 4/Telegram suites
plus related input checks; `test:ui` runs all Playwright files. Neither replaces
the complete PR runner. Add focused rule/persistence checks alongside E2E for
the affected game and shared paths. A new room class must also be registered
in the relevant local harnesses.

Playwright keeps failure traces in `test-results/`. Review failures rather
than rerunning until green. Record fixes, rerun affected checks, then the
complete PR runner. Generated screenshots are evidence of that run, not
proof of untested environments; retain historical captures as historical.

Each PR report must state the exact commands and actual passing/failing/skipped
counts, browser/version, viewport sizes, touch mechanism and known gaps. Do
not copy counts from an older report. Synthetic screenshots and fixtures do
not replace live E2E. Chrome mobile emulation is not physical iPhone/Android,
Safari or Telegram WebView testing. No automated suite establishes production
network or assistive-technology coverage; report these limitations explicitly.
