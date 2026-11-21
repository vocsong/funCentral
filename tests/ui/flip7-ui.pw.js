const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../static');
const initial = () => ({ type:'state',roomCode:'ABCD',revision:2,hostId:'me',minPlayers:3,maxPlayers:12,watchers:0,you:{id:'me',removed:false},players:[{id:'me',name:'Alex',connected:true},{id:'b',name:'Blair',connected:true},{id:'c',name:'Casey',connected:true}],game:{id:'game1',phase:'playing',round:1,dealerId:'c',turnId:'me',deckCount:80,winnerId:null,flippedBy:null,pending:null,players:[{id:'me',total:0,roundScore:7,status:'active',numbers:[2,5],bonuses:[],doubled:false,secondChance:false},{id:'b',total:0,roundScore:9,status:'active',numbers:[9],bonuses:[],doubled:false,secondChance:false},{id:'c',total:0,roundScore:4,status:'stayed',numbers:[4],bonuses:[],doubled:false,secondChance:false}]}});
async function setup(page, state=initial(), { stallFirst = false } = {}) {
 await page.route('**/*', route => {
  const u=new URL(route.request().url());
  if(u.pathname==='/api/me')return route.fulfill({json:{displayName:'Alex'}});
  const f=u.pathname==='/flip7/'?'flip7/index.html':u.pathname.slice(1);
  const full=path.join(root,f);
  if(!full.startsWith(root)||!fs.existsSync(full))return route.fulfill({status:404,body:'Not found'});
  return route.fulfill({body:fs.readFileSync(full),contentType:f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':'text/html'});
 });
 await page.addInitScript(({ state, stallFirst }) => {
  localStorage.setItem('authToken', 'fixture');
  window.sent = [];
  window.socketAttempts = 0;
  class FakeSocket {
   static OPEN = 1;
   constructor() {
    this.readyState = 0;
    window.sock = this;
    const attempt = ++window.socketAttempts;
    setTimeout(() => {
     if (this.readyState !== 0) return;
     this.readyState = 1;
     this.onopen?.();
     if (attempt !== 1 || !stallFirst) this.push(state);
    }, 10);
   }
   send(message) { window.sent.push(message); }
   close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
   push(state) { this.onmessage?.({ data: JSON.stringify(state) }); }
  }
  window.WebSocket = FakeSocket;
 }, { state, stallFirst });
 await page.goto('http://127.0.0.1:4184/flip7/#ABCD');
}
const push=(p,s)=>p.evaluate(s=>sock.push(s),s);
const frames=p=>p.evaluate(()=>sent.filter(x=>x!=='ping').map(x=>JSON.parse(x)));
test('hit sends authoritative revision once and waits for acknowledgement',async({page})=>{await setup(page);await expect(page.getByRole('button',{name:'Hit · draw a card'})).toBeEnabled();await page.getByRole('button',{name:'Hit · draw a card'}).click();expect(await frames(page)).toEqual([{type:'hit',gameId:'game1',revision:2}]);await expect(page.getByRole('button',{name:'Stay · bank 7'})).toBeDisabled();});
test('other turns and disconnected sessions cannot send gameplay',async({page})=>{const s=initial();s.game.turnId='b';await setup(page,s);await expect(page.getByRole('button',{name:'Hit · draw a card'})).toBeDisabled();s.revision++;s.game.turnId='me';await push(page,s);await expect(page.getByRole('button',{name:'Hit · draw a card'})).toBeEnabled();await page.evaluate(()=>sock.close(4409));await expect(page.getByRole('button',{name:'Hit · draw a card'})).toBeDisabled();await expect(page.getByText('This room is open in another tab or device.')).toBeVisible();});
test('only the action actor can choose eligible targets',async({page})=>{const s=initial();s.game.pending={type:'freeze',actorId:'me',targets:['b']};await setup(page,s);await expect(page.getByRole('button',{name:'Choose Blair'})).toBeVisible();await expect(page.getByRole('button',{name:'Choose Casey'})).toHaveCount(0);await page.getByRole('button',{name:'Choose Blair'}).click();expect(await frames(page)).toEqual([{type:'target',playerId:'b',gameId:'game1',revision:2}]);});
test('host sees next round and final results; spectators have no game authority',async({page})=>{const s=initial();s.game.phase='roundEnd';s.game.turnId=null;await setup(page,s);await expect(page.getByRole('button',{name:'Start round 2'})).toBeEnabled();s.revision++;s.game.phase='finished';s.game.winnerId='b';s.game.players[1].total=210;await push(page,s);await expect(page.getByRole('heading',{name:'Blair wins!'})).toBeVisible();s.you.id=null;await push(page,s);await expect(page.getByRole('button',{name:'Back to lobby'})).toHaveCount(0);});
test('mobile board has no horizontal overflow, exposes rules and escapes player names',async({page})=>{await page.setViewportSize({width:390,height:844});const s=initial();s.players[1].name='<img src=x onerror=alert(1)>';await setup(page,s);await expect(page.locator('#players img')).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.getByRole('button',{name:'How to play'}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();});
test('lobby enforces minimum connected players and shows authenticated join',async({page})=>{const s=initial();s.game=null;s.players=s.players.slice(0,2);await setup(page,s);await expect(page.getByRole('button',{name:'Start game'})).toBeDisabled();s.you.id='c';await push(page,s);await page.getByRole('button',{name:'Take a seat'}).click();expect(await frames(page)).toEqual([{type:'join'}]);});
test('leaving an active game keeps the server seat and returns home',async({page})=>{await setup(page);page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Leave',exact:true}).click();await expect(page.locator('#home')).toBeVisible();expect(await frames(page)).toEqual([]);});
test('restoring a cached game page reconnects the table', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('button', { name: 'Hit · draw a card' })).toBeEnabled();
  await page.evaluate(() => {
    window.previousSocket = window.sock;
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect.poll(() => page.evaluate(() => window.sock !== window.previousSocket)).toBe(true);
  await expect(page.getByRole('button', { name: 'Hit · draw a card' })).toBeEnabled();
});
test('socket that opens without sending state retries and unlocks after syncing', async ({ page }) => {
  await page.clock.install();
  await setup(page, initial(), { stallFirst: true });
  await page.clock.runFor(100);
  await expect(page.locator('#connection')).toHaveText('Connecting…');
  await page.clock.runFor(9600);
  await expect(page.locator('#connection')).toHaveText('● Live');
  await expect(page.getByRole('button', { name: 'Hit · draw a card' })).toBeEnabled();
  expect(await page.evaluate(() => window.socketAttempts)).toBe(2);
});

test('displaced tab will not reclaim a seat after connectivity returns without a click', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#connection')).toHaveText('● Live');
  await page.evaluate(() => {
    window.sock.close(4409);
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.getByText('This room is open in another tab or device.')).toBeVisible();
  expect(await page.evaluate(() => window.socketAttempts)).toBe(1);
  await page.getByRole('button', { name: 'Reconnect this tab' }).click();
  await expect(page.locator('#connection')).toHaveText('● Live');
  expect(await page.evaluate(() => window.socketAttempts)).toBe(2);
});

test('offline lobby exit explains that the seat remains reserved', async ({ page }) => {
  const state = initial();
  state.game = null;
  await setup(page, state);
  await expect(page.locator('#connection')).toHaveText('● Live');
  await page.evaluate(() => window.sock.close(1006));
  const dialog = page.waitForEvent('dialog');
  const exit = page.getByRole('button', { name: 'Leave', exact: true }).click();
  const confirmation = await dialog;
  expect(confirmation.message()).toContain('without giving up your seat');
  await confirmation.accept();
  await exit;
  await expect(page.locator('#home')).toBeVisible();
  expect(await frames(page)).toEqual([]);
});

test('Second Chance is an action card with its official name, not a modifier', async ({ page }) => {
 const s=initial();s.game.players[0].secondChance=true;s.game.players[0].doubled=true;s.game.players[0].bonuses=[4];await setup(page,s);
 const hand=page.locator('[data-player-id="me"] .cards');
 await expect(hand.getByLabel('Second Chance action card')).toBeVisible();
 await expect(hand.getByLabel('×2 modifier card')).toBeVisible();
 await expect(hand.getByLabel('+4 modifier card')).toBeVisible();
 await expect(hand).not.toContainText('PROTECT');await expect(hand).not.toContainText('Save');
});

test('Freeze draws announce the chooser, legal targets and effect to actor and spectators', async ({page}) => {
 const s=initial();s.game.pending={type:'freeze',actorId:'me',targets:['b']};
 s.game.events=[{id:1,round:1,type:'actionDrawn',actorId:'me',card:{type:'freeze'}}];await setup(page,s);
 await expect(page.locator('#action-spotlight')).toContainText('Alex drew Freeze');
 await expect(page.locator('#action-spotlight')).toContainText('bank');
 await expect(page.locator('[data-player-id="b"]')).toHaveClass(/eligible-target/);
 await expect(page.locator('#activity')).toContainText('Alex drew Freeze');
 s.you.id=null;await push(page,s);
 await expect(page.locator('#action-spotlight')).toContainText('Alex is choosing');
 await expect(page.getByRole('button',{name:'Choose Blair'})).toHaveCount(0);
 s.revision++;s.game.pending=null;s.game.players[1].status='frozen';s.game.events.push({id:2,round:1,type:'actionResolved',actorId:'me',targetId:'b',card:{type:'freeze'}});await push(page,s);
 await expect(page.locator('#activity')).toContainText('Alex used Freeze on Blair');
});

test('bust duplicate remains visible with a clear explanation for every viewer',async({page})=>{
 const s=initial();s.you.id=null;s.game.players[1].status='busted';s.game.players[1].roundScore=0;s.game.players[1].bustCard={type:'number',value:9};
 s.game.events=[{id:1,round:1,type:'bust',actorId:'b',card:{type:'number',value:9}}];await setup(page,s);
 const player=page.locator('[data-player-id="b"]');
 await expect(player.locator('.bust-card')).toHaveAccessibleName('9 duplicate number card · Bust');
 await expect(player.locator('.cards .card')).toHaveCount(2);
 await expect(player).toContainText('Duplicate 9 · 0 points this round');
 await expect(page.locator('#activity')).toContainText('Blair busted on a duplicate 9');
});

for(const width of [320,390,1280])test(`compact dark table and action selection remain usable at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:844});const s=initial();s.game.pending={type:'secondChance',actorId:'me',targets:['b','c']};s.game.players[0].secondChance=true;s.game.players[0].numbers=[0,1,2,3,4,5];s.game.players[2].status='active';await setup(page,s);
 await expect(page.locator('#action-spotlight')).toBeVisible();
 const theme=await page.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor);expect(theme).not.toBe('rgb(246, 243, 233)');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 for(const b of await page.locator('#actions button').all()){const box=await b.boundingBox();expect(box.height).toBeGreaterThanOrEqual(44);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);}
 await expect(page.locator('#action-spotlight')).toContainText('Second Chance');
 if(process.env.FLIP7_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.FLIP7_SCREENSHOT_DIR}/flip7-${width}.png`,fullPage:true});
});

test('shared narration is bounded, escapes names, and does not duplicate after reconnect',async({page})=>{
 const s=initial();s.players[1].name='<script>bad()</script>';s.game.events=[{id:1,round:1,type:'secondChanceUsed',actorId:'b',card:{type:'number',value:9}}];await setup(page,s);await push(page,s);
 await expect(page.locator('#activity li')).toHaveCount(1);await expect(page.locator('#activity script')).toHaveCount(0);await expect(page.locator('#activity')).toContainText('used Second Chance to discard a duplicate 9');
});

test('latest shared play stays above a twelve-player mobile table',async({page})=>{
 await page.setViewportSize({width:390,height:844});const s=initial();
 for(let i=3;i<12;i++){s.players.push({id:'p'+i,name:'Player '+i,connected:true});s.game.players.push({...s.game.players[1],id:'p'+i});}
 s.game.events=[{id:1,round:1,type:'actionResolved',actorId:'b',targetId:'me',card:{type:'flipThree'}}];await setup(page,s);
 const latest=await page.locator('#latest-event').boundingBox();const players=await page.locator('#players').boundingBox();expect(latest.y+latest.height).toBeLessThan(players.y);expect(latest.y+latest.height).toBeLessThan(844);
});

test('batched Flip Three and Bust keep the target and outcome above the table',async({page})=>{
 await page.setViewportSize({width:390,height:844});const s=initial();s.you.id=null;
 s.game.events=[{id:1,batchId:1,round:1,type:'actionResolved',actorId:'me',targetId:'b',card:{type:'flipThree'}},{id:2,batchId:1,sourceActionId:1,round:1,type:'bust',actorId:'b',card:{type:'number',value:9}}];await setup(page,s);
 await expect(page.locator('#latest-play')).toContainText('Alex used Flip Three on Blair');
 await expect(page.locator('#latest-play')).toContainText('Blair busted on a duplicate 9');
 const box=await page.locator('#latest-play').boundingBox();expect(box.y+box.height).toBeLessThan(844);
 s.game.round++;s.game.events=[];await push(page,s);await expect(page.locator('#latest-play')).toBeHidden();
});


for(const [label,type,targetId,actionBatchId,bustBatchId] of [
 ['old Freeze','freeze','c',1,2],
 ['earlier Flip Three on the same player','flipThree','b',1,2],
 ['a non-causal action in the same server batch','freeze','c',1,1],
 ['legacy events without batch ids','flipThree','b',undefined,undefined],
])test(`Latest Play does not connect an independent bust to ${label}`,async({page})=>{
 const s=initial();s.you.id=null;
 s.game.events=[{id:1,batchId:actionBatchId,round:1,type:'actionResolved',actorId:'me',targetId,card:{type}}];await setup(page,s);
 await expect(page.locator('#latest-play')).toContainText('Alex used');
 s.revision++;s.game.events.push({id:2,batchId:bustBatchId,round:1,type:'bust',actorId:'b',card:{type:'number',value:9}});await push(page,s);
 const latest=page.locator('#latest-play');
 await expect(latest).toContainText('Blair busted on a duplicate 9');
 await expect(latest).not.toContainText('Alex used');
 await page.locator('#activity summary').click();
 await expect(page.locator('#activity li').filter({hasText:'Alex used'})).toBeVisible();
});

test('oval seats rotate clockwise from you and show the exact server-revealed modifier',async({page})=>{
 await page.setViewportSize({width:1280,height:844});const s=initial();s.game.lastDraw={id:1,actorId:'b',card:{type:'bonus',value:4}};
 await setup(page,s);const table=page.locator('#oval-table'), seats=table.locator('[data-seat-id]');
 await expect(seats).toHaveCount(3);expect(await seats.evaluateAll(list=>list.map(el=>el.dataset.seatId))).toEqual(['me','b','c']);
 const pos=await Promise.all(['me','b','c'].map(id=>table.locator(`[data-seat-id="${id}"]`).boundingBox()));
 expect(pos[0].y).toBeGreaterThan(Math.max(pos[1].y,pos[2].y));expect(pos[1].x).toBeLessThan(pos[2].x);
 await expect(table.locator('#revealed-card')).toHaveAccessibleName('+4 modifier card');
 await expect(table.locator('#reveal-caption')).toContainText('Blair drew');
 await expect(table.locator('#deck-count')).toHaveText('80 cards');
 s.revision++;s.game.lastDraw=null;await push(page,s);await expect(table.locator('#revealed-card')).toHaveCount(0);
 await expect(table.locator('#reveal-caption')).toContainText('No card revealed');
});

test('spectator table places the dealer at the top and shows authoritative duplicate outcome',async({page})=>{
 const s=initial();s.you.id=null;s.game.lastDraw={id:1,actorId:'b',card:{type:'number',value:9}};
 Object.assign(s.game.players[1],{status:'busted',roundScore:0,bustCard:{type:'number',value:9}});
 await setup(page,s);const table=page.locator('#oval-table');
 const dealer=table.locator('[data-seat-id="c"]');await expect(dealer).toBeVisible();
 expect((await dealer.boundingBox()).y).toBeLessThan((await table.locator('[data-seat-id="me"]').boundingBox()).y);
 await expect(table.locator('#revealed-card')).toHaveAccessibleName('9 duplicate number card · Bust');
 await expect(table.locator('#reveal-caption')).toContainText('Blair busted');
 await expect(table.locator('[data-seat-id="b"]')).toHaveAttribute('aria-pressed','true');
 await expect(page.getByRole('button',{name:'Hit · draw a card'})).toBeDisabled();
});

for(const width of [320,390])test(`twelve oval seats stay individually readable and selectable at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:844});const s=initial();
 for(let i=3;i<12;i++){s.players.push({id:'p'+i,name:'Player '+i,connected:true});s.game.players.push({...s.game.players[1],id:'p'+i,numbers:[2,8,10,11],roundScore:31});}
 await setup(page,s);const table=page.locator('#oval-table'), seats=table.locator('[data-seat-id]');
 await expect(seats).toHaveCount(12);const boxes=await Promise.all((await seats.all()).map(seat=>seat.boundingBox()));
 for(const [i,a] of boxes.entries()){
   expect(a.height).toBeGreaterThanOrEqual(44);expect(a.width).toBeGreaterThanOrEqual(44);
   expect(a.x).toBeGreaterThanOrEqual(0);expect(a.x+a.width).toBeLessThanOrEqual(width);
   for(const b of boxes.slice(i+1)) expect(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y).toBe(true);
 }
 const inspect=table.locator('[data-seat-id="p10"]');
 await expect(inspect.getByText('+2',{exact:true})).toBeVisible();
 await inspect.focus();await inspect.press('Enter');
 await expect(inspect).toHaveAttribute('aria-pressed','true');await expect(inspect).toBeFocused();
 await expect(page.locator('[data-player-id="p10"]').getByLabel('8 number card')).toBeVisible();
 s.revision++;await push(page,s);await expect(inspect).toHaveAttribute('aria-pressed','true');await expect(inspect).toBeFocused();
 await expect(page.locator('[data-player-id="me"] .cards')).not.toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('your turn and target choice bring back your hand once without moving focus',async({page})=>{
 await page.setViewportSize({width:390,height:844});const s=initial();s.game.turnId='b';
 await setup(page,s);const yours=page.locator('#oval-seats [data-seat-id="me"]'), opposing=page.locator('#oval-seats [data-seat-id="b"]');
 await opposing.click();
 await expect(opposing).toHaveAttribute('aria-pressed','true');
 s.revision++;s.game.turnId='me';await push(page,s);
 await expect(yours).toHaveAttribute('aria-pressed','true');
 await expect(opposing).toBeFocused();
 await opposing.click();
 s.revision++;s.players[2].connected=false;await push(page,s);
 await expect(opposing).toHaveAttribute('aria-pressed','true');
 s.revision++;s.game.pending={type:'freeze',actorId:'me',targets:['b']};await push(page,s);
 await expect(yours).toHaveAttribute('aria-pressed','true');
 await expect(opposing).toBeFocused();
 await opposing.click();s.revision++;await push(page,s);
 await expect(opposing).toHaveAttribute('aria-pressed','true');
});

const drawMotionProbe = page => page.addInitScript(() => {
 const animate=Element.prototype.animate;
 window.dealMotions=[];
 Element.prototype.animate=function(frames, options){
  if(this.classList.contains('f7-deal-ghost'))window.dealMotions.push(frames);
  return animate.call(this,frames,options);
 };
});
const motionCount = page => page.evaluate(()=>dealMotions.length);

test('a new live reveal sends one non-interactive card toward its seat, while face and controls update immediately',async({page})=>{
 await page.emulateMedia({reducedMotion:'no-preference'});
 await drawMotionProbe(page);
 const s=initial();s.game.lastDraw={id:3,actorId:'c',card:{type:'number',value:4}};
 await setup(page,s);await expect(page.locator('#revealed-card')).toHaveAccessibleName('4 number card');
 expect(await motionCount(page)).toBe(0);
 s.revision++;s.game.lastDraw={id:4,actorId:'b',card:{type:'number',value:11}};s.game.players[1].numbers.push(11);
 const frame=await page.evaluate(state=>{
  sock.push(state);
  const ghost=document.querySelector('.f7-deal-ghost');
  return { label:document.getElementById('revealed-card').getAttribute('aria-label'),
   ghostHidden:ghost?.getAttribute('aria-hidden'), pointer:ghost ? getComputedStyle(ghost).pointerEvents : undefined,
   deckX:document.querySelector('.f7-deck-back').getBoundingClientRect().x,
   ghostX:ghost?.getBoundingClientRect().x, seatX:document.querySelector('[data-seat-id="b"]').getBoundingClientRect().x,
   targetX:dealMotions.length ? new DOMMatrix(dealMotions.at(-1).at(-1).transform).m41 : 0, hitReady:!document.querySelector('#actions button').disabled };
 },s);
 expect(frame).toMatchObject({label:'11 number card',ghostHidden:'true',pointer:'none',hitReady:true});
 expect(Math.abs(frame.deckX-frame.ghostX)).toBeLessThan(4);
 const dx=frame.targetX;
 expect(Math.sign(dx)).toBe(Math.sign(frame.seatX-frame.deckX));
 expect(Math.abs(dx)).toBeGreaterThan(20);
 await push(page,s);
 s.revision++;s.players[2].connected=false;await push(page,s);
 expect(await motionCount(page)).toBe(1);
 await expect(page.locator('.f7-deal-ghost')).toHaveCount(0);
 await expect(page.locator('#revealed-card')).toHaveAccessibleName('11 number card');
});

test('reduced motion keeps authoritative reveal instant with no travelling card',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});
 await drawMotionProbe(page);
 const s=initial();s.game.lastDraw={id:2,actorId:'c',card:{type:'number',value:4}};await setup(page,s);
 await expect(page.locator('#revealed-card')).toHaveAccessibleName('4 number card');
 s.revision++;s.game.lastDraw={id:3,actorId:'b',card:{type:'number',value:9}};await push(page,s);
 await expect(page.locator('#revealed-card')).toHaveAccessibleName('9 number card');
 expect(await motionCount(page)).toBe(0);
 await expect(page.locator('.f7-deal-ghost')).toHaveCount(0);
});

test('new draws replace travelling cards and reconnect and new rounds do not replay motion',async({page})=>{
 await page.emulateMedia({reducedMotion:'no-preference'});
 await drawMotionProbe(page);
 const s=initial();s.game.lastDraw={id:3,actorId:'c',card:{type:'number',value:4}};await setup(page,s);
 await expect(page.locator('#revealed-card')).toHaveAccessibleName('4 number card');
 const state2=structuredClone(s);state2.revision++;state2.game.lastDraw={id:4,actorId:'b',card:{type:'number',value:9}};
 const state3=structuredClone(state2);state3.revision++;state3.game.lastDraw={id:5,actorId:'me',card:{type:'number',value:5}};
 const after=await page.evaluate(([second,third])=>{
  sock.push(second);const firstGhost=document.querySelector('.f7-deal-ghost');
  sock.push(third);
  const replacement=!!firstGhost&&!firstGhost.isConnected&&document.querySelectorAll('.f7-deal-ghost').length===1;
  sock.close(4409);
  return {replacement, removed:!document.querySelector('.f7-deal-ghost')};
 },[state2,state3]);
 expect(after).toEqual({replacement:true,removed:true});
 await page.getByRole('button',{name:'Reconnect this tab'}).click();
 await expect.poll(()=>page.evaluate(()=>window.socketAttempts)).toBe(2);
 const state4=structuredClone(state3);state4.revision++;state4.game.lastDraw={id:6,actorId:'c',card:{type:'number',value:3}};
 await push(page,state4);
 await expect(page.locator('#revealed-card')).toHaveAccessibleName('3 number card');
 expect(await motionCount(page)).toBe(2);
 state4.revision++;state4.game.round++;state4.game.lastDraw={id:7,actorId:'me',card:{type:'number',value:7}};
 await push(page,state4);
 await expect(page.locator('#revealed-card')).toHaveAccessibleName('7 number card');
 expect(await motionCount(page)).toBe(2);
});
