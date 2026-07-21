'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const TURN_MS = 30000;
const ROOM_IDLE_MS = 4 * 60 * 60 * 1000;

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const ROOM_THEMES = new Set(['tropical', 'castle', 'penthouse', 'underground']);


function commonHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...extra
  };
}




function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, commonHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store'
  }));
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (err) { reject(new Error('Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

function cleanName(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 18) || 'Player';
}

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Unable to create room code.');
}

function token() {
  return crypto.randomUUID();
}

function log(room, message) {
  room.log.unshift({ at: Date.now(), message });
  room.log = room.log.slice(0, 40);
}

function createRoom(hostName, options = {}) {
  const code = roomCode();
  const hostToken = token();
  const maxPlayers = clampInt(options.maxPlayers, 2, 6, 6);
  const buyIn = clampInt(options.buyIn, 100, 10000, 500);
  const bigBlind = Math.max(2, Math.floor(buyIn / 50));
  const room = {
    code,
    hostToken,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stage: 'lobby',
    options: {
      maxPlayers,
      buyIn,
      smallBlind: Math.max(1, Math.floor(bigBlind / 2)),
      bigBlind,
      theme: ROOM_THEMES.has(options.theme) ? options.theme : 'tropical'
    },
    players: [],
    clients: new Map(),
    game: null,
    log: []
  };
  room.players.push(makePlayer(hostToken, hostName, 0));
  rooms.set(code, room);
  log(room, `${cleanName(hostName)} created the room.`);
  return { room, playerToken: hostToken };
}

function makePlayer(playerToken, name, seat) {
  return {
    token: playerToken,
    name: cleanName(name),
    seat,
    connected: true,
    chips: 0,
    hole: [],
    folded: false,
    allIn: false,
    acted: false,
    inHand: false,
    streetBet: 0,
    totalBet: 0,
    lastSeen: Date.now()
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function getRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase());
}

function getPlayer(room, playerToken) {
  return room.players.find(p => p.token === playerToken);
}

function touch(room, player) {
  room.updatedAt = Date.now();
  if (player) {
    player.lastSeen = Date.now();
    player.connected = true;
  }
}

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function draw(game) {
  const card = game.deck.pop();
  if (!card) throw new Error('The deck ran out of cards.');
  return card;
}

function liveIndices(room) {
  return room.players.map((p, i) => p.chips > 0 ? i : -1).filter(i => i >= 0);
}

function nextIndex(room, start, predicate) {
  for (let step = 1; step <= room.players.length; step++) {
    const i = (start + step) % room.players.length;
    if (predicate(room.players[i], i)) return i;
  }
  return null;
}

function nextLive(room, start) {
  return nextIndex(room, start, p => p.chips > 0);
}

function contenders(room) {
  return room.players.filter(p => p.inHand && !p.folded);
}

function actionable(room) {
  return room.players.filter(p => p.inHand && !p.folded && !p.allIn);
}

function amountToCall(room, index) {
  const p = room.players[index];
  return Math.max(0, room.game.currentBet - p.streetBet);
}

function legalRaiseBounds(room, index) {
  const game = room.game;
  const p = room.players[index];
  const maxTotal = p.streetBet + p.chips;
  const normalMin = game.currentBet + game.minRaise;
  const minTotal = Math.min(normalMin, maxTotal);
  const hasResponder = room.players.some((q, i) => i !== index && q.inHand && !q.folded && !q.allIn);
  return {
    minTotal,
    maxTotal,
    canRaise: hasResponder && p.chips > amountToCall(room, index) && maxTotal > game.currentBet
  };
}

function commit(room, index, requested) {
  const p = room.players[index];
  const amount = Math.max(0, Math.min(Math.floor(requested), p.chips));
  p.chips -= amount;
  p.streetBet += amount;
  p.totalBet += amount;
  room.game.pot += amount;
  if (p.chips === 0) p.allIn = true;
  return amount;
}

function postBlind(room, index, amount, label) {
  const p = room.players[index];
  const paid = commit(room, index, amount);
  log(room, `${p.name} posts ${label} ${paid}.`);
}

function clearTurnTimer(room) {
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
      log(room, `${player.name} checks after the turn timer expires.`);
    } else {
      player.folded = true;
      player.acted = true;
      log(room, `${player.name} folds after the turn timer expires.`);
    }
    afterAction(room, actor);
  }, TURN_MS + 25);
}

