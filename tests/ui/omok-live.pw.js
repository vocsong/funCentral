// Real local Worker, D1 and browser WebSockets. Completed human rounds below
// use real moves; only the separate draw/rules unit fixtures patch board state.
const { test, expect } = require('@playwright/test');
const { startWorker } = require('./live-worker.cjs');
const path = require('node:path');
const fs = require('node:fs/promises');
let worker;
test.beforeAll(async () => { worker = await startWorker(4245); });
test.afterAll(async () => { await worker?.stop(); });
const state = page => page.evaluate(() => view);
async function client(browser, name, room, mobile=false, width) {
  const context = await browser.newContext({viewport:mobile?{width:width||390,height:844}:{width:1366,height:900},isMobile:mobile,hasTouch:mobile});
  const page=await context.newPage(); const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===worker.origin?route.continue():route.abort());
  if(name) {
    const auth=await fetch(`${worker.origin}/api/auth/dev`,{method:'POST',body:JSON.stringify({displayName:name})}).then(r=>r.json());
    await page.addInitScript(token=>localStorage.setItem('authToken',token),auth.token);
  }
  await page.goto(`${worker.origin}/omok/${room?'#'+room:''}`);
  if(room) await expect.poll(async()=>(await state(page))?.you.seat).toBe(name?0:-1);
  return {context,page,errors,mobile};
}
async function table(browser,mobile=false,width) {
  const {roomCode}=await fetch(`${worker.origin}/api/omok/create`,{method:'POST'}).then(r=>r.json());
  const a=await client(browser,'Alice Omok',roomCode,mobile,width);
  // Second player will get seat 1, so do not use the first-seat helper assertion.
  const b=await client(browser,'Bob Omok',null);
  await b.page.goto(`${worker.origin}/omok/#${roomCode}`);
  await expect.poll(async()=>(await state(b.page))?.you.seat).toBe(1);
  await expect(a.page.locator('#lobby-players .om-player')).toHaveCount(2);
  return {clients:[a,b],a,b,roomCode};
}
async function start(a) {
  await a.page.locator('#btn-start')[a.mobile?'tap':'click']();
  await expect(a.page.locator('#screen-game')).toHaveClass(/active/);
  await expect(a.page.locator('#om-game')).not.toHaveClass(/opening/,{timeout:10000});
}
async function place(actor,row,col) {
  const count=(await state(actor.page)).game.moveCount;
  await expect.poll(async()=>actor.page.evaluate(()=>canPlace())).toBe(true);
  const point=actor.page.locator(`.om-cell[data-row="${row}"][data-col="${col}"]`);
  await point[actor.mobile?'tap':'click']();
  expect((await state(actor.page)).game.moveCount).toBe(count);
  await expect(actor.page.locator('#btn-place')).toBeEnabled();
  await actor.page.locator('#btn-place')[actor.mobile?'tap':'click']();
  await expect.poll(async()=>(await state(actor.page)).game.moveCount).toBe(count+1);
}
async function close(clients) {for(const c of clients) {expect(c.errors).toEqual([]); await c.context.close();}}
async function fits(page) {
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  for(const selector of ['.om-game','.om-table','.om-players','.om-move-panel','.om-side']) {
    const box=await page.locator(selector).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x+box.width).toBeLessThanOrEqual((await page.viewportSize()).width+1);
  }
}
async function capture(page,name) {
  const dir=path.resolve(__dirname,'../../docs/evidence/omok'); await fs.mkdir(dir,{recursive:true});
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:path.join(dir,name+'.png'),fullPage:true,animations:'disabled'});
}

