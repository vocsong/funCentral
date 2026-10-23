'use strict';

// ---------- Card helpers (mirror src/regicide/engine.ts) ----------
const SUIT_SYMBOL = { H: '♥', D: '♦', C: '♣', S: '♠' };
const SUIT_NAME = { H: 'Hearts', D: 'Diamonds', C: 'Clubs', S: 'Spades' };
const SUIT_POWER = { H: 'Heal', D: 'Draw', C: 'Double', S: 'Shield' };
const POWER_ORDER = ['H', 'D', 'C', 'S']; // hearts resolve before diamonds
const ROYAL_NAME = { J: 'Jack', Q: 'Queen', K: 'King' };
const ROYAL_VALUE = { J: 10, Q: 15, K: 20 };
const ROYAL_GLYPH = { J: '♞︎', Q: '♛︎', K: '♚︎' }; // text presentation, not emoji
const ROYAL_STATS = { J: { attack: 10, health: 20 }, Q: { attack: 15, health: 30 }, K: { attack: 20, health: 40 } };
const SUIT_ORDER = ['C', 'D', 'H', 'S']; // Bridge's hand order
const SETUP = {
  1: { hand: 8, jesters: '2 Jester flips', jesterCount: 2, jesterLabel: 'Jester flips' },
  2: { hand: 7, jesters: 'No Jesters', jesterCount: 0, jesterLabel: 'Jesters in deck' },
  3: { hand: 6, jesters: '1 Jester', jesterCount: 1, jesterLabel: 'Jester in deck' },
  4: { hand: 5, jesters: '2 Jesters', jesterCount: 2, jesterLabel: 'Jesters in deck' },
};
const SEAT_COLORS = ['#f5c451', '#5ec8f2', '#c084fc', '#6ee7a8'];

const isJester = (c) => c.startsWith('X');
const rankOf = (c) => (isJester(c) ? 'X' : c.slice(0, -1));
const suitOf = (c) => (isJester(c) ? null : c.slice(-1));
const isRed = (c) => suitOf(c) === 'H' || suitOf(c) === 'D';
const isRoyal = (c) => rankOf(c) in ROYAL_NAME;
function valueOf(c) {
  const r = rankOf(c);
  if (r === 'X') return 0;
  if (r === 'A') return 1;
  return ROYAL_VALUE[r] ?? Number(r);
}
const sum = (cards) => cards.reduce((t, c) => t + valueOf(c), 0);
const label = (c) => (isJester(c) ? 'Jester' : rankOf(c) + SUIT_SYMBOL[suitOf(c)]);
const enemyName = (c) => `${ROYAL_NAME[rankOf(c)]} of ${SUIT_NAME[suitOf(c)]}`;
const isOver = (g) => g.phase === 'won' || g.phase === 'lost';
const seatColor = (seat) => SEAT_COLORS[seat % SEAT_COLORS.length];
const initialOf = (name) => ([...String(name || '?').trim()][0] || '?').toUpperCase();

function validatePlay(cards) {
  if (cards.length === 0) return 'Select a card';
  if (cards.some(isJester)) return cards.length === 1 ? null : 'The Jester must be played alone';
  if (cards.length === 1) return null;
  const ranks = cards.map(rankOf);
  if (ranks.includes('A')) return cards.length === 2 ? null : 'A companion pairs with one card';
  if (new Set(ranks).size !== 1) return 'Combos need matching ranks';
  if (sum(cards) > 10) return 'Combos must total 10 or less';
  return null;
}

function sortHand(cards) {
  return [...cards].sort((a, b) => {
    if (isJester(a) !== isJester(b)) return isJester(a) ? 1 : -1;
    const s = SUIT_ORDER.indexOf(suitOf(a)) - SUIT_ORDER.indexOf(suitOf(b));
    return s || valueOf(a) - valueOf(b);
  });
}

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

const ICON_PATHS = {
  sword: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  sound: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  flag: '<path d="M4 22V4c2-1.3 4-1.6 6-1 2 .7 4 2 7 1.3 1-.2 2-.6 3-1.3v11c-1 .7-2 1.1-3 1.3-3 .7-5-.6-7-1.3-2-.6-4-.3-6 1"/>',
};
function icon(name, cls = '') {
  const span = el('span', `rc-ico ${cls}`.trim());
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
  return span;
}

/**
 * One card face for every size (hand, battle line, flying copies): corner rank over suit,
 * a centre pip, royal glyphs, the Ace's companion paw and the Jester. `.card-corner` stays
 * the tap target the hand tests aim for.
 */
function cardEl(code, { tag = 'div', mini = false } = {}) {
  const node = el(tag, `${mini ? 'card-mini' : 'card'} rc-card`);
  node.dataset.card = code;
  const corner = el('span', 'card-corner');
  if (isJester(code)) {
    node.classList.add('rc-jester');
    node.setAttribute('aria-label', 'Jester');
    corner.append(el('span', 'card-value', '★'));
    node.append(corner, el('span', 'rc-pip rc-jester-face', '🃏'));
    if (!mini) node.append(el('span', 'rc-jester-word', 'Jester'));
    return node;
  }
  const rank = rankOf(code);
  const suit = suitOf(code);
  node.classList.add(isRed(code) ? 'red' : 'black', `suit-${suit}`);
  corner.append(el('span', 'card-value', rank), el('span', 'card-suit', SUIT_SYMBOL[suit]));
  node.append(corner);
  if (isRoyal(code)) {
    node.classList.add('rc-royal');
    node.append(el('span', 'rc-pip rc-royal-glyph', ROYAL_GLYPH[rank]), el('span', 'rc-val', String(ROYAL_VALUE[rank])));
  } else {
    node.append(el('span', 'rc-pip', SUIT_SYMBOL[suit]));
    if (rank === 'A') node.append(el('span', 'rc-paw', '🐾'));
  }
  node.setAttribute('aria-label', rank === 'A' ? `Ace (companion) of ${SUIT_NAME[suit]}` : `${ROYAL_NAME[rank] ?? rank} of ${SUIT_NAME[suit]}`);
  return node;
}

/** The current enemy: a framed royal portrait. */
function enemyCardEl(code) {
  const rank = rankOf(code);
  const suit = suitOf(code);
  const node = el('div', `rc-enemy-card ${isRed(code) ? 'red' : 'black'} rank-${rank} suit-${suit}`);
  node.dataset.card = code;
  const corner = () => {
    const c = el('span', 'rc-enemy-corner');
    c.append(el('b', null, rank), el('span', null, SUIT_SYMBOL[suit]));
    return c;
  };
  const art = el('div', 'rc-enemy-art');
  art.append(el('span', 'rc-enemy-glyph', ROYAL_GLYPH[rank]), el('span', 'rc-enemy-suit', SUIT_SYMBOL[suit]));
  const badge = el('span', 'rc-immune-badge', SUIT_SYMBOL[suit]);
  badge.title = `Immune to ${SUIT_SYMBOL[suit]} ${SUIT_POWER[suit]}`;
  const br = corner();
  br.classList.add('br');
  node.append(corner(), art, br, badge);
  node.setAttribute('aria-label', enemyName(code));
  return node;
}

function cardText(cards) {
  return cards.map(label).join(' ');
}

function toast(message, kind = '') {
  const stack = $('toasts');
  const node = el('div', `rc-toast ${kind}`.trim(), message);
  stack.append(node);
  while (stack.children.length > 3) stack.firstChild.remove();
  setTimeout(() => node.remove(), kind === 'error' ? 3800 : 2600);
}

// ---------- Identity ----------
function parseHash() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw) return { room: null, pid: null };
  const [room, pid] = raw.split(':');
  return { room: /^[A-Za-z0-9]{4}$/.test(room) ? room.toUpperCase() : null, pid: pid || null };
}

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* blocked */ } },
};

const hashInfo = parseHash();
let playerId = hashInfo.pid || store.get('regicidePlayerId');
if (!playerId) playerId = (crypto.randomUUID?.() ?? `p${Date.now()}${Math.random().toString(36).slice(2)}`);
if (!hashInfo.pid) store.set('regicidePlayerId', playerId);
let playerName = store.get('playerName') || '';
let profile = null; // verified Telegram profile (FunAuth), null until signed in

// ---------- Sound (synthesised, off by default) ----------
const sfx = (() => {
  let ctx = null;
  let on = store.get('regicideSound') === 'on';
  function audio() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function tone(freq, { at = 0, dur = 0.14, type = 'sine', gain = 0.1, slide = 0 } = {}) {
    const c = audio();
    if (!c) return;
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
  function noise({ at = 0, dur = 0.1, gain = 0.12, freq = 1200 } = {}) {
    const c = audio();
    if (!c) return;
    const t0 = c.currentTime + at;
    const buffer = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = c.createBufferSource();
    const filter = c.createBiquadFilter();
    const amp = c.createGain();
    src.buffer = buffer;
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    amp.gain.value = gain;
    src.connect(filter).connect(amp).connect(c.destination);
    src.start(t0);
  }
  const SOUNDS = {
    card: () => noise({ dur: 0.07, gain: 0.1, freq: 2600 }),
    hit: () => { noise({ dur: 0.14, gain: 0.22, freq: 420 }); tone(150, { dur: 0.2, type: 'triangle', gain: 0.16, slide: -80 }); },
    kill: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.07, dur: 0.26, type: 'triangle', gain: 0.09 })),
    hurt: () => { tone(118, { dur: 0.32, type: 'sawtooth', gain: 0.07, slide: -45 }); noise({ dur: 0.18, gain: 0.12, freq: 300 }); },
    heal: () => [440, 554, 659, 880].forEach((f, i) => tone(f, { at: i * 0.05, dur: 0.2, gain: 0.06 })),
    shield: () => tone(980, { dur: 0.32, type: 'triangle', gain: 0.06, slide: -260 }),
    jester: () => [392, 523, 466, 622].forEach((f, i) => tone(f, { at: i * 0.08, dur: 0.18, type: 'square', gain: 0.035 })),
    turn: () => { tone(660, { dur: 0.1, gain: 0.07 }); tone(990, { at: 0.1, dur: 0.16, gain: 0.07 }); },
    reveal: () => tone(196, { dur: 0.5, type: 'triangle', gain: 0.08, slide: 60 }),
    win: () => [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.12, dur: 0.3, type: 'triangle', gain: 0.09 })),
    lose: () => [392, 349, 311, 262].forEach((f, i) => tone(f, { at: i * 0.18, dur: 0.38, type: 'sawtooth', gain: 0.045 })),
  };
  return {
    get on() { return on; },
    play(name, delayMs = 0) {
      if (!on || !SOUNDS[name]) return;
      const run = () => { try { SOUNDS[name](); } catch { /* audio unavailable */ } };
      if (delayMs > 0) at(delayMs, run); // cancelled with the animation on a newer state or leave
      else run();
    },
    toggle() {
      on = !on;
      store.set('regicideSound', on ? 'on' : 'off');
      if (on) this.play('turn');
      return on;
    },
  };
})();

function vibrate(pattern) {
  try { if (navigator.vibrate && matchMedia('(pointer: coarse)').matches) navigator.vibrate(pattern); } catch { /* unsupported */ }
}

// ---------- State ----------
let ws = null;
let roomCode = null;
let view = null;
let selected = new Set();
let reconnectDelay = 800;
let reconnectTimer = 0;
let tickerSeq = 0;
let lastGameNo = -1;
let overDismissed = false;
let joinSent = false;
let modalTimer = 0;
let modalAt = 0;
let lastFocus = null;
const lobbySeen = new Set();

// ---------- Networking ----------
function connect(code) {
  roomCode = code;
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = FunAuth.token();
  const socket = new WebSocket(`${proto}//${location.host}/api/regicide/ws?room=${code}&playerId=${encodeURIComponent(playerId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`);
  ws = socket;
  joinSent = false;
  socket.onopen = () => {
    reconnectDelay = 800;
    $('overlay-reconnect').classList.add('hidden');
  };
  socket.onmessage = (event) => {
    if (ws !== socket) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'state') onState(msg);
    else if (msg.type === 'error') onError(msg);
  };
  socket.onclose = (event) => {
    if (ws !== socket || !roomCode) return;
    // The room replaced this connection with a newer one (another tab/browser): stop here.
    // Coming back to this tab reconnects (visibilitychange) and takes the seat back.
    if (event.reason === 'Replaced by new connection') {
      toast('This game is open in another window — come back here to take it over');
      return;
    }
    $('overlay-reconnect').classList.remove('hidden');
    reconnectTimer = setTimeout(() => connect(roomCode), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.8, 10000);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else toast('Reconnecting… try again in a moment', 'error');
}

function onError(msg) {
  if (msg.code === 'notFound') {
    toast(`Room ${roomCode} doesn't exist (or has expired)`, 'error');
    leaveRoom(false);
    return;
  }
  toast(msg.message, 'error');
}

