// Real local Worker, rooms and D1: responsive Connect 4 geometry and UI controls.
const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
let worker;
test.beforeAll(async () => { worker = await startWorker(4224); });
test.afterAll(async () => { await worker?.stop(); });

async function client(browser, name, viewport, room) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 900, isMobile: viewport.width < 900 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === worker.origin ? route.continue() : route.abort());
  const response = await fetch(`${worker.origin}/api/auth/dev`, { method: 'POST', body: JSON.stringify({ displayName: name }) });
  expect(response.ok).toBe(true);
  const { token } = await response.json();
  await page.addInitScript(token => localStorage.setItem('authToken', token), token);
  await page.goto(`${worker.origin}/connect4/${room ? `#${room}` : ''}`);
  return { context, page, errors };
}

async function roomWithPlayers(browser, viewport) {
  const response = await fetch(`${worker.origin}/api/connect4/create`, { method: 'POST' });
  expect(response.ok).toBe(true);
  const { roomCode } = await response.json();
  const host = await client(browser, 'Alexandria'.repeat(6), viewport, roomCode);
  const guest = await client(browser, 'Christopher'.repeat(5), viewport, roomCode);
  await expect(host.page.locator('.c4-player')).toHaveCount(2);
  return { roomCode, host, guest };
}

async function close(...clients) {
  for (const client of clients) {
    expect(client.errors).toEqual([]);
    await client.context.close();
  }
}

async function expectContained(page, selectors) {
  const violations = await page.evaluate(selectors => {
    const failures = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const r = element.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.left < -1 || r.right > innerWidth + 1) failures.push(`${selector} outside viewport: ${r.left}..${r.right}`);
        if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible') failures.push(`${selector} has overflowing content`);
      }
    }
    return failures;
  }, selectors);
  expect(violations).toEqual([]);
}

for (const viewport of [
  { width: 320, height: 740 }, { width: 360, height: 640 },
  { width: 390, height: 844 }, { width: 520, height: 740 },
  { width: 768, height: 1024 }, { width: 844, height: 390 },
  { width: 979, height: 900 }, { width: 980, height: 900 },
  { width: 1024, height: 768 }, { width: 1366, height: 900 },
]) {
  test(`board, open log and player plates fit at ${viewport.width}×${viewport.height}`, async ({ browser }) => {
    const { host, guest } = await roomWithPlayers(browser, viewport);
    try {
      await host.page.locator('#btn-start').click();
      await expect(host.page.locator('#screen-game')).toHaveClass(/active/);
      const openingSeat = await host.page.evaluate(() => view.game.currentSeat);
      const [first, second] = openingSeat === 0 ? [host, guest] : [guest, host];
      const method = viewport.width < 900 ? 'tap' : 'click';
      await first.page.locator('.c4-drop[data-col="0"]')[method]();
      await second.page.locator('.c4-drop[data-col="1"]')[method]();
      await expect(host.page.locator('#log li')).toHaveCount(2);
      const summary = host.page.locator('#log-details summary');
      if (await host.page.locator('#log-details').evaluate(details => details.open)) await summary.click();
      const before = await host.page.locator('.c4-frame').evaluate(frame => frame.offsetTop);
      await summary.click();
      await expect(host.page.locator('#log-details')).toHaveAttribute('open', '');
      await expectContained(host.page, ['.c4-game', '.c4-table', '.c4-side', '.c4-frame', '.c4-players', '.c4-plate', '.c4-log', '.c4-log li', '.top-bar']);
      const geometry = await host.page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const board = rect('.c4-frame'), log = rect('.c4-log'), table = rect('.c4-table');
        const cells = [...document.querySelectorAll('.c4-cell')].map(cell => cell.getBoundingClientRect());
        return {
          separate: board.right <= log.left || log.right <= board.left || board.bottom <= log.top || log.bottom <= board.top,
          contained: board.left >= table.left - 1 && board.right <= table.right + 1,
          circular: cells.every(cell => Math.abs(cell.width - cell.height) < 1),
          allInside: cells.every(cell => cell.left > board.left && cell.right < board.right && cell.bottom < board.bottom),
          controlsClear: [...document.querySelectorAll('.top-bar button:not(.hidden)')].every(button => {
            const r = button.getBoundingClientRect();
            return r.left >= 0 && r.right <= innerWidth && r.top >= 0;
          }),
        };
      });
      expect(geometry).toEqual({ separate: true, contained: true, circular: true, allInside: true, controlsClear: true });
      const after = await host.page.locator('.c4-frame').evaluate(frame => frame.offsetTop);
      expect(Math.abs(after - before)).toBeLessThan(1);
      await host.page.screenshot({ path: test.info().outputPath('game-open-log.png'), fullPage: true });
      await summary.click();
      await first.page.locator('.c4-drop[data-col="6"]')[method]();
      await expect(guest.page.locator('#log li')).toHaveCount(3);
      // Expanding a log or resizing must not reset the live board.
      await host.page.setViewportSize({ width: viewport.width < 980 ? 1366 : 390, height: 900 });
      await expectContained(host.page, ['.c4-game', '.c4-frame', '.c4-side', '.c4-plate']);
      await expect(host.page.locator(`.c4-cell.${openingSeat === 0 ? 'red' : 'yellow'}`)).toHaveCount(2);
    } finally { await close(host, guest); }
  });
}