function startTable(room) {
  if (room.stage !== 'lobby') throw new Error('The table has already started.');
  if (room.players.length < 2) throw new Error('At least two players are required.');
  room.stage = 'playing';
  room.players.forEach((p, i) => {
    p.seat = i;
    p.chips = room.options.buyIn;
  });
  room.game = {
    handNo: 0,
    handId: 0,
    phase: 'idle',
    dealerIndex: crypto.randomInt(room.players.length),
    sbIndex: null,
    bbIndex: null,
    deck: [],
    board: [],
    street: 'preflop',
    pot: 0,
    currentBet: 0,
    minRaise: room.options.bigBlind,
    currentActor: null,
    handOver: true,
    tableOver: false,
    reveal: false,
    status: 'The table is ready.',
    result: null,
    turnDeadline: 0,
    turnTimer: null
  };
  log(room, `The ${room.players.length}-player table started.`);
  startHand(room);
}

function startHand(room) {
  const game = room.game;
  if (!game || game.tableOver) throw new Error('The table is not available.');
  clearTurnTimer(room);
  const live = liveIndices(room);
  if (live.length <= 1) {
    finishTable(room);
    return;
  }
  if (game.handNo > 0) game.dealerIndex = nextLive(room, game.dealerIndex);
  game.handNo += 1;
  game.handId += 1;
  const handId = game.handId;
  game.phase = 'dealing';
  game.deck = makeDeck();
  game.board = [];
  game.street = 'preflop';
  game.pot = 0;
  game.currentBet = 0;
  game.minRaise = room.options.bigBlind;
  game.currentActor = null;
  game.handOver = false;
  game.reveal = false;
  game.phase = 'betting';
  game.result = null;
  game.turnDeadline = 0;

  for (const p of room.players) {
    p.inHand = p.chips > 0;
    p.hole = p.inHand ? [draw(game), draw(game)] : [];
    p.folded = !p.inHand;
    p.allIn = false;
    p.acted = false;
    p.streetBet = 0;
    p.totalBet = 0;
  }

  if (live.length === 2) {
    game.sbIndex = game.dealerIndex;
    game.bbIndex = nextLive(room, game.dealerIndex);
  } else {
    game.sbIndex = nextLive(room, game.dealerIndex);
    game.bbIndex = nextLive(room, game.sbIndex);
  }
  postBlind(room, game.sbIndex, room.options.smallBlind, 'small blind');
  postBlind(room, game.bbIndex, room.options.bigBlind, 'big blind');
  game.currentBet = Math.max(room.players[game.sbIndex].streetBet, room.players[game.bbIndex].streetBet);
  game.currentActor = nextIndex(room, game.bbIndex, p => p.inHand && !p.folded && !p.allIn);
  game.status = `Hand ${game.handNo} · ${room.players[game.currentActor].name} to act`;
  log(room, `Hand ${game.handNo} begins.`);
  broadcast(room);
  if (actionable(room).length < 2) runoutAndShowdown(room, handId);
  else armTurnTimer(room);
}

function needsAction(room, p) {
  return p.inHand && !p.folded && !p.allIn && (!p.acted || p.streetBet !== room.game.currentBet);
}

function roundComplete(room) {
  const active = actionable(room);
  if (active.length === 0) return true;
  return active.every(p => p.acted && p.streetBet === room.game.currentBet);
}

