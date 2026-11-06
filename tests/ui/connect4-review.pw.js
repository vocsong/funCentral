// Review smoke + controlled network/socket chaos, using the real local Worker,
// D1 and browser WebSockets. No patched board is used for completed games.
const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
let worker;
test.beforeAll(async () => { worker = await startWorker(4242); });
test.afterAll(async () => { await worker?.stop(); });
const state = (page) => page.evaluate(() => view);
async function client(browser, name, room, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort());
  const auth = await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName: name }) }).then((r) => r.json());
  await page.addInitScript((token) => localStorage.setItem('authToken', token), auth.token);
  await page.goto(`${worker.origin}/connect4/#${room}`);
  await expect.poll(async () => (await state(page))?.you.seat).toBeGreaterThanOrEqual(0);
  return { context, page, errors, mobile };
}
async function match(browser, mobile, bot = false) {
  const { roomCode } = await fetch(`${worker.origin}/api/connect4/create`, { method: 'POST' }).then((r) => r.json());
  const host = await client(browser, 'Alice Review', roomCode, mobile);
  const clients = [host];
  if (bot) await host.page.locator('#btn-add-bot').click();
  else clients.push(await client(browser, 'Bob Review', roomCode));
  await expect(host.page.locator('#lobby-players .c4-player')).toHaveCount(2);
  return { roomCode, clients, host };
}
async function close(clients) {
  for (const client of clients) { expect(client.errors).toEqual([]); await client.context.close(); }
}
async function start(host) {
  await host.page.locator('#btn-start')[host.mobile ? 'tap' : 'click']();
  await expect(host.page.locator('#screen-game')).toHaveClass(/active/);
}
async function finishHumans(clients, { reconnect = false } = {}) {
  const host = clients[0].page;
  const opener = (await state(host)).game.currentSeat;
  for (let move = 0; move < 7; move++) {
    const seat = move % 2 ? 1 - opener : opener;
    const actor = clients[seat];
    const button = actor.page.getByRole('button', { name: `Drop in column ${move % 2 + 1}`, exact: true });
    await expect(button).toBeEnabled({ timeout: 10000 });
    await button[actor.mobile ? 'tap' : 'click']();
    await expect.poll(async () => (await state(host)).game.moveCount).toBe(move + 1);
    if (reconnect && move === 2) {
      const gameId = (await state(host)).gameId;
      await clients[1].context.setOffline(true);
      await host.evaluate(() => { for (const payload of ['null', '[]', '42', '{}', 'not json']) ws.send(payload); });
      // Reload creates a real replacement socket; a JS close() alone can sit
      // in the browser's CLOSING handshake without simulating a network loss.
      await host.reload();
      await expect.poll(async () => (await state(host))?.gameId).toBe(gameId);
      await expect.poll(async () => (await state(host))?.game.moveCount).toBe(3);
      await clients[1].context.setOffline(false);
      await clients[1].page.reload();
      await expect.poll(async () => (await state(clients[1].page))?.gameId).toBe(gameId);
      await expect.poll(async () => clients[1].page.evaluate(() => ws?.readyState)).toBe(1);
      await expect.poll(async () => host.evaluate(() => ws?.readyState)).toBe(1);
      expect((await state(clients[1].page)).game.moveCount).toBe(3);
    }
  }
  for (const client of clients) await expect(client.page.locator('#modal-over')).toBeVisible();
}
async function trap(page, id) {
  const modal = page.locator(`#${id}`);
  await expect(modal).toBeVisible();
  const focusables = modal.locator('button:visible');
  const first = focusables.first(), last = focusables.last();
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate((id) => document.getElementById(id).contains(document.activeElement), id)).toBe(true);
  }
  await page.locator('#btn-leave').evaluate((node) => node.focus());
  await expect.poll(() => page.evaluate((id) => document.getElementById(id).contains(document.activeElement), id)).toBe(true);
  expect(await page.locator('#top-bar').evaluate((node) => node.inert)).toBe(true);
}

for (const mobile of [false, true]) {
  test(`same player and both humans can dismiss results, reconnect and rematch (${mobile ? 'mobile' : 'desktop'})`, async ({ browser }) => {
    test.setTimeout(60000);
    const { clients, host } = await match(browser, mobile);
    try {
      await start(host);
      await host.page.locator('#btn-rules').click();
      await trap(host.page, 'modal-rules');
      await host.page.keyboard.press('Escape');
      await expect(host.page.locator('#btn-rules')).toBeFocused();
      await host.page.locator('#btn-leave').click();
      await trap(host.page, 'modal-confirm');
      await host.page.keyboard.press('Escape');
      await expect(host.page.locator('#btn-leave')).toBeFocused();
      await finishHumans(clients, { reconnect: true });
      await trap(host.page, 'modal-over');
      const gameId = (await state(host.page)).gameId;
      for (const actor of clients) await actor.page.locator('#btn-over-close').click();
      await expect(host.page.getByRole('button', { name: 'View results', exact: true })).toBeFocused();
      for (const actor of clients) await expect(actor.page.locator('#modal-over')).toBeHidden();
      // A reload must not be required to escape a finished board, but must work too.
      await host.page.reload();
      await expect(host.page.locator('#modal-over')).toBeVisible();
      await host.page.locator('#btn-over-close').click();
      await host.page.getByRole('button', { name: 'View results', exact: true }).click();
      await expect(host.page.locator('#btn-again')).toBeFocused();
      await host.page.locator('#btn-again').click();
      for (const actor of clients) await expect(actor.page.locator('#screen-lobby')).toHaveClass(/active/);
      await expect.poll(async () => await worker.db.prepare('SELECT COUNT(*) AS n FROM connect4_games WHERE game_id = ?').bind(gameId).first('n')).toBe(1);
      await start(host);
      await expect(host.page.locator('#c4-cells .c4-cell.red, #c4-cells .c4-cell.yellow')).toHaveCount(0);
      expect((await state(host.page)).gameId).not.toBe(gameId);
    } finally { await close(clients); }
  });
}