test('narrow home and lobby controls align; rules and results stay inside the viewport', async ({ browser }) => {
  const viewport = { width: 320, height: 740 };
  const home = await client(browser, 'Layout Home', viewport);
  let host, guest;
  try {
    await expect(home.page.locator('#game-section')).toBeVisible();
    await expectContained(home.page, ['.c4-home', '.c4-join-row', '.c4-join-row input', '.c4-home-links']);
    const input = await home.page.locator('#input-code').boundingBox();
    const join = await home.page.locator('#btn-join').boundingBox();
    expect(input.width).toBeGreaterThan(100);
    expect(Math.abs(input.height - join.height)).toBeLessThan(1);
    expect(Math.abs(input.y - join.y)).toBeLessThan(1);
    ({ host, guest } = await roomWithPlayers(browser, viewport));
    await expectContained(host.page, ['.c4-lobby', '.room-code-display', '.c4-player', '.lobby-identity', '.lobby-meta', '.lobby-action']);
    await expect(host.page.locator('#btn-start')).toBeEnabled();
    await host.page.locator('#btn-rules-lobby').click();
    await expect(host.page.locator('#modal-rules')).toBeVisible();
    await expectContained(host.page, ['.c4-rules']);
    await host.page.locator('#modal-rules [data-close]').click();
    await host.page.locator('#btn-start').click();
    await expect(host.page.locator('#screen-game')).toHaveClass(/active/);
    const openingSeat = await host.page.evaluate(() => view.game.currentSeat);
    const [first, second] = openingSeat === 0 ? [host, guest] : [guest, host];
    for (let move = 0; move < 7; move++) {
      const current = move % 2 ? second : first;
      await current.page.locator(`.c4-drop[data-col="${move % 2}"]`).tap();
      await expect(host.page.locator('#log li')).toHaveCount(move === 6 ? 8 : move + 1);
    }
    await expect(host.page.locator('#modal-over')).toBeVisible();
    await expectContained(host.page, ['#modal-over .c4-modal-box', '.c4-result', '.c4-rating-row', '.gameover-actions']);
    await host.page.locator('#btn-over-close').click();
    await expect(host.page.locator('.c4-cell.win')).toHaveCount(4);
    await expect(host.page.locator('.c4-drop:enabled')).toHaveCount(0);
    await guest.page.locator('#btn-again').click();
    await expect(host.page.locator('#screen-lobby')).toHaveClass(/active/);
    await host.page.locator('#btn-start').click();
    await expect(host.page.locator('#screen-game')).toHaveClass(/active/);
    expect(await host.page.evaluate(() => view.game.currentSeat)).toBe(1 - openingSeat);
    await expect(second.page.locator('.c4-drop:enabled')).toHaveCount(7);
    await expect(first.page.locator('.c4-drop:enabled')).toHaveCount(0);
  } finally { await close(home, ...[host, guest].filter(Boolean)); }
});

