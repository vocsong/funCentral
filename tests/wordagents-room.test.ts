import {beforeAll,afterAll,it,expect} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
let mf: Miniflare, room: any, ns: any;
beforeAll(async()=>{
 const {outputFiles}=await build({stdin:{contents:`export {WordAgentsRoom} from './src/wordagents/room'; export default {fetch(){return new Response('test')}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:*']});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:outputFiles[0].text,compatibilityDate:'2024-12-01',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'WordAgentsRoom',useSQLite:true}}}));
 await mf.ready;ns=await mf.getDurableObjectNamespace('ROOM');room=ns.get(ns.idFromName('game'));
 await room.fetch('https://test/create',{method:'POST',body:JSON.stringify({roomCode:'ABCD'})});
},30000);
afterAll(async()=>{await mf?.dispose()});
async function connect(id:string,stub:any=room){const r=await stub.fetch(`https://test/?playerId=${id}&name=Player${id}`,{headers:{Upgrade:'websocket'}});const ws=r.webSocket;ws.accept();const frames:any[]=[];ws.addEventListener('message',(e:any)=>frames.push(JSON.parse(e.data)));return {ws,frames,send:(m:unknown)=>ws.send(JSON.stringify(m)),state:()=>frames.filter(f=>f.type==='state').at(-1)};}
function expectAllocation(players: any[], size: number) {
 const sizes = ['red','blue'].map(team => {
  const members = players.filter(p => p.team === team);
  expect(members.filter(p => p.role === 'spymaster')).toHaveLength(1);
  expect(members.filter(p => p.role === 'operative')).toHaveLength(members.length - 1);
  return members.length;
 });
 expect(players).toHaveLength(size);
 expect(new Set(players.map(p => p.id)).size).toBe(size);
 expect(sizes.sort((a,b) => a-b)).toEqual([Math.floor(size/2), Math.ceil(size/2)]);
}
it('enforces membership, roles, secret views, version guards and reconnect authority',async()=>{
 const clients=[];
 for(let i=1;i<=4;i++){
  const c=await connect(`tg_${i}`);clients.push(c);c.send({type:'join'});
  await expect.poll(()=>c.state()?.players.length).toBe(i);
  expect(c.state().you).toMatchObject({team:null,role:null});
  if(i===3){
   clients[0].send({type:'start'});
   await expect.poll(()=>clients[0].frames.some(f=>f.message?.includes('At least four'))).toBe(true);
  }
 }
 const guest=await connect('guest_x');guest.send({type:'join'});await expect.poll(()=>guest.frames.some(f=>f.message?.includes('Sign in'))).toBe(true);
 clients[0].send({type:'start'});await expect.poll(()=>clients[0].state()?.game?.phase).toBe('clue');
 await expect.poll(()=>clients.every(c=>c.state()?.game?.cards.length===25)).toBe(true);
 await expect.poll(()=>guest.state()?.game?.cards.length).toBe(25);
 const s=clients[0].state();
 expectAllocation(s.players,4);
 for(const c of clients) expect(c.state().game.cards.every((card:any)=>(card.color!==null)===(c.state().you.role==='spymaster'))).toBe(true);
 expect(guest.state().game.cards.every((c:any)=>c.color===null)).toBe(true);
 const master=clients.find(c=>c.state().you.team===s.game.turn&&c.state().you.role==='spymaster')!;
 const op=clients.find(c=>c.state().you.team===s.game.turn&&c.state().you.role==='operative')!;
 op.send({type:'choose',team:s.game.turn,role:'spymaster'});await expect.poll(()=>op.frames.some(f=>f.message?.includes('assigned when a round starts'))).toBe(true);
 expect(op.state().you.role).toBe('operative');
 op.send({type:'clue',word:'Conceptual',count:1,gameId:s.game.id,revision:s.revision});await expect.poll(()=>op.frames.some(f=>f.message?.includes('Only the spymaster'))).toBe(true);
 master.send({type:'clue',word:'Conceptual',count:1,gameId:s.game.id,revision:s.revision});await expect.poll(()=>op.state().game.phase).toBe('guess');
 const t=op.state(),idx=master.state().game.cards.findIndex((c:any)=>c.color===t.game.turn);const action={type:'guess',index:idx,gameId:t.game.id,revision:t.revision};op.send(action);op.send(action);
 await expect.poll(()=>op.state().game.cards.filter((c:any)=>c.revealed).length).toBe(1);await expect.poll(()=>op.frames.some(f=>f.message?.includes('board changed'))).toBe(true);
 const beforeReconnect=op.state().you;
 const re=await connect(beforeReconnect.id);re.send({type:'sync'});await expect.poll(()=>re.state()?.game.cards.filter((c:any)=>c.revealed).length).toBe(1);expect(re.state().you).toEqual(beforeReconnect);
 for(const c of [...clients,guest,re])c.ws.close();
 await new Promise(resolve=>setTimeout(resolve,100));
 const returning=await connect('tg_3'); returning.send({type:'sync'});
 await expect.poll(()=>returning.state()?.hostId).toBe('tg_3');
 // The chosen host gets the room back on reconnect; the stand-in was only temporary.
 const original=await connect('tg_1');original.send({type:'sync'});await expect.poll(()=>returning.state()?.hostId).toBe('tg_1');
 returning.ws.close();original.ws.close();
},30000);

it('keeps rejoins and marks off the board revision, assigns teams at start, blocks removed and late joiners, and reassigns at rematch',async()=>{
 const stub=ns.get(ns.idFromName('second'));await stub.fetch('https://test/create',{method:'POST',body:JSON.stringify({roomCode:'WXYZ'})});
 const c:any[]=[];for(let i=1;i<=6;i++){const x=await connect(`tg_${10+i}`,stub);c.push(x);x.send({type:'join'});await expect.poll(()=>x.state()?.players.length).toBe(i);}
 const host=c[0];const rev=host.state().revision;
 c[1].send({type:'join'});c[1].send({type:'sync'});await expect.poll(()=>c[1].frames.filter((f:any)=>f.type==='state').length).toBeGreaterThan(2);
 expect(c[1].state().revision).toBe(rev);
 const guest=await connect('guest_watch',stub);await expect.poll(()=>host.state()?.watchers).toBe(1);
 c[1].send({type:'start'});await expect.poll(()=>c[1].frames.some((f:any)=>f.message?.includes('Only the host'))).toBe(true);
 host.send({type:'randomize'});await expect.poll(()=>host.frames.some((f:any)=>f.message?.includes('assigned when a round starts'))).toBe(true);
 expect(host.state().players.every((p:any)=>p.team===null&&p.role===null)).toBe(true);
 host.send({type:'kick',playerId:'tg_16'});await expect.poll(()=>host.state().players.length).toBe(5);
 await expect.poll(()=>c[5].state().you.removed).toBe(true);
 c[5].send({type:'join'});await expect.poll(()=>c[5].frames.some((f:any)=>f.message?.includes('removed you'))).toBe(true);
 host.send({type:'start'});await expect.poll(()=>host.state()?.game?.phase).toBe('clue');
 expectAllocation(host.state().players,5);
 const late=await connect('tg_99',stub);late.send({type:'join'});await expect.poll(()=>late.frames.some((f:any)=>f.message?.includes('round is on the board'))).toBe(true);
 const byId=(id:string)=>c[Number(id.slice(3))-11];
 const s=host.state(),turn=s.game.turn,players=s.players.filter((p:any)=>p.team===turn);
 const spy=byId(players.find((p:any)=>p.role==='spymaster').id),op=byId(players.find((p:any)=>p.role==='operative').id);
 spy.send({type:'clue',word:'Conceptual',count:2,gameId:s.game.id,revision:s.revision});await expect.poll(()=>op.state().game.phase).toBe('guess');
 const g=op.state(),key=spy.state().game.cards;
 spy.send({type:'mark',index:0,gameId:g.game.id});await expect.poll(()=>spy.frames.some((f:any)=>f.message?.includes('mark cards'))).toBe(true);
 op.send({type:'mark',index:3,gameId:g.game.id});await expect.poll(()=>guest.state().game.marks).toEqual([{playerId:op.state().you.id,index:3}]);
 expect(op.state().revision).toBe(g.revision);
 op.send({type:'guess',index:key.findIndex((k:any)=>k.color==='assassin'),gameId:g.game.id,revision:g.revision});
 await expect.poll(()=>guest.state().game.phase).toBe('finished');
 expect(guest.state().game.endReason).toBe('assassin');expect(guest.state().game.cards.every((k:any)=>k.color)).toBe(true);
 const finished=host.state();
 // Removing a prior spymaster guarantees a valid rematch cannot reuse assignments,
 // without relying on independent draws returning different roles by chance.
 const outgoing = finished.players.find((p:any)=>p.role==='spymaster'&&p.id!==host.state().you.id);
 byId(outgoing.id).send({type:'leave'});
 await expect.poll(()=>host.state().players.length).toBe(4);
 host.send({type:'start'});
 await expect.poll(()=>host.state().game?.id).not.toBe(finished.game.id);
 expect(host.state().game.phase).toBe('clue');
 expectAllocation(host.state().players,4);
 expect(host.state().players.some((p:any)=>p.id===outgoing.id)).toBe(false);
 expect(finished.players.filter((p:any)=>p.role==='operative').some((p:any)=>host.state().players.find((q:any)=>q.id===p.id)?.role==='spymaster')).toBe(true);
 for(const x of [...c,guest,late])x.ws.close();
},30000);

it('includes every seated player and requires them online for the next mission',async()=>{
 const stub=ns.get(ns.idFromName('third'));await stub.fetch('https://test/create',{method:'POST',body:JSON.stringify({roomCode:'BNCH'})});
 const c:any[]=[];for(let i=1;i<=5;i++){const x=await connect(`tg_${30+i}`,stub);c.push(x);x.send({type:'join'});await expect.poll(()=>x.state()?.players.length).toBe(i);}
 c[0].send({type:'start'});await expect.poll(()=>c[4].state()?.game?.phase).toBe('clue');
 expect(c[4].state().you.team).not.toBeNull();
 expectAllocation(c[4].state().players,5);
 c[3].ws.close();await expect.poll(()=>c[0].state().players.find((p:any)=>p.id==='tg_34').connected).toBe(false);
 c[1].send({type:'abandon'});await expect.poll(()=>c[1].frames.some((f:any)=>f.message?.includes('Only the host can end'))).toBe(true);
 c[0].send({type:'abandon'});await expect.poll(()=>c[0].state().game).toBeNull();
 expect(c[0].state().players.every((p:any)=>p.team===null&&p.role===null)).toBe(true);
 c[0].send({type:'start'});await expect.poll(()=>c[0].frames.some((f:any)=>f.message?.includes('Everyone in the room must be connected'))).toBe(true);
 c[0].send({type:'kick',playerId:'tg_34'});
 await expect.poll(()=>c[0].state().players.length).toBe(4);
 c[0].send({type:'start'});await expect.poll(()=>c[0].state().game?.phase).toBe('clue');
 for(const x of [c[0],c[1],c[2],c[4]])x.ws.close();
},30000);
