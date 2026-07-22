'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const SERVER_PATH = path.join(ROOT, 'server.js');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const SERVER_MARKER = 'SIVEL_SERVER_AUTHORITY_V55';
const CLIENT_MARKER = 'SIVEL_SERVER_AUTHORITY_CLIENT_V55';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`V55 patch could not find ${label}. The project version is not compatible with this patch.`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`V55 patch found more than one ${label}; refusing an ambiguous change.`);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function patchServer(source) {
  if (source.includes(SERVER_MARKER)) return source;

  source = replaceOnce(
    source,
    "'use strict';",
    "'use strict';\n\n// SIVEL_SERVER_AUTHORITY_V55 — server owns deadlines, actions, cards, pots, and outcomes.",
    'server authority marker'
  );


  source = replaceOnce(
    source,
`function clearTurnTimer(room) {
  if (room.game && room.game.turnTimer) clearTimeout(room.game.turnTimer);
  if (room.game) room.game.turnTimer = null;
}

function armTurnTimer(room) {
  clearTurnTimer(room);
  const game = room.game;
  if (!game || game.handOver || game.phase !== 'betting' || game.currentActor == null) return;
  game.turnDeadline = Date.now() + TURN_MS;
  const actor = game.currentActor;
  const handId = game.handId;
  const gameRef = game;
  game.turnTimer = setTimeout(() => {
    if (room.game !== gameRef || !room.game || room.game.handOver || room.game.phase !== 'betting' || room.game.handId !== handId || room.game.currentActor !== actor) return;
    const owed = amountToCall(room, actor);
    const player = room.players[actor];
    if (owed === 0) {
      player.acted = true;
      log(room, \`${'${player.name}'} checks after the turn timer expires.\`);
    } else {
      player.folded = true;
      player.acted = true;
      log(room, \`${'${player.name}'} folds after the turn timer expires.\`);
    }
    afterAction(room, actor);
  }, TURN_MS + 25);
}`,
`function clearTurnTimer(room) {
  if (room.game && room.game.turnTimer) clearTimeout(room.game.turnTimer);
  if (room.game) {
    room.game.turnTimer = null;
    room.game.turnDeadline = 0;
  }
}

function expireTurn(room, expected = {}) {
  const game = room.game;
  if (!game || game.handOver || game.phase !== 'betting' || game.currentActor == null) return false;
  if (expected.gameRef && game !== expected.gameRef) return false;
  if (expected.handId != null && Number(game.handId) !== Number(expected.handId)) return false;
  if (expected.turnId != null && Number(game.turnId) !== Number(expected.turnId)) return false;
  if (expected.actor != null && Number(game.currentActor) !== Number(expected.actor)) return false;
  const actor = game.currentActor;
  const player = room.players[actor];
  if (!player || !player.inHand || player.folded || player.allIn) return false;
  clearTurnTimer(room);
  player.folded = true;
  player.acted = true;
  log(room, \`${'${player.name}'} folds after the turn timer expires.\`);
  afterAction(room, actor);
  return true;
}

function armTurnTimer(room) {
  clearTurnTimer(room);
  const game = room.game;
  if (!game || game.handOver || game.phase !== 'betting' || game.currentActor == null) return;
  game.turnId = Number(game.turnId || 0) + 1;
  game.turnDeadline = Date.now() + TURN_MS;
  const expected = { gameRef: game, actor: game.currentActor, handId: game.handId, turnId: game.turnId };
  game.turnTimer = setTimeout(() => expireTurn(room, expected), Math.max(0, game.turnDeadline - Date.now() + 25));
  if (game.turnTimer.unref) game.turnTimer.unref();
  broadcast(room);
}`,
    'authoritative turn timer'
  );

  source = replaceOnce(
    source,
`    result: null,
    turnDeadline: 0,
    turnTimer: null`,
`    result: null,
    turnDeadline: 0,
    turnId: 0,
    turnTimer: null`,
    'initial turn identifier'
  );

  source = replaceOnce(
    source,
`  game.result = null;
  game.turnDeadline = 0;

  for (const p of room.players) {`,
`  game.result = null;
  game.turnDeadline = 0;
  game.turnId = 0;

  for (const p of room.players) {`,
    'per-hand turn reset'
  );

  source = replaceOnce(
    source,
`  broadcast(room);
  if (actionable(room).length < 2) runoutAndShowdown(room, handId);
  else armTurnTimer(room);`,
`  if (actionable(room).length < 2) runoutAndShowdown(room, handId);
  else armTurnTimer(room);`,
    'opening-turn broadcast order'
  );

  source = replaceOnce(
    source,
`  game.currentActor = next;
  game.status = \`${'${room.players[next].name}'} to act\`;
  broadcast(room);
  armTurnTimer(room);`,
`  game.currentActor = next;
  game.status = \`${'${room.players[next].name}'} to act\`;
  armTurnTimer(room);`,
    'next-turn broadcast order'
  );

  source = replaceOnce(
    source,
`  game.phase = 'betting';
  game.status = \`${'${capitalize(game.street)}'} · ${'${room.players[game.currentActor].name}'} to act\`;
  broadcast(room);
  armTurnTimer(room);`,
`  game.phase = 'betting';
  game.status = \`${'${capitalize(game.street)}'} · ${'${room.players[game.currentActor].name}'} to act\`;
  armTurnTimer(room);`,
    'street-turn broadcast order'
  );

  source = replaceOnce(
    source,
`  const type = String(payload.type || '').toLowerCase();
  const owed = amountToCall(room, index);
  clearTurnTimer(room);

  if (type === 'fold') {`,
`  const type = String(payload.type || '').toLowerCase();
  const owed = amountToCall(room, index);
  if (!Number.isInteger(Number(payload.handId)) || Number(payload.handId) !== Number(game.handId)) throw new Error('That action belongs to an older hand.');
  if (!Number.isInteger(Number(payload.turnId)) || Number(payload.turnId) !== Number(game.turnId)) throw new Error('That turn has already advanced.');
  if (!game.turnDeadline || Date.now() >= Number(game.turnDeadline)) {
    expireTurn(room, { gameRef: game, actor: index, handId: game.handId, turnId: game.turnId });
    throw new Error('Time expired. Your hand was folded by the server.');
  }
  clearTurnTimer(room);

  if (type === 'fold') {`,
    'stale and late action rejection'
  );

  source = replaceOnce(
    source,
`  } else if (type === 'call' || type === 'check') {
    const paid = commit(room, index, owed);
    p.acted = true;
    log(room, paid ? \`${'${p.name}'} calls ${'${paid}'}${"${p.allIn ? ' and is all-in' : ''}"}.\` : \`${'${p.name}'} checks.\`);
  } else if (type === 'raise') {`,
`  } else if (type === 'check') {
    if (owed !== 0) throw new Error('You cannot check while facing a bet.');
    p.acted = true;
    log(room, \`${'${p.name}'} checks.\`);
  } else if (type === 'call') {
    if (owed <= 0) throw new Error('There is no bet to call.');
    const paid = commit(room, index, owed);
    p.acted = true;
    log(room, \`${'${p.name}'} calls ${'${paid}'}${"${p.allIn ? ' and is all-in' : ''}"}.\`);
  } else if (type === 'raise') {`,
    'strict check and call validation'
  );

  source = replaceOnce(
    source,
`    const requested = clampInt(payload.total, bounds.minTotal, bounds.maxTotal, bounds.minTotal);
    const target = Math.max(bounds.minTotal, Math.min(requested, bounds.maxTotal));`,
`    const requested = Number(payload.total);
    if (!Number.isInteger(requested)) throw new Error('Enter a valid whole-chip raise total.');
    if (requested < bounds.minTotal || requested > bounds.maxTotal) throw new Error(\`Raise total must be between ${'${bounds.minTotal}'} and ${'${bounds.maxTotal}'}.\`);
    const target = requested;`,
    'strict raise validation'
  );

  source = replaceOnce(
    source,
`  if (contenders(room).length === 1) {
    awardUncontested(room, contenders(room)[0]);
    return;
  }`,
`  if (contenders(room).length === 1) {
    const foldedPlayer = room.players[index] && room.players[index].folded ? room.players[index] : null;
    awardUncontested(room, contenders(room)[0], foldedPlayer);
    return;
  }`,
    'fold-result attribution'
  );

  source = replaceOnce(
    source,
`        awardUncontested(room, remaining[0]);`,
`        awardUncontested(room, remaining[0], player);`,
    'departing-player fold attribution'
  );

  source = replaceOnce(
    source,
`function awardUncontested(room, winner) {
  const game = room.game;
  winner.chips += game.pot;
  const amount = game.pot;
  game.pot = 0;
  game.handOver = true;
  game.phase = 'complete';
  game.currentActor = null;
  game.status = \`${'${winner.name}'} wins ${'${amount}'} uncontested.\`;
  game.result = { handId: game.handId, handNo: game.handNo, title: \`${'${winner.name}'} wins\`, detail: \`${'${amount}'} chips · uncontested\`, winners: [winner.seat] };
  log(room, game.status);
  finishHand(room);
}`,
`function awardUncontested(room, winner, foldedPlayer = null) {
  const game = room.game;
  winner.chips += game.pot;
  const amount = game.pot;
  game.pot = 0;
  game.handOver = true;
  game.phase = 'complete';
  game.currentActor = null;
  game.turnDeadline = 0;
  const foldedName = foldedPlayer ? foldedPlayer.name : 'Opponent';
  game.status = \`${'${foldedName}'} folded.\`;
  game.result = {
    handId: game.handId,
    handNo: game.handNo,
    reason: 'fold',
    foldedSeat: foldedPlayer ? foldedPlayer.seat : null,
    title: \`${'${foldedName}'} folded\`,
    detail: \`${'${winner.name}'} receives ${'${amount}'} chips\`,
    winners: [winner.seat]
  };
  log(room, game.status);
  finishHand(room);
}`,
    'fold result payload'
  );

  source = replaceOnce(
    source,
`      result: game.handOver && game.phase === 'complete' && game.result && Number(game.result.handId) === Number(game.handId) && (game.result.tableOver || Number(game.result.handNo) === Number(game.handNo)) ? game.result : null,
      turnDeadline: game.turnDeadline`,
`      result: game.handOver && game.phase === 'complete' && game.result && Number(game.result.handId) === Number(game.handId) && (game.result.tableOver || Number(game.result.handNo) === Number(game.handNo)) ? game.result : null,
      turnDeadline: game.turnDeadline,
      turnId: Number(game.turnId || 0)`,
    'public turn identifier'
  );

  source = replaceOnce(
    source,
`    const player = getPlayer(room, body.token);
    if (!player) throw new Error('Player session not found. Rejoin the room.');
    touch(room, player);`,
`    const player = getPlayer(room, body.token);
    if (!player) throw new Error('Player session not found. Rejoin the room.');
    const tableAccount = await accounts.requireAuth(authTokenFrom(req, body));
    if (Number(tableAccount.id) !== Number(player.userId)) throw new Error('That table seat belongs to a different account.');
    touch(room, player);`,
    'account-bound table commands'
  );

  source = replaceOnce(
    source,
"return json(res, 200, { ok: true, version: 'admin-command-center-1', database: database.ok, rooms: rooms.size, publicTables: PUBLIC_TABLE_DEFINITIONS.length, now: Date.now() });",
"return json(res, 200, { ok: true, version: 'server-authority-v55', authority: 'server', database: database.ok, rooms: rooms.size, publicTables: PUBLIC_TABLE_DEFINITIONS.length, now: Date.now() });",
    'health authority version'
  );

  return source;
}