function onState(next) {
  const prev = view;
  if (next.you.seat >= 0) joinSent = true; // seated: never auto-join again on this connection (e.g. after a kick)
  // Connection flags, names and late rating results don't change the game itself: refresh those
  // parts without interrupting an animation or the pending results modal.
  if (next.game && prev?.game && prev.gameNo === next.gameNo && JSON.stringify(next.game) === JSON.stringify(prev.game)) {
    view = next;
    const myTurn = next.you.seat >= 0 && next.game.currentSeat === next.you.seat;
    renderTopBar();
    renderParty(next.game);
    renderBanner(next.game, myTurn);
    syncModals(null);
    return;
  }
  // Finish any running animation first, so the snapshot reflects the settled board.
  fxReset();
  const scene = snapshotScene();
  view = next;
  // Join on first contact if we aren't seated yet and seats are open (signed-in players only).
  if (!joinSent && next.you.seat < 0 && !next.game && FunAuth.token()) {
    joinSent = true;
    send({ type: 'join', name: playerName });
  }
  if (next.gameNo !== lastGameNo) {
    lastGameNo = next.gameNo;
    overDismissed = false;
    selected.clear();
    tickerSeq = 0;
  }
  // Drop selections that are no longer in hand, and clear after phase/turn changes.
  const g = next.game;
  const pg = prev?.game;
  if (!g || !pg || g.phase !== pg.phase || g.currentSeat !== pg.currentSeat) selected.clear();
  if (g?.hand) selected = new Set([...selected].filter((c) => g.hand.includes(c)));
  render({ deferModals: true, reflow: !!pg });
  const busyFor = g ? animateTransition(prev, next, scene) : 0;
  syncModals(busyFor);
}

// ---------- Screens ----------
function showScreen(id) {
  for (const sc of document.querySelectorAll('.screen')) sc.classList.toggle('active', sc.id === id);
  document.body.dataset.screen = id;
}

function render({ deferModals = false, reflow = false } = {}) {
  const inRoom = !!roomCode;
  $('top-bar').classList.toggle('hidden', !inRoom);
  $('tb-room').textContent = roomCode || '';
  $('tb-name').textContent = playerName;
  renderTopBar();
  if (!inRoom) { showScreen('screen-home'); return; }
  if (!view) { showScreen('screen-lobby'); renderLobbyLoading(); return; }
  if (!view.game) { showScreen('screen-lobby'); renderLobby(); hideModal('modal-over'); hideModal('modal-jester'); return; }
  showScreen('screen-game');
  renderGame({ reflow });
  if (!deferModals) syncModals(0);
}

function renderTopBar() {
  const sound = $('btn-sound');
  sound.replaceChildren(icon(sfx.on ? 'sound' : 'mute'));
  sound.setAttribute('aria-pressed', String(sfx.on));
  sound.title = sfx.on ? 'Sound effects on' : 'Sound effects off';
  if (!$('btn-rules').firstChild) $('btn-rules').append(icon('help'));
  if (!$('btn-end').firstChild) $('btn-end').append(icon('flag'));
  const g = view?.game;
  $('btn-end').classList.toggle('hidden', !(g && !isOver(g) && view.you.isHost && view.you.seat >= 0));
}

function renderLobbyLoading() {
  $('lobby-code').textContent = roomCode;
  $('lobby-players').replaceChildren(el('div', 'player-item rc-empty', 'Connecting…'));
  $('btn-start').classList.add('hidden');
  $('lobby-wait').textContent = '';
  $('lobby-setup').classList.add('hidden');
}

function statusDot(connected) {
  return el('span', `status-dot ${connected ? 'online' : 'offline'}`);
}

function avatarEl(p, seat) {
  const avatar = el('span', 'rc-avatar', initialOf(p.name));
  avatar.style.setProperty('--seat-color', seatColor(seat));
  avatar.append(statusDot(p.connected));
  return avatar;
}

/** One row in the lobby / Jester chooser: avatar, name, badges, action. */
function playerRow(p, seat, { tag = 'div', meta = null } = {}) {
  const item = el(tag, 'player-item rc-player');
  item.style.setProperty('--seat-color', seatColor(seat));
  const identity = el('div', 'lobby-identity');
  identity.append(el('span', 'lobby-player-name', p.name));
  if (p.id === view.you.id) identity.append(el('span', 'rc-you', 'you'));
  const metaBox = el('div', 'lobby-meta');
  if (meta) metaBox.append(meta);
  item.append(avatarEl(p, seat), identity, metaBox, el('div', 'lobby-action'));
  return item;
}

function renderLobby() {
  const { players, you } = view;
  $('lobby-code').textContent = view.roomCode;
  const list = $('lobby-players');
  list.replaceChildren();
  players.forEach((p, seat) => {
    const meta = el('span', 'rc-player-meta');
    if (p.isHost) meta.append(el('span', 'rc-host', '👑 Host'));
    // Same signal as Bridge: non-members still play and are rated, but don't count for this group.
    if (p.isGroupMember === false) meta.append(el('span', 'not-ranked-badge', '⚠️ not in group'));
    if (!p.connected) meta.append(el('span', 'rc-offline', 'offline'));
    const row = playerRow(p, seat, { meta });
    if (!lobbySeen.has(p.id)) { lobbySeen.add(p.id); row.classList.add('rc-enter'); }
    if (you.isHost && p.id !== you.id) {
      const kick = el('button', 'kick-btn', '✕');
      kick.type = 'button';
      kick.setAttribute('aria-label', `Remove ${p.name}`);
      kick.onclick = () => send({ type: 'kick', playerId: p.id });
      row.querySelector('.lobby-action').append(kick);
    }
    list.append(row);
  });
  for (let i = players.length; i < 4; i++) {
    const open = el('div', 'player-item rc-empty');
    open.append(el('span', 'rc-avatar rc-avatar-empty', '+'), el('span', null, 'Open seat'));
    list.append(open);
  }

  const n = players.length;
  const setup = $('lobby-setup');
  setup.classList.toggle('hidden', n === 0);
  if (n > 0) {
    const s = SETUP[n];
    const stat = (value, text) => { const d = el('div', 'rc-setup-stat'); d.append(el('b', null, String(value)), el('span', null, text)); return d; };
    const stats = el('div', 'rc-setup-stats');
    stats.append(stat(s.hand, n === 1 ? 'card hand' : 'cards each'), stat(s.jesterCount, s.jesterLabel), stat(12, 'royals to defeat'));
    const parts = [el('div', 'rc-setup-mode', n === 1 ? '🗡️ Solo run · no yielding' : `🤝 Co-op · ${n} players`), stats];
    if (view.groupName) parts.push(el('div', 'rc-setup-group', `💬 ${view.groupName}`));
    setup.replaceChildren(...parts);
  }

  const seated = you.seat >= 0;
  $('btn-start').classList.toggle('hidden', !you.isHost);
  if (!seated && !FunAuth.token()) {
    $('lobby-wait').textContent = 'Sign in with Telegram on the Regicide home screen to take a seat — you can watch until then.';
    return;
  }
  $('btn-start').textContent = n === 1 ? '♛ Start Solo Run' : `♛ Start Game (${n} players)`;
  const wait = $('lobby-wait');
  wait.textContent = !seated
    ? (n >= 4 ? 'This room is full.' : 'Joining…')
    : you.isHost
      ? (n < 4 ? 'Share the code — up to 4 can play, or start now.' : 'Table is full — ready when you are.')
      : `Waiting for ${players.find((p) => p.isHost)?.name ?? 'the host'} to start...`;
}

// ---------- Game rendering ----------
function playerName_(seat) {
  return view.players[seat]?.name ?? `Player ${seat + 1}`;
}
function who(seat) {
  return seat === view.you.seat ? 'You' : playerName_(seat);
}

function renderGame({ reflow = false } = {}) {
  const g = view.game;
  const me = view.you.seat;
  const myTurn = me >= 0 && g.currentSeat === me;
  const over = isOver(g);
  const root = $('rc-game');
  root.dataset.phase = g.phase;
  root.classList.toggle('my-turn', myTurn && !over);
  root.classList.toggle('taking-damage', myTurn && g.phase === 'discard');
  root.classList.toggle('spectating', me < 0);
  $('rc-table').classList.toggle('rc-fallen', g.phase === 'lost');
  if (g.phase !== 'lost') $('rc-table').style.removeProperty('--fall-delay');
  $('rc-table').classList.toggle('rc-won', g.phase === 'won');

  renderCastle($('castle-track'), g);
  $('info-castle').textContent = `${g.defeated.length}/12`;
  renderPiles(g);
  renderEnemy(g);
  renderPlayed(g);
  renderParty(g);
  renderLog(g);
  renderTicker(g);
  renderBanner(g, myTurn);
  renderHand(g, myTurn, { reflow });
  renderForecast(g, myTurn);
  renderFooter(g, myTurn);
  renderActions(g, myTurn);
}

/** 12 pips: defeated royals, the current enemy, then what's left of each rank. */
function renderCastle(box, g) {
  const pips = [];
  for (const code of g.defeated) pips.push({ code, state: 'down' });
  if (g.enemy) pips.push({ code: g.enemy, state: g.phase === 'lost' ? 'fell' : 'now' });
  for (const rank of ['J', 'Q', 'K']) for (let i = 0; i < (g.castle[rank] ?? 0); i++) pips.push({ rank, state: 'left' });
  box.replaceChildren(...pips.slice(0, 12).map(({ code, rank, state }) => {
    const r = code ? rankOf(code) : rank;
    const pip = el('span', `rc-pip-royal ${state} tier-${r}${code && isRed(code) ? ' red' : ''}`);
    if (code) pip.dataset.card = code;
    pip.append(el('b', null, r));
    if (code && state !== 'left') pip.append(el('span', null, SUIT_SYMBOL[suitOf(code)]));
    pip.title = code ? `${enemyName(code)}${state === 'down' ? ' — defeated' : state === 'now' ? ' — fighting now' : ''}` : `${ROYAL_NAME[r]} — still in the castle`;
    return pip;
  }));
  box.setAttribute('aria-label', `${g.defeated.length} of 12 royals defeated`);
}

function renderPiles(g) {
  $('tavern-count').textContent = String(g.tavernCount);
  $('discard-count').textContent = String(g.discardCount);
  const depth = (n) => String(n === 0 ? 0 : n < 8 ? 1 : n < 20 ? 2 : 3);
  $('pile-tavern').dataset.depth = depth(g.tavernCount);
  $('pile-discard').dataset.depth = depth(g.discardCount);
}

function renderEnemy(g) {
  const holder = $('enemy-card');
  const changed = (holder.dataset.card || '') !== (g.enemy || '');
  if (changed) {
    holder.dataset.card = g.enemy || '';
    holder.replaceChildren(g.enemy ? enemyCardEl(g.enemy) : el('div', 'rc-enemy-empty', g.phase === 'won' ? '👑' : '🏰'));
  }
  if (!g.enemy && holder.firstChild) holder.firstChild.textContent = g.phase === 'won' ? '👑' : '🏰';
  renderEnemyInfo(g);
  setHp(g.enemy ? Math.max(0, g.enemyHealth - g.enemyDamage) : 0, g.enemyHealth || 1, { instant: changed });
}

/** Name, HP text and the attack / shield / immunity chips. Takes any game view (the animator replays the previous one). */
function renderEnemyInfo(g) {
  const card = $('enemy-card').firstChild;
  if (card?.classList.contains('rc-enemy-card')) {
    card.classList.toggle('immune', !!g.immuneSuit);
    card.classList.toggle('jestered', !!g.jesterActive);
  }
  const atk = $('info-attack');
  const sh = $('info-shield');
  const imm = $('info-immune');
  if (!g.enemy) {
    $('enemy-name').textContent = g.phase === 'won' ? 'The castle has fallen!' : '';
    $('hp-left').textContent = '0';
    $('hp-max').textContent = '0';
    for (const chip of [atk, sh, imm]) chip.classList.add('hidden');
    return;
  }
  const left = Math.max(0, g.enemyHealth - g.enemyDamage);
  $('enemy-name').textContent = enemyName(g.enemy);
  $('hp-left').textContent = String(left);
  $('hp-max').textContent = String(g.enemyHealth);
  const bar = $('hp-bar');
  bar.setAttribute('aria-valuemax', String(g.enemyHealth));
  bar.setAttribute('aria-valuenow', String(left));
  for (const chip of [atk, sh, imm]) chip.classList.remove('hidden');
  atk.replaceChildren(icon('sword'), el('b', null, String(g.attack)));
  if (g.shield > 0) atk.append(el('s', 'rc-stat-base', String(g.enemyAttack)));
  atk.classList.toggle('blocked', g.attack === 0);
  sh.replaceChildren(icon('shield'), el('b', null, String(g.shield)));
  sh.classList.toggle('zero', g.shield === 0);
  const suit = suitOf(g.enemy);
  imm.className = 'rc-stat rc-immune';
  if (g.jesterActive) {
    imm.classList.add('cancelled');
    imm.replaceChildren(el('span', 'rc-imm-suit', '🃏'), el('span', null, 'No immunity'));
  } else {
    imm.classList.add(`suit-${suit}`);
    imm.replaceChildren(el('span', 'rc-imm-suit', SUIT_SYMBOL[suit]), el('span', null, 'Immune'), el('span', 'rc-imm-power', ` · ${SUIT_POWER[suit]}`));
  }
}