function action(room, playerToken, payload) {
  const game = room.game;
  if (room.stage !== 'playing' || !game || game.handOver || game.phase !== 'betting') throw new Error('There is no active hand.');
  const index = room.players.findIndex(p => p.token === playerToken);
  if (index < 0) throw new Error('Player not found.');
  if (game.currentActor !== index) throw new Error('It is not your turn.');
  const p = room.players[index];
  const type = String(payload.type || '').toLowerCase();
  const owed = amountToCall(room, index);
  clearTurnTimer(room);

  if (type === 'fold') {
    p.folded = true;
    p.acted = true;
    log(room, `${p.name} folds.`);
  } else if (type === 'call' || type === 'check') {
    const paid = commit(room, index, owed);
    p.acted = true;
    log(room, paid ? `${p.name} calls ${paid}${p.allIn ? ' and is all-in' : ''}.` : `${p.name} checks.`);
  } else if (type === 'raise') {
    const bounds = legalRaiseBounds(room, index);
    if (!bounds.canRaise) throw new Error('A raise is not available.');
    const requested = clampInt(payload.total, bounds.minTotal, bounds.maxTotal, bounds.minTotal);
    const target = Math.max(bounds.minTotal, Math.min(requested, bounds.maxTotal));
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
    log(room, `${p.name} ${oldBet ? 'raises to' : 'bets'} ${p.streetBet}${p.allIn ? ' and is all-in' : ''}.`);
  } else {
    throw new Error('Unknown action.');
  }

  afterAction(room, index);
}

function afterAction(room, index) {
  const game = room.game;
  if (contenders(room).length === 1) {
    awardUncontested(room, contenders(room)[0]);
    return;
  }
  if (roundComplete(room)) {
    finishBettingRound(room);
    return;
  }
  const next = nextIndex(room, index, p => needsAction(room, p));
  if (next == null) {
    finishBettingRound(room);
    return;
  }
  game.currentActor = next;
  game.status = `${room.players[next].name} to act`;
  broadcast(room);
  armTurnTimer(room);
}

function finishBettingRound(room) {
  const game = room.game;
  clearTurnTimer(room);
  const handId = game.handId;
  if (game.phase !== 'betting' || game.handOver) return;
  game.phase = 'resolving';
  if (game.street === 'river') {
    showdown(room, handId);
    return;
  }
  if (actionable(room).length < 2) {
    runoutAndShowdown(room, handId);
    return;
  }
  advanceStreet(room);
  room.players.forEach(p => {
    p.streetBet = 0;
    p.acted = false;
  });
  game.currentBet = 0;
  game.minRaise = room.options.bigBlind;
  game.currentActor = nextIndex(room, game.dealerIndex, p => p.inHand && !p.folded && !p.allIn);
  if (game.currentActor == null || actionable(room).length < 2) {
    runoutAndShowdown(room, handId);
    return;
  }
  game.phase = 'betting';
  game.status = `${capitalize(game.street)} · ${room.players[game.currentActor].name} to act`;
  broadcast(room);
  armTurnTimer(room);
}

function advanceStreet(room) {
  const game = room.game;
  if (game.street === 'preflop') {
    game.board.push(draw(game), draw(game), draw(game));
    game.street = 'flop';
    log(room, 'The flop is dealt.');
  } else if (game.street === 'flop') {
    game.board.push(draw(game));
    game.street = 'turn';
    log(room, 'The turn is dealt.');
  } else if (game.street === 'turn') {
    game.board.push(draw(game));
    game.street = 'river';
    log(room, 'The river is dealt.');
  }
}

function runoutAndShowdown(room, expectedHandId = room.game && room.game.handId) {
  const game = room.game;
  if (!game || game.handOver || game.handId !== expectedHandId || !['betting', 'resolving', 'runout'].includes(game.phase)) return;
  clearTurnTimer(room);
  game.phase = 'runout';
  while (game.street !== 'river') advanceStreet(room);
  showdown(room, expectedHandId);
}

