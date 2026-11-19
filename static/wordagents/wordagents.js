'use strict';

// Word Agents client. The WordAgentsRoom Durable Object is authoritative: this file
// renders the projected view, sends intents and never infers hidden key colours.

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* blocked */ } },
};
const motionOK = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
const TEAMS = ['red', 'blue'];
const teamName = (team) => team === 'red' ? 'Red' : 'Blue';
const otherTeam = (team) => team === 'red' ? 'blue' : 'red';
const GLYPH = { red: '◆', blue: '●', neutral: '—', assassin: '✕' };
const ROLE = { spymaster: 'Spymaster', operative: 'Operative' };
const colorName = (color) => color === 'assassin' ? 'Assassin' : color === 'neutral' ? 'Civilian' : `${teamName(color)} agent`;
const coord = (index) => `${'ABCDE'[index % 5]}${Math.floor(index / 5) + 1}`;
const initials = (name) => {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [...parts[0]][0] + [...parts[1]][0] : [...(parts[0] || '?')].slice(0, 2).join('');
  return letters.toUpperCase();
};

// Optional reading breaks for the original deck. They add no characters and wrap only
// when a narrow card needs them; rules and accessible names keep the complete word.
const WORD_BREAKS = Object.fromEntries([
  'BAL|CONY', 'BOUL|DER', 'CHIM|NEY', 'COM|PASS', 'DIA|MOND',
  'EN|VE|LOPE', 'FOUN|TAIN', 'HAM|MER', 'HO|RI|ZON', 'LAN|TERN',
  'LIGHT|HOUSE', 'MEA|DOW', 'MOUN|TAIN', 'MUSH|ROOM', 'NOTE|BOOK',
  'PUMP|KIN', 'RAIN|BOW', 'SAT|EL|LITE', 'SHAD|OW', 'SPAR|ROW',
  'STRAW|BERRY', 'SUB|MARINE', 'THUN|DER', 'TRI|ANGLE', 'TRUM|PET',
  'UM|BRELLA', 'VOL|CANO', 'WATER|FALL', 'WIN|DOW',
].map((parts) => [parts.replaceAll('|', ''), parts.split('|')]));

function toast(message, kind = '') {
  const stack = $('toasts');
  const node = el('div', `wa-toast ${kind}`.trim(), message);
  stack.append(node);
  while (stack.children.length > 3) stack.firstChild.remove();
  setTimeout(() => node.remove(), kind === 'error' ? 4200 : 2800);
}

// ---------- Sound (synthesised, off by default) ----------
const sfx = (() => {
  let ctx = null;
  let on = store.get('wordagentsSound') === 'on';
  function audio() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function tone(freq, { at = 0, dur = 0.16, type = 'sine', gain = 0.07, slide = 0 } = {}) {
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
  const sounds = {
    clue: () => { tone(660, { dur: 0.12 }); tone(990, { at: 0.09, dur: 0.18 }); },
    good: () => { tone(523, { dur: 0.1, type: 'triangle' }); tone(784, { at: 0.08, dur: 0.18, type: 'triangle' }); },
    bad: () => tone(300, { dur: 0.28, type: 'triangle', slide: -90 }),
    assassin: () => { tone(220, { dur: 0.5, type: 'sawtooth', gain: 0.05, slide: -140 }); tone(110, { at: 0.12, dur: 0.6, gain: 0.06 }); },
    turn: () => { tone(880, { dur: 0.09 }); tone(880, { at: 0.14, dur: 0.12 }); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.11, dur: 0.24, type: 'triangle' })),
    lose: () => [392, 330, 262].forEach((f, i) => tone(f, { at: i * 0.14, dur: 0.26, type: 'triangle' })),
    select: () => tone(1200, { dur: 0.05, gain: 0.03 }),
  };
  return {
    get on() { return on; },
    toggle() { on = !on; store.set('wordagentsSound', on ? 'on' : 'off'); if (on) sounds.select(); },
    play(name) { if (on && document.visibilityState === 'visible') try { sounds[name]?.(); } catch { /* audio unavailable */ } },
  };
})();

