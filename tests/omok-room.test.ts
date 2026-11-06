import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createOmokRoomHarness, connectSocket, readRoom, fireAlarm, Response } from './omok-room-harness';
type Harness=Awaited<ReturnType<typeof createOmokRoomHarness>>;
type Room=Awaited<ReturnType<Harness['room']>>;
type Client=Awaited<ReturnType<typeof connectSocket>>;
let harness:Harness;
const save=(room:Room,state:unknown)=>room.fetch('https://room.test/__state',{method:'POST',body:JSON.stringify(state)});
async function create(h:Harness,name:string,humans=true) {
  const room=await h.room(name);
  await room.fetch('https://room.test/create',{method:'POST',body:JSON.stringify({roomCode:name.slice(0,4)})});
  const a=await connectSocket(room,'tg_1','Alice'); a.send({type:'join',name:'forged'});
  await expect.poll(async()=>(await readRoom(room)).state.players.length).toBe(1);
  const b=await connectSocket(room,'tg_2','Bob');
  if(humans) { b.send({type:'join'}); await expect.poll(async()=>(await readRoom(room)).state.players.length).toBe(2); }
  return {room,clients:[a,b],a,b};
}
async function start(room:Room,a:Client,fast=true) {
  a.send({type:'start'});
  await expect.poll(async()=>(await readRoom(room)).state.game?.phase).toBe('play');
  const {state}=await readRoom(room);
  if(fast) {state.openingUntil=0; await save(room,state);}
  return state;
}
async function move(room:Room,clients:Client[],row:number,col:number) {
  const {state}=await readRoom(room);
  clients[state.game.currentSeat].send({type:'place',row,col,gameId:state.gameId,moveNumber:state.game.moveCount});
  await expect.poll(async()=>(await readRoom(room)).state.game.moveCount).toBe(state.game.moveCount+1);
}
async function finish(room:Room,clients:Client[]) {
  for(let i=0;i<9;i++) await move(room,clients,i%2===0?7:0,Math.floor(i/2));
}