for (const viewport of [{ width: 320, height: 740 }, { width: 1366, height: 900 }]) {
  test(`bot and host badges match without highlighting at ${viewport.width}px`, async ({ browser }) => {
    const response = await fetch(`${worker.origin}/api/connect4/create`, { method: 'POST' });
    const { roomCode } = await response.json();
    const host = await client(browser, 'Practice Host', viewport, roomCode);
    try {
      await host.page.locator('#btn-add-bot').click();
      await expect(host.page.locator('.c4-bot')).toBeVisible();
      const styles = await host.page.evaluate(() => {
        const bot = getComputedStyle(document.querySelector('.c4-bot'));
        const host = getComputedStyle(document.querySelector('.c4-host'));
        return { botFont: bot.fontSize, hostFont: host.fontSize, background: bot.backgroundColor, padding: bot.padding, hostPadding: host.padding };
      });
      expect(styles.botFont).toBe(styles.hostFont);
      expect(styles.padding).toBe(styles.hostPadding);
      expect(styles.background).toBe('rgba(0, 0, 0, 0)');
      await expectContained(host.page, ['.c4-player', '.lobby-meta', '.lobby-action']);
    } finally { await close(host); }
  });
}

for (const viewport of [{ width: 320, height: 740 }, { width: 1366, height: 900 }]) {
  test(`separate three-colour palettes stay synced from lobby to results at ${viewport.width}px`, async ({ browser }) => {
    const { roomCode, host, guest } = await roomWithPlayers(browser, viewport);
    let watcher;
    const palette = page => page.evaluate(() => [
      document.body.style.getPropertyValue('--c4-red'),
      document.body.style.getPropertyValue('--c4-yellow'),
    ]);
    try {
      await expect(host.page.locator('.c4-colour-option')).toHaveCount(3);
      await expect(guest.page.locator('.c4-colour-option')).toHaveCount(3);
      await expect(host.page.locator('.c4-colour-option')).toHaveText(['Red', 'Rose', 'Violet']);
      await expect(guest.page.locator('.c4-colour-option')).toHaveText(['Yellow', 'Cyan', 'Mint']);
      for (let left = 0; left < 3; left++) {
        await host.page.locator(`.c4-colour-option[data-colour="${left}"]`).click();
        await expect(host.page.locator(`.c4-colour-option[data-colour="${left}"]`)).toHaveAttribute('aria-pressed', 'true');
        for (let right = 0; right < 3; right++) {
          await guest.page.locator(`.c4-colour-option[data-colour="${right}"]`).click();
          await expect(guest.page.locator(`.c4-colour-option[data-colour="${right}"]`)).toHaveAttribute('aria-pressed', 'true');
          const colours = await palette(guest.page);
          await expect.poll(() => palette(host.page)).toEqual(colours);
          expect(colours[0]).not.toBe(colours[1]);
        }
      }
      // Native buttons also support keyboard selection, with focus retained after acknowledgement.
      const violet = host.page.getByRole('button', { name: 'Violet discs' });
      await violet.focus();
      await host.page.keyboard.press('Enter');
      await expect(violet).toBeFocused();
      await expectContained(host.page, ['.c4-lobby', '.c4-colour-picker', '.c4-colour-option']);
      await host.page.screenshot({ path: test.info().outputPath('colour-lobby.png'), fullPage: true });
      await guest.page.reload();
      await expect(guest.page.getByRole('button', { name: 'Mint discs' })).toHaveAttribute('aria-pressed', 'true');
      watcher = await client(browser, 'Colour Watcher', viewport, roomCode);
      await expect.poll(() => watcher.page.evaluate(() => view?.players.length)).toBe(2);
      await expect(watcher.page.locator('#lobby-colours')).toBeHidden();
      await expect.poll(() => palette(watcher.page)).toEqual(['#a879f5', '#46d5a0']);
      await host.page.locator('#btn-start').click();
      await expect(host.page.locator('#screen-game')).toHaveClass(/active/);
      const openingSeat = await host.page.evaluate(() => view.game.currentSeat);
      const [first, second] = openingSeat === 0 ? [host, guest] : [guest, host];
      await expect(host.page.locator('.c4-plate-sub')).toHaveText(['Violet', 'Mint']);
      for (let move = 0; move < 7; move++) {
        await (move % 2 ? second : first).page.locator(`.c4-drop[data-col="${move % 2}"]`).click();
        await expect(host.page.locator('#log li')).toHaveCount(move === 6 ? 8 : move + 1);
      }
      await expect(host.page.locator('#modal-over')).toBeVisible();
      const gradients = await host.page.evaluate(() => ['red', 'yellow'].map(disc => {
        const image = selector => getComputedStyle(document.querySelector(selector)).backgroundImage;
        return [image(`.c4-cell.${disc}`), image(`.c4-disc-dot.${disc}`), image(`.c4-result-disc.${disc}`)];
      }));
      for (const [board, plate, result] of gradients) {
        expect(board).not.toBe('none');
        expect(plate).toBe(board);
        expect(result).toBe(board);
      }
      await expect.poll(() => palette(watcher.page)).toEqual(await palette(host.page));
      await host.page.screenshot({ path: test.info().outputPath('colour-results.png'), fullPage: true });
      await host.page.locator('#btn-again').click();
      await expect(host.page.getByRole('button', { name: 'Violet discs' })).toHaveAttribute('aria-pressed', 'true');
      await expect(guest.page.getByRole('button', { name: 'Mint discs' })).toHaveAttribute('aria-pressed', 'true');
    } finally { await close(host, guest, ...[watcher].filter(Boolean)); }
  });
}

