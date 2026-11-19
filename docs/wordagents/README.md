# Word Agents

Original funCentral team word-association game inspired by the mechanics of classic team word-deduction party games. No third-party artwork, logos, rulebook text or publisher word deck is included, and Word Agents is not affiliated with any publisher.

## Play

Open `/wordagents/`, sign in through the shared Telegram identity, create a room and share the invite. Signed-out visitors can watch and sign in from the lobby without losing the invite.

- **Lobby.** Four to twelve players join the room without choosing a team or role. Once all seated players are connected, the host can start. The server randomly assigns balanced teams; each gets one spymaster (🔑) and at least one operative. The host can remove offline players; removed players may still watch but cannot rejoin that room.
- **Board.** A random 5×5 board holds nine agents for the starting team, eight for the other, seven civilians and one assassin. Every card shows a coordinate (A1–E5) so remote teams can talk about it in chat or on a call.
- **Spymasters** alone see the key: tinted cards with a colour band and a shape (◆ red, ● blue, — civilian, ✕ assassin) so colour is never the only cue. **Hide key** blanks the tints on their own screen. The clue dock checks one-word, letters-only clues inline and blocks words that are, or contain, an unrevealed board word; the server repeats every check.
- **Operatives** tap a card to select it, then **Reveal** it or **Mark** it. Marks show the marker’s initials on the card for everyone, so a team on separate devices can converge before committing. Marks are advisory: they clear on reveal and at the end of the turn, and never invalidate a teammate’s pending reveal. After at least one guess, **End turn** asks for confirmation.
- **Turn rules.** Up to count + 1 guesses while correct. A civilian or opposing agent ends the turn, the assassin loses instantly, and the first team to uncover all of its agents wins. Zero/unlimited clues are out of scope.
- **Results.** The full key is revealed. The host can start a **New round · random teams** to draw new assignments for the seated players or go **Back to lobby** to change who is playing; everyone else sees who won and why.

The screen keeps a live connection dot, watcher count, optional synthesised sounds (off by default), reveal animations that respect reduced motion, toasts for every reveal, a per-turn mission log, a sticky action dock on phones and arrow-key navigation across the board.

## Authority and privacy

All legality, key projection, shuffles and stale-command guards are server-side in `WordAgentsRoom`. Spymasters receive the key; operatives, watchers and guests receive colours only for revealed cards until the round ends. Clue, guess and end-turn commands carry the board `revision`; marks and presence changes are broadcast without bumping it. Rejoining is a no-op, so a reconnect never disturbs an in-flight command.

Roles lock for the round, including after reconnect; a second tab takes over the seat, and the first tab can take it back. The chosen host keeps the room through a refresh: while they are offline the first connected player stands in, and host controls return when they reconnect. Players can join only from the lobby. A rematch draws again from every seated player; individual players can randomly get the same team or role.

Gameplay is casual and unrated: no D1 tables, scores or other games’ ratings are touched. State persists in the room’s own SQLite Durable Object; empty rooms expire after 30 minutes.

## Integration and release

- `src/wordagents/engine.ts` (rules, structured public history, marks) and `src/wordagents/room.ts` (room authority).
- `static/wordagents/`: client built on the shared `/style.css` design system (`.top-bar`, `.home-container`, `.lobby-container`, `.overlay`, `.gameover-container`) plus `/fc-auth.js`.
- `WORDAGENTS_ROOM` / `WordAgentsRoom` with additive DO migration `v6`; no D1 migration.
- `/api/wordagents/create`, `/api/wordagents/ws`, `/newwordagents` (alias `/newwordagentsgame`) and the `/newgame` chooser.
- Merge deploys through the existing Workers Builds pipeline. Never deploy manually for QA.

## Checks

```sh
npm run test:wordagents       # engine + room (Vitest, real SQLite Durable Object)
npm run test:wordagents:ui    # fixture UI + live multiplayer (port 4250)
npm run test:pr               # always, before merge
```

`tests/ui/wordagents-capture.cjs` regenerates the [screenshot gallery](screenshots/QA.md) from real local rounds (port 4252); it is not a test. Chromium mobile emulation does not verify iOS Safari, Telegram WebView or physical touch devices.