function confetti(team) {
  if (!motionOK()) return;
  const fx = $('fx');
  const colors = team === 'red' ? ['#f06272', '#ffb3bc', '#f3c266', '#fff'] : ['#4fa6f2', '#a8d6ff', '#f3c266', '#fff'];
  for (let i = 0; i < 70; i++) {
    const piece = el('i', 'wa-confetti');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    fx.append(piece);
    const drift = (Math.random() - 0.5) * 240;
    piece.animate([
      { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${drift}px, ${innerHeight + 40}px) rotate(${Math.random() * 720}deg)`, opacity: 0.9 },
    ], { duration: 1800 + Math.random() * 1400, delay: Math.random() * 300, easing: 'cubic-bezier(.2,.6,.4,1)' })
      .finished.then(() => piece.remove(), () => piece.remove());
  }
}

// ---------- State ----------
let profile = null;
let socket = null;
let view = null;
let room = '';
let generation = 0;
let retryTimer = 0;
let retryDelay = 800;
let heartbeat = 0;
let lastMessage = 0;
let pendingTimer = 0;
let pending = false;
let ready = false;
let fatal = false;
let leaving = false;
let selection = null; // { index, gameId, revision }
let keyHidden = false;
let overDismissed = false;
let overTimer = 0;
let clueCount = 2;
const autoJoined = new Set();
const fresh = new Set();
const modalStack = [];

const connected = () => ready && socket?.readyState === WebSocket.OPEN;
const me = () => view?.players.find((p) => p.id === view.you?.id) || null;
const isHost = () => !!view && view.you?.id === view.hostId;
const readRoom = () => {
  const raw = location.hash.slice(1).split(':')[0];
  return /^[A-Za-z0-9]{4}$/.test(raw) ? raw.toUpperCase() : '';
};
function canGuess() {
  const g = view?.game;
  return connected() && !pending && g?.phase === 'guess' && view.you?.role === 'operative' && view.you.team === g.turn;
}
function clearPending() { pending = false; clearTimeout(pendingTimer); }

// ---------- Networking ----------
function send(type, data = {}) {
  if (!connected()) { toast('Reconnecting… try again in a moment', 'error'); return false; }
  if (pending) return false;
  pending = true;
  socket.send(JSON.stringify({ type, ...data, ...(view?.game ? { gameId: view.game.id, revision: view.revision } : {}) }));
  pendingTimer = setTimeout(() => {
    clearPending();
    toast('No response yet. Reconnecting to confirm the latest state…', 'error');
    socket?.close();
  }, 8000);
  render();
  return true;
}

function stop() {
  generation++;
  clearTimeout(retryTimer);
  clearInterval(heartbeat);
  clearPending();
  if (socket) { socket.onclose = null; socket.onmessage = null; try { socket.close(); } catch { /* closed */ } socket = null; }
  ready = false;
}

function setConn(online, label) {
  const dot = $('tb-conn');
  dot.classList.toggle('offline', !online);
  dot.title = label;
  dot.setAttribute('aria-label', label);
}

function connect() {
  stop();
  if (!room || fatal || window.FC_MOVED) return;
  const current = generation;
  setConn(false, 'Connecting…');
  const params = new URLSearchParams({ room });
  const token = FunAuth.token();
  if (token) params.set('token', token);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/wordagents/ws?${params}`);
  socket = ws;
  ws.onopen = () => {
    if (current !== generation) return;
    lastMessage = Date.now();
    heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMessage > 40000) { ws.close(); return; }
      ws.send('ping');
    }, 15000);
  };
  ws.onmessage = (event) => {
    if (current !== generation) return;
    lastMessage = Date.now();
    if (event.data === 'pong') return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'error') {
      clearPending();
      leaving = false;
      toast(message.message || 'That action could not be completed.', 'error');
      render();
      return;
    }
    if (message.type === 'state') onState(message);
  };
  ws.onclose = (event) => {
    if (current !== generation) return;
    ready = false;
    clearInterval(heartbeat);
    clearPending();
    if ([4401, 4403, 4404, 4409].includes(event.code)) {
      fatal = true;
      setConn(false, 'Disconnected');
      showFatal(event.code);
    } else {
      setConn(false, 'Connection interrupted · reconnecting…');
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 1.7, 8000);
    }
    render();
  };
  ws.onerror = () => { /* the close event drives retries */ };
}

function showFatal(code) {
  // The overlay must be reachable: close any dialog so nothing above it stays inert.
  confirmDone?.(false);
  for (const modal of document.querySelectorAll('.wa-modal:not(.hidden)')) hideModal(modal.id);
  const message = code === 4409 ? 'This room is open in another tab or device.'
    : code === 4404 ? 'This room no longer exists. Create a new room or check your invite.'
    : 'Your sign-in needs refreshing. Go back and sign in again.';
  $('reconnect-message').textContent = message;
  $('btn-reconnect').classList.toggle('hidden', code !== 4409);
  $('btn-reconnect-home').classList.remove('hidden');
  $('overlay-reconnect').querySelector('.spinner').classList.add('hidden');
  $('overlay-reconnect').classList.remove('hidden');
}
function hideFatal() {
  $('overlay-reconnect').classList.add('hidden');
  $('overlay-reconnect').querySelector('.spinner').classList.remove('hidden');
}

// ---------- Incoming state ----------
function onState(next) {
  if (view && next.revision < view.revision) return;
  const prev = view;
  const sameRound = !!next.game && prev?.game?.id === next.game.id;
  if (selection && (selection.revision !== next.revision || selection.gameId !== next.game?.id)) selection = null;
  view = next;
  ready = true;
  retryDelay = 800;
  clearPending();
  setConn(true, 'Live · room synced');

  const seated = view.players.some((p) => p.id === view.you?.id);
  if (leaving && !seated) { leaving = false; goHome(); return; }
  if (profile && !seated && !view.game && !view.you?.removed && !autoJoined.has(room)) {
    autoJoined.add(room);
    socket.send(JSON.stringify({ type: 'join' }));
  }
  if (prev && prev.players.some((p) => p.id === prev.you?.id) && !seated && view.you?.removed) {
    toast('The host removed you from this room. You can keep watching.', 'error');
  }

  if (prev?.game && prev.game.phase !== 'finished' && !next.game) toast('The host ended the round. Back in the lobby.');
  fresh.clear();
  const g = next.game;
  if (g && !sameRound) {
    overDismissed = false;
    clearTimeout(overTimer);
    overTimer = 0;
    hideModal('modal-over');
    keyHidden = false;
    clueCount = 2;
    if (prev && g.phase !== 'finished') {
      toast(`Mission started · ${teamName(g.turn)} team goes first`, g.turn);
      sfx.play(view.you?.team === g.turn ? 'turn' : 'clue');
    }
  }
  if (sameRound) announce(prev.game, g);
  render();
  fresh.clear();
  if (g?.phase === 'finished' && !overDismissed) {
    // Let the final reveal play; later broadcasts (presence, rejoins) must not cut it short.
    if (sameRound && prev.game.phase !== 'finished') {
      clearTimeout(overTimer);
      overTimer = setTimeout(() => { overTimer = 0; syncOverModal(); }, motionOK() ? 1100 : 200);
    } else if (!overTimer) syncOverModal();
  }
}

