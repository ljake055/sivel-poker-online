'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const serverPath = path.join(root, 'server.js');
const storePath = path.join(root, 'account-store.js');

function fail(message) {
  console.error(`
Upgrade stopped: ${message}
`);
  process.exit(1);
}

function replaceOnce(source, find, replacement, label) {
  const count = source.split(find).length - 1;
  if (count !== 1) fail(`${label} anchor was found ${count} times. Apply this patch only to the reviewed Sivel Poker backend from the GitHub main branch.`);
  return source.replace(find, replacement);
}

if (!fs.existsSync(serverPath) || !fs.existsSync(storePath)) {
  fail('Place this file beside server.js and account-store.js, then run: node apply-online-progression-v32.js');
}

let server = fs.readFileSync(serverPath, 'utf8');
let store = fs.readFileSync(storePath, 'utf8');

if (server.includes('recordOnlineHandProgress') && store.includes('async function recordOnlineHand({ tableId')) {
  console.log('Online progression/statistics upgrade is already installed.');
  process.exit(0);
}

fs.copyFileSync(serverPath, `${serverPath}.pre-online-progression-v32.bak`);
fs.copyFileSync(storePath, `${storePath}.pre-online-progression-v32.bak`);

const schemaAnchor = `      CREATE TABLE IF NOT EXISTS admin_audit_log (`;
const schemaUpgrade = `      ALTER TABLE player_profiles ADD COLUMN IF NOT EXISTS online_stats JSONB NOT NULL DEFAULT '{"handsPlayed":0,"handsWon":0,"publicHands":0,"publicWins":0,"privateHands":0,"privateWins":0,"publicProfit":0,"privateProfit":0,"biggestPot":0,"publicTables":0,"publicTableWins":0}'::jsonb;

      CREATE TABLE IF NOT EXISTS online_hand_results (
        table_id UUID NOT NULL,
        hand_no INTEGER NOT NULL CHECK (hand_no > 0),
        room_code VARCHAR(8) NOT NULL,
        table_type VARCHAR(12) NOT NULL CHECK (table_type IN ('public','private')),
        pot BIGINT NOT NULL CHECK (pot >= 0),
        participants JSONB NOT NULL DEFAULT '[]'::jsonb,
        payouts JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (table_id, hand_no)
      );
      CREATE INDEX IF NOT EXISTS online_hand_results_created_idx ON online_hand_results(created_at DESC);

${schemaAnchor}`;
store = replaceOnce(store, schemaAnchor, schemaUpgrade, 'database schema');

store = replaceOnce(
  store,
  `               p.biggest_pot, p.achievements,
               w.balance,`,
  `               p.biggest_pot, p.achievements, p.online_stats,
               w.balance,`,
  'account select'
);

store = replaceOnce(
  store,
  `       achievements: row.achievements || {},
       dailySpin: {`,
  `       achievements: row.achievements || {},
       onlineStats: row.online_stats || {},
       dailySpin: {`,
  'account response'
);

