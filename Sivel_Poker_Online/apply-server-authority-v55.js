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

function patchMultiplayerHtml(source) {
  if (source.includes(CLIENT_MARKER)) return patchPremiumTablePresentationClient(patchProfessionalTableClient(patchAllInShowdownClient(patchBustTopUpClient(source))));

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

  return patchPremiumTablePresentationClient(patchProfessionalTableClient(patchAllInShowdownClient(patchBustTopUpClient(source))));
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
