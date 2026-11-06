-- Connect 4 ratings and group stats — everything Connect 4 needs, in one file.
-- Kept apart from Bridge's users.elo / group_stats and from Regicide/Tai Di tables so the boards never mix.
-- Only CREATE ... IF NOT EXISTS: safe to run more than once, touches no existing data.

CREATE TABLE IF NOT EXISTS connect4_ratings (
  telegram_id    INTEGER PRIMARY KEY,
  rating         INTEGER NOT NULL DEFAULT 1000,
  games_played   INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  draws          INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connect4_ratings_rating ON connect4_ratings(rating DESC);

-- One row per rated game. Its presence marks the game as already counted.
CREATE TABLE IF NOT EXISTS connect4_games (
  game_id       TEXT PRIMARY KEY,
  room_code     TEXT NOT NULL,
  num_players   INTEGER NOT NULL,
  played_at     INTEGER NOT NULL
);

-- place: 1 = win, 2 = loss; on a draw both players carry place 1.
CREATE TABLE IF NOT EXISTS connect4_rating_history (
  game_id        TEXT NOT NULL,
  telegram_id    INTEGER NOT NULL,
  place          INTEGER NOT NULL,
  rating_before  INTEGER NOT NULL,
  rating_after   INTEGER NOT NULL,
  delta          INTEGER NOT NULL,
  played_at      INTEGER NOT NULL,
  PRIMARY KEY (game_id, telegram_id)
);
CREATE INDEX IF NOT EXISTS idx_connect4_history_player ON connect4_rating_history(telegram_id, played_at DESC);

-- Results per Telegram group, mirroring Bridge's group_stats: only players
-- verified as members of the group when they joined are counted.
CREATE TABLE IF NOT EXISTS connect4_group_stats (
  group_id       TEXT    NOT NULL,
  telegram_id    INTEGER NOT NULL,
  games_played   INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  draws          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, telegram_id),
  FOREIGN KEY (group_id) REFERENCES groups(group_id)
);