const recordFunction = `
  async function recordOnlineHand({ tableId, handNo, roomCode, tableType, pot, participants, payouts }) {
    const safeType = tableType === 'public' ? 'public' : 'private';
    const safePot = Math.max(0, Math.floor(Number(pot) || 0));
    const safeParticipants = (Array.isArray(participants) ? participants : [])
      .map(item => ({ userId: Number(item.userId), contribution: Math.max(0, Math.floor(Number(item.contribution) || 0)) }))
      .filter(item => item.userId > 0);
    const safePayouts = {};
    for (const [key, value] of Object.entries(payouts || {})) {
      const userId = Number(key);
      const amount = Math.max(0, Math.floor(Number(value) || 0));
      if (userId > 0 && amount > 0) safePayouts[String(userId)] = amount;
    }
    if (!tableId || !Number(handNo) || !safeParticipants.length) return { recorded: false };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        'INSERT INTO online_hand_results(table_id,hand_no,room_code,table_type,pot,participants,payouts) ' +
        'VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ' +
        'ON CONFLICT (table_id,hand_no) DO NOTHING RETURNING hand_no',
        [tableId, Number(handNo), String(roomCode || '').slice(0,8), safeType, safePot, JSON.stringify(safeParticipants), JSON.stringify(safePayouts)]
      );
      if (!inserted.rowCount) {
        await client.query('COMMIT');
        return { recorded: false, duplicate: true };
      }

      for (const participant of safeParticipants) {
        const payout = Number(safePayouts[String(participant.userId)] || 0);
        const won = payout > 0;
        const profit = payout - participant.contribution;
        const current = await client.query('SELECT online_stats FROM player_profiles WHERE user_id=$1 FOR UPDATE', [participant.userId]);
        if (!current.rowCount) continue;
        const stats = current.rows[0].online_stats || {};
        stats.handsPlayed = Number(stats.handsPlayed || 0) + 1;
        stats.handsWon = Number(stats.handsWon || 0) + (won ? 1 : 0);
        stats.biggestPot = Math.max(Number(stats.biggestPot || 0), won ? safePot : 0);
        if (safeType === 'public') {
          stats.publicHands = Number(stats.publicHands || 0) + 1;
          stats.publicWins = Number(stats.publicWins || 0) + (won ? 1 : 0);
          stats.publicProfit = Number(stats.publicProfit || 0) + profit;
        } else {
          stats.privateHands = Number(stats.privateHands || 0) + 1;
          stats.privateWins = Number(stats.privateWins || 0) + (won ? 1 : 0);
          stats.privateProfit = Number(stats.privateProfit || 0) + profit;
        }
        const xpGain = won ? 35 : 15;
        const achievements = {
          first_online_hand: true,
          ...(won ? { first_online_win: true } : {}),
          ...(stats.handsPlayed >= 100 ? { hundred_online_hands: true } : {}),
          ...(stats.biggestPot >= 5000 ? { online_big_pot: true } : {})
        };
        await client.query(
          'UPDATE player_profiles ' +
          'SET hands_played=hands_played+1, ' +
          'hands_won=hands_won+$2, ' +
          'xp=xp+$3, ' +
          'level=1+FLOOR(SQRT((xp+$3)/250.0))::INTEGER, ' +
          'biggest_pot=GREATEST(biggest_pot,$4), ' +
          'achievements=achievements||$5::jsonb, ' +
          'online_stats=$6::jsonb, ' +
          'updated_at=NOW() ' +
          'WHERE user_id=$1',
          [participant.userId, won ? 1 : 0, xpGain, won ? safePot : 0, JSON.stringify(achievements), JSON.stringify(stats)]
        );
      }
      await client.query('COMMIT');
      return { recorded: true };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

`;
store = replaceOnce(store, `  async function requireAdmin(rawToken) {`, recordFunction + `  async function requireAdmin(rawToken) {`, 'recordOnlineHand function');

store = replaceOnce(
  store,
  `    socialSnapshot,
    requireAdmin,`,
  `    socialSnapshot,
    recordOnlineHand,
    requireAdmin,`,
  'account-store export'
);

const publicCareerAnchor = `      const account = await accountById(client, row.user_id);
      await client.query('COMMIT');
      return { changed: true, payout, account };`;
