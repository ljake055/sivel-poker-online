'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAccountStore } = require('./account-store');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const TURN_MS = 30000;
const ROOM_IDLE_MS = 4 * 60 * 60 * 1000;

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const ROOM_THEMES = new Set(['tropical', 'castle', 'penthouse', 'underground']);
const PROFILE_AVATARS = new Set(['🕶️','🦊','🐺','🦁','🐉','👑','⚡','🎯','🃏','🤖','👻','🧙‍♂️','🦅','🔥','💎','🥷']);
const CHAT_MAX_LENGTH = 220;
const CHAT_MAX_MESSAGES = 80;
const CHAT_RATE_MS = 750;
const PUBLIC_NEXT_HAND_MS = 3800;
const PUBLIC_DISCONNECT_GRACE_MS = 90 * 1000;
const PUBLIC_TABLE_DEFINITIONS = Object.freeze([
  { id: 'starter', code: 'ST01', name: 'Sivel Starter', description: 'Fast heads-up action', maxPlayers: 2, buyIn: 500, smallBlind: 5, bigBlind: 10, theme: 'tropical' },
  { id: 'main-room', code: 'MAIN', name: 'The Main Room', description: 'Four-seat classic cash game', maxPlayers: 4, buyIn: 1000, smallBlind: 10, bigBlind: 20, theme: 'penthouse' },
  { id: 'high-stakes', code: 'VIP1', name: 'Sivel High Stakes', description: 'Six-seat premium table', maxPlayers: 6, buyIn: 2500, smallBlind: 25, bigBlind: 50, theme: 'underground' }
]);
const accounts = createAccountStore({ databaseUrl: process.env.DATABASE_URL, production: process.env.NODE_ENV === 'production' });
const loginAttempts = new Map();
const socialClients = new Map();
const socialMessageTimes = new Map();
const SOCIAL_MESSAGE_RATE_MS = 650;




function socialSend(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function socialOnline(userId) {
  const set = socialClients.get(Number(userId));
  return !!(set && set.size);
}

function decorateSocialSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  snapshot.friends = (snapshot.friends || []).map(friend => ({ ...friend, online: socialOnline(friend.id) }));
  snapshot.incomingRequests = (snapshot.incomingRequests || []).map(request => ({ ...request, user: { ...request.user, online: socialOnline(request.user.id) } }));
  snapshot.outgoingRequests = (snapshot.outgoingRequests || []).map(request => ({ ...request, user: { ...request.user, online: socialOnline(request.user.id) } }));
  snapshot.blocked = (snapshot.blocked || []).map(user => ({ ...user, online: socialOnline(user.id) }));
  snapshot.invites = (snapshot.invites || []).map(invite => ({ ...invite, inviter: { ...invite.inviter, online: socialOnline(invite.inviter.id) } }));
  return snapshot;
}

async function socialSnapshotFor(userId) {
  return decorateSocialSnapshot(await accounts.socialSnapshot(userId));
}

async function broadcastSocial(userIds) {
  const unique = [...new Set((userIds || []).map(Number).filter(Boolean))];
  await Promise.all(unique.map(async userId => {
    const clients = socialClients.get(userId);
    if (!clients || !clients.size) return;
    try {
      const snapshot = await socialSnapshotFor(userId);
      for (const res of [...clients]) {
        try { socialSend(res, 'snapshot', snapshot); }
        catch (_) { clients.delete(res); }
      }
    } catch (err) {
      console.error('Social broadcast failed:', err);
    }
  }));
}

async function broadcastPresence(userId) {
  const ids = await accounts.friendIds(userId).catch(() => []);
  ids.push(Number(userId));
  await broadcastSocial(ids);
}

function checkSocialMessageRate(userId) {
  const now = Date.now();
  const last = socialMessageTimes.get(Number(userId)) || 0;
  if (now - last < SOCIAL_MESSAGE_RATE_MS) throw new Error('Please wait a moment before sending another message.');
  socialMessageTimes.set(Number(userId), now);
}


