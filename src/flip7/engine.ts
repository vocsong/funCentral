// Pure, server-side implementation of the tabletop rules. Card order is private.
export type ActionType = 'freeze' | 'flipThree' | 'secondChance';
export type Card = { type: 'number'; value: number } | { type: 'bonus'; value: number }
  | { type: ActionType | 'double' };
export interface PublicEvent {
  id: number;
  round: number;
  /** Optional on events saved before move grouping was added. */
  batchId?: number;
  /** The Flip Three resolution that forced this duplicate draw, if any. */
  sourceActionId?: number;
  type: 'actionDrawn' | 'actionResolved' | 'secondChanceUsed' | 'bust';
  actorId: string;
  card: Card;
  targetId?: string;
  disposition?: 'discarded';
}
const PUBLIC_EVENT_LIMIT = 32;

type Status = 'active' | 'stayed' | 'busted' | 'frozen';
type Phase = 'dealing' | 'playing' | 'roundEnd' | 'finished';
interface Player {
  id: string;
  total: number;
  status: Status;
  numbers: number[];
  bonuses: number[];
  doubled: boolean;
  secondChance: boolean;
  held: Card[];
  /** Optional for rooms persisted before public presentation evidence existed. */
  bustCard?: Extract<Card, { type: 'number' }> | null;
}
interface Choice { type: ActionType; actorId: string; targets: string[] }
type Task = { kind: 'draw'; playerId: string } | { kind: 'choose'; type: ActionType; actorId: string }
  | { kind: 'three'; playerId: string; remaining: number; deferred: ActionType[]; sourceActionId?: number };
export interface Game {
  id: string;
  phase: Phase;
  round: number;
  dealer: number;
  /** Seat at which the last normal turn was chosen; pending actions don't change it. */
  cursor: number;
  turnId: string | null;
  winnerId: string | null;
  flippedBy: string | null;
  players: Player[];
  deck: Card[];
  discard: Card[];
  spent: Card[];
  queue: Task[];
  pending: Choice | null;
  events?: PublicEvent[];
  eventSequence?: number;
  /** Public reveal only. Missing in older persisted games. */
  lastDraw?: { id: number; actorId: string; card: Card } | null;
  drawSequence?: number;
}
export type Move = { type: 'hit' | 'stay' | 'target' | 'nextRound'; playerId?: string };

export function buildDeck(): Card[] {
  const cards: Card[] = [];
  for (let value = 0; value <= 12; value++) {
    for (let i = 0; i < Math.max(1, value); i++) cards.push({ type: 'number', value });
  }
  for (const value of [2, 4, 6, 8, 10]) cards.push({ type: 'bonus', value });
  cards.push({ type: 'double' });
  for (const type of ['freeze', 'flipThree', 'secondChance'] as const) {
    for (let i = 0; i < 3; i++) cards.push({ type });
  }
  return cards;
}

function shuffle(cards: Card[]): Card[] {
  const ordered = cards.slice();
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  }
  return ordered;
}

function seatAfter(game: Game, seat: number, offset = 1): number {
  return (seat + offset) % game.players.length;
}

function roundScore(player: Player, flippedBy: string | null): number {
  if (player.status === 'busted') return 0;
  const sum = player.numbers.reduce((total, n) => total + n, 0);
  const bonuses = player.bonuses.reduce((total, n) => total + n, 0);
  return sum * (player.doubled ? 2 : 1) + bonuses + (player.id === flippedBy ? 15 : 0);
}

function endRound(game: Game): void {
  game.turnId = null;
  game.pending = null;
  game.queue = [];
  for (const player of game.players) player.total += roundScore(player, game.flippedBy);
  const highest = Math.max(...game.players.map(p => p.total));
  const leaders = game.players.filter(p => p.total === highest);
  game.winnerId = highest >= 200 && leaders.length === 1 ? leaders[0].id : null;
  game.phase = game.winnerId ? 'finished' : 'roundEnd';
}

function startRound(game: Game): void {
  const previousEventId = game.eventSequence ?? 0;
  game.round++;
  game.events = [];
  game.lastDraw = null;
  game.phase = 'dealing';
  game.cursor = game.dealer;
  game.flippedBy = null;
  game.turnId = null;
  game.pending = null;
  game.players = game.players.map(({ id, total }) => ({
    id, total, status: 'active', numbers: [], bonuses: [], doubled: false, secondChance: false, held: [], bustCard: null,
  }));
  game.queue = game.players.map((_, i) => ({
    kind: 'draw', playerId: game.players[seatAfter(game, game.dealer, i + 1)].id,
  }));
  advance(game);
  tagEventBatch(game, previousEventId);
}

