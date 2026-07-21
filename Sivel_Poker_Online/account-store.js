'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const STARTING_BANKROLL = 10_000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,18}$/;
const AVATARS = new Set(['🕶️','🦊','🐺','🦁','🐉','👑','⚡','🎯','🃏','🤖','👻','🧙‍♂️','🦅','🔥','💎','🥷']);

function cleanDisplayName(value, fallback = 'Player') {
  const name = String(value || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);
  return name || fallback;
}

function cleanAvatar(value) {
  const avatar = String(value || '').trim();
  return AVATARS.has(avatar) ? avatar : '🕶️';
}

function normalizeUsername(value) {
  return String(value || '').trim();
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!USERNAME_RE.test(username)) {
    throw new Error('Username must be 3–18 characters using only letters, numbers, or underscores.');
  }
  return username;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  if (password.length > 128) throw new Error('Password is too long.');
  return password;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

async function hashPassword(password, saltHex = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return { saltHex, hashHex: Buffer.from(derived).toString('hex') };
}

async function verifyPassword(password, saltHex, expectedHex) {
  const { hashHex } = await hashPassword(password, saltHex);
  const actual = Buffer.from(hashHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createAccountStore({ databaseUrl, production = false } = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for Sivel Poker accounts.');

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: production ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });

  pool.on('error', err => console.error('Unexpected PostgreSQL pool error:', err));

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username_key VARCHAR(18) NOT NULL UNIQUE,
        username VARCHAR(18) NOT NULL,
        password_salt VARCHAR(64) NOT NULL,
        password_hash VARCHAR(256) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS player_profiles (
        user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        display_name VARCHAR(18) NOT NULL,
        avatar VARCHAR(16) NOT NULL DEFAULT '🕶️',
        xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
        level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
        tables_played INTEGER NOT NULL DEFAULT 0 CHECK (tables_played >= 0),
        tables_won INTEGER NOT NULL DEFAULT 0 CHECK (tables_won >= 0),
        hands_played INTEGER NOT NULL DEFAULT 0 CHECK (hands_played >= 0),
        hands_won INTEGER NOT NULL DEFAULT 0 CHECK (hands_won >= 0),
        biggest_pot BIGINT NOT NULL DEFAULT 0 CHECK (biggest_pot >= 0),
        achievements JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wallets (
        user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        balance BIGINT NOT NULL DEFAULT ${STARTING_BANKROLL} CHECK (balance >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount BIGINT NOT NULL,
        balance_before BIGINT NOT NULL,
        balance_after BIGINT NOT NULL,
        reason VARCHAR(64) NOT NULL,
        table_id UUID,
        room_code VARCHAR(8),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS wallet_transactions_user_created_idx
        ON wallet_transactions(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);

      CREATE TABLE IF NOT EXISTS table_sessions (
        id UUID PRIMARY KEY,
        table_id UUID NOT NULL,
        room_code VARCHAR(8) NOT NULL,
        player_token UUID NOT NULL UNIQUE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        buy_in BIGINT NOT NULL CHECK (buy_in > 0),
        payout BIGINT NOT NULL DEFAULT 0 CHECK (payout >= 0),
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS table_sessions_table_idx ON table_sessions(table_id);
      CREATE INDEX IF NOT EXISTS table_sessions_user_idx ON table_sessions(user_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS table_sessions_active_user_table_idx
        ON table_sessions(table_id, user_id) WHERE status = 'active';
    `);

    await pool.query('DELETE FROM auth_sessions WHERE expires_at <= NOW()');
  }

  async function createSession(client, userId) {
    const raw = crypto.randomBytes(32).toString('base64url');
    await client.query(
      `INSERT INTO auth_sessions(token_hash, user_id, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' days')::interval)`,
      [tokenHash(raw), userId, String(SESSION_DAYS)]
    );
    return raw;
  }

  async function accountById(client, userId) {
    const result = await client.query(
      `SELECT u.id, u.username, u.created_at,
              p.display_name, p.avatar, p.xp, p.level,
              p.tables_played, p.tables_won, p.hands_played, p.hands_won,
              p.biggest_pot, p.achievements,
              w.balance
       FROM users u
       JOIN player_profiles p ON p.user_id = u.id
       JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      id: Number(row.id),
      username: row.username,
      displayName: row.display_name,
      avatar: row.avatar,
      bankroll: Number(row.balance),
      xp: Number(row.xp),
      level: Number(row.level),
      tablesPlayed: Number(row.tables_played),
      tablesWon: Number(row.tables_won),
      handsPlayed: Number(row.hands_played),
      handsWon: Number(row.hands_won),
      biggestPot: Number(row.biggest_pot),
      achievements: row.achievements || {},
      createdAt: row.created_at
    };
  }

  async function register({ username, password, displayName, avatar }) {
    username = validateUsername(username);
    password = validatePassword(password);
    const key = username.toLowerCase();
    const display = cleanDisplayName(displayName, username);
    const safeAvatar = cleanAvatar(avatar);
    const passwordData = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO users(username_key, username, password_salt, password_hash, last_login)
         VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
        [key, username, passwordData.saltHex, passwordData.hashHex]
      );
      const userId = inserted.rows[0].id;
      await client.query(
        `INSERT INTO player_profiles(user_id, display_name, avatar) VALUES ($1, $2, $3)`,
        [userId, display, safeAvatar]
      );
      await client.query(`INSERT INTO wallets(user_id, balance) VALUES ($1, $2)`, [userId, STARTING_BANKROLL]);
      await client.query(
        `INSERT INTO wallet_transactions(user_id, amount, balance_before, balance_after, reason)
         VALUES ($1, $2, 0, $2, 'account_starting_bankroll')`,
        [userId, STARTING_BANKROLL]
      );
      const sessionToken = await createSession(client, userId);
      const account = await accountById(client, userId);
      await client.query('COMMIT');
      return { token: sessionToken, account };
    } catch (err) {
      await client.query('ROLLBACK');
      if (err && err.code === '23505') throw new Error('That username is already taken.');
      throw err;
    } finally {
      client.release();
    }
  }

  async function login({ username, password }) {
    username = validateUsername(username);
    password = validatePassword(password);
    const result = await pool.query(
      `SELECT id, password_salt, password_hash FROM users WHERE username_key = $1`,
      [username.toLowerCase()]
    );
    if (!result.rowCount) throw new Error('Incorrect username or password.');
    const row = result.rows[0];
    const valid = await verifyPassword(password, row.password_salt, row.password_hash);
    if (!valid) throw new Error('Incorrect username or password.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET last_login = NOW() WHERE id = $1', [row.id]);
      const sessionToken = await createSession(client, row.id);
      const account = await accountById(client, row.id);
      await client.query('COMMIT');
      return { token: sessionToken, account };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function authenticate(rawToken) {
    if (!rawToken) return null;
    const result = await pool.query(
      `SELECT s.user_id
       FROM auth_sessions s
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [tokenHash(rawToken)]
    );
    if (!result.rowCount) return null;
    const userId = result.rows[0].user_id;
    await pool.query('UPDATE auth_sessions SET last_seen = NOW() WHERE token_hash = $1', [tokenHash(rawToken)]);
    return accountById(pool, userId);
  }

  async function requireAuth(rawToken) {
    const account = await authenticate(rawToken);
    if (!account) throw new Error('Please sign in to your Sivel Poker account.');
    return account;
  }

  async function logout(rawToken) {
    if (rawToken) await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(rawToken)]);
  }

  async function updateProfile(userId, { displayName, avatar }) {
    const account = await accountById(pool, userId);
    if (!account) throw new Error('Account not found.');
    const display = cleanDisplayName(displayName, account.username);
    const safeAvatar = cleanAvatar(avatar);
    await pool.query(
      `UPDATE player_profiles SET display_name = $2, avatar = $3, updated_at = NOW() WHERE user_id = $1`,
      [userId, display, safeAvatar]
    );
    return accountById(pool, userId);
  }

  async function reserveBuyIn({ userId, amount, tableId, roomCode, playerToken }) {
    amount = Math.floor(Number(amount));
    if (!Number.isFinite(amount) || amount < 100 || amount > 10_000) throw new Error('Invalid table buy-in.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const wallet = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!wallet.rowCount) throw new Error('Player wallet not found.');
      const before = Number(wallet.rows[0].balance);
      if (before < amount) throw new Error(`You need ${amount.toLocaleString()} Sivel Chips to join this table.`);
      const after = before - amount;
      await client.query('UPDATE wallets SET balance = $2, updated_at = NOW() WHERE user_id = $1', [userId, after]);
      await client.query(
        `INSERT INTO table_sessions(id, table_id, room_code, player_token, user_id, buy_in)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [crypto.randomUUID(), tableId, roomCode, playerToken, userId, amount]
      );
      await client.query(
        `INSERT INTO wallet_transactions(user_id, amount, balance_before, balance_after, reason, table_id, room_code)
         VALUES ($1, $2, $3, $4, 'table_buy_in', $5, $6)`,
        [userId, -amount, before, after, tableId, roomCode]
      );
      await client.query('COMMIT');
      return after;
    } catch (err) {
      await client.query('ROLLBACK');
      if (err && err.code === '23505') throw new Error('This account already has a seat at that table.');
      throw err;
    } finally {
      client.release();
    }
  }

  async function refundPlayer(playerToken, reason = 'table_refund') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query(
        `SELECT * FROM table_sessions WHERE player_token = $1 FOR UPDATE`,
        [playerToken]
      );
      if (!session.rowCount || session.rows[0].status !== 'active') {
        await client.query('COMMIT');
        return false;
      }
      const row = session.rows[0];
      const wallet = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [row.user_id]);
      const before = Number(wallet.rows[0].balance);
      const amount = Number(row.buy_in);
      const after = before + amount;
      await client.query('UPDATE wallets SET balance = $2, updated_at = NOW() WHERE user_id = $1', [row.user_id, after]);
      await client.query(
        `UPDATE table_sessions SET status = 'refunded', payout = $2, updated_at = NOW() WHERE id = $1`,
        [row.id, amount]
      );
      await client.query(
        `INSERT INTO wallet_transactions(user_id, amount, balance_before, balance_after, reason, table_id, room_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.user_id, amount, before, after, reason, row.table_id, row.room_code]
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function refundTable(tableId, reason = 'table_interrupted') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sessions = await client.query(
        `SELECT * FROM table_sessions WHERE table_id = $1 AND status = 'active' FOR UPDATE`,
        [tableId]
      );
      for (const row of sessions.rows) {
        const wallet = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [row.user_id]);
        const before = Number(wallet.rows[0].balance);
        const amount = Number(row.buy_in);
        const after = before + amount;
        await client.query('UPDATE wallets SET balance = $2, updated_at = NOW() WHERE user_id = $1', [row.user_id, after]);
        await client.query(
          `UPDATE table_sessions SET status = 'interrupted', payout = $2, updated_at = NOW() WHERE id = $1`,
          [row.id, amount]
        );
        await client.query(
          `INSERT INTO wallet_transactions(user_id, amount, balance_before, balance_after, reason, table_id, room_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [row.user_id, amount, before, after, reason, row.table_id, row.room_code]
        );
      }
      await client.query('COMMIT');
      return sessions.rowCount;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function recoverInterruptedTables() {
    const result = await pool.query(`SELECT DISTINCT table_id FROM table_sessions WHERE status = 'active'`);
    let recovered = 0;
    for (const row of result.rows) recovered += await refundTable(row.table_id, 'server_restart_refund');
    return recovered;
  }

  async function settleTable({ tableId, winnerPlayerToken, payout, biggestPot = 0 }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sessions = await client.query(
        `SELECT * FROM table_sessions WHERE table_id = $1 AND status = 'active' FOR UPDATE`,
        [tableId]
      );
      if (!sessions.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const winner = sessions.rows.find(row => row.player_token === winnerPlayerToken);
      if (!winner) throw new Error('Winning account session not found.');
      payout = Math.max(0, Math.floor(Number(payout) || 0));
      const wallet = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [winner.user_id]);
      const before = Number(wallet.rows[0].balance);
      const after = before + payout;
      await client.query('UPDATE wallets SET balance = $2, updated_at = NOW() WHERE user_id = $1', [winner.user_id, after]);
      if (payout > 0) {
        await client.query(
          `INSERT INTO wallet_transactions(user_id, amount, balance_before, balance_after, reason, table_id, room_code)
           VALUES ($1, $2, $3, $4, 'table_payout', $5, $6)`,
          [winner.user_id, payout, before, after, tableId, winner.room_code]
        );
      }
      for (const row of sessions.rows) {
        const won = row.player_token === winnerPlayerToken;
        const xpGain = won ? 300 : 75;
        await client.query(
          `UPDATE table_sessions SET status = 'settled', payout = $2, updated_at = NOW() WHERE id = $1`,
          [row.id, won ? payout : 0]
        );
        await client.query(
          `UPDATE player_profiles
           SET tables_played = tables_played + 1,
               tables_won = tables_won + $2,
               xp = xp + $3,
               level = 1 + FLOOR(SQRT((xp + $3) / 250.0))::INTEGER,
               biggest_pot = GREATEST(biggest_pot, $4),
               achievements = CASE WHEN $2 = 1 THEN achievements || '{"first_table_win":true}'::jsonb ELSE achievements END,
               updated_at = NOW()
           WHERE user_id = $1`,
          [row.user_id, won ? 1 : 0, xpGain, Math.max(0, Math.floor(Number(biggestPot) || payout))]
        );
      }
      await client.query('COMMIT');
      return accountById(pool, winner.user_id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function recentTransactions(userId, limit = 20) {
    limit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
    const result = await pool.query(
      `SELECT amount, balance_before, balance_after, reason, room_code, created_at
       FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(row => ({
      amount: Number(row.amount),
      balanceBefore: Number(row.balance_before),
      balanceAfter: Number(row.balance_after),
      reason: row.reason,
      room: row.room_code,
      createdAt: row.created_at
    }));
  }

  async function health() {
    const result = await pool.query('SELECT NOW() AS now');
    return { ok: true, now: result.rows[0].now };
  }

  return {
    init,
    register,
    login,
    authenticate,
    requireAuth,
    logout,
    updateProfile,
    reserveBuyIn,
    refundPlayer,
    refundTable,
    recoverInterruptedTables,
    settleTable,
    recentTransactions,
    health,
    close: () => pool.end()
  };
}

module.exports = { createAccountStore, cleanDisplayName, cleanAvatar };