function cleanAdminText(value, max = 180) {
  return String(value || '').replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function adminRoomSnapshot() {
  return [...rooms.values()].map(room => ({
    code: room.code,
    name: room.isPublic ? room.publicName : `Private Table · ${room.code}`,
    isPublic: !!room.isPublic,
    stage: room.stage,
    theme: room.options.theme,
    seated: room.players.filter(player => !player.cashedOut).length,
    maxPlayers: room.options.maxPlayers,
    players: room.players.filter(player => !player.cashedOut).map(player => ({
      userId: Number(player.userId), username: player.username, name: player.name, avatar: player.avatar,
      chips: Number(player.chips || 0), connected: !!player.connected, isAdmin: !!player.isAdmin
    }))
  }));
}

async function sendAdminAnnouncement(admin, text) {
  const message = cleanAdminText(text, 180);
  if (!message) throw new Error('Enter an announcement first.');
  for (const room of rooms.values()) {
    pushChat(room, { system: true, senderToken: '', name: 'Sivel Poker Admin', avatar: '👑', role: 'admin', isAdmin: true, text: `ANNOUNCEMENT · ${message}` });
    broadcast(room);
  }
  for (const clients of socialClients.values()) {
    for (const response of [...clients]) {
      try { socialSend(response, 'announcement', { text: message, by: admin.displayName, username: admin.username, at: Date.now() }); }
      catch (_) { clients.delete(response); }
    }
  }
  await accounts.recordAdminAction(admin.id, null, 'global_announcement', { text: message });
  return message;
}

function commonHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

function authTokenFrom(req, body = {}) {
  const header = String(req.headers.authorization || '');
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  return String(body.authToken || bearer || '').trim();
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function checkLoginRate(req, username) {
  const key = `${clientIp(req)}:${String(username || '').toLowerCase()}`;
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter(at => now - at < 10 * 60 * 1000);
  if (recent.length >= 8) throw new Error('Too many login attempts. Please wait a few minutes.');
  recent.push(now);
  loginAttempts.set(key, recent);
  return key;
}

function clearLoginRate(key) {
  if (key) loginAttempts.delete(key);
}

function cleanName(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 18) || 'Player';
}

function cleanAvatar(value) {
  const avatar = String(value || '').trim();
  return PROFILE_AVATARS.has(avatar) ? avatar : '♠';
}

function cleanChatText(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LENGTH);
}

function pushChat(room, message) {
  room.chat.push({ id: crypto.randomUUID(), at: Date.now(), ...message });
  room.chat = room.chat.slice(-CHAT_MAX_MESSAGES);
}

function systemChat(room, text) {
  pushChat(room, { system: true, senderToken: '', name: 'Sivel Poker', avatar: '♠', text });
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

function createRoom(hostAccount, options = {}) {
  const code = roomCode();
  const hostToken = token();
  const maxPlayers = clampInt(options.maxPlayers, 2, 6, 6);
  const buyIn = clampInt(options.buyIn, 100, 10000, 500);
  const bigBlind = Math.max(2, Math.floor(buyIn / 50));
  const room = {
    id: crypto.randomUUID(),
    code,
    hostToken,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stage: 'lobby',
    settlementStarted: false,
    settlementComplete: false,
    isPublic: false,
    publicId: null,
    publicName: '',
    publicDescription: '',
    publicNextTimer: null,
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
    log: [],
    chat: []
  };
  room.players.push(makePlayer(hostToken, hostAccount, 0, buyIn));
  rooms.set(code, room);
  log(room, `${hostAccount.displayName} created the room.`);
  systemChat(room, `${hostAccount.displayName} opened the table chat.`);
  return { room, playerToken: hostToken };
}

function createPublicRoom(definition) {
  const room = {
    id: crypto.randomUUID(),
    code: definition.code,
    hostToken: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stage: 'lobby',
    settlementStarted: false,
    settlementComplete: false,
    isPublic: true,
    publicId: definition.id,
    publicName: definition.name,
    publicDescription: definition.description,
    publicNextTimer: null,
    options: {
      maxPlayers: definition.maxPlayers,
      buyIn: definition.buyIn,
      smallBlind: definition.smallBlind,
      bigBlind: definition.bigBlind,
      theme: definition.theme
    },
    players: [],
    clients: new Map(),
    game: null,
    log: [],
    chat: []
  };
  rooms.set(room.code, room);
  systemChat(room, `${room.publicName} is open.`);
  log(room, `${room.publicName} opened as a permanent public table.`);
  return room;
}

function ensurePublicTables() {
  for (const definition of PUBLIC_TABLE_DEFINITIONS) {
    const existing = rooms.get(definition.code);
    if (!existing || !existing.isPublic) createPublicRoom(definition);
  }
}

function publicRoomById(value) {
  const key = String(value || '').trim().toLowerCase();
  return [...rooms.values()].find(room => room.isPublic && (room.publicId === key || room.code.toLowerCase() === key));
}

function seatedPlayers(room) {
  return room.players.filter(player => !player.cashedOut);
}

function clearPublicNextTimer(room) {
  if (room && room.publicNextTimer) clearTimeout(room.publicNextTimer);
  if (room) room.publicNextTimer = null;
}

function compactPublicPlayers(room) {
  if (!room || !room.isPublic) return;
  const dealerToken = room.game && room.game.dealerIndex != null && room.players[room.game.dealerIndex]
    ? room.players[room.game.dealerIndex].token : null;
  const removed = room.players.filter(player => player.cashedOut);
  removed.forEach(player => { if (player.disconnectTimer) clearTimeout(player.disconnectTimer); });
  room.players = room.players.filter(player => !player.cashedOut);
  room.players.forEach((player, index) => { player.seat = index; });
  if (room.game) {
    const dealerIndex = dealerToken ? room.players.findIndex(player => player.token === dealerToken) : -1;
    room.game.dealerIndex = dealerIndex >= 0 ? dealerIndex : Math.max(0, Math.min(room.game.dealerIndex || 0, room.players.length - 1));
  }
}

function publicTableSummary(room) {
  const seated = seatedPlayers(room);
  const activeHand = !!(room.game && !room.game.handOver && room.game.phase === 'betting');
  const physicalSeatsAvailable = !activeHand || room.players.length < room.options.maxPlayers;
  const joinable = seated.length < room.options.maxPlayers && physicalSeatsAvailable;
  let status = 'Waiting for players';
  if (activeHand) status = `Hand ${room.game.handNo} in progress`;
  else if (room.game && room.game.handOver && liveIndices(room).length >= 2) status = 'Next hand starting';
  else if (seated.length === 1) status = 'One player waiting';
  return {
    id: room.publicId,
    code: room.code,
    name: room.publicName,
    description: room.publicDescription,
    theme: room.options.theme,
    maxPlayers: room.options.maxPlayers,
    buyIn: room.options.buyIn,
    smallBlind: room.options.smallBlind,
    bigBlind: room.options.bigBlind,
    seated: seated.length,
    connected: seated.filter(player => player.connected).length,
    joinable,
    status,
    stage: room.stage,
    handNo: room.game ? room.game.handNo : 0,
    players: seated.map(player => ({ name: player.name, avatar: cleanAvatar(player.avatar), chips: player.chips, role: player.role || 'player', isAdmin: !!player.isAdmin }))
  };
}

function schedulePublicPlay(room, delay = PUBLIC_NEXT_HAND_MS) {
  if (!room || !room.isPublic) return;
  clearPublicNextTimer(room);
  const enoughPlayers = room.stage === 'lobby' ? seatedPlayers(room).length >= 2 : liveIndices(room).length >= 2;
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
      else if (room.game && room.game.handOver && !room.game.tableOver && liveIndices(room).length >= 2) startHand(room);
    } catch (err) {
      console.error(`Unable to continue public table ${room.code}:`, err);
      if (room.game) room.game.status = 'The table is waiting to restart.';
      broadcast(room);
    }
  }, Math.max(250, Number(delay) || PUBLIC_NEXT_HAND_MS));
  if (room.publicNextTimer.unref) room.publicNextTimer.unref();
}