const publicCareerUpgrade = `      if (reason === 'public_table_cash_out') {
        const wonSession = payout > Number(row.buy_in);
        const current = await client.query('SELECT online_stats FROM player_profiles WHERE user_id=$1 FOR UPDATE', [row.user_id]);
        const stats = current.rowCount ? (current.rows[0].online_stats || {}) : {};
        stats.publicTables = Number(stats.publicTables || 0) + 1;
        stats.publicTableWins = Number(stats.publicTableWins || 0) + (wonSession ? 1 : 0);
        await client.query(
          'UPDATE player_profiles ' +
          'SET tables_played=tables_played+1, ' +
          'tables_won=tables_won+$2, ' +
          'xp=xp+$3, ' +
          'level=1+FLOOR(SQRT((xp+$3)/250.0))::INTEGER, ' +
          'online_stats=$4::jsonb, ' +
          'updated_at=NOW() ' +
          'WHERE user_id=$1',
          [row.user_id, wonSession ? 1 : 0, wonSession ? 150 : 50, JSON.stringify(stats)]
        );
      }
      const account = await accountById(client, row.user_id);
      await client.query('COMMIT');
      return { changed: true, payout, account };`;
store = replaceOnce(store, publicCareerAnchor, publicCareerUpgrade, 'public table career settlement');

const helperAnchor = `function systemChat(room, text) {
  pushChat(room, { system: true, senderToken: '', name: 'Sivel Poker', avatar: '♠', text });
}
`;
const helper = `${helperAnchor}
function recordOnlineHandProgress(room, payouts, pot) {
  if (!room || !room.game) return;
  const participants = room.players
    .filter(player => Number(player.userId) > 0 && (player.inHand || player.folded || player.allIn || Number(player.totalBet || 0) > 0))
    .map(player => ({ userId: Number(player.userId), contribution: Math.max(0, Number(player.totalBet) || 0) }));
  accounts.recordOnlineHand({
    tableId: room.id,
    handNo: room.game.handNo,
    roomCode: room.code,
    tableType: room.isPublic ? 'public' : 'private',
    pot: Math.max(0, Number(pot) || 0),
    participants,
    payouts
  }).then(() => broadcastSocial(participants.map(item => item.userId))).catch(err => {
    console.error('Online hand progression failed for ' + room.code + ' hand ' + (room.game && room.game.handNo) + ':', err);
  });
}
`;
server = replaceOnce(server, helperAnchor, helper, 'server progression helper');

server = replaceOnce(
  server,
  `  winner.chips += game.pot;
  const amount = game.pot;`,
  `  winner.chips += game.pot;
  const amount = game.pot;
  recordOnlineHandProgress(room, { [String(winner.userId)]: amount }, amount);`,
  'uncontested hand progression'
);

server = replaceOnce(
  server,
  `  const pots = buildSidePots(room);
  const summaries = [];
  const allWinnerSeats = new Set();`,
  `  const totalPot = game.pot;
  const pots = buildSidePots(room);
  const summaries = [];
  const allWinnerSeats = new Set();
  const payoutsByUser = {};`,
  'showdown setup'
);

server = replaceOnce(
  server,
  `      room.players[index].chips += share + (remainder-- > 0 ? 1 : 0);
      allWinnerSeats.add(index);`,
  `      const awarded = share + (remainder-- > 0 ? 1 : 0);
      room.players[index].chips += awarded;
      payoutsByUser[String(room.players[index].userId)] = Number(payoutsByUser[String(room.players[index].userId)] || 0) + awarded;
      allWinnerSeats.add(index);`,
  'showdown payouts'
);

server = replaceOnce(
  server,
  `  summaries.forEach(message => log(room, message));
  finishHand(room);`,
  `  summaries.forEach(message => log(room, message));
  recordOnlineHandProgress(room, payoutsByUser, totalPot);
  finishHand(room);`,
  'showdown progression call'
);

server = replaceOnce(
  server,
  `    cashout = await accounts.cashOutPlayer(playerToken, payout, 'table_cash_out');`,
  `    cashout = await accounts.cashOutPlayer(playerToken, payout, room.isPublic ? 'public_table_cash_out' : 'table_cash_out');`,
  'public cashout classification'
);

fs.writeFileSync(serverPath, server);
fs.writeFileSync(storePath, store);
console.log('Online progression and statistics upgrade installed successfully.');
console.log('Backups created beside both backend files.');
console.log('Run npm test, then restart or redeploy the service.');