function patchMultiplayerHtml(source) {
  if (source.includes(CLIENT_MARKER)) return source;

  source = replaceOnce(
    source,
    'const AUTH_TOKEN=__SIVEL_AUTH_TOKEN__;',
    'const AUTH_TOKEN=__SIVEL_AUTH_TOKEN__;\nconst SIVEL_SERVER_AUTHORITY_CLIENT_V55=true;',
    'client authority marker'
  );

  source = replaceOnce(
    source,
`let timerInterval = null;
let clientTimeoutActionKey = '';`,
`let timerInterval = null;
let serverClockOffset = 0;
let clientTimeoutActionKey = '';`,
    'server clock offset'
  );

  source = replaceOnce(
    source,
`async function api(path,body={}){
  let res;
  try{res=await fetch(endpoint(path),{method:'POST',mode:'cors',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
  catch(_){throw new Error(\`Cannot reach the multiplayer server at ${'${serverBase||\'the saved address\'}'}. Open the Render link directly or check the server address.\`)}
  const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'Request failed.');return data
}`,
`async function api(path,body={}){
  let res;const headers={'Content-Type':'application/json'};if(AUTH_TOKEN)headers.Authorization=\`Bearer ${'${AUTH_TOKEN}'}\`;
  try{res=await fetch(endpoint(path),{method:'POST',mode:'cors',headers,body:JSON.stringify(body)})}
  catch(_){throw new Error(\`Cannot reach the multiplayer server at ${'${serverBase||\'the saved address\'}'}. Open the Render link directly or check the server address.\`)}
  const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'Request failed.');return data
}`,
    'authenticated multiplayer requests'
  );

  source = replaceOnce(
    source,
`function connectEvents(){if(events)events.close();if(!session)return;events=new EventSource(endpoint(\`/api/events?room=${'${encodeURIComponent(session.room)}'}&token=${'${encodeURIComponent(session.token)}'}\`));events.addEventListener('state',e=>{const next=JSON.parse(e.data);handleStateSounds(next);state=next;$('connectionLabel').textContent='Connected';setServerStatus('Connected to multiplayer server',true);render()});events.onerror=()=>{const label=$('connectionLabel'),tip=$('connectionTip');if(label)label.textContent='Reconnecting…';if(tip)tip.textContent='Connection interrupted. The browser is attempting to reconnect automatically.'}}`,
`function connectEvents(){if(events)events.close();if(!session)return;events=new EventSource(endpoint(\`/api/events?room=${'${encodeURIComponent(session.room)}'}&token=${'${encodeURIComponent(session.token)}'}\`));events.addEventListener('state',e=>{const next=JSON.parse(e.data);if(Number.isFinite(Number(next.serverTime)))serverClockOffset=Number(next.serverTime)-Date.now();handleStateSounds(next);state=next;$('connectionLabel').textContent='Connected';setServerStatus('Connected to multiplayer server',true);render()});events.onerror=()=>{const label=$('connectionLabel'),tip=$('connectionTip');if(label)label.textContent='Reconnecting…';if(tip)tip.textContent='Connection interrupted. The browser is attempting to reconnect automatically.'}}`,
    'server-clock synchronization'
  );

  source = replaceOnce(
    source,
`  const explicit=/without showdown|uncontested|opponent(?:s)? folded|you folded/i.test(resultText);`,
`  const explicit=result.reason==='fold'||/without showdown|uncontested|opponent(?:s)? folded|you folded/i.test(resultText);`,
    'structured fold result support'
  );

  const oldTimer = `function startTimer(){
  clearInterval(timerInterval);
  const tick=()=>{
    if(!state||!state.game||state.game.handOver||!state.game.turnDeadline){$('turnTimer').textContent='--';clearVisibleTurnCountdown();clientTimeoutActionPending=false;return}
    const g=state.game,rawDeadline=g.turnDeadline,deadline=Number(rawDeadline)||Date.parse(rawDeadline),remainingMs=deadline-Date.now();
    const remain=Number.isFinite(remainingMs)?Math.max(0,Math.ceil(remainingMs/1000)):0;
    $('turnTimer').textContent=\`${'${remain}'}s\`;
    updateVisibleTurnCountdown(remain,Math.max(0,remainingMs),g);
    /* Submit just before the server deadline so its fallback cannot convert this into a check. */
    if(remainingMs<=500)resolveExpiredSelfTurn(g);
  };
  tick();timerInterval=setInterval(tick,100);
}`;
  const newTimer = `function startTimer(){
  clearInterval(timerInterval);
  const tick=()=>{
    if(!state||!state.game||state.game.handOver||state.game.phase!=='betting'||!state.game.turnDeadline){$('turnTimer').textContent='--';clearVisibleTurnCountdown();clientTimeoutActionPending=false;return}
    const g=state.game,rawDeadline=g.turnDeadline,deadline=Number(rawDeadline)||Date.parse(rawDeadline),serverNow=Date.now()+serverClockOffset,remainingMs=deadline-serverNow;
    const remain=Number.isFinite(remainingMs)?Math.max(0,Math.ceil(remainingMs/1000)):0;
    $('turnTimer').textContent=\`${'${remain}'}s\`;
    updateVisibleTurnCountdown(remain,Math.max(0,remainingMs),g);
    if(remainingMs<=0&&state.legal&&state.legal.canAct)$('gameStatus').textContent='Time expired — the server is folding your hand.';
  };
  tick();timerInterval=setInterval(tick,100);
}`;
  source = replaceOnce(source, oldTimer, newTimer, 'server-driven visual timer');

  source = replaceOnce(
    source,
`async function doAction(type,total){try{await api('/api/action',{room:session.room,token:session.token,action:{type,total}});return true}catch(e){$('gameStatus').textContent=e.message;return false}}`,
`async function doAction(type,total){try{const g=state&&state.game;if(!g)throw new Error('There is no active hand.');await api('/api/action',{room:session.room,token:session.token,action:{type,total,handId:g.handId,turnId:g.turnId}});return true}catch(e){$('gameStatus').textContent=e.message;return false}}`,
    'hand-and-turn-bound actions'
  );

  source = replaceOnce(
    source,
`$('callBtn').onclick=()=>doAction('call');`,
`$('callBtn').onclick=()=>doAction(state&&state.legal&&state.legal.toCall>0?'call':'check');`,
    'explicit check versus call action'
  );

  return source;
}

