// Tai Di end-to-end: real local Worker + Durable Object + D1, driven through the UI.
// Seeded rooms plus the dev-only /api/taidi/debug/patch hook set up exact situations;
// full 2/3/4-player games check hidden hands, spectators, reloads and rating results.
const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
test.setTimeout(240000);
let worker;
test.beforeAll(async () => { worker = await startWorker(4219); });
test.afterAll(async () => { await worker?.stop(); });

const api = (path, init) => fetch(`${worker.origin}${path}`, init);
async function token(name) {
  const res = await api('/api/auth/dev', { method: 'POST', body: JSON.stringify({ displayName: name }) });
  return (await res.json()).token;
}
async function createRoom(seed = 1) {
  const res = await api('/api/taidi/create', { method: 'POST', body: JSON.stringify({ seed }) });
  return (await res.json()).roomCode;
}
async function patch(room, game) {
  const res = await api(`/api/taidi/debug/patch?room=${room}`, { method: 'POST', body: JSON.stringify(game) });
  expect(res.ok).toBe(true);
}

async function client(browser, name, { mobile = false, room = null, signedIn = true } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort()));
  const auth = signedIn ? await token(name) : null;
  await page.addInitScript(({ auth }) => {
    if (auth) localStorage.setItem('authToken', auth);
    window.confirm = () => true;
  }, { auth });
  await page.goto(`${worker.origin}/taidi/${room ? `#${room}` : ''}`);
  return { page, context, name, errors };
}

/** Seats everyone in a fresh seeded room and starts; returns pages in seat order. */
async function table(browser, n, { seed = 1, mobile = [] } = {}) {
  const room = await createRoom(seed);
  const names = ['Ada', 'Bea', 'Cy', 'Di'].slice(0, n).map((x) => `${x}${seed}`);
  const pages = [];
  for (let i = 0; i < n; i++) {
    pages.push(await client(browser, names[i], { room, mobile: mobile.includes(i) }));
    await expect(pages[0].page.locator('#lobby-players .player-item.td-player')).toHaveCount(i + 1);
  }
  await pages[0].page.locator('#btn-start').click();
  for (const p of pages) await expect(p.page.locator('#screen-game')).toHaveClass(/active/);
  return { room, pages };
}
async function close(pages) {
  for (const p of pages) {
    expect(p.errors, `page errors for ${p.name}`).toEqual([]);
    await p.context.close();
  }
}
const view = (page) => page.evaluate(() => view);
const lastSeq = (page) => page.evaluate(() => view?.game?.log.at(-1)?.seq ?? 0);
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** Taps a fanned card on its exposed corner, like a finger would. */
async function tapCard(page, code) {
  const point = await page.evaluate((code) => {
    const card = document.querySelector(`#hand .hand-card[data-card="${code}"]`);
    const corner = card.querySelector('.card-corner').getBoundingClientRect();
    const p = { x: corner.left + corner.width / 2, y: corner.top + Math.min(10, corner.height / 2) };
    return document.elementFromPoint(p.x, p.y)?.closest('.hand-card') === card ? p : null;
  }, code);
  expect(point, `corner of ${code} must be exposed`).not.toBeNull();
  await page.mouse.click(point.x, point.y);
}
async function select(page, codes) {
  for (const c of codes) await tapCard(page, c);
  expect((await page.evaluate(() => [...selected])).sort()).toEqual([...codes].sort());
}

/** The current player makes the lowest legal single or pair, or passes. Returns false once the game is over. */
async function autoMove(pages) {
  const states = await Promise.all(pages.map((p) => view(p.page)));
  if (states[0].game.phase === 'done') return false;
  const mover = states.findIndex((s) => s.you.seat === s.game.currentSeat);
  const { page } = pages[mover];
  const before = await lastSeq(page);
  await page.evaluate(() => {
    const g = view.game;
    const hand = sortHand(g.hand);
    const tries = hand.map((c) => [c]);
    for (let i = 0; i < hand.length; i++) for (let j = i + 1; j < hand.length; j++) tries.push([hand[i], hand[j]]);
    const legal = tries.filter((cards) => (!g.mustInclude || cards.includes(g.mustInclude)) && classify(cards) && !whyNot(g, cards));
    if (legal.length) send({ type: 'play', cards: legal[0] });
    else send({ type: 'pass' });
  });
  await expect.poll(async () => (await view(page)).game.phase === 'done' || (await lastSeq(page)) > before).toBe(true);
  return true;
}

