// A result may arrive while a spectator/opponent is reading rules. Test the
// real nested-dialog path rather than just opening a dialog in an idle fixture.
const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
let worker;
test.beforeAll(async () => { worker = await startWorker(4243); });
test.afterAll(async () => { await worker?.stop(); });

test('a winning result above an open rules modal traps focus and restores each layer', async ({ browser }) => {
  test.setTimeout(45000);
  const room = await fetch(`${worker.origin}/api/connect4/create`, { method: 'POST' }).then((r) => r.json());
  const contexts = [];
  const pages = [];
  try {
    for (const name of ['Modal Host', 'Modal Guest']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      const auth = await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName: name }) }).then((r) => r.json());
      await page.addInitScript((token) => localStorage.setItem('authToken', token), auth.token);
      await page.route('**/*', (route) => new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort());
      await page.goto(`${worker.origin}/connect4/#${room.roomCode}`);
      await expect.poll(() => page.evaluate(() => view?.you.seat)).toBe(pages.length - 1);
    }
    const [host, guest] = pages;
    await host.locator('#btn-start').tap();
    await expect(host.locator('#screen-game')).toHaveClass(/active/);
    const opener = await host.evaluate(() => view.game.currentSeat);
    const moves = opener === 1 ? 7 : 8; // guest always wins; host can keep rules open
    for (let i = 0; i < moves; i++) {
      const seat = (opener + i) % 2;
      if (i === moves - 1) {
        await host.locator('#btn-rules').tap();
        await expect(host.locator('#modal-rules')).toBeVisible();
      }
      // Spread the host's discs so the host cannot win before the guest.
      const col = seat === 1 ? 1 : (Math.floor(i / 2) % 2 ? 2 : 0);
      const button = pages[seat].locator(`.c4-drop[data-col="${col}"]`);
      await expect(button).toBeEnabled({ timeout: 10000 });
      await button.tap();
      await expect.poll(() => host.evaluate(() => view.game.moveCount)).toBe(i + 1);
    }
    await expect(host.locator('#modal-over')).toBeVisible();
    await expect(host.locator('#btn-again')).toBeFocused();
    expect(await host.locator('#modal-rules').evaluate((node) => node.inert)).toBe(true);
    await host.keyboard.press('Shift+Tab');
    await expect(host.locator('#btn-over-close')).toBeFocused();
    await host.keyboard.press('Tab');
    await expect(host.locator('#btn-again')).toBeFocused();
    await host.locator('#btn-over-close').tap();
    await expect(host.locator('#modal-rules [data-close]')).toBeFocused();
    expect(await host.locator('#modal-rules').evaluate((node) => node.inert)).toBe(false);
    await host.keyboard.press('Escape');
    await expect(host.locator('#btn-rules')).toBeFocused();
    expect(await host.locator('#top-bar').evaluate((node) => node.inert)).toBe(false);
    await host.getByRole('button', { name: 'View results', exact: true }).tap();
    // Either player can return everyone to the lobby. The seated non-host
    // has no Start Game or Take a Seat button to receive restored focus.
    await guest.locator('#btn-again').tap();
    await expect(host.locator('#screen-lobby')).toHaveClass(/active/);
    await expect(guest.locator('#screen-lobby')).toHaveClass(/active/);
    await expect(host.locator('#btn-start')).toBeFocused();
    await expect(guest.locator('#btn-rules-lobby')).toBeFocused();
  } finally { for (const context of contexts) await context.close(); }
});
