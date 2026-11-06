'use strict';

// ---------- Board helpers (mirror src/omok/engine.ts; the room stays authoritative) ----------
const COLS = 15;
const ROWS = 15;
const STONES = [
  { name: 'Black', fill: '#8c9aab', light: '#526072', dark: '#10151e' },
  { name: 'White', fill: '#f5f1e8', light: '#ffffff', dark: '#b8afa1' },
];
function seatColour(seat) {
  const black = view?.game?.blackSeat ?? view?.nextStartingSeat ?? 0;
  return STONES[seat === black ? 0 : 1];
}
function stoneClass(seat) { return seatColour(seat).name.toLowerCase(); }
const coordinate = (row, col) => `${String.fromCharCode(65 + col)}${row + 1}`;
let selectedMove = null;
let movePending = false;
let cursor = { row: 7, col: 7 };
let replaced = false;
function canPlace() {
  const g = view?.game;
  return !!g && g.phase === 'play' && view.you.seat === g.currentSeat && !openingActive() && !movePending && ws?.readyState === WebSocket.OPEN;
}
function clearMove() { selectedMove = null; movePending = false; }
const isOver = (g) => g.phase === 'done';

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function toast(message, kind = '') {
  const stack = $('toasts');
  const node = el('div', `om-toast ${kind}`.trim(), message);
  stack.append(node);
  while (stack.children.length > 3) stack.firstChild.remove();
  setTimeout(() => node.remove(), kind === 'error' ? 3800 : 2600);
}

// ---------- Identity ----------
function parseHash() {
  let raw;
  try { raw = decodeURIComponent(location.hash.slice(1)); }
  catch { return { room: null, pid: null }; }
  if (!raw) return { room: null, pid: null };
  const [room, pid] = raw.split(':');
  return { room: /^[A-Za-z0-9]{4}$/.test(room) ? room.toUpperCase() : null, pid: pid || null };
}

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* blocked */ } },
};

const hashInfo = parseHash();
let playerId = hashInfo.pid || store.get('omokPlayerId');
if (!playerId) playerId = (crypto.randomUUID?.() ?? `p${Date.now()}${Math.random().toString(36).slice(2)}`);
if (!hashInfo.pid) store.set('omokPlayerId', playerId);
let playerName = store.get('playerName') || '';
let profile = null; // verified Telegram profile (FunAuth), null until signed in

// ---------- State ----------
let ws = null;
let roomCode = null;
let view = null;
let reconnectDelay = 800;
let reconnectTimer = 0;
let lastGameNo = -1;
let overDismissed = false;
let joinSent = false;
let joinBlocked = null;
let hasSeenGame = false;
const modalStack = [];
let renderedMoveCount = 0;
const lobbySeen = new Set();
const OPENING_REVEAL_MS = 2200;
const openingReveal = { key: null, deadline: 0, timer: 0, lastBeat: -1, settledSound: false };

function resetOpeningReveal() {
  clearTimeout(openingReveal.timer);
  openingReveal.key = null;
  openingReveal.deadline = 0;
  openingReveal.timer = 0;
  openingReveal.lastBeat = -1;
  openingReveal.settledSound = false;
  $('om-game').classList.remove('opening');
}
function openingActive() {
  return view?.game?.phase === 'play' && view.game.moveCount === 0 &&
    openingReveal.key === view.gameId && performance.now() < openingReveal.deadline;
}
function openingSettled() {
  return !motionOK() || openingReveal.deadline - performance.now() <= 500;
}
function syncOpeningReveal(next) {
  if (!next.game || next.game.phase !== 'play' || next.game.moveCount > 0) {
    resetOpeningReveal();
    return;
  }
  if (openingReveal.key === next.gameId) return;
  resetOpeningReveal();
  openingReveal.key = next.gameId;
  // Use server-relative time, not the player's wall clock. Reloads resume rather
  // than replay the reveal, and presence broadcasts don't restart its timer.
  const remaining = Math.max(0, (next.game.opensAt ?? 0) - (next.serverTime ?? Date.now()));
  openingReveal.deadline = performance.now() + remaining;
  if (remaining > 0) openingReveal.timer = setTimeout(tickOpeningReveal, 0);
}
function paintOpeningReveal() {
  const active = openingActive();
  $('om-game').classList.toggle('opening', active);
  if (!active) return;
  const elapsed = OPENING_REVEAL_MS - (openingReveal.deadline - performance.now());
  const beats = [0, 140, 310, 510, 740, 1000, 1300];
  const beat = Math.max(0, beats.filter(time => time <= elapsed).length - 1);
  const settled = openingSettled();
  const picked = settled ? view.game.currentSeat : beat % 2;
  if (document.visibilityState === 'visible') {
    if (settled && !openingReveal.settledSound) {
      openingReveal.settledSound = true;
      sfx.play('reveal');
    } else if (!settled && openingReveal.lastBeat !== beat) {
      openingReveal.lastBeat = beat;
      sfx.play('shuffle');
    }
  }
  for (const plate of $('om-players').children) {
    const selected = Number(plate.dataset.seat) === picked;
    plate.classList.toggle('opening-pick', selected);
    plate.classList.toggle('opening-settled', selected && settled);
    const tag = plate.querySelector('.om-opening-tag');
    const label = settled ? 'first' : '…';
    if (tag && tag.textContent !== label) tag.textContent = label;
  }
  renderTurn(view.game, false);
  renderCaption(view.game);
}
function tickOpeningReveal() {
  clearTimeout(openingReveal.timer);
  openingReveal.timer = 0;
  if (!openingActive()) {
    if (view?.game && view.gameId === openingReveal.key) renderGame();
    return;
  }
  paintOpeningReveal();
  openingReveal.timer = setTimeout(tickOpeningReveal, 40);
}
document.addEventListener('visibilitychange', () => {
  if (openingReveal.key) tickOpeningReveal();
});