for(const mobile of [false,true]) test(`played game, spectator, reload, results and alternating rematch (${mobile?'touch mobile':'desktop'})`,async({browser})=>{
  test.setTimeout(90000);
  const {clients,a,b,roomCode}=await table(browser,mobile);
  let watcher;
  try {
    await capture(a.page,mobile?'lobby-mobile':'lobby-desktop');
    if(mobile) await a.page.emulateMedia({reducedMotion:'reduce'});
    await start(a); const initial=await state(a.page);
    expect(initial.game.yourStone===1).toBe(initial.game.blackSeat===0);
    watcher=await client(browser,null,roomCode,mobile);
    await expect(watcher.page.locator('#om-turn')).toContainText('Watching');
    await expect(watcher.page.locator('#btn-place')).toBeDisabled();
    for(let i=0;i<9;i++) {
      const current=await state(a.page), actor=clients[current.game.currentSeat];
      await place(actor,i%2===0?7:0,Math.floor(i/2));
      await expect.poll(async()=>(await state(watcher.page)).game.moveCount).toBe(i+1);
      if(i===2) {
        await capture(a.page,mobile?'game-mobile':'game-desktop'); await fits(a.page);
        const id=(await state(a.page)).gameId;
        await b.context.setOffline(true); await a.page.reload();
        await expect.poll(async()=>(await state(a.page))?.game.moveCount).toBe(3);
        expect((await state(a.page)).gameId).toBe(id);
        await b.context.setOffline(false); await b.page.reload();
        await expect.poll(async()=>(await state(b.page))?.game.moveCount).toBe(3);
      }
    }
    await expect(a.page.locator('#modal-over')).toBeVisible();
    await expect(a.page.locator('.om-cell.win')).toHaveCount(5);
    await expect(a.page.locator('#over-rating')).toBeVisible();
    const gameId=(await state(a.page)).gameId;
    await expect.poll(async()=>worker.db.prepare('SELECT COUNT(*) AS n FROM omok_games WHERE game_id = ?').bind(gameId).first('n')).toBe(1);
    await capture(a.page,mobile?'results-mobile':'results-desktop');
    await a.page.locator('#btn-over-close').click();
    await expect(a.page.locator('#btn-results')).toBeFocused();
    await a.page.locator('#btn-results').click(); await a.page.locator('#btn-again').click();
    await expect(b.page.locator('#screen-lobby')).toHaveClass(/active/);
    await expect(watcher.page.locator('#screen-lobby')).toHaveClass(/active/);
    expect((await state(watcher.page)).you.seat).toBe(-1);
    await start(a);
    expect((await state(a.page)).game.blackSeat).toBe(1-initial.game.blackSeat);
    expect((await state(a.page)).game.moveCount).toBe(0);
  }finally {await close([...clients,...(watcher?[watcher]:[])]);}
});

test('keyboard grid, precise preview, modal focus and accessibility tree',async({browser})=>{
  const {clients,a}=await table(browser);
  try {
    await start(a);
    const actor=clients[(await state(a.page)).game.currentSeat],page=actor.page;
    expect(await page.locator('[role="gridcell"][tabindex="0"]').count()).toBe(1);
    await page.locator('[role="gridcell"][tabindex="0"]').focus();
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
    await expect(page.locator('#btn-place')).toContainText('G7');
    expect((await state(page)).game.moveCount).toBe(0);
    await page.keyboard.press('Escape'); await expect(page.locator('#btn-place')).toBeDisabled();
    await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
    await expect(page.locator('#btn-place')).toBeFocused(); await page.keyboard.press('Enter');
    await expect.poll(async()=>(await state(page)).game.moveCount).toBe(1);
    await expect(page.getByRole('gridcell',{name:'G7: Black stone, last move',exact:true})).toBeVisible();
    const cdp=await actor.context.newCDPSession(page),tree=await cdp.send('Accessibility.getFullAXTree');
    expect(tree.nodes.some(n=>!n.ignored&&n.role?.value==='gridcell'&&n.name?.value==='G7: Black stone, last move')).toBe(true);
    await cdp.detach();
    await page.locator('#btn-rules').click();
    const first=page.locator('#modal-rules button').first(); await first.focus(); await page.keyboard.press('Shift+Tab');
    await expect(first).toBeFocused();
    expect(await page.locator('#screen-game').evaluate(n=>n.inert)).toBe(true);
    await page.keyboard.press('Escape'); await expect(page.locator('#btn-rules')).toBeFocused();
    await page.locator('#btn-resign').click(); await expect(page.locator('#modal-confirm')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('#btn-resign')).toBeFocused();
  }finally {await close(clients);}
});

test('320px touch board enlarges without page overflow and can place at the far corner',async({browser})=>{
  const {clients,a}=await table(browser,true,320);
  try {
    await start(a);
    // Ensure the narrow client is to play, without patching a game.
    if((await state(a.page)).game.currentSeat===1) await place(clients[1],7,7);
    await a.page.locator('#btn-zoom').tap();
    await expect(a.page.locator('#btn-zoom')).toHaveAttribute('aria-pressed','true');
    await a.page.locator('.om-cell[data-row="14"][data-col="14"]').scrollIntoViewIfNeeded();
    await place(a,14,14); await fits(a.page);
    await a.page.locator('#btn-zoom').tap(); await capture(a.page,'game-320px');
  }finally {await close(clients);}
});