/** Toasts, sounds and reveal animations for events since the previous view of this round. */
function announce(before, after) {
  const added = (after.history || []).slice((before.history || []).length);
  const mine = view.you?.team;
  for (const event of added) {
    if (event.t === 'clue') {
      $('wa-clue').classList.remove('fresh');
      requestAnimationFrame(() => $('wa-clue').classList.add('fresh'));
      if (event.team === mine && view.you?.role === 'operative') sfx.play('clue');
    } else if (event.t === 'guess') {
      fresh.add(event.index);
      const verdict = event.color === 'assassin' ? 'the assassin!' : event.color === event.team ? `${colorName(event.color)} ✓` : colorName(event.color);
      toast(`${teamName(event.team)} revealed ${event.word} · ${verdict}`, event.team);
      sfx.play(event.color === 'assassin' ? 'assassin' : event.color === event.team ? 'good' : 'bad');
    } else if (event.t === 'pass') {
      toast(`${teamName(event.team)} team ended their turn`, event.team);
    }
  }
  for (const team of TEAMS) {
    if (after.remaining[team] < before.remaining[team]) {
      const score = $(`score-${team}`);
      score.classList.remove('bump');
      requestAnimationFrame(() => score.classList.add('bump'));
    }
  }
  if (after.phase === 'finished' && before.phase !== 'finished') {
    if (mine && after.winner === mine) { setTimeout(() => sfx.play('win'), 500); confetti(mine); }
    else if (mine) setTimeout(() => sfx.play('lose'), 500);
  } else if (after.turn !== before.turn && after.turn === mine) {
    setTimeout(() => sfx.play('turn'), 400);
  }
}

// ---------- Screens ----------
function showScreen(id) {
  for (const screen of document.querySelectorAll('.screen')) screen.classList.toggle('active', screen.id === id);
  document.body.dataset.screen = id;
}

function placeLogin() {
  // Signed-out visitors in a room can sign in from the lobby without losing the invite.
  const login = $('login-section');
  if (room && !profile) { if (login.parentElement.id !== 'lobby-login') $('lobby-login').append(login); }
  else if (login.parentElement.id === 'lobby-login') $('screen-home').querySelector('.wa-home-links').before(login);
}

function render() {
  placeLogin();
  $('top-bar').classList.toggle('hidden', !room);
  if (!room) { showScreen('screen-home'); return; }
  $('tb-room').textContent = room;
  renderTopBar();
  if (!view) { showScreen('screen-lobby'); renderLobbyLoading(); return; }
  if (!view.game) { showScreen('screen-lobby'); hideModal('modal-over'); renderLobby(); return; }
  showScreen('screen-game');
  renderGame();
}

function renderTopBar() {
  const p = me();
  $('tb-name').textContent = p ? `${p.name}${p.team ? ` · ${teamName(p.team)}${p.role ? ` ${ROLE[p.role]}` : ''}` : ''}` : profile ? 'Watching' : 'Watching as guest';
  const sound = $('btn-sound');
  sound.textContent = sfx.on ? '🔊' : '🔇';
  sound.setAttribute('aria-pressed', String(sfx.on));
  sound.title = sfx.on ? 'Sound effects on' : 'Sound effects off';
  const watchers = view?.watchers || 0;
  $('tb-watchers').classList.toggle('hidden', !watchers);
  $('tb-watchers').textContent = `👁 ${watchers}`;
  $('tb-watchers').title = `${watchers} watching`;
  $('btn-results').classList.toggle('hidden', view?.game?.phase !== 'finished');
}

// ---------- Lobby ----------
function renderLobbyLoading() {
  $('lobby-code').textContent = room;
  $('lobby-roster').replaceChildren(el('div', 'wa-open-slot', 'Connecting to the room…'));
  $('lobby-checklist').replaceChildren();
  $('lobby-wait').textContent = '';
  for (const id of ['btn-start', 'btn-take-seat']) $(id).classList.add('hidden');
}