for (const { viewport, reducedMotion } of [
  { viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' },
  { viewport: { width: 1366, height: 900 }, reducedMotion: 'no-preference' },
  { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' },
]) {
  test(`opening border reveals the real starter at ${viewport.width}px with motion ${reducedMotion}`, async ({ browser }) => {
    const { host, guest } = await roomWithPlayers(browser, viewport);
    try {
      await Promise.all([host, guest].map(client => client.page.emulateMedia({ reducedMotion })));
      // Latch the brief settled state: Playwright's default backoff can skip a
      // 500ms hold entirely, even when the animation rendered correctly.
      await host.page.evaluate(() => {
        window.observedOpeningSeats = [];
        new MutationObserver(() => {
          const plate = document.querySelector('.opening-settled');
          if (plate) window.observedOpeningSeats.push(Number(plate.dataset.seat));
        }).observe(document.querySelector('#c4-players'), { subtree: true, attributes: true, childList: true, attributeFilter: ['class'] });
      });
      await host.page.locator('#btn-start').click();
      await expect(host.page.locator('#c4-game')).toHaveClass(/opening/);
      await expect(guest.page.locator('#c4-game')).toHaveClass(/opening/);
      const { opener, opensAt } = await host.page.evaluate(() => ({ opener: view.game.currentSeat, opensAt: view.game.opensAt }));
      const deadline = await host.page.evaluate(() => openingReveal.deadline);
      expect(await guest.page.evaluate(() => view.game.opensAt)).toBe(opensAt);
      await expect(host.page.locator('.c4-drop:enabled')).toHaveCount(0);
      await expect(guest.page.locator('.c4-drop:enabled')).toHaveCount(0);
      await expect(host.page.locator('.c4-plate.active')).toHaveCount(0);
      if (reducedMotion === 'reduce') {
        await expect(host.page.locator('.opening-settled')).toHaveAttribute('data-seat', String(opener));
        await expect(host.page.locator('#c4-turn')).toContainText(/go(es)? first/);
      } else {
        const seen = new Set();
        await expect.poll(async () => {
          const seat = await host.page.locator('.opening-pick').getAttribute('data-seat');
          seen.add(seat);
          return seen.size;
        }, { intervals: [50, 50, 50], timeout: 1200 }).toBe(2);
      }
      // Reloading one player broadcasts presence to the other. Neither may reroll
      // the opener or restart the server's reveal window.
      await guest.page.reload();
      await expect(guest.page.locator('#screen-game')).toHaveClass(/active/);
      expect(await guest.page.evaluate(() => view.game.opensAt)).toBe(opensAt);
      expect(await host.page.evaluate(() => openingReveal.deadline)).toBe(deadline);
      await expect.poll(() => host.page.evaluate(() => window.observedOpeningSeats)).toContain(opener);
      expect(await host.page.evaluate(() => window.observedOpeningSeats.every(seat => seat === view.game.currentSeat))).toBe(true);
      await expectContained(host.page, ['.c4-players', '.c4-plate', '.c4-frame']);
      await expect(host.page.locator('#c4-game')).not.toHaveClass(/opening/);
      await expect(guest.page.locator('#c4-game')).not.toHaveClass(/opening/);
      await expect(host.page.locator('.c4-plate.active')).toHaveAttribute('data-seat', String(opener));
      const [first, second] = opener === 0 ? [host, guest] : [guest, host];
      await expect(first.page.locator('.c4-drop:enabled')).toHaveCount(7);
      await expect(second.page.locator('.c4-drop:enabled')).toHaveCount(0);
      await first.page.locator('.c4-drop[data-col="3"]').click();
      await expect(host.page.locator('#log li')).toHaveCount(1);
      await guest.page.reload();
      await expect(guest.page.locator('#screen-game')).toHaveClass(/active/);
      await expect(guest.page.locator('#c4-game')).not.toHaveClass(/opening/);
      await expect(guest.page.locator('.c4-cell.red, .c4-cell.yellow')).toHaveCount(1);
    } finally { await close(host, guest); }
  });
}

for (const mode of ['muted', 'enabled', 'mute during shuffle']) {
  test(`opening shuffle audio respects ${mode}`, async ({ browser }) => {
    const { host, guest } = await roomWithPlayers(browser, { width: 390, height: 844 });
    try {
      await host.page.evaluate(() => {
        window.openingAudio = { shuffle: 0, tones: 0 };
        const Context = window.AudioContext || window.webkitAudioContext;
        for (const [factory, counter] of [['createBufferSource', 'shuffle'], ['createOscillator', 'tones']]) {
          const original = Context.prototype[factory];
          Context.prototype[factory] = function (...args) {
            const source = original.apply(this, args);
            const start = source.start.bind(source);
            source.start = (...args) => { window.openingAudio[counter]++; return start(...args); };
            return source;
          };
        }
      });
      if (mode !== 'muted') await host.page.locator('#btn-sound').click();
      // Exclude the existing toggle-confirmation tones from reveal counts.
      await host.page.evaluate(() => { window.openingAudio = { shuffle: 0, tones: 0 }; });
      await host.page.locator('#btn-start').click();
      await expect(host.page.locator('#c4-game')).toHaveClass(/opening/);
      if (mode !== 'muted') {
        await expect.poll(() => host.page.evaluate(() => window.openingAudio.shuffle)).toBeGreaterThan(0);
        const duplicates = await host.page.evaluate(() => {
          const before = window.openingAudio.shuffle;
          for (let i = 0; i < 5; i++) renderPlayers(view.game);
          return window.openingAudio.shuffle - before;
        });
        expect(duplicates).toBe(0);
      }
      let mutedAt;
      if (mode === 'mute during shuffle') {
        await host.page.locator('#btn-sound').click();
        await expect(host.page.locator('#btn-sound')).toHaveAttribute('aria-pressed', 'false');
        mutedAt = await host.page.evaluate(() => ({ ...window.openingAudio }));
      }
      await expect(host.page.locator('#c4-game')).not.toHaveClass(/opening/);
      const audio = await host.page.evaluate(() => window.openingAudio);
      if (mode === 'muted') expect(audio).toEqual({ shuffle: 0, tones: 0 });
      else if (mode === 'mute during shuffle') expect(audio).toEqual(mutedAt);
      else {
        expect(audio.shuffle).toBeGreaterThan(1);
        expect(audio.shuffle).toBeLessThanOrEqual(7);
        expect(audio.tones).toBe(2); // one soft two-note settle cue
      }
    } finally { await close(host, guest); }
  });
}

test('no early-end control exists, forged resets fail, and leaving preserves the active round', async ({ browser }) => {
  const { roomCode, host, guest } = await roomWithPlayers(browser, { width: 390, height: 844 });
  try {
    await host.page.locator('#btn-start').click();
    await expect(host.page.locator('#screen-game')).toHaveClass(/active/);
    await expect(host.page.locator('#btn-end')).toHaveCount(0);
    await expect(guest.page.locator('#btn-end')).toHaveCount(0);
    const gameId = await host.page.evaluate(() => view.gameId);
    await host.page.evaluate(() => send({ type: 'backToLobby' }));
    await expect(host.page.locator('.c4-toast.error')).toContainText('Finish the round');
    await expect(host.page.locator('#screen-game')).toHaveClass(/active/);
    expect(await host.page.evaluate(() => view.gameId)).toBe(gameId);
    await host.page.locator('#btn-leave').click();
    await expect(host.page.locator('#modal-confirm')).toBeVisible();
    await host.page.locator('#confirm-ok').click();
    await expect(host.page.locator('#screen-home')).toHaveClass(/active/);
    await expect.poll(() => guest.page.evaluate(() => view.players[0].connected)).toBe(false);
    expect(await guest.page.evaluate(() => view.gameId)).toBe(gameId);
    await expect(guest.page.locator('#screen-game')).toHaveClass(/active/);
    await host.page.goto(`${worker.origin}/connect4/#${roomCode}`);
    await expect(host.page.locator('#screen-game')).toHaveClass(/active/);
    expect(await host.page.evaluate(() => view.gameId)).toBe(gameId);
    expect(await host.page.evaluate(() => view.you.seat)).toBe(0);
    expect(await host.page.evaluate(() => view.game.moveCount)).toBe(0);
    await expect(host.page.locator('#btn-end')).toHaveCount(0);
  } finally { await close(host, guest); }
});

test('four complete rated rematches apply protection to both players on the fourth loss', async ({ browser }) => {
  test.setTimeout(60000);
  const response = await fetch(`${worker.origin}/api/connect4/create`, { method: 'POST' });
  const { roomCode } = await response.json();
  const viewport = { width: 390, height: 844 };
  const host = await client(browser, 'Pity Winner', viewport, roomCode);
  const guest = await client(browser, 'Pity Challenger', viewport, roomCode);
  try {
    await expect(host.page.locator('.c4-player')).toHaveCount(2);
    const deltas = [];
    for (let round = 1; round <= 4; round++) {
      await host.page.locator('#btn-start').click();
      await expect(host.page.locator('#screen-game')).toHaveClass(/active/);
      let guestMoves = 0;
      while (await host.page.evaluate(() => view.game.phase !== 'done')) {
        const { currentSeat, moveCount } = await host.page.evaluate(() => view.game);
        const mover = currentSeat === 0 ? host : guest;
        // Host builds a vertical four; the other player alternates columns so
        // that opening second does not accidentally let the guest win first.
        const col = currentSeat === 0 ? 0 : [1, 2, 1, 2][guestMoves++];
        await mover.page.locator(`.c4-drop[data-col="${col}"]`).tap();
        await expect.poll(() => host.page.evaluate(() => view.game.moveCount)).toBeGreaterThan(moveCount);
      }
      await expect(host.page.locator('#modal-over')).toBeVisible();
      await expect.poll(() => host.page.evaluate(() => view.lastRating?.gameId === view.gameId)).toBe(true);
      const changes = await host.page.evaluate(() => view.lastRating.changes);
      expect(changes).toHaveLength(2);
      const winner = changes.find(change => change.seat === 0);
      const loser = changes.find(change => change.seat === 1);
      expect(winner.delta).toBe([8, 8, 7, 3][round - 1]);
      expect(loser.delta).toBe(-winner.delta);
      deltas.push(winner.delta);
      await expect(host.page.locator('.c4-rating-row')).toHaveCount(2);
      if (round < 4) {
        await host.page.locator('#btn-again').click();
        await expect(host.page.locator('#screen-lobby')).toHaveClass(/active/);
      }
    }
    expect(deltas).toEqual([8, 8, 7, 3]);
  } finally { await close(host, guest); }
});
