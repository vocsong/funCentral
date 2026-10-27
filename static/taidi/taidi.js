'use strict';

// ---------- Card helpers (mirror src/taidi/engine.ts; the room stays authoritative) ----------
const SUIT_SYMBOL = { D: '♦', C: '♣', H: '♥', S: '♠' };
const SUIT_NAME = { D: 'Diamonds', C: 'Clubs', H: 'Hearts', S: 'Spades' };
const SUITS = ['D', 'C', 'H', 'S']; // low to high
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']; // low to high
const SEAT_COLORS = ['#f5c451', '#5ec8f2', '#c084fc', '#6ee7a8'];
const KIND_NAME = {
  single: 'Single', pair: 'Pair', triple: 'Triple', straight: 'Straight', flush: 'Flush',
  fullhouse: 'Full house', quads: 'Four of a kind', straightflush: 'Straight flush',
};
const DEAL = {
  2: { each: 17, note: '18 cards stay out of play' },
  3: { each: 17, note: 'last card turned face up for the 3♦ holder' },
  4: { each: 13, note: 'the whole deck' },
};

const rankOf = (c) => c.slice(0, -1);
const suitOf = (c) => c.slice(-1);
const rankIndex = (c) => RANKS.indexOf(rankOf(c));
const power = (c) => rankIndex(c) * 4 + SUITS.indexOf(suitOf(c));
const isRed = (c) => suitOf(c) === 'H' || suitOf(c) === 'D';
const label = (c) => rankOf(c) + SUIT_SYMBOL[suitOf(c)];
const cardText = (cards) => cards.map(label).join(' ');
const sortHand = (cards) => [...cards].sort((a, b) => power(a) - power(b));
const isOver = (g) => g.phase === 'done';
const seatColor = (seat) => SEAT_COLORS[seat % SEAT_COLORS.length];
const initialOf = (name) => ([...String(name || '?').trim()][0] || '?').toUpperCase();

/** Classifies a set of cards, or null when it is not a legal combination. */
function classify(cards) {
  const n = cards.length;
  if (new Set(cards).size !== n) return null;
  const sorted = sortHand(cards);
  const top = sorted[n - 1];
  if (n === 1) return { kind: 'single', size: 1, tier: 0, power: power(top) };
  if (n === 2) return rankIndex(sorted[0]) === rankIndex(sorted[1]) ? { kind: 'pair', size: 2, tier: 0, power: power(top) } : null;
  if (n === 3) return sorted.every((c) => rankIndex(c) === rankIndex(top)) ? { kind: 'triple', size: 3, tier: 0, power: rankIndex(top) } : null;
  if (n !== 5) return null;

  const counts = new Map();
  for (const c of sorted) counts.set(rankIndex(c), (counts.get(rankIndex(c)) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = sorted.every((c) => suitOf(c) === suitOf(top));
  const ranks = sorted.map(rankIndex);
  const straight = counts.size === 5 && ranks[4] <= RANKS.indexOf('A') && ranks[4] - ranks[0] === 4;

  if (straight && flush) return { kind: 'straightflush', size: 5, tier: 5, power: power(top) };
  if (groups[0][1] === 4) return { kind: 'quads', size: 5, tier: 4, power: groups[0][0] };
  if (groups[0][1] === 3 && groups[1] && groups[1][1] === 2) return { kind: 'fullhouse', size: 5, tier: 3, power: groups[0][0] };
  if (flush) return { kind: 'flush', size: 5, tier: 2, power: SUITS.indexOf(suitOf(top)) * 16 + rankIndex(top) };
  if (straight) return { kind: 'straight', size: 5, tier: 1, power: power(top) };
  return null;
}

function beats(a, b) {
  if (a.size !== b.size) return false;
  if (a.size === 5) return a.tier !== b.tier ? a.tier > b.tier : a.power > b.power;
  return a.power > b.power;
}

/** Why these cards can't be played right now (null when they can). Cosmetic: the room re-checks. */
function whyNot(g, cards) {
  if (!cards.length) return 'Select cards to play';
  const combo = classify(cards);
  if (!combo) return cards.length === 1 ? null : "That isn't a valid combination";
  if (g.mustInclude && !cards.includes(g.mustInclude)) return `The first play must include the ${label(g.mustInclude)}`;
  if (g.table && !beats(combo, g.table)) {
    return g.table.size === combo.size ? "That doesn't beat the table" : `Play ${g.table.size} card${g.table.size === 1 ? '' : 's'} to beat the table`;
  }
  return null;
}

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/** One card face for the hand and the table. `.card-corner` stays the tap target tests aim for. */
function cardEl(code, { tag = 'div', mini = false } = {}) {
  const node = el(tag, `${mini ? 'card-mini' : 'card'} td-card ${isRed(code) ? 'red' : 'black'} suit-${suitOf(code)}`);
  node.dataset.card = code;
  const corner = el('span', 'card-corner');
  corner.append(el('span', 'card-value', rankOf(code)), el('span', 'card-suit', SUIT_SYMBOL[suitOf(code)]));
  node.append(corner, el('span', 'td-pip', SUIT_SYMBOL[suitOf(code)]));
  node.setAttribute('aria-label', `${rankOf(code)} of ${SUIT_NAME[suitOf(code)]}`);
  return node;
}

function toast(message, kind = '') {
  const stack = $('toasts');
  const node = el('div', `td-toast ${kind}`.trim(), message);
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
let playerId = hashInfo.pid || store.get('taidiPlayerId');
if (!playerId) playerId = (crypto.randomUUID?.() ?? `p${Date.now()}${Math.random().toString(36).slice(2)}`);
if (!hashInfo.pid) store.set('taidiPlayerId', playerId);
let playerName = store.get('playerName') || '';
let profile = null; // verified Telegram profile (FunAuth), null until signed in

// ---------- State ----------
let ws = null;
let roomCode = null;
let view = null;
let selected = new Set();
let reconnectDelay = 800;
let reconnectTimer = 0;
let lastGameNo = -1;
let overDismissed = false;
let joinSent = false;
let lastFocus = null;
const lobbySeen = new Set();

// ---------- Sound (synthesised, off by default) ----------
const sfx = (() => {
  let ctx = null;
  let on = store.get('taidiSound') === 'on';
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
    deal: () => [0, 0.06, 0.12, 0.18].forEach((d) => noise({ at: d, dur: 0.05, gain: 0.07, freq: 3000 })),
    pass: () => tone(240, { dur: 0.12, type: 'triangle', gain: 0.05, slide: -60 }),
    trick: () => { noise({ dur: 0.16, gain: 0.08, freq: 1800 }); tone(520, { dur: 0.16, type: 'triangle', gain: 0.05, slide: 260 }); },
    combo: () => [523, 659, 784].forEach((f, i) => tone(f, { at: i * 0.06, dur: 0.2, type: 'triangle', gain: 0.07 })),
    big: () => { [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.06, dur: 0.26, type: 'triangle', gain: 0.08 })); noise({ dur: 0.18, gain: 0.14, freq: 500 }); },
    warn: () => { tone(880, { dur: 0.1, type: 'square', gain: 0.03 }); tone(880, { at: 0.14, dur: 0.1, type: 'square', gain: 0.03 }); },
    turn: () => { tone(660, { dur: 0.1, gain: 0.07 }); tone(990, { at: 0.1, dur: 0.16, gain: 0.07 }); },
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
      store.set('taidiSound', on ? 'on' : 'off');
      if (on) this.play('turn');
      return on;
    },
  };
})();

