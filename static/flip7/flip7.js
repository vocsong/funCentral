'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const make = (tag, cls, text) => { const n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=text; return n; };
  const names = { freeze:'Freeze',flipThree:'Flip Three',secondChance:'Second Chance' };
  const CONNECTION_TIMEOUT = 8000;
  const TERMINAL_CLOSE_CODES = [4401, 4403, 4404, 4409];
  let profile=null, view=null, socket=null, room='', ready=false, pending=false, generation=0, retry=null, heartbeat=null, timeout=null, leaving=false;
  let connectTimeout=null, retryDelay=1500, terminalClose=false;
  let inspectionKey=null, inspectedId=null, localActionKey=null;
  let seenDeal=null, dealTravel=null;
  const name = id => view?.players.find(p=>p.id===id)?.name || 'Player';
  const me = () => view?.you?.id;
  const host = () => !!me() && view?.hostId===me();
  const seated = () => !!me() && view?.players.some(p=>p.id===me());
  const active = () => ready && !pending && socket?.readyState===WebSocket.OPEN;
  function notice(message) { $('notice').textContent=message; $('notice').hidden=false; clearTimeout(notice.timer); notice.timer=setTimeout(()=>$('notice').hidden=true,6500); }
  function button(label, action, disabled=false, cls='') {const b=make('button',cls,label);b.type='button';b.disabled=disabled;b.onclick=action;return b;}
  function send(type, data={}) {
    if(!active())return false;
    const frame={type,...data};
    if(['hit','stay','target','nextRound','abandon'].includes(type)){if(!view?.game)return false;frame.gameId=view.game.id;frame.revision=view.revision;}
    pending=true;socket.send(JSON.stringify(frame));clearTimeout(timeout);
    timeout=setTimeout(()=>{notice('No response yet. Reconnecting to check the latest state.');connect();},8000);render();return true;
  }
  function stop() {generation++;ready=false;seenDeal=null;endDealTravel();pending=false;clearTimeout(retry);clearTimeout(timeout);clearTimeout(connectTimeout);clearInterval(heartbeat);if(socket){socket.onclose=null;socket.onmessage=null;socket.close();socket=null;}}
  function connect() {
    stop();if(!room || terminalClose || window.FC_MOVED)return;const g=generation;let last=Date.now();
    $('connection').textContent='Connecting…';$('recovery').hidden=true;
    const params=new URLSearchParams({room});const token=FunAuth.token();if(token)params.set('token',token);
    socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/flip7/ws?${params}`);
    const ws=socket;
    connectTimeout=setTimeout(()=>{if(g===generation&&!ready)ws.close();},CONNECTION_TIMEOUT);
    ws.onopen=()=>{if(g!==generation)return;heartbeat=setInterval(()=>{if(Date.now()-last>40000){ws.close();return;}if(ws.readyState===WebSocket.OPEN)ws.send('ping');},15000);};
    ws.onmessage=e=>{
      if(g!==generation)return;last=Date.now();if(e.data==='pong')return;let s;try{s=JSON.parse(e.data);}catch{return;}
      if(s.type==='error'){pending=false;leaving=false;clearTimeout(timeout);notice(s.message||'Action could not be completed.');render();return;}
      if(s.type!=='state'||(view&&s.revision<view.revision))return;
      view=s;ready=true;pending=false;retryDelay=1500;clearTimeout(connectTimeout);clearTimeout(timeout);$('connection').textContent='● Live';
      if(leaving&&!seated()){leaving=false;location.hash='';return;}render();
    };
    ws.onclose=e=>{if(g!==generation)return;ready=false;pending=false;clearTimeout(timeout);clearTimeout(connectTimeout);clearInterval(heartbeat);$('connection').textContent='Offline';render();
      if(TERMINAL_CLOSE_CODES.includes(e.code)){terminalClose=true;$('recovery').hidden=false;$('recovery-message').textContent=e.code===4409?'This room is open in another tab or device.':e.code===4404?'This room no longer exists. Check the code or create a new room.':'Your sign-in needs refreshing. Return home and sign in again.';$('reconnect').hidden=e.code!==4409;}
      else {$('connection').textContent='Reconnecting…';retry=setTimeout(connect,retryDelay);retryDelay=Math.min(retryDelay*2,10000);}
    };
    ws.onerror=()=>{};render();
  }
  // All faces are original CSS artwork; the server owns cards and outcomes.
  function card(value, kind='') {
    const action = kind === 'action';
    const modifier = kind === 'special';
    const label = action ? names[value] : String(value);
    const n = make('div', `card ${kind}${action ? ` action-${value}` : ''}`);
    n.setAttribute('role', 'img');
    n.setAttribute('aria-label', `${label} ${action ? 'action' : modifier ? 'modifier' : 'number'} card`);
    if (!action && !modifier) n.style.setProperty('--card-hue', String((Number(value) * 27 + 175) % 360));
    n.append(make('small', 'card-type', action ? 'ACTION CARD' : modifier ? 'SCORE MODIFIER' : 'NUMBER CARD'));
    if (action) n.append(make('span', 'card-symbol', {freeze:'❄',flipThree:'↻',secondChance:'↺'}[value]));
    n.append(make('span', 'card-face', label));
    const corner = make('small', 'f7-card-corner', action ? 'FLIP 7' : String(value));
    corner.setAttribute('aria-hidden', 'true');
    n.append(corner);
    return n;
  }

  function describeEvent(event) {
    const who = name(event.actorId);
    const action = names[event.card?.type] || 'an action card';
    if (event.type === 'actionDrawn') return `${who} drew ${action}.`;
    if (event.type === 'actionResolved') {
      if (event.disposition === 'discarded') return `${who} discarded ${action}: no eligible player could receive it.`;
      const targetId = event.targetId || event.actorId;
      const target = targetId === event.actorId ? 'themself' : name(targetId);
      const effect = event.card?.type === 'freeze' ? 'They bank their score and stop for this round.'
        : event.card?.type === 'flipThree' ? 'They draw up to three cards, stopping at a Bust or Flip 7.'
        : 'They can discard one duplicate Number Card.';
      return `${who} used ${action} on ${target}. ${effect}`;
    }
    if (event.type === 'secondChanceUsed') return `${who} used Second Chance to discard a duplicate ${event.card?.value}.`;
    if (event.type === 'bust') return `${who} busted on a duplicate ${event.card?.value}. Zero points this round.`;
    return '';
  }

  function renderActivity(game) {
    const events = (game?.events || []).filter(event => describeEvent(event)).slice(-8);
    $('activity').hidden = events.length === 0;
    $('latest-play').hidden = events.length === 0;
    const lastEvent = events[events.length - 1];
    // Older events have no batch; never infer a connection from their order.
    const resolved = lastEvent?.batchId != null && lastEvent.type !== 'actionResolved'
      ? events.slice().reverse().find(event => event.type === 'actionResolved'
        && event.batchId === lastEvent.batchId
        // Resuming dealing can emit an unrelated bust in the same move.
        && (lastEvent.type !== 'bust' || event.id === lastEvent.sourceActionId))
      : undefined;
    const latest = lastEvent ? [resolved ? describeEvent(resolved) : '', describeEvent(lastEvent)].filter(Boolean).join(' ') : '';
    // Presence updates must not re-announce an unchanged play.
    const latestKey = events.length ? `${game.id}:${events[events.length - 1].id}` : '';
    if ($('latest-event').dataset.eventKey !== latestKey) {
      $('latest-event').dataset.eventKey = latestKey;
      $('latest-event').textContent = latest;
    }
    $('activity-list').replaceChildren(...events.slice().reverse().map(event => {
      const li = make('li', '', describeEvent(event));
      li.dataset.eventId = String(event.id);
      return li;
    }));
  }

  function renderAction(game) {
    const area = $('action-spotlight');
    const choice = game?.pending;
    area.hidden = !choice;
    area.replaceChildren();
    if (!choice) return;
    area.dataset.action = choice.type;
    area.append(card(choice.type, 'action'));
    const copy = make('div', 'action-copy');
    copy.append(make('p', 'eyebrow', 'ACTION DRAWN'));
    copy.append(make('h2', '', `${name(choice.actorId)} drew ${names[choice.type]}.`));
    const effects = {
      freeze: 'Freeze makes an active player bank their score and stop for this round.',
      flipThree: 'The chosen player draws up to three cards, stopping at a Bust or Flip 7.',
      secondChance: 'Pass this extra Second Chance to an eligible player. It cancels one duplicate Number Card.',
    };
    copy.append(make('p', '', effects[choice.type]));
    copy.append(make('p', 'selection-hint', choice.actorId === me() && seated()
      ? 'Your choice: select an eligible player below.'
      : `${name(choice.actorId)} is choosing a player. Everyone will see the result.`));
    area.append(copy);
  }
  function updateInspection(defaultId) {
    const selectedId = inspectedId || defaultId;
    for (const seat of $('oval-seats').children) {
      seat.setAttribute('aria-pressed', String(seat.dataset.seatId === selectedId));
    }
    for (const hand of $('players').children) {
      hand.classList.toggle('is-inspected', hand.dataset.playerId === selectedId);
    }
  }

  function revealedFace(draw, busted) {
    const exposed = draw.card;
    const face = exposed.type === 'number' ? card(exposed.value)
      : exposed.type === 'bonus' ? card(`+${exposed.value}`, 'special')
      : exposed.type === 'double' ? card('×2','special') : card(exposed.type,'action');
    face.id = 'revealed-card';
    if (busted) {
      face.classList.add('bust-card');
      face.setAttribute('aria-label', `${exposed.value} duplicate number card · Bust`);
      face.append(make('b','bust-stamp','BUST'));
    }
    return face;
  }

  function endDealTravel() {
    if (!dealTravel) return;
    const { ghost, animation } = dealTravel;
    dealTravel = null;
    ghost.remove();
    animation.cancel();
  }

  function renderDealTravel(table, seats, scope, draw) {
    if (!ready) {
      seenDeal = null;
      endDealTravel();
      return;
    }
    const previous = seenDeal;
    const sameRound = previous?.scope === scope;
    const id = draw?.id ?? 0;
    seenDeal = { scope, id: sameRound ? Math.max(previous.id, id) : id };
    if (!sameRound || !draw) {
      endDealTravel();
      return;
    }
    if (id <= previous.id) return;
    endDealTravel();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const target = [...seats.children].find(seat => seat.dataset.seatId === draw.actorId);
    const deck = table.querySelector('.f7-deck-back');
    if (!target || !deck?.animate) return;
    const origin = table.getBoundingClientRect();
    const source = deck.getBoundingClientRect();
    const destination = target.getBoundingClientRect();
    const dx = destination.left + (destination.width - source.width) / 2 - source.left;
    const dy = destination.top + (destination.height - source.height) / 2 - source.top;
    const ghost = make('div','f7-deck-back f7-deal-ghost','7');
    ghost.setAttribute('aria-hidden','true');
    ghost.style.left = `${source.left - origin.left}px`;
    ghost.style.top = `${source.top - origin.top}px`;
    table.append(ghost);
    const animation = ghost.animate([
      { transform:'translate(0px, 0px) scale(1)', opacity:1 },
      { transform:`translate(${dx * .55}px, ${dy * .55 - 9}px) scale(.82)`, opacity:1, offset:.58 },
      { transform:`translate(${dx}px, ${dy}px) scale(.55)`, opacity:0 },
    ], { duration:360, easing:'cubic-bezier(.19,.55,.31,1)' });
    dealTravel = {ghost, animation};
    const remove = () => {
      ghost.remove();
      if (dealTravel?.ghost === ghost) dealTravel = null;
    };
    animation.finished.then(remove,remove);
  }

  function renderOval(game) {
    const table = $('oval-table');
    const seats = $('oval-seats');
    const deck = $('deck-count');
    const caption = $('reveal-caption');
    const slot = $('deal-face');
    table.hidden = $('hand-guide').hidden = !game;
    const choice = game?.pending;
    const matchingAction = !!(choice && game.lastDraw?.actorId === choice.actorId && game.lastDraw.card.type === choice.type);
    $('action-spotlight').classList.toggle('f7-centre-has-action', matchingAction);
    $('latest-play').classList.toggle('f7-repeated-action', !!(matchingAction
      && $('latest-event').textContent === `${name(choice.actorId)} drew ${names[choice.type]}.`));
    $('players').classList.toggle('f7-in-play', !!game);
    $('players').classList.toggle('f7-crowded', (game?.players.length || 0) > 6);
    if (!game) {
      inspectionKey = inspectedId = localActionKey = seenDeal = null;
      endDealTravel();
      seats.replaceChildren();
      slot.replaceChildren();
      delete slot.dataset.drawKey;
      caption.textContent = '';
      return;
    }
    const key = `${view.roomCode}:${game.id}`;
    if (key !== inspectionKey || !game.players.some(p => p.id === inspectedId)) inspectedId = null;
    inspectionKey = key;
    const ownSeat = game.players.findIndex(p => p.id === me());
    // Use gameplay evidence, not room revisions or connectivity, to detect a new decision.
    const nextActionKey = ownSeat === -1 ? null
      : choice ? (choice.actorId === me() ? `${game.round}:target:${choice.type}:${game.events?.at(-1)?.id ?? ''}` : null)
      : game.phase === 'playing' && game.turnId === me() && game.players[ownSeat].status === 'active'
        ? `${game.round}:turn:${game.lastDraw?.id ?? ''}` : null;
    if (nextActionKey && nextActionKey !== localActionKey) inspectedId = null;
    localActionKey = nextActionKey;
    const dealerSeat = game.players.findIndex(p => p.id === game.dealerId);
    const anchor = ownSeat !== -1 ? ownSeat : Math.max(0, dealerSeat);
    const players = [...game.players.slice(anchor), ...game.players.slice(0,anchor)];
    const draw = game.lastDraw;
    const drawPlayer = draw && game.players.find(p => p.id === draw.actorId);
    const bust = !!(drawPlayer?.status === 'busted' && draw.card.type === 'number'
      && drawPlayer.bustCard?.value === draw.card.value);
    const count = `${game.deckCount} ${game.deckCount === 1 ? 'card' : 'cards'}`;
    if (deck.textContent !== count) deck.textContent = count;
    const drawKey = draw ? `${key}:${game.round}:${draw.id}:${bust}` : '';
    const message = draw ? (bust ? `${name(draw.actorId)} busted on ${draw.card.value}.` : `${name(draw.actorId)} drew ${draw.card.type === 'number' ? draw.card.value : draw.card.type === 'bonus' ? `+${draw.card.value}` : draw.card.type === 'double' ? '×2' : names[draw.card.type]}.`) : 'No card revealed yet.';
    if (slot.dataset.drawKey !== drawKey) {
      slot.dataset.drawKey = drawKey;
      slot.replaceChildren(draw ? revealedFace(draw,bust) : make('div','f7-card-placeholder','?'));
    }
    if (caption.textContent !== message) caption.textContent = message;
    const defaultId = game.players[ownSeat]?.id || draw?.actorId || game.events?.at(-1)?.actorId
      || game.turnId || game.dealerId || players[0]?.id;
    const focusedSeat = seats.contains(document.activeElement) ? document.activeElement.dataset.seatId : null;
    const crowded = players.length > 6;
    const previewLimit = crowded ? 2 : 3;
    table.classList.toggle('f7-many-seats', crowded);
    seats.replaceChildren(...players.map((p,i) => {
      const angle = (ownSeat === -1 ? Math.PI : 0) + (2 * Math.PI * i / players.length);
      const participant = view.players.find(item => item.id === p.id);
      const eligible = !!game.pending?.targets.includes(p.id);
      const current = game.turnId === p.id;
      const chooser = game.pending?.actorId === p.id;
      const dealer = game.dealerId === p.id;
      const seat = button('', () => { inspectedId=p.id; updateInspection(defaultId); }, false, 'f7-seat');
      seat.dataset.seatId = p.id;
      seat.style.setProperty('--seat-x', String(-Math.sin(angle)));
      seat.style.setProperty('--seat-y', String(Math.cos(angle)));
      seat.classList.toggle('f7-seat-current', current || chooser);
      seat.classList.toggle('f7-seat-eligible', eligible);
      seat.classList.toggle('f7-seat-busted', p.status === 'busted');
      const displayName = name(p.id);
      const labels = [p.id === me() ? 'You' : '', dealer ? 'Dealer' : '', current ? 'Current turn' : '',
        chooser ? 'Choosing target' : '', eligible ? 'Eligible target' : '', p.status !== 'active' ? p.status : '', participant?.connected === false ? 'Offline' : ''];
      seat.setAttribute('aria-label',[displayName,...labels.filter(Boolean)].join(', '));
      seat.title = [displayName,...labels.filter(Boolean)].join(' · ');
      const dot = make('span','f7-seat-dot',dealer ? 'D' : current ? '●' : p.id === me() ? 'YOU' : chooser ? '!' : eligible ? '◇' : p.status === 'busted' ? '×' : '');
      dot.setAttribute('aria-hidden','true');
      const heading = make('span','f7-seat-heading');
      heading.append(make('span','f7-seat-name',displayName),dot);
      seat.append(heading);
      const ranks = [...p.numbers.map(String),...p.bonuses.map(n => `+${n}`),...(p.doubled ? ['×2'] : []),...(p.secondChance ? ['↺'] : []),...(p.bustCard ? [String(p.bustCard.value)] : [])];
      const preview = make('span','f7-seat-preview');
      preview.setAttribute('aria-hidden','true');
      for (const rank of ranks.slice(0,previewLimit)) preview.append(make('span','f7-rank',rank));
      if (ranks.length > previewLimit) preview.append(make('span','f7-rank-more',`+${ranks.length-previewLimit}`));
      if (!ranks.length) preview.append(make('span','f7-rank-empty','—'));
      seat.append(preview);
      return seat;
    }));
    updateInspection(defaultId);
    if (focusedSeat) [...seats.children].find(seat => seat.dataset.seatId === focusedSeat)?.focus({preventScroll:true});
    renderDealTravel(table,seats,`${key}:${game.round}`,draw);
  }

  function render() {
    $('home').hidden=!!room;$('room').hidden=!room;if(!view||!room)return;
    $('code').textContent=view.roomCode;$('watchers').textContent=`${view.watchers||0} watching · ${view.players.length}/${view.maxPlayers||12} seats`;
    const game=view.game;renderActivity(game);renderAction(game);const roster=$('players');roster.replaceChildren();
    for(const p of view.players){const gp=game?.players.find(x=>x.id===p.id);const tile=make('article',`player ${gp?.status||''} ${game?.turnId===p.id?'current':''}`);tile.dataset.playerId=p.id;
      const eligible = !!game?.pending?.targets.includes(p.id);
      tile.classList.toggle('eligible-target', eligible);
      tile.classList.toggle('action-chooser', game?.pending?.actorId === p.id);
      const head=make('div','player-head');head.append(make('span','avatar',p.name.slice(0,2).toUpperCase()));const info=make('div');info.append(make('div','player-name',p.name+(p.id===me()?' · you':'')),make('div','status',[p.id===view.hostId?'Host':null,p.connected?'Connected':'Offline',gp?.status,game?.turnId===p.id?'Taking a turn':null].filter(Boolean).join(' · ')));head.append(info);
      if(gp){const score=make('div','player-score',String(gp.roundScore));score.append(make('small','',gp.status==='busted'?'BUSTED':'THIS ROUND'));head.append(score);}
      tile.append(head);
      if(gp){const cards=make('div','cards');for(const n of gp.numbers)cards.append(card(n));for(const n of gp.bonuses)cards.append(card(`+${n}`,'special'));if(gp.doubled)cards.append(card('×2','special'));if(gp.secondChance)cards.append(card('secondChance','action'));if(gp.bustCard){const duplicate=card(gp.bustCard.value);duplicate.classList.add('bust-card');duplicate.setAttribute('aria-label',`${gp.bustCard.value} duplicate number card · Bust`);duplicate.append(make('b','bust-stamp','BUST'));cards.append(duplicate);}if(!cards.children.length)cards.append(make('span','empty-cards','Waiting for the first card.'));tile.append(cards);if(gp.bustCard)tile.append(make('p','bust-explanation',`Duplicate ${gp.bustCard.value} · 0 points this round`));}
      if(eligible)tile.append(make('span','target-label','Eligible target'));
      if(game?.pending?.actorId===p.id)tile.append(make('span','chooser-label','Choosing an action target'));
      if(host()&&!game&&p.id!==me())tile.append(button('Remove '+p.name,()=>send('kick',{playerId:p.id}),!active(),'quiet danger'));roster.append(tile);
    }
    renderOval(game);
    $('standings').replaceChildren();const standings=game?[...game.players].sort((a,b)=>b.total-a.total):view.players.map(p=>({id:p.id,total:0}));standings.forEach((p,i)=>{const row=make('div','standing');row.append(make('span','',`${i+1}. ${name(p.id)}`),make('b','',String(p.total)));$('standings').append(row);});
    const actions=$('actions');actions.replaceChildren();$('summary').hidden=true;$('abandon').hidden=!(host()&&game&&!['finished'].includes(game.phase));$('abandon').disabled=!active();
    if(!game){$('round-label').textContent='THE TABLE IS OPEN';$('headline').textContent='Take a seat.';$('hint').textContent=`Invite your friends. ${view.minPlayers||3} connected players needed to start.`;
      if(!seated()&&profile&&!view.you?.removed)actions.append(button('Take a seat',()=>send('join'),!active()||view.players.length>=(view.maxPlayers||12),'primary'));
      if(!profile)actions.append(make('p','','Watching as a guest. Sign in from the home page to play.'));
      if(view.you?.removed)actions.append(make('p','','The host removed your seat. You can keep watching.'));
      if(host())actions.append(button('Start game',()=>send('start'),!active()||view.players.length<(view.minPlayers||3)||view.players.some(p=>!p.connected),'primary'));
      else if(seated())actions.append(make('p','','Waiting for the host to start the game.'));return;
    }
    $('round-label').textContent=`ROUND ${game.round} / RACE TO 200 · ${game.deckCount} CARDS LEFT`;
    if(game.phase==='finished'||game.phase==='roundEnd'){
      const best=Math.max(...game.players.map(p=>p.total));const winners=game.players.filter(p=>p.total===best).map(p=>name(p.id));
      $('headline').textContent=game.phase==='finished'?(winners.length>1?`${winners.join(' & ')} tie!`:`${winners[0]} wins!`):'Banked. Busted. Next?';
      $('hint').textContent=game.phase==='finished'?'Final totals are in. Thanks for playing.':'Round complete. Everyone’s total has been updated.';
      $('summary').hidden=false;$('summary').textContent=game.flippedBy?`${name(game.flippedBy)} flipped seven! +15 bonus points.`:game.phase==='finished'?`${best} points takes the game.`:'A fresh round means a fresh chance.';
      if(host())actions.append(game.phase==='finished'?button('Back to lobby',()=>send('lobby'),!active(),'primary'):button(`Start round ${game.round+1}`,()=>send('nextRound'),!active(),'primary'));else actions.append(make('p','','Waiting for the host.'));return;
    }
    const gp=game.players.find(p=>p.id===me());const yourTurn=seated()&&game.turnId===me()&&gp?.status==='active';
    if(game.pending){const p=game.pending;$('headline').textContent=`${names[p.type]||'Action card'}.`;$('hint').textContent=`${name(p.actorId)} chooses who receives this card.`;
      if(p.actorId===me()&&seated()){actions.append(make('p','',`Choose a player for ${names[p.type]||'this card'}.`));for(const id of p.targets)actions.append(button(`Choose ${name(id)}`,()=>send('target',{playerId:id}),!active(),'primary'));}
      else actions.append(make('p','','Waiting for the action card to be resolved.'));return;
    }
    $('headline').textContent=yourTurn?'One more card?':`${name(game.turnId)} is up.`;
    $('hint').textContent=yourTurn?'Trust your luck. Or take the points.':seated()?'Watch the table. Your next turn is coming.':'You’re watching this game. Join the next game from the lobby.';
    const allowed=active()&&yourTurn&&game.phase==='playing';
    actions.append(button('Hit · draw a card',()=>send('hit'),!allowed,'primary'),button(`Stay · bank ${gp?.roundScore||0}`,()=>send('stay'),!allowed||!(gp.numbers.length||gp.bonuses.length||gp.doubled||gp.secondChance)));
    if(pending)actions.append(make('p','','Confirming your move…'));
  }
  function navigate(){stop();view=null;leaving=false;terminalClose=false;retryDelay=1500;room=location.hash.slice(1).split(':')[0].toUpperCase();if(!/^[A-Z0-9]{4}$/.test(room))room='';$('home').hidden=!!room;$('room').hidden=!room;$('recovery').hidden=true;if(room)connect();}
  $('rules-open').onclick=()=>$('rules').showModal();$('rules-close').onclick=()=>$('rules').close();
  $('join-form').onsubmit=e=>{e.preventDefault();const code=$('room-input').value.trim().toUpperCase();if(/^[A-Z0-9]{4}$/.test(code)){if(location.hash==='#'+code)navigate();else location.hash=code;}else notice('Enter a four-character room code.');};
  $('create').onclick=async()=>{const b=$('create');b.disabled=true;try{const r=await fetch('/api/flip7/create',{method:'POST',headers:{Authorization:`Bearer ${FunAuth.token()}`},signal:AbortSignal.timeout(10000)});const d=await r.json();if(!r.ok||!/^[A-Z0-9]{4}$/.test(d.roomCode||''))throw Error(d.error||'Could not create a room.');location.hash=d.roomCode;}catch(e){notice(e.message);}finally{b.disabled=false;}};
  $('invite').onclick=async()=>{const url=`${location.origin}/flip7/#${room}`;try{await navigator.clipboard.writeText(url);notice('Invite link copied.');}catch{notice(`Share this room code: ${room}`);}};
  $('leave').onclick=()=>{if(!seated()){location.hash='';return;}if(view.game&&view.game.phase!=='finished'){if(confirm('Return home? Your seat stays in this game. Reopen the invite with the same sign-in to reconnect.'))location.hash='';return;}if(pending)return;if(!ready){if(confirm('Leave without giving up your seat? Reopen the invite to reconnect.'))location.hash='';return;}leaving=send('leave');};
  $('abandon').onclick=()=>{const revision=view?.revision;const id=view?.game?.id;if(confirm('End this game for everyone and return to the lobby?')&&view?.revision===revision&&view?.game?.id===id)send('abandon');};
  $('reconnect').onclick=()=>{terminalClose=false;retryDelay=1500;connect();};window.addEventListener('hashchange',navigate);window.addEventListener('online',()=>{if(room&&!ready)connect();});window.addEventListener('pagehide',stop);
  window.addEventListener('pageshow',e=>{if(e.persisted&&room)connect();});
  async function auth(){profile=await FunAuth.profile();$('identity').textContent=profile?.offline?'Sign-in could not be checked. Please reconnect.':profile?`Playing as ${profile.displayName||'you'}`:'Sign in once. Play across funCentral.';$('signed-in').hidden=!profile||!!profile.offline;$('login').hidden=!!profile; if(!profile)await FunAuth.mountLogin($('login'),()=>{auth();if(room)connect();});render();}
  navigate();auth();
})();
