# Omok

Omok (오목), also known as Gomoku, joins funCentral at `/omok/`. The hub tile,
shared leaderboard and Telegram `/newgame` chooser all include it. Typed
`/newomok` and `/newomokgame` shortcuts create group-linked rooms.

## Rules and product choices

- Freestyle Omok on a 15×15 intersection board. Five **or more** contiguous
  stones wins horizontally, vertically or diagonally. A full board with no
  winner draws. There are no Renju forbidden moves, exact-five restriction,
  opening zones, swap rule, undo, turn clock or forced disconnect forfeits.
- Black always opens. The first black player is random; colours alternate
  every rematch, independently of host/seat order. The lobby shows next-round
  colours. A short server-timed opening reveal prevents early placement.
- Click/tap a point to preview, then choose **Place** to commit. Selection
  never changes authoritative state. A later state/reconnect clears stale
  previews. Game id and expected move number protect against duplicate or
  delayed actions, including packets from an earlier round.
- **Enlarge board** offers a scrollable larger grid on narrow screens.
  Browser pinch zoom stays enabled. One grid point is in the Tab order;
  arrows/Home/End explore, Enter/Space select, Tab reaches Place, and Escape
  clears a preview. Coordinates are A–O and 1–15, with A1 at top left.
- The last stone has a centre dot. The winning run is outlined, with matching
  accessible labels. The board is public to players and spectators.
- Signed-in players can take one of two seats. Guests can watch invite links.
  Late arrivals keep watching after a round until they explicitly take a seat.
  Host controls, sharing, sound off by default, reduced motion, focus-trapped
  dialogs, results and game log follow Connect 4's established patterns.
- Leaving mid-round preserves the seat and board. **Resign round** concedes
  immediately (rated in human matches); **Play Again** returns to the lobby.
  A displaced duplicate browser stays paused until **Reconnect here** is chosen.
- Practice uses a deterministic casual bot: immediate wins, immediate blocks,
  then open-line heuristics near existing stones. It is beatable and is not
  a full search engine. Bot turns use durable alarms and games are unrated.

## Architecture and persistence

`src/omok/engine.ts` contains pure rules; `bot.ts` contains the practice policy.
`room.ts` owns authoritative transitions, hibernating WebSockets, identity,
opening/bot alarms, rematches and a durable completion outbox. It is an
independent room class, rather than sharing mutable state with Connect 4.

`db.ts` and `rating.ts` follow Connect 4's tested two-player Elo transaction
pattern, with separate `omok_*` tables. Ratings start at 1000; K is 16 for the
first 30 games, then 8. Draws score 0.5. After three consecutive rated losses
against the same opponent, additional losses in that streak halve both
players' K before rounding. A win, draw or different opponent breaks it;
practice neither extends nor breaks it. Group boards count verified members.

Rating retries run in the background of room alarms, so pending results from
an earlier human match cannot delay a new practice bot turn. The shared
leaderboard also loads Omok independently of its existing boards; delayed
responses preserve the active tab/focus and cannot overwrite a newer mount.

Completion snapshots are persisted before external I/O. Idempotent D1 batches
guard both players' input snapshots and retry concurrent conflicts. Lost
acknowledgements survive restarts. Late results merge into current room state.
Missing Omok tables leave stats/boards empty and results queued; gameplay and
other games remain available. Idle cleanup waits for queued results. After a
cold restart without sockets, a null idle timestamp begins a fresh 30-minute
window instead of being interpreted as an expired room.

## Release requirements

This implementation does not apply production changes. Review and apply the
new additive D1 migration `0016_omok.sql` using the schema/ledger inspection
workflow in [deployment](deployment.md). It creates `omok_ratings`,
`omok_games`, `omok_rating_history`, `omok_group_stats` and two indexes. It
does not alter/reset other games. Do not replay historical SQL files.

`wrangler.toml` appends `OMOK_ROOM`/`OmokRoom` and the incremental Durable
Object class migration `v5`. That class migration is separate from the D1
migration and takes effect only on a later authorized deployment. Existing
bindings, domain, database, secrets and migrations retain their identities.

## Verification

- `tests/omok-engine.test.ts`: rules, boundaries, overlines, invalid input,
  draw priority and deterministic bot tactics/complete legal play.
- `tests/omok-room.test.ts`: real local workerd joins, authority, spectators,
  kicks, stale/duplicate messages, opening gates, bot alarms, rematches,
  replacement sockets, cold restart, resignation, durable result retries,
  delayed acknowledgements and missing-schema recovery/cleanup.
- `tests/omok-{rating,pity,persistence,concurrency}.test.ts`: real isolated D1,
  idempotence, atomic rollback, concurrency snapshots and rating streaks.
- `tests/ui/omok-live.pw.js`: desktop/touch played rounds, two-client reloads,
  guest watching, keyboard grid and Chromium accessibility tree, modal focus,
  320px enlarged board, duplicate-window pause, practice, results, shared
  identity and lobby/leaderboard navigation.
- `tests/ui/omok-no-tables.pw.js`: local Worker without migration 0016, real
  practice moves, empty stats/board and unaffected Bridge creation.
- `tests/ui/omok-review.pw.js`: delayed/stale leaderboard responses and real
  Worker JWT/name/identity verification with dev login/debug routes disabled.
- Telegram's captured outbound suite includes Omok's chooser and group room;
  no browser test sends messages to real Telegram.

The required `npm run test:pr` discovers these suites. Focused commands:

```sh
npm run test:omok
npm run test:omok:ui
```

Current-run counts and visual evidence are recorded in
[the implementation report](omok-verification.md). Chrome touch emulation is
not physical-phone, Safari, Telegram WebView or manual screen-reader evidence.