function resetPublicRoom(room) {
  clearTurnTimer(room);
  clearPublicNextTimer(room);
  for (const response of room.clients.values()) { try { response.end(); } catch (_) {} }
  room.clients.clear();
  room.players.forEach(player => { if (player.disconnectTimer) clearTimeout(player.disconnectTimer); });
  room.players = [];
  room.hostToken = '';
  room.stage = 'lobby';
  room.game = null;
  room.updatedAt = Date.now();
  room.log = [];
  room.chat = [];
  systemChat(room, `${room.publicName} is open.`);
  log(room, `${room.publicName} reset and reopened.`);
}

function makePlayer(playerToken, account, seat, buyIn) {
  return {
    token: playerToken,
    userId: account.id,
    username: account.username,
    role: account.role || 'player',
    isAdmin: !!account.isAdmin,
    name: cleanName(account.displayName),
    avatar: cleanAvatar(account.avatar),
    walletBalance: Number(account.bankroll),
    reservedBuyIn: Number(buyIn) || 0,
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
    lastSeen: Date.now(),
    lastChatAt: 0,
    cashOutPending: false,
    cashedOut: false,
    waitingForNextHand: false,
    disconnectTimer: null
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
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
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
  return room.players.map((p, i) => p.chips > 0 && !p.cashedOut ? i : -1).filter(i => i >= 0);
}

function nextIndex(room, start, predicate) {
  for (let step = 1; step <= room.players.length; step++) {
    const i = (start + step) % room.players.length;
    if (predicate(room.players[i], i)) return i;
  }
  return null;
}

function nextLive(room, start) {
  return nextIndex(room, start, p => p.chips > 0 && !p.cashedOut);
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
  if (room.isPublic) compactPublicPlayers(room);
  if (seatedPlayers(room).length < 2) throw new Error('At least two players are required.');
  room.stage = 'playing';
  room.players.forEach((p, i) => {
    p.seat = i;
    p.chips = Number(p.reservedBuyIn) || room.options.buyIn;
    p.waitingForNextHand = false;
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
  if (room.isPublic) compactPublicPlayers(room);
  const live = liveIndices(room);
  if (live.length <= 1) {
    if (room.isPublic) {
      game.handOver = true;
      game.tableOver = false;
      game.phase = 'waiting';
      game.currentActor = null;
      game.status = 'Waiting for another player to take a seat.';
      broadcast(room);
    } else finishTable(room);
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
    p.waitingForNextHand = !p.inHand;
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
  if (p.cashOutPending || p.cashedOut) throw new Error('This seat is cashing out.');
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
  if (room.isPublic) {
    game.tableOver = false;
    game.status += live.length >= 2 ? ' · Next hand deals automatically.' : ' · Waiting for another player.';
    broadcast(room);
    schedulePublicPlay(room);
  } else if (live.length <= 1) {
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
  if (room.isPublic) {
    game.tableOver = false;
    game.handOver = true;
    game.phase = 'waiting';
    game.currentActor = null;
    game.status = 'Waiting for another player to take a seat.';
    broadcast(room);
    schedulePublicPlay(room);
    return;
  }
  const winner = live.length === 1 ? room.players[live[0]] : room.players.slice().sort((a, b) => b.chips - a.chips)[0];
  game.tableOver = true;
  game.handOver = true;
  game.phase = 'complete';
  game.currentActor = null;
  game.reveal = true;
  game.status = `${winner.name} wins the table with ${winner.chips} chips. Settling the online bankroll…`;
  game.result = { handId: game.handId, handNo: game.handNo, title: `${winner.name} wins the table`, detail: `${winner.chips} chips`, winners: [winner.seat], tableOver: true };
  log(room, `${winner.name} wins the table with ${winner.chips} chips.`);
  broadcast(room);
  if (!room.settlementStarted) {
    room.settlementStarted = true;
    accounts.settleTable({ tableId: room.id, winnerPlayerToken: winner.token, payout: winner.chips, biggestPot: winner.chips })
      .then(account => {
        room.settlementComplete = true;
        if (account) winner.walletBalance = Number(account.bankroll);
        game.status = `${winner.name} wins the table with ${winner.chips} chips. Online bankroll settled.`;
        broadcast(room);
      })
      .catch(err => {
        room.settlementStarted = false;
        game.status = `${winner.name} wins the table. Bankroll settlement needs attention.`;
        console.error('Table settlement failed:', err);
        broadcast(room);
      });
  }
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
  const requestedBuyIn = clampInt(values.buyIn, 100, 10000, room.options.buyIn);
  if (requestedBuyIn !== room.options.buyIn) throw new Error('The buy-in is locked after the room is created. Create a new room to use different stakes.');
  if (ROOM_THEMES.has(values.theme)) room.options.theme = values.theme;
  broadcast(room);
}

function joinRoom(room, account, requestedToken, newPlayerToken) {
  if (room.isPublic) throw new Error('Choose this table from the Public Tables list.');
  let player = requestedToken ? getPlayer(room, requestedToken) : null;
  if (player) {
    if (Number(player.userId) !== Number(account.id)) throw new Error('That saved seat belongs to a different account.');
    player.connected = true;
    player.name = cleanName(account.displayName);
    player.avatar = cleanAvatar(account.avatar);
    player.walletBalance = Number(account.bankroll);
    player.lastSeen = Date.now();
    log(room, `${player.name} reconnected.`);
    systemChat(room, `${player.name} reconnected.`);
    return player.token;
  }
  if (room.stage !== 'lobby') throw new Error('This table has already started. Rejoin with the same browser instead.');
  if (room.players.length >= room.options.maxPlayers) throw new Error('This room is full.');
  if (room.players.some(p => Number(p.userId) === Number(account.id))) throw new Error('This account already has a seat at this table.');
  const playerToken = newPlayerToken || token();
  player = makePlayer(playerToken, account, room.players.length, room.options.buyIn);
  room.players.push(player);
  log(room, `${player.name} joined the room.`);
  systemChat(room, `${player.name} joined the table.`);
  broadcast(room);
  return playerToken;
}

async function joinPublicRoom(room, account, authToken, requestedToken) {
  if (!room || !room.isPublic) throw new Error('Public table not found.');
  if (room.game && room.game.handOver) compactPublicPlayers(room);

  let player = requestedToken ? getPlayer(room, requestedToken) : null;
  if (!player) player = room.players.find(candidate => !candidate.cashedOut && Number(candidate.userId) === Number(account.id));
  if (player) {
    player.connected = true;
    player.name = cleanName(account.displayName);
    player.avatar = cleanAvatar(account.avatar);
    player.walletBalance = Number(account.bankroll);
    player.lastSeen = Date.now();
    systemChat(room, `${player.name} reconnected.`);
    broadcast(room);
    return { playerToken: player.token, account: await accounts.requireAuth(authToken) };
  }

  const seated = seatedPlayers(room);
  if (seated.length >= room.options.maxPlayers) throw new Error('This public table is full.');
  if (room.game && !room.game.handOver && room.players.length >= room.options.maxPlayers) {
    throw new Error('A seat is opening after the current hand. Try again in a moment.');
  }

  const playerToken = token();
  const remaining = await accounts.reserveBuyIn({
    userId: account.id,
    amount: room.options.buyIn,
    tableId: room.id,
    roomCode: room.code,
    playerToken
  });
  account.bankroll = remaining;
  player = makePlayer(playerToken, account, room.players.length, room.options.buyIn);
  player.walletBalance = remaining;
  if (room.stage === 'playing') {
    player.chips = room.options.buyIn;
    player.folded = true;
    player.inHand = false;
    player.waitingForNextHand = true;
  }
  room.players.push(player);
  if (!room.hostToken) room.hostToken = playerToken;
  log(room, `${player.name} joined ${room.publicName}.`);
  systemChat(room, `${player.name} took a seat${room.stage === 'playing' ? ' and will enter on the next hand' : ''}.`);
  broadcast(room);
  if (room.stage === 'lobby' && seatedPlayers(room).length >= 2) schedulePublicPlay(room, 700);
  else if (room.stage === 'playing' && room.game && room.game.handOver) schedulePublicPlay(room, 900);
  return { playerToken, account: await accounts.requireAuth(authToken) };
}

function sendChatMessage(room, player, value) {
  const text = cleanChatText(value);
  if (!text) throw new Error('Type a message before sending.');
  const now = Date.now();
  if (now - (player.lastChatAt || 0) < CHAT_RATE_MS) throw new Error('Please wait a moment before sending another message.');
  player.lastChatAt = now;
  pushChat(room, {
    system: false,
    senderToken: player.token,
    name: player.name,
    avatar: cleanAvatar(player.avatar),
    role: player.role || 'player',
    isAdmin: !!player.isAdmin,
    text
  });
  broadcast(room);
}

async function leaveRoom(room, playerToken) {
  const player = getPlayer(room, playerToken);
  if (!player) return { account: null, payout: 0 };
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectTimer = null;

  const stream = room.clients.get(playerToken);
  if (stream) {
    try { stream.end(); } catch (_) {}
    room.clients.delete(playerToken);
  }

  if (room.stage === 'lobby') {
    const account = await accounts.refundPlayer(playerToken, 'lobby_leave_refund');
    const payout = Number(player.reservedBuyIn) || Number(room.options.buyIn) || 0;
    const index = room.players.indexOf(player);
    room.players.splice(index, 1);
    room.players.forEach((p, i) => p.seat = i);
    log(room, `${player.name} left the room and received ${payout} chips back.`);
    systemChat(room, `${player.name} left the table.`);
    if (room.players.length === 0) {
      if (room.isPublic) {
        room.hostToken = '';
        room.updatedAt = Date.now();
        broadcast(room);
      } else rooms.delete(room.code);
      return { account, payout };
    }
    if (room.hostToken === playerToken) room.hostToken = room.players[0].token;
    broadcast(room);
    return { account, payout };
  }

  if (player.cashOutPending) throw new Error('Your cash-out is already being processed.');
  player.cashOutPending = true;
  const payout = Math.max(0, Math.floor(Number(player.chips) || 0));
  let cashout;
  try {
    cashout = await accounts.cashOutPlayer(playerToken, payout, 'table_cash_out');
  } catch (err) {
    player.cashOutPending = false;
    throw err;
  }

  if (cashout.account) player.walletBalance = Number(cashout.account.bankroll);
  player.cashOutPending = false;
  player.cashedOut = true;
  player.connected = false;
  player.lastSeen = Date.now();
  player.chips = 0;
  player.folded = true;
  player.allIn = false;
  player.acted = true;
  player.inHand = false;

  log(room, `${player.name} cashed out ${payout} chips and left the table.`);
  systemChat(room, `${player.name} cashed out and left the table.`);

  if (room.hostToken === playerToken) {
    const nextHost = room.players.find(p => !p.cashedOut && p.chips > 0);
    if (nextHost) room.hostToken = nextHost.token;
  }

  const game = room.game;
  if (game && !game.tableOver) {
    if (!game.handOver && game.phase === 'betting') {
      const remaining = contenders(room);
      if (remaining.length === 1) {
        clearTurnTimer(room);
        awardUncontested(room, remaining[0]);
      } else if (game.currentActor === player.seat) {
        clearTurnTimer(room);
        afterAction(room, player.seat);
      } else {
        broadcast(room);
      }
    } else if (liveIndices(room).length <= 1) {
      finishTable(room);
    } else {
      broadcast(room);
    }
  } else {
    broadcast(room);
  }

  if (room.isPublic) schedulePublicPlay(room, 900);
  return { account: cashout.account || null, payout: cashout.payout ?? payout };
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
      avatar: cleanAvatar(p.avatar),
      role: p.role || 'player',
      isAdmin: !!p.isAdmin,
      connected: p.connected,
      cashedOut: !!p.cashedOut,
      waitingForNextHand: !!p.waitingForNextHand,
      chips: p.chips,
      folded: p.folded,
      allIn: p.allIn,
      inHand: p.inHand,
      streetBet: p.streetBet,
      isHost: !room.isPublic && p.token === room.hostToken,
      isSelf: self,
      onlineBankroll: self ? Number(p.walletBalance) : null,
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
    isPublic: !!room.isPublic,
    publicId: room.publicId,
    publicName: room.publicName,
    publicDescription: room.publicDescription,
    isHost: !room.isPublic && viewerToken === room.hostToken,
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
    chat: room.chat.map(message => ({
      id: message.id,
      at: message.at,
      name: message.name,
      avatar: message.avatar,
      text: message.text,
      system: !!message.system,
      role: message.role || 'player',
      isAdmin: !!message.isAdmin,
      isSelf: !!message.senderToken && message.senderToken === viewerToken
    })),
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
      const database = await accounts.health();
      return json(res, 200, { ok: true, version: 'daily-spin-1', database: database.ok, rooms: rooms.size, publicTables: PUBLIC_TABLE_DEFINITIONS.length, now: Date.now() });
    }
    if (req.method === 'GET' && pathname === '/api/public-tables') {
      ensurePublicTables();
      const tables = PUBLIC_TABLE_DEFINITIONS.map(definition => publicTableSummary(rooms.get(definition.code)));
      return json(res, 200, { ok: true, tables, now: Date.now() });
    }
    if (req.method === 'GET' && pathname === '/api/account') {
      const account = await accounts.requireAuth(authTokenFrom(req));
      return json(res, 200, { ok: true, account });
    }
    if (req.method === 'GET' && pathname === '/api/daily-spin') {
      const account = await accounts.requireAuth(authTokenFrom(req));
      const status = await accounts.dailySpinStatus(account.id);
      return json(res, 200, { ok: true, status });
    }
    if (req.method === 'GET' && pathname === '/api/wallet/transactions') {
      const account = await accounts.requireAuth(authTokenFrom(req));
      const transactions = await accounts.recentTransactions(account.id, url.searchParams.get('limit'));
      return json(res, 200, { ok: true, transactions });
    }

    if (req.method === 'GET' && pathname === '/api/admin/overview') {
      const admin = await accounts.requireAdmin(authTokenFrom(req));
      const overview = await accounts.adminOverview();
      return json(res, 200, { ok: true, admin, overview: { ...overview, rooms: adminRoomSnapshot() } });
    }
    if (req.method === 'GET' && pathname === '/api/admin/users') {
      await accounts.requireAdmin(authTokenFrom(req));
      const users = await accounts.adminSearchUsers(url.searchParams.get('q'));
      return json(res, 200, { ok: true, users });
    }

    if (req.method === 'GET' && pathname === '/api/social/events') {
      const account = await accounts.requireAuth(String(url.searchParams.get('token') || ''));
      const userId = Number(account.id);
      await accounts.touchUser(userId).catch(() => {});
      res.writeHead(200, commonHeaders({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }));
      res.write(': social-connected\n\n');
      if (!socialClients.has(userId)) socialClients.set(userId, new Set());
      const set = socialClients.get(userId);
      set.add(res);
      socialSend(res, 'snapshot', await socialSnapshotFor(userId));
      broadcastPresence(userId).catch(() => {});
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        set.delete(res);
        if (!set.size) socialClients.delete(userId);
        accounts.touchUser(userId).catch(() => {});
        setTimeout(() => broadcastPresence(userId).catch(() => {}), 1200);
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/social/snapshot') {
      const account = await accounts.requireAuth(authTokenFrom(req));
      await accounts.touchUser(account.id).catch(() => {});
      return json(res, 200, { ok: true, snapshot: await socialSnapshotFor(account.id) });
    }
    if (req.method === 'GET' && pathname === '/api/social/search') {
      const account = await accounts.requireAuth(authTokenFrom(req));
      const users = await accounts.searchUsers(account.id, url.searchParams.get('q'));
      return json(res, 200, { ok: true, users: users.map(user => ({ ...user, online: socialOnline(user.id) })) });
    }
    if (req.method === 'GET' && pathname === '/api/social/profile') {
      const account = await accounts.requireAuth(authTokenFrom(req));
      const profile = await accounts.publicProfile(account.id, url.searchParams.get('userId'));
      return json(res, 200, { ok: true, profile: { ...profile, online: socialOnline(profile.id) } });
    }
    if (req.method === 'GET' && pathname === '/api/social/conversation') {
      const account = await accounts.requireAuth(authTokenFrom(req));
      const otherId = Number(url.searchParams.get('userId'));
      const messages = await accounts.conversation(account.id, otherId, url.searchParams.get('limit'));
      await broadcastSocial([account.id, otherId]);
      return json(res, 200, { ok: true, messages });
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
        if (room.isPublic && !player.cashedOut) {
          if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
          player.disconnectTimer = setTimeout(() => {
            if (!player.connected && getPlayer(room, playerToken) === player && !player.cashedOut) {
              leaveRoom(room, playerToken).catch(err => console.error(`Public disconnect cash-out failed for ${room.code}:`, err));
            }
          }, PUBLIC_DISCONNECT_GRACE_MS);
          if (player.disconnectTimer.unref) player.disconnectTimer.unref();
        }
        broadcast(room);
      });
      return;
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
    const body = await readJson(req);

    if (pathname === '/api/register') {
      const result = await accounts.register(body);
      return json(res, 200, { ok: true, ...result });
    }
    if (pathname === '/api/login') {
      const rateKey = checkLoginRate(req, body.username);
      try {
        const result = await accounts.login(body);
        clearLoginRate(rateKey);
        return json(res, 200, { ok: true, ...result });
      } catch (err) {
        throw err;
      }
    }
    if (pathname === '/api/logout') {
      await accounts.logout(authTokenFrom(req, body));
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/profile') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      const updated = await accounts.updateProfile(account.id, body);
      return json(res, 200, { ok: true, account: updated });
    }
    if (pathname === '/api/daily-spin') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      try {
        const spin = await accounts.claimDailySpin(account.id);
        return json(res, 200, { ok: true, spin });
      } catch (err) {
        if (err && err.code === 'DAILY_SPIN_COOLDOWN') {
          return json(res, 409, { error: err.message, nextSpinAt: err.nextSpinAt });
        }
        throw err;
      }
    }

    if (pathname === '/api/admin/announcement') {
      const admin = await accounts.requireAdmin(authTokenFrom(req, body));
      const message = await sendAdminAnnouncement(admin, body.text);
      return json(res, 200, { ok: true, message });
    }
    if (pathname === '/api/admin/adjust-bankroll') {
      const admin = await accounts.requireAdmin(authTokenFrom(req, body));
      const adjustment = await accounts.adminAdjustBankroll({ adminUserId: admin.id, targetUserId: Number(body.userId), amount: body.amount, reason: body.reason });
      await broadcastSocial([Number(body.userId)]);
      return json(res, 200, { ok: true, adjustment });
    }
    if (pathname === '/api/admin/kick') {
      const admin = await accounts.requireAdmin(authTokenFrom(req, body));
      const room = getRoom(body.roomCode);
      if (!room) throw new Error('Table not found.');
      const targetUserId = Number(body.userId);
      const player = room.players.find(item => Number(item.userId) === targetUserId && !item.cashedOut);
      if (!player) throw new Error('That player is no longer seated at this table.');
      if (player.isAdmin && Number(player.userId) !== Number(admin.id)) throw new Error('Another administrator cannot be removed.');
      const reason = cleanAdminText(body.reason || 'Removed by administrator.', 120) || 'Removed by administrator.';
      pushChat(room, { system: true, senderToken: '', name: 'Sivel Poker Admin', avatar: '👑', role: 'admin', isAdmin: true, text: `${player.name} was removed from the table by an administrator.` });
      const result = await leaveRoom(room, player.token);
      await accounts.recordAdminAction(admin.id, targetUserId, 'table_removal', { roomCode: room.code, reason, payout: result.payout || 0 });
      return json(res, 200, { ok: true, payout: result.payout || 0 });
    }

    if (pathname === '/api/social/friend-request') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      const result = await accounts.sendFriendRequest(account.id, body.userId);
      await broadcastSocial([account.id, result.targetId]);
      return json(res, 200, { ok: true, accepted: result.accepted });
    }
    if (pathname === '/api/social/friend-response') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      const result = await accounts.respondFriendRequest(account.id, body.requestId, String(body.action || ''));
      await broadcastSocial([result.senderId, result.receiverId]);
      return json(res, 200, { ok: true, accepted: result.accepted });
    }
    if (pathname === '/api/social/friend-cancel') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      const targetId = await accounts.cancelFriendRequest(account.id, body.requestId);
      await broadcastSocial([account.id, targetId]);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/social/friend-remove') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      const otherId = Number(body.userId);
      await accounts.removeFriend(account.id, otherId);
      await broadcastSocial([account.id, otherId]);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/social/block') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      const otherId = Number(body.userId);
      await accounts.blockUser(account.id, otherId);
      await broadcastSocial([account.id, otherId]);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/social/unblock') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      const otherId = Number(body.userId);
      await accounts.unblockUser(account.id, otherId);
      await broadcastSocial([account.id, otherId]);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/social/message') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      checkSocialMessageRate(account.id);
      const otherId = Number(body.userId);
      const message = await accounts.sendDirectMessage(account.id, otherId, body.text);
      await broadcastSocial([account.id, otherId]);
      return json(res, 200, { ok: true, message });
    }
    if (pathname === '/api/social/invite') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      const inviteeId = Number(body.userId);
      let targetType = String(body.targetType || '');
      let tableId = null, roomCode = null, tableName = '';
      if (targetType === 'public') {
        ensurePublicTables();
        const target = publicRoomById(body.tableId);
        if (!target) throw new Error('Public table not found.');
        tableId = target.publicId;
        roomCode = target.code;
        tableName = target.publicName;
      } else if (targetType === 'private') {
        const target = getRoom(body.roomCode);
        if (!target || target.isPublic) throw new Error('Private room not found.');
        if (target.stage !== 'lobby') throw new Error('Private-room invitations are available before the game starts.');
        if (!target.players.some(player => Number(player.userId) === Number(account.id) && !player.cashedOut)) throw new Error('Take a seat in that private room before inviting friends.');
        roomCode = target.code;
        tableName = `Private Table · ${target.code}`;
      } else throw new Error('Choose a valid table invitation.');
      const result = await accounts.sendTableInvite({ inviterId: account.id, inviteeId, targetType, tableId, roomCode, tableName });
      await broadcastSocial([account.id, result.inviteeId]);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/social/invite-response') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      const invite = await accounts.respondTableInvite(account.id, body.inviteId, String(body.action || ''));
      await broadcastSocial([invite.inviterId, invite.inviteeId]);
      return json(res, 200, { ok: true, invite });
    }
    if (pathname === '/api/public/join') {
      const authToken = authTokenFrom(req, body);
      const account = await accounts.requireAuth(authToken);
      ensurePublicTables();
      const room = publicRoomById(body.tableId || body.room);
      if (!room) throw new Error('Public table not found.');
      const joined = await joinPublicRoom(room, account, authToken, body.token);
      touch(room, getPlayer(room, joined.playerToken));
      return json(res, 200, {
        room: room.code,
        token: joined.playerToken,
        account: joined.account,
        state: publicState(room, joined.playerToken)
      });
    }
    if (pathname === '/api/create') {
      const authToken = authTokenFrom(req, body);
      const account = await accounts.requireAuth(authToken);
      const { room, playerToken } = createRoom(account, body.options || {});
      try {
        const remaining = await accounts.reserveBuyIn({ userId: account.id, amount: room.options.buyIn, tableId: room.id, roomCode: room.code, playerToken });
        room.players[0].walletBalance = remaining;
      } catch (err) {
        rooms.delete(room.code);
        throw err;
      }
      const refreshed = await accounts.requireAuth(authToken);
      broadcast(room);
      return json(res, 200, { room: room.code, token: playerToken, account: refreshed, state: publicState(room, playerToken) });
    }
    if (pathname === '/api/join') {
      const authToken = authTokenFrom(req, body);
      const account = await accounts.requireAuth(authToken);
      const room = getRoom(body.room);
      if (!room) throw new Error('Room not found. Check the four-character code.');
      let playerToken;
      const existing = body.token ? getPlayer(room, body.token) : null;
      if (existing) {
        playerToken = joinRoom(room, account, body.token);
      } else {
        if (room.stage !== 'lobby') throw new Error('This table has already started. Rejoin with the same browser instead.');
        if (room.players.length >= room.options.maxPlayers) throw new Error('This room is full.');
        if (room.players.some(p => Number(p.userId) === Number(account.id))) throw new Error('This account already has a seat at this table.');
        playerToken = token();
        try {
          const remaining = await accounts.reserveBuyIn({ userId: account.id, amount: room.options.buyIn, tableId: room.id, roomCode: room.code, playerToken });
          account.bankroll = remaining;
          joinRoom(room, account, null, playerToken);
        } catch (err) {
          await accounts.refundPlayer(playerToken, 'join_failure_refund').catch(() => {});
          throw err;
        }
      }
      touch(room, getPlayer(room, playerToken));
      const refreshed = await accounts.requireAuth(authToken);
      const player = getPlayer(room, playerToken);
      if (player) player.walletBalance = Number(refreshed.bankroll);
      return json(res, 200, { room: room.code, token: playerToken, account: refreshed, state: publicState(room, playerToken) });
    }

    const room = getRoom(body.room);
    if (!room) throw new Error('Room not found.');
    const player = getPlayer(room, body.token);
    if (!player) throw new Error('Player session not found. Rejoin the room.');
    touch(room, player);

    if (pathname === '/api/chat') {
      sendChatMessage(room, player, body.text);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/options') {
      if (room.isPublic) throw new Error('Public table settings are fixed.');
      if (room.hostToken !== body.token) throw new Error('Only the host can change table options.');
      updateOptions(room, body.options || {});
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/start') {
      if (room.isPublic) throw new Error('Public tables start automatically.');
      if (room.hostToken !== body.token) throw new Error('Only the host can start the table.');
      startTable(room);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/action') {
      action(room, body.token, body.action || {});
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/next-hand') {
      if (room.isPublic) throw new Error('Public tables deal automatically.');
      if (room.hostToken !== body.token) throw new Error('Only the host can deal the next hand.');
      if (!room.game || !room.game.handOver || room.game.tableOver) throw new Error('The current hand is not ready to continue.');
      startHand(room);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/reset-lobby') {
      throw new Error('This account-backed table is complete. Leave and create a new table for the next match.');
    }
    if (pathname === '/api/leave') {
      const result = await leaveRoom(room, body.token);
      return json(res, 200, { ok: true, account: result.account, payout: result.payout });
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
    if (room.isPublic) continue;
    if (now - room.updatedAt > ROOM_IDLE_MS) {
      clearTurnTimer(room);
      clearPublicNextTimer(room);
      for (const res of room.clients.values()) { try { res.end(); } catch (_) {} }
      accounts.refundTable(room.id, 'idle_room_refund').catch(err => console.error('Idle room refund failed:', err));
      if (room.isPublic) resetPublicRoom(room);
      else rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

async function shutdown(signal) {
  console.log(`${signal} received. Refunding unsettled tables before shutdown.`);
  server.close();
  for (const clients of socialClients.values()) for (const res of clients) { try { res.end(); } catch (_) {} }
  socialClients.clear();
  for (const room of rooms.values()) {
    clearTurnTimer(room);
    clearPublicNextTimer(room);
    room.players.forEach(player => { if (player.disconnectTimer) clearTimeout(player.disconnectTimer); });
    await accounts.refundTable(room.id, 'server_shutdown_refund').catch(err => console.error('Shutdown refund failed:', err));
  }
  await accounts.close().catch(() => {});
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

async function boot() {
  await accounts.init();
  const recovered = await accounts.recoverInterruptedTables();
  ensurePublicTables();
  if (recovered) console.log(`Recovered ${recovered} interrupted table buy-in(s).`);
  server.listen(PORT, HOST, () => {
    const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    console.log(`Sivel Poker Online with public tables listening on ${publicUrl}`);
  });
}

boot().catch(err => {
  console.error('Unable to start Sivel Poker:', err);
  process.exit(1);
});
