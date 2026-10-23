# Regicide UI revamp

Captures of the Regicide client before (master `28a2df4`) and after this
change, using the same seeded rooms, dev-only state patches, Chrome, viewport
and taps. They come from a local Worker with synthetic test players, not
production. Phone captures use Chrome mobile emulation (390 × 844, touch,
2× pixels); this is not iPhone/Safari or Telegram WebView evidence.

Regenerate with `PLAYWRIGHT_CHANNEL=chrome node tests/ui/regicide-capture.cjs docs/regicide-ui/after --clips`.
Stills are JPEG (quality 82). Clips are animated PNGs recorded with Chrome's
DevTools screencast at ~9 fps, 5 bits per colour channel. While recording,
the looping ambient glows (breathing enemy, glowing turn plate, pulsing Play
button) are paused to keep the files small. The event animations are unchanged.

## What changed

- **Board:** a castle track of all 12 royals, a framed enemy portrait with an
  immunity badge, a ghosted HP bar, attack/shield/immunity chips, the tavern
  and discard piles beside the battle line, and party plates in turn order
  (whose turn, who is taking damage, who yielded, who is up next).
- **Forecast:** suit-power chips light up for the selected cards and show
  the real numbers (cards actually healed/drawn after hand limits, shield
  gained, immune suits struck through). The outcome line says whether the
  attack kills (exact kill → joins the tavern), how much HP remains, the hit
  you will take and whether your hand survives it. A fatal move is flagged
  before you make it.
- **Discard:** a meter of selected value against the damage needed, plus
  Best fit beside the Discard button.
- **Animation:** every state still renders immediately; new log entries then
  replay on a separate layer that never takes input. Cards fly from the
  hand or a player's plate, damage numbers float, the enemy reels and lunges
  at its target, hearts carry cards back to the tavern, diamonds deal round
  the table, defeated royals shatter (or walk to the tavern on an exact
  kill), new royals flip out of the castle, Jesters flash, victory throws
  confetti. A newer state finishes running animations at once. Reduced motion
  turns them off.
- **UX:** your-turn and brace callouts, a yield block that names who
  yielded, styled confirmations (leave, end run, Jester flip), host
  **End run**, optional synthesized sound (off by default), short haptics on
  phones, desktop keys (1–8, Enter, Y, B, F, Esc), and a Jester chooser that
  opens as a bottom sheet on phones.
- **Server:** the per-player view adds `yielded` (each seat's last turn was a
  yield, already public through the log). No rules or protocol changes.
- **Client fixes that predate this change:** a kicked player who had
  reconnected was automatically seated again. Frames from a socket left behind
  by an invite-link room switch could still be applied. Two windows of the
  same account replaced each other's connection forever; the replaced window
  now stops and takes over again when shown.

## Phone, 390 × 844

| Screen | Before | After |
| --- | --- | --- |
| Home | ![Before](before/home-390.jpg) | ![After](after/home-390.jpg) |
| Lobby (host, 3 players) | ![Before](before/lobby-390.jpg) | ![After](after/lobby-390.jpg) |
| Your turn | ![Before](before/turn-390.jpg) | ![After](after/turn-390.jpg) |
| Companion combo selected | ![Before](before/combo-390.jpg) | ![After](after/combo-390.jpg) |
| Enemy strikes back (0.5 s after) | ![Before](before/strike-390.jpg) | ![After](after/strike-390.jpg) |
| Discard (Best fit) | ![Before](before/discard-390.jpg) | ![After](after/discard-390.jpg) |
| Jester: who goes next | ![Before](before/jester-390.jpg) | ![After](after/jester-390.jpg) |
| Solo victory | ![Before](before/victory-390.jpg) | ![After](after/victory-390.jpg) |
| Defeat | ![Before](before/defeat-390.jpg) | ![After](after/defeat-390.jpg) |
| Rules | ![Before](before/rules-390.jpg) | ![After](after/rules-390.jpg) |

## Desktop, 1366 × 900

| Screen | Before | After |
| --- | --- | --- |
| Single card selected | ![Before](before/combo-1366.jpg) | ![After](after/combo-1366.jpg) |
| Watching a teammate take a hit | ![Before](before/watching-discard-1366.jpg) | ![After](after/watching-discard-1366.jpg) |
| Exact kill, 0.45 s after playing | ![Before](before/defeat-mid-1366.jpg) | ![After](after/defeat-mid-1366.jpg) |
| Next royal revealed | ![Before](before/reveal-1366.jpg) | ![After](after/reveal-1366.jpg) |
| Solo victory | ![Before](before/victory-1366.jpg) | ![After](after/victory-1366.jpg) |

## Animation clips (after)

| Game start: royal reveal and deal | A♣ + 7♦ kills the Queen | Hit, then Best fit discard |
| --- | --- | --- |
| ![Intro](after/clip-intro-390.png) | ![Combo kill](after/clip-combo-kill-390.png) | ![Strike and discard](after/clip-strike-discard-390.png) |

| Jester cancels immunity | Last King falls (desktop) |
| --- | --- |
| ![Jester](after/clip-jester-390.png) | ![Victory](after/clip-victory-1366.png) |