describe('Omok authoritative rooms on real local workerd',()=>{
  beforeAll(async()=>{harness=await createOmokRoomHarness();},30000);
  afterAll(async()=>{await harness?.stop();});
  it('keeps verified names, spectators, full rooms, host controls and kicks authoritative',async()=>{
    const {room,a,b}=await create(harness,'auth',false);
    const guest=await connectSocket(room,'guest_watch','Guest');
    guest.send({type:'join',name:'forged'});
    await expect.poll(()=>guest.frames.at(-1)?.message).toContain('Sign in');
    b.send({type:'start'}); await expect.poll(()=>b.frames.at(-1)?.message).toContain('host');
    b.send({type:'join'}); await expect.poll(async()=>(await readRoom(room)).state.players.length).toBe(2);
    expect((await readRoom(room)).state.players[0].name).toBe('Alice');
    const c=await connectSocket(room,'tg_3','Cat'); c.send({type:'join'});
    await expect.poll(()=>c.frames.at(-1)?.message).toContain('full');
    a.send({type:'kick',playerId:'tg_2'}); await expect.poll(async()=>(await readRoom(room)).state.players.length).toBe(1);
    b.send({type:'join'}); await expect.poll(()=>b.frames.at(-1)?.message).toContain('removed');
    a.send({type:'leave'}); await expect.poll(async()=>(await readRoom(room)).state.hostId).toBeNull();
    for(const client of [a,b,c,guest]) client.socket.close();
  });
  it('rejects early, malformed, occupied, duplicate, out-of-turn and stale-round actions',async()=>{
    const {room,a,clients}=await create(harness,'safe');
    let state=await start(room,a,false); const actor=clients[state.game.currentSeat];
    actor.send({type:'place',row:7,col:7,gameId:state.gameId,moveNumber:0});
    await expect.poll(()=>actor.frames.at(-1)?.message).toContain('reveal');
    state.openingUntil=0; await save(room,state);
    for(const payload of ['null','[]','42','{}','not json']) actor.socket.send(payload);
    actor.send({type:'place',row:'7',col:7,gameId:state.gameId,moveNumber:0});
    await expect.poll(()=>actor.frames.at(-1)?.message).toContain('intersection');
    const packet={type:'place',row:7,col:7,gameId:state.gameId,moveNumber:0};
    actor.send(packet); actor.send(packet);
    await expect.poll(async()=>(await readRoom(room)).state.game.moveCount).toBe(1);
    await expect.poll(()=>actor.frames.at(-1)?.message).toContain('board changed');
    const other=clients[1-state.game.currentSeat];
    other.send({...packet,moveNumber:1}); await expect.poll(()=>other.frames.at(-1)?.message).toContain('occupied');
    actor.send({...packet,row:8,moveNumber:1}); await expect.poll(()=>actor.frames.at(-1)?.message).toContain('turn');
    a.send({type:'backToLobby'}); await expect.poll(()=>a.frames.at(-1)?.message).toContain('Finish');
    const watcher=await connectSocket(room,'guest_observer','Observer');
    watcher.send({type:'resign',gameId:state.gameId}); await expect.poll(()=>watcher.frames.at(-1)?.message).toContain('watching');
    a.send({type:'resign',gameId:state.gameId}); await expect.poll(async()=>(await readRoom(room)).state.game.phase).toBe('done');
    a.send({type:'backToLobby'}); await expect.poll(async()=>(await readRoom(room)).state.game).toBeNull();
    await start(room,a);
    actor.send(packet); await expect.poll(()=>actor.frames.at(-1)?.message).toContain('board changed');
    expect((await readRoom(room)).state.game.moveCount).toBe(0);
    for(const client of [...clients,watcher]) client.socket.close();
  });
  it('restores board, colours and seat through replacement and a cold restart',async()=>{
    let {room,a,b,clients}=await create(harness,'cold');
    const before=await start(room,a); await move(room,clients,7,7);
    a=await connectSocket(room,'tg_1','Alice'); clients[0]=a;
    a.send({type:'join'}); await expect.poll(async()=>(await readRoom(room)).state.players[0].connected).toBe(true);
    expect((await readRoom(room)).state.players).toHaveLength(2);
    await harness.restart(); room=await harness.room('cold');
    const restored=(await readRoom(room)).state;
    expect(restored.gameId).toBe(before.gameId); expect(restored.game.blackSeat).toBe(before.game.blackSeat);
    expect(restored.game.board[7][7]).toBe(1); expect(restored.nextStartingSeat).toBe(1-before.game.blackSeat);
    a=await connectSocket(room,'tg_1','Alice'); b=await connectSocket(room,'tg_2','Bob');
    await move(room,[a,b],8,8);
    expect((await readRoom(room)).state.game.board[8][8]).toBe(2);
    a.socket.close(); b.socket.close();
  },15000);
  it('completes a played game once, keeps spectators watching and swaps black on rematch',async()=>{
    const {room,a,clients}=await create(harness,'game'); const before=await start(room,a);
    const watcher=await connectSocket(room,'tg_3','Cat'); watcher.send({type:'join'});
    await expect.poll(()=>watcher.frames.at(-1)?.message).toContain('started');
    await finish(room,clients);
    await expect.poll(async()=>await harness.db.prepare('SELECT COUNT(*) AS n FROM omok_games WHERE game_id = ?').bind(before.gameId).first('n')).toBe(1);
    const done=(await readRoom(room)).state;
    expect(done.game.winningLine).toHaveLength(5); expect(done.lastRating.changes).toHaveLength(2);
    a.send({type:'backToLobby'}); await expect.poll(async()=>(await readRoom(room)).state.game).toBeNull();
    expect((await readRoom(room)).state.players).toHaveLength(2);
    const next=await start(room,a); expect(next.game.blackSeat).toBe(1-before.game.blackSeat);
    for(const client of [...clients,watcher]) client.socket.close();
  },15000);
  it('schedules legal practice bot moves and keeps resignations unrated',async()=>{
    const {room,a,b}=await create(harness,'bots',false);
    a.send({type:'addBot'}); await expect.poll(async()=>(await readRoom(room)).state.players.length).toBe(2);
    const initial=await start(room,a,false);
    const target=initial.game.blackSeat===1?1:2;
    if(initial.game.currentSeat===0) {
      await expect.poll(()=>Date.now()>=initial.openingUntil,{timeout:5000}).toBe(true);
      a.send({type:'place',row:7,col:7,gameId:initial.gameId,moveNumber:0});
    }
    await expect.poll(async()=>(await readRoom(room)).state.game.moveCount,{timeout:6000}).toBe(target);
    const {state}=await readRoom(room); expect(state.game.currentSeat).toBe(0);
    expect(state.game.board.flat().filter((v:number)=>v!==0)).toHaveLength(target);
    a.send({type:'resign',gameId:state.gameId}); await expect.poll(async()=>(await readRoom(room)).state.game.phase).toBe('done');
    expect((await readRoom(room)).state.pendingRatings??[]).toEqual([]);
    expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM omok_games WHERE game_id = ?').bind(state.gameId).first('n')).toBe(0);
    a.send({type:'leave'}); await expect.poll(async()=>(await readRoom(room)).state.players).toEqual([]);
    expect((await readRoom(room)).state.hostId).toBeNull();
    a.socket.close(); b.socket.close();
  },15000);
});

it('durably retries a lost completion acknowledgement across restart without duplicating ratings',async()=>{
  let failed=true;
  const h=await createOmokRoomHarness({gateRatingAck:true,outbound:async request=>{
    if(new URL(request.url).pathname==='/rating-ack'&&failed) return new Response('injected failure',{status:503});
    return Response.json({ok:true});
  }});
  try {
    let {room,a,clients}=await create(h,'retry'); const before=await start(room,a);
    await finish(room,clients);
    await expect.poll(async()=>await h.db.prepare('SELECT COUNT(*) AS n FROM omok_games').first('n')).toBe(1);
    await expect.poll(async()=>(await readRoom(room)).state.pendingRatings?.length).toBe(1);
    const rating=await h.db.prepare('SELECT * FROM omok_ratings ORDER BY telegram_id').all();
    await h.restart(); room=await h.room('retry'); failed=false;
    await fireAlarm(room);
    await expect.poll(async()=>(await readRoom(room)).state.pendingRatings?.length).toBe(0);
    expect((await readRoom(room)).state.lastRating.gameId).toBe(before.gameId);
    expect((await h.db.prepare('SELECT * FROM omok_ratings ORDER BY telegram_id').all()).results).toEqual(rating.results);
    const {state}=await readRoom(room); state.idleSince=Date.now()-31*60*1000; await save(room,state);
    await fireAlarm(room); expect((await readRoom(room)).state).toBeUndefined();
  } finally {await h.stop();}
},20000);