export function newGame(ids: string[], drawOrder?: Card[], dealer = Math.floor(Math.random() * ids.length)): Game {
  if (ids.length < 3 || ids.length > 12 || new Set(ids).size !== ids.length) throw new Error('Flip 7 needs 3–12 distinct players.');
  if (!Number.isInteger(dealer) || dealer < 0 || dealer >= ids.length) throw new Error('Invalid dealer.');
  const game: Game = {
    id: crypto.randomUUID(), phase: 'dealing', round: 0, dealer, cursor: dealer, turnId: null, winnerId: null, flippedBy: null,
    players: ids.map(id => ({ id, total: 0, status: 'active', numbers: [], bonuses: [], doubled: false, secondChance: false, held: [] })),
    deck: drawOrder ? drawOrder.slice() : shuffle(buildDeck()), discard: [], spent: [], queue: [], pending: null, events: [], eventSequence: 0,
  };
  startRound(game);
  return game;
}

function findPlayer(game: Game, id: string): Player {
  const player = game.players.find(p => p.id === id);
  if (!player) throw new Error('You are not seated in this game.');
  return player;
}

/** Presentation only: records revealed outcomes, never queued or future cards. */
function recordEvent(game: Game, event: Omit<PublicEvent, 'id' | 'round' | 'batchId'>): number {
  game.eventSequence = (game.eventSequence ?? 0) + 1;
  game.events = [...(game.events ?? []), {
    ...event, card: { ...event.card }, id: game.eventSequence, round: game.round,
  }].slice(-PUBLIC_EVENT_LIMIT);
  return game.eventSequence;
}

function tagEventBatch(game: Game, previousEventId: number): void {
  // The first event ID in this move remains unique even when a move records no events.
  for (const event of game.events ?? []) {
    if (event.id > previousEventId) event.batchId = previousEventId + 1;
  }
}

/** Older rooms already retain the duplicate in held; infer without changing rules/state. */
function bustEvidence(player: Player): Extract<Card, { type: 'number' }> | null {
  if (player.status !== 'busted') return null;
  if (player.bustCard) return { ...player.bustCard };
  const seen = new Set<number>();
  for (const card of player.held) {
    if (card.type !== 'number') continue;
    if (seen.has(card.value)) return { ...card };
    seen.add(card.value);
  }
  return null;
}

/** Returns an action to resolve; forced draws defer Freeze and Flip Three until the batch ends. */
function draw(game: Game, player: Player, sourceActionId?: number): ActionType | undefined {
  if (!game.deck.length && game.discard.length) {
    game.deck = shuffle(game.discard);
    game.discard = [];
  }
  const card = game.deck.shift();
  if (!card) {
    endRound(game);
    return;
  }
  game.drawSequence = (game.drawSequence ?? game.lastDraw?.id ?? 0) + 1;
  game.lastDraw = { id: game.drawSequence, actorId: player.id, card: { ...card } };
  if (card.type === 'freeze' || card.type === 'flipThree' || card.type === 'secondChance') {
    recordEvent(game, { type: 'actionDrawn', actorId: player.id, card });
  }
  switch (card.type) {
    case 'number':
      if (player.numbers.includes(card.value)) {
        if (player.secondChance) {
          recordEvent(game, { type: 'secondChanceUsed', actorId: player.id, card });
          player.secondChance = false;
          const protectedIndex = player.held.findIndex(c => c.type === 'secondChance');
          game.discard.push(card, ...player.held.splice(protectedIndex, 1));
        } else {
          player.bustCard = { ...card };
          recordEvent(game, { type: 'bust', actorId: player.id, card,
            ...(sourceActionId === undefined ? {} : { sourceActionId }),
          });
          player.status = 'busted';
          player.held.push(card);
        }
        return;
      }
      player.held.push(card);
      player.numbers.push(card.value);
      if (player.numbers.length === 7) {
        game.flippedBy = player.id;
        endRound(game);
      }
      return;
    case 'bonus':
      player.held.push(card);
      player.bonuses.push(card.value);
      return;
    case 'double':
      player.held.push(card);
      player.doubled = true;
      return;
    case 'secondChance':
      if (!player.secondChance) {
        player.secondChance = true;
        player.held.push(card);
        return;
      }
      return 'secondChance';
    case 'freeze':
    case 'flipThree':
      game.spent.push(card);
      return card.type;
  }
}

function setChoice(game: Game, type: ActionType, actorId: string): void {
  const targets = game.players.filter(p => p.status === 'active'
    && (type !== 'secondChance' || (p.id !== actorId && !p.secondChance))).map(p => p.id);
  if (!targets.length) {
    if (type === 'secondChance') {
      game.discard.push({ type });
      recordEvent(game, { type: 'actionResolved', actorId, card: { type }, disposition: 'discarded' });
    }
    return;
  }
  game.pending = { type, actorId, targets };
}