for (const [choice, colours] of [[0, ['Red', 'Yellow']], [1, ['Rose', 'Cyan']], [2, ['Violet', 'Mint']]]) {
  test(`accessible board exposes empty cells and chosen ${colours.join('/')} contents, without 42 tab stops`, async ({ browser }) => {
    const { clients, host } = await match(browser, false);
    try {
      for (const [seat, actor] of clients.entries()) {
        await actor.page.getByRole('button', { name: `${colours[seat]} discs`, exact: true }).click();
        await expect(actor.page.getByRole('button', { name: `${colours[seat]} discs`, exact: true })).toHaveAttribute('aria-pressed', 'true');
      }
      await start(host);
      await expect(host.page.getByRole('img', { name: 'Row 1, column 1: empty', exact: true })).toBeVisible();
      expect(await host.page.locator('#c4-cells [tabindex]').count()).toBe(0);
      for (let move = 0; move < 2; move++) {
        const seat = (await state(host.page)).game.currentSeat;
        const actor = clients[seat];
        const button = actor.page.getByRole('button', { name: `Drop in column ${seat + 1}`, exact: true });
        await expect(button).toBeEnabled({ timeout: 10000 });
        await button.click();
        await expect(host.page.getByRole('img', { name: `Row 6, column ${seat + 1}: ${seat === 0 ? 'Alice Review' : 'Bob Review'}'s ${colours[seat]} disc`, exact: true })).toBeVisible();
      }
      await expect(host.page.locator('#c4-cells').getByRole('img')).toHaveCount(42);
      // Verify labels reach Chromium's accessibility tree, not just attributes.
      const cdp = await host.context.newCDPSession(host.page);
      const tree = await cdp.send('Accessibility.getFullAXTree');
      const names = tree.nodes.filter((n) => !n.ignored && n.role?.value === 'image').map((n) => n.name?.value);
      expect(names).toContain(`Row 6, column 1: Alice Review's ${colours[0]} disc`);
      expect(names).toContain(`Row 6, column 2: Bob Review's ${colours[1]} disc`);
      await cdp.detach();
    } finally { await close(clients); }
  });
}

for (const action of ['rematch', 'leave after completion']) test(`practice bot: complete a real game, then ${action} with no other human`, async ({ browser }) => {
  test.setTimeout(120000);
  const { clients, host, roomCode } = await match(browser, true, true);
  try {
    await start(host);
    let humanDrops = 0;
    // A deterministic human strategy; every bot turn is executed by the room alarm.
    while (!(await state(host.page)).game || (await state(host.page)).game.phase !== 'done') {
      const view = await state(host.page);
      if (view.game?.phase === 'done') break;
      if (view.game?.currentSeat !== view.you.seat || await host.page.locator('.c4-drop:enabled').count() === 0) {
        await host.page.waitForTimeout(100);
        continue;
      }
      const col = [3, 2, 4, 1, 5, 0, 6].find((col) => view.game.legalCols.includes(col));
      await host.page.locator(`.c4-drop[data-col="${col}"]`).tap();
      humanDrops++;
      await expect.poll(async () => (await state(host.page)).game.moveCount).toBeGreaterThan(view.game.moveCount);
      expect(humanDrops).toBeLessThanOrEqual(22);
    }
    await expect(host.page.locator('#modal-over')).toBeVisible();
    const finishedId = (await state(host.page)).gameId;
    await host.page.locator('#btn-over-close').tap();
    if (action === 'rematch') {
      await host.page.getByRole('button', { name: 'View results', exact: true }).tap();
      await host.page.locator('#btn-again').tap();
      await expect(host.page.locator('#screen-lobby')).toHaveClass(/active/);
      await start(host);
      expect((await state(host.page)).gameId).not.toBe(finishedId);
    } else {
      await host.page.locator('#btn-leave').tap();
      await expect(host.page.locator('#screen-home')).toHaveClass(/active/);
      const next = await client(browser, 'Next Human', roomCode, true);
      clients.push(next);
      await expect.poll(async () => (await state(next.page)).you.isHost).toBe(true);
      await next.page.reload();
      await expect.poll(async () => (await state(next.page))?.you.isHost).toBe(true);
      await next.page.locator('#btn-add-bot').tap();
      await expect(next.page.getByRole('button', { name: 'Remove Bot', exact: true })).toBeVisible();
      await next.page.getByRole('button', { name: 'Remove Bot', exact: true }).tap();
      await expect(next.page.locator('#lobby-players .c4-player')).toHaveCount(1);
      await next.page.locator('#btn-add-bot').tap();
      await start(next);
    }
    expect(await worker.db.prepare('SELECT COUNT(*) AS n FROM connect4_games WHERE game_id = ?').bind(finishedId).first('n')).toBe(0);
  } finally { await close(clients); }
});