function avatar(p, team) {
  const node = el('span', `wa-avatar${p.role === 'spymaster' ? ' spy' : ''}`, initials(p.name));
  if (team) node.style.setProperty('--team', `var(--wa-${team})`);
  const dot = el('span', `status-dot ${p.connected ? 'online' : 'offline'}`);
  dot.setAttribute('aria-hidden', 'true');
  node.append(dot);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function memberRow(p) {
  const row = el('div', 'wa-member');
  row.append(avatar(p));
  const name = el('div', 'wa-member-name', p.name);
  if (p.id === view.you?.id) name.append(el('span', 'wa-badge', 'you'));
  if (p.id === view.hostId) name.append(el('span', 'wa-badge host', '👑 host'));
  name.append(el('span', 'wa-member-meta', p.connected ? 'Online' : 'Offline'));
  row.append(name);
  if (isHost() && p.id !== view.you?.id) {
    const kick = el('button', 'kick-btn', '✕');
    kick.type = 'button';
    kick.title = `Remove ${p.name}`;
    kick.setAttribute('aria-label', `Remove ${p.name} from room`);
    kick.disabled = !connected() || pending;
    kick.onclick = async () => {
      if (await askConfirm({ title: `Remove ${p.name}?`, body: 'They can still watch with the invite, but cannot rejoin this room.', ok: 'Remove', danger: true })) send('kick', { playerId: p.id });
    };
    row.append(kick);
  } else row.append(el('span'));
  return row;
}

function lobbyReadiness() {
  const players = view.players;
  const enough = players.length >= 4;
  const allOnline = players.length > 0 && players.every((p) => p.connected);
  const items = [
    { ok: enough, text: `${players.length}/4+ players` },
    { ok: allOnline, text: 'All players online' },
  ];
  return { items, valid: enough && allOnline, enough };
}

function renderLobby() {
  const you = view.you || {};
  const seated = !!me();
  $('lobby-code').textContent = view.roomCode;
  const list = el('div', 'wa-roster-list');
  list.append(...view.players.map(memberRow));
  $('lobby-roster').replaceChildren(
    el('h3', 'wa-slot-label', `Players · ${view.players.length}/${view.maxPlayers || 12}`),
    view.players.length ? list : el('div', 'wa-open-slot', 'No players have joined yet'),
  );

  const { items, valid, enough } = lobbyReadiness();
  $('lobby-checklist').replaceChildren(...items.map((item) => el('li', item.ok ? 'ok' : '', item.text)));
  const host = isHost();
  $('btn-start').classList.toggle('hidden', !host);
  $('btn-start').disabled = !valid || !connected() || pending;
  $('btn-take-seat').classList.toggle('hidden', !profile || seated || !!you.removed);
  $('btn-take-seat').disabled = !connected() || pending || view.players.length >= (view.maxPlayers || 12);
  const hostName = view.players.find((p) => p.id === view.hostId)?.name;
  $('lobby-wait').textContent = !connected() ? 'Reconnecting… actions pause until the room is synced.'
    : you.removed ? 'The host removed you from this room. You can keep watching.'
    : !profile ? 'You are watching. Sign in with Telegram below to play.'
    : !seated ? view.players.length >= (view.maxPlayers || 12) ? 'This room is full. You can watch.' : 'You are watching. Join this room to play.'
    : !enough ? 'Waiting for at least four players.'
    : !valid ? host ? 'Wait for offline players or remove them to start.' : 'Waiting for everyone to be online.'
    : host ? 'Everyone is ready. Start when you are.' : `Everyone is ready. Waiting for ${hostName || 'the host'} to start.`;
}

// ---------- Game ----------
function renderGame() {
  const g = view.game;
  const you = view.you || {};
  const finished = g.phase === 'finished';
  const myTurn = !!you.team && you.team === g.turn && !finished;

  for (const team of TEAMS) {
    $(`${team}-left`).textContent = g.remaining[team];
    const score = $(`score-${team}`);
    score.classList.toggle('active', !finished ? g.turn === team : g.winner === team);
    score.classList.toggle('idle', !finished ? g.turn !== team : g.winner !== team);
    score.setAttribute('aria-label', `${teamName(team)}: ${g.remaining[team]} agents left to find`);
  }
  const turn = $('wa-turn');
  turn.className = `wa-turn ${finished ? g.winner : g.turn}`;
  turn.textContent = finished ? `${teamName(g.winner)} team wins!`
    : `${myTurn ? 'Your team' : `${teamName(g.turn)} team`} · ${g.phase === 'clue' ? 'giving a clue' : 'guessing'}`;
  $('wa-you').textContent = you.role ? `You · ${teamName(you.team)} ${ROLE[you.role].toLowerCase()}` : 'You are watching';

  // Clue bar
  const word = $('clue-word');
  const showClue = g.clue && g.phase === 'guess';
  word.classList.toggle('waiting', !showClue);
  word.textContent = showClue ? g.clue.word
    : finished ? (g.endReason === 'assassin' ? 'The assassin was found' : 'Every agent was found')
    : myTurn && you.role === 'spymaster' ? 'Your clue goes here' : `Waiting for the ${teamName(g.turn).toLowerCase()} spymaster…`;
  $('clue-count').textContent = showClue ? String(g.clue.count) : '';
  const pips = $('clue-pips');
  pips.replaceChildren();
  if (showClue) {
    const total = g.clue.count + 1;
    for (let i = 0; i < total; i++) pips.append(el('i', i < g.guessesMade ? 'used' : i === total - 1 ? 'bonus' : ''));
    pips.title = `${g.guessesLeft} guesses left`;
  }

  const spy = you.role === 'spymaster' && !finished;
  $('secret-bar').classList.toggle('hidden', !spy);
  $('btn-hide-key').textContent = keyHidden ? 'Show key' : 'Hide key';
  $('btn-hide-key').setAttribute('aria-pressed', String(keyHidden));

  renderBoard(g);
  renderDock(g, myTurn);
  renderRoster(g);
  renderLog(g);
}

function renderBoard(g) {
  const board = $('board');
  const focused = document.activeElement?.closest?.('.wa-card')?.dataset.index;
  const finished = g.phase === 'finished';
  const pick = canGuess();
  const myId = view.you?.id;
  const marks = new Map();
  for (const mark of g.marks || []) {
    if (!marks.has(mark.index)) marks.set(mark.index, []);
    marks.get(mark.index).push(mark.playerId);
  }
  const cards = g.cards.map((card, index) => {
    const showKey = card.color && !card.revealed && !(keyHidden && !finished);
    const classes = ['wa-card'];
    if (card.revealed) classes.push('revealed', `c-${card.color}`);
    else if (showKey) classes.push(`key-${card.color}`);
    if (finished && !card.revealed) classes.push('missed');
    if (fresh.has(index)) classes.push('fresh');
    if (selection?.index === index) classes.push('selected');
    if (marks.has(index)) classes.push('marked');
    const actionable = pick && !card.revealed;
    if (actionable) classes.push('can-pick');
    // Reuse the card element: replacing it mid-tap (a mark or presence broadcast) would swallow the click.
    let button = board.children[index];
    if (!button || button.dataset.word !== card.word) {
      button = el('button');
      button.type = 'button';
      button.dataset.index = String(index);
      button.dataset.word = card.word;
    }
    button.className = classes.join(' ');
    button.setAttribute('aria-disabled', String(!actionable));
    button.setAttribute('aria-pressed', String(selection?.index === index));
    button.replaceChildren(el('span', 'wa-coord', coord(index)));
    const label = el('span', 'wa-word');
    (WORD_BREAKS[card.word] || [card.word]).forEach((part, i) => {
      if (i) label.append(document.createElement('wbr'));
      label.append(document.createTextNode(part));
    });
    button.append(label);
    const known = card.revealed || showKey;
    if (known) {
      const glyph = el('span', 'wa-glyph', GLYPH[card.color]);
      glyph.setAttribute('aria-hidden', 'true');
      button.append(glyph, el('span', 'wa-tag', colorName(card.color)));
    }
    const who = marks.get(index) || [];
    if (who.length) {
      const chips = el('span', 'wa-marks');
      chips.setAttribute('aria-hidden', 'true');
      for (const id of who.slice(0, 3)) chips.append(el('i', id === myId ? 'me' : '', initials(view.players.find((p) => p.id === id)?.name)));
      if (who.length > 3) chips.append(el('i', '', `+${who.length - 3}`));
      button.append(chips);
    }
    const status = known ? colorName(card.color) : 'Unrevealed';
    const markText = who.length ? `, marked by ${who.map((id) => (id === myId ? 'you' : view.players.find((p) => p.id === id)?.name || 'a teammate')).join(', ')}` : '';
    button.setAttribute('aria-label', `${card.word}, ${coord(index)}, ${status}${card.revealed ? ', revealed' : ''}${markText}`);
    return button;
  });
  if (cards.length !== board.children.length || cards.some((card, i) => board.children[i] !== card)) {
    board.replaceChildren(...cards);
    if (focused != null) board.querySelector(`[data-index="${focused}"]`)?.focus({ preventScroll: true });
  }
}

function renderDock(g, myTurn) {
  const you = view.you || {};
  const hint = $('dock-hint');
  const clueForm = $('clue-form');
  const guessActions = $('guess-actions');
  const finished = g.phase === 'finished';
  const giving = !finished && g.phase === 'clue' && myTurn && you.role === 'spymaster';
  const guessing = !finished && g.phase === 'guess' && myTurn && you.role === 'operative';
  clueForm.classList.toggle('hidden', !giving);
  guessActions.classList.toggle('hidden', !guessing);
  $('btn-dock-results').classList.toggle('hidden', !finished);

  const team = teamName(g.turn);
  const html = (parts) => { hint.replaceChildren(...parts.map((p) => typeof p === 'string' ? document.createTextNode(p) : p)); };
  if (!connected()) html(['Reconnecting… actions pause until the room is synced.']);
  else if (finished) html(['Round over. The full key is revealed: compare notes, then play again.']);
  else if (!you.role) html([`You are watching. ${team} team is ${g.phase === 'clue' ? 'waiting for a clue' : 'guessing'}.${profile ? '' : ' Sign in from the lobby between rounds to play.'}`]);
  else if (giving) html(['Link your team’s agents with ', el('b', '', 'one word'), ' and a number.']);
  else if (guessing) {
    if (selection) html(['Reveal ', el('b', '', g.cards[selection.index].word), ` (${coord(selection.index)})? Or mark it to discuss with your team.`]);
    else html([`Tap a card to select it · ${g.guessesLeft} ${g.guessesLeft === 1 ? 'guess' : 'guesses'} left.`]);
  } else if (myTurn && you.role === 'operative') html(['Waiting for your spymaster’s clue…']);
  else if (myTurn) html([`Your operatives are guessing · ${g.guessesLeft} left. No hints!`]);
  else html([`${team} team is ${g.phase === 'clue' ? 'thinking of a clue' : 'guessing'}…`]);

  if (giving) {
    const busy = !connected() || pending;
    $('clue-input').disabled = busy;
    $('count-value').textContent = String(clueCount);
    $('count-down').disabled = busy || clueCount <= 1;
    $('count-up').disabled = busy || clueCount >= 9;
    validateClueInput();
  }
  if (guessing) {
    const reveal = $('btn-reveal');
    const busy = !connected() || pending;
    reveal.disabled = busy || !selection;
    reveal.textContent = selection ? `Reveal ${g.cards[selection.index].word}` : 'Select a card';
    const markedByMe = !!selection && (g.marks || []).some((m) => m.index === selection.index && m.playerId === you.id);
    $('btn-mark').disabled = busy || !selection;
    $('btn-mark').setAttribute('aria-pressed', String(markedByMe));
    $('btn-mark').textContent = markedByMe ? 'Unmark' : 'Mark';
    $('btn-end').disabled = busy || g.guessesMade < 1;
    $('btn-end').title = g.guessesMade < 1 ? 'Make at least one guess first' : 'End your team’s turn';
  }
}

/** Mirrors the server's clue check for inline feedback; the room still validates. */
function clueProblem(raw) {
  const value = raw.trim().toUpperCase();
  if (!value) return { value, problem: '' };
  if (!/^[A-Z]{1,30}$/.test(value)) return { value, problem: 'One word, letters only.' };
  const clash = view?.game?.cards.find((c) => !c.revealed && (c.word.includes(value) || value.includes(c.word)));
  if (clash) return { value, problem: `Too close to ${clash.word}, which is still on the board.` };
  return { value, problem: '' };
}
function validateClueInput() {
  const { value, problem } = clueProblem($('clue-input').value);
  $('clue-error').textContent = problem;
  $('clue-input').setAttribute('aria-invalid', String(!!problem));
  $('btn-clue').disabled = !value || !!problem || !connected() || pending;
  $('btn-clue').textContent = value && !problem ? `Send ${value} · ${clueCount}` : 'Send clue';
}

function renderRoster(g) {
  $('btn-abandon').classList.toggle('hidden', !isHost() || g.phase === 'finished');
  $('btn-abandon').disabled = !connected() || pending;
  const nodes = TEAMS.map((team) => {
    const players = view.players.filter((p) => p.team === team).sort((a, b) => (a.role === 'spymaster' ? -1 : 0) - (b.role === 'spymaster' ? -1 : 0));
    const box = el('div', `wa-roster-team ${team}`);
    const head = el('h4', '', `${GLYPH[team]} ${teamName(team)}`);
    head.append(el('small', '', `${g.remaining[team]} to find`));
    const list = el('ul');
    for (const p of players) {
      const item = el('li', p.connected ? '' : 'offline');
      item.append(avatar(p, team), el('span', '', `${p.name}${p.id === view.you?.id ? ' (you)' : ''}${p.role === 'spymaster' ? ' · spymaster' : ''}${p.connected ? '' : ' · offline'}`));
      list.append(item);
    }
    box.append(head, list);
    return box;
  });
  $('roster').replaceChildren(...nodes);
}

function turnsFrom(history) {
  const turns = [];
  let current = null;
  for (const event of history || []) {
    if (event.t === 'start') continue;
    if (event.t === 'clue' || !current || current.team !== event.team) {
      current = { team: event.team, clue: null, items: [] };
      turns.push(current);
    }
    if (event.t === 'clue') current.clue = event;
    else current.items.push(event);
  }
  return turns;
}

function renderLog(g) {
  const turns = turnsFrom(g.history).reverse();
  const list = $('log');
  if (!turns.length) { list.replaceChildren(el('li', 'wa-log-empty', `${teamName(g.turn)} team goes first.`)); return; }
  list.replaceChildren(...turns.map((turn) => {
    const item = el('li', `wa-turn-entry ${turn.team}`);
    const head = el('header');
    head.append(el('small', '', teamName(turn.team)));
    if (turn.clue) head.append(el('b', '', `${turn.clue.word} · ${turn.clue.count}`));
    item.append(head);
    const chips = el('div', 'wa-chips');
    for (const e of turn.items) {
      const chip = e.t === 'guess' ? el('span', `wa-chip c-${e.color}`, `${GLYPH[e.color]} ${e.word}`) : el('span', 'wa-chip pass', 'ended turn');
      if (e.t === 'guess') chip.title = colorName(e.color);
      chips.append(chip);
    }
    if (!turn.items.length) chips.append(el('span', 'wa-chip pass', 'guessing…'));
    item.append(chips);
    return item;
  }));
}

// ---------- Results ----------
function syncOverModal() {
  const g = view?.game;
  if (g?.phase === 'finished' && !overDismissed) showOverModal(g);
  else hideModal('modal-over');
}

function showOverModal(g) {
  const mine = view.you?.team;
  const loser = otherTeam(g.winner);
  const lastGuess = [...(g.history || [])].reverse().find((e) => e.t === 'guess');
  const box = $('modal-over').querySelector('.gameover-container');
  box.classList.remove('wa-over-red', 'wa-over-blue');
  box.classList.add(`wa-over-${g.winner}`);
  $('over-title').textContent = mine === g.winner ? '🏆 Your team wins!' : `${GLYPH[g.winner]} ${teamName(g.winner)} team wins`;
  $('over-sub').textContent = g.endReason === 'assassin' ? `${teamName(loser)} uncovered the assassin${lastGuess ? ` (${lastGuess.word})` : ''}.`
    : lastGuess && lastGuess.team !== g.winner ? `${teamName(loser)} revealed ${teamName(g.winner)}’s final agent.`
    : `${teamName(g.winner)} found every agent.`;
  const rows = TEAMS.map((team) => {
    const total = g.cards.filter((c) => c.color === team).length;
    const row = el('div', `wa-result ${team}${team === g.winner ? ' winner' : ''}${team === mine ? ' me' : ''}`);
    const glyph = el('span', 'wa-score-glyph', GLYPH[team]);
    glyph.setAttribute('aria-hidden', 'true');
    row.append(glyph, el('b', '', `${teamName(team)} team${team === g.winner ? ' · winner' : ''}`));
    row.append(el('span', 'wa-result-found', `${total - g.remaining[team]}/${total}`));
    row.append(el('small', '', view.players.filter((p) => p.team === team).map((p) => `${p.name}${p.role === 'spymaster' ? ' 🔑' : ''}`).join(', ') || '—'));
    return row;
  });
  $('over-results').replaceChildren(...rows);
  const host = isHost();
  $('btn-again').classList.toggle('hidden', !host);
  $('btn-to-lobby').classList.toggle('hidden', !host);
  $('over-wait').classList.toggle('hidden', host);
  const { valid, enough } = lobbyReadiness();
  $('btn-again').disabled = !valid || !connected() || pending;
  $('over-blocked').classList.toggle('hidden', !host || valid);
  $('over-blocked').textContent = enough
    ? 'Wait for offline players or go back to the lobby to remove them.'
    : 'Go back to the lobby to invite more players. Four are needed.';
  $('btn-to-lobby').disabled = !connected() || pending;
  showModal('modal-over');
}

// ---------- Modals ----------
function showModal(id) {
  const modal = $(id);
  if (!modal.classList.contains('hidden')) return;
  modalStack.push({ modal, returnFocus: document.activeElement });
  modal.classList.remove('hidden');
  syncModalIsolation();
  document.body.classList.add('modal-open');
  focusModal(modal);
}
function hideModal(id) {
  const modal = $(id);
  if (modal.classList.contains('hidden')) return;
  const index = modalStack.findIndex((entry) => entry.modal === modal);
  const [entry] = index < 0 ? [] : modalStack.splice(index, 1);
  modal.classList.add('hidden');
  syncModalIsolation();
  const active = modalStack.at(-1)?.modal;
  if (active) { focusModal(active); return; }
  document.body.classList.remove('modal-open');
  const target = entry?.returnFocus;
  if (target?.isConnected && !target.disabled && target.getClientRects().length) target.focus({ preventScroll: true });
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
  for (const node of document.body.children) {
    if (node.tagName === 'SCRIPT' || node.id === 'toasts') continue;
    node.inert = !!active && node !== active;
  }
  modalStack.forEach(({ modal }, index) => { modal.style.zIndex = String(1200 + index); });
}
document.addEventListener('keydown', (event) => {
  const modal = modalStack.at(-1)?.modal;
  if (!modal || event.key !== 'Tab') return;
  const nodes = modalFocusables(modal);
  const first = nodes[0], last = nodes.at(-1);
  if (!nodes.length || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last) || !nodes.includes(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last ?? modal : first ?? modal).focus();
  }
});