function vibrate(pattern) {
  try { if (navigator.vibrate && matchMedia('(pointer: coarse)').matches) navigator.vibrate(pattern); } catch { /* unsupported */ }
}

// ---------- Animation layer ----------
// Every state is rendered immediately (the table is always authoritative). Animations then
// replay the new log entries on top: cards fly from hand or seat to the felt, passes and
// combos float up, a won trick sweeps to its leader. They never take input, and a newer
// state finishes them instantly.
const FLY = 380;
const fx = { timers: new Set(), anims: new Set() };

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
const plateOf = (seat) => document.querySelector(`#opponents .td-plate[data-seat="${seat}"]`);

/** Where a seat "is" on screen: its plate, or my own hand. */
function anchorOf(seat) {
  const r = seat === view.you.seat ? R($('hand')) ?? R($('turn-banner')) : R(plateOf(seat));
  return r ? centerOf(r) : null;
}

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
  const table = [...document.querySelectorAll('#table-play .card-mini')].map((n) => ({ code: n.dataset.card, rect: R(n) })).filter((p) => p.rect);
  return { active: $('screen-game').classList.contains('active'), hand, table };
}

/** Moves a detached node from one box to another inside the fx layer. */
function flyNode(node, from, to, { delay = 0, duration = 420, rotate = [0, 0], fadeOut = false, arc = 0, easing = 'cubic-bezier(.2,.75,.25,1)', onLand } = {}) {
  if (!from || !to) return;
  node.classList.add('td-fly');
  Object.assign(node.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  node.style.setProperty('--w', `${from.width}px`);
  $('fx').append(node);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const s = to.width / from.width;
  const frames = [{ transform: `translate(0px, 0px) scale(1) rotate(${rotate[0]}deg)`, opacity: 1 }];
  if (arc) frames.push({ transform: `translate(${dx / 2}px, ${dy / 2 - arc}px) scale(${(1 + s) / 2}) rotate(${(rotate[0] + rotate[1]) / 2}deg)`, opacity: 1, offset: 0.5 });
  frames.push({ transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(${rotate[1]}deg)`, opacity: fadeOut ? 0 : 1 });
  const a = anim(node, frames, { duration, delay, easing, fill: 'both' });
  if (!a) { node.remove(); return; }
  a.finished.then(() => { node.remove(); onLand?.(); }).catch(() => node.remove());
}

/** FLIP: a real element appears to travel from `from` to where it now sits. */
function flipFrom(node, from, { delay = 0, duration = FLY, arc = 0 } = {}) {
  const to = R(node);
  if (!to || !from) return;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const s = from.width / to.width;
  const frames = [{ transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(${from.angle || 0}deg)`, zIndex: 5 }];
  if (arc) frames.push({ transform: `translate(${dx / 2}px, ${dy / 2 - arc}px) scale(${(1 + s) / 2}) rotate(${(from.angle || 0) / 2}deg)`, zIndex: 5, offset: 0.55 });
  frames.push({ transform: 'none', zIndex: 5 });
  anim(node, frames, { duration, delay, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' });
}

function floatText(text, point, { cls = '', delay = 0, duration = 1100, rise = 48 } = {}) {
  if (!point) return;
  at(delay, () => {
    const n = el('div', `td-float ${cls}`.trim(), text);
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

function burst(point, { n = 16, colors = ['#f5c451', '#fff3c4', '#ff9f43'], delay = 0, spread = 100, size = 7 } = {}) {
  if (!point) return;
  at(delay, () => {
    for (let i = 0; i < n; i++) {
      const p = el('i', 'td-particle');
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

/** A big caption over the felt ("Your turn", "X opens", …). */
function callout(text, kind = '', delay = 0, { sub = '', y = 0.5, duration = 1400 } = {}) {
  at(delay, () => {
    const t = R($('td-table'));
    if (!t) return;
    const n = el('div', `td-callout ${kind}`.trim());
    n.append(el('span', 'td-callout-main', text));
    if (sub) n.append(el('span', 'td-callout-sub', sub));
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
    const n = el('div', `td-flash ${cls}`);
    const r = rect ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
    Object.assign(n.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    $('fx').append(n);
    const a = anim(n, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration, easing: 'ease-out', fill: 'forwards' });
    a?.finished.then(() => n.remove()).catch(() => n.remove());
  });
}

function pulse(node, delay = 0, scale = 1.1) {
  if (!node) return;
  anim(node, [{ transform: 'scale(1)' }, { transform: `scale(${scale})`, offset: 0.4 }, { transform: 'scale(1)' }], { duration: 380, delay, easing: 'ease-out' });
}

function shake(node) {
  if (!node || !motionOK()) return;
  anim(node, [
    { transform: 'none' }, { transform: 'translateX(-7px)', offset: 0.2 }, { transform: 'translateX(6px)', offset: 0.45 },
    { transform: 'translateX(-3px)', offset: 0.7 }, { transform: 'none' },
  ], { duration: 320 });
}

function confetti(delay = 0) {
  at(delay, () => {
    const colors = ['#f5c451', '#ff6b6b', '#5ec8f2', '#6ee7a8', '#c084fc', '#fff3c4'];
    for (let i = 0; i < 56; i++) {
      const p = el('i', 'td-confetti');
      Object.assign(p.style, { left: `${Math.random() * innerWidth}px`, top: '-16px', background: colors[i % colors.length] });
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

/** Where a played card starts: my own card's spot in hand, otherwise its owner's plate. */
function sourceBox(code, seat, ctx, i = 0, n = 1) {
  if (seat === ctx.me) {
    const h = ctx.scene.hand.get(code);
    if (h) return h;
  }
  const pr = R(plateOf(seat)) ?? (seat === ctx.me ? R($('hand')) : null);
  if (!pr) return null;
  const b = cardBox(pr, 30);
  b.left += (i - (n - 1) / 2) * 12;
  return b;
}

/** The middle of the felt, where plays land. */
function feltBox(w = 56) {
  const r = R($('table-play')) ?? R($('td-table'));
  return r ? cardBox(r, w) : null;
}

/** Plays the new log entries in order; returns how long the sequence runs (ms). */
function animateTransition(prev, next, scene) {
  const g = next.game;
  if (!motionOK() || !$('screen-game').classList.contains('active')) return 0;
  const pg = prev?.game;
  if (!pg || prev.gameNo !== next.gameNo || !scene.active) return g.log.length === 0 && !isOver(g) ? dealTimeline(g, next.you.seat) : 0;
  const lastSeq = pg.log.at(-1)?.seq ?? 0;
  if ((g.log.at(-1)?.seq ?? 0) < lastSeq) return 0; // log was reset (dev patch)
  const events = g.log.filter((e) => e.seq > lastSeq);
  if (!events.length || events.length > 12) return 0;

  const me = next.you.seat;
  const ctx = { g, pg, me, scene, events, held: [], tableHandled: false };
  let t = 0;
  for (const e of events) t = runEffect(e, ctx, t);

  // Turn hand-off cues.
  const myTurn = me >= 0 && g.currentSeat === me && !isOver(g);
  if (myTurn && (pg.currentSeat !== me || pg.phase !== 'play')) {
    callout('Your turn', '', t + 40, { duration: 1000 });
    sfx.play('turn', t + 40);
    at(t + 40, () => vibrate(30));
    t += 120;
  }
  return t;
}

function runEffect(e, ctx, t) {
  switch (e.t) {
    case 'play': return fxPlay(e, ctx, t);
    case 'pass': return fxPass(e, ctx, t);
    case 'trick': return fxTrick(e, ctx, t);
    case 'won': return fxWon(e, ctx, t);
  }
  return t;
}

function fxPlay(e, ctx, t) {
  const sources = e.cards.map((c, i) => sourceBox(c, e.seat, ctx, i, e.cards.length));
  const finalTable = ctx.g.table?.cards.join(',') === e.cards.join(',') ? [...document.querySelectorAll('#table-play .card-mini')] : null;

  // What was lying there before is covered up by the new play.
  if (!ctx.tableHandled && ctx.scene.table.length) {
    ctx.tableHandled = true;
    for (const old of ctx.scene.table) {
      flyNode(cardEl(old.code, { mini: true }), old.rect, { ...old.rect, width: old.rect.width * 0.86, height: old.rect.height * 0.86 }, { delay: t, duration: FLY, fadeOut: true, easing: 'ease-in' });
    }
  }
  sfx.play('card', t);
  if (finalTable) {
    finalTable.forEach((node, i) => flipFrom(node, sources[i], { delay: t + i * 55, arc: 26 }));
  } else {
    // This play was answered or cleared within the same update: let it land on the felt, then wait to be swept.
    const target = feltBox(54);
    e.cards.forEach((c, i) => {
      const box = target ? { ...target, left: target.left + (i - (e.cards.length - 1) / 2) * 30 } : null;
      flyNode(cardEl(c, { mini: true }), sources[i], box, {
        delay: t + i * 55, duration: FLY, arc: 26,
        onLand: () => {
          if (!box) return;
          const rest = cardEl(c, { mini: true });
          rest.classList.add('td-fly');
          Object.assign(rest.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
          rest.style.setProperty('--w', `${box.width}px`);
          $('fx').append(rest);
          ctx.held.push({ node: rest, code: c, box });
        },
      });
    });
  }

  let end = t + FLY + (e.cards.length - 1) * 55;
  const anchor = feltBox(54);
  const point = anchor ? centerOf({ left: anchor.left, top: anchor.top - 14, width: anchor.width, height: anchor.height }) : null;
  const plate = plateOf(e.seat);
  if (plate && e.seat !== ctx.me) pulse(plate, t + FLY);
  if (e.kind === 'quads' || e.kind === 'straightflush') {
    floatText(`${KIND_NAME[e.kind]}!`, point, { cls: 'td-float-big', delay: end - 120, duration: 1500, rise: 60 });
    burst(point, { n: 22, delay: end - 80, spread: 120 });
    overlayFlash('td-flash-big', end - 100, R($('td-table')), 800);
    sfx.play('big', end - 100);
    at(end, () => vibrate([20, 40, 30]));
    end += 260;
  } else if (e.cards.length === 5) {
    floatText(`${KIND_NAME[e.kind]}!`, point, { cls: 'td-float-combo', delay: end - 120, duration: 1300 });
    burst(point, { n: 10, delay: end - 80, spread: 80 });
    sfx.play('combo', end - 100);
    end += 160;
  }
  // The last time this seat plays in this update: warn if they're nearly out.
  const lastPlayOfSeat = [...ctx.events].reverse().find((x) => x.t === 'play' && x.seat === e.seat);
  const left = ctx.g.handCounts[e.seat];
  if (lastPlayOfSeat === e && left === 1 && !isOver(ctx.g)) {
    floatText('1 card left!', anchorOf(e.seat), { cls: 'td-float-out', delay: end - 60, duration: 1300 });
    sfx.play('warn', end - 60);
    end += 120;
  }
  return end - FLY * 0.45;
}

function fxPass(e, ctx, t) {
  const p = anchorOf(e.seat);
  floatText('Pass', p, { cls: 'td-float-pass', delay: t, duration: 900, rise: 34 });
  sfx.play('pass', t);
  return t + 300;
}

function fxTrick(e, ctx, t) {
  // Everything lying on the felt is swept to whoever takes it.
  const winnerPoint = anchorOf(e.seat);
  const to = winnerPoint ? { left: winnerPoint.x - 10, top: winnerPoint.y - 14, width: 20, height: 28, angle: 0 } : null;
  const entries = [...ctx.held];
  if (!ctx.tableHandled) {
    ctx.tableHandled = true;
    for (const old of ctx.scene.table) entries.push({ code: old.code, box: old.rect, node: null });
  }
  for (const h of entries) {
    h.node?.remove();
    flyNode(cardEl(h.code, { mini: true }), h.box, to, { delay: t, duration: 460, fadeOut: true, easing: 'cubic-bezier(.5,0,.75,.4)', rotate: [0, e.seat === ctx.me ? 0 : 12] });
  }
  ctx.held = [];
  sfx.play('trick', t);
  if (e.seat !== ctx.me) pulse(plateOf(e.seat), t + 420);
  floatText(e.seat === ctx.me ? 'You lead' : `${who(e.seat)} leads`, winnerPoint, { cls: 'td-float-lead', delay: t + 380, duration: 1000, rise: 36 });
  return t + 520;
}

function fxWon(e, ctx, t) {
  const mine = e.seat === ctx.me;
  if (mine) {
    confetti(t);
    callout('You went out!', 'good', t, { sub: 'First to empty their hand', duration: 1800 });
    sfx.play('win', t);
    at(t, () => vibrate([30, 60, 30, 60, 60]));
  } else {
    callout(`${who(e.seat)} went out`, '', t, { sub: ctx.me >= 0 ? 'Better luck next hand' : '', duration: 1500 });
    sfx.play(ctx.me >= 0 ? 'lose' : 'win', t);
  }
  burst(anchorOf(e.seat), { n: 18, delay: t, spread: 110 });
  overlayFlash('td-flash-big', t, R($('td-table')), 900);
  return t + 900;
}

/** A fresh deal: cards fan out from the middle of the table, plates pop in, the opener is called. */
function dealTimeline(g, me) {
  const from = feltBox(40);
  if (from) {
    for (const [i, node] of [...document.querySelectorAll('#hand .hand-card')].entries()) {
      const to = R(node);
      if (!to) continue;
      const angle = parseFloat(node.style.getPropertyValue('--card-angle')) || 0;
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      anim(node, [
        { transform: `translate(${dx}px, ${dy}px) scale(${from.width / node.offsetWidth}) rotate(0deg)`, opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: `rotate(${angle}deg)`, opacity: 1 },
      ], { duration: 460, delay: 120 + i * 38, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' });
    }
  }
  document.querySelectorAll('#opponents .td-plate').forEach((p, i) => {
    anim(p, [{ opacity: 0, transform: 'translateY(-10px) scale(.9)' }, { opacity: 1, transform: 'none' }], { duration: 360, delay: i * 90, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' });
  });
  const n = document.querySelectorAll('#hand .hand-card').length;
  const dealt = 160 + Math.max(n, 4) * 38 + 380;
  sfx.play('deal', 100);
  const opener = g.currentSeat;
  callout(opener === me ? 'You open' : `${playerNameOf(opener)} opens`, '', dealt - 200, { sub: g.mustInclude ? `with the ${label(g.mustInclude)}` : '', duration: 1300 });
  return dealt + 200;
}

// ---------- Networking ----------
function connect(code) {
  if (window.FC_MOVED) return; // this page is forwarding to funcentral.vocs.io (fc-host.js)
  roomCode = code;
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = FunAuth.token();
  const socket = new WebSocket(`${proto}//${location.host}/api/taidi/ws?room=${code}&playerId=${encodeURIComponent(playerId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`);
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
  shake($('hand'));
}

let overPending = false; // hold the results panel until the closing animation has played

function onState(next) {
  const prev = view;
  // Connection flags, names and late rating results don't change the game itself: refresh those
  // parts without interrupting an animation or the pending results panel.
  if (next.game && prev?.game && prev.gameNo === next.gameNo && JSON.stringify(next.game) === JSON.stringify(prev.game)) {
    view = next;
    renderTopBar();
    renderOpponents(next.game);
    renderBanner(next.game, next.you.seat >= 0 && next.game.currentSeat === next.you.seat && !isOver(next.game));
    if (!overPending) syncOverModal();
    return;
  }
  // Finish any running animation first, so the snapshot reflects the settled table.
  fxReset();
  overPending = false;
  const scene = snapshotScene();
  view = next;
  if (next.you.seat >= 0) joinSent = true; // seated: never auto-join again on this connection (e.g. after a kick)
  // Join on first contact if we aren't seated yet and the game hasn't started (signed-in players only).
  if (!joinSent && next.you.seat < 0 && !next.game && FunAuth.token()) {
    joinSent = true;
    send({ type: 'join', name: playerName });
  }
  if (next.gameNo !== lastGameNo) {
    lastGameNo = next.gameNo;
    overDismissed = false;
    selected.clear();
  }
  // Selections only make sense on my own turn, and only for cards still in hand.
  const g = next.game;
  const pg = prev?.game;
  if (!g || !pg || g.currentSeat !== pg.currentSeat || g.phase !== pg.phase) selected.clear();
  if (g?.hand) selected = new Set([...selected].filter((c) => g.hand.includes(c)));
  overPending = !!g && isOver(g);
  render();
  const t = g ? animateTransition(prev, next, scene) : 0;
  if (overPending) at(t > 0 ? t + 500 : 0, () => { overPending = false; syncOverModal(); });
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
  renderGame();
  if (!overPending) syncOverModal();
}

function renderTopBar() {
  const sound = $('btn-sound');
  sound.textContent = sfx.on ? '🔊' : '🔇';
  sound.setAttribute('aria-pressed', String(sfx.on));
  sound.title = sfx.on ? 'Sound effects on' : 'Sound effects off';
  const g = view?.game;
  $('btn-end').classList.toggle('hidden', !(g && !isOver(g) && view.you.isHost && view.you.seat >= 0));
}

// ---------- Lobby ----------
function renderLobbyLoading() {
  $('lobby-code').textContent = roomCode;
  $('lobby-players').replaceChildren(el('div', 'player-item td-empty', 'Connecting…'));
  $('btn-start').classList.add('hidden');
  $('lobby-wait').textContent = '';
  $('lobby-setup').classList.add('hidden');
}

function statusDot(connected) {
  return el('span', `status-dot ${connected ? 'online' : 'offline'}`);
}

function avatarEl(p, seat) {
  const avatar = el('span', 'td-avatar', initialOf(p.name));
  avatar.style.setProperty('--seat-color', seatColor(seat));
  avatar.append(statusDot(p.connected));
  return avatar;
}

function renderLobby() {
  const { players, you } = view;
  const max = view.maxPlayers;
  const min = view.minPlayers;
  $('lobby-code').textContent = view.roomCode;
  const list = $('lobby-players');
  list.replaceChildren();
  players.forEach((p, seat) => {
    const item = el('div', 'player-item td-player');
    item.style.setProperty('--seat-color', seatColor(seat));
    const identity = el('div', 'lobby-identity');
    identity.append(el('span', 'lobby-player-name', p.name));
    if (p.id === you.id) identity.append(el('span', 'td-you', 'you'));
    const meta = el('div', 'lobby-meta');
    if (p.isHost) meta.append(el('span', 'td-host', '👑 Host'));
    // Same signal as Bridge: non-members still play and are rated, but don't count for this group.
    if (p.isGroupMember === false) meta.append(el('span', 'not-ranked-badge', '⚠️ not in group'));
    if (!p.connected) meta.append(el('span', 'td-offline', 'offline'));
    const action = el('div', 'lobby-action');
    item.append(avatarEl(p, seat), identity, meta, action);
    if (!lobbySeen.has(p.id)) { lobbySeen.add(p.id); item.classList.add('td-enter'); }
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
    const open = el('div', 'player-item td-empty');
    open.append(el('span', 'td-avatar td-avatar-empty', '+'), el('span', null, i < min ? 'Waiting for a player' : 'Open seat'));
    list.append(open);
  }

  const n = players.length;
  const setup = $('lobby-setup');
  setup.classList.toggle('hidden', n < min);
  if (n >= min) {
    const d = DEAL[n];
    const parts = [el('div', 'td-setup-mode', `🎴 ${n} players · ${d.each} cards each`), el('div', 'td-setup-note', d.note)];
    if (view.groupName) parts.push(el('div', 'td-setup-group', `💬 ${view.groupName}`));
    setup.replaceChildren(...parts);
  }

  const seated = you.seat >= 0;
  $('btn-start').classList.toggle('hidden', !you.isHost);
  $('btn-start').disabled = n < min;
  if (!seated && !FunAuth.token()) {
    $('lobby-wait').textContent = 'Sign in with Telegram on the Tai Di home screen to take a seat — you can watch until then.';
    return;
  }
  $('btn-start').textContent = `🎴 Start Game (${n} players)`;
  const wait = $('lobby-wait');
  wait.textContent = !seated
    ? (n >= max ? 'This room is full.' : 'Joining…')
    : you.isHost
      ? (n < min ? `Share the code — you need at least ${min} players.` : n < max ? `Share the code — up to ${max} can play, or start now.` : 'Table is full — ready when you are.')
      : `Waiting for ${players.find((p) => p.isHost)?.name ?? 'the host'} to start...`;
}

// ---------- Game rendering ----------
const playerNameOf = (seat) => view.players[seat]?.name ?? `Player ${seat + 1}`;
const who = (seat) => (seat === view.you.seat ? 'You' : playerNameOf(seat));

function renderGame() {
  const g = view.game;
  const myTurn = view.you.seat >= 0 && g.currentSeat === view.you.seat && !isOver(g);
  $('td-game').classList.toggle('my-turn', myTurn);
  renderOpponents(g);
  renderTable(g);
  renderBanner(g, myTurn);
  renderHand(g, myTurn);
  renderPreview(g, myTurn);
  renderActions(g, myTurn);
  renderLog(g);
}

/** Everyone but me, in turn order after my seat (all seats for a spectator). */
function otherSeats(n, me) {
  if (me < 0) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: n - 1 }, (_, i) => (me + 1 + i) % n);
}

function renderOpponents(g) {
  const box = $('opponents');
  box.replaceChildren();
  for (const seat of otherSeats(g.numPlayers, view.you.seat)) {
    const p = view.players[seat];
    const active = !isOver(g) && g.currentSeat === seat;
    const plate = el('div', `td-plate${active ? ' active' : ''}${g.winner === seat ? ' winner' : ''}${p?.connected === false ? ' offline' : ''}`);
    plate.dataset.seat = String(seat);
    plate.style.setProperty('--seat-color', seatColor(seat));
    const avatar = el('span', 'td-avatar', initialOf(p?.name));
    avatar.style.setProperty('--seat-color', seatColor(seat));
    const info = el('div', 'td-plate-info');
    info.append(el('span', 'td-plate-name', p?.name ?? `Player ${seat + 1}`));
    const left = g.handCounts[seat];
    const count = el('span', `td-plate-count${left <= 3 && left > 0 ? ' low' : ''}`, left === 0 ? 'out!' : `${left} card${left === 1 ? '' : 's'}`);
    info.append(count);
    plate.append(avatar, info);
    if (g.table?.seat === seat && !isOver(g)) plate.append(el('span', 'td-plate-tag', 'leading'));
    if (g.winner === seat) plate.append(el('span', 'td-plate-tag', '🏆'));
    box.append(plate);
  }
}

function renderTable(g) {
  const meta = $('table-meta');
  const bits = [];
  if (g.exposed) bits.push(`Face-up card: ${label(g.exposed)}`);
  if (g.unused) bits.push(`${g.unused} cards out of play`);
  if (view.you.seat >= 0) bits.push(`Your cards: ${g.handCounts[view.you.seat]}`);
  meta.replaceChildren(...bits.map((b) => el('span', 'td-chip', b)));

  const play = $('table-play');
  const caption = $('table-caption');
  play.replaceChildren();
  if (g.table) {
    for (const code of g.table.cards) play.append(cardEl(code, { mini: true }));
    caption.textContent = `${who(g.table.seat)} played a ${KIND_NAME[g.table.kind].toLowerCase()}${g.passes ? ` · ${g.passes} pass${g.passes === 1 ? '' : 'es'}` : ''}`;
  } else {
    play.append(el('div', 'td-empty-table', isOver(g) ? '—' : 'Table is clear'));
    caption.textContent = isOver(g) ? '' : g.mustInclude ? `${who(g.currentSeat)} must open with the ${label(g.mustInclude)}` : `${who(g.currentSeat)} leads — any play`;
  }
}

function renderBanner(g, myTurn) {
  const banner = $('turn-banner');
  banner.classList.toggle('mine', myTurn);
  if (banner.dataset.turn !== `${view.gameNo}:${g.currentSeat}:${g.phase}`) {
    banner.dataset.turn = `${view.gameNo}:${g.currentSeat}:${g.phase}`;
    banner.classList.remove('pop');
    void banner.offsetWidth;
    banner.classList.add('pop');
  }
  if (isOver(g)) banner.textContent = g.winner === view.you.seat ? '🏆 You went out first!' : `${playerNameOf(g.winner)} went out first`;
  else if (view.you.seat < 0) banner.textContent = `Watching — ${playerNameOf(g.currentSeat)} to play`;
  else if (myTurn) banner.textContent = g.table ? 'Your turn — beat the table or pass' : g.mustInclude ? `Your lead — include the ${label(g.mustInclude)}` : 'Your lead — play anything';
  else banner.textContent = `Waiting for ${playerNameOf(g.currentSeat)}…`;
}

// ---------- Hand ----------
function fanLayout(container, n) {
  const width = container.clientWidth || 340;
  const wide = width >= 600;
  const cardW = Math.round(Math.min(wide ? 92 : 70, Math.max(44, width / (wide ? 8 : 6))));
  // Keep the rotated outer cards inside the container (their corners swing ~20% of a card outwards).
  const usable = width - cardW * 1.4;
  const spacing = n > 1 ? Math.min(cardW * 0.8, usable / (n - 1)) : 0;
  const mid = (n - 1) / 2;
  const step = n > 1 ? Math.min(4, 22 / (n - 1)) : 0;
  const arc = cardW * 0.02;
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
function renderHand(g, myTurn) {
  const hand = $('hand');
  if (!g.hand) {
    hand.style.height = '64px';
    hand.replaceChildren(el('div', 'td-hand-empty', 'You are watching this game.'));
    return;
  }
  const cards = sortHand(g.hand);
  hand.classList.toggle('interactive', myTurn);
  for (const node of [...hand.children]) if (!node.classList.contains('hand-card') || !cards.includes(node.dataset.card)) node.remove();
  const nodes = new Map([...hand.children].map((n) => [n.dataset.card, n]));
  const place = fanLayout(hand, cards.length);
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
    node.classList.toggle('td-must', !!g.mustInclude && code === g.mustInclude && myTurn);
    node.setAttribute('aria-pressed', String(isSel));
    node.disabled = !myTurn;
    node.dataset.key = String(i + 1);
  });
  if (!cards.length) hand.append(el('div', 'td-hand-empty', 'Your hand is empty'));
}

function onCardTap(code) {
  const g = view?.game;
  if (!g || isOver(g)) return;
  if (selected.has(code)) selected.delete(code);
  else if (selected.size >= 5) { toast('A play is at most five cards', 'error'); return; }
  else selected.add(code);
  refreshHandArea();
}

function refreshHandArea() {
  const g = view?.game;
  if (!g) return;
  const myTurn = view.you.seat >= 0 && g.currentSeat === view.you.seat && !isOver(g);
  renderHand(g, myTurn);
  renderPreview(g, myTurn);
  renderActions(g, myTurn);
}

function renderPreview(g, myTurn) {
  const box = $('preview');
  box.className = 'td-preview';
  const cards = [...selected];
  if (!myTurn || !cards.length) { box.textContent = ''; return; }
  const combo = classify(cards);
  const problem = whyNot(g, cards);
  if (problem) {
    box.classList.add('bad');
    box.textContent = problem;
  } else {
    box.classList.add('ok');
    box.textContent = `${KIND_NAME[combo.kind]}: ${cardText(sortHand(cards))}`;
  }
}

function renderActions(g, myTurn) {
  const act = $('btn-act');
  const pass = $('btn-pass');
  const over = isOver(g);
  const seated = view.you.seat >= 0;
  $('action-bar').classList.toggle('hidden', !seated);
  if (over) {
    act.textContent = 'Results';
    act.dataset.action = 'results';
    act.disabled = false;
    pass.classList.add('hidden');
    return;
  }
  pass.classList.remove('hidden');
  act.dataset.action = 'play';
  act.textContent = selected.size ? `Play ${selected.size}` : 'Play';
  act.disabled = !myTurn || !!whyNot(g, [...selected]);
  pass.disabled = !myTurn || !g.canPass;
  pass.title = myTurn && !g.canPass ? 'You are leading — you have to play' : 'Pass this turn (P)';
}

// ---------- Log ----------
function describe(entry) {
  switch (entry.t) {
    case 'play': return `${who(entry.seat)} played ${KIND_NAME[entry.kind].toLowerCase()} ${cardText(entry.cards)}`;
    case 'pass': return `${who(entry.seat)} passed`;
    case 'trick': return `${who(entry.seat)} took the table`;
    case 'won': return `${who(entry.seat)} went out first`;
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
  if (!document.querySelector('.td-modal:not(.hidden)')) lastFocus = document.activeElement;
  m.classList.remove('hidden');
  document.body.classList.add('modal-open');
  if (id !== 'modal-confirm') requestAnimationFrame(() => m.querySelector('button:not(.hidden):not([disabled])')?.focus({ preventScroll: true }));
}

function hideModal(id) {
  const m = $(id);
  if (m.classList.contains('hidden')) return;
  m.classList.add('hidden');
  if (!document.querySelector('.td-modal:not(.hidden)')) {
    document.body.classList.remove('modal-open');
    if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }
}

function syncOverModal() {
  const g = view?.game;
  if (g && isOver(g) && !overDismissed) showOverModal(g);
  else hideModal('modal-over');
}

const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4]}`;

function showOverModal(g) {
  const youWon = g.winner === view.you.seat;
  $('over-title').textContent = youWon ? '🏆 You win!' : `${playerNameOf(g.winner)} wins`;
  $('over-sub').textContent = view.you.seat >= 0 && !youWon ? `You finished ${ordinal(g.placements[view.you.seat])}` : 'First to empty their hand';
  const order = g.placements.map((place, seat) => ({ place, seat })).sort((a, b) => a.place - b.place || a.seat - b.seat);
  const rows = order.map(({ place, seat }) => {
    const row = el('div', `td-result${seat === view.you.seat ? ' me' : ''}`);
    row.append(el('span', 'td-result-place', place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : `${place}.`));
    row.append(el('span', 'td-result-name', who(seat)));
    row.append(el('span', 'td-result-left', g.handCounts[seat] === 0 ? 'out' : `${g.handCounts[seat]} left`));
    return row;
  });
  // The staggered entrance only plays when the panel opens, not on every refresh while it is open.
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
  box.replaceChildren(el('div', 'td-rating-head', 'Rating'), ...[...result.changes].sort((a, b) => a.place - b.place).map((c, i) => {
    const row = el('div', `td-rating-row${c.seat === view.you.seat ? ' me' : ''}`);
    row.style.setProperty('--i', String(i));
    row.append(el('span', null, c.name || 'Player'), el('b', c.delta >= 0 ? 'up' : 'down', `${c.delta >= 0 ? '+' : ''}${c.delta}`), el('span', 'td-rating-after', String(c.after)));
    return row;
  }));
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
    const res = await fetch('/api/taidi/stats');
    statsRows = res.ok ? await res.json() : [];
  } catch { statsRows = []; }
  renderStats();
}

function hideStats() {
  history.replaceState(null, '', location.pathname);
  render();
}

function sortStats(col) {
  statsSort = statsSort.col === col ? { col, dir: statsSort.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: col === 'name' || col === 'avg' ? 'asc' : 'desc' };
  renderStats();
}

function renderStats() {
  const content = $('stats-content');
  for (const b of document.querySelectorAll('#td-min-games .min-games-btn')) b.classList.toggle('active', Number(b.dataset.value) === statsMinGames);
  const sortFns = {
    elo: (r) => r.elo, games: (r) => r.games, wins: (r) => r.wins, winPct: (r) => r.winPct,
    avg: (r) => r.avgPlace, name: (r) => r.displayName.toLowerCase(),
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
  const th = (col, text, left = false) => `<th class="${left ? 'stats-th-left' : ''}${statsSort.col === col ? ' sorted' : ''}" data-sort="${col}">${text} ${arrow(col)}</th>`;
  const body = sorted.map((r, i) => `<tr>
      <td class="stats-td-name">${i < 3 ? medals[i] : `${i + 1}.`} ${esc(r.displayName)}</td>
      <td class="stats-td-num stats-elo">${r.elo}</td>
      <td class="stats-td-num">${r.games}</td>
      <td class="stats-td-num">${r.wins}</td>
      <td class="stats-td-num">${r.winPct}%</td>
      <td class="stats-td-num">${Number(r.avgPlace).toFixed(1)}</td>
    </tr>`).join('');
  content.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr>${th('name', 'Player', true)}${th('elo', 'Rating')}${th('games', 'G')}${th('wins', 'W')}${th('winPct', 'Win%')}${th('avg', 'Avg place')}</tr></thead>
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
  if (socket) { socket.onclose = null; setTimeout(() => socket.close(), 50); }
  history.replaceState(null, '', location.pathname);
  $('overlay-reconnect').classList.add('hidden');
  for (const m of document.querySelectorAll('.td-modal')) m.classList.add('hidden');
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
    out.onclick = (e) => { e.preventDefault(); FunAuth.logout(); profile = null; showSignedOut(); FunLeaderboard.mount($('leaderboard-section'), { game: 'taidi' }); };
    status.append(out);
  }
}

function showSignedOut() {
  $('game-section').classList.add('hidden');
  $('login-section').classList.remove('hidden');
  FunAuth.mountLogin($('login-section'), (p) => {
    showSignedIn(p);
    FunLeaderboard.mount($('leaderboard-section'), { game: 'taidi' });
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
    const res = await fetch('/api/taidi/create', { method: 'POST' });
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
    try { await navigator.share({ title: 'Tai Di on funCentral', text: `Join my Tai Di game — room ${roomCode}`, url }); return; } catch { /* cancelled */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied 📋');
  } catch {
    prompt('Copy this invite link:', url);
  }
}

function playSelected() {
  const g = view?.game;
  if (!g || isOver(g)) return;
  send({ type: 'play', cards: [...selected] });
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
  if (midGame && !await askConfirm({ title: 'Leave this game?', body: 'The table waits for you — your seat is kept if you come back.', ok: 'Leave', danger: true })) return;
  leaveRoom(true);
});
$('btn-end').addEventListener('click', async () => {
  if (!view?.game) return;
  const ok = await askConfirm({
    title: 'End this game?',
    body: 'Everyone returns to the lobby. A game that is ended early is not rated.',
    ok: 'End game',
    danger: true,
  });
  if (ok) send({ type: 'backToLobby' });
});
$('btn-sound').addEventListener('click', () => { sfx.toggle(); renderTopBar(); });
$('btn-pass').addEventListener('click', () => send({ type: 'pass' }));
$('btn-act').addEventListener('click', () => {
  const action = $('btn-act').dataset.action;
  if (action === 'results') { overDismissed = false; showOverModal(view.game); return; }
  if (action === 'play') playSelected();
});
$('btn-stats').addEventListener('click', showStats);
$('btn-stats-home').addEventListener('click', hideStats);
for (const b of document.querySelectorAll('#td-min-games .min-games-btn')) {
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
  if (!g || isOver(g) || !$('screen-game').classList.contains('active') || document.querySelector('.td-modal:not(.hidden)')) return;
  if (view.you.seat < 0 || g.currentSeat !== view.you.seat || !g.hand) return;
  const key = e.key.toLowerCase();
  if (/^[1-9]$/.test(key)) {
    const code = sortHand(g.hand)[Number(key) - 1];
    if (code) { e.preventDefault(); onCardTap(code); }
  } else if (key === 'enter' && !e.target.closest?.('button')) {
    if (!$('btn-act').disabled) { e.preventDefault(); $('btn-act').click(); }
  } else if (key === 'p') {
    const p = $('btn-pass');
    if (!p.disabled) p.click();
  }
});

// Desktop: keep the log open by default.
if (matchMedia('(min-width: 1100px)').matches) $('log-details').open = true;

// The fan is laid out in pixels, so re-lay it when the width changes.
let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (view?.game) refreshHandArea(); }, 100);
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

FunLeaderboard.mount($('leaderboard-section'), { game: 'taidi' });
initAuth().finally(() => {
  if (hashInfo.room) openFromHash(hashInfo.room);
  else if (new URLSearchParams(location.search).get('view') === 'stats') showStats();
  else render();
});
