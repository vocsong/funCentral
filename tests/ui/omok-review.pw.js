// Independent review: shared leaderboard isolation and real Worker auth gates.
// Leaderboard responses are fixtures; socket identity/debug checks use real
// routing, JWT verification, room classes and local D1 with dev login disabled.
const {test,expect}=require('@playwright/test');
const {createHmac}=require('node:crypto');
const {startWorker}=require('./live-worker.cjs');
let worker;
test.beforeAll(async()=>{worker=await startWorker(4247,{ALLOW_DEV_LOGIN:'0'});});
test.afterAll(async()=>{await worker?.stop();});
const token=(id,exp=Math.floor(Date.now()/1000)+600)=>{
  const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({sub:String(id),name:'Old JWT name',exp})).toString('base64url');
  const content=header+'.'+payload;
  return content+'.'+createHmac('sha256','local-chat-test-only').update(content).digest('base64url');
};
async function pageFor(browser){
  const context=await browser.newContext(),page=await context.newPage();
  await page.route('**/*',route=>new URL(route.request().url()).origin===worker.origin?route.continue():route.abort());
  await page.goto(worker.origin+'/omok/');
  return{context,page};
}
async function socket(page,room,credential,id='tg_41'){
  await page.evaluate(({url})=>{
    window.reviewFrames=[];
    window.reviewSocket=new WebSocket(url);
    reviewSocket.onmessage=event=>reviewFrames.push(JSON.parse(event.data));
  },{url:`${worker.origin.replace('http','ws')}/api/omok/ws?room=${room}&playerId=${id}&name=Forged${credential?'&token='+encodeURIComponent(credential):''}`});
  await expect.poll(()=>page.evaluate(()=>reviewFrames.find(f=>f.type==='state')?.type)).toBe('state');
}
const state=page=>page.evaluate(()=>reviewFrames.filter(f=>f.type==='state').at(-1));
const send=(page,msg)=>page.evaluate(msg=>reviewSocket.send(JSON.stringify(msg)),msg);
async function user(id,name){await worker.db.prepare('INSERT OR REPLACE INTO users (telegram_id,display_name,created_at) VALUES (?,?,0)').bind(id,name).run();}

test('a stalled Omok leaderboard cannot hold existing boards blank',async({browser})=>{
  const {context,page}=await pageFor(browser);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  let requested=false;
  try{
    await page.route('**/api/leaderboard',route=>route.fulfill({json:{top:[{rank:1,displayName:'Bridge Review',elo:1040,wins:3,gamesPlayed:4}],me:null}}));
    for(const game of ['regicide','taidi','connect4'])await page.route(`**/api/${game}/leaderboard`,route=>route.fulfill({json:{top:[],me:null}}));
    await page.route('**/api/omok/leaderboard',async route=>{
      requested=true;await gate;
      await route.fulfill({json:{top:[{rank:1,displayName:'Omok Review',elo:1020,wins:2,draws:0,gamesPlayed:3}],me:null}}).catch(()=>{});
    });
    await page.goto(worker.origin+'/');
    await expect.poll(()=>requested).toBe(true);
    await expect(page.locator('.lb-name').filter({hasText:'Bridge Review'})).toBeVisible({timeout:1500});
    // A later response must preserve the chosen tab and keyboard focus.
    await page.locator('.lb-tab[data-game="connect4"]').click();
    const completed=page.waitForResponse(response=>response.url().endsWith('/api/omok/leaderboard'));
    release();
    await(await completed).finished();await page.evaluate(()=>new Promise(requestAnimationFrame));
    await expect(page.locator('.lb-tab[data-game="connect4"]')).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('.lb-tab[data-game="connect4"]')).toBeFocused();
    await page.locator('.lb-tab[data-game="omok"]').click();
    await expect(page.locator('.lb-name')).toHaveText('Omok Review');
  }finally{release();await context.close();}
});