function setHp(left, max, { instant = false } = {}) {
  const fill = $('hp-fill');
  const ghost = $('hp-ghost');
  const pct = max > 0 ? Math.max(0, Math.min(100, (left / max) * 100)) : 0;
  if (instant) { fill.style.transition = 'none'; ghost.style.transition = 'none'; }
  fill.style.width = `${pct}%`;
  ghost.style.width = `${pct}%`;
  fill.classList.toggle('low', pct > 0 && pct <= 35);
  if (instant) { void fill.offsetWidth; fill.style.transition = ''; ghost.style.transition = ''; }
}

function renderPlayed(g) {
  const row = $('played-cards');
  row.replaceChildren();
  if (!g.played.length) {
    row.append(el('span', 'rc-played-empty', g.enemy && !isOver(g) ? 'No attacks yet — strike first!' : ''));
    return;
  }
  g.played.forEach((play, i) => {
    const group = el('div', 'rc-played-group');
    group.dataset.cards = play.cards.join(',');
    group.dataset.index = String(i);
    group.style.setProperty('--seat-color', seatColor(play.seat));
    group.title = `${who(play.seat)}: ${isJester(play.cards[0]) ? 'Jester' : `${play.damage} damage`}`;
    const cards = el('div', 'rc-played-cards');
    for (const c of play.cards) cards.append(cardEl(c, { mini: true }));
    const tag = el('span', 'rc-played-dmg', isJester(play.cards[0]) ? '🃏' : `−${play.damage}`);
    tag.prepend(el('i', 'rc-played-who', initialOf(playerName_(play.seat))));
    group.append(cards, tag);
    row.append(group);
  });
}

/** Players from your seat onwards, i.e. in turn order starting with you. */
function partyOrder(n, me) {
  const base = me >= 0 ? me : 0;
  return Array.from({ length: n }, (_, i) => (base + i) % n);
}

function renderParty(g) {
  const box = $('party');
  const over = isOver(g);
  const n = view.players.length;
  box.style.setProperty('--n', String(n));
  box.dataset.n = String(n);
  box.replaceChildren(...partyOrder(n, view.you.seat).map((seat) => {
    const p = view.players[seat];
    const isMe = seat === view.you.seat;
    const active = seat === g.currentSeat && !over;
    const plate = el('div', 'rc-plate');
    plate.dataset.seat = String(seat);
    plate.style.setProperty('--seat-color', seatColor(seat));
    plate.classList.toggle('is-you', isMe);
    plate.classList.toggle('is-turn', active);
    plate.classList.toggle('offline', !p.connected);
    plate.classList.toggle('danger', active && g.phase === 'discard');
    plate.title = p.name;
    const body = el('div', 'rc-plate-body');
    body.append(el('span', 'rc-plate-name', isMe ? 'You' : p.name), el('span', 'rc-plate-status', plateStatus(g, seat, active, over)));
    const count = el('span', 'rc-plate-count');
    count.title = `${g.handCounts[seat]} of ${g.maxHand} cards`;
    count.append(el('i', 'rc-mini-back'), el('b', null, String(g.handCounts[seat])));
    plate.append(avatarEl(p, seat), body, count);
    return plate;
  }));
}

function plateStatus(g, seat, active, over) {
  if (!view.players[seat].connected) return 'Offline';
  if (over) return '';
  if (active) return g.phase === 'discard' ? `Taking ${g.pendingDamage}` : g.phase === 'jester' ? 'Choosing…' : 'Attacking';
  if (g.yielded?.[seat]) return 'Yielded';
  if (g.numPlayers > 1 && g.phase === 'play' && seat === (g.currentSeat + 1) % g.numPlayers) return 'Up next';
  return '';
}

