'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVER_PATH = path.join(__dirname, 'server.js');
const MARKER = 'SIVEL_GAMEPLAY_STABILITY_V57';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`V57 patch could not find ${label}. Run apply-server-authority-v55.js first.`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`V57 patch found more than one ${label}; refusing an ambiguous change.`);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}


function patchConnectionLifecycle(source) {
  source = replaceOnce(
    source,
`      const previous = room.clients.get(playerToken);
      if (previous && previous !== res) { try { previous.end(); } catch (_) {} }
      room.clients.set(playerToken, res);`,
`      const previous = room.clients.get(playerToken);
      room.clients.set(playerToken, res);
      if (previous && previous !== res) { try { previous.end(); } catch (_) {} }`,
    'replacement connection ordering'
  );

  source = replaceOnce(
    source,
`        clearInterval(heartbeat);
        if (room.clients.get(playerToken) === res) room.clients.delete(playerToken);
        player.connected = false;`,
`        clearInterval(heartbeat);
        if (room.clients.get(playerToken) !== res) return;
        room.clients.delete(playerToken);
        player.connected = false;`,
    'stale stream close guard'
  );

  source = replaceOnce(
    source,
`            if (!player.connected && getPlayer(room, playerToken) === player && !player.cashedOut) {`,
`            if (!player.connected && !room.clients.has(playerToken) && getPlayer(room, playerToken) === player && !player.cashedOut) {`,
    'active replacement cash-out guard'
  );

  return source;
}