test('late Omok and season responses cannot overwrite a newer leaderboard mount',async({browser})=>{
  const {context,page}=await pageFor(browser);
  let releaseOmok,releaseSeason;
  const omokGate=new Promise(resolve=>{releaseOmok=resolve;});
  const seasonGate=new Promise(resolve=>{releaseSeason=resolve;});
  let omokCalls=0;
  try{
    await page.route('**/review-widget',route=>route.fulfill({contentType:'text/html',body:'<div id="review-board"></div><script src="/leaderboard.js"></script>'}));
    for(const game of ['regicide','taidi','connect4'])await page.route(`**/api/${game}/leaderboard`,route=>route.fulfill({json:{top:[],me:null}}));
    await page.route('**/api/omok/leaderboard',async route=>{
      if(++omokCalls===1)await omokGate;
      await route.fulfill({json:{top:[],me:null}}).catch(()=>{});
    });
    await page.route('**/api/leaderboard?season=1',async route=>{
      await seasonGate;
      await route.fulfill({json:{top:[{rank:1,displayName:'Old season result',elo:1000,wins:1,gamesPlayed:1}],me:null}}).catch(()=>{});
    });
    await page.goto(worker.origin+'/review-widget');
    const mount=name=>page.evaluate(async name=>{
      await FunLeaderboard.mount(document.getElementById('review-board'),{bridgeData:{
        top:[{rank:1,displayName:name,elo:1000,wins:1,gamesPlayed:1}],me:null,
        season:{id:'2',name:'Season 2'},seasons:[{id:'1',name:'Season 1'},{id:'2',name:'Season 2',current:true}],
      }});
    },name);
    await mount('First mount');
    await page.locator('.lb-season[data-season="1"]').click();
    await mount('Latest mount');
    await expect(page.locator('.lb-name')).toHaveText('Latest mount');
    const omokDone=page.waitForResponse(response=>response.url().endsWith('/api/omok/leaderboard'));
    const seasonDone=page.waitForResponse(response=>response.url().endsWith('/api/leaderboard?season=1'));
    releaseOmok();releaseSeason();
    await(await omokDone).finished();await(await seasonDone).finished();
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    await expect(page.locator('.lb-name')).toHaveText('Latest mount');
    await expect(page.locator('.lb-season[data-season="2"]')).toHaveAttribute('aria-pressed','true');
  }finally{releaseOmok();releaseSeason();await context.close();}
});

test('verified profiles override socket names/ids; forged and expired credentials remain spectators',async({browser})=>{
  await user(41,'Verified Alice');
  const {roomCode}=await fetch(worker.origin+'/api/omok/create',{method:'POST'}).then(r=>r.json());
  const host=await pageFor(browser),guest=await pageFor(browser);
  try{
    await socket(host.page,roomCode,token(41),'tg_999');
    await send(host.page,{type:'join',name:'Spoofed player'});
    await expect.poll(async()=>(await state(host.page)).players.length).toBe(1);
    expect((await state(host.page)).you.id).toBe('tg_41');
    expect((await state(host.page)).players[0].name).toBe('Verified Alice');
    for(const credential of [null,token(41).slice(0,-8)+'tampered',token(41,1)]){
      await socket(guest.page,roomCode,credential);
      expect((await state(guest.page)).you.id).toMatch(/^guest_/);
      expect((await state(guest.page)).you.seat).toBe(-1);
      await send(guest.page,{type:'join',name:'Verified Alice'});
      await expect.poll(()=>guest.page.evaluate(()=>reviewFrames.filter(f=>f.type==='error').at(-1)?.message)).toContain('Sign in');
      expect(await host.page.evaluate(()=>reviewSocket.readyState)).toBe(1);
      expect((await state(host.page)).players).toHaveLength(1);
      await guest.page.evaluate(()=>reviewSocket.close());
    }
  }finally{await host.context.close();await guest.context.close();}
});

test('production-like flags reject dev login and debug patches without changing the active game',async({browser})=>{
  for(const [id,name]of [[51,'Review A'],[52,'Review B']])await user(id,name);
  const {roomCode}=await fetch(worker.origin+'/api/omok/create',{method:'POST'}).then(r=>r.json());
  const a=await pageFor(browser),b=await pageFor(browser);
  try{
    await socket(a.page,roomCode,token(51));await send(a.page,{type:'join'});
    await expect.poll(async()=>(await state(a.page)).you.seat).toBe(0);
    await socket(b.page,roomCode,token(52));await send(b.page,{type:'join'});
    await expect.poll(async()=>(await state(a.page)).players.length).toBe(2);
    await send(a.page,{type:'start'});await expect.poll(async()=>(await state(a.page)).game?.phase).toBe('play');
    const before=await state(a.page);
    expect((await fetch(worker.origin+'/api/auth/dev',{method:'POST',body:JSON.stringify({displayName:'forged'})})).status).toBe(404);
    expect((await fetch(`${worker.origin}/api/omok/debug/patch?room=${roomCode}`,{method:'POST',headers:{Authorization:'Bearer '+token(51)},body:JSON.stringify({phase:'done',winner:0})})).status).toBe(404);
    expect((await state(a.page)).gameId).toBe(before.gameId);
    expect((await state(a.page)).game.phase).toBe('play');
    for(const room of ['x','12345','%3Cscript%3E'])expect((await fetch(`${worker.origin}/api/omok/ws?room=${room}`)).status).toBe(400);
  }finally{await a.context.close();await b.context.close();}
});