function patchIndex(source) {
  const match = source.match(/const encoded='([A-Za-z0-9+/=]+)';/);
  if (!match) throw new Error('V55 patch could not locate the embedded multiplayer client.');
  const multiplayer = Buffer.from(match[1], 'base64').toString('utf8');
  const patched = patchMultiplayerHtml(multiplayer);
  if (patched === multiplayer) return source;
  const encoded = Buffer.from(patched, 'utf8').toString('base64');
  return source.slice(0, match.index) + `const encoded='${encoded}';` + source.slice(match.index + match[0].length);
}

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Syntax check failed for ${file}`);
}

function main() {
  const clientOnly = process.argv.includes('--client-only');
  const serverOnly = process.argv.includes('--server-only');
  if (clientOnly && serverOnly) throw new Error('Choose only one patch mode.');

  if (!clientOnly) {
    if (!fs.existsSync(SERVER_PATH)) throw new Error(`Missing ${SERVER_PATH}`);
    const originalServer = fs.readFileSync(SERVER_PATH, 'utf8');
    const patchedServer = patchServer(originalServer);
    if (patchedServer !== originalServer) {
      fs.writeFileSync(SERVER_PATH, patchedServer, 'utf8');
      try { syntaxCheck(SERVER_PATH); }
      catch (err) { fs.writeFileSync(SERVER_PATH, originalServer, 'utf8'); throw err; }
      console.log('Applied V55 server-authority hardening to server.js.');
    }
  }

  if (!serverOnly) {
    if (!fs.existsSync(INDEX_PATH)) throw new Error(`Missing ${INDEX_PATH}`);
    const originalIndex = fs.readFileSync(INDEX_PATH, 'utf8');
    const patchedIndex = patchIndex(originalIndex);
    if (patchedIndex !== originalIndex) {
      fs.writeFileSync(INDEX_PATH, patchedIndex, 'utf8');
      console.log('Applied V55 server-authority client protocol to public/index.html.');
    }
  }
}

if (require.main === module) {
  try { main(); }
  catch (err) { console.error(`Sivel Poker V55 patch failed: ${err.message}`); process.exit(1); }
}

module.exports = { patchServer, patchMultiplayerHtml, patchIndex };