let confirmDone = null;
function askConfirm({ title, body, ok = 'OK', danger = false }) {
  confirmDone?.(false);
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = ok;
  $('confirm-ok').className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  showModal('modal-confirm');
  return new Promise((resolve) => {
    confirmDone = (answer) => { confirmDone = null; hideModal('modal-confirm'); resolve(answer); };
  });
}

// ---------- Actions ----------
function goHome() {
  stop();
  room = '';
  view = null;
  selection = null;
  fatal = false;
  leaving = false;
  hideFatal();
  for (const modal of document.querySelectorAll('.wa-modal')) hideModal(modal.id);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  render();
}

function navigate() {
  const next = readRoom();
  if (next === room && (socket || fatal)) return;
  stop();
  view = null;
  selection = null;
  fatal = false;
  leaving = false;
  hideFatal();
  room = next;
  if (room) $('input-code').value = room;
  render();
  if (room) connect();
}

function inviteUrl() { return `${location.origin}/wordagents/#${room}`; }
async function shareInvite() {
  const url = inviteUrl();
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'Word Agents on funCentral', text: `Join my Word Agents room ${room}`, url }); return; } catch { /* cancelled */ }
  }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied 📋'); }
  catch { prompt('Copy this invite link:', url); }
}

function selectCard(index) {
  const g = view?.game;
  if (!g || !canGuess() || g.cards[index]?.revealed) return;
  selection = selection?.index === index ? null : { index, gameId: g.id, revision: view.revision };
  if (selection) sfx.play('select');
  renderGame();
}