function describe(entry) {
  switch (entry.t) {
    case 'play': {
      const bits = [];
      if (entry.doubled) bits.push('♣ ×2');
      if (entry.heal) bits.push(`♥ healed ${entry.heal}`);
      if (entry.draw || (entry.cards.some((c) => suitOf(c) === 'D') && !entry.immune.includes('D'))) {
        bits.push(entry.draw < entry.value ? `♦ drew ${entry.draw} of ${entry.value}` : `♦ drew ${entry.draw}`);
      }
      if (entry.shield) bits.push(`♠ shield +${entry.shield}`);
      if (entry.immune.length) bits.push(`${entry.immune.map((s) => SUIT_SYMBOL[s]).join('')} blocked`);
      return `${who(entry.seat)} played ${cardText(entry.cards)} for ${entry.damage} damage${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
    }
    case 'jester': return `${who(entry.seat)} played the Jester — immunity cancelled`;
    case 'yield': return `${who(entry.seat)} yielded`;
    case 'damage': return `The enemy strikes ${entry.seat === view.you.seat ? 'you' : who(entry.seat)} for ${entry.amount}`;
    case 'nodamage': return `${who(entry.seat)} blocked the attack completely 🛡️`;
    case 'discard': return `${who(entry.seat)} discarded ${cardText(entry.cards)} (${entry.value})`;
    case 'defeat': return `${who(entry.seat)} defeated the ${enemyName(entry.enemy)}!${entry.exact ? ' Exact hit — it joins the tavern deck 🤝' : ''}`;
    case 'reveal': return `${enemyName(entry.enemy)} steps forward`;
    case 'choose': return `${who(entry.seat)} chose ${entry.target === entry.seat ? 'themself' : who(entry.target)} to go next`;
    case 'flip': return `${who(entry.seat)} flipped a Jester — fresh hand of ${entry.drawn}`;
    case 'won': return 'Victory! The castle has fallen 👑';
    case 'lost': return `${who(entry.seat)} ${entry.reason}`;
  }
  return '';
}

function renderLog(g) {
  const log = $('log');
  log.replaceChildren(...[...g.log].reverse().map((entry) => {
    const li = el('li', `log-${entry.t}`);
    if ('seat' in entry) li.style.setProperty('--seat-color', seatColor(entry.seat));
    li.append(el('span', 'rc-log-text', describe(entry)));
    return li;
  }));
}

function renderTicker(g) {
  const box = $('last-action');
  // The two latest events, e.g. "You played 7♥ for 7" + "The enemy strikes you for 10".
  // A reveal right after a defeat is skipped so the defeat itself stays visible.
  const entries = g.log.filter((e, i) => e.t !== 'reveal' || i === 0);
  const recent = entries.slice(-2);
  const last = recent[recent.length - 1];
  if (!last) { box.replaceChildren(); return; }
  if (last.seq !== tickerSeq) {
    box.replaceChildren(...recent.map((e, i) => {
      const line = el('div', i === recent.length - 1 ? 'la-latest' : 'la-prev', describe(e));
      line.dataset.t = e.t;
      return line;
    }));
    box.classList.remove('pop');
    void box.offsetWidth;
    box.classList.add('pop');
    tickerSeq = last.seq;
  }
}

function renderBanner(g, myTurn) {
  const banner = $('turn-banner');
  let text = '';
  let kind = '';
  const name = playerName_(g.currentSeat);
  if (g.phase === 'won') { text = 'Victory! Every royal has been defeated.'; kind = 'good'; }
  else if (g.phase === 'lost') { text = `Defeat — ${who(g.currentSeat)} ${g.loseReason}`; kind = 'danger'; }
  else if (view.you.seat < 0) { text = `👁 Watching · ${name}'s turn`; }
  else if (myTurn && g.phase === 'play') {
    text = g.hand.length === 0
      ? (g.numPlayers === 1 ? 'No cards left — flip a Jester to refill' : 'No cards left — you must yield')
      : 'Your turn · pick a card or combo';
    kind = 'mine';
  } else if (myTurn && mustFlip(g)) {
    text = `Your hand can't cover ${g.pendingDamage} damage — flip a Jester or you lose`;
    kind = 'danger';
  } else if (myTurn && g.phase === 'discard') {
    text = `Take ${g.pendingDamage} damage · discard cards worth ${g.pendingDamage}+`;
    kind = 'danger';
  } else if (myTurn && g.phase === 'jester') { text = 'Choose who goes next'; kind = 'mine'; }
  else if (g.phase === 'discard') text = `${name} is taking ${g.pendingDamage} damage…`;
  else if (g.phase === 'jester') text = `${name} is choosing who goes next…`;
  else text = `${name} is attacking…`;
  banner.textContent = text;
  banner.className = `rc-turn ${kind}`.trim();
}

/** Fan geometry for up to 8 cards. */
function fanLayout(container, n) {
  const width = container.clientWidth || 340;
  const wide = width >= 600;
  const cardW = Math.round(Math.min(wide ? 100 : 84, Math.max(56, width / (wide ? 7 : 5))));
  // Keep the rotated outer cards inside the container (their corners swing ~20% of a card outwards).
  const usable = width - cardW * 1.4;
  const spacing = n > 1 ? Math.min(cardW * 0.8, usable / (n - 1)) : 0;
  const mid = (n - 1) / 2;
  const step = n > 1 ? Math.min(5, 24 / (n - 1)) : 0;
  const arc = cardW * 0.028;
  const lift = 20;
  container.style.setProperty('--hand-card-width', `${cardW}px`);
  container.style.setProperty('--corner-font', `${Math.round(cardW * 0.27)}px`);
  container.style.height = `${Math.round(cardW * 1.4 + lift + arc * mid * mid + 8)}px`;
  return (i) => ({ left: width / 2 + (i - mid) * spacing - cardW / 2, top: lift + arc * (i - mid) ** 2, angle: (i - mid) * step });
}

function handCardEl(code) {
  const node = cardEl(code, { tag: 'button' });
  node.type = 'button';
  node.classList.add('hand-card');
  node.addEventListener('click', () => onCardTap(code));
  return node;
}

/** Keyed: surviving cards keep their buttons (focus, transitions), new ones are inserted in order. */
function renderHand(g, myTurn, { reflow = false } = {}) {
  const hand = $('hand');
  if (!g.hand) {
    hand.style.height = '64px';
    hand.replaceChildren(el('div', 'rc-hand-empty', 'You are watching this game.'));
    return;
  }
  const cards = sortHand(g.hand);
  const interactive = myTurn && (g.phase === 'play' || g.phase === 'discard');
  hand.classList.toggle('interactive', interactive);
  hand.classList.toggle('discarding', myTurn && g.phase === 'discard');
  hand.classList.toggle('rc-reflow', reflow);
  for (const node of [...hand.children]) if (!node.classList.contains('hand-card') || !cards.includes(node.dataset.card)) node.remove();
  const nodes = new Map([...hand.children].map((n) => [n.dataset.card, n]));
  const place = fanLayout(hand, cards.length);
  const sel = [...selected];
  cards.forEach((code, i) => {
    const node = nodes.get(code) ?? handCardEl(code);
    if (hand.children[i] !== node) hand.insertBefore(node, hand.children[i] ?? null);
    const pos = place(i);
    node.style.left = `${pos.left}px`;
    node.style.top = `${pos.top}px`;
    node.style.setProperty('--card-angle', `${pos.angle}deg`);
    node.style.setProperty('--card-order', String(i + 1));
    const isSel = selected.has(code);
    node.classList.toggle('is-selected', isSel);
    node.setAttribute('aria-pressed', String(isSel));
    node.disabled = !interactive;
    node.classList.toggle('rc-dim', interactive && g.phase === 'play' && !isSel && sel.length > 0 && !!validatePlay([...sel, code]));
    node.dataset.key = String(i + 1);
  });
  if (!cards.length) hand.append(el('div', 'rc-hand-empty', 'Your hand is empty'));
}

function onCardTap(code) {
  const g = view?.game;
  if (!g) return;
  if (selected.has(code)) selected.delete(code);
  else if (g.phase === 'play' && validatePlay([...selected, code])) selected = new Set([code]); // start a fresh selection
  else selected.add(code);
  sfx.play('card');
  refreshHandArea();
}

function refreshHandArea() {
  const g = view?.game;
  if (!g) return;
  const myTurn = view.you.seat >= 0 && g.currentSeat === view.you.seat;
  renderHand(g, myTurn);
  renderForecast(g, myTurn);
  renderFooter(g, myTurn);
  renderActions(g, myTurn);
}

/** Cheapest discard that covers the damage (fewest points lost, then fewest cards). Hands are ≤ 8 cards. */
function bestFit(hand, need) {
  let best = null;
  for (let mask = 1; mask < 1 << hand.length; mask++) {
    const pick = hand.filter((_, i) => mask & (1 << i));
    const v = sum(pick);
    if (v < need) continue;
    if (!best || v < best.v || (v === best.v && pick.length < best.pick.length)) best = { v, pick };
  }
  return best?.pick ?? [];
}

/**
 * What the selected attack would do: damage, each suit power (with the real number of cards
 * healed/drawn after hand limits), and the outcome — kill, exact kill, or the hit you'd take.
 */
function forecastPlay(g, cards) {
  const err = validatePlay(cards);
  if (err) return { ok: false, error: err };
  const enemy = ROYAL_NAME[rankOf(g.enemy)];
  if (isJester(cards[0])) {
    const retro = g.immuneSuit === 'S' ? g.played.filter((p) => p.cards.some((c) => suitOf(c) === 'S')).reduce((t, p) => t + p.value, 0) : 0;
    return {
      ok: true,
      jester: true,
      outcome: {
        kind: 'jester',
        text: g.immuneSuit
          ? `Cancels immunity (${SUIT_SYMBOL[g.immuneSuit]} ${SUIT_POWER[g.immuneSuit]}) — no damage, then you choose who goes next${retro ? ` · earlier spades shield ${retro}` : ''}`
          : 'No immunity left to cancel — no damage, then you choose who goes next',
      },
    };
  }
  const me = view.you.seat;
  const value = sum(cards);
  const suits = new Set(cards.map(suitOf));
  const handAfter = g.hand.filter((c) => !cards.includes(c));
  const powers = {};
  for (const s of POWER_ORDER) powers[s] = { state: !suits.has(s) ? 'off' : s === g.immuneSuit ? 'blocked' : 'on' };
  const active = (s) => powers[s].state === 'on';
  const healed = active('H') ? Math.min(value, g.discardCount) : 0;
  let drawn = 0;
  let myDraws = 0;
  if (active('D')) {
    const counts = g.handCounts.slice();
    counts[me] = handAfter.length;
    let deck = g.tavernCount + healed;
    let seat = me;
    while (drawn < value && deck > 0 && counts.some((c) => c < g.maxHand)) {
      if (counts[seat] < g.maxHand) { counts[seat]++; deck--; drawn++; if (seat === me) myDraws++; }
      seat = (seat + 1) % g.numPlayers;
    }
  }
  const doubled = active('C');
  const damage = doubled ? value * 2 : value;
  powers.H.text = active('H') ? (g.discardCount ? `Heal ${healed}` : 'Nothing to heal') : powers.H.state === 'blocked' ? 'Immune' : 'Heal';
  powers.D.text = active('D') ? (drawn === value ? `Draw ${drawn}` : `Draw ${drawn} of ${value}`) : powers.D.state === 'blocked' ? 'Immune' : 'Draw';
  powers.C.text = active('C') ? '×2' : powers.C.state === 'blocked' ? 'Immune' : 'Double';
  powers.S.text = active('S') ? `Shield +${value}` : powers.S.state === 'blocked' ? 'Immune' : 'Shield';
  if (active('H') && !g.discardCount) powers.H.state = 'empty';

  const remaining = g.enemyHealth - g.enemyDamage;
  let outcome;
  if (damage >= remaining && g.castle.remaining === 0) outcome = { kind: 'win', text: 'Defeats the last King — victory!' };
  else if (damage === remaining) outcome = { kind: 'kill', text: `Exact kill — the ${enemyName(g.enemy)} joins your tavern deck` };
  else if (damage > remaining) outcome = { kind: 'kill', text: `Defeats the ${enemy} (${damage - remaining} overkill) — you go again` };
  else {
    const shield = g.shield + (active('S') ? value : 0);
    const incoming = Math.max(0, g.enemyAttack - shield);
    const keep = sum(handAfter);
    const hpLeft = remaining - damage;
    if (!incoming) outcome = { kind: 'safe', text: `${hpLeft} HP left · fully shielded — no damage to you` };
    else if (keep >= incoming) outcome = { kind: 'ok', text: `${hpLeft} HP left · then take ${incoming} (you keep ${keep}${myDraws ? ' + draws' : ''})` };
    else if (myDraws) outcome = { kind: 'risk', text: `${hpLeft} HP left · then take ${incoming} — you keep ${keep} + ${myDraws} drawn` };
    else if (g.numPlayers === 1 && g.soloJestersLeft > 0) outcome = { kind: 'risk', text: `${hpLeft} HP left · then take ${incoming} — you'd need a Jester flip (${keep} left)` };
    else outcome = { kind: 'fatal', text: `☠ ${hpLeft} HP left · then take ${incoming} with only ${keep} left — you'd lose` };
  }
  return { ok: true, value, damage, doubled, powers, outcome };
}

function chip(cls, text, title) {
  const node = el('span', `rc-chip ${cls}`.trim(), text);
  if (title) node.title = title;
  return node;
}

/** Suit powers as chips: a legend when idle, lit up for the selected attack. */
function powerChips(g, f = null) {
  const row = el('div', 'rc-chips');
  if (f?.ok && !f.jester) {
    const dmg = chip('rc-chip-dmg', '');
    dmg.append(icon('sword'), el('b', null, String(f.damage)), document.createTextNode(' dmg'));
    row.append(dmg);
  }
  for (const s of POWER_ORDER) {
    let state = 'idle';
    let text = s === 'C' ? 'Double' : SUIT_POWER[s];
    if (f?.ok && !f.jester) ({ state, text } = f.powers[s]);
    if (f?.ok && !f.jester && state === 'off') text = '';
    else if (s === g.immuneSuit) { state = 'blocked'; text = 'Immune'; }
    if (f?.jester && s === g.immuneSuit) { state = 'unlock'; text = 'Unlocked'; }
    row.append(chip(`rc-power suit-${s} ${state}`, text ? `${SUIT_SYMBOL[s]} ${text}` : SUIT_SYMBOL[s], `${SUIT_SYMBOL[s]} ${SUIT_POWER[s]}${state === 'blocked' ? ' — this enemy is immune' : ''}`));
  }
  return row;
}

function renderForecast(g, myTurn) {
  const box = $('preview');
  box.className = 'rc-forecast';
  if (!g.hand || isOver(g) || !g.enemy) { box.replaceChildren(); return; }
  const sel = [...selected];
  if (myTurn && g.phase === 'discard') {
    const v = sum(sel);
    const need = g.pendingDamage;
    const meter = el('div', `rc-meter ${v >= need ? 'full' : ''}`.trim());
    const fill = el('div', 'rc-meter-fill');
    fill.style.width = `${Math.min(100, need ? (v / need) * 100 : 100)}%`;
    meter.append(fill, el('span', 'rc-meter-text', `Discarding ${v} of ${need} needed`));
    const total = sum(g.hand);
    const note = total < need
      ? (mustFlip(g) ? `Your hand is worth only ${total} — flip a Jester for a fresh hand` : `Your hand is worth only ${total}`)
      : v >= need ? `Covers the hit${v > need ? ` · ${v - need} over` : ' exactly'}` : sel.length ? `Select ${need - v} more` : 'Tap cards to discard, or use ✨ Best fit';
    box.classList.add(v >= need ? 'good' : 'bad');
    box.replaceChildren(meter, el('div', `rc-outcome ${v >= need ? 'ok' : 'risk'}`, note));
    return;
  }
  if (myTurn && g.phase === 'play' && sel.length) {
    const f = forecastPlay(g, sel);
    if (!f.ok) {
      box.classList.add('bad');
      box.replaceChildren(powerChips(g), el('div', 'rc-outcome fatal', `${f.error} · sets need equal ranks totalling ≤ 10, or an Ace plus one card`));
      return;
    }
    box.classList.add('active');
    box.replaceChildren(powerChips(g, f), el('div', `rc-outcome ${f.outcome.kind}`, f.outcome.text));
    return;
  }
  box.classList.add('idle');
  const hint = myTurn && g.phase === 'play'
    ? (g.hand.length ? 'Tap a card · sets of equal rank up to 10 · an Ace pairs with any card' : '')
    : '';
  box.replaceChildren(powerChips(g), ...(hint ? [el('div', 'rc-outcome hint', hint)] : []));
}

function renderFooter(g, myTurn) {
  const total = $('hand-total');
  const surv = $('survival');
  surv.className = 'rc-survival';
  if (!g.hand) { total.textContent = ''; surv.textContent = ''; return; }
  const value = sum(g.hand);
  total.textContent = `Hand value ${value} · ${g.hand.length}/${g.maxHand} cards`;
  if (!g.enemy || isOver(g)) { surv.textContent = ''; return; }
  const need = myTurn && g.phase === 'discard' ? g.pendingDamage : g.attack;
  if (need <= 0) { surv.textContent = '🛡 Fully shielded'; surv.classList.add('ok'); return; }
  const ok = value >= need;
  surv.textContent = ok ? `vs ⚔ ${need} · ✓ can take the hit` : `vs ⚔ ${need} · ✗ short by ${need - value}`;
  surv.classList.add(ok ? 'ok' : 'bad');
}

/**
 * Solo, and a Jester flip is the only legal move: the hand can't cover the damage (Step 4),
 * or it's empty at the start of the turn (Step 1, solo can't yield). Without a flip left the
 * engine has already ended the game.
 */
function mustFlip(g) {
  if (g.numPlayers !== 1 || g.soloJestersLeft <= 0 || !g.hand) return false;
  if (g.phase === 'discard') return sum(g.hand) < g.pendingDamage;
  return g.phase === 'play' && g.hand.length === 0;
}

function yieldBlockers(g) {
  const me = view.you.seat;
  const names = (g.yielded ?? []).map((y, seat) => (y && seat !== me ? playerName_(seat) : null)).filter(Boolean);
  return names.length ? names.join(' and ') : 'everyone else';
}

function renderActions(g, myTurn) {
  const act = $('btn-act');
  const yieldBtn = $('btn-yield');
  const flip = $('btn-flip');
  const best = $('btn-bestfit');
  const note = $('action-note');
  const over = isOver(g);
  const seated = view.you.seat >= 0;
  note.textContent = '';
  act.classList.remove('danger', 'ready');

  flip.classList.toggle('hidden', !(g.numPlayers === 1 && seated && !over));
  flip.disabled = !(myTurn && g.soloJestersLeft > 0 && (g.phase === 'play' || g.phase === 'discard'));
  $('flip-count').textContent = String(g.soloJestersLeft);
  best.classList.toggle('hidden', !(myTurn && g.phase === 'discard' && g.hand && sum(g.hand) >= g.pendingDamage));

  if (over) {
    yieldBtn.classList.add('hidden');
    act.textContent = 'Results';
    act.disabled = false;
    act.dataset.action = 'results';
    return;
  }
  if (!seated) {
    yieldBtn.classList.add('hidden');
    act.textContent = 'Watching';
    act.disabled = true;
    act.dataset.action = '';
    return;
  }
  const sel = [...selected];
  if (myTurn && mustFlip(g)) {
    // Solo rule: a Jester may be flipped at the start of Step 4 — it's the only way to survive this hit.
    yieldBtn.classList.add('hidden');
    flip.classList.add('hidden');
    act.textContent = `🃏 Flip Jester to survive (${g.soloJestersLeft} left)`;
    act.disabled = false;
    act.dataset.action = 'flip';
    act.classList.add('danger');
    return;
  }
  if (g.phase === 'discard') {
    yieldBtn.classList.add('hidden');
    const v = sum(sel);
    act.textContent = myTurn ? (sel.length ? `Discard ${v}` : `Discard ≥ ${g.pendingDamage}`) : 'Waiting…';
    act.disabled = !myTurn || v < g.pendingDamage;
    act.dataset.action = 'discard';
    if (myTurn) act.classList.add('danger');
    return;
  }
  if (g.phase === 'jester') {
    yieldBtn.classList.add('hidden');
    act.textContent = myTurn ? 'Choose who goes next' : 'Waiting…';
    act.disabled = !myTurn;
    act.dataset.action = 'jester';
    return;
  }
  // Solo players can't yield, so the button only exists in multiplayer.
  yieldBtn.classList.toggle('hidden', g.numPlayers === 1);
  yieldBtn.disabled = !(myTurn && g.phase === 'play' && g.canYield);
  yieldBtn.title = g.canYield ? 'Skip attacking and take the hit (Y)' : "Can't yield — everyone else yielded on their last turn";
  const valid = sel.length > 0 && !validatePlay(sel);
  act.textContent = myTurn ? (valid ? `Play ${cardText(sel)}` : sel.length ? 'Not a valid combo' : 'Select cards') : 'Waiting…';
  act.disabled = !(myTurn && g.phase === 'play' && valid);
  act.dataset.action = 'play';
  if (myTurn && valid) act.classList.add('ready');
  if (myTurn && g.numPlayers > 1 && !g.canYield) note.textContent = `Can't yield — ${yieldBlockers(g)} yielded on their last turn`;
  else if (myTurn && g.numPlayers > 1 && g.hand.length === 0) note.textContent = 'No cards in hand — yield and take the hit';
}

// ---------- Animation layer ----------
// Every state is rendered immediately (the board is always authoritative). Animations then
// replay the new log entries on top: cards fly, numbers float, the enemy reels. They never
// take input, and a newer state finishes them instantly.
const FLY = 380;
const fx = { timers: new Set(), anims: new Set(), tweens: new Set() };

function motionOK() {
  return !matchMedia('(prefers-reduced-motion: reduce)').matches && document.visibilityState === 'visible';
}
function at(ms, fn) {
  if (ms <= 0) { fn(); return; }
  const id = setTimeout(() => { fx.timers.delete(id); fn(); }, ms);
  fx.timers.add(id);
}
function anim(node, keyframes, opts) {
  if (!node?.animate) return null;
  const a = node.animate(keyframes, opts);
  fx.anims.add(a);
  a.finished.catch(() => {}).then(() => fx.anims.delete(a));
  return a;
}
function fxReset() {
  for (const id of fx.timers) clearTimeout(id);
  fx.timers.clear();
  for (const a of fx.anims) { try { a.finish(); } catch { a.cancel(); } }
  fx.anims.clear();
  for (const t of fx.tweens) t.dead = true;
  fx.tweens.clear();
  for (const n of document.querySelectorAll('.rc-incoming')) n.classList.remove('rc-incoming');
  $('fx').replaceChildren();
}

const R = (node) => {
  const r = node?.getBoundingClientRect?.();
  return r && r.width > 0 && r.height > 0 ? r : null;
};
const centerOf = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
/** A card-shaped box of width `w` centred on a rect. */
function cardBox(r, w = 34) {
  const c = centerOf(r);
  const h = w * 1.4;
  return { left: c.x - w / 2, top: c.y - h / 2, width: w, height: h, angle: 0 };
}
const plateOf = (seat) => document.querySelector(`#party .rc-plate[data-seat="${seat}"]`);

function snapshotScene() {
  const hand = new Map();
  for (const n of document.querySelectorAll('#hand .hand-card')) {
    const r = R(n);
    if (!r) continue;
    const c = centerOf(r);
    const w = n.offsetWidth;
    const h = n.offsetHeight;
    hand.set(n.dataset.card, { left: c.x - w / 2, top: c.y - h / 2, width: w, height: h, angle: parseFloat(n.style.getPropertyValue('--card-angle')) || 0 });
  }
  const played = [...document.querySelectorAll('#played-cards .card-mini')].map((n) => ({ code: n.dataset.card, rect: R(n) })).filter((p) => p.rect);
  const enemyNode = document.querySelector('#enemy-card .rc-enemy-card');
  const enemyRect = R(enemyNode);
  return {
    active: $('screen-game').classList.contains('active'),
    hand,
    played,
    enemy: enemyNode && enemyRect ? { code: enemyNode.dataset.card, rect: enemyRect } : null,
  };
}

/** Moves a detached node from one box to another inside the fx layer. */
function flyNode(node, from, to, { delay = 0, duration = 420, rotate = [0, 0], fadeOut = false, arc = 0, appearNow = false, easing = 'cubic-bezier(.2,.75,.25,1)', onLand } = {}) {
  if (!from || !to) return;
  const launch = (wait) => {
    node.classList.add('rc-fly');
    Object.assign(node.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    node.style.setProperty('--w', `${from.width}px`);
    $('fx').append(node);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const s = to.width / from.width;
    const frames = [{ transform: `translate(0px, 0px) scale(1) rotate(${rotate[0]}deg)`, opacity: 1 }];
    if (arc) frames.push({ transform: `translate(${dx / 2}px, ${dy / 2 - arc}px) scale(${(1 + s) / 2}) rotate(${(rotate[0] + rotate[1]) / 2}deg)`, opacity: 1, offset: 0.5 });
    frames.push({ transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(${rotate[1]}deg)`, opacity: fadeOut ? 0 : 1 });
    const a = anim(node, frames, { duration, delay: wait, easing, fill: 'both' });
    if (!a) { node.remove(); return; }
    a.finished.then(() => { node.remove(); onLand?.(); }).catch(() => node.remove());
  };
  if (appearNow) launch(delay);
  else at(delay, () => launch(0));
}

/** FLIP: a real element appears to travel from `from` to where it now sits. */
function flipFrom(node, from, { delay = 0, duration = FLY } = {}) {
  const to = R(node);
  if (!to || !from) return;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const s = from.width / to.width;
  anim(node, [
    { transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(${from.angle || 0}deg)`, zIndex: 5 },
    { transform: 'none', zIndex: 5 },
  ], { duration, delay, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' });
}

function floatText(text, point, { cls = '', delay = 0, duration = 1100, rise = 48 } = {}) {
  if (!point) return;
  at(delay, () => {
    const n = el('div', `rc-float ${cls}`.trim(), text);
    n.style.left = `${point.x}px`;
    n.style.top = `${point.y}px`;
    $('fx').append(n);
    const a = anim(n, [
      { transform: 'translate(-50%, -50%) scale(.5)', opacity: 0 },
      { transform: 'translate(-50%, -50%) translateY(-10px) scale(1.18)', opacity: 1, offset: 0.18 },
      { transform: 'translate(-50%, -50%) translateY(-18px) scale(1)', opacity: 1, offset: 0.55 },
      { transform: `translate(-50%, -50%) translateY(-${rise}px) scale(.96)`, opacity: 0 },
    ], { duration, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' });
    a?.finished.then(() => n.remove()).catch(() => n.remove());
  });
}

function burst(point, { n = 14, colors = ['#f5c451', '#fff3c4', '#ff9f43'], delay = 0, spread = 90, size = 7 } = {}) {
  if (!point) return;
  at(delay, () => {
    for (let i = 0; i < n; i++) {
      const p = el('i', 'rc-particle');
      const angle = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      const dist = spread * (0.5 + Math.random() * 0.7);
      Object.assign(p.style, { left: `${point.x}px`, top: `${point.y}px`, width: `${size}px`, height: `${size}px`, background: colors[i % colors.length] });
      $('fx').append(p);
      const a = anim(p, [
        { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1 },
        { transform: `translate(-50%, -50%) translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist + 18}px) scale(.3) rotate(${180 + Math.random() * 180}deg)`, opacity: 0 },
      ], { duration: 700 + Math.random() * 300, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' });
      a?.finished.then(() => p.remove()).catch(() => p.remove());
    }
  });
}

/** A big caption over the table ("Your turn", the new enemy's name, …). */
function callout(text, kind = '', delay = 0, { sub = '', y = 0.42, duration = 1400 } = {}) {
  at(delay, () => {
    const t = R($('rc-table'));
    if (!t) return;
    const n = el('div', `rc-callout ${kind}`.trim());
    n.append(el('span', 'rc-callout-main', text));
    if (sub) n.append(el('span', 'rc-callout-sub', sub));
    n.style.left = `${t.left + t.width / 2}px`;
    n.style.top = `${t.top + t.height * y}px`;
    $('fx').append(n);
    const a = anim(n, [
      { opacity: 0, transform: 'translate(-50%, -50%) scale(.7)', filter: 'blur(6px)' },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1.05)', filter: 'blur(0)', offset: 0.16 },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', filter: 'blur(0)', offset: 0.78 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1.06)', filter: 'blur(3px)' },
    ], { duration, easing: 'ease-out', fill: 'forwards' });
    a?.finished.then(() => n.remove()).catch(() => n.remove());
  });
}

function overlayFlash(cls, delay = 0, rect = null, duration = 650) {
  at(delay, () => {
    const n = el('div', `rc-flash ${cls}`);
    const r = rect ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
    Object.assign(n.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    $('fx').append(n);
    const a = anim(n, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration, easing: 'ease-out', fill: 'forwards' });
    a?.finished.then(() => n.remove()).catch(() => n.remove());
  });
}

function pulse(node, delay = 0, scale = 1.14) {
  if (!node) return;
  anim(node, [{ transform: 'scale(1)' }, { transform: `scale(${scale})`, offset: 0.4 }, { transform: 'scale(1)' }], { duration: 380, delay, easing: 'ease-out' });
}

function hitShake(node, delay) {
  if (!node) return;
  anim(node, [
    { transform: 'none', filter: 'none' },
    { transform: 'translateX(-7px) rotate(-2.5deg)', filter: 'brightness(1.9) saturate(.5)', offset: 0.14 },
    { transform: 'translateX(6px) rotate(2deg)', filter: 'brightness(1.2)', offset: 0.38 },
    { transform: 'translateX(-3px) rotate(-1deg)', filter: 'none', offset: 0.64 },
    { transform: 'none', filter: 'none' },
  ], { duration: 440, delay });
}

function tweenNumber(node, from, to, delay = 0, duration = 520) {
  if (!node || from === to) return;
  node.textContent = String(from);
  const token = { dead: false };
  fx.tweens.add(token);
  at(delay, () => {
    const start = performance.now();
    const step = (now) => {
      if (token.dead) return;
      const k = Math.min(1, (now - start) / duration);
      node.textContent = String(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
      if (k < 1) requestAnimationFrame(step);
      else fx.tweens.delete(token);
    };
    requestAnimationFrame(step);
  });
}

function ghostEnemy(code, rect) {
  const g = enemyCardEl(code);
  g.classList.add('rc-fly', 'rc-ghost');
  Object.assign(g.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  g.style.setProperty('--ew', `${rect.width}px`);
  $('fx').append(g);
  return g;
}

function confetti(delay = 0) {
  at(delay, () => {
    const colors = ['#f5c451', '#ff6b6b', '#5ec8f2', '#6ee7a8', '#c084fc', '#fff3c4'];
    for (let i = 0; i < 56; i++) {
      const p = el('i', 'rc-confetti');
      const x = Math.random() * innerWidth;
      Object.assign(p.style, { left: `${x}px`, top: '-16px', background: colors[i % colors.length] });
      $('fx').append(p);
      const drift = (Math.random() - 0.5) * 160;
      const a = anim(p, [
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${drift}px, ${innerHeight * (0.7 + Math.random() * 0.35)}px) rotate(${360 + Math.random() * 540}deg)`, opacity: 0.2 },
      ], { duration: 1800 + Math.random() * 1400, delay: Math.random() * 500, easing: 'cubic-bezier(.25,.6,.45,1)', fill: 'both' });
      a?.finished.then(() => p.remove()).catch(() => p.remove());
    }
  });
}

/** Where a played or discarded card starts: your own card's spot in hand, otherwise its owner's plate. */
function sourceBox(code, seat, ctx, i = 0, n = 1) {
  if (seat === ctx.me) {
    const h = ctx.scene.hand.get(code);
    if (h) return h;
  }
  const pr = R(plateOf(seat));
  if (!pr) return null;
  const b = cardBox(pr, 30);
  b.left += (i - (n - 1) / 2) * 12;
  return b;
}

/** Plays the new log entries in order; returns how long the sequence runs (ms). */
function animateTransition(prev, next, scene) {
  const g = next.game;
  if (!motionOK() || !$('screen-game').classList.contains('active')) return 0;
  const pg = prev?.game;
  const fresh = g.log.length === 1 && g.log[0].t === 'reveal';
  if (!pg || prev.gameNo !== next.gameNo || !scene.active) return fresh ? introTimeline(g) : 0;
  const lastSeq = pg.log.at(-1)?.seq ?? 0;
  if ((g.log.at(-1)?.seq ?? 0) < lastSeq) return 0; // log was reset (dev patch)
  const events = g.log.filter((e) => e.seq > lastSeq);
  if (!events.length || events.length > 12) return 0;

  const me = next.you.seat;
  const ctx = {
    g, pg, me, scene, events,
    ghost: null,
    newCards: g.hand && pg.hand ? g.hand.filter((c) => !pg.hand.includes(c)) : [],
    dealt: 0,
    tavernAt: 0,
    discardAt: 0,
  };
  const killed = scene.enemy && events.some((e) => e.t === 'defeat');
  if (killed) {
    // The old royal stays on screen as a ghost until its defeat plays; the new one waits for its reveal.
    ctx.ghost = ghostEnemy(scene.enemy.code, scene.enemy.rect);
    renderEnemyInfo(pg);
    setHp(Math.max(0, pg.enemyHealth - pg.enemyDamage), pg.enemyHealth, { instant: true });
  }
  let t = 0;
  for (const e of events) t = runEffect(e, ctx, t);
  if (ctx.newCards.length > ctx.dealt) t = Math.max(t, dealIn(ctx.newCards.slice(ctx.dealt), t));
  tweenNumber($('tavern-count'), pg.tavernCount, g.tavernCount, ctx.tavernAt);
  tweenNumber($('discard-count'), pg.discardCount, g.discardCount, ctx.discardAt);

  // Turn hand-off cues.
  const myTurn = me >= 0 && g.currentSeat === me && !isOver(g);
  if (myTurn && g.numPlayers > 1 && g.phase === 'play' && (pg.currentSeat !== me || pg.phase !== 'play')) {
    callout('Your turn', 'turn', t + 60, { duration: 1100 });
    sfx.play('turn', t + 60);
    at(t + 60, () => vibrate(30));
  }
  return t;
}

function runEffect(e, ctx, t) {
  switch (e.t) {
    case 'play': return fxPlay(e, ctx, t);
    case 'jester': return fxJester(e, ctx, t);
    case 'yield': return fxYield(e, ctx, t);
    case 'damage': return fxDamage(e, ctx, t);
    case 'nodamage': return fxNoDamage(e, ctx, t);
    case 'discard': return fxDiscard(e, ctx, t);
    case 'defeat': return fxDefeat(e, ctx, t);
    case 'reveal': return fxReveal(e, ctx, t);
    case 'choose': return fxChoose(e, ctx, t);
    case 'flip': return fxFlip(e, ctx, t);
    case 'won': return fxWon(e, ctx, t);
    case 'lost': return fxLost(e, ctx, t);
  }
  return t;
}

function lastGroupFor(cards) {
  const key = cards.join(',');
  return [...document.querySelectorAll('#played-cards .rc-played-group')].reverse().find((n) => n.dataset.cards === key) ?? null;
}

function fxPlay(e, ctx, t) {
  const killedNow = ctx.events.some((x) => x.t === 'defeat' && x.seq > e.seq);
  const enemyR = ctx.scene.enemy?.rect ?? R(document.querySelector('#enemy-card .rc-enemy-card'));
  const sources = e.cards.map((c, i) => sourceBox(c, e.seat, ctx, i, e.cards.length));
  sfx.play('card', t);
  const group = killedNow ? null : lastGroupFor(e.cards);
  if (group) {
    group.querySelectorAll('.card-mini').forEach((node, i) => flipFrom(node, sources[i], { delay: t + i * 60 }));
    const tag = group.querySelector('.rc-played-dmg');
    if (tag) anim(tag, [{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(1.3)', offset: 0.6 }, { opacity: 1, transform: 'none' }], { duration: 360, delay: t + FLY, fill: 'backwards' });
  } else if (enemyR) {
    e.cards.forEach((c, i) => flyNode(cardEl(c, { mini: true }), sources[i], cardBox(enemyR, enemyR.width * 0.42), {
      delay: t + i * 60, duration: FLY, rotate: [sources[i]?.angle ?? 0, (i - 0.5) * 10], fadeOut: true, appearNow: true,
    }));
  }
  const impact = t + FLY + (e.cards.length - 1) * 60;
  if (enemyR) {
    const c = centerOf(enemyR);
    if (e.damage > 0) {
      floatText(`−${e.damage}`, { x: c.x, y: c.y - enemyR.height * 0.08 }, { cls: `rc-float-dmg${e.doubled ? ' doubled' : ''}`, delay: impact, duration: 1150, rise: 58 });
      burst(c, { n: 9, colors: ['#ffffff', '#ffd1d6', '#ff4d5e'], spread: 64, size: 5, delay: impact });
      sfx.play('hit', impact);
    }
    if (e.doubled) floatText('♣ ×2', { x: c.x + enemyR.width * 0.5, y: c.y - enemyR.height * 0.34 }, { cls: 'rc-float-x2', delay: impact + 80, duration: 950 });
    if (e.immune.length) floatText(`${e.immune.map((s) => SUIT_SYMBOL[s]).join('')} blocked`, { x: c.x, y: enemyR.bottom - 6 }, { cls: 'rc-float-blocked', delay: impact + 140 });
  }
  const sameEnemy = !killedNow && ctx.scene.enemy?.code === ctx.g.enemy;
  hitShake(killedNow ? ctx.ghost : document.querySelector('#enemy-card .rc-enemy-card'), impact);
  if (sameEnemy || killedNow) {
    const max = killedNow ? ctx.pg.enemyHealth : ctx.g.enemyHealth;
    const before = Math.max(0, ctx.pg.enemyHealth - ctx.pg.enemyDamage);
    const after = killedNow ? 0 : Math.max(0, ctx.g.enemyHealth - ctx.g.enemyDamage);
    setHp(before, max, { instant: true });
    at(impact, () => setHp(after, max));
    tweenNumber($('hp-left'), before, after, impact, 480);
  }
  let end = impact + 420;
  if (e.heal > 0) end = Math.max(end, fxHeal(e.heal, ctx, impact + 120));
  if (e.draw > 0) end = Math.max(end, fxDraw(e, ctx, impact + 160));
  if (e.shield > 0) fxShield(e.shield, impact + 120);
  return end;
}

function fxHeal(n, ctx, t) {
  const from = R($('pile-discard'));
  const to = R($('pile-tavern'));
  if (!from || !to) return t;
  const shown = Math.min(n, 6);
  for (let i = 0; i < shown; i++) {
    flyNode(el('div', 'rc-back rc-back-heal'), cardBox(from, 26), cardBox(to, 26), { delay: t + i * 70, duration: 520, arc: 46, rotate: [0, -12] });
  }
  floatText(`♥ +${n} to the tavern`, { x: centerOf(to).x, y: to.top - 4 }, { cls: 'rc-float-heal', delay: t + 200 });
  sfx.play('heal', t);
  ctx.tavernAt = Math.max(ctx.tavernAt, t + 300);
  ctx.discardAt = Math.max(ctx.discardAt, t);
  return t + 520 + shown * 70;
}

/** Diamond draws go round-robin from the attacker, skipping full hands. */
function fxDraw(e, ctx, t) {
  const { g, pg, me } = ctx;
  const counts = pg.handCounts.slice();
  counts[e.seat] -= e.cards.length;
  let seat = e.seat;
  const order = [];
  for (let k = 0; k < e.draw && counts.some((c) => c < g.maxHand); k++) {
    while (counts[seat] >= g.maxHand) seat = (seat + 1) % g.numPlayers;
    counts[seat]++;
    order.push(seat);
    seat = (seat + 1) % g.numPlayers;
  }
  const tavern = R($('pile-tavern'));
  if (!tavern) return t;
  let end = t;
  order.forEach((s, k) => {
    const delay = t + k * 90;
    if (s === me && ctx.dealt < ctx.newCards.length) {
      end = Math.max(end, dealIn([ctx.newCards[ctx.dealt++]], delay));
    } else {
      const pr = R(plateOf(s));
      if (pr) flyNode(el('div', 'rc-back'), cardBox(tavern, 26), cardBox(pr, 18), { delay, duration: 460, rotate: [0, 18], fadeOut: true, onLand: () => pulse(plateOf(s)?.querySelector('.rc-plate-count')) });
      end = Math.max(end, delay + 460);
    }
  });
  ctx.tavernAt = Math.max(ctx.tavernAt, t);
  return end;
}

/** New cards in your hand fly in from the tavern; each real card appears as its copy lands. */
function dealIn(codes, t, stagger = 80) {
  const tavern = R($('pile-tavern'));
  let end = t;
  codes.forEach((code, i) => {
    const node = document.querySelector(`#hand .hand-card[data-card="${code}"]`);
    const r = R(node);
    if (!node || !r || !tavern) return;
    const c = centerOf(r);
    const angle = parseFloat(node.style.getPropertyValue('--card-angle')) || 0;
    const target = { left: c.x - node.offsetWidth / 2, top: c.y - node.offsetHeight / 2, width: node.offsetWidth, height: node.offsetHeight };
    const delay = t + i * stagger;
    const land = delay + 480;
    flyNode(cardEl(code, { mini: true }), cardBox(tavern, 30), target, { delay, duration: 480, rotate: [-8, angle], arc: 24 });
    anim(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 90, delay: land - 20, fill: 'backwards' });
    node.classList.add('rc-incoming');
    at(land, () => node.classList.remove('rc-incoming'));
    end = land;
  });
  if (codes.length) sfx.play('card', t);
  return end;
}

function fxShield(n, t) {
  const chipEl = $('info-shield');
  const r = R(chipEl);
  pulse(chipEl, t, 1.3);
  pulse($('info-attack'), t + 120, 1.18);
  if (r) floatText(`🛡 +${n}`, { x: centerOf(r).x, y: r.top - 4 }, { cls: 'rc-float-shield', delay: t });
  sfx.play('shield', t);
}

function fxJester(e, ctx, t) {
  const group = [...document.querySelectorAll('#played-cards .rc-played-group')].reverse().find((n) => n.dataset.cards.startsWith('X'));
  const code = group?.dataset.cards;
  if (group && code) flipFrom(group.querySelector('.card-mini'), sourceBox(code, e.seat, ctx));
  const land = t + FLY;
  overlayFlash('rc-flash-jester', land, R($('rc-table')), 800);
  pulse($('info-immune'), land + 60, 1.25);
  const er = R(document.querySelector('#enemy-card .rc-enemy-card'));
  if (er) floatText('Immunity cancelled!', { x: centerOf(er).x, y: er.top + 8 }, { cls: 'rc-float-jester', delay: land + 80, duration: 1300 });
  sfx.play('jester', land);
  return land + 520;
}

function fxYield(e, ctx, t) {
  const pr = R(plateOf(e.seat));
  if (pr) floatText('Yield', { x: centerOf(pr).x, y: pr.top }, { cls: 'rc-float-yield', delay: t, duration: 900 });
  return t + 380;
}

function fxDamage(e, ctx, t) {
  const plate = plateOf(e.seat);
  const pr = R(plate);
  const enemy = ctx.ghost ?? document.querySelector('#enemy-card .rc-enemy-card');
  const er = R(enemy);
  if (er && pr) {
    const a = centerOf(er);
    const b = centerOf(pr);
    anim(enemy, [
      { transform: 'none' },
      { transform: `translate(${(b.x - a.x) * 0.2}px, ${(b.y - a.y) * 0.2}px) scale(1.07)`, offset: 0.42 },
      { transform: 'none' },
    ], { duration: 480, delay: t, easing: 'cubic-bezier(.3,0,.2,1)' });
  }
  const strike = t + 200;
  if (pr) {
    const slash = el('div', 'rc-slash');
    at(strike, () => {
      Object.assign(slash.style, { left: `${centerOf(pr).x}px`, top: `${centerOf(pr).y}px` });
      $('fx').append(slash);
      const a = anim(slash, [{ opacity: 0, transform: 'translate(-50%, -50%) rotate(-28deg) scaleX(.1)' }, { opacity: 1, transform: 'translate(-50%, -50%) rotate(-28deg) scaleX(1)', offset: 0.35 }, { opacity: 0, transform: 'translate(-50%, -50%) rotate(-28deg) scaleX(1.1)' }], { duration: 420, fill: 'forwards' });
      a?.finished.then(() => slash.remove()).catch(() => slash.remove());
    });
    hitShake(plate, strike);
    floatText(`−${e.amount}`, { x: centerOf(pr).x, y: pr.top - 2 }, { cls: 'rc-float-hurt', delay: strike + 40 });
  }
  if (e.seat === ctx.me) {
    overlayFlash('rc-vignette', strike, null, 700);
    hitShake(document.querySelector('.rc-main'), strike);
    at(strike, () => vibrate([60, 40, 60]));
    if (ctx.g.phase === 'discard') callout('Brace!', 'danger', strike + 120, { sub: `Discard ${e.amount} or more`, y: 0.5, duration: 1200 });
  }
  sfx.play('hurt', strike);
  return t + 620;
}

function fxNoDamage(e, ctx, t) {
  const pr = R(plateOf(e.seat));
  if (pr) floatText('🛡 Blocked!', { x: centerOf(pr).x, y: pr.top }, { cls: 'rc-float-shield', delay: t });
  pulse(plateOf(e.seat), t, 1.08);
  sfx.play('shield', t);
  return t + 460;
}

function fxDiscard(e, ctx, t) {
  const pile = R($('pile-discard'));
  if (!pile) return t;
  e.cards.forEach((code, i) => {
    flyNode(cardEl(code, { mini: true }), sourceBox(code, e.seat, ctx, i, e.cards.length), cardBox(pile, 30), {
      delay: t + i * 70, duration: 470, rotate: [ctx.scene.hand.get(code)?.angle ?? 0, 20 + i * 6], arc: 30, appearNow: e.seat === ctx.me,
    });
  });
  const land = t + 470 + (e.cards.length - 1) * 70;
  pulse($('pile-discard'), land, 1.12);
  ctx.discardAt = Math.max(ctx.discardAt, t + 300);
  sfx.play('card', t);
  return land + 60;
}

function fxDefeat(e, ctx, t) {
  const ghost = ctx.ghost;
  const r = ctx.scene.enemy?.rect;
  const pile = R($('pile-discard'));
  ctx.scene.played.forEach((p, i) => {
    flyNode(cardEl(p.code, { mini: true }), p.rect, pile ? cardBox(pile, 26) : null, { delay: t + 160 + i * 45, duration: 440, rotate: [0, 70], appearNow: true, fadeOut: true });
  });
  ctx.discardAt = Math.max(ctx.discardAt, t + 400);
  // The empty battle line's placeholder waits until the old cards have been swept away.
  anim($('played-cards').querySelector('.rc-played-empty'), [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: t + 700, fill: 'backwards' });
  const pip = document.querySelector(`#castle-track [data-card="${e.enemy}"]`);
  if (pip) anim(pip, [{ transform: 'scale(1)', filter: 'brightness(1)' }, { transform: 'scale(1.7)', filter: 'brightness(1.8)', offset: 0.4 }, { transform: 'scale(1)', filter: 'brightness(1)' }], { duration: 560, delay: t + 380 });
  sfx.play('kill', t);
  if (!ghost || !r) return t + 500;
  const c = centerOf(r);
  if (e.exact) {
    // It joins you: glows gold and walks to the top of the tavern deck.
    const tavern = R($('pile-tavern'));
    anim(ghost, [{ filter: 'none' }, { filter: 'brightness(1.5) drop-shadow(0 0 22px #f5c451)', offset: 0.5 }, { filter: 'brightness(1.3) drop-shadow(0 0 14px #f5c451)' }], { duration: 420, delay: t, fill: 'forwards' });
    if (tavern) {
      const dx = centerOf(tavern).x - c.x;
      const dy = centerOf(tavern).y - c.y;
      anim(ghost, [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${dx / 2}px, ${dy / 2 - 40}px) scale(.62) rotate(-8deg)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(.3) rotate(-14deg)`, opacity: 0.2 },
      ], { duration: 700, delay: t + 420, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
      pulse($('pile-tavern'), t + 1100, 1.2);
    }
    floatText('Exact kill — joins the tavern! 🤝', { x: c.x, y: r.top - 4 }, { cls: 'rc-float-royal', delay: t + 80, duration: 1500, rise: 30 });
    burst(c, { n: 12, colors: ['#f5c451', '#fff3c4'], spread: 80, size: 6, delay: t + 120 });
    ctx.tavernAt = Math.max(ctx.tavernAt, t + 1100);
    at(t + 1200, () => ghost.remove());
    return t + 1150;
  }
  anim(ghost, [
    { transform: 'none', opacity: 1, filter: 'none' },
    { transform: 'scale(1.08) rotate(-2deg)', opacity: 1, filter: 'brightness(2.4)', offset: 0.16 },
    { transform: 'scale(.86) rotate(7deg) translateY(14px)', opacity: 0, filter: 'brightness(1) grayscale(1) blur(2px)' },
  ], { duration: 760, delay: t, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
  burst(c, { n: 20, colors: ['#f5c451', '#fff3c4', '#ff9f43', '#ffffff'], spread: 120, size: 8, delay: t + 90 });
  floatText('Defeated!', { x: c.x, y: c.y }, { cls: 'rc-float-royal', delay: t + 120, duration: 1200, rise: 36 });
  at(t + 900, () => ghost.remove());
  return t + 900;
}

function fxReveal(e, ctx, t) {
  const card = document.querySelector('#enemy-card .rc-enemy-card');
  if (!card || card.dataset.card !== e.enemy) return t;
  const to = R(card);
  const pip = R(document.querySelector('#castle-track .rc-pip-royal.now'));
  let dx = 0;
  let dy = -60;
  if (to && pip) { dx = centerOf(pip).x - centerOf(to).x; dy = centerOf(pip).y - centerOf(to).y; }
  anim(card, [
    { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(.25) rotateY(180deg)` },
    { opacity: 1, transform: 'translate(0, 0) scale(1.1) rotateY(0deg)', offset: 0.7 },
    { opacity: 1, transform: 'none' },
  ], { duration: 760, delay: t, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
  const g = ctx.g;
  at(t, () => {
    renderEnemyInfo(g);
    setHp(0, g.enemyHealth, { instant: true });
  });
  at(t + 40, () => setHp(Math.max(0, g.enemyHealth - g.enemyDamage), g.enemyHealth));
  const stats = ROYAL_STATS[rankOf(e.enemy)];
  const suit = suitOf(e.enemy);
  callout(enemyName(e.enemy), 'royal', t + 380, { sub: `⚔ ${stats.attack} · ❤ ${stats.health} · immune to ${SUIT_SYMBOL[suit]} ${SUIT_POWER[suit]}`, y: 0.7, duration: 1500 });
  sfx.play('reveal', t);
  return t + 820;
}

function fxChoose(e, ctx, t) {
  const from = R(plateOf(e.seat));
  const to = R(plateOf(e.target));
  if (from && to && e.seat !== e.target) {
    flyNode(el('i', 'rc-orb'), cardBox(from, 16), cardBox(to, 16), { delay: t, duration: 520, arc: 50, fadeOut: true });
  }
  pulse(plateOf(e.target), t + 500, 1.1);
  return t + 600;
}

function fxFlip(e, ctx, t) {
  const pile = R($('pile-discard'));
  let i = 0;
  for (const [code, box] of ctx.scene.hand) {
    if (ctx.g.hand?.includes(code)) continue;
    flyNode(cardEl(code, { mini: true }), box, pile ? cardBox(pile, 28) : null, { delay: t + i * 40, duration: 420, rotate: [box.angle, 40], appearNow: true, fadeOut: true });
    i++;
  }
  overlayFlash('rc-flash-jester', t, R($('rc-table')), 700);
  const pr = R(plateOf(e.seat)) ?? R($('rc-table'));
  if (pr) floatText('🃏 Jester flip!', { x: centerOf(pr).x, y: pr.top }, { cls: 'rc-float-jester', delay: t, duration: 1200 });
  sfx.play('jester', t);
  ctx.discardAt = Math.max(ctx.discardAt, t + 200);
  ctx.tavernAt = Math.max(ctx.tavernAt, t + 360);
  const fresh = ctx.newCards.slice(ctx.dealt);
  ctx.dealt = ctx.newCards.length;
  return Math.max(t + 420 + i * 40, dealIn(fresh, t + 360, 70));
}

function fxWon(e, ctx, t) {
  at(t, () => renderEnemyInfo(ctx.g));
  // Backwards fill keeps the crown hidden while the last royal's defeat plays.
  anim(document.querySelector('#enemy-card .rc-enemy-empty'), [
    { opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(1.25)', offset: 0.7 }, { opacity: 1, transform: 'none' },
  ], { duration: 700, delay: t, fill: 'backwards' });
  confetti(t);
  callout('Victory!', 'good', t + 100, { sub: 'The castle has fallen', duration: 1800 });
  burst(centerOf(R($('rc-table')) ?? { left: 0, top: 0, width: innerWidth, height: innerHeight }), { n: 26, spread: 160, size: 9, delay: t + 100 });
  sfx.play('win', t);
  return t + 900;
}

function fxLost(e, ctx, t) {
  // Re-apply the class after setting the delay so the transition actually waits.
  const table = $('rc-table');
  table.classList.remove('rc-fallen');
  void table.offsetWidth;
  table.style.setProperty('--fall-delay', `${t}ms`);
  table.classList.add('rc-fallen');
  callout('The castle holds', 'danger', t + 80, { sub: `${who(e.seat)} ${e.reason}`, duration: 1800 });
  sfx.play('lose', t);
  return t + 900;
}

/** A new game: the first royal steps out of the castle and the hand is dealt from the tavern. */
function introTimeline(g) {
  const card = document.querySelector('#enemy-card .rc-enemy-card');
  const to = R(card);
  const pip = R(document.querySelector('#castle-track .rc-pip-royal.now'));
  if (card && to && pip) {
    anim(card, [
      { opacity: 0, transform: `translate(${centerOf(pip).x - centerOf(to).x}px, ${centerOf(pip).y - centerOf(to).y}px) scale(.25) rotateY(180deg)` },
      { opacity: 1, transform: 'scale(1.1) rotateY(0deg)', offset: 0.7 },
      { opacity: 1, transform: 'none' },
    ], { duration: 800, delay: 250, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
  }
  const n = g.numPlayers;
  callout('The siege begins', 'royal', 60, { sub: n === 1 ? 'Solo run · 8 cards · 2 Jester flips' : `${n} players · ${SETUP[n].hand} cards each`, y: 0.7, duration: 1500 });
  sfx.play('reveal', 250);
  const codes = g.hand ? sortHand(g.hand) : [];
  const end = dealIn(codes, 650, 70);
  const tavern = R($('pile-tavern'));
  if (tavern) {
    for (const plate of document.querySelectorAll('#party .rc-plate:not(.is-you)')) {
      const pr = R(plate);
      if (!pr) continue;
      for (let i = 0; i < 3; i++) flyNode(el('div', 'rc-back'), cardBox(tavern, 26), cardBox(pr, 18), { delay: 650 + i * 110, duration: 440, rotate: [0, 16], fadeOut: true });
    }
  }
  return Math.max(end, 1300);
}

// ---------- Modals ----------
function showModal(id) {
  const m = $(id);
  if (!m.classList.contains('hidden')) return;
  if (id !== 'modal-rules') for (const c of $('fx').querySelectorAll('.rc-callout')) c.remove();
  if (!document.querySelector('.rc-modal:not(.hidden)')) lastFocus = document.activeElement;
  m.classList.remove('hidden');
  document.body.classList.add('modal-open');
  if (id !== 'modal-confirm') requestAnimationFrame(() => m.querySelector('button:not(.hidden):not([disabled])')?.focus({ preventScroll: true }));
}
function hideModal(id) {
  const m = $(id);
  if (m.classList.contains('hidden')) return;
  m.classList.add('hidden');
  if (!document.querySelector('.rc-modal:not(.hidden)')) {
    document.body.classList.remove('modal-open');
    if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }
}

/**
 * Opens the Jester chooser / results once the current animation has had its moment.
 * `delay` is the new animation's length; null keeps the schedule already set.
 */
function syncModals(delay = 0) {
  clearTimeout(modalTimer);
  if (delay !== null) modalAt = performance.now() + (delay > 0 ? Math.min(delay, 1800) + 250 : 0);
  const g = view?.game;
  if (!g) { hideModal('modal-over'); hideModal('modal-jester'); return; }
  const myTurn = view.you.seat >= 0 && g.currentSeat === view.you.seat;
  const wantJester = g.phase === 'jester' && myTurn;
  const wantOver = isOver(g) && !overDismissed;
  if (!wantJester) hideModal('modal-jester');
  if (!isOver(g)) hideModal('modal-over');
  if (!wantJester && !wantOver) return;
  const open = !$(wantOver ? 'modal-over' : 'modal-jester').classList.contains('hidden');
  const wait = modalAt - performance.now();
  if (open || wait <= 0) {
    if (wantJester) showJesterModal(g);
    if (wantOver) showOverModal(g);
  } else modalTimer = setTimeout(() => syncModals(0), wait);
}

function showJesterModal(g) {
  const box = $('jester-choices');
  box.replaceChildren();
  view.players.forEach((p, seat) => {
    const meta = el('span', 'lobby-stats', `${g.handCounts[seat]}/${g.maxHand} cards`);
    const row = playerRow(p, seat, { tag: 'button', meta });
    row.type = 'button';
    if (seat === view.you.seat) row.classList.add('is-you');
    row.onclick = () => send({ type: 'chooseNext', seat });
    box.append(row);
  });
  showModal('modal-jester');
}

function showOverModal(g) {
  const won = g.phase === 'won';
  const tierEmoji = { gold: '🥇', silver: '🥈', bronze: '🥉' };
  const box = $('over-box');
  box.classList.toggle('rc-over-win', won);
  box.classList.toggle('rc-over-loss', !won);
  $('over-emblem').textContent = won ? (tierEmoji[g.tier] ?? '👑') : '💀';
  $('over-title').textContent = won
    ? `${g.tier ? `${g.tier[0].toUpperCase()}${g.tier.slice(1)} Victory!` : 'Victory!'}`
    : 'Defeat';
  $('over-sub').textContent = won
    ? (g.numPlayers === 1 ? `You stormed the castle using ${2 - g.soloJestersLeft} Jester flip${2 - g.soloJestersLeft === 1 ? '' : 's'}.` : 'Your party stormed the castle together.')
    : `${who(g.currentSeat)} ${g.loseReason}.`;
  renderCastle($('over-track'), g);
  const stats = $('over-stats');
  const stat = (n, l) => { const d = el('div'); d.append(el('b', null, n), el('span', null, l)); return d; };
  stats.replaceChildren(stat(`${g.defeated.length}/12`, 'royals defeated'), stat(String(g.defeated.filter((c) => rankOf(c) === 'K').length), 'kings'));
  if (g.enemy && !won) stats.append(stat(`${Math.max(0, g.enemyHealth - g.enemyDamage)}`, `HP left on ${label(g.enemy)}`));
  else if (g.numPlayers === 1) stats.append(stat(String(2 - g.soloJestersLeft), 'Jester flips used'));
  renderRatingResult();
  $('btn-again').classList.toggle('hidden', view.you.seat < 0);
  showModal('modal-over');
}

function renderRatingResult() {
  const box = $('over-rating');
  const rating = view.lastRating;
  if (!rating || rating.gameId !== view.gameId || !rating.changes.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const rows = rating.changes.map((c) => {
    const row = el('div', 'lb-row');
    const delta = el('span', c.delta >= 0 ? 'rc-delta-up' : 'rc-delta-down', `${c.delta >= 0 ? '+' : ''}${c.delta}`);
    row.append(el('span', 'lb-name', c.seat === view.you.seat ? 'You' : c.name), el('span', 'lb-elo', String(c.after)), delta);
    return row;
  });
  box.replaceChildren(el('div', 'lb-header', '🏆 Regicide rating'), ...rows);
}

let confirmDone = null;
/** A styled confirm dialog; resolves true/false. */
function askConfirm({ title, body, ok = 'OK', danger = false }) {
  if (confirmDone) confirmDone(false);
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    const okBtn = $('confirm-ok');
    okBtn.textContent = ok;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    confirmDone = (value) => {
      confirmDone = null;
      hideModal('modal-confirm');
      resolve(value);
    };
    showModal('modal-confirm');
    okBtn.focus();
  });
}

// ---------- Stats (Bridge's Players table, ranking only) ----------
let statsRows = [];
let statsMinGames = 3;
let statsSort = { col: 'elo', dir: 'desc' };

async function showStats() {
  showScreen('screen-stats');
  history.replaceState(null, '', `${location.pathname}?view=stats`);
  $('stats-content').innerHTML = '<p class="stats-empty">Loading…</p>';
  try {
    const res = await fetch('/api/regicide/stats');
    statsRows = res.ok ? await res.json() : [];
  } catch { statsRows = []; }
  renderStats();
}

function hideStats() {
  history.replaceState(null, '', location.pathname);
  render();
}

function sortStats(col) {
  statsSort = statsSort.col === col ? { col, dir: statsSort.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: col === 'name' ? 'asc' : 'desc' };
  renderStats();
}

function renderStats() {
  const content = $('stats-content');
  for (const b of document.querySelectorAll('#rc-min-games .min-games-btn')) b.classList.toggle('active', Number(b.dataset.value) === statsMinGames);
  const sortFns = {
    elo: (r) => r.elo, games: (r) => r.games, wins: (r) => r.wins, winPct: (r) => r.winPct,
    best: (r) => r.bestDefeated, avg: (r) => r.avgDefeated, name: (r) => r.displayName.toLowerCase(),
  };
  const fn = sortFns[statsSort.col] ?? sortFns.elo;
  const sorted = statsRows.filter((r) => r.games >= statsMinGames).sort((a, b) => {
    const av = fn(a), bv = fn(b);
    return statsSort.dir === 'desc' ? (bv > av ? 1 : bv < av ? -1 : 0) : (av > bv ? 1 : av < bv ? -1 : 0);
  });
  if (!sorted.length) {
    content.innerHTML = `<p class="stats-empty">No players with ${statsMinGames}+ games yet.</p>`;
    return;
  }
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const medals = ['🥇', '🥈', '🥉'];
  const arrow = (col) => (statsSort.col !== col ? '<span class="sort-arrow">⇅</span>' : `<span class="sort-arrow active">${statsSort.dir === 'desc' ? '▼' : '▲'}</span>`);
  const th = (col, label, left = false) => `<th class="${left ? 'stats-th-left' : ''}${statsSort.col === col ? ' sorted' : ''}" data-sort="${col}">${label} ${arrow(col)}</th>`;
  const body = sorted.map((r, i) => `<tr>
      <td class="stats-td-name">${i < 3 ? medals[i] : `${i + 1}.`} ${esc(r.displayName)}</td>
      <td class="stats-td-num stats-elo">${r.elo}</td>
      <td class="stats-td-num">${r.games}</td>
      <td class="stats-td-num">${r.wins}</td>
      <td class="stats-td-num">${r.winPct}%</td>
      <td class="stats-td-num${r.bestDefeated === 12 ? ' rc-best-win' : ''}">${r.bestDefeated}/12</td>
      <td class="stats-td-num">${r.avgDefeated.toFixed(1)}</td>
    </tr>`).join('');
  content.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr>${th('name', 'Player', true)}${th('elo', 'Rating')}${th('games', 'G')}${th('wins', 'W')}${th('winPct', 'Win%')}${th('best', 'Best')}${th('avg', 'Avg')}</tr></thead>
    <tbody>${body}</tbody></table></div>`;
  for (const cell of content.querySelectorAll('th[data-sort]')) cell.addEventListener('click', () => sortStats(cell.dataset.sort));
}

// ---------- Room lifecycle ----------
function enterRoom(code) {
  roomCode = code;
  view = null;
  lastGameNo = -1;
  lobbySeen.clear();
  history.replaceState(null, '', `#${code}${hashInfo.pid ? `:${hashInfo.pid}` : ''}`);
  render();
  connect(code);
}

function leaveRoom(notify = true) {
  if (notify) send({ type: 'leave' });
  const socket = ws;
  ws = null;
  roomCode = null;
  view = null;
  selected.clear();
  if (socket) socket.onmessage = null;
  clearTimeout(reconnectTimer);
  clearTimeout(modalTimer);
  fxReset();
  if (socket) { socket.onclose = null; setTimeout(() => socket.close(), 50); }
  history.replaceState(null, '', location.pathname);
  $('overlay-reconnect').classList.add('hidden');
  for (const m of document.querySelectorAll('.rc-modal')) m.classList.add('hidden');
  document.body.classList.remove('modal-open');
  render();
}

async function requireName() {
  if (!FunAuth.token()) { toast('Sign in with Telegram first', 'error'); return false; }
  const input = $('input-name');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    toast('Enter your name first', 'error');
    return false;
  }
  // Telegram accounts without a usable name pick one once, saved to the shared profile (like Bridge).
  if (!input.readOnly && profile && name !== profile.displayName) {
    try {
      await fetch('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FunAuth.token()}` }, body: JSON.stringify({ displayName: name }) });
      profile.displayName = name;
    } catch { /* keep going with the local name */ }
  }
  playerName = name;
  store.set('playerName', name);
  return true;
}

/** Bridge's home flow: signed in → game section with the Telegram name; otherwise the login box. */
function showSignedIn(p) {
  profile = p;
  $('login-section').classList.add('hidden');
  $('game-section').classList.remove('hidden');
  const input = $('input-name');
  const name = p.nameRequired ? '' : (p.displayName || playerName);
  input.value = name;
  input.readOnly = !!(p.displayName && !p.nameRequired);
  input.classList.toggle('input-readonly', input.readOnly);
  if (name) { playerName = name; store.set('playerName', name); }
  const status = $('auth-status');
  status.innerHTML = '';
  if (p.displayName) {
    status.append('Logged in as ', el('strong', null, p.displayName), ' · ');
    const out = el('a', null, 'Logout');
    out.href = '#';
    out.onclick = (e) => { e.preventDefault(); FunAuth.logout(); profile = null; showSignedOut(); FunLeaderboard.mount($('leaderboard-section'), { game: 'regicide' }); };
    status.append(out);
  }
}

function showSignedOut() {
  $('game-section').classList.add('hidden');
  $('login-section').classList.remove('hidden');
  FunAuth.mountLogin($('login-section'), (p) => {
    showSignedIn(p);
    FunLeaderboard.mount($('leaderboard-section'), { game: 'regicide' });
    if (pendingRoom) { const room = pendingRoom; pendingRoom = null; enterRoom(room); }
  });
}

let pendingRoom = null;
async function initAuth() {
  const p = await FunAuth.profile();
  if (p) showSignedIn(p);
  else showSignedOut();
}

async function createRoom() {
  if (!await requireName()) return;
  const btn = $('btn-create');
  btn.disabled = true;
  try {
    const res = await fetch('/api/regicide/create', { method: 'POST' });
    if (!res.ok) throw new Error('create failed');
    const { roomCode: code } = await res.json();
    enterRoom(code);
  } catch {
    toast('Could not create a room — check your connection', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function joinRoom() {
  if (!await requireName()) return;
  const code = $('input-code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    $('input-code').focus();
    toast('Room codes are 4 characters', 'error');
    return;
  }
  enterRoom(code);
}

function inviteUrl() {
  return `${location.origin}${location.pathname}#${roomCode}`;
}

async function shareInvite() {
  const url = inviteUrl();
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'Regicide on Fun Central', text: `Join my Regicide game — room ${roomCode}`, url }); return; } catch { /* cancelled */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied 📋');
  } catch {
    prompt('Copy this invite link:', url);
  }
}

async function flipJester() {
  const g = view?.game;
  if (!g) return;
  const left = g.soloJestersLeft - 1;
  const ok = await askConfirm({
    title: '🃏 Flip a Jester?',
    body: `Your whole hand (${g.hand?.length ?? 0} cards) is discarded and you draw a fresh hand of up to ${g.maxHand}. ${left === 0 ? 'This is your last flip.' : `${left} flip left after this.`}`,
    ok: 'Flip Jester',
  });
  if (ok) send({ type: 'flip' });
}

function pickBestFit() {
  const g = view?.game;
  if (!g?.hand || g.phase !== 'discard') return;
  selected = new Set(bestFit(g.hand, g.pendingDamage));
  refreshHandArea();
}

// ---------- Wire up ----------
$('input-name').value = playerName;
$('btn-create').addEventListener('click', createRoom);
$('btn-join').addEventListener('click', joinRoom);
$('input-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('input-code').value ? joinRoom() : createRoom()); });
$('btn-share').addEventListener('click', shareInvite);
$('lobby-code-btn').addEventListener('click', shareInvite);
$('tb-room').addEventListener('click', shareInvite);
$('btn-start').addEventListener('click', () => send({ type: 'start' }));
$('btn-leave').addEventListener('click', async () => {
  const g = view?.game;
  const midGame = g && !isOver(g) && view.you.seat >= 0;
  if (midGame && !await askConfirm({ title: 'Leave this game?', body: 'Your party will be stuck until you come back — your seat is kept.', ok: 'Leave', danger: true })) return;
  leaveRoom(true);
});
$('btn-end').addEventListener('click', async () => {
  const g = view?.game;
  if (!g) return;
  const rated = g.defeated.length > 0;
  const ok = await askConfirm({
    title: 'End this run?',
    body: `Everyone returns to the lobby. ${rated ? `The run still counts for ratings (${g.defeated.length}/12 royals).` : 'No royal has fallen yet, so it won\'t be rated.'}`,
    ok: 'End run',
    danger: true,
  });
  if (ok) send({ type: 'backToLobby' });
});
$('btn-sound').addEventListener('click', () => { sfx.toggle(); renderTopBar(); });
$('btn-yield').addEventListener('click', () => send({ type: 'yield' }));
$('btn-flip').addEventListener('click', flipJester);
$('btn-act').addEventListener('click', () => {
  const action = $('btn-act').dataset.action;
  if (action === 'results') { overDismissed = false; showOverModal(view.game); return; }
  if (action === 'jester') { showJesterModal(view.game); return; }
  if (action === 'flip') { send({ type: 'flip' }); return; }
  if (!action) return;
  send({ type: action, cards: [...selected] });
});
$('btn-bestfit').addEventListener('click', pickBestFit);
$('btn-stats').addEventListener('click', showStats);
$('btn-stats-home').addEventListener('click', hideStats);
for (const b of document.querySelectorAll('#rc-min-games .min-games-btn')) {
  b.addEventListener('click', () => { statsMinGames = Number(b.dataset.value); renderStats(); });
}
$('btn-again').addEventListener('click', () => send({ type: 'backToLobby' }));
$('btn-over-close').addEventListener('click', () => { overDismissed = true; hideModal('modal-over'); });
$('confirm-ok').addEventListener('click', () => confirmDone?.(true));
$('confirm-cancel').addEventListener('click', () => confirmDone?.(false));
$('modal-confirm').addEventListener('click', (e) => { if (e.target === e.currentTarget) confirmDone?.(false); });

const openRules = () => showModal('modal-rules');
$('btn-rules').addEventListener('click', openRules);
$('btn-rules-home').addEventListener('click', openRules);
$('btn-rules-lobby').addEventListener('click', openRules);
$('modal-rules').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.closest('[data-close]')) hideModal('modal-rules');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (confirmDone) confirmDone(false);
    else if (!$('modal-rules').classList.contains('hidden')) hideModal('modal-rules');
    else if (selected.size && view?.game) { selected.clear(); refreshHandArea(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
  const g = view?.game;
  if (!g || !$('screen-game').classList.contains('active') || document.querySelector('.rc-modal:not(.hidden)')) return;
  if (view.you.seat < 0 || g.currentSeat !== view.you.seat || !g.hand) return;
  const key = e.key.toLowerCase();
  if (/^[1-9]$/.test(key)) {
    const code = sortHand(g.hand)[Number(key) - 1];
    const incoming = code && document.querySelector(`#hand .hand-card.rc-incoming[data-card="${code}"]`);
    if (code && !incoming && (g.phase === 'play' || g.phase === 'discard')) { e.preventDefault(); onCardTap(code); }
  } else if (key === 'enter' && !e.target.closest?.('button')) {
    if (!$('btn-act').disabled) { e.preventDefault(); $('btn-act').click(); }
  } else if (key === 'y') {
    const y = $('btn-yield');
    if (!y.disabled && !y.classList.contains('hidden')) y.click();
  } else if (key === 'b') {
    if (!$('btn-bestfit').classList.contains('hidden')) pickBestFit();
  } else if (key === 'f') {
    const f = $('btn-flip');
    if (!f.disabled && !f.classList.contains('hidden')) flipJester();
  }
});

// Desktop: keep the log open by default.
if (matchMedia('(min-width: 1100px)').matches) $('log-details').open = true;

// The fan is laid out in pixels, so re-lay it when the width changes.
let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (view?.game) renderHand(view.game, view.you.seat === view.game.currentSeat); }, 100);
});

// Reconnect promptly when a phone wakes the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && roomCode && ws?.readyState !== WebSocket.OPEN) connect(roomCode); // also takes over from another window
});
setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send('ping'); }, 25000);

function openFromHash(room) {
  $('input-code').value = room;
  if (FunAuth.token() && playerName) enterRoom(room);
  else { pendingRoom = room; render(); toast(`Sign in to join room ${room}`); }
}

// An invite link opened in an already-loaded tab only changes the hash.
addEventListener('hashchange', () => {
  const { room } = parseHash();
  if (room && room !== roomCode) {
    if (roomCode) leaveRoom(true);
    openFromHash(room);
  }
});

FunLeaderboard.mount($('leaderboard-section'), { game: 'regicide' });
initAuth().finally(() => {
  if (hashInfo.room) openFromHash(hashInfo.room);
  else if (new URLSearchParams(location.search).get('view') === 'stats') showStats();
  else render();
});