it('merges a delayed old result into the latest lobby without restoring the old roster',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const h=await createOmokRoomHarness({gateRatingAck:true,outbound:async request=>{
    if(new URL(request.url).pathname==='/rating-ack') await gate;
    return Response.json({ok:true});
  }});
  try {
    const {room,a,clients}=await create(h,'late'); await start(room,a); await finish(room,clients);
    await expect.poll(async()=>h.db.prepare('SELECT COUNT(*) AS n FROM omok_games').first('n')).toBe(1);
    a.send({type:'backToLobby'}); await expect.poll(async()=>(await readRoom(room)).state.game).toBeNull();
    a.send({type:'kick',playerId:'tg_2'}); await expect.poll(async()=>(await readRoom(room)).state.players.length).toBe(1);
    a.send({type:'addBot'}); await expect.poll(async()=>(await readRoom(room)).state.players[1]?.isBot).toBe(true);
    release(); await expect.poll(async()=>(await readRoom(room)).state.pendingRatings?.length).toBe(0);
    const {state}=await readRoom(room);
    expect(state.game).toBeNull(); expect(state.players[1].isBot).toBe(true);
    expect(state.lastRating.changes.map((p:any)=>p.name)).toEqual(['Alice','Bob']);
    for(const c of clients)c.socket.close();
  } finally {release();await h.stop();}
},15000);

it('missing Omok schema leaves results queued, retains idle rooms and recovers after local migration',async()=>{
  const h=await createOmokRoomHarness();
  try {
    for(const table of ['omok_group_stats','omok_rating_history','omok_games','omok_ratings']) await h.db.prepare(`DROP TABLE ${table}`).run();
    const {room,a,clients}=await create(h,'miss'); const initial=await start(room,a); await finish(room,clients);
    await expect.poll(async()=>(await readRoom(room)).state.pendingRatings?.length).toBe(1);
    for(const c of clients)c.socket.close();
    await expect.poll(async()=>(await readRoom(room)).state.players.every((p:any)=>!p.connected)).toBe(true);
    const {state}=await readRoom(room);state.idleSince=Date.now()-31*60*1000;await save(room,state);
    await fireAlarm(room);
    expect((await readRoom(room)).state.pendingRatings).toHaveLength(1);
    const sql=await readFile(new URL('../migrations/0016_omok.sql',import.meta.url),'utf8');
    for(const statement of sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean)) await h.db.prepare(statement).run();
    await fireAlarm(room);
    await expect.poll(()=>h.db.prepare('SELECT COUNT(*) AS n FROM omok_games WHERE game_id = ?').bind(initial.gameId).first('n')).toBe(1);
    expect(await h.db.prepare('SELECT COUNT(*) AS n FROM omok_rating_history').first('n')).toBe(2);
  } finally {await h.stop();}
},15000);

it('a stalled old rating cannot delay the next practice bot turn',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let waiting=false;
  const h=await createOmokRoomHarness({gateRatingRead:true,outbound:async request=>{
    if(new URL(request.url).pathname==='/rating-read') {waiting=true;await gate;}
    return Response.json({ok:true});
  }});
  let alarm:Promise<unknown>|undefined;
  try {
    const {room,a,clients}=await create(h,'busy');await start(room,a);await finish(room,clients);
    await expect.poll(()=>waiting).toBe(true);
    a.send({type:'backToLobby'});await expect.poll(async()=>(await readRoom(room)).state.game).toBeNull();
    a.send({type:'kick',playerId:'tg_2'});await expect.poll(async()=>(await readRoom(room)).state.players.length).toBe(1);
    a.send({type:'addBot'});await expect.poll(async()=>(await readRoom(room)).state.players[1]?.isBot).toBe(true);
    const {state:before}=await readRoom(room);before.nextStartingSeat=1;await save(room,before);
    const state=await start(room,a);state.botMoveAt=Date.now()-1;await save(room,state);
    alarm=fireAlarm(room);
    await expect.poll(async()=>(await readRoom(room)).state.game.moveCount,{timeout:1500}).toBe(1);
    const current=(await readRoom(room)).state;
    expect(current.gameId).toBe(state.gameId);expect(current.game.currentSeat).toBe(0);
    expect(current.pendingRatings).toHaveLength(1);
    release();await alarm;
    await expect.poll(async()=>(await readRoom(room)).state.pendingRatings?.length).toBe(0);
    for(const c of clients)c.socket.close();
  }finally{release();await alarm;await h.stop();}
},15000);