function revealSelection() {
  const chosen = selection;
  if (!chosen || !canGuess() || chosen.revision !== view.revision || chosen.gameId !== view.game.id) { selection = null; renderGame(); return; }
  selection = null;
  send('guess', { index: chosen.index });
}

async function createRoom() {
  if (!profile) { toast('Sign in with Telegram first', 'error'); return; }
  const button = $('btn-create');
  button.disabled = true;
  try {
    const response = await fetch('/api/wordagents/create', { method: 'POST', headers: { Authorization: `Bearer ${FunAuth.token()}` }, signal: AbortSignal.timeout(10000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !/^[A-Z0-9]{4}$/.test(data.roomCode || '')) throw new Error(data.error || 'Could not create a room. Please retry.');
    location.hash = data.roomCode;
  } catch (error) {
    toast(error.name === 'TimeoutError' ? 'Could not create a room — check your connection' : error.message, 'error');
  } finally { button.disabled = false; }
}

async function leave() {
  const g = view?.game;
  const seated = !!me();
  if (seated && g && g.phase !== 'finished') {
    if (await askConfirm({ title: 'Leave the mission?', body: 'Roles are locked until this round ends. Your seat is kept: open the invite again to rejoin.', ok: 'Leave', danger: true })) goHome();
    return;
  }
  if (seated && connected()) {
    leaving = true;
    if (!send('leave')) { leaving = false; goHome(); }
    return;
  }
  goHome();
}

// ---------- Wire up ----------
$('btn-create').addEventListener('click', createRoom);
$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = $('input-code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { $('input-code').focus(); toast('Room codes are 4 characters', 'error'); return; }
  location.hash = code;
});
$('input-code').addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('tb-room').addEventListener('click', shareInvite);
$('lobby-code-btn').addEventListener('click', shareInvite);
$('btn-share').addEventListener('click', shareInvite);
$('btn-leave').addEventListener('click', leave);
$('btn-sound').addEventListener('click', () => { sfx.toggle(); renderTopBar(); });
$('btn-take-seat').addEventListener('click', () => { if (connected()) send('join'); });
$('btn-start').addEventListener('click', () => send('start'));
$('btn-again').addEventListener('click', () => { if (send('start')) hideModal('modal-over'); });
$('btn-to-lobby').addEventListener('click', () => send('lobby'));
$('btn-abandon').addEventListener('click', async () => {
  const id = view?.game?.id;
  if (await askConfirm({ title: 'End this round for everyone?', body: 'Nobody wins. Everyone returns to the lobby, where you can invite players or remove players who left.', ok: 'End round', danger: true })) {
    if (view?.game?.id === id && view.game.phase !== 'finished') send('abandon');
  }
});
$('btn-over-close').addEventListener('click', () => { overDismissed = true; hideModal('modal-over'); });
$('btn-results').addEventListener('click', () => { overDismissed = false; syncOverModal(); });
$('btn-dock-results').addEventListener('click', () => { overDismissed = false; syncOverModal(); });
$('btn-hide-key').addEventListener('click', () => { keyHidden = !keyHidden; renderGame(); });
$('btn-reveal').addEventListener('click', revealSelection);
$('btn-mark').addEventListener('click', () => { if (selection && canGuess()) send('mark', { index: selection.index }); });
$('btn-end').addEventListener('click', async () => {
  const g = view?.game;
  if (!g || !canGuess()) return;
  const revision = view.revision, turn = g.turn;
  const left = g.guessesLeft;
  if (await askConfirm({ title: 'End your turn?', body: `Your team still has ${left} ${left === 1 ? 'guess' : 'guesses'}. The other team will get the next clue.`, ok: 'End turn' })) {
    if (view?.game?.id === g.id && view.revision === revision && view.game.turn === turn && canGuess()) { selection = null; send('endTurn'); }
  }
});
$('board').addEventListener('click', (event) => {
  const card = event.target.closest('.wa-card');
  if (card) selectCard(Number(card.dataset.index));
});
$('board').addEventListener('keydown', (event) => {
  const card = event.target.closest('.wa-card');
  if (!card) return;
  const index = Number(card.dataset.index);
  const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5 }[event.key];
  if (move == null) return;
  const target = index + move;
  if (target < 0 || target > 24 || (Math.abs(move) === 1 && Math.floor(target / 5) !== Math.floor(index / 5))) return;
  event.preventDefault();
  $('board').querySelector(`[data-index="${target}"]`)?.focus();
});
$('clue-input').addEventListener('input', validateClueInput);
$('count-down').addEventListener('click', () => { clueCount = Math.max(1, clueCount - 1); renderGame(); });
$('count-up').addEventListener('click', () => { clueCount = Math.min(9, clueCount + 1); renderGame(); });
$('clue-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const { value, problem } = clueProblem($('clue-input').value);
  if (!value || problem) { validateClueInput(); $('clue-input').focus(); return; }
  if (send('clue', { word: value, count: clueCount })) $('clue-input').value = '';
});
$('btn-reconnect').addEventListener('click', () => { fatal = false; hideFatal(); connect(); });
$('btn-reconnect-home').addEventListener('click', goHome);
$('confirm-ok').addEventListener('click', () => confirmDone?.(true));
$('confirm-cancel').addEventListener('click', () => confirmDone?.(false));
$('modal-confirm').addEventListener('click', (event) => { if (event.target === event.currentTarget) confirmDone?.(false); });
const openRules = () => showModal('modal-rules');
for (const id of ['btn-rules', 'btn-rules-home', 'btn-rules-lobby']) $(id).addEventListener('click', openRules);
$('modal-rules').addEventListener('click', (event) => {
  if (event.target === event.currentTarget || event.target.closest('[data-close]')) hideModal('modal-rules');
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const active = modalStack.at(-1)?.modal;
  if (active?.id === 'modal-confirm') confirmDone?.(false);
  else if (active?.id === 'modal-rules') hideModal('modal-rules');
  else if (active?.id === 'modal-over') { overDismissed = true; hideModal('modal-over'); }
  else if (selection && view?.game) { selection = null; renderGame(); }
});