test('replacement socket pauses until explicit reconnect and preserves the seat',async({browser})=>{
  const {clients,a,roomCode}=await table(browser); let replacement;
  try {
    await start(a);
    replacement=await client(browser,'Alice Omok',roomCode);
    await expect(a.page.locator('#btn-reconnect')).toBeVisible();
    await a.page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await expect(a.page.locator('#btn-reconnect')).toBeVisible();
    await a.page.locator('#btn-reconnect').click();
    await expect(a.page.locator('#overlay-reconnect')).toBeHidden();
    await expect(replacement.page.locator('#btn-reconnect')).toBeVisible();
    expect((await state(a.page)).players).toHaveLength(2); expect((await state(a.page)).you.seat).toBe(0);
  }finally {await close([...clients,...(replacement?[replacement]:[])]);}
});

test('practice bot responds to a real placement; resignation, result and rematch remain unrated',async({browser})=>{
  const {roomCode}=await fetch(`${worker.origin}/api/omok/create`,{method:'POST'}).then(r=>r.json());
  const a=await client(browser,'Solo Omok',roomCode,true);
  try {
    await a.page.locator('#btn-add-bot').tap(); await start(a);
    await expect.poll(async()=>(await state(a.page)).game.currentSeat,{timeout:10000}).toBe(0);
    const current=(await state(a.page)).game;
    const row=current.board[7][7]?8:7;
    await place(a,row,7);
    await expect.poll(async()=>(await state(a.page)).game.moveCount,{timeout:10000}).toBe(current.moveCount+2);
    await a.page.locator('#btn-resign').tap(); await a.page.locator('#confirm-ok').tap();
    await expect(a.page.locator('#modal-over')).toBeVisible();
    await expect(a.page.locator('#over-sub')).toContainText('resigned');
    expect(await worker.db.prepare('SELECT COUNT(*) AS n FROM omok_games WHERE game_id = ?').bind((await state(a.page)).gameId).first('n')).toBe(0);
    await a.page.locator('#btn-again').tap(); await expect(a.page.locator('#screen-lobby')).toHaveClass(/active/);
    await a.page.locator('#btn-leave').tap(); await expect(a.page.locator('#screen-home')).toHaveClass(/active/);
  }finally {await close([a]);}
});

for(const mobile of [false,true]) test(`lobby entry, shared auth and independent leaderboard (${mobile?'mobile':'desktop'})`,async({browser})=>{
  const a=await client(browser,'Lobby Omok',null,mobile);
  try {
    await a.page.goto(worker.origin+'/omok/#%E0%A4');
    await expect(a.page.locator('#screen-home')).toHaveClass(/active/);
    // Seed a board row as fixture evidence for the shared component, not a played match.
    const auth=await fetch(`${worker.origin}/api/auth/dev`,{method:'POST',body:JSON.stringify({displayName:'Board Omok'})}).then(r=>r.json());
    await worker.db.prepare('INSERT OR REPLACE INTO omok_ratings (telegram_id,rating,games_played,wins,draws,updated_at) VALUES (?,1040,4,3,0,0)').bind(auth.telegramId).run();
    await a.page.goto(worker.origin+'/');
    await expect(a.page.locator('.game-tile')).toHaveCount(5);
    await capture(a.page,mobile?'hub-mobile':'hub-desktop');
    await a.page.locator('.tile-omok').click();
    await expect(a.page.locator('#game-section')).toBeVisible();
    await expect(a.page.locator('.lb-tab[data-game="omok"]')).toHaveAttribute('aria-pressed','true');
    await expect(a.page.locator('.lb-name').filter({hasText:'Board Omok'})).toBeVisible();
    await capture(a.page,mobile?'home-mobile':'home-desktop');
    await a.page.locator('.lb-tab[data-game="connect4"]').click(); await expect(a.page.locator('.lb-empty')).toBeVisible();
    await a.page.locator('.lb-tab[data-game="omok"]').click(); await expect(a.page.locator('.lb-footer a')).toHaveAttribute('href','/omok/?view=stats');
    await a.page.locator('.lb-footer a').click();
    await expect(a.page.locator('#screen-stats')).toHaveClass(/active/);
    await expect(a.page.locator('.stats-td-name').filter({hasText:'Board Omok'})).toBeVisible();
    await a.page.getByRole('button',{name:'Sort by Rating',exact:true}).focus();
    await a.page.keyboard.press('Enter');
    await expect(a.page.locator('th[aria-sort="ascending"]')).toContainText('Rating');
    await expect(a.page.getByRole('button',{name:'Sort by Rating',exact:true})).toBeFocused();
    await a.page.locator('#btn-stats-home').click();
    await a.page.locator('#btn-create').click(); await expect(a.page.locator('#screen-lobby')).toHaveClass(/active/);
  }finally {await close([a]);}
});