function isRoundActive(game: Game): boolean {
  return game.phase === 'playing' || game.phase === 'dealing';
}

function advance(game: Game): void {
  while (isRoundActive(game) && !game.pending) {
    const task = game.queue.shift();
    if (!task) break;
    if (task.kind === 'choose') {
      // A self-freeze doesn't invalidate a previously earned choice; a bust does.
      if (findPlayer(game, task.actorId).status !== 'busted') setChoice(game, task.type, task.actorId);
      continue;
    }
    const player = findPlayer(game, task.playerId);
    if (player.status !== 'active') continue;
    const action = draw(game, player, task.kind === 'three' ? task.sourceActionId : undefined);
    if (!isRoundActive(game)) return;
    if (task.kind === 'draw') {
      if (action) setChoice(game, action, player.id);
    } else if (player.status === 'active') {
      if (action && action !== 'secondChance') task.deferred.push(action);
      const remaining = task.remaining - 1;
      if (remaining > 0) game.queue.unshift({ ...task, remaining });
      else game.queue.unshift(...task.deferred.map(type => ({ kind: 'choose' as const, type, actorId: player.id })));
      if (action === 'secondChance') setChoice(game, action, player.id);
    }
  }
  if (!isRoundActive(game) || game.pending) return;
  for (let i = 1; i <= game.players.length; i++) {
    const seat = seatAfter(game, game.cursor, i);
    if (game.players[seat].status === 'active') {
      game.phase = 'playing';
      game.turnId = game.players[seat].id;
      return;
    }
  }
  endRound(game);
}

export function applyMove(current: Game, actorId: string, move: Move): Game {
  // Do not mutate authoritative state on a rejected or interrupted move.
  const game = structuredClone(current);
  const previousEventId = game.eventSequence ?? 0;
  const player = findPlayer(game, actorId);
  switch (move.type) {
    case 'nextRound':
      if (game.phase !== 'roundEnd') throw new Error('There is no next round right now.');
      game.discard.push(...game.spent);
      for (const p of game.players) game.discard.push(...p.held);
      game.spent = [];
      game.dealer = seatAfter(game, game.dealer);
      startRound(game);
      return game;
    case 'target': {
      const pending = game.pending;
      if (!pending || pending.actorId !== actorId) throw new Error('It is not your action choice.');
      if (!move.playerId || !pending.targets.includes(move.playerId)) throw new Error('Choose an eligible player.');
      const target = findPlayer(game, move.playerId);
      game.pending = null;
      const resolvedId = recordEvent(game, { type: 'actionResolved', actorId, targetId: target.id, card: { type: pending.type } });
      if (pending.type === 'freeze') target.status = 'frozen';
      else if (pending.type === 'secondChance') {
        target.secondChance = true;
        target.held.push({ type: 'secondChance' });
      } else game.queue.unshift({ kind: 'three', playerId: target.id, remaining: 3, deferred: [], sourceActionId: resolvedId });
      break;
    }
    case 'hit':
    case 'stay':
      if (game.phase !== 'playing' || game.pending || game.turnId !== actorId || player.status !== 'active') {
        throw new Error('It is not your Hit or Stay turn.');
      }
      if (move.type === 'stay' && !player.held.length) throw new Error('You need at least one card to stay.');
      game.cursor = game.players.findIndex(p => p.id === actorId);
      game.turnId = null;
      if (move.type === 'stay') player.status = 'stayed';
      else game.queue.push({ kind: 'draw', playerId: actorId });
      break;
  }
  advance(game);
  tagEventBatch(game, previousEventId);
  return game;
}

export function gameView(game: Game) {
  return {
    id: game.id, phase: game.phase, round: game.round, dealerId: game.players[game.dealer].id,
    turnId: game.turnId, deckCount: game.deck.length, winnerId: game.winnerId, flippedBy: game.flippedBy,
    events: (game.events ?? []).slice(-PUBLIC_EVENT_LIMIT).map(event => ({ ...event, card: { ...event.card } })),
    lastDraw: game.lastDraw
      ? { id: game.lastDraw.id, actorId: game.lastDraw.actorId, card: { ...game.lastDraw.card } } : null,
    players: game.players.map(p => ({
      id: p.id, total: p.total, status: p.status, numbers: p.numbers.slice(), bonuses: p.bonuses.slice(),
      bustCard: bustEvidence(p),
      doubled: p.doubled, secondChance: p.secondChance, roundScore: roundScore(p, game.flippedBy),
    })),
    pending: game.pending ? { ...game.pending, targets: game.pending.targets.slice() } : null,
  };
}