function awardUncontested(room, winner) {
  const game = room.game;
  winner.chips += game.pot;
  const amount = game.pot;
  game.pot = 0;
  game.handOver = true;
  game.phase = 'complete';
  game.currentActor = null;
  game.status = `${winner.name} wins ${amount} uncontested.`;
  game.result = { handId: game.handId, handNo: game.handNo, title: `${winner.name} wins`, detail: `${amount} chips · uncontested`, winners: [winner.seat] };
  log(room, game.status);
  finishHand(room);
}

function showdown(room, expectedHandId = room.game && room.game.handId) {
  const game = room.game;
  if (!game || game.handOver || game.handId !== expectedHandId) return;
  if (game.street !== 'river' || game.board.length !== 5 || !['resolving', 'runout'].includes(game.phase)) return;
  clearTurnTimer(room);
  game.phase = 'showdown';
  game.reveal = true;
  const pots = buildSidePots(room);
  const summaries = [];
  const allWinnerSeats = new Set();

  for (const pot of pots) {
    if (pot.eligible.length === 0 || pot.amount <= 0) continue;
    const ranked = pot.eligible.map(index => ({ index, value: evaluate([...room.players[index].hole, ...game.board]) }));
    ranked.sort((a, b) => compareValues(b.value, a.value));
    const best = ranked[0].value;
    const winners = ranked.filter(x => compareValues(x.value, best) === 0).map(x => x.index);
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    winners.forEach(index => {
      room.players[index].chips += share + (remainder-- > 0 ? 1 : 0);
      allWinnerSeats.add(index);
    });
    const names = winners.map(i => room.players[i].name).join(' & ');
    summaries.push(`${names} ${winners.length > 1 ? 'split' : 'wins'} ${pot.amount} with ${handName(best.rank)}`);
  }

  game.pot = 0;
  game.handOver = true;
  game.phase = 'complete';
  game.currentActor = null;
  game.status = summaries.join(' · ');
  game.result = {
    handId: game.handId,
    handNo: game.handNo,
    title: allWinnerSeats.size === 1 ? `${room.players[[...allWinnerSeats][0]].name} wins` : 'Split pot',
    detail: summaries.join(' · '),
    winners: [...allWinnerSeats]
  };
  summaries.forEach(message => log(room, message));
  finishHand(room);
}

function buildSidePots(room) {
  const contributions = room.players.map(p => p.totalBet);
  const levels = [...new Set(contributions.filter(v => v > 0))].sort((a, b) => a - b);
  const pots = [];
  let previous = 0;
  for (const level of levels) {
    const participants = contributions.map((v, i) => v >= level ? i : -1).filter(i => i >= 0);
    const amount = (level - previous) * participants.length;
    const eligible = participants.filter(i => !room.players[i].folded && room.players[i].inHand);
    if (amount > 0) pots.push({ amount, eligible });
    previous = level;
  }
  return pots;
}

function finishHand(room) {
  const game = room.game;
  clearTurnTimer(room);
  const live = liveIndices(room);
  if (live.length <= 1) {
    finishTable(room);
  } else {
    game.status += ' · Host may deal the next hand.';
    broadcast(room);
  }
}

function finishTable(room) {
  const game = room.game;
  clearTurnTimer(room);
  const live = liveIndices(room);
  const winner = live.length === 1 ? room.players[live[0]] : room.players.slice().sort((a, b) => b.chips - a.chips)[0];
  game.tableOver = true;
  game.handOver = true;
  game.phase = 'complete';
  game.currentActor = null;
  game.reveal = true;
  game.status = `${winner.name} wins the table with ${winner.chips} chips.`;
  game.result = { handId: game.handId, handNo: game.handNo, title: `${winner.name} wins the table`, detail: `${winner.chips} chips`, winners: [winner.seat], tableOver: true };
  log(room, game.status);
  broadcast(room);
}