// ---------- Sound (synthesised, off by default) ----------
const sfx = (() => {
  let ctx = null;
  let on = store.get('omokSound') === 'on';
  function audio() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function tone(freq, { at = 0, dur = 0.14, type = 'sine', gain = 0.08, slide = 0 } = {}) {
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
  function shuffleTick() {
    const c = audio();
    if (!c) return;
    const duration = 0.045;
    const buffer = c.createBuffer(1, Math.ceil(c.sampleRate * duration), c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = c.createBufferSource();
    const filter = c.createBiquadFilter();
    const amp = c.createGain();
    source.buffer = buffer;
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    filter.Q.value = 0.6;
    const now = c.currentTime;
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(0.035, now + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(amp).connect(c.destination);
    source.start(now);
    source.stop(now + duration);
  }
  const SOUNDS = {
    shuffle: shuffleTick,
    reveal: () => { tone(440, { dur: 0.1, type: 'triangle', gain: 0.025 }); tone(660, { at: 0.06, dur: 0.12, gain: 0.02 }); },
    drop: () => tone(240, { dur: 0.09, type: 'triangle', gain: 0.07, slide: -80 }),
    turn: () => { tone(660, { dur: 0.1, gain: 0.07 }); tone(990, { at: 0.1, dur: 0.16, gain: 0.07 }); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.12, dur: 0.3, type: 'triangle', gain: 0.08 })),
    lose: () => [392, 349, 311, 262].forEach((f, i) => tone(f, { at: i * 0.18, dur: 0.38, type: 'sawtooth', gain: 0.04 })),
    draw: () => [440, 440, 466].forEach((f, i) => tone(f, { at: i * 0.14, dur: 0.24, type: 'triangle', gain: 0.06 })),
  };
  return {
    get on() { return on; },
    play(name, delayMs = 0) {
      if (!on || !SOUNDS[name]) return;
      const run = () => { try { SOUNDS[name](); } catch { /* audio unavailable */ } };
      if (delayMs > 0) setTimeout(run, delayMs);
      else run();
    },
    toggle() {
      on = !on;
      store.set('omokSound', on ? 'on' : 'off');
      if (on) this.play('turn');
      return on;
    },
  };
})();

// ---------- Animation layer ----------
const fx = { timers: new Set() };
function at(ms, fn) {
  if (ms <= 0) { fn(); return; }
  const id = setTimeout(() => { fx.timers.delete(id); fn(); }, ms);
  fx.timers.add(id);
}
function fxReset() {
  for (const id of fx.timers) clearTimeout(id);
  fx.timers.clear();
  $('fx').replaceChildren();
}
function motionOK() {
  return !matchMedia('(prefers-reduced-motion: reduce)').matches && document.visibilityState === 'visible';
}
function callout(text, kind = '', delay = 0, duration = 1400) {
  if (!motionOK()) return;
  at(delay, () => {
    const t = document.getElementById('om-table')?.getBoundingClientRect();
    if (!t) return;
    const n = el('div', `om-callout ${kind}`.trim());
    n.append(el('span', 'om-callout-main', text));
    n.style.left = `${t.left + t.width / 2}px`;
    n.style.top = `${t.top + t.height * 0.45}px`;
    $('fx').append(n);
    const a = n.animate([
      { opacity: 0, transform: 'translate(-50%, -50%) scale(.7)' },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1.05)', offset: 0.16 },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.78 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1.06)' },
    ], { duration, easing: 'ease-out', fill: 'forwards' });
    a?.finished.then(() => n.remove()).catch(() => n.remove());
  });
}
function confetti(delay = 0) {
  if (!motionOK()) return;
  at(delay, () => {
    const colors = ['#f5om51', '#ef3d4b', '#5ec8f2', '#6ee7a8', '#c084fc', '#fff3om'];
    for (let i = 0; i < 48; i++) {
      const p = el('i', 'om-confetti');
      Object.assign(p.style, { left: `${Math.random() * innerWidth}px`, top: '-16px', background: colors[i % colors.length] });
      $('fx').append(p);
      const drift = (Math.random() - 0.5) * 160;
      const a = p.animate([
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${drift}px, ${innerHeight * (0.7 + Math.random() * 0.35)}px) rotate(${360 + Math.random() * 540}deg)`, opacity: 0.2 },
      ], { duration: 1800 + Math.random() * 1400, delay: Math.random() * 500, easing: 'cubic-bezier(.25,.6,.45,1)', fill: 'both' });
      a?.finished.then(() => p.remove()).catch(() => p.remove());
    }
  });
}

// ---------- Networking ----------
function connect(code) {
  if (window.FC_MOVED) return;
  roomCode = code;
  replaced = false;
  clearMove();
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = FunAuth.token();
  const socket = new WebSocket(`${proto}//${location.host}/api/omok/ws?room=${code}&playerId=${encodeURIComponent(playerId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`);
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
    if (event.reason === 'Replaced by new connection') {
      replaced = true;
      clearMove();
      if (view?.game) renderGame();
      $('reconnect-message').textContent = 'This table is open in another window.';
      $('btn-reconnect').classList.remove('hidden');
      $('overlay-reconnect').classList.remove('hidden');
      return;
    }
    clearMove();
    if (view?.game) renderGame();
    $('reconnect-message').textContent = 'Reconnecting…';
    $('btn-reconnect').classList.add('hidden');
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
  clearMove();
  if (view?.game) renderGame();
  if (msg.code === 'notFound') {
    toast(`Room ${roomCode} doesn't exist (or has expired)`, 'error');
    leaveRoom(false);
    return;
  }
  if (msg.message?.includes('removed from this lobby')) joinBlocked = 'kicked';
  else if (msg.message?.includes('This room is full')) joinBlocked = 'full';
  toast(msg.message, 'error');
  if (view && !view.game) render();
}

let overPending = false;

function onState(next) {
  const prev = view;
  if (next.gameId !== prev?.gameId || next.game?.moveCount !== prev?.game?.moveCount || next.game?.phase !== prev?.game?.phase || next.you.seat !== prev?.you?.seat) clearMove();
  if (next.game) hasSeenGame = true;
  if (next.you?.kicked) joinBlocked = 'kicked';
  // Connection flags/names and late rating results don't change the board:
  // refresh those parts without interrupting the results panel.
  if (next.game && prev?.game && prev.gameNo === next.gameNo && JSON.stringify(next.game) === JSON.stringify(prev.game)) {
    view = next;
    syncOpeningReveal(next);
    renderTopBar();
    renderPlayers(next.game);
    renderCells(next.game);
    renderDrops(next.game);
    renderTurn(next.game, next.you.seat >= 0 && next.game.currentSeat === next.you.seat && !isOver(next.game));
    if (!overPending) syncOverModal();
    return;
  }
  fxReset();
  overPending = false;
  view = next;
  syncOpeningReveal(next);
  if (next.you.kicked) joinBlocked = 'kicked';
  if (next.you.seat >= 0) { joinSent = true; joinBlocked = null; }
  if (next.game) { hasSeenGame = true; if (roomCode) store.set(`omokWatched:${roomCode}`, '1'); }
  if (!joinSent && next.you.seat < 0 && !next.game && FunAuth.token() && !hasSeenGame && !joinBlocked) {
    joinSent = true;
    send({ type: 'join', name: playerName });
  }
  if (next.gameNo !== lastGameNo) {
    lastGameNo = next.gameNo;
    overDismissed = false;
    renderedMoveCount = 0;
  }
  overPending = !!next.game && isOver(next.game);
  render();
  if (overPending) at(600, () => { overPending = false; syncOverModal(); });
  const g = next.game;
  if (g && prev?.game && prev.gameNo === next.gameNo && g.moveCount > (prev.game?.moveCount ?? 0)) {
    sfx.play(g.isDraw ? 'draw' : g.winner !== null && g.winner !== view.you.seat ? 'lose' : 'drop');
    if (g.winner === view.you.seat) { confetti(); callout('You win!', 'good'); sfx.play('win'); }
    else if (g.winner !== null && g.winner !== view.you.seat) callout(`${playerNameOf(g.winner)} wins`);
    else if (g.isDraw) callout('Draw');
    else if (view.you.seat >= 0 && g.currentSeat === view.you.seat) sfx.play('turn');
  }
}

// ---------- Screens ----------
function showScreen(id) {
  for (const sc of document.querySelectorAll('.screen')) sc.classList.toggle('active', sc.id === id);
  document.body.dataset.screen = id;
}

function render() {
  const inRoom = !!roomCode;
  $('top-bar').classList.toggle('hidden', !inRoom);
  $('tb-room').textContent = roomCode || '';
  $('tb-name').textContent = playerName;
  renderTopBar();
  if (!inRoom) { showScreen('screen-home'); return; }
  if (!view) { showScreen('screen-lobby'); renderLobbyLoading(); return; }
  if (!view.game) { showScreen('screen-lobby'); renderLobby(); hideModal('modal-over'); return; }
  showScreen('screen-game');
      if (view?.game) renderGame();
  if (!overPending) syncOverModal();
}

function renderTopBar() {
  const sound = $('btn-sound');
  sound.textContent = sfx.on ? '🔊' : '🔇';
  sound.setAttribute('aria-pressed', String(sfx.on));
  sound.title = sfx.on ? 'Sound effects on' : 'Sound effects off';
  $('btn-results').classList.toggle('hidden', !view?.game || !isOver(view.game));
}

// ---------- Lobby ----------
function renderLobbyLoading() {
  $('lobby-code').textContent = roomCode;
  $('lobby-players').replaceChildren(el('div', 'player-item om-empty', 'Connecting…'));
  $('btn-start').classList.add('hidden');
  $('lobby-wait').textContent = '';
  $('lobby-setup').classList.add('hidden');
}

function statusDot(connected) {
  return el('span', `status-dot ${connected ? 'online' : 'offline'}`);
}

function avatarEl(p, seat) {
  const avatar = el('span', 'om-avatar', p.isBot ? '🤖' : initialOf(p.name));
  avatar.style.setProperty('--seat-color', seatColour(seat).fill);
  if (!p.isBot) avatar.append(statusDot(p.connected));
  return avatar;
}

const initialOf = (name) => ([...String(name || '?').trim()][0] || '?').toUpperCase();

function renderLobby() {
  const { players, you } = view;
  const max = view.maxPlayers;
  const min = view.minPlayers;
  $('lobby-code').textContent = view.roomCode;
  const list = $('lobby-players');
  list.replaceChildren();
  players.forEach((p, seat) => {
    const item = el('div', 'player-item om-player');
    item.style.setProperty('--seat-color', seatColour(seat).fill);
    const identity = el('div', 'lobby-identity');
    identity.append(el('span', 'lobby-player-name', p.name));
    if (p.id === you.id) identity.append(el('span', 'om-you', 'you'));
    const meta = el('div', 'lobby-meta');
    meta.append(el('span', 'om-colour-label', seatColour(seat).name));
    if (p.isHost) meta.append(el('span', 'om-host', '👑 Host'));
    if (p.isBot) meta.append(el('span', 'om-bot', '🤖 bot'));
    if (p.isGroupMember === false) meta.append(el('span', 'not-ranked-badge', '⚠️ not in group'));
    if (!p.connected) meta.append(el('span', 'om-offline', 'offline'));
    const action = el('div', 'lobby-action');
    item.append(avatarEl(p, seat), identity, meta, action);
    if (!lobbySeen.has(p.id)) { lobbySeen.add(p.id); item.classList.add('om-enter'); }
    if (you.isHost && p.id !== you.id) {
      const kick = el('button', 'kick-btn', '✕');
      kick.type = 'button';
      kick.setAttribute('aria-label', `Remove ${p.name}`);
      kick.onclick = () => send({ type: 'kick', playerId: p.id });
      action.append(kick);
    }
    list.append(item);
  });
  for (let i = players.length; i < max; i++) {
    const open = el('div', 'player-item om-empty');
    open.append(el('span', 'om-avatar om-avatar-empty', '+'), el('span', null, i < min ? 'Waiting for an opponent' : 'Open seat'));
    list.append(open);
  }

  const n = players.length;
  const setup = $('lobby-setup');
  setup.classList.toggle('hidden', n < min);
  if (n >= min) {
    const parts = [
      el('div', 'om-setup-mode', '🔴 2 players · first to connect five in a row'),
      el('div', 'om-setup-note', 'Black opens · colours alternate each rematch'),
    ];
    if (view.groupName) parts.push(el('div', 'om-setup-group', `💬 ${view.groupName}`));
    setup.replaceChildren(...parts);
  }

  const seated = you.seat >= 0;
  $('btn-start').classList.toggle('hidden', !you.isHost);
  $('btn-start').disabled = n < min;
  const hasBot = players.some((p) => p.isBot);
  const addBot = $('btn-add-bot');
  addBot.classList.toggle('hidden', !(you.isHost && seated && n < max && !hasBot));
  const takeSeat = $('btn-take-seat');
  if (!seated && !FunAuth.token()) {
    $('lobby-wait').textContent = 'Sign in with Telegram on the Omok home screen to take a seat — you can watch until then.';
    takeSeat.classList.add('hidden');
    return;
  }
  $('btn-start').textContent = `🔴 Start Game (${n} players)`;
  const wait = $('lobby-wait');
  if (!seated && joinBlocked === 'kicked') {
    wait.textContent = 'You were removed from this lobby.';
    takeSeat.classList.add('hidden');
  } else if (!seated && (joinBlocked === 'full' || hasSeenGame)) {
    wait.textContent = n >= max
      ? 'This room is full — take a seat when one opens.'
      : joinBlocked === 'full' ? 'A seat is open — take it to play.' : 'You were watching — take a seat to play.';
    takeSeat.classList.remove('hidden');
    takeSeat.disabled = n >= max;
  } else {
    takeSeat.classList.add('hidden');
    wait.textContent = !seated
      ? (n >= max ? 'This room is full.' : 'Joining…')
      : you.isHost
        ? (n < min ? (hasBot ? 'Ready — start when you are.' : 'Share the code — or add a bot to play solo.') : 'Ready — start when you are.')
        : 'Waiting for the host to start...';
  }
}

// ---------- Game rendering ----------
const playerNameOf = (seat) => view.players[seat]?.name ?? `Player ${seat + 1}`;
const who = (seat) => (seat === view.you.seat ? 'You' : playerNameOf(seat));

function renderGame() {
  const g = view.game;
  const myTurn = view.you.seat >= 0 && g.currentSeat === view.you.seat && !isOver(g) && !openingActive();
  $('om-game').classList.toggle('my-turn', myTurn);
  $('btn-resign').classList.toggle('hidden', view.you.seat < 0 || isOver(g));
  $('om-round').textContent = `Round ${view.gameNo} · ${view.players.some(p => p.isBot) ? 'Practice · unrated' : 'Rated match'} · ${g.moveCount} stones`;
  renderPlayers(g);
  renderDrops(g, myTurn);
  renderCells(g);
  renderTurn(g, myTurn);
  renderCaption(g);
  renderLog(g);
}

function renderPlayers(g) {
  const box = $('om-players');
  box.replaceChildren();
  for (let seat = 0; seat < 2; seat++) {
    const p = view.players[seat];
    const active = !openingActive() && !isOver(g) && g.currentSeat === seat;
    const plate = el('div', `om-plate${active ? ' active' : ''}${g.winner === seat ? ' winner' : ''}${p?.connected === false ? ' offline' : ''}`);
    plate.dataset.seat = String(seat);
    plate.style.setProperty('--seat-color', seatColour(seat).fill);
    const info = el('div', 'om-plate-info');
    info.append(el('span', 'om-plate-name', p?.isBot ? `🤖 ${p.name}` : (p?.name ?? `Player ${seat + 1}`)));
    info.append(el('span', 'om-plate-sub', seatColour(seat).name));
    plate.append(el('span', `om-disc-dot ${stoneClass(seat)}`), info);
    if (openingActive()) {
      const tag = el('span', 'om-plate-tag om-opening-tag', '…');
      tag.setAttribute('aria-hidden', 'true');
      plate.append(tag);
    }
    if (active && !isOver(g)) plate.append(el('span', 'om-plate-tag', 'to play'));
    if (g.winner === seat) plate.append(el('span', 'om-plate-tag', '🏆'));
    box.append(plate);
  }
  paintOpeningReveal();
}

// Keep the grid DOM stable so focus survives presence and move broadcasts.
function renderDrops() {
  const button = $('btn-place');
  button.disabled = !selectedMove || !canPlace();
  button.textContent = movePending ? 'Placing…' : selectedMove
    ? `Place ${seatColour(view.you.seat).name.toLowerCase()} at ${coordinate(selectedMove.row, selectedMove.col)}`
    : view.you.seat < 0 ? 'Watching game' : isOver(view.game) ? 'Round finished' : canPlace() ? 'Select an intersection' : 'Waiting for your turn';
  $('btn-clear').disabled = !selectedMove || movePending;
  $('om-selection').textContent = selectedMove ? `${coordinate(selectedMove.row, selectedMove.col)} selected. Place your stone or choose another point.`
    : view.you.seat < 0 ? 'You’re watching. The whole board is public.' : 'Tap a point to preview. Place your stone when ready.';
}
function selectMove(row, col) {
  if (!canPlace()) return;
  if (view.game.board[row][col]) { toast('That intersection is occupied'); return; }
  cursor = { row, col };
  selectedMove = { row, col };
  renderCells(view.game);
  renderDrops();
}
function focusPoint(row, col) {
  cursor = { row: Math.max(0, Math.min(14, row)), col: Math.max(0, Math.min(14, col)) };
  for (const button of $('om-cells').querySelectorAll('button')) button.tabIndex = -1;
  const button = $('om-cells').querySelector(`[data-row="${cursor.row}"][data-col="${cursor.col}"]`);
  button.tabIndex = 0;
  button.focus({ preventScroll: true });
  if ($('om-viewport').classList.contains('zoomed')) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function renderCells(g) {
  const box = $('om-cells');
  if (!box.children.length) {
    for (let row = 0; row < ROWS; row++) {
      const line = el('div', 'om-board-row');
      line.setAttribute('role', 'row');
      for (let col = 0; col < COLS; col++) {
        const cell = el('button', 'om-cell');
        cell.type = 'button'; cell.dataset.row = row; cell.dataset.col = col;
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-rowindex', row + 1); cell.setAttribute('aria-colindex', col + 1);
        cell.append(el('span', 'om-stone'));
        cell.addEventListener('click', () => selectMove(row, col));
        cell.addEventListener('focus', () => { cursor = { row, col }; });
        cell.addEventListener('keydown', event => {
          const delta = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[event.key];
          if (delta) { event.preventDefault(); focusPoint(row + delta[0], col + delta[1]); }
          if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault(); focusPoint(event.ctrlKey ? (event.key === 'Home' ? 0 : 14) : row, event.key === 'Home' ? 0 : 14);
          }
        });
        line.append(cell);
      }
      box.append(line);
    }
  }
  const newMove = g.lastMove && g.moveCount > renderedMoveCount ? g.lastMove : null;
  for (const cell of box.querySelectorAll('button')) {
    const row = +cell.dataset.row, col = +cell.dataset.col, stone = g.board[row][col];
    const last = g.lastMove?.row === row && g.lastMove?.col === col;
    const selected = selectedMove?.row === row && selectedMove?.col === col;
    const win = g.winningLine?.some(([r,c]) => r === row && c === col);
    const name = stone ? `${stone === 1 ? 'Black' : 'White'} stone` : 'empty';
    cell.className = `om-cell${stone ? stone === 1 ? ' black' : ' white' : ''}${last ? ' last' : ''}${win ? ' win' : ''}${selected ? ` selected preview-${view.game.yourStone === 1 ? 'black' : 'white'}` : ''}${newMove?.row === row && newMove?.col === col ? ' pop' : ''}`;
    cell.tabIndex = cursor.row === row && cursor.col === col ? 0 : -1;
    cell.setAttribute('aria-label', `${coordinate(row,col)}: ${name}${last ? ', last move' : ''}${win ? ', winning line' : ''}`);
    cell.setAttribute('aria-selected', String(!!selected));
    cell.setAttribute('aria-disabled', String(!canPlace() || !!stone));
    cell.firstChild.textContent = last ? '•' : '';
    if ([3,7,11].includes(row) && [3,7,11].includes(col)) cell.classList.add('star');
  }
  renderedMoveCount = g.moveCount;
}

function renderTurn(g, myTurn) {
  const t = $('om-turn');
  if (openingActive()) {
    t.classList.remove('mine', 'pop');
    const message = openingSettled()
      ? (g.currentSeat === view.you.seat ? 'You go first!' : `${playerNameOf(g.currentSeat)} goes first`)
      : 'Who goes first?';
    if (t.textContent !== message) t.textContent = message;
    return;
  }
  t.classList.toggle('mine', myTurn);
  if (t.dataset.turn !== `${view.gameNo}:${g.currentSeat}:${g.phase}`) {
    t.dataset.turn = `${view.gameNo}:${g.currentSeat}:${g.phase}`;
    t.classList.remove('pop');
    void t.offsetWidth;
    t.classList.add('pop');
  }
  if (isOver(g)) {
    if (g.isDraw) t.textContent = '🤝 Draw';
    else if (g.winner === view.you.seat) t.textContent = '🏆 You win!';
    else t.textContent = `${playerNameOf(g.winner)} wins`;
  } else if (view.you.seat < 0) t.textContent = `Watching — ${playerNameOf(g.currentSeat)} to play`;
  else if (myTurn) t.textContent = 'Your turn — place a stone';
  else t.textContent = `Waiting for ${playerNameOf(g.currentSeat)}…`;
}

function renderCaption(g) {
  const cap = $('om-caption');
  if (openingActive()) {
    const message = openingSettled() ? 'Round starts shortly…' : 'Watch the border land on the starting player.';
    if (cap.textContent !== message) cap.textContent = message;
    return;
  }
  if (isOver(g)) {
    cap.textContent = g.isDraw ? 'The board is full.' : g.endReason === 'resign' ? `${playerNameOf(1 - g.winner)} resigned.` : `${playerNameOf(g.winner)} connected five.`;
    return;
  }
  const disc = seatColour(g.currentSeat).name;
  cap.textContent = view.you.seat < 0 ? `${playerNameOf(g.currentSeat)} (${disc}) to play` : `${who(g.currentSeat)} (${disc}) to play`;
}

function describe(entry) {
  switch (entry.t) {
    case 'place': return `${who(entry.seat)} · ${coordinate(entry.row, entry.col)}`;
    case 'resign': return `${who(entry.seat)} resigned`;
    case 'win': return `${who(entry.seat)} connected five`;
    case 'draw': return 'Draw — the board is full';
    default: return '';
  }
}

function renderLog(g) {
  const list = $('log');
  list.replaceChildren(...[...g.log].reverse().map((e) => el('li', `log-${e.t}`, describe(e))).filter((li) => li.textContent));
}

// ---------- Game over ----------
function showModal(id) {
  const m = $(id);
  if (!m.classList.contains('hidden')) return;
  modalStack.push({ modal: m, returnFocus: document.activeElement });
  m.classList.remove('hidden');
  syncModalIsolation();
  document.body.classList.add('modal-open');
  focusModal(m);
}

function hideModal(id) {
  const m = $(id);
  if (m.classList.contains('hidden')) return;
  const index = modalStack.findIndex((entry) => entry.modal === m);
  const [entry] = index < 0 ? [] : modalStack.splice(index, 1);
  m.classList.add('hidden');
  syncModalIsolation();
  const active = modalStack.at(-1)?.modal;
  if (active) {
    if (active.contains(entry?.returnFocus)) entry.returnFocus.focus({ preventScroll: true });
    else focusModal(active);
  } else {
    document.body.classList.remove('modal-open');
    const target = entry?.returnFocus;
    if (target?.isConnected && target.matches('button, a[href], input, select, textarea, [tabindex]') &&
        !target.disabled && target.getClientRects().length) target.focus({ preventScroll: true });
    else for (const id of ['btn-results', 'btn-start', 'btn-take-seat', 'btn-rules-lobby', 'btn-rules-home']) {
      const fallback = $(id);
      if (fallback.getClientRects().length && !fallback.disabled) { fallback.focus({ preventScroll: true }); break; }
    }
  }
}

function modalFocusables(modal) {
  return [...modal.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
    .filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
}

function focusModal(modal) {
  modal.tabIndex = -1;
  (modalFocusables(modal)[0] ?? modal).focus({ preventScroll: true });
}

function syncModalIsolation() {
  const active = modalStack.at(-1)?.modal;
  for (const node of document.body.children) node.inert = !!active && node !== active;
  modalStack.forEach(({ modal }, index) => { modal.style.zIndex = String(1200 + index); });
}

document.addEventListener('focusin', (event) => {
  const modal = modalStack.at(-1)?.modal;
  if (modal && !modal.contains(event.target)) focusModal(modal);
});

document.addEventListener('keydown', (event) => {
  const modal = modalStack.at(-1)?.modal;
  if (!modal || event.key !== 'Tab') return;
  const nodes = modalFocusables(modal);
  const first = nodes[0], last = nodes.at(-1);
  if (!nodes.length || (event.shiftKey && document.activeElement === first) ||
      (!event.shiftKey && document.activeElement === last) || !nodes.includes(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last ?? modal : first ?? modal).focus();
  }
});

function syncOverModal() {
  const g = view?.game;
  if (g && isOver(g) && !overDismissed) showOverModal(g);
  else hideModal('modal-over');
}

function showOverModal(g) {
  $('btn-again').classList.toggle('hidden', view.you.seat < 0);
  const youWon = g.winner === view.you.seat;
  const draw = g.isDraw;
  $('over-title').textContent = draw ? '🤝 Draw' : youWon ? '🏆 You win!' : `${playerNameOf(g.winner)} wins`;
  $('over-sub').textContent = g.endReason === 'resign' ? `${playerNameOf(1 - g.winner)} resigned` : view.you.seat >= 0 && !youWon && !draw ? 'Better luck next time' : draw ? 'Nobody connected five' : 'Five in a row';
  const rows = [0, 1].map((seat) => {
    const row = el('div', `om-result${seat === view.you.seat ? ' me' : ''}`);
    const disc = el('span', `om-result-disc ${stoneClass(seat)}`);
    disc.setAttribute('aria-label', `${seatColour(seat).name} stones`);
    row.append(disc);
    row.append(el('span', 'om-result-name', who(seat)));
    row.append(el('span', 'om-result-outcome', draw ? 'Draw' : g.winner === seat ? 'Winner' : ''));
    return row;
  });
  const opening = $('modal-over').classList.contains('hidden');
  rows.forEach((r, i) => r.style.setProperty('--i', String(i)));
  $('over-results').replaceChildren(...rows);
  for (const id of ['over-results', 'over-title', 'over-rating']) $(id).classList.toggle('fresh', opening);
  renderRatingResult(opening);
  showModal('modal-over');
}

function renderRatingResult(opening = false) {
  const box = $('over-rating');
  const result = view?.lastRating;
  if (!result || result.gameId !== view.gameId || !result.changes.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (opening) box.classList.add('fresh');
  box.replaceChildren(el('div', 'om-rating-head', 'Rating'), ...result.changes.map((c, i) => {
    const row = el('div', `om-rating-row${c.seat === view.you.seat ? ' me' : ''}`);
    row.style.setProperty('--i', String(i));
    row.append(el('span', null, c.name || 'Player'), el('b', c.delta >= 0 ? 'up' : 'down', `${c.delta >= 0 ? '+' : ''}${c.delta}`), el('span', 'om-rating-after', String(c.after)));
    return row;
  }));
}

let confirmDone = null;
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

// ---------- Stats ----------
let statsRows = [];
let statsMinGames = 3;
let statsSort = { col: 'elo', dir: 'desc' };

async function showStats() {
  showScreen('screen-stats');
  history.replaceState(null, '', `${location.pathname}?view=stats`);
  $('stats-content').innerHTML = '<p class="stats-empty">Loading…</p>';
  try {
    const res = await fetch('/api/omok/stats');
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
  const focusedSort = content.contains(document.activeElement) ? document.activeElement.dataset.sort : null;
  for (const b of document.querySelectorAll('#om-min-games .min-games-btn')) b.classList.toggle('active', Number(b.dataset.value) === statsMinGames);
  const sortFns = {
    elo: (r) => r.elo, games: (r) => r.games, wins: (r) => r.wins, draws: (r) => r.draws, winPct: (r) => r.winPct, name: (r) => r.displayName.toLowerCase(),
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
  const th = (col, text, left = false) => `<th class="${left ? 'stats-th-left' : ''}${statsSort.col === col ? ' sorted' : ''}" aria-sort="${statsSort.col === col ? statsSort.dir === 'asc' ? 'ascending' : 'descending' : 'none'}"><button type="button" class="om-sort" data-sort="${col}" aria-label="Sort by ${text}">${text} ${arrow(col)}</button></th>`;
  const body = sorted.map((r, i) => `<tr>
      <td class="stats-td-name">${i < 3 ? medals[i] : `${i + 1}.`} ${esc(r.displayName)}</td>
      <td class="stats-td-num stats-elo">${r.elo}</td>
      <td class="stats-td-num">${r.games}</td>
      <td class="stats-td-num">${r.wins}</td>
      <td class="stats-td-num">${r.draws}</td>
      <td class="stats-td-num">${r.winPct}%</td>
    </tr>`).join('');
  content.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr>${th('name', 'Player', true)}${th('elo', 'Rating')}${th('games', 'G')}${th('wins', 'W')}${th('draws', 'D')}${th('winPct', 'Win%')}</tr></thead>
    <tbody>${body}</tbody></table></div>`;
  for (const cell of content.querySelectorAll('button[data-sort]')) cell.addEventListener('click', () => sortStats(cell.dataset.sort));
  if (focusedSort) content.querySelector(`[data-sort="${focusedSort}"]`)?.focus();
}

// ---------- Room lifecycle ----------
function enterRoom(code) {
  roomCode = code;
  view = null;
  lastGameNo = -1;
  joinSent = false;
  joinBlocked = null;
  renderedMoveCount = 0;
  hasSeenGame = store.get(`omokWatched:${code}`) === '1';
  lobbySeen.clear();
  history.replaceState(null, '', `#${code}${hashInfo.pid ? `:${hashInfo.pid}` : ''}`);
  render();
  connect(code);
}

function leaveRoom(notify = true) {
  resetOpeningReveal();
  clearMove();
  replaced = false;
  if (notify) send({ type: 'leave' });
  const socket = ws;
  ws = null;
  roomCode = null;
  view = null;
  if (socket) socket.onmessage = null;
  clearTimeout(reconnectTimer);
  if (socket) { socket.onclose = null; setTimeout(() => socket.close(), 50); }
  history.replaceState(null, '', location.pathname);
  $('overlay-reconnect').classList.add('hidden');
  for (const m of document.querySelectorAll('.om-modal')) hideModal(m.id);
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
    out.onclick = (e) => { e.preventDefault(); FunAuth.logout(); profile = null; showSignedOut(); FunLeaderboard.mount($('leaderboard-section'), { game: 'omok' }); };
    status.append(out);
  }
}

function showSignedOut() {
  $('game-section').classList.add('hidden');
  $('login-section').classList.remove('hidden');
  FunAuth.mountLogin($('login-section'), (p) => {
    showSignedIn(p);
    FunLeaderboard.mount($('leaderboard-section'), { game: 'omok' });
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
    const res = await fetch('/api/omok/create', { method: 'POST' });
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
    try { await navigator.share({ title: 'Omok on funCentral', text: `Join my Omok game — room ${roomCode}`, url }); return; } catch { /* cancelled */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied 📋');
  } catch {
    prompt('Copy this invite link:', url);
  }
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
$('btn-add-bot').addEventListener('click', () => send({ type: 'addBot' }));
$('btn-take-seat').addEventListener('click', () => {
  joinSent = true;
  send({ type: 'join', name: playerName });
});
$('btn-leave').addEventListener('click', async () => {
  const g = view?.game;
  const midGame = g && !isOver(g) && view.you.seat >= 0;
  if (midGame && !await askConfirm({ title: 'Leave this game?', body: 'The table waits for you — your seat is kept if you come back.', ok: 'Leave', danger: true })) return;
  leaveRoom(true);
});
$('btn-sound').addEventListener('click', () => { sfx.toggle(); renderTopBar(); });
$('btn-stats').addEventListener('click', showStats);
$('btn-stats-home').addEventListener('click', hideStats);
for (const b of document.querySelectorAll('#om-min-games .min-games-btn')) {
  b.addEventListener('click', () => { statsMinGames = Number(b.dataset.value); renderStats(); });
}
$('btn-results').addEventListener('click', () => { overDismissed = false; syncOverModal(); });
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
    const active = modalStack.at(-1)?.modal;
    if (active?.id === 'modal-confirm') confirmDone?.(false);
    else if (active?.id === 'modal-rules') hideModal('modal-rules');
    else if (active?.id === 'modal-over') { overDismissed = true; hideModal('modal-over'); }
    if (!active && selectedMove && view?.game) { clearMove(); renderGame(); }
    return;
  }

});


$('btn-place').addEventListener('click', () => {
  if (!selectedMove || !canPlace()) return;
  const move = selectedMove;
  movePending = true;
  renderGame();
  send({ type: 'place', ...move, gameId: view.gameId, moveNumber: view.game.moveCount });
});
$('btn-clear').addEventListener('click', () => { clearMove(); renderGame(); });
$('btn-zoom').addEventListener('click', () => {
  const zoomed = $('om-viewport').classList.toggle('zoomed');
  $('btn-zoom').setAttribute('aria-pressed', String(zoomed));
  $('btn-zoom').textContent = zoomed ? 'Fit board' : 'Enlarge board';
});
$('btn-reconnect').addEventListener('click', () => connect(roomCode));
$('btn-resign').addEventListener('click', async () => {
  const gameId = view.gameId;
  if (await askConfirm({ title: 'Resign this round?', body: 'Your opponent wins this round. You can play again from the results screen.', ok: 'Resign', danger: true })) {
    if (view?.gameId === gameId && view.game.phase === 'play') send({ type: 'resign', gameId });
  }
});

// Desktop: keep the log open by default.
if (matchMedia('(min-width: 980px)').matches) $('log-details').open = true;

// Reconnect promptly when a phone wakes the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !replaced && roomCode && ws?.readyState !== WebSocket.OPEN) connect(roomCode);
});
setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send('ping'); }, 25000);

function openFromHash(room) {
  $('input-code').value = room;
  enterRoom(room);
}

addEventListener('hashchange', () => {
  const { room } = parseHash();
  if (room && room !== roomCode) {
    if (roomCode) leaveRoom(true);
    openFromHash(room);
  }
});

FunLeaderboard.mount($('leaderboard-section'), { game: 'omok' });
initAuth().finally(() => {
  if (hashInfo.room) openFromHash(hashInfo.room);
  else if (new URLSearchParams(location.search).get('view') === 'stats') showStats();
  else render();
});
