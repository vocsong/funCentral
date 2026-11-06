# Connect 4 expanded-review fixes and fault-test evidence — 2026-11-06

Scope: PR #86, based on `e9d85ae`. The original checkout's uncommitted work was
left untouched; these fixes were implemented in a separate worktree. Earlier
screenshots remain historical. Final-commit gate output and refreshed hub,
lobby and game captures are attached separately to the PR after verification.

## Review fixes

- Hosts must be human. Removing the final human clears practice bots, host,
  current game and bot/opening timers, but preserves the durable rating outbox.
  Loading a previously persisted bot-host room repairs it before sending a view.
  Disconnecting is deliberately different from explicitly leaving: a disconnected
  human retains their seat and ownership for reconnection.
- Elo validates both players' ratings AND game counts inside the transaction
  before its first history write. A rejected snapshot makes all writes, including
  group statistics and the game marker, no-ops. It re-reads/recomputes up to five
  times, then throws for the durable outbox to retry later. Pity eligibility is
  still evaluated inside the accepted transaction; no migration or room-local
  lock is needed. At 29 games, two equal-opponent wins now total +12, not +16.
- Finished boards have a Results button. The same human can dismiss results,
  reopen them and use Play Again; this works when both humans dismissed and
  when the only human is playing a practice bot. Spectators do not get a
  misleading Play Again button.
- Each non-tabbable board cell exposes row, column, player and the chosen disc
  colour (Red/Rose/Violet or Yellow/Cyan/Mint), plus winning-line membership.
  Modal focus wraps in both directions; the background is inert. Nested results
  over rules are ordered correctly and closing each layer restores useful focus.
  A saved `<body>` target after reload is not treated as a usable focus control.
- Invalid JSON envelopes (`null`, arrays, primitives, missing/non-string type)
  are ignored instead of throwing in the room handler.

## Smoke and controlled chaos

Commands (system Chrome is already installed):

```sh
npm ci --include=dev
PLAYWRIGHT_CHANNEL=chrome npm run test:connect4:smoke
npm run test:connect4:chaos
PLAYWRIGHT_CHANNEL=chrome npm run test:pr
```

The final runs use `NODE_OPTIONS=--max-old-space-size=1024` to bound Node memory
on this Windows workstation. The first dependency install ran out of virtual
memory; repeating it with that bound succeeded (audit: zero findings). This
was an environment issue, not counted as a passing test run.

Focused verification before the final commit:

- All unit tests: **378 passed, 0 failed, 0 skipped**, 38 files.
- Connect 4 smoke command: **38 passed, 0 failed, 0 skipped**, including existing
  layout/splash checks and eight new review browser cases.
- Chaos command: **15 passed, 0 failed, 0 skipped** in **three independent runs**;
  no test retries used to hide failures.
- Regression falsification: the six new D1 concurrency/chaos cases were also run
  against the unchanged `e9d85ae` production source. **All six failed**, including
  the sequential table oracle and retry-exhaustion check; they pass with the fix.

| Failure model | Assertions |
| --- | --- |
| Two callers paused after the same old rating read | Both transactions equal a valid sequential order, including all history, ratings, game and group rows; a stale snapshot retries |
| Game 30 boundary; shared player in second position; draw with zero Elo delta; new rows | Both players' input snapshots matter; games played is validated even if Elo did not change |
| Two distinct live room objects finish concurrently | Shared player at 29 games finishes at 1012 / 31 games, not 1016 |
| Snapshot changes on all five attempts | No partial result, history or group writes; a later durable retry can finish |
| Failure at the final SQL statement | All preceding history/rating/group writes roll back |
| Twelve reordered results, duplicate delivery, lost acknowledgement after commit | Every result applies once; final database equals an independently replayed sequential database |
| D1 failure or lost acknowledgement, then actual workerd restart and expired idle clock | Pending result survives; cleanup cannot purge it; recovered writes/history apply once |
| Rating acknowledgement delayed while next round starts and opponent disconnects | Rating merges into current state without overwriting the newer game/connection flags |
| Host explicitly leaves in lobby or after completed practice game; runtime reload | No bot host; next human can host, remove/add a bot and start; persisted bot-host rooms heal |
| Malformed/duplicate actions and replacement sockets | No room crash, duplicated seat, extra game or stale-socket disconnect of replacement |
| Offline context plus page reload/replacement during a played human game | Same game, seats and board survive; both players can finish, dismiss results and rematch |
| Real alarm-driven practice game, no patched board | Sole human can rematch, or explicitly leave after completion; next human can manage after reload; practice stays unrated |
| All six chosen colours and keyboard traversal | Occupants reach Chromium's accessibility tree; cells add no 42 tab stops; all modal layers trap and restore focus |

The initial browser work exposed and fixed a real restoration-to-body edge case.
Two test-scenario corrections are not presented as product fixes: a JavaScript
`WebSocket.close()` can remain in the CLOSING handshake and was replaced with
actual reload/replacement for the reconnect test; the nested-dialog test spreads
the host's discs so the host cannot win before the intended guest winning move.
The old pity concurrency assertion also needed a valid sequential expectation:
the fourth loss must use the ratings after the third, which changes rounding.

## Exact-final-commit gate

The agreed gate is the repository's unchanged `npm run test:pr`: typecheck,
Vitest with two workers, the full Classic browser suite, then the complete
2.5D hand-layout suite. It is run again **after committing**, with no source edits
between the commit and run. A failure is reported as a failure, not erased by an
isolated diagnostic pass. The PR response identifies the exact SHA and actual
counts and links the raw output; local results are not called hosted CI.

## Deployment and limits

D1: `0015_connect4.sql`, after reconciling the live schema/ledger/pending list.
DO: `v4`, SQLite `Connect4Room`, binding `CONNECT4_ROOM`. These review fixes add
no migration. Never replay destructive `0006`. See [deployment](deployment.md).
A read-only `wrangler d1 migrations list ... --remote` attempt was blocked by
missing Cloudflare credentials; no production status or ordering was inferred
from historical checkpoints. No migration was applied and nothing deployed.

Windows, Node 26.13.0, Playwright 1.64.1, Chrome 156.0.8078.80. Review browser
viewports are 1366×900 desktop and 390×844 mobile (`isMobile`/`hasTouch`, actual
Playwright tap input); existing smoke cases cover narrower and landscape layouts.
Synthetic identities, local Worker/D1 and controlled fault gates are not real
Telegram or production-load testing. Offline/reload coverage is not a claim that
all transport failures automatically recover. Chromium accessibility-tree checks
are not actual NVDA/VoiceOver use. Physical phones, Safari, Telegram WebView,
manual screen-reader use and production availability remain unverified.

Capture command (hub/lobby/game at desktop/mobile, plus the mobile hub scrolled
to the Connect 4 tile):

```sh
CONNECT4_SHOTS=/path/to/evidence PLAYWRIGHT_CHANNEL=chrome node tests/ui/connect4-review-capture.cjs
```

Hub captures are actual signed-out pages; game captures are six legal moves with
synthetic signed-in users. Captures preserve the viewport and fold, with a second
mobile hub capture scrolled to the Connect 4 tile. A root full-page capture would
clip the hub's nested 100vh scroller, so no artificial page stretching is used.
No fixture leaderboard data is seeded.