function resetToLobby(room) {
  clearTurnTimer(room);
  room.stage = 'lobby';
  room.game = null;
  room.players.forEach((p, i) => {
    p.seat = i;
    p.chips = 0;
    p.hole = [];
    p.folded = false;
    p.allIn = false;
    p.acted = false;
    p.inHand = false;
    p.streetBet = 0;
    p.totalBet = 0;
  });
  log(room, 'The host returned the room to the lobby.');
  broadcast(room);
}

function updateOptions(room, values) {
  if (room.stage !== 'lobby') throw new Error('Options can only be changed in the lobby.');
  room.options.maxPlayers = clampInt(values.maxPlayers, Math.max(2, room.players.length), 6, room.options.maxPlayers);
  room.options.buyIn = clampInt(values.buyIn, 100, 10000, room.options.buyIn);
  const bb = Math.max(2, Math.floor(room.options.buyIn / 50));
  room.options.bigBlind = bb;
  room.options.smallBlind = Math.max(1, Math.floor(bb / 2));
  if (ROOM_THEMES.has(values.theme)) room.options.theme = values.theme;
  broadcast(room);
}

function joinRoom(room, name, requestedToken) {
  let player = requestedToken ? getPlayer(room, requestedToken) : null;
  if (player) {
    player.connected = true;
    player.name = cleanName(name || player.name);
    player.lastSeen = Date.now();
    log(room, `${player.name} reconnected.`);
    return player.token;
  }
  if (room.stage !== 'lobby') throw new Error('This table has already started. Rejoin with the same browser instead.');
  if (room.players.length >= room.options.maxPlayers) throw new Error('This room is full.');
  const playerToken = token();
  player = makePlayer(playerToken, name, room.players.length);
  room.players.push(player);
  log(room, `${player.name} joined the room.`);
  broadcast(room);
  return playerToken;
}

function leaveRoom(room, playerToken) {
  const player = getPlayer(room, playerToken);
  if (!player) return;
  if (room.stage === 'lobby') {
    const index = room.players.indexOf(player);
    room.players.splice(index, 1);
    room.players.forEach((p, i) => p.seat = i);
    room.clients.delete(playerToken);
    log(room, `${player.name} left the room.`);
    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostToken === playerToken) room.hostToken = room.players[0].token;
  } else {
    player.connected = false;
    player.lastSeen = Date.now();
    log(room, `${player.name} disconnected and may rejoin.`);
    if (room.game && !room.game.handOver && room.game.phase === 'betting' && room.game.currentActor === player.seat) {
      clearTurnTimer(room);
      const owed = amountToCall(room, player.seat);
      if (owed === 0) player.acted = true;
      else { player.folded = true; player.acted = true; }
      afterAction(room, player.seat);
      return;
    }
  }
  broadcast(room);
}

function publicState(room, viewerToken) {
  const viewerIndex = room.players.findIndex(p => p.token === viewerToken);
  const game = room.game;
  const players = room.players.map((p, index) => {
    const revealHole = game && game.handOver && game.phase === 'complete' && game.reveal && p.inHand && !p.folded;
    const self = index === viewerIndex;
    return {
      seat: index,
      name: p.name,
      connected: p.connected,
      chips: p.chips,
      folded: p.folded,
      allIn: p.allIn,
      inHand: p.inHand,
      streetBet: p.streetBet,
      isHost: p.token === room.hostToken,
      isSelf: self,
      hole: self || revealHole ? p.hole : p.hole.map(() => null)
    };
  });
  let legal = { canAct: false, toCall: 0, canRaise: false, minRaiseTotal: 0, maxRaiseTotal: 0 };
  if (game && !game.handOver && game.phase === 'betting' && viewerIndex >= 0 && game.currentActor === viewerIndex) {
    const bounds = legalRaiseBounds(room, viewerIndex);
    legal = {
      canAct: true,
      toCall: Math.min(amountToCall(room, viewerIndex), room.players[viewerIndex].chips),
      canRaise: bounds.canRaise,
      minRaiseTotal: bounds.minTotal,
      maxRaiseTotal: bounds.maxTotal
    };
  }
  return {
    serverTime: Date.now(),
    room: room.code,
    stage: room.stage,
    isHost: viewerToken === room.hostToken,
    options: room.options,
    players,
    game: game ? {
      handNo: game.handNo,
      handId: game.handId,
      phase: game.phase,
      dealerIndex: game.dealerIndex,
      sbIndex: game.sbIndex,
      bbIndex: game.bbIndex,
      board: game.board,
      street: game.street,
      pot: game.pot,
      currentBet: game.currentBet,
      currentActor: game.currentActor,
      handOver: game.handOver,
      tableOver: game.tableOver,
      status: game.status,
      result: game.handOver && game.phase === 'complete' && game.result && Number(game.result.handId) === Number(game.handId) && (game.result.tableOver || Number(game.result.handNo) === Number(game.handNo)) ? game.result : null,
      turnDeadline: game.turnDeadline
    } : null,
    legal,
    log: room.log
  };
}

function sendEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(room) {
  room.updatedAt = Date.now();
  for (const [playerToken, res] of room.clients.entries()) {
    try { sendEvent(res, 'state', publicState(room, playerToken)); }
    catch (_) { room.clients.delete(playerToken); }
  }
}

function rankCounts(cards) {
  const counts = new Map();
  for (const card of cards) counts.set(card.r, (counts.get(card.r) || 0) + 1);
  return counts;
}

function straightHigh(ranks) {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let i = 0; i <= unique.length - 5; i++) {
    let ok = true;
    for (let j = 1; j < 5; j++) if (unique[i + j] !== unique[i] - j) ok = false;
    if (ok) return unique[i];
  }
  return 0;
}

function evaluate(cards) {
  const bySuit = new Map(SUITS.map(s => [s, []]));
  for (const card of cards) bySuit.get(card.s).push(card.r);
  for (const ranks of bySuit.values()) {
    if (ranks.length >= 5) {
      const high = straightHigh(ranks);
      if (high) return { rank: high === 14 ? 9 : 8, tiebreak: [high] };
    }
  }
  const counts = rankCounts(cards);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const four = groups.find(([, c]) => c === 4);
  if (four) {
    const kicker = Math.max(...groups.filter(([r]) => r !== four[0]).map(([r]) => r));
    return { rank: 7, tiebreak: [four[0], kicker] };
  }
  const trips = groups.filter(([, c]) => c >= 3).map(([r]) => r).sort((a, b) => b - a);
  const pairs = groups.filter(([, c]) => c >= 2).map(([r]) => r).sort((a, b) => b - a);
  if (trips.length && pairs.some(r => r !== trips[0])) {
    const pair = pairs.find(r => r !== trips[0]);
    return { rank: 6, tiebreak: [trips[0], pair] };
  }
  for (const ranks of bySuit.values()) {
    if (ranks.length >= 5) return { rank: 5, tiebreak: ranks.sort((a, b) => b - a).slice(0, 5) };
  }
  const straight = straightHigh(cards.map(c => c.r));
  if (straight) return { rank: 4, tiebreak: [straight] };
  if (trips.length) {
    const kickers = groups.filter(([r]) => r !== trips[0]).map(([r]) => r).sort((a, b) => b - a).slice(0, 2);
    return { rank: 3, tiebreak: [trips[0], ...kickers] };
  }
  const exactPairs = groups.filter(([, c]) => c >= 2).map(([r]) => r).sort((a, b) => b - a);
  if (exactPairs.length >= 2) {
    const high = exactPairs[0], low = exactPairs[1];
    const kicker = Math.max(...groups.filter(([r]) => r !== high && r !== low).map(([r]) => r));
    return { rank: 2, tiebreak: [high, low, kicker] };
  }
  if (exactPairs.length === 1) {
    const pair = exactPairs[0];
    const kickers = groups.filter(([r]) => r !== pair).map(([r]) => r).sort((a, b) => b - a).slice(0, 3);
    return { rank: 1, tiebreak: [pair, ...kickers] };
  }
  return { rank: 0, tiebreak: [...counts.keys()].sort((a, b) => b - a).slice(0, 5) };
}

