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

function replaceBetweenOnce(source, startNeedle, endNeedle, replacement, label) {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`V55 patch could not find the start of ${label}.`);
  if (source.indexOf(startNeedle, start + startNeedle.length) >= 0) throw new Error(`V55 patch found more than one start for ${label}; refusing an ambiguous change.`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end < 0) throw new Error(`V55 patch could not find the end of ${label}.`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchBustTopUpServer(source) {
  if (source.includes('SIVEL_BUST_TOP_UP_SERVER_FIX')) {
    if (source.includes('schedulePublicPlay(room, 700);')) {
      return replaceOnce(
        source,
        'schedulePublicPlay(room, 700);',
        'schedulePublicPlay(room, PUBLIC_NEXT_HAND_MS);',
        'top-up result-display hold'
      );
    }
    return source;
  }
  return replaceOnce(
    source,
`  player.walletBalance = Number(result.account.bankroll);
  log(room, \`${'${player.name}'} tops up ${'${amount}'} chips.\`);
  systemChat(room, \`${'${player.name}'} topped up to ${'${player.chips.toLocaleString()}'} chips.\`);
  broadcast(room);
  return result;`,
`  player.walletBalance = Number(result.account.bankroll);
  player.waitingForNextHand = !player.sittingOut;
  player.allIn = false;
  player.folded = true;
  player.inHand = false;
  log(room, \`${'${player.name}'} tops up ${'${amount}'} chips.\`);
  systemChat(room, \`${'${player.name}'} topped up to ${'${player.chips.toLocaleString()}'} chips.\`);
  // SIVEL_BUST_TOP_UP_SERVER_FIX — a busted public seat can refill and automatically re-enter play.
  broadcast(room);
  if (room.isPublic && room.game && room.game.handOver) schedulePublicPlay(room, PUBLIC_NEXT_HAND_MS);
  return result;`,
    'busted-seat top-up restart'
  );
}

function patchAllInShowdownServer(source) {
  if (source.includes('SIVEL_ALL_IN_SHOWDOWN_FIX')) return source;

  source = replaceOnce(
    source,
`function schedulePublicPlay(room, delay = PUBLIC_NEXT_HAND_MS) {
  if (!room || !room.isPublic) return;
  clearPublicNextTimer(room);
  if (room.adminPaused) {
    if (room.game && room.game.handOver) {
      room.game.phase = 'waiting';
      room.game.currentActor = null;
      room.game.status = 'Table paused by administration.';
    }
    broadcast(room);
    return;
  }
  const enoughPlayers = room.stage === 'lobby' ? seatedPlayers(room).filter(player => !player.sittingOut).length >= 2 : activeIndices(room).length >= 2;
  if (!enoughPlayers) {
    if (room.game) {
      room.game.handOver = true;
      room.game.tableOver = false;
      room.game.currentActor = null;
      room.game.phase = 'waiting';
      room.game.board = [];
      room.game.street = 'preflop';
      room.game.pot = 0;
      room.game.reveal = false;
      room.game.result = null;
      room.game.status = 'Waiting for another player to take a seat.';
    }
    broadcast(room);
    return;
  }
  room.publicNextTimer = setTimeout(() => {
    room.publicNextTimer = null;
    try {
      compactPublicPlayers(room);
      if (room.stage === 'lobby') startTable(room);
      else if (room.game && room.game.handOver && !room.game.tableOver && activeIndices(room).length >= 2) startHand(room);
    } catch (err) {
      console.error(\`Unable to continue public table ${'${room.code}'}:\`, err);
      if (room.game) room.game.status = 'The table is waiting to restart.';
      broadcast(room);
    }
  }, Math.max(250, Number(delay) || PUBLIC_NEXT_HAND_MS));
  if (room.publicNextTimer.unref) room.publicNextTimer.unref();
}`,
`function movePublicTableToWaiting(room) {
  if (!room || !room.game) return;
  room.game.handOver = true;
  room.game.tableOver = false;
  room.game.currentActor = null;
  room.game.phase = 'waiting';
  room.game.board = [];
  room.game.street = 'preflop';
  room.game.pot = 0;
  room.game.reveal = false;
  room.game.result = null;
  const seatedCount = seatedPlayers(room).length;
  room.game.status = seatedCount >= 2
    ? 'Waiting for another player to top up or return.'
    : 'Waiting for another player to take a seat.';
  broadcast(room);
}

function schedulePublicPlay(room, delay = PUBLIC_NEXT_HAND_MS) {
  if (!room || !room.isPublic) return;
  clearPublicNextTimer(room);
  if (room.adminPaused) {
    if (room.game && room.game.handOver) {
      room.game.phase = 'waiting';
      room.game.currentActor = null;
      room.game.status = 'Table paused by administration.';
    }
    broadcast(room);
    return;
  }
  const enoughPlayers = room.stage === 'lobby'
    ? seatedPlayers(room).filter(player => !player.sittingOut).length >= 2
    : activeIndices(room).length >= 2;
  const preserveCompletedResult = !!(room.game && room.game.handOver && room.game.phase === 'complete' && room.game.result);
  const requestedDelay = Math.max(250, Number(delay) || PUBLIC_NEXT_HAND_MS);
  const displayDelay = preserveCompletedResult ? Math.max(PUBLIC_NEXT_HAND_MS, requestedDelay) : requestedDelay;

  if (!enoughPlayers) {
    if (!preserveCompletedResult) {
      movePublicTableToWaiting(room);
      return;
    }
    room.publicNextTimer = setTimeout(() => {
      room.publicNextTimer = null;
      try {
        if (!room.game || !room.game.handOver) return;
        compactPublicPlayers(room);
        if (activeIndices(room).length >= 2) startHand(room);
        else movePublicTableToWaiting(room);
      } catch (err) {
        console.error(\`Unable to settle public table display ${'${room.code}'}:\`, err);
        movePublicTableToWaiting(room);
      }
    }, displayDelay);
    if (room.publicNextTimer.unref) room.publicNextTimer.unref();
    return;
  }

  room.publicNextTimer = setTimeout(() => {
    room.publicNextTimer = null;
    try {
      compactPublicPlayers(room);
      if (room.stage === 'lobby') startTable(room);
      else if (room.game && room.game.handOver && !room.game.tableOver && activeIndices(room).length >= 2) startHand(room);
    } catch (err) {
      console.error(\`Unable to continue public table ${'${room.code}'}:\`, err);
      if (room.game) room.game.status = 'The table is waiting to restart.';
      broadcast(room);
    }
  }, displayDelay);
  if (room.publicNextTimer.unref) room.publicNextTimer.unref();
}`,
    'public showdown result hold'
  );

  source = replaceOnce(
    source,
`function runoutAndShowdown(room, expectedHandId = room.game && room.game.handId) {
  const game = room.game;
  if (!game || game.handOver || game.handId !== expectedHandId || !['betting', 'resolving', 'runout'].includes(game.phase)) return;
  clearTurnTimer(room);
  game.phase = 'runout';
  while (game.street !== 'river') advanceStreet(room);
  showdown(room, expectedHandId);
}`,
`function runoutAndShowdown(room, expectedHandId = room.game && room.game.handId) {
  const game = room.game;
  if (!game || game.handOver || game.handId !== expectedHandId || !['betting', 'resolving', 'runout'].includes(game.phase)) return;
  if (game.runoutPending && Number(game.runoutHandId) === Number(expectedHandId)) return;
  if (game.runoutTimer) clearTimeout(game.runoutTimer);
  clearTurnTimer(room);
  game.phase = 'runout';
  game.currentActor = null;
  game.turnDeadline = 0;
  game.reveal = true;
  game.runoutPending = true;
  game.runoutHandId = expectedHandId;
  game.status = 'All-in · hole cards revealed.';
  // SIVEL_ALL_IN_SHOWDOWN_FIX — reveal every all-in hand and deal the remaining board in visible stages.
  broadcast(room);

  const continueRunout = () => {
    const current = room.game;
    if (current !== game || current.handOver || current.handId !== expectedHandId || current.phase !== 'runout') return;
    if (current.street !== 'river') {
      advanceStreet(room);
      current.status = \`All-in · ${'${capitalize(current.street)}'} dealt.\`;
      broadcast(room);
      current.runoutTimer = setTimeout(continueRunout, 700);
      if (current.runoutTimer.unref) current.runoutTimer.unref();
      return;
    }
    current.status = 'All-in · determining the winner…';
    broadcast(room);
    current.runoutTimer = setTimeout(() => {
      current.runoutTimer = null;
      if (room.game !== game || game.handOver || game.handId !== expectedHandId || game.phase !== 'runout') return;
      game.runoutPending = false;
      game.runoutHandId = null;
      showdown(room, expectedHandId);
    }, 850);
    if (current.runoutTimer.unref) current.runoutTimer.unref();
  };

  game.runoutTimer = setTimeout(continueRunout, 550);
  if (game.runoutTimer.unref) game.runoutTimer.unref();
}`,
    'visible all-in board runout'
  );

  source = replaceOnce(
    source,
`    const revealHole = game && game.handOver && game.phase === 'complete' && game.reveal && p.inHand && !p.folded;`,
`    const revealHole = game && game.reveal && p.inHand && !p.folded && ((game.handOver && game.phase === 'complete') || game.phase === 'runout');`,
    'all-in hole-card visibility'
  );

  return source;
}

function patchServer(source) {
  if (source.includes(SERVER_MARKER)) return patchAllInShowdownServer(patchBustTopUpServer(source));

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

  return patchAllInShowdownServer(patchBustTopUpServer(source));
}

function patchBustTopUpClient(source) {
  if (source.includes('SIVEL_BUST_TOP_UP_CLIENT_FIX')) return source;
  return replaceOnce(
    source,
`  const controls=document.querySelector('.controls');if(controls)controls.classList.add('waiting-controls');const tools=$('tableTools');if(tools)tools.classList.add('hidden');
  $('nextHandBtn').classList.add('hidden');`,
`  // SIVEL_BUST_TOP_UP_CLIENT_FIX — betting actions stay disabled, but table controls remain usable while waiting.
  const controls=document.querySelector('.controls');if(controls)controls.classList.remove('waiting-controls');
  renderTableControls();
  $('nextHandBtn').classList.add('hidden');`,
    'waiting-table top-up controls'
  );
}


function patchAllInShowdownClient(source) {
  if (source.includes('SIVEL_ALL_IN_SHOWDOWN_CLIENT_FIX')) return source;
  return replaceOnce(
    source,
`const showdownRevealed=!p.isSelf&&g.handOver&&g.phase==='complete'&&(p.hole||[]).length===2;`,
`const showdownRevealed=!p.isSelf&&(p.hole||[]).length===2&&((g.handOver&&g.phase==='complete')||g.phase==='runout');/* SIVEL_ALL_IN_SHOWDOWN_CLIENT_FIX */`,
    'all-in opponent-card presentation'
  );
}


function patchProfessionalTableClient(source) {
  if (source.includes('SIVEL_PRO_TABLE_CLEANUP')) {
    if (source.includes('SIVEL_COMMUNITY_BOARD_CENTER_FIX')) return source;
    return replaceOnce(
      source,
      `.center{z-index:6!important;width:64%!important;top:48%!important}.board{position:relative;z-index:7!important;margin:12px 0 26px!important}`,
      `.center{z-index:6!important;width:64%!important;top:48%!important;left:50%!important;transform:translate(-50%,-50%)!important;text-align:center!important}.board{position:relative;z-index:7!important;margin:12px auto 26px!important;left:auto!important;right:auto!important}/* SIVEL_COMMUNITY_BOARD_CENTER_FIX */`,
      'community-card board centering'
    );
  }

  source = replaceOnce(
    source,
    '<div class="table-dealer-console"><span>DEALER</span><i></i></div>',
    '<!-- SIVEL_PRO_TABLE_CLEANUP — redundant dealer console removed; the named dealer remains visible. -->',
    'redundant dealer console'
  );

  source = replaceOnce(
    source,
    '<div class="table-host-copy"><small>TABLE DEALER</small>',
    '<div class="table-host-copy"><small>DEALER</small>',
    'dealer identity label'
  );

  const cleanupCss = `<style id="sivel-professional-gameplay-cleanup">
/* SIVEL_PRO_TABLE_CLEANUP — unobstructed board, authentic seat markers, and cleaner cash-game controls. */
.table-dealer-console{display:none!important}
.table-host,
.table-stage[data-players="2"] .table-host,
.table-stage[data-players="3"] .table-host,
.table-stage[data-players="4"] .table-host,
.table-stage[data-players="5"] .table-host,
.table-stage[data-players="6"] .table-host{
  left:18px!important;right:auto!important;top:16px!important;transform:none!important;z-index:9!important;
  padding:6px 10px 6px 6px!important;gap:8px!important;border-radius:15px!important;
  background:linear-gradient(180deg,rgba(16,27,39,.96),rgba(6,11,17,.98))!important;
  border-color:rgba(224,188,105,.42)!important;box-shadow:0 10px 24px rgba(0,0,0,.42)!important
}
.table-host-avatar{width:34px!important;height:34px!important;font-size:21px!important;border-width:1px!important;box-shadow:0 0 0 2px #0b1118!important}
.table-host-copy{min-width:68px!important}.table-host-copy small{font-size:6px!important;letter-spacing:.18em!important}.table-host-copy strong{font-size:12px!important}.table-host-copy span{display:none!important}
.table-center-brand{display:none!important}
.center{z-index:6!important;width:64%!important;top:48%!important;left:50%!important;transform:translate(-50%,-50%)!important;text-align:center!important}.board{position:relative;z-index:7!important;margin:12px auto 26px!important;left:auto!important;right:auto!important}/* SIVEL_COMMUNITY_BOARD_CENTER_FIX */.board::after{content:'SIVEL POKER · OFFICIAL CASH TABLE';position:absolute;left:50%;bottom:-18px;transform:translateX(-50%);font-size:6px;font-weight:950;letter-spacing:.25em;color:color-mix(in srgb,var(--table-metal) 48%,transparent);white-space:nowrap;text-shadow:0 1px 5px rgba(0,0,0,.45)}.board-slot{position:relative;z-index:7!important}.status{position:relative;z-index:7!important;min-width:250px!important;padding:8px 14px!important;background:rgba(3,9,14,.88)!important;border-color:rgba(255,255,255,.10)!important;box-shadow:0 8px 20px rgba(0,0,0,.34)!important}
.seat-core{position:relative!important;padding-right:12px!important}.position-badges{position:absolute;right:-18px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:3px;z-index:4}.position-badges:empty{display:none}.position-badges .badge,.blind-badge{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:8px;font-weight:950;line-height:1;box-shadow:0 4px 10px rgba(0,0,0,.42)}.position-badges .badge{background:linear-gradient(180deg,#fffdf5,#d7d2c5);color:#171717;border:2px solid #aaa393}.blind-badge{height:18px;border-radius:9px;background:linear-gradient(180deg,#25384b,#101b27);color:#f2d388;border:1px solid #7c6740}
.seat.active .seat-core{border-color:#62b9f3!important;box-shadow:0 0 0 3px rgba(84,177,239,.14),0 10px 18px rgba(0,0,0,.5)!important}.seat.folded{opacity:.48!important}.seat-status-tag.all-in{color:#ffd875!important;background:#3a290f;border:1px solid #8c6722;border-radius:5px;padding:2px 5px;width:max-content}
.action-row{grid-template-columns:minmax(100px,.85fr) minmax(120px,1fr) minmax(230px,1.65fr) minmax(145px,1.1fr)!important}.action-btn{height:52px!important;border-radius:12px!important;letter-spacing:.02em!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 7px 14px rgba(0,0,0,.22)}.action-btn:not(:disabled):active{transform:translateY(1px)}
.raise-box{min-height:52px!important;padding:0 12px!important}.raise-total{min-width:76px!important;display:flex!important;flex-direction:column!important;align-items:flex-end!important;line-height:1.05!important}.raise-total small{display:block;font-size:7px;letter-spacing:.13em;color:#71889c;font-weight:900}.raise-total strong{display:block;margin-top:3px;color:#f1cf7d;font-size:15px;font-variant-numeric:tabular-nums}
.pot-copy strong,.seat-name span,.bet-chip{font-variant-numeric:tabular-nums}
@media(max-width:860px){.table-host,.table-stage[data-players] .table-host{left:9px!important;top:9px!important}.board::after{font-size:5px;letter-spacing:.16em}.action-row{grid-template-columns:1fr 1fr!important}.raise-box{grid-column:1/-1!important}.position-badges{right:-13px}}
</style>`;
  source = replaceOnce(source, '</head>', cleanupCss + '\n</head>', 'professional table cleanup styles');

  source = replaceOnce(
    source,
    `const dealer=originalIndex===g.dealerIndex;const cards=`,
    `const dealer=originalIndex===g.dealerIndex;const smallBlind=originalIndex===g.sbIndex;const bigBlind=originalIndex===g.bbIndex;const cards=`,
    'seat position flags'
  );

  source = replaceOnce(
    source,
    `${'${p.chips}'}</span>${'${p.sittingOut?\'<span class="seat-status-tag">SITTING OUT</span>\':p.leaveAfterHand?\'<span class="seat-status-tag">LEAVING AFTER HAND</span>\':p.sitOutNextHand?\'<span class="seat-status-tag">SIT OUT NEXT</span>\':\'\'}'}</div>${'${dealer?\'<div class="badge">D</div>\':\'\'}'}</div>`,
    `${'${Number(p.chips||0).toLocaleString()}'}</span>${'${p.allIn?\'<span class="seat-status-tag all-in">ALL-IN</span>\':p.sittingOut?\'<span class="seat-status-tag">SITTING OUT</span>\':p.leaveAfterHand?\'<span class="seat-status-tag">LEAVING AFTER HAND</span>\':p.sitOutNextHand?\'<span class="seat-status-tag">SIT OUT NEXT</span>\':\'\'}'}</div><div class="position-badges">${'${dealer?\'<span class="badge">D</span>\':\'\'}'}${'${smallBlind?\'<span class="blind-badge">SB</span>\':\'\'}'}${'${bigBlind?\'<span class="blind-badge">BB</span>\':\'\'}'}</div></div>`,
    'professional seat stack and position markers'
  );

  source = replaceOnce(
    source,
    `$('pot').textContent=g.pot;`,
    `$('pot').textContent=Number(g.pot||0).toLocaleString();`,
    'formatted pot amount'
  );

  source = replaceOnce(
    source,
    `$('gameBuyIn').textContent=state.options.buyIn;`,
    `$('gameBuyIn').textContent=Number(state.options.buyIn||0).toLocaleString();`,
    'formatted buy-in amount'
  );

  source = replaceOnce(
    source,
    `<div class="raise-total" id="raiseTotal">0</div>`,
    `<div class="raise-total"><small>RAISE TO</small><strong id="raiseTotal">0</strong></div>`,
    'raise-to control label'
  );

  source = replaceOnce(
    source,
    `  const l=state.legal;$('foldBtn').disabled=!l.canAct;$('callBtn').disabled=!l.canAct;$('callBtn').textContent=l.toCall?\`Call ${'${l.toCall}'}\`:'Check';$('raiseBtn').disabled=!l.canAct||!l.canRaise;$('raiseSlider').disabled=!l.canAct||!l.canRaise;$('raiseSlider').min=l.minRaiseTotal||0;$('raiseSlider').max=l.maxRaiseTotal||0;let value=Number($('raiseSlider').value);if(!Number.isFinite(value)||value<l.minRaiseTotal||value>l.maxRaiseTotal)value=l.minRaiseTotal||0;$('raiseSlider').value=value;$('raiseTotal').textContent=value||'—';`,
    `  const l=state.legal;$('foldBtn').disabled=!l.canAct;$('callBtn').disabled=!l.canAct;$('callBtn').textContent=l.toCall?\`Call ${'${Number(l.toCall).toLocaleString()}'}\`:'Check';$('raiseBtn').disabled=!l.canAct||!l.canRaise;$('raiseSlider').disabled=!l.canAct||!l.canRaise;$('raiseSlider').min=l.minRaiseTotal||0;$('raiseSlider').max=l.maxRaiseTotal||0;let value=Number($('raiseSlider').value);if(!Number.isFinite(value)||value<l.minRaiseTotal||value>l.maxRaiseTotal)value=l.minRaiseTotal||0;$('raiseSlider').value=value;const raiseVerb=g.currentBet>0?'Raise to':'Bet';$('raiseTotal').textContent=value?Number(value).toLocaleString():'—';$('raiseBtn').textContent=l.canRaise&&value?\`${'${raiseVerb}'} ${'${Number(value).toLocaleString()}'}\`:'Bet / Raise';`,
    'professional action labels'
  );

  source = replaceOnce(
    source,
    `$('raiseSlider').oninput=()=>{$('raiseTotal').textContent=$('raiseSlider').value};`,
    `$('raiseSlider').oninput=()=>{const value=Number($('raiseSlider').value)||0;$('raiseTotal').textContent=value?value.toLocaleString():'—';const verb=state&&state.game&&state.game.currentBet>0?'Raise to':'Bet';$('raiseBtn').textContent=value?\`${'${verb}'} ${'${value.toLocaleString()}'}\`:'Bet / Raise'};`,
    'live raise label'
  );

  return source;
}


function patchPremiumTablePresentationClient(source) {
  if (source.includes('SIVEL_PREMIUM_TABLE_PRESENTATION')) return source;

  const presentationCss = `<style id="sivel-premium-table-presentation">
/* SIVEL_PREMIUM_TABLE_PRESENTATION — restrained casino-grade dealing, reveal, pot, and action feedback. */
.table-stage{perspective:1200px}.seat-card,.board-slot{backface-visibility:hidden;transform-style:preserve-3d}
.seat-card.sivel-deal-in{animation:sivelDealIn .62s cubic-bezier(.18,.78,.22,1) both;will-change:translate,rotate,scale,opacity,filter}
.board-slot.sivel-board-reveal{animation:sivelBoardReveal .58s cubic-bezier(.2,.78,.18,1) both;will-change:rotate,scale,opacity,filter}
.seat-card.sivel-showdown-reveal{animation:sivelShowdownReveal .62s cubic-bezier(.2,.72,.22,1) both;will-change:rotate,scale,opacity,filter}
.pot-display.sivel-pot-pulse,.pot-box.sivel-pot-pulse{animation:sivelPotPulse .48s ease-out both}
.sivel-action-pop{position:absolute;left:50%;top:-11px;z-index:18;translate:-50% 0;padding:5px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:linear-gradient(180deg,rgba(11,20,29,.98),rgba(4,9,14,.98));box-shadow:0 7px 20px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.08);font-size:8px;font-weight:950;letter-spacing:.12em;color:#e8f3ff;white-space:nowrap;pointer-events:none;animation:sivelActionPop 1.05s ease-out both}
.sivel-action-pop.check{color:#aee3ff;border-color:rgba(84,177,239,.35)}.sivel-action-pop.call{color:#bff5d8;border-color:rgba(72,208,139,.34)}.sivel-action-pop.raise,.sivel-action-pop.bet{color:#ffe29a;border-color:rgba(232,185,91,.4)}.sivel-action-pop.fold{color:#c3ccd6}.sivel-action-pop.allin{color:#ffd46e;border-color:rgba(255,181,55,.55);box-shadow:0 7px 22px rgba(0,0,0,.58),0 0 18px rgba(255,173,44,.18)}
@keyframes sivelDealIn{0%{opacity:0;translate:var(--deal-x,0) var(--deal-y,-160px);rotate:var(--deal-rot,-9deg);scale:.72;filter:blur(1px) brightness(1.18)}68%{opacity:1;translate:0 -3px;rotate:0deg;scale:1.025;filter:none}100%{opacity:1;translate:0 0;rotate:0deg;scale:1;filter:none}}
@keyframes sivelBoardReveal{0%{opacity:.16;rotate:0 1 0 92deg;scale:.82;filter:brightness(1.28)}58%{opacity:1;rotate:0 1 0 -7deg;scale:1.035;filter:none}100%{opacity:1;rotate:0 1 0 0deg;scale:1;filter:none}}
@keyframes sivelShowdownReveal{0%{opacity:.35;rotate:0 1 0 88deg;scale:.9;filter:brightness(1.3)}55%{opacity:1;rotate:0 1 0 -8deg;scale:1.035;filter:none}100%{opacity:1;rotate:0 1 0 0deg;scale:1;filter:none}}
@keyframes sivelPotPulse{0%{scale:1;filter:brightness(1)}42%{scale:1.08;filter:brightness(1.25)}100%{scale:1;filter:brightness(1)}}
@keyframes sivelActionPop{0%{opacity:0;translate:-50% 7px;scale:.88}16%{opacity:1;translate:-50% 0;scale:1.03}72%{opacity:1;translate:-50% -1px;scale:1}100%{opacity:0;translate:-50% -9px;scale:.98}}
@media(prefers-reduced-motion:reduce){.seat-card.sivel-deal-in,.board-slot.sivel-board-reveal,.seat-card.sivel-showdown-reveal,.pot-display.sivel-pot-pulse,.pot-box.sivel-pot-pulse,.sivel-action-pop{animation-duration:.01ms!important;animation-delay:0ms!important}}
</style>`;
  source = replaceOnce(source, '</head>', presentationCss + '\n</head>', 'premium table presentation styles');

  source = replaceOnce(
    source,
`let soundSnapshot=null;
let tableControlBusy=false;`,
`let soundSnapshot=null;
let tableControlBusy=false;
let visualSnapshot=null;
let pendingTableMotion=null;`,
    'premium presentation state'
  );

  source = replaceOnce(
    source,
`    case 'deal':noise(.09,.014,0,500);tone(185,.055,.015,.01,'triangle',130);break;`,
`    case 'deal':noise(.075,.013,0,620);tone(188,.05,.013,.008,'triangle',132);noise(.07,.011,.105,680);tone(205,.045,.011,.11,'triangle',145);break;`,
    'professional card-deal sound'
  );

  source = replaceOnce(
    source,
`    case 'check':tone(430,.045,.018,0,'triangle',360);break;`,
`    case 'check':noise(.025,.012,0,1050);tone(330,.032,.011,.002,'triangle',275);noise(.024,.011,.105,1120);tone(350,.03,.010,.107,'triangle',290);break;
    case 'reveal':noise(.055,.010,0,760);tone(510,.075,.014,.018,'triangle',690);break;`,
    'double-tap check and reveal sounds'
  );

  const motionCode = `
function visualCardKey(card){return card&&card.r&&card.s?String(card.r)+card.s:'?'}
function knownHoleCards(player){const cards=player&&Array.isArray(player.hole)?player.hole:[];return cards.length===2&&cards.every(card=>visualCardKey(card)!=='?')}
function visualDigest(snapshot){const g=snapshot&&snapshot.game;return{stage:snapshot&&snapshot.stage||'',handId:Number(g&&g.handId||0),board:g&&Array.isArray(g.board)?g.board.map(visualCardKey):[],pot:Number(g&&g.pot||0),latest:snapshot&&snapshot.log&&snapshot.log[0]?String(snapshot.log[0].message||''):'',players:(snapshot&&snapshot.players||[]).map((player,index)=>({index:index,name:String(player.name||''),known:knownHoleCards(player)}))}}
function actionMotionFromLog(message,next){const text=String(message||'');if(!text)return null;const players=next&&next.players||[];const allInPlayer=players.find(item=>text.startsWith(String(item.name||'')+' ')&&/all-in/i.test(text));if(allInPlayer)return{seat:Number(allInPlayer.seat),label:'ALL-IN',kind:'allin'};const matchers=[[/^(.+?) checks\\./i,'CHECK','check'],[/^(.+?) calls ([0-9,]+)/i,'CALL','call'],[/^(.+?) raises to ([0-9,]+)/i,'RAISE TO','raise'],[/^(.+?) bets ([0-9,]+)/i,'BET','bet'],[/^(.+?) folds\\./i,'FOLD','fold']];for(const entry of matchers){const found=text.match(entry[0]);if(!found)continue;const name=found[1].trim();const player=players.find(item=>String(item.name||'')===name);if(!player)continue;const amount=found[2]?' '+found[2]:'';return{seat:Number(player.seat),label:entry[1]+amount,kind:entry[2]}}return null}
function prepareTableMotion(next){const current=visualDigest(next),previous=visualSnapshot;visualSnapshot=current;if(!previous||current.stage!=='playing'){pendingTableMotion=null;return}const handChanged=!!current.handId&&current.handId!==previous.handId;const boardFrom=handChanged?0:previous.board.length;const newBoard=[];for(let index=boardFrom;index<current.board.length;index++)newBoard.push(index);const revealed=[];current.players.forEach(player=>{const before=previous.players.find(item=>item.index===player.index);if(player.known&&before&&!before.known)revealed.push(player.index)});pendingTableMotion={handChanged:handChanged,newBoard:newBoard,revealed:revealed,potRaised:current.pot>previous.pot,action:current.latest!==previous.latest?actionMotionFromLog(current.latest,next):null}}
function clearMotionClass(element,className,delay){if(!element)return;setTimeout(()=>element.classList.remove(className),Math.max(700,Number(delay||0)+760))}
function dealCardsFromDealer(){const stage=document.getElementById('tableStage');if(!stage)return;const stageRect=stage.getBoundingClientRect(),originX=stageRect.left+stageRect.width*.5,originY=stageRect.top+34;const seats=Array.from(document.querySelectorAll('#seats .seat')).sort((a,b)=>Number(a.dataset.playerIndex)-Number(b.dataset.playerIndex));let order=0;for(let cardIndex=0;cardIndex<2;cardIndex++){seats.forEach((seat,seatOrder)=>{const card=seat.querySelectorAll('.seat-cards .seat-card')[cardIndex];if(!card)return;const rect=card.getBoundingClientRect(),delay=order*62;card.style.setProperty('--deal-x',(originX-(rect.left+rect.width/2))+'px');card.style.setProperty('--deal-y',(originY-(rect.top+rect.height/2))+'px');card.style.setProperty('--deal-rot',((seatOrder%2?1:-1)*(7+(seatOrder%3)*2))+'deg');card.style.animationDelay=delay+'ms';card.classList.add('sivel-deal-in');clearMotionClass(card,'sivel-deal-in',delay);order++})}}
function revealBoardCards(indexes){indexes.forEach((index,order)=>{const slot=document.querySelector('#board .board-slot:nth-child('+(index+1)+')');if(!slot||!slot.querySelector('.seat-card'))return;const delay=order*105;slot.style.animationDelay=delay+'ms';slot.classList.add('sivel-board-reveal');clearMotionClass(slot,'sivel-board-reveal',delay)})}
function revealHoleCards(seats){if(!seats.length)return;PokerAudio.play('reveal');seats.forEach((seatIndex,seatOrder)=>{const seat=document.querySelector('#seats .seat[data-player-index="'+seatIndex+'"]');if(!seat)return;seat.querySelectorAll('.seat-cards .seat-card').forEach((card,cardIndex)=>{const delay=seatOrder*90+cardIndex*115;card.style.animationDelay=delay+'ms';card.classList.add('sivel-showdown-reveal');clearMotionClass(card,'sivel-showdown-reveal',delay)})})}
function pulsePot(){const pot=document.getElementById('pot');const holder=pot&&(pot.closest('.pot-display')||pot.closest('.pot-box')||pot.parentElement);if(!holder)return;holder.classList.remove('sivel-pot-pulse');void holder.offsetWidth;holder.classList.add('sivel-pot-pulse');clearMotionClass(holder,'sivel-pot-pulse',0)}
function showSeatAction(action){if(!action)return;const seat=document.querySelector('#seats .seat[data-player-index="'+action.seat+'"]');if(!seat)return;seat.querySelectorAll('.sivel-action-pop').forEach(node=>node.remove());const badge=document.createElement('span');badge.className='sivel-action-pop '+action.kind;badge.textContent=action.label;seat.appendChild(badge);setTimeout(()=>badge.remove(),1120)}
function applyTableMotion(){const motion=pendingTableMotion;pendingTableMotion=null;if(!motion)return;if(motion.handChanged)dealCardsFromDealer();if(motion.newBoard.length)revealBoardCards(motion.newBoard);if(motion.revealed.length)revealHoleCards(motion.revealed);if(motion.potRaised)pulsePot();showSeatAction(motion.action)}
`;
  source = replaceOnce(source, 'async function api(path,body={}){', motionCode + '\nasync function api(path,body={}){', 'premium motion controller');

  source = replaceOnce(
    source,
`function connectEvents(){if(events)events.close();if(!session)return;events=new EventSource(endpoint(\`/api/events?room=${'${encodeURIComponent(session.room)}'}&token=${'${encodeURIComponent(session.token)}'}\`));events.addEventListener('state',e=>{const next=JSON.parse(e.data);if(Number.isFinite(Number(next.serverTime)))serverClockOffset=Number(next.serverTime)-Date.now();handleStateSounds(next);state=next;$('connectionLabel').textContent='Connected';setServerStatus('Connected to multiplayer server',true);render()});events.onerror=()=>{const label=$('connectionLabel'),tip=$('connectionTip');if(label)label.textContent='Reconnecting…';if(tip)tip.textContent='Connection interrupted. The browser is attempting to reconnect automatically.'}}`,
`function connectEvents(){if(events)events.close();if(!session)return;events=new EventSource(endpoint(\`/api/events?room=${'${encodeURIComponent(session.room)}'}&token=${'${encodeURIComponent(session.token)}'}\`));events.addEventListener('state',e=>{const next=JSON.parse(e.data);if(Number.isFinite(Number(next.serverTime)))serverClockOffset=Number(next.serverTime)-Date.now();handleStateSounds(next);prepareTableMotion(next);state=next;$('connectionLabel').textContent='Connected';setServerStatus('Connected to multiplayer server',true);render();requestAnimationFrame(applyTableMotion)});events.onerror=()=>{const label=$('connectionLabel'),tip=$('connectionTip');if(label)label.textContent='Reconnecting…';if(tip)tip.textContent='Connection interrupted. The browser is attempting to reconnect automatically.'}}`,
    'state-driven card and action animation'
  );

  return source;
}


function patchSoloTablePresentation(source) {
  if (source.includes('SIVEL_SOLO_PUBLIC_PRESENTATION_MATCH')) return source;

  source = replaceOnce(
    source,
    '<div class="table-dealer-console"><span>DEALER</span><i></i></div>',
    '<!-- SIVEL_SOLO_PUBLIC_PRESENTATION_MATCH — redundant dealer console removed. -->',
    'solo redundant dealer console'
  );

  source = replaceOnce(
    source,
    '<div class="solo-table-host-copy"><small>TABLE DEALER</small>',
    '<div class="solo-table-host-copy"><small>DEALER</small>',
    'solo dealer identity label'
  );

  source = replaceOnce(
    source,
    '<div class="raiseamt" id="raiseAmount">40</div>',
    '<div class="raiseamt"><small>RAISE TO</small><strong id="raiseAmount">40</strong></div>',
    'solo raise-to amount label'
  );

  const soloCss = `<style id="sivel-solo-public-presentation-match">
/* SIVEL_SOLO_PUBLIC_PRESENTATION_MATCH — mirrors the polished public-table presentation while preserving solo AI and progression. */
#gameScreen .table-dealer-console{display:none!important}
#gameScreen .table-center-brand{display:none!important}
#gameScreen .solo-table-host,
#gameScreen[data-players="2"] .solo-table-host,
#gameScreen[data-players="3"] .solo-table-host,
#gameScreen[data-players="4"] .solo-table-host,
#gameScreen[data-players="5"] .solo-table-host,
#gameScreen[data-players="6"] .solo-table-host{
  left:18px!important;right:auto!important;top:16px!important;transform:none!important;z-index:11!important;
  padding:6px 10px 6px 6px!important;gap:8px!important;border-radius:15px!important;
  background:linear-gradient(180deg,rgba(16,27,39,.96),rgba(6,11,17,.98))!important;
  border-color:rgba(224,188,105,.42)!important;box-shadow:0 10px 24px rgba(0,0,0,.42)!important
}
#gameScreen .solo-table-host-avatar{width:34px!important;height:34px!important;font-size:21px!important;border-width:1px!important;box-shadow:0 0 0 2px #0b1118!important}
#gameScreen .solo-table-host-copy{min-width:68px!important}
#gameScreen .solo-table-host-copy small{font-size:6px!important;letter-spacing:.18em!important}
#gameScreen .solo-table-host-copy strong{font-size:12px!important}
#gameScreen .solo-table-host-copy span{display:none!important}
#gameScreen .center-table{z-index:6!important;width:64%!important;top:44%!important;left:50%!important;transform:translate(-50%,-50%)!important;text-align:center!important}
#gameScreen .board{position:relative;z-index:7!important;margin:12px auto 26px!important;left:auto!important;right:auto!important}
#gameScreen .board:after{content:'SIVEL POKER · OFFICIAL CASH TABLE';position:absolute;left:50%;bottom:-18px;transform:translateX(-50%);font-size:6px;font-weight:950;letter-spacing:.25em;color:rgba(226,198,126,.34);white-space:nowrap;text-shadow:0 1px 5px rgba(0,0,0,.45)}
#gameScreen .board-slot{position:relative;z-index:7!important;backface-visibility:hidden;transform-style:preserve-3d}
#gameScreen .status{position:relative;z-index:7!important;min-width:250px!important;padding:8px 14px!important;background:rgba(3,9,14,.88)!important;border-color:rgba(255,255,255,.10)!important;box-shadow:0 8px 20px rgba(0,0,0,.34)!important}
#gameScreen .action-flash{display:none!important}
#gameScreen .seat-core{position:relative!important;padding-right:12px!important}
#gameScreen .position-badges{position:absolute;right:-18px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:3px;z-index:6}
#gameScreen .position-badges .hidden{display:none!important}
#gameScreen .position-badges .dealer,#gameScreen .position-badges .blind-badge{position:static!important;inset:auto!important;transform:none!important;margin:0!important;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:8px;font-weight:950;line-height:1;box-shadow:0 4px 10px rgba(0,0,0,.42)}
#gameScreen .position-badges .dealer{background:linear-gradient(180deg,#fffdf5,#d7d2c5);color:#171717;border:2px solid #aaa393}
#gameScreen .position-badges .blind-badge{height:18px;border-radius:9px;background:linear-gradient(180deg,#25384b,#101b27);color:#f2d388;border:1px solid #7c6740}
#gameScreen .seat.active-turn .seat-core{border-color:#62b9f3!important;box-shadow:0 0 0 3px rgba(84,177,239,.14),0 10px 18px rgba(0,0,0,.5)!important}
#gameScreen .seat.folded{opacity:.48!important}
#gameScreen .solo-seat-status{display:none;font-style:normal;margin-top:3px;font-size:7px;font-weight:950;letter-spacing:.1em}
#gameScreen .solo-seat-status.all-in{display:block;color:#ffd875!important;background:#3a290f;border:1px solid #8c6722;border-radius:5px;padding:2px 5px;width:max-content}
#gameScreen .main-actions{display:grid!important;grid-template-columns:minmax(100px,.85fr) minmax(120px,1fr) minmax(230px,1.65fr) minmax(145px,1.1fr)!important;gap:10px!important;max-width:900px;margin:0 auto}
#gameScreen .action{height:52px!important;min-width:0!important;border-radius:12px!important;letter-spacing:.02em!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 7px 14px rgba(0,0,0,.22)}
#gameScreen .action:not(:disabled):active{transform:translateY(1px)}
#gameScreen .raisebox{min-height:52px!important;padding:0 12px!important;width:auto!important;order:initial!important}
#gameScreen .raisebox input{width:100%!important;min-width:120px}
#gameScreen .raiseamt{min-width:76px!important;display:flex!important;flex-direction:column!important;align-items:flex-end!important;line-height:1.05!important}
#gameScreen .raiseamt small{display:block;font-size:7px;letter-spacing:.13em;color:#71889c;font-weight:900}
#gameScreen .raiseamt strong{display:block;margin-top:3px;color:#f1cf7d;font-size:15px;font-variant-numeric:tabular-nums}
#gameScreen .pot-copy strong,#gameScreen .seat-name span,#gameScreen .bet-badge strong{font-variant-numeric:tabular-nums}
#gameScreen .card{backface-visibility:hidden;transform-style:preserve-3d}
#gameScreen .card.solo-deal-in{animation:soloPublicDealIn .62s cubic-bezier(.18,.78,.22,1) both!important;will-change:translate,rotate,scale,opacity,filter}
#gameScreen .board-slot.solo-board-reveal{animation:soloPublicBoardReveal .58s cubic-bezier(.2,.78,.18,1) both!important;will-change:rotate,scale,opacity,filter}
#gameScreen .card.solo-showdown-reveal{animation:soloPublicShowdownReveal .62s cubic-bezier(.2,.72,.22,1) both!important;will-change:rotate,scale,opacity,filter}
#gameScreen .pot.solo-pot-pulse{animation:soloPublicPotPulse .48s ease-out both!important}
#gameScreen .solo-action-pop{position:absolute;left:50%;top:-11px;z-index:18;translate:-50% 0;padding:5px 9px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:linear-gradient(180deg,rgba(11,20,29,.98),rgba(4,9,14,.98));box-shadow:0 7px 20px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.08);font-size:8px;font-weight:950;letter-spacing:.12em;color:#e8f3ff;white-space:nowrap;pointer-events:none;animation:soloPublicActionPop 1.05s ease-out both}
#gameScreen .solo-action-pop.check{color:#aee3ff;border-color:rgba(84,177,239,.35)}
#gameScreen .solo-action-pop.call{color:#bff5d8;border-color:rgba(72,208,139,.34)}
#gameScreen .solo-action-pop.raise,#gameScreen .solo-action-pop.bet{color:#ffe29a;border-color:rgba(232,185,91,.4)}
#gameScreen .solo-action-pop.fold{color:#c3ccd6}
#gameScreen .solo-action-pop.allin{color:#ffd46e;border-color:rgba(255,181,55,.55);box-shadow:0 7px 22px rgba(0,0,0,.58),0 0 18px rgba(255,173,44,.18)}
@keyframes soloPublicDealIn{0%{opacity:0;translate:var(--solo-deal-x,0) var(--solo-deal-y,-160px);rotate:var(--solo-deal-rot,-9deg);scale:.72;filter:blur(1px) brightness(1.18)}68%{opacity:1;translate:0 -3px;rotate:0deg;scale:1.025;filter:none}100%{opacity:1;translate:0 0;rotate:0deg;scale:1;filter:none}}
@keyframes soloPublicBoardReveal{0%{opacity:.16;rotate:0 1 0 92deg;scale:.82;filter:brightness(1.28)}58%{opacity:1;rotate:0 1 0 -7deg;scale:1.035;filter:none}100%{opacity:1;rotate:0 1 0 0deg;scale:1;filter:none}}
@keyframes soloPublicShowdownReveal{0%{opacity:.35;rotate:0 1 0 88deg;scale:.9;filter:brightness(1.3)}55%{opacity:1;rotate:0 1 0 -8deg;scale:1.035;filter:none}100%{opacity:1;rotate:0 1 0 0deg;scale:1;filter:none}}
@keyframes soloPublicPotPulse{0%{scale:1;filter:brightness(1)}42%{scale:1.08;filter:brightness(1.25)}100%{scale:1;filter:brightness(1)}}
@keyframes soloPublicActionPop{0%{opacity:0;translate:-50% 7px;scale:.88}16%{opacity:1;translate:-50% 0;scale:1.03}72%{opacity:1;translate:-50% -1px;scale:1}100%{opacity:0;translate:-50% -9px;scale:.98}}
body.reduced-motion #gameScreen .card.solo-deal-in,body.reduced-motion #gameScreen .board-slot.solo-board-reveal,body.reduced-motion #gameScreen .card.solo-showdown-reveal,body.reduced-motion #gameScreen .pot.solo-pot-pulse,body.reduced-motion #gameScreen .solo-action-pop{animation-duration:.01ms!important;animation-delay:0ms!important}
@media(prefers-reduced-motion:reduce){#gameScreen .card.solo-deal-in,#gameScreen .board-slot.solo-board-reveal,#gameScreen .card.solo-showdown-reveal,#gameScreen .pot.solo-pot-pulse,#gameScreen .solo-action-pop{animation-duration:.01ms!important;animation-delay:0ms!important}}
@media(max-width:860px){#gameScreen .solo-table-host,#gameScreen[data-players] .solo-table-host{left:9px!important;top:9px!important}#gameScreen .board:after{font-size:5px;letter-spacing:.16em}#gameScreen .main-actions{grid-template-columns:1fr 1fr!important}#gameScreen .raisebox{grid-column:1/-1!important}#gameScreen .position-badges{right:-13px}#gameScreen .center-table{width:88%!important}}
</style>`;
  source = replaceOnce(source, '</head>', soloCss + '\n</head>', 'solo public-style presentation CSS');

  const soloRuntime = `
/* SIVEL_SOLO_PUBLIC_PRESENTATION_MATCH runtime */
let soloPublicBoardCount=0;
let soloPublicLastPot=0;
function soloPublicReducedMotion(){return !!(settings&&settings.reducedMotion)||!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)}
function soloPublicClearMotion(element,className,delay){if(!element)return;setTimeout(function(){element.classList.remove(className)},Math.max(700,Number(delay||0)+760))}
function soloPublicDealCards(){if(soloPublicReducedMotion())return;const stage=document.querySelector('#gameScreen .table-stage');if(!stage)return;const host=document.getElementById('soloTableHost');const stageRect=stage.getBoundingClientRect();const hostRect=host?host.getBoundingClientRect():null;const originX=hostRect?hostRect.left+hostRect.width/2:stageRect.left+stageRect.width*.5;const originY=hostRect?hostRect.top+hostRect.height/2:stageRect.top+34;const seats=Array.from(document.querySelectorAll('#seatsLayer .seat')).sort(function(a,b){return Number(a.dataset.index)-Number(b.dataset.index)});let order=0;for(let cardIndex=0;cardIndex<2;cardIndex++){seats.forEach(function(seat,seatOrder){const card=seat.querySelectorAll('.seat-cards .card')[cardIndex];if(!card)return;const rect=card.getBoundingClientRect();const delay=order*62;card.style.setProperty('--solo-deal-x',(originX-(rect.left+rect.width/2))+'px');card.style.setProperty('--solo-deal-y',(originY-(rect.top+rect.height/2))+'px');card.style.setProperty('--solo-deal-rot',((seatOrder%2?1:-1)*(7+(seatOrder%3)*2))+'deg');card.style.animationDelay=delay+'ms';card.classList.add('solo-deal-in');soloPublicClearMotion(card,'solo-deal-in',delay);order++})}}
function soloPublicRevealBoard(indexes){if(soloPublicReducedMotion())return;indexes.forEach(function(index,order){const slot=document.querySelector('#board .board-slot:nth-child('+(index+1)+')');if(!slot||!slot.querySelector('.card'))return;const delay=order*105;slot.style.animationDelay=delay+'ms';slot.classList.add('solo-board-reveal');soloPublicClearMotion(slot,'solo-board-reveal',delay)})}
function soloPublicRevealSeat(index){if(soloPublicReducedMotion())return;const seat=document.querySelector('#seatsLayer .seat[data-index="'+index+'"]');if(!seat)return;let animated=0;seat.querySelectorAll('.seat-cards .card').forEach(function(card,cardIndex){if(card.classList.contains('solo-reveal-seen'))return;card.classList.add('solo-reveal-seen');const delay=cardIndex*115;card.style.animationDelay=delay+'ms';card.classList.add('solo-showdown-reveal');soloPublicClearMotion(card,'solo-showdown-reveal',delay);animated++});if(animated)pokerSound('reveal')}
function soloPublicRevealAll(){document.querySelectorAll('#seatsLayer .seat.showdown-revealed').forEach(function(seat){soloPublicRevealSeat(Number(seat.dataset.index))})}
function soloPublicPulsePot(){const pot=document.querySelector('#gameScreen .pot');if(!pot||soloPublicReducedMotion())return;pot.classList.remove('solo-pot-pulse');void pot.offsetWidth;pot.classList.add('solo-pot-pulse');soloPublicClearMotion(pot,'solo-pot-pulse',0)}
function soloPublicShowAction(index,label,kind){const seat=document.querySelector('#seatsLayer .seat[data-index="'+index+'"]');if(!seat)return;seat.querySelectorAll('.solo-action-pop').forEach(function(node){node.remove()});const badge=document.createElement('span');badge.className='solo-action-pop '+kind;badge.textContent=label;seat.appendChild(badge);setTimeout(function(){badge.remove()},1120)}
function soloPublicActionFromLog(text){text=String(text||'');if(!text)return null;let index=-1;if(/^You\\s/i.test(text))index=0;else{for(let i=1;i<state.players.length;i++){if(text.indexOf(state.players[i].name+' ')===0){index=i;break}}}if(index<0)return null;if(/all-in/i.test(text))return{index:index,label:'ALL-IN',kind:'allin'};if(/ fold(?:s)?\\./i.test(text))return{index:index,label:'FOLD',kind:'fold'};if(/ check(?:s)?\\./i.test(text))return{index:index,label:'CHECK',kind:'check'};let match=text.match(/ call(?:s)? ([0-9,]+)/i);if(match)return{index:index,label:'CALL '+match[1],kind:'call'};match=text.match(/ raise(?:s)? to ([0-9,]+)/i);if(match)return{index:index,label:'RAISE TO '+match[1],kind:'raise'};match=text.match(/ bet(?:s)? ([0-9,]+)/i);if(match)return{index:index,label:'BET '+match[1],kind:'bet'};return null}
const soloPublicBaseAddLog=addLog;
addLog=function(text){soloPublicBaseAddLog(text);const action=soloPublicActionFromLog(text);if(action)requestAnimationFrame(function(){soloPublicShowAction(action.index,action.label,action.kind)})};
const soloPublicBaseSound=pokerSound;
pokerSound=function(type){if(!soundOn)return;if(type==='deal'){noiseFx(.075,.013,0,620);beep(188,.05,.013,.008,'triangle',132);noiseFx(.07,.011,.105,680);beep(205,.045,.011,.11,'triangle',145);return}if(type==='check'){noiseFx(.025,.012,0,1050);beep(330,.032,.011,.002,'triangle',275);noiseFx(.024,.011,.105,1120);beep(350,.03,.010,.107,'triangle',290);return}if(type==='reveal'){noiseFx(.055,.010,0,760);beep(510,.075,.014,.018,'triangle',690);return}soloPublicBaseSound(type)};
buildSeats=function(){seatNodes.clear();const layer=$('seatsLayer');layer.innerHTML='';const slots=SEAT_LAYOUTS[activeCount];state.players.forEach(function(p,i){const el=document.createElement('div');el.className='seat slot-'+slots[i];el.dataset.index=i;el.innerHTML='<div class="seat-cards"></div><div class="bet-badge"></div><div class="seat-core"><div class="seat-avatar">'+p.avatar+'</div><div class="seat-name"><strong>'+p.name+(p.human?' · YOU':'')+'</strong><span>0</span><em class="solo-seat-status"></em></div><div class="position-badges"><div class="dealer hidden">D</div><div class="blind-badge solo-sb hidden">SB</div><div class="blind-badge solo-bb hidden">BB</div></div></div>';layer.appendChild(el);seatNodes.set(i,{root:el,cards:el.querySelector('.seat-cards'),bet:el.querySelector('.bet-badge'),chips:el.querySelector('.seat-name span'),dealer:el.querySelector('.dealer'),smallBlind:el.querySelector('.solo-sb'),bigBlind:el.querySelector('.solo-bb'),status:el.querySelector('.solo-seat-status'),sig:'',betSig:null,wasShown:false})})};
renderSeats=function(){state.players.forEach(function(p,i){const n=seatNodes.get(i);if(!n)return;const revealOpponent=!!(state.reveal&&p.inHand&&!p.folded&&(state.phase==='runout'||(state.handOver&&state.phase==='complete'&&state.completedHandToken===handToken)));const show=p.human||revealOpponent;const sig=p.hole.map(function(c){return String(c.r)+c.s}).join('|')+':'+show+':'+p.inHand;if(sig!==n.sig){n.cards.innerHTML=p.inHand?p.hole.map(function(c,k){return cardHTML(c,!show,k*45)}).join(''):'';n.sig=sig}n.chips.textContent=Number(p.chips||0).toLocaleString();n.dealer.classList.toggle('hidden',i!==state.dealerIndex);n.smallBlind.classList.toggle('hidden',i!==state.sbIndex);n.bigBlind.classList.toggle('hidden',i!==state.bbIndex);n.status.textContent=p.allIn?'ALL-IN':'';n.status.classList.toggle('all-in',!!p.allIn);n.root.classList.toggle('active-turn',state.currentActor===i&&!state.handOver);n.root.classList.toggle('folded',p.folded&&p.inHand);n.root.classList.toggle('busted',p.chips<=0);n.root.classList.toggle('showdown-revealed',!!(show&&!p.human&&p.inHand&&p.hole.length===2));if(show&&!n.wasShown&&!p.human)requestAnimationFrame(function(){soloPublicRevealSeat(i)});n.wasShown=show;if(n.betSig!==p.streetBet){const previousBet=Number(n.betSig||0);n.bet.innerHTML=p.streetBet?(window.SivelChipSystem&&window.SivelChipSystem.betMarkup?window.SivelChipSystem.betMarkup(p.streetBet):'<i class="mini-chip"></i><strong>'+p.streetBet+'</strong>'):'';if(p.streetBet>previousBet)requestAnimationFrame(function(){if(window.SivelChipSystem&&window.SivelChipSystem.bet)window.SivelChipSystem.bet(n.root,p.streetBet-previousBet)});n.betSig=p.streetBet}})};
const soloPublicBaseRenderBoard=renderBoard;
renderBoard=function(){const before=soloPublicBoardCount;const beforePot=soloPublicLastPot;soloPublicBaseRenderBoard();const next=state.board.length;if(next>before){const indexes=[];for(let i=before;i<next;i++)indexes.push(i);requestAnimationFrame(function(){soloPublicRevealBoard(indexes)})}soloPublicBoardCount=next;if(Number(state.pot||0)>beforePot)requestAnimationFrame(soloPublicPulsePot);soloPublicLastPot=Number(state.pot||0);$('pot').textContent=Number(state.pot||0).toLocaleString()};
updateActions=function(){const active=!state.handOver&&state.currentActor===0,p=state.players[0]||{chips:0,streetBet:0},owed=Math.min(amountToCall(0),p.chips),b=legalRaiseBounds(0);$('foldBtn').disabled=!active;$('callBtn').disabled=!active;$('callBtn').textContent=owed?'Call '+Number(owed).toLocaleString():'Check';$('raiseBtn').disabled=!active||!b.canRaise;$('raiseSlider').disabled=!active||!b.canRaise;document.querySelectorAll('.quick-bet').forEach(function(x){x.disabled=!active||!b.canRaise});const min=Math.max(0,b.minTotal),max=Math.max(0,b.maxTotal);$('raiseSlider').min=min;$('raiseSlider').max=max;$('raiseSlider').step=BLINDS[activeBuyIn].sb;let v=Number($('raiseSlider').value);if(!Number.isFinite(v)||v<min)v=min;if(v>max)v=max;$('raiseSlider').value=v;$('raiseAmount').textContent=b.canRaise?Number(v).toLocaleString():'—';const verb=state.currentBet>0?'Raise to':'Bet';$('raiseBtn').textContent=b.canRaise&&v?verb+' '+Number(v).toLocaleString():'Bet / Raise';if(!state.handOver)$('nextHandBtn').classList.add('hidden')};
const soloPublicBaseStartHand=startHand;
startHand=function(){soloPublicBoardCount=0;soloPublicLastPot=0;document.querySelectorAll('#seatsLayer .solo-action-pop').forEach(function(node){node.remove()});soloPublicBaseStartHand();if(!state.handOver)requestAnimationFrame(function(){setTimeout(soloPublicDealCards,20)})};
queueRunout=function(token){if(token!==handToken||state.handOver)return;clearTimeout(transitionTimer);state.transitioning=true;state.phase='runout';state.reveal=true;state.currentActor=null;state.message='All-in · hole cards revealed';dealerSay(DEALERS[activeDealer].showdown);renderAll();requestAnimationFrame(soloPublicRevealAll);transitionTimer=setTimeout(function(){runout(token)},550)};
runout=function(token){if(token!==handToken||state.handOver||state.phase!=='runout')return;if(state.street==='river'){state.message='All-in · determining the winner…';renderAll();transitionTimer=setTimeout(function(){showdown(token)},850);return}advanceStreet();state.message='All-in · '+capitalize(state.street)+' dealt';renderAll();transitionTimer=setTimeout(function(){runout(token)},700)};
const soloPublicBaseShowHandResult=showHandResult;
showHandResult=function(type,title,detail,expectedToken){const showdownResult=!!(state&&state.reveal&&state.phase==='complete'&&!/NO SHOWDOWN/i.test(String(detail||'')));if(!showdownResult){soloPublicBaseShowHandResult(type,title,detail,expectedToken);return}clearTimeout(showHandResult.timer);showHandResult.timer=setTimeout(function(){soloPublicBaseShowHandResult(type,title,detail,expectedToken)},850)};
const soloPublicBaseSettleHand=settleHand;
settleHand=function(winnerIndices,wasShowdown){soloPublicBaseSettleHand(winnerIndices,wasShowdown);if(state.reveal)requestAnimationFrame(soloPublicRevealAll);if(wasShowdown&&settings.autoNextHand&&!state.matchOver&&!matchSettled){clearTimeout(window.__autoNextTimer);window.__autoNextTimer=setTimeout(function(){if(state.handOver&&!state.matchOver&&!matchSettled)startHand()},3400)}};
`;

  source = replaceOnce(
    source,
    `$('playTableBtn').onclick=startSession;`,
    soloRuntime + `\n$('playTableBtn').onclick=startSession;`,
    'solo public-style runtime'
  );

  source = replaceOnce(
    source,
    `$('raiseSlider').oninput=()=>{$('raiseAmount').textContent=$('raiseSlider').value;};`,
    `$('raiseSlider').oninput=()=>{const value=Number($('raiseSlider').value)||0;$('raiseAmount').textContent=value?value.toLocaleString():'—';const verb=state&&state.currentBet>0?'Raise to':'Bet';$('raiseBtn').textContent=value?verb+' '+value.toLocaleString():'Bet / Raise';};`,
    'solo live raise label'
  );

  return source;
}


function patchGameplayVisualFixesClient(source) {
  if (source.includes('SIVEL_GAMEPLAY_VISUAL_FIXES')) return source;

  const visualCss = `<style id="sivel-gameplay-visual-fixes">
/* SIVEL_GAMEPLAY_VISUAL_FIXES — preserves the approved board position while preventing card repaint flicker and table overlays. */
.center{display:block!important;top:48%!important}
.center .board{margin:12px auto 26px!important}
.center .pot{position:relative!important;z-index:12!important;left:90px!important;transform:none!important}
.center .result{position:absolute!important;left:50%!important;right:auto!important;top:auto!important;bottom:0!important;transform:translateX(-50%)!important;z-index:13!important;width:min(330px,90%)!important;margin:0!important;padding:7px 12px!important;border-radius:12px!important;background:rgba(5,11,17,.96)!important;box-shadow:0 9px 22px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.06)!important;pointer-events:none!important}
.center .result strong{font-size:15px!important;line-height:1.05!important}.center .result span{font-size:9px!important;line-height:1.25!important;margin-top:3px!important;display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.center .status.sivel-result-placeholder{visibility:hidden!important}.seat-cards{isolation:isolate}.seat-cards .seat-card{visibility:visible!important}
@media(max-width:760px){.center{top:48%!important}.center .board{margin:12px auto 26px!important}.center .pot{left:60px!important;transform:none!important}.center .result{width:min(280px,88%)!important;padding:7px 9px!important}.center .result strong{font-size:14px!important}}
</style>`;
  source = replaceOnce(source, '</head>', visualCss + '\n</head>', 'gameplay visual-fix styles');

  source = replaceOnce(
    source,
    '<div class="status" id="gameStatus">Waiting for the table.</div></div><div class="result hidden" id="resultBox"><strong id="resultTitle"></strong><span id="resultDetail"></span></div></div>',
    '<div class="status" id="gameStatus">Waiting for the table.</div><div class="result hidden" id="resultBox"><strong id="resultTitle"></strong><span id="resultDetail"></span></div></div></div>',
    'inline multiplayer result placement'
  );

  const stableSeatRuntime = `
/* SIVEL_GAMEPLAY_VISUAL_FIXES runtime */
/* SIVEL_ALL_IN_SHOWDOWN_CLIENT_FIX retained by the stable seat renderer. */
const sivelStableSeatNodes=new Map();
function sivelStableCardKey(card){return card&&card.r&&card.s?String(card.r)+String(card.s):'?'}
function sivelStableSeatClass(p,originalIndex,slot,g,showdownRevealed){return 'seat slot-'+slot+(p.isSelf?' self-seat':'')+(showdownRevealed?' showdown-revealed':'')+(p.sittingOut?' sitting-out':'')+(g.currentActor===originalIndex&&!g.handOver?' active':'')+(p.folded?' folded':'')+(!p.connected?' disconnected':'')}
function renderStableMultiplayerSeats(assignments,g){
  const container=$('seats');if(!container)return;
  const desired=new Set();
  assignments.forEach(function(assignment){
    const p=assignment.p,originalIndex=assignment.originalIndex,slot=assignment.slot,key=String(originalIndex);desired.add(key);
    let record=sivelStableSeatNodes.get(key);
    if(record&&(!record.root.isConnected||record.root.parentElement!==container||record.playerName!==String(p.name||''))){try{record.root.remove()}catch(_e){}sivelStableSeatNodes.delete(key);record=null}
    if(!record){
      const root=document.createElement('div');root.dataset.playerIndex=String(originalIndex);
      root.innerHTML='<div class="seat-cards"></div><div class="bet-chip"></div><div class="seat-core"><div class="avatar"></div><div class="seat-name"><strong></strong><span></span><span class="seat-status-tag hidden"></span></div><div class="position-badges"><span class="badge sivel-position-d hidden">D</span><span class="blind-badge sivel-position-sb hidden">SB</span><span class="blind-badge sivel-position-bb hidden">BB</span></div></div>';
      container.appendChild(root);
      record={root:root,cards:root.querySelector('.seat-cards'),bet:root.querySelector('.bet-chip'),avatar:root.querySelector('.avatar'),name:root.querySelector('.seat-name strong'),stack:root.querySelector('.seat-name>span:not(.seat-status-tag)'),status:root.querySelector('.seat-status-tag'),dealer:root.querySelector('.sivel-position-d'),smallBlind:root.querySelector('.sivel-position-sb'),bigBlind:root.querySelector('.sivel-position-bb'),cardSig:null,betSig:null,nameSig:null,playerName:String(p.name||''),selfHole:null,selfHoleHandId:0};
      sivelStableSeatNodes.set(key,record);
    }
    /* Keep mounted seat and card nodes in place. Re-appending them on every server state caused one-frame card flashes in some browsers. */
    record.root.dataset.playerIndex=String(originalIndex);
    const showdownRevealed=!p.isSelf&&(p.hole||[]).length===2&&((g.handOver&&g.phase==='complete')||g.phase==='runout');
    record.root.className=sivelStableSeatClass(p,originalIndex,slot,g,showdownRevealed);
    const avatarText=avatarFor(p);if(record.avatar.textContent!==avatarText)record.avatar.textContent=avatarText;
    const nameMarkup=esc(p.name)+(p.isAdmin?' <span class="admin-seat-mark">ADMIN</span>':'')+(p.isSelf?' · YOU':'');if(record.nameSig!==nameMarkup){record.name.innerHTML=nameMarkup;record.nameSig=nameMarkup}
    record.stack.textContent=Number(p.chips||0).toLocaleString();
    const statusText=p.allIn?'ALL-IN':p.sittingOut?'SITTING OUT':p.leaveAfterHand?'LEAVING AFTER HAND':p.sitOutNextHand?'SIT OUT NEXT':'';
    record.status.textContent=statusText;record.status.className='seat-status-tag'+(p.allIn?' all-in':'')+(statusText?'':' hidden');
    record.dealer.classList.toggle('hidden',originalIndex!==g.dealerIndex);record.smallBlind.classList.toggle('hidden',originalIndex!==g.sbIndex);record.bigBlind.classList.toggle('hidden',originalIndex!==g.bbIndex);
    const incomingHole=Array.isArray(p.hole)?p.hole:[];
    const incomingKnown=incomingHole.length===2&&incomingHole.every(function(card){return sivelStableCardKey(card)!=='?'});
    if(p.isSelf&&incomingKnown){record.selfHole=incomingHole.map(function(card){return{r:card.r,s:card.s}});record.selfHoleHandId=Number(g.handId||0)}
    const retainedSelfHole=p.isSelf&&p.inHand&&!incomingKnown&&record.selfHole&&record.selfHole.length===2&&record.selfHoleHandId===Number(g.handId||0);
    const displayHole=retainedSelfHole?record.selfHole:incomingHole;
    if(!p.inHand||record.selfHoleHandId!==Number(g.handId||0)&&!incomingKnown){record.selfHole=null;if(!incomingKnown)record.selfHoleHandId=0}
    const cardSig=displayHole.map(sivelStableCardKey).join('|');
    if(cardSig!==record.cardSig){record.cards.innerHTML=displayHole.map(function(card){return cardHtml(card)}).join('');record.cardSig=cardSig}
    const betSig=Number(p.streetBet||0);if(betSig!==record.betSig){record.bet.innerHTML=betSig?(window.SivelPremiumChips?.betMarkup(betSig)||('● '+betSig)):'';record.betSig=betSig}
  });
  Array.from(sivelStableSeatNodes.entries()).forEach(function(entry){if(!desired.has(entry[0])){try{entry[1].root.remove()}catch(_e){}sivelStableSeatNodes.delete(entry[0])}});
}`;
  source = replaceOnce(source, 'async function api(path,body={}){', stableSeatRuntime + '\nasync function api(path,body={}){', 'stable multiplayer seat renderer');

  source = replaceBetweenOnce(
    source,
    `const assignments=visualSeatAssignments(state.players,state.players.length);$('seats').innerHTML=assignments.map`,
    `  window.SivelPremiumChips?.sync(state);`,
    `const assignments=visualSeatAssignments(state.players,state.players.length);renderStableMultiplayerSeats(assignments,g);\n`,
    'multiplayer seat repaint replacement'
  );

  source = replaceOnce(
    source,
    `$('gameStatus').textContent='Waiting for players…';`,
    `$('gameStatus').classList.remove('hidden');$('gameStatus').textContent='Waiting for players…';`,
    'waiting-table status visibility'
  );

  source = replaceOnce(
    source,
    `const validResult=!!(g.handOver&&g.phase==='complete'&&g.handNo>0&&g.result&&Number(g.result.handId)===Number(g.handId)&&Number(g.result.handNo)===Number(g.handNo));if(validResult){`,
    `const validResult=!!(g.handOver&&g.phase==='complete'&&g.handNo>0&&g.result&&Number(g.result.handId)===Number(g.handId)&&Number(g.result.handNo)===Number(g.handNo));$('gameStatus').classList.remove('hidden');$('gameStatus').classList.toggle('sivel-result-placeholder',validResult);if(validResult){`,
    'result/status shared presentation area'
  );

  return source;
}

function patchSoloGameplayVisualFixes(source) {
  if (source.includes('SIVEL_SOLO_GAMEPLAY_VISUAL_FIXES')) return source;

  const css = `<style id="sivel-solo-gameplay-visual-fixes">
/* SIVEL_SOLO_GAMEPLAY_VISUAL_FIXES — preserves the approved solo board position while keeping the pot and results clear of cards. */
#gameScreen .center-table{display:block!important;top:44%!important}
#gameScreen .center-table .board{margin:12px auto 26px!important}
#gameScreen .center-table .pot{position:relative!important;z-index:12!important;left:90px!important;transform:none!important}
#gameScreen .center-table .hand-result{position:absolute!important;left:50%!important;right:auto!important;top:auto!important;bottom:0!important;display:block!important;min-height:0!important;width:min(330px,90%)!important;margin:0!important;padding:7px 12px!important;border-radius:12px!important;background:rgba(5,11,17,.96)!important;border:1px solid rgba(255,255,255,.10)!important;box-shadow:0 9px 22px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.06)!important;opacity:0!important;visibility:hidden!important;transform:translateX(-50%)!important;pointer-events:none!important}
#gameScreen .center-table .hand-result.show{opacity:1!important;visibility:visible!important;transform:translateX(-50%)!important}
#gameScreen .center-table .hand-result:before{display:none!important}
#gameScreen .center-table .status.sivel-result-placeholder{visibility:hidden!important}
#gameScreen .center-table .hand-result strong{font-size:15px!important;line-height:1.05!important}#gameScreen .center-table .hand-result span{font-size:9px!important;line-height:1.25!important;margin-top:3px!important;display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#resultOverlay{display:none!important}
@media(max-width:860px){#gameScreen .center-table{top:44%!important}#gameScreen .center-table .board{margin:12px auto 26px!important}#gameScreen .center-table .pot{left:60px!important;transform:none!important}#gameScreen .center-table .hand-result{width:min(280px,88%)!important;padding:7px 9px!important}#gameScreen .center-table .hand-result strong{font-size:14px!important}}
</style>`;
  source = replaceOnce(source, '</head>', css + '\n</head>', 'solo gameplay visual-fix styles');

  const runtime = `
/* SIVEL_SOLO_GAMEPLAY_VISUAL_FIXES runtime */
const sivelInlineBaseHideHandResult=hideHandResult;
hideHandResult=function(clearContent){sivelInlineBaseHideHandResult(clearContent);const box=$('handResult');if(box){box.className='hand-result';if(clearContent){$('handResultTitle').textContent='';$('handResultDetail').textContent=''}}const status=$('status');if(status){status.classList.remove('hidden');status.classList.remove('sivel-result-placeholder')}};
showHandResult=function(type,title,detail,expectedToken){
  expectedToken=expectedToken==null?handToken:expectedToken;
  const display=function(){if(!state||expectedToken!==handToken||!state.handOver||state.phase!=='complete'||state.completedHandToken!==expectedToken||state.handNo<1)return;const box=$('handResult');if(!box)return;box.className='hand-result show '+type;$('handResultTitle').textContent=title;const split=String(detail||'').split(' · ');const first=(split.shift()||'SHOWDOWN').toUpperCase();$('handResultDetail').textContent=first+(split.length?' · '+split.join(' · '):'');const status=$('status');if(status){status.classList.remove('hidden');status.classList.add('sivel-result-placeholder')};playResultSound(type);flashTable(type);clearTimeout(showHandResult.timer);showHandResult.timer=setTimeout(function(){hideHandResult(false)},1900)};
  clearTimeout(showHandResult.timer);const showdownResult=!!(state&&state.reveal&&state.phase==='complete'&&!/NO SHOWDOWN/i.test(String(detail||'')));showHandResult.timer=setTimeout(display,showdownResult?850:0)
};`;
  source = replaceOnce(source, `$('playTableBtn').onclick=startSession;`, runtime + `\n$('playTableBtn').onclick=startSession;`, 'inline solo result runtime');
  return source;
}


function patchProfessionalPotSeatLayoutClient(source) {
  if (source.includes('SIVEL_PRO_POT_SEAT_LAYOUT')) return source;

  const css = `<style id="sivel-professional-pot-seat-layout">
/* SIVEL_PRO_POT_SEAT_LAYOUT — keeps the approved board coordinates untouched while centering the pot and integrating stack totals into the seat panel. */
.center .pot{
  left:0!important;right:auto!important;margin-left:auto!important;margin-right:auto!important;
  transform:translateY(210px)!important;z-index:12!important;pointer-events:none!important
}
.center .status{
  transform:translateY(32px)!important;min-width:0!important;width:min(360px,90%)!important;
  max-width:360px!important;margin-left:auto!important;margin-right:auto!important
}
.center .result{
  transform:translate(-50%,33px)!important;width:min(360px,90%)!important;padding:4px 9px!important
}
.center .result strong{font-size:13px!important}.center .result span{font-size:7px!important;margin-top:1px!important}
.seat .seat-name>span:not(.seat-status-tag){
  display:inline-flex!important;align-items:center!important;gap:5px!important;width:max-content!important;
  margin-top:4px!important;padding:2px 7px 2px 4px!important;border-radius:999px!important;
  color:#f2d98f!important;font-size:10px!important;line-height:1.15!important;letter-spacing:.02em!important;
  background:linear-gradient(180deg,rgba(25,38,51,.98),rgba(8,15,22,.98))!important;
  border:1px solid rgba(218,185,103,.35)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 3px 8px rgba(0,0,0,.26)!important
}
.seat .seat-name>span:not(.seat-status-tag)::before{
  content:'';display:block;width:12px;height:12px;flex:0 0 12px;border-radius:50%;
  background:repeating-conic-gradient(from 0deg,#f0cf76 0 12deg,#7e4d13 12deg 24deg);
  border:2px solid #f5df9c;box-shadow:inset 0 0 0 2px #8b5717,0 1px 3px rgba(0,0,0,.42)
}
@media(max-width:760px){
  .center .pot{transform:translateY(182px)!important}
  .center .status{transform:translateY(32px)!important;width:min(280px,88%)!important;max-width:280px!important}
  .center .result{transform:translate(-50%,33px)!important;width:min(280px,88%)!important}
  .seat .seat-name>span:not(.seat-status-tag){font-size:9px!important;padding:2px 6px 2px 3px!important}
  .seat .seat-name>span:not(.seat-status-tag)::before{width:10px;height:10px;flex-basis:10px}
}
</style>`;
  return replaceOnce(source, '</head>', css + '\n</head>', 'professional pot and seat layout');
}

function patchSoloProfessionalPotSeatLayout(source) {
  if (source.includes('SIVEL_SOLO_PRO_POT_SEAT_LAYOUT')) return source;

  const css = `<style id="sivel-solo-professional-pot-seat-layout">
/* SIVEL_SOLO_PRO_POT_SEAT_LAYOUT — solo table parity without moving the approved community-card block. */
#gameScreen .center-table .pot{
  left:0!important;right:auto!important;margin-left:auto!important;margin-right:auto!important;
  transform:translateY(205px)!important;z-index:12!important;pointer-events:none!important
}
#gameScreen .center-table .status{
  transform:translateY(41px)!important;min-width:0!important;width:min(360px,90%)!important;
  max-width:360px!important;margin-left:auto!important;margin-right:auto!important
}
#gameScreen .center-table .hand-result,
#gameScreen .center-table .hand-result.show{
  transform:translate(-50%,46px)!important;width:min(360px,90%)!important;padding:4px 9px!important
}
#gameScreen .center-table .hand-result strong{font-size:13px!important}#gameScreen .center-table .hand-result span{font-size:7px!important;margin-top:1px!important}
#gameScreen .seat .seat-name>span{
  display:inline-flex!important;align-items:center!important;gap:5px!important;width:max-content!important;
  margin-top:4px!important;padding:2px 7px 2px 4px!important;border-radius:999px!important;
  color:#f2d98f!important;font-size:10px!important;line-height:1.15!important;letter-spacing:.02em!important;
  background:linear-gradient(180deg,rgba(25,38,51,.98),rgba(8,15,22,.98))!important;
  border:1px solid rgba(218,185,103,.35)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 3px 8px rgba(0,0,0,.26)!important
}
#gameScreen .seat .seat-name>span::before{
  content:'';display:block;width:12px;height:12px;flex:0 0 12px;border-radius:50%;
  background:repeating-conic-gradient(from 0deg,#f0cf76 0 12deg,#7e4d13 12deg 24deg);
  border:2px solid #f5df9c;box-shadow:inset 0 0 0 2px #8b5717,0 1px 3px rgba(0,0,0,.42)
}
@media(max-width:860px){
  #gameScreen .center-table .pot{transform:translateY(169px)!important}
  #gameScreen .center-table .status{transform:translateY(31px)!important;width:min(280px,88%)!important;max-width:280px!important}
  #gameScreen .center-table .hand-result,
  #gameScreen .center-table .hand-result.show{transform:translate(-50%,36px)!important;width:min(280px,88%)!important}
  #gameScreen .seat .seat-name>span{font-size:9px!important;padding:2px 6px 2px 3px!important}
  #gameScreen .seat .seat-name>span::before{width:10px;height:10px;flex-basis:10px}
}
</style>`;
  return replaceOnce(source, '</head>', css + '\n</head>', 'solo professional pot and seat layout');
}


function patchOrganizedPotOpponentStacksClient(source) {
  if (source.includes('SIVEL_ORGANIZED_POT_STACKS')) return source;

  source = replaceOnce(
    source,
    `record.stack.textContent=Number(p.chips||0).toLocaleString();`,
    `record.stack.textContent=Number(p.chips||0).toLocaleString();record.root.dataset.stack=Number(p.chips||0).toLocaleString();`,
    'opponent stack display data'
  );

  const css = `<style id="sivel-organized-pot-opponent-stacks">
/* SIVEL_ORGANIZED_POT_STACKS — pot/logo separation and opponent stack tabs only; board and table coordinates stay untouched. */
.center .pot{transform:translateY(232px) scale(.78)!important;transform-origin:center!important;overflow:hidden!important}
.center .pot-chip-visual .premium-chip{display:none!important}
.center .pot-chip-visual .premium-chip:first-child{display:block!important;left:50%!important;right:auto!important;top:50%!important;bottom:auto!important;transform:translate(-50%,-50%)!important}
.center .status{transform:translateY(42px) scale(.72)!important;transform-origin:center!important}
.center .result{transform:translate(-50%,43px) scale(.72)!important}
.seat:not(.self-seat)[data-stack] .seat-name>span:not(.seat-status-tag){display:none!important}
.seat:not(.self-seat)[data-stack]::before{
  content:attr(data-stack);position:absolute;left:50%;top:-13px;transform:translateX(-50%);z-index:14;
  display:flex;align-items:center;justify-content:center;min-width:42px;height:21px;padding:0 8px 0 22px;
  border-radius:999px;border:1px solid rgba(226,195,117,.58);background:linear-gradient(180deg,rgba(18,29,41,.98),rgba(5,11,17,.98));
  box-shadow:0 6px 14px rgba(0,0,0,.46),inset 0 1px 0 rgba(255,255,255,.08);color:#f4dc98;font-size:10px;font-weight:950;letter-spacing:.02em;font-variant-numeric:tabular-nums;white-space:nowrap
}
.seat:not(.self-seat)[data-stack]::after{
  content:'';position:absolute;left:calc(50% - 28px);top:-9px;z-index:15;width:12px;height:12px;border-radius:50%;
  background:repeating-conic-gradient(from 0deg,#f0cf76 0 12deg,#7e4d13 12deg 24deg);border:2px solid #f5df9c;box-shadow:inset 0 0 0 2px #8b5717,0 1px 3px rgba(0,0,0,.42)
}
@media(max-width:760px){
  .center .pot{transform:translateY(209px) scale(.8)!important}
  .center .status{transform:translateY(48px) scale(.72)!important}
  .center .result{transform:translate(-50%,49px) scale(.72)!important}
  .seat:not(.self-seat)[data-stack]::before{top:-10px;height:19px;min-width:38px;padding:0 7px 0 19px;font-size:9px}
  .seat:not(.self-seat)[data-stack]::after{left:calc(50% - 25px);top:-7px;width:10px;height:10px}
}
</style>`;
  return replaceOnce(source, '</head>', css + '\n</head>', 'organized pot and opponent stacks');
}

function patchSoloOrganizedPotOpponentStacks(source) {
  if (source.includes('SIVEL_SOLO_ORGANIZED_POT_STACKS')) return source;

  source = replaceOnce(
    source,
    `el.className='seat slot-'+slots[i];`,
    `el.className='seat slot-'+slots[i]+(p.human?' self-seat':'');`,
    'solo self-seat identity'
  );
  source = replaceOnce(
    source,
    `n.chips.textContent=Number(p.chips||0).toLocaleString();`,
    `n.chips.textContent=Number(p.chips||0).toLocaleString();n.root.dataset.stack=Number(p.chips||0).toLocaleString();`,
    'solo opponent stack display data'
  );

  const css = `<style id="sivel-solo-organized-pot-opponent-stacks">
/* SIVEL_SOLO_ORGANIZED_POT_STACKS — solo parity without changing community-card or table coordinates. */
#gameScreen .center-table .pot{transform:translateY(223px) scale(.78)!important;transform-origin:center!important;overflow:hidden!important}
#gameScreen .center-table .pot-chip-visual .premium-chip{display:none!important}
#gameScreen .center-table .pot-chip-visual .premium-chip:first-child{display:block!important;left:50%!important;right:auto!important;top:50%!important;bottom:auto!important;transform:translate(-50%,-50%)!important}
#gameScreen .center-table .status{transform:translateY(45px) scale(.75)!important;transform-origin:center!important}
#gameScreen .center-table .hand-result,#gameScreen .center-table .hand-result.show{transform:translate(-50%,46px) scale(.75)!important}
#gameScreen .seat:not(.self-seat)[data-stack] .seat-name>span{display:none!important}
#gameScreen .seat:not(.self-seat)[data-stack]::before{
  content:attr(data-stack);position:absolute;left:50%;top:-13px;transform:translateX(-50%);z-index:14;
  display:flex;align-items:center;justify-content:center;min-width:42px;height:21px;padding:0 8px 0 22px;
  border-radius:999px;border:1px solid rgba(226,195,117,.58);background:linear-gradient(180deg,rgba(18,29,41,.98),rgba(5,11,17,.98));
  box-shadow:0 6px 14px rgba(0,0,0,.46),inset 0 1px 0 rgba(255,255,255,.08);color:#f4dc98;font-size:10px;font-weight:950;letter-spacing:.02em;font-variant-numeric:tabular-nums;white-space:nowrap
}
#gameScreen .seat:not(.self-seat)[data-stack]::after{
  content:'';position:absolute;left:calc(50% - 28px);top:-9px;z-index:15;width:12px;height:12px;border-radius:50%;
  background:repeating-conic-gradient(from 0deg,#f0cf76 0 12deg,#7e4d13 12deg 24deg);border:2px solid #f5df9c;box-shadow:inset 0 0 0 2px #8b5717,0 1px 3px rgba(0,0,0,.42)
}
@media(max-width:860px){
  #gameScreen .center-table .pot{transform:translateY(183px) scale(.8)!important}
  #gameScreen .center-table .status{transform:translateY(33px) scale(.75)!important}
  #gameScreen .center-table .hand-result,#gameScreen .center-table .hand-result.show{transform:translate(-50%,34px) scale(.75)!important}
  #gameScreen .seat:not(.self-seat)[data-stack]::before{top:-10px;height:19px;min-width:38px;padding:0 7px 0 19px;font-size:9px}
  #gameScreen .seat:not(.self-seat)[data-stack]::after{left:calc(50% - 25px);top:-7px;width:10px;height:10px}
}
</style>`;
  return replaceOnce(source, '</head>', css + '\n</head>', 'solo organized pot and opponent stacks');
}

function patchMultiplayerHtml(source) {
  if (source.includes(CLIENT_MARKER)) return patchOrganizedPotOpponentStacksClient(patchProfessionalPotSeatLayoutClient(patchGameplayVisualFixesClient(patchPremiumTablePresentationClient(patchProfessionalTableClient(patchAllInShowdownClient(patchBustTopUpClient(source)))))));

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

  return patchOrganizedPotOpponentStacksClient(patchProfessionalPotSeatLayoutClient(patchGameplayVisualFixesClient(patchPremiumTablePresentationClient(patchProfessionalTableClient(patchAllInShowdownClient(patchBustTopUpClient(source)))))));
}

function patchIndex(source) {
  source = patchSoloOrganizedPotOpponentStacks(patchSoloProfessionalPotSeatLayout(patchSoloGameplayVisualFixes(patchSoloTablePresentation(source))));
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

module.exports = { patchServer, patchSoloTablePresentation, patchSoloGameplayVisualFixes, patchSoloProfessionalPotSeatLayout, patchSoloOrganizedPotOpponentStacks, patchProfessionalPotSeatLayoutClient, patchOrganizedPotOpponentStacksClient, patchMultiplayerHtml, patchIndex };
