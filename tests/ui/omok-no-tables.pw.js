const {test,expect}=require('@playwright/test');
const {startWorker}=require('./live-worker.cjs');
let worker;
test.beforeAll(async()=>{worker=await startWorker(4246,{}, {skipMigrations:['0016_omok.sql']});});
test.afterAll(async()=>{await worker?.stop();});
test('unmigrated Omok endpoints stay empty while real gameplay, practice and Bridge remain available',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.route('**/*',route=>new URL(route.request().url()).origin===worker.origin?route.continue():route.abort());
    const auth=await fetch(worker.origin+'/api/auth/dev',{method:'POST',body:JSON.stringify({displayName:'Schema Omok'})}).then(r=>r.json());
    await page.addInitScript(token=>localStorage.setItem('authToken',token),auth.token);
    await page.goto(worker.origin+'/omok/');await page.locator('#btn-create').tap();
    await expect(page.locator('#screen-lobby')).toHaveClass(/active/);
    await page.locator('#btn-add-bot').tap();await page.locator('#btn-start').tap();
    await expect(page.locator('#screen-game')).toHaveClass(/active/);
    await expect.poll(()=>page.evaluate(()=>canPlace()),{timeout:10000}).toBe(true);
    const point=await page.evaluate(()=>{for(let r=0;r<15;r++)for(let c=0;c<15;c++)if(!view.game.board[r][c])return{r,c};});
    await page.locator(`.om-cell[data-row="${point.r}"][data-col="${point.c}"]`).tap();await page.locator('#btn-place').tap();
    await expect.poll(()=>page.evaluate(()=>view.game.moveCount)).toBeGreaterThan(0);
    expect(await fetch(worker.origin+'/api/omok/leaderboard').then(r=>r.json())).toEqual({top:[],me:null});
    expect(await fetch(worker.origin+'/api/omok/stats').then(r=>r.json())).toEqual([]);
    const bridge=await fetch(worker.origin+'/api/create',{method:'POST'}).then(r=>r.json());expect(bridge.roomCode).toMatch(/^[A-Z0-9]{4}$/);
    expect(errors).toEqual([]);
  }finally{await context.close();}
});