function compareValues(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const length = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < length; i++) {
    const diff = (a.tiebreak[i] || 0) - (b.tiebreak[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function handName(rank) {
  return ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush', 'Royal Flush'][rank] || 'Hand';
}

function capitalize(value) {
  const s = String(value || '');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function serveStatic(req, res, pathname) {
  let relative = pathname === '/' ? '/index.html' : pathname;
  relative = decodeURIComponent(relative).replace(/\\/g, '/');
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, commonHeaders()); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, commonHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
    };
    res.writeHead(200, commonHeaders({ 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' }));
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleApi(req, res, pathname, url) {
  try {
    if (req.method === 'GET' && pathname === '/api/info') {
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const host = req.headers.host || `localhost:${PORT}`;
      return json(res, 200, { ok: true, publicUrl: `${proto}://${host}` });
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true, version: 'hand-state-fix-2', rooms: rooms.size, now: Date.now() });
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      const room = getRoom(url.searchParams.get('room'));
      const playerToken = url.searchParams.get('token');
      if (!room || !getPlayer(room, playerToken)) {
        res.writeHead(404, commonHeaders()); res.end(); return;
      }
      const player = getPlayer(room, playerToken);
      touch(room, player);
      res.writeHead(200, commonHeaders({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }));
      res.write(': connected\n\n');
      const previous = room.clients.get(playerToken);
      if (previous && previous !== res) { try { previous.end(); } catch (_) {} }
      room.clients.set(playerToken, res);
      sendEvent(res, 'state', publicState(room, playerToken));
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        if (room.clients.get(playerToken) === res) room.clients.delete(playerToken);
        player.connected = false;
        broadcast(room);
      });
      return;
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
    const body = await readJson(req);

    if (pathname === '/api/create') {
      const { room, playerToken } = createRoom(body.name, body.options || {});
      broadcast(room);
      return json(res, 200, { room: room.code, token: playerToken, state: publicState(room, playerToken) });
    }
    if (pathname === '/api/join') {
      const room = getRoom(body.room);
      if (!room) throw new Error('Room not found. Check the four-character code.');
      const playerToken = joinRoom(room, body.name, body.token);
      touch(room, getPlayer(room, playerToken));
      return json(res, 200, { room: room.code, token: playerToken, state: publicState(room, playerToken) });
    }

    const room = getRoom(body.room);
    if (!room) throw new Error('Room not found.');
    const player = getPlayer(room, body.token);
    if (!player) throw new Error('Player session not found. Rejoin the room.');
    touch(room, player);

    if (pathname === '/api/options') {
      if (room.hostToken !== body.token) throw new Error('Only the host can change table options.');
      updateOptions(room, body.options || {});
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/start') {
      if (room.hostToken !== body.token) throw new Error('Only the host can start the table.');
      startTable(room);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/action') {
      action(room, body.token, body.action || {});
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/next-hand') {
      if (room.hostToken !== body.token) throw new Error('Only the host can deal the next hand.');
      if (!room.game || !room.game.handOver || room.game.tableOver) throw new Error('The current hand is not ready to continue.');
      startHand(room);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/reset-lobby') {
      if (room.hostToken !== body.token) throw new Error('Only the host can return to the lobby.');
      resetToLobby(room);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/leave') {
      leaveRoom(room, body.token);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Unknown API route.' });
  } catch (err) {
    return json(res, 400, { error: err.message || 'Request failed.' });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, commonHeaders());
    res.end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname, url);
  serveStatic(req, res, url.pathname);
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > ROOM_IDLE_MS) {
      clearTurnTimer(room);
      for (const res of room.clients.values()) { try { res.end(); } catch (_) {} }
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`Sivel Poker Online listening on ${publicUrl}`);
});
