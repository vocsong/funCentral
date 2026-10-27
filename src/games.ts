/** Hub game identities and Telegram choices. Keep each game's implementation isolated. */
export const GAME_CATALOG = [
  { id: 'bridge', name: 'Floating Bridge', path: '/bridge/', telegramCommand: 'newbridge', players: '4 players', emoji: '🃏' },
  { id: 'regicide', name: 'Regicide', path: '/regicide/', telegramCommand: 'newregicide', players: 'co-op, 1–4 players', emoji: '♛' },
  { id: 'taidi', name: 'Tai Di', path: '/taidi/', telegramCommand: 'newtaidi', players: '2–4 players', emoji: '🎴' },
] as const;

export type GameId = typeof GAME_CATALOG[number]['id'];
export type GameCommand = typeof GAME_CATALOG[number]['telegramCommand'];