const resync = () => {
  if (!room || fatal || document.hidden) return;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'sync' }));
  else if (!socket || socket.readyState !== WebSocket.CONNECTING) connect();
};
addEventListener('online', resync);
document.addEventListener('visibilitychange', resync);
addEventListener('offline', () => { ready = false; setConn(false, 'You are offline · actions paused'); if (room) render(); });
addEventListener('hashchange', navigate);
if (matchMedia('(min-width: 980px)').matches) $('log-details').open = true;

// ---------- Identity ----------
function showSignedIn(p) {
  profile = p;
  $('login-section').classList.add('hidden');
  $('game-section').classList.remove('hidden');
  $('identity-status').textContent = '';
  const status = $('auth-status');
  status.replaceChildren();
  status.append('Signed in as ', el('strong', null, p.displayName || p.name || 'Player'), ' · ');
  const out = el('a', null, 'Logout');
  out.href = '#';
  out.onclick = (event) => { event.preventDefault(); FunAuth.logout(); profile = null; showSignedOut(); if (room) connect(); };
  status.append(out);
}
function showSignedOut(message = '') {
  profile = null;
  $('game-section').classList.add('hidden');
  $('login-section').classList.remove('hidden');
  $('identity-status').textContent = message;
  FunAuth.mountLogin($('login-section'), (p) => {
    showSignedIn(p);
    // Reconnect so the room sees the verified identity, then auto-join.
    if (room) { autoJoined.delete(room); connect(); }
  });
}
async function identify() {
  const p = await FunAuth.profile();
  if (p?.offline) showSignedOut('Unable to verify sign-in right now. Check your connection and reload.');
  else if (p) showSignedIn(p);
  else showSignedOut();
}

if (!window.FC_MOVED) identify().finally(() => { render(); navigate(); });