test('hub lists Tai Di and the lobby needs two players', async ({ browser }) => {
  const hub = await client(browser, 'Hub', { signedIn: false });
  try {
    await hub.page.goto(worker.origin);
    await expect(hub.page.getByRole('link', { name: /Tai Di/ })).toHaveAttribute('href', '/taidi/');
  } finally { await hub.context.close(); }

  const room = await createRoom(2);
  const solo = await client(browser, 'Solo', { room });
  try {
    await expect(solo.page.locator('#lobby-players .player-item.td-player')).toHaveCount(1);
    await expect(solo.page.locator('#btn-start')).toBeDisabled();
    await expect(solo.page.locator('#lobby-wait')).toContainText('at least 2');
    const second = await client(browser, 'Second', { room });
    await expect(solo.page.locator('#btn-start')).toBeEnabled();
    await second.context.close();
  } finally { await close([solo]); }
});

test('signed-out visitors see the login and can only watch', async ({ browser }) => {
  const room = await createRoom(3);
  const guest = await client(browser, 'Guest', { signedIn: false, room });
  try {
    await expect(guest.page.locator('#login-section')).toBeVisible();
    await expect(guest.page.locator('[data-dev-login]')).toBeVisible();
    await expect(guest.page.locator('#game-section')).toBeHidden();
    await guest.page.locator('#input-dev-name').fill('Late Guest');
    await guest.page.locator('[data-dev-login] button').click();
    await expect(guest.page.locator('#screen-lobby')).toHaveClass(/active/);
    await expect(guest.page.locator('#lobby-players .td-player')).toHaveCount(1);
  } finally { await close([guest]); }
});

test('two players: opening card, tapping cards, play and pass by hand', async ({ browser }) => {
  const { room, pages } = await table(browser, 2, { seed: 11 });
  const [a, b] = pages;
  try {
    // Exact hands so every assertion is deterministic.
    await patch(room, {
      hands: [['3D', '4C', '9H', 'KS'], ['3C', '3H', 'JH', '2S']],
      currentSeat: 0, mustInclude: '3D', table: null, passes: 0,
    });
    await expect(a.page.locator('#turn-banner')).toContainText('include the 3♦');
    await expect(b.page.locator('#turn-banner')).toContainText('Waiting for');

    // The opening play must include the lowest card; other plays are explained and not offered.
    await select(a.page, ['4C']);
    await expect(a.page.locator('#preview')).toContainText('must include');
    await expect(a.page.locator('#btn-act')).toBeDisabled();
    await a.page.keyboard.press('Escape');
    await select(a.page, ['3D']);
    await expect(a.page.locator('#preview')).toContainText('Single');
    await a.page.locator('#btn-act').click();

    // The other seat sees the play and only their own hand; a pair can't answer a single.
    await expect(b.page.locator('#table-play .card-mini')).toHaveCount(1);
    await expect(b.page.locator('#table-caption')).toContainText('played a single');
    expect((await view(b.page)).game.hand).toEqual(['3C', '3H', 'JH', '2S']);
    expect((await view(b.page)).game.handCounts).toEqual([3, 4]);
    await expect(b.page.locator('#btn-pass')).toBeEnabled();
    await select(b.page, ['3C', '3H']);
    await expect(b.page.locator('#preview')).toContainText('Play 1 card');
    await expect(b.page.locator('#btn-act')).toBeDisabled();
    await b.page.keyboard.press('Escape');
    await select(b.page, ['3C']);
    await expect(b.page.locator('#preview')).toContainText('Single: 3♣'); // clubs beat diamonds
    await b.page.keyboard.press('Escape');

    // Passing back to the leader clears the table, and a leader can't pass.
    await b.page.locator('#btn-pass').click();
    await expect(a.page.locator('#table-caption')).toContainText('leads');
    await expect(a.page.locator('#btn-pass')).toBeDisabled();
    expect(await noSideScroll(a.page)).toBe(true);

    // Going out ends the game: results, places and a rating change for both.
    await patch(room, { hands: [['KS'], ['3C', '5D']], table: null });
    await select(a.page, ['KS']);
    await a.page.locator('#btn-act').click();
    for (const p of pages) {
      await expect(p.page.locator('#modal-over')).toBeVisible();
      await expect(p.page.locator('#over-results .td-result')).toHaveCount(2);
    }
    await expect(a.page.locator('#over-title')).toContainText('You win');
    await expect(b.page.locator('#over-sub')).toContainText('2nd');
    await expect(a.page.locator('#over-rating')).toBeVisible();
    await expect(a.page.locator('#over-rating .td-rating-row.me b')).toHaveText('+16');
    await expect(b.page.locator('#over-rating .td-rating-row.me b')).toHaveText('-16');

    // Both boards and stats reflect it.
    const board = await (await api('/api/taidi/leaderboard')).json();
    expect(board.top.map((e) => [e.displayName, e.elo])).toEqual([['Ada11', 1016], ['Bea11', 984]]);
    // Play Again returns everyone to the lobby.
    await a.page.locator('#btn-again').click();
    for (const p of pages) await expect(p.page.locator('#screen-lobby')).toHaveClass(/active/);
  } finally { await close(pages); }
});