function patchServer(source) {
  if (source.includes(MARKER)) return source;
  if (!source.includes('SIVEL_SERVER_AUTHORITY_V55')) {
    throw new Error('V55 server authority must be applied before V57 gameplay stability.');
  }

  source = replaceOnce(
    source,
    '// SIVEL_SERVER_AUTHORITY_V55 — server owns deadlines, actions, cards, pots, and outcomes.',
    '// SIVEL_SERVER_AUTHORITY_V55 — server owns deadlines, actions, cards, pots, and outcomes.\n// SIVEL_GAMEPLAY_STABILITY_V57 — stable live connections, safe clocks, and preserved all-in results.',
    'V57 marker location'
  );

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
      console.error(\`Unable to continue public table \${room.code}:\`, err);
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
  if (!enoughPlayers) {
    const preserveCompletedResult = !!(room.game && room.game.handOver && room.game.phase === 'complete' && room.game.result);
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
        console.error(\`Unable to settle public table display \${room.code}:\`, err);
        movePublicTableToWaiting(room);
      }
    }, Math.max(250, Number(delay) || PUBLIC_NEXT_HAND_MS));
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
      console.error(\`Unable to continue public table \${room.code}:\`, err);
      if (room.game) room.game.status = 'The table is waiting to restart.';
      broadcast(room);
    }
  }, Math.max(250, Number(delay) || PUBLIC_NEXT_HAND_MS));
  if (room.publicNextTimer.unref) room.publicNextTimer.unref();
}`,
    'public result display scheduling'
  );

  source = replaceOnce(
    source,
`function action(room, playerToken, payload) {
  const game = room.game;
  if (room.stage !== 'playing' || !game || game.handOver || game.phase !== 'betting') throw new Error('There is no active hand.');
  const index = room.players.findIndex(p => p.token === playerToken);
  if (index < 0) throw new Error('Player not found.');
  if (game.currentActor !== index) throw new Error('It is not your turn.');
  const p = room.players[index];
  if (p.cashOutPending || p.cashedOut) throw new Error('This seat is cashing out.');
  const type = String(payload.type || '').toLowerCase();
  const owed = amountToCall(room, index);
  if (!Number.isInteger(Number(payload.handId)) || Number(payload.handId) !== Number(game.handId)) throw new Error('That action belongs to an older hand.');
  if (!Number.isInteger(Number(payload.turnId)) || Number(payload.turnId) !== Number(game.turnId)) throw new Error('That turn has already advanced.');
  if (!game.turnDeadline || Date.now() >= Number(game.turnDeadline)) {
    expireTurn(room, { gameRef: game, actor: index, handId: game.handId, turnId: game.turnId });
    throw new Error('Time expired. Your hand was folded by the server.');
  }
  clearTurnTimer(room);

  if (type === 'fold') {
    p.folded = true;
    p.acted = true;
    log(room, \`${'${p.name}'} folds.\`);
  } else if (type === 'check') {
    if (owed !== 0) throw new Error('You cannot check while facing a bet.');
    p.acted = true;
    log(room, \`${'${p.name}'} checks.\`);
  } else if (type === 'call') {
    if (owed <= 0) throw new Error('There is no bet to call.');
    const paid = commit(room, index, owed);
    p.acted = true;
    log(room, \`${'${p.name}'} calls ${'${paid}'}${"${p.allIn ? ' and is all-in' : ''}"}.\`);
  } else if (type === 'raise') {
    const bounds = legalRaiseBounds(room, index);
    if (!bounds.canRaise) throw new Error('A raise is not available.');
    const requested = Number(payload.total);
    if (!Number.isInteger(requested)) throw new Error('Enter a valid whole-chip raise total.');
    if (requested < bounds.minTotal || requested > bounds.maxTotal) throw new Error(\`Raise total must be between ${'${bounds.minTotal}'} and ${'${bounds.maxTotal}'}.\`);
    const target = requested;
    const oldBet = game.currentBet;
    commit(room, index, target - p.streetBet);
    game.currentBet = Math.max(game.currentBet, p.streetBet);
    const raiseSize = game.currentBet - oldBet;
    if (raiseSize >= game.minRaise) {
      game.minRaise = raiseSize;
      room.players.forEach(q => {
        if (q.inHand && !q.folded && !q.allIn) q.acted = false;
      });
    }
    p.acted = true;
    log(room, \`${'${p.name}'} ${"${oldBet ? 'raises to' : 'bets'}"} ${'${p.streetBet}'}${"${p.allIn ? ' and is all-in' : ''}"}.\`);
  } else {
    throw new Error('Unknown action.');
  }

  afterAction(room, index);
}`,
`function action(room, playerToken, payload) {
  const game = room.game;
  if (room.stage !== 'playing' || !game || game.handOver || game.phase !== 'betting') throw new Error('There is no active hand.');
  const index = room.players.findIndex(p => p.token === playerToken);
  if (index < 0) throw new Error('Player not found.');
  if (game.currentActor !== index) throw new Error('It is not your turn.');
  const p = room.players[index];
  if (p.cashOutPending || p.cashedOut) throw new Error('This seat is cashing out.');
  const type = String(payload.type || '').toLowerCase();
  const owed = amountToCall(room, index);
  if (!Number.isInteger(Number(payload.handId)) || Number(payload.handId) !== Number(game.handId)) throw new Error('That action belongs to an older hand.');
  if (!Number.isInteger(Number(payload.turnId)) || Number(payload.turnId) !== Number(game.turnId)) throw new Error('That turn has already advanced.');
  if (!game.turnDeadline || Date.now() >= Number(game.turnDeadline)) {
    expireTurn(room, { gameRef: game, actor: index, handId: game.handId, turnId: game.turnId });
    throw new Error('Time expired. Your hand was folded by the server.');
  }

  let raiseData = null;
  if (type === 'check' && owed !== 0) throw new Error('You cannot check while facing a bet.');
  if (type === 'call' && owed <= 0) throw new Error('There is no bet to call.');
  if (type === 'raise') {
    const bounds = legalRaiseBounds(room, index);
    if (!bounds.canRaise) throw new Error('A raise is not available.');
    const requested = Number(payload.total);
    if (!Number.isInteger(requested)) throw new Error('Enter a valid whole-chip raise total.');
    if (requested < bounds.minTotal || requested > bounds.maxTotal) throw new Error(\`Raise total must be between ${'${bounds.minTotal}'} and ${'${bounds.maxTotal}'}.\`);
    raiseData = { target: requested, oldBet: game.currentBet };
  } else if (!['fold', 'check', 'call'].includes(type)) {
    throw new Error('Unknown action.');
  }

  clearTurnTimer(room);
  if (type === 'fold') {
    p.folded = true;
    p.acted = true;
    log(room, \`${'${p.name}'} folds.\`);
  } else if (type === 'check') {
    p.acted = true;
    log(room, \`${'${p.name}'} checks.\`);
  } else if (type === 'call') {
    const paid = commit(room, index, owed);
    p.acted = true;
    log(room, \`${'${p.name}'} calls ${'${paid}'}${"${p.allIn ? ' and is all-in' : ''}"}.\`);
  } else {
    const { target, oldBet } = raiseData;
    commit(room, index, target - p.streetBet);
    game.currentBet = Math.max(game.currentBet, p.streetBet);
    const raiseSize = game.currentBet - oldBet;
    if (raiseSize >= game.minRaise) {
      game.minRaise = raiseSize;
      room.players.forEach(q => {
        if (q.inHand && !q.folded && !q.allIn) q.acted = false;
      });
    }
    p.acted = true;
    log(room, \`${'${p.name}'} ${"${oldBet ? 'raises to' : 'bets'}"} ${'${p.streetBet}'}${"${p.allIn ? ' and is all-in' : ''}"}.\`);
  }

  afterAction(room, index);
}`,
    'action validation ordering'
  );

  source = patchConnectionLifecycle(source);

  source = replaceOnce(
    source,
    "version: 'server-authority-v55'",
    "version: 'server-authority-v57'",
    'V57 health version'
  );

  return source;
}

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Syntax check failed for ${file}`);
}

function main() {
  if (!fs.existsSync(SERVER_PATH)) throw new Error(`Missing ${SERVER_PATH}`);
  const original = fs.readFileSync(SERVER_PATH, 'utf8');
  const patched = patchServer(original);
  if (patched === original) return;
  fs.writeFileSync(SERVER_PATH, patched, 'utf8');
  try { syntaxCheck(SERVER_PATH); }
  catch (err) { fs.writeFileSync(SERVER_PATH, original, 'utf8'); throw err; }
  console.log('Applied V57 public-table stability fixes to server.js.');
}

if (require.main === module) {
  try { main(); }
  catch (err) { console.error(`Sivel Poker V57 patch failed: ${err.message}`); process.exit(1); }
}

module.exports = { patchServer, patchConnectionLifecycle };