test.describe('full games', () => {
  for (const n of [2, 3, 4]) {
    test(`${n} players: hidden hands, spectator, reload, play to a finish and rate`, async ({ browser }) => {
      const { room, pages } = await table(browser, n, { seed: 20 + n, mobile: [n - 1] });
      const spectator = await client(browser, 'Watcher', { room });
      try {
        const first = await view(pages[0].page);
        const dealt = { 2: 17, 3: 17, 4: 13 }[n];
        expect(first.game.handCounts.reduce((a, c) => a + c, 0)).toBe(dealt * n + (n === 3 ? 1 : 0));

        // Everyone sees only their own cards; the spectator sees none and cannot act.
        for (let i = 0; i < n; i++) {
          const v = await view(pages[i].page);
          expect(v.you.seat).toBe(i);
          expect(v.game.hand).toHaveLength(v.game.handCounts[i]);
          expect(JSON.stringify(v)).not.toContain(JSON.stringify((await view(pages[(i + 1) % n].page)).game.hand));
        }
        await expect(spectator.page.locator('#screen-game')).toHaveClass(/active/);
        expect((await view(spectator.page)).game.hand).toBeNull();
        await expect(spectator.page.locator('#hand')).toContainText('watching');
        await expect(spectator.page.locator('#action-bar')).toBeHidden();

        // The opener holds the lowest card; reloading mid-game keeps the seat, hand and turn.
        const opener = first.game.currentSeat;
        expect(first.game.hand === null).toBe(false);
        for (let i = 0; i < 3; i++) await autoMove(pages);
        const reloading = pages[n - 1].page;
        const handBefore = (await view(reloading)).game.hand;
        await reloading.reload();
        await expect(reloading.locator('#screen-game')).toHaveClass(/active/);
        await expect.poll(async () => (await view(reloading))?.game?.hand ?? null).toEqual(handBefore);
        expect((await view(reloading)).you.seat).toBe(n - 1);
        expect(opener).toBeGreaterThanOrEqual(0);

        // Play it out.
        for (let guard = 0; guard < 600; guard++) if (!await autoMove(pages)) break;
        for (const p of [...pages, spectator]) {
          await expect(p.page.locator('#modal-over')).toBeVisible();
          const g = (await view(p.page)).game;
          expect(g.phase).toBe('done');
          expect(g.placements.filter((x) => x === 1)).toHaveLength(1);
          expect(g.handCounts[g.winner]).toBe(0);
        }
        await expect(pages[0].page.locator('#over-rating')).toBeVisible();
        const changes = (await view(pages[0].page)).lastRating.changes;
        expect(changes).toHaveLength(n);
        expect(changes.filter((c) => c.place === 1)[0].delta).toBeGreaterThan(0);
        expect(changes.map((c) => c.delta).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(n);
        for (const p of pages) expect(await noSideScroll(p.page)).toBe(true);
      } finally { await close([...pages, spectator]); }
    });
  }
});

test('a game ended early by the host is not rated', async ({ browser }) => {
  const { room, pages } = await table(browser, 2, { seed: 31 });
  const [host, other] = pages;
  try {
    await expect(other.page.locator('#btn-end')).toBeHidden();
    await expect(host.page.locator('#btn-end')).toBeVisible();
    await host.page.locator('#btn-end').click();
    await host.page.locator('#confirm-ok').click();
    for (const p of pages) await expect(p.page.locator('#screen-lobby')).toHaveClass(/active/);
    expect((await (await api('/api/taidi/leaderboard')).json()).top.some((e) => e.displayName.endsWith('31'))).toBe(false);
    expect(room).toMatch(/^[A-Z0-9]{4}$/);
  } finally { await close(pages); }
});

test('rooms are full at four and late joiners can watch', async ({ browser }) => {
  const { room, pages } = await table(browser, 4, { seed: 41 });
  const late = await client(browser, 'Late41', { room });
  try {
    await expect(late.page.locator('#screen-game')).toHaveClass(/active/);
    const v = await view(late.page);
    expect(v.you.seat).toBe(-1);
    expect(v.game.hand).toBeNull();
    expect(v.players).toHaveLength(4);
  } finally { await close([...pages, late]); }
});
