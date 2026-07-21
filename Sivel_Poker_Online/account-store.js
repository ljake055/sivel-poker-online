'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const STARTING_BANKROLL = 10_000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,18}$/;
const BIO_MAX_LENGTH = 280;
const DM_MAX_LENGTH = 500;
const AVATARS = new Set(['🕶️','🦊','🐺','🦁','🐉','👑','⚡','🎯','🃏','🤖','👻','🧙‍♂️','🦅','🔥','💎','🥷']);
const ADMIN_USERNAME_KEYS = new Set(String(process.env.SIVEL_ADMIN_USERNAMES || 'csivel16').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
const DAILY_SPIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DAILY_SPIN_REWARDS = Object.freeze([100, 150, 200, 250, 300, 500, 750, 1500]);
function roleForUsername(username) { return ADMIN_USERNAME_KEYS.has(String(username || '').trim().toLowerCase()) ? 'admin' : 'player'; }

function cleanDisplayName(value, fallback = 'Player') {
  const name = String(value || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);
  return name || fallback;
}

function cleanBio(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BIO_MAX_LENGTH);
}

function cleanDirectMessage(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DM_MAX_LENGTH);
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
        last_login TIMESTAMPTZ,
        role VARCHAR(16) NOT NULL DEFAULT 'player'
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

      CREATE TABLE IF NOT EXISTS daily_spins (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reward BIGINT NOT NULL CHECK (reward > 0),
        segment_index SMALLINT NOT NULL CHECK (segment_index >= 0 AND segment_index < 8),
        spun_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS daily_spins_user_time_idx
        ON daily_spins(user_id, spun_at DESC);

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

      ALTER TABLE player_profiles ADD COLUMN IF NOT EXISTS bio VARCHAR(280) NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'player';

      CREATE TABLE IF NOT EXISTS friendships (
        user_id_low BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_id_high BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id_low, user_id_high),
        CHECK (user_id_low < user_id_high)
      );
      CREATE INDEX IF NOT EXISTS friendships_low_idx ON friendships(user_id_low);
      CREATE INDEX IF NOT EXISTS friendships_high_idx ON friendships(user_id_high);

      CREATE TABLE IF NOT EXISTS friend_requests (
        id BIGSERIAL PRIMARY KEY,
        sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        responded_at TIMESTAMPTZ,
        CHECK (sender_id <> receiver_id),
        CHECK (status IN ('pending','accepted','declined','cancelled'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_pending_pair_idx
        ON friend_requests(sender_id, receiver_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS friend_requests_receiver_idx
        ON friend_requests(receiver_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS user_blocks (
        blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (blocker_id, blocked_id),
        CHECK (blocker_id <> blocked_id)
      );

      CREATE TABLE IF NOT EXISTS direct_messages (
        id BIGSERIAL PRIMARY KEY,
        sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body VARCHAR(500) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        read_at TIMESTAMPTZ,
        CHECK (sender_id <> receiver_id)
      );
      CREATE INDEX IF NOT EXISTS direct_messages_conversation_idx
        ON direct_messages(sender_id, receiver_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS direct_messages_unread_idx
        ON direct_messages(receiver_id, read_at, created_at DESC);

      CREATE TABLE IF NOT EXISTS table_invites (
        id UUID PRIMARY KEY,
        inviter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invitee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_type VARCHAR(12) NOT NULL,
        table_id VARCHAR(32),
        room_code VARCHAR(8),
        table_name VARCHAR(80) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        responded_at TIMESTAMPTZ,
        CHECK (inviter_id <> invitee_id),
        CHECK (target_type IN ('public','private')),
        CHECK (status IN ('pending','accepted','declined','expired','cancelled'))
      );
      CREATE INDEX IF NOT EXISTS table_invites_invitee_idx
        ON table_invites(invitee_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id BIGSERIAL PRIMARY KEY,
        admin_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(64) NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_log(created_at DESC);

    `);

    for (const usernameKey of ADMIN_USERNAME_KEYS) {
      await pool.query(`UPDATE users SET role = 'admin' WHERE username_key = $1`, [usernameKey]);
    }
    await pool.query('DELETE FROM auth_sessions WHERE expires_at <= NOW()');
    await pool.query(`UPDATE table_invites SET status = 'expired', responded_at = NOW()
                      WHERE status = 'pending' AND expires_at <= NOW()`);
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
      `SELECT u.id, u.username, u.created_at, u.role,
              p.display_name, p.avatar, p.bio, p.xp, p.level,
              p.tables_played, p.tables_won, p.hands_played, p.hands_won,
              p.biggest_pot, p.achievements,
              w.balance,
              ds.reward AS last_spin_reward,
              ds.segment_index AS last_spin_segment_index,
              ds.spun_at AS last_spin_at
       FROM users u
       JOIN player_profiles p ON p.user_id = u.id
       JOIN wallets w ON w.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT reward, segment_index, spun_at
         FROM daily_spins
         WHERE user_id = u.id
         ORDER BY spun_at DESC
         LIMIT 1
       ) ds ON TRUE
       WHERE u.id = $1`,
      [userId]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const lastSpinAt = row.last_spin_at ? new Date(row.last_spin_at).toISOString() : null;
    const nextSpinAt = lastSpinAt ? new Date(new Date(lastSpinAt).getTime() + DAILY_SPIN_COOLDOWN_MS).toISOString() : null;
    return {
      id: Number(row.id),
      username: row.username,
      role: row.role || 'player',
      isAdmin: row.role === 'admin',
      displayName: row.display_name,
      avatar: row.avatar,
      bio: row.bio || '',
      bankroll: Number(row.balance),
      xp: Number(row.xp),
      level: Number(row.level),
      tablesPlayed: Number(row.tables_played),
      tablesWon: Number(row.tables_won),
      handsPlayed: Number(row.hands_played),
      handsWon: Number(row.hands_won),
      biggestPot: Number(row.biggest_pot),
      achievements: row.achievements || {},
      dailySpin: {
        ready: !nextSpinAt || new Date(nextSpinAt).getTime() <= Date.now(),
        lastSpinAt,
        nextSpinAt,
        lastReward: Number(row.last_spin_reward || 0),
        lastSegmentIndex: row.last_spin_segment_index === null || row.last_spin_segment_index === undefined ? null : Number(row.last_spin_segment_index),
        rewards: DAILY_SPIN_REWARDS
      },
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
        `INSERT INTO users(username_key, username, password_salt, password_hash, last_login, role)
         VALUES ($1, $2, $3, $4, NOW(), $5) RETURNING id`,
        [key, username, passwordData.saltHex, passwordData.hashHex, roleForUsername(username)]
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

  async function updateProfile(userId, { displayName, avatar, bio } = {}) {
    const account = await accountById(pool, userId);
    if (!account) throw new Error('Account not found.');
    const display = displayName === undefined ? account.displayName : cleanDisplayName(displayName, account.username);
    const safeAvatar = avatar === undefined ? account.avatar : cleanAvatar(avatar);
    const safeBio = bio === undefined ? account.bio : cleanBio(bio);
    await pool.query(
      `UPDATE player_profiles
       SET display_name = $2, avatar = $3, bio = $4, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, display, safeAvatar, safeBio]
    );
    return accountById(pool, userId);
  }

  async function dailySpinStatus(userId) {
    const result = await pool.query(
      `SELECT ds.reward, ds.segment_index, ds.spun_at,
              ds.spun_at + INTERVAL '24 hours' AS next_spin_at,
              NOW() AS server_now
       FROM daily_spins ds
       WHERE ds.user_id = $1
       ORDER BY ds.spun_at DESC
       LIMIT 1`,
      [userId]
    );
    if (!result.rowCount) {
      const nowResult = await pool.query('SELECT NOW() AS server_now');
      return {
        ready: true,
        lastSpinAt: null,
        nextSpinAt: null,
        lastReward: 0,
        lastSegmentIndex: null,
        rewards: DAILY_SPIN_REWARDS,
        serverNow: nowResult.rows[0].server_now
      };
    }
    const row = result.rows[0];
    const nextMs = new Date(row.next_spin_at).getTime();
    const nowMs = new Date(row.server_now).getTime();
    return {
      ready: nextMs <= nowMs,
      lastSpinAt: new Date(row.spun_at).toISOString(),
      nextSpinAt: new Date(row.next_spin_at).toISOString(),
      lastReward: Number(row.reward),
      lastSegmentIndex: Number(row.segment_index),
      rewards: DAILY_SPIN_REWARDS,
      serverNow: row.server_now
    };
  }

  async function claimDailySpin(userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const wallet = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!wallet.rowCount) throw new Error('Player wallet not found.');
      const previous = await client.query(
        `SELECT spun_at, spun_at + INTERVAL '24 hours' AS next_spin_at, NOW() AS server_now
         FROM daily_spins
         WHERE user_id = $1
         ORDER BY spun_at DESC
         LIMIT 1`,
        [userId]
      );
      if (previous.rowCount) {
        const row = previous.rows[0];
        if (new Date(row.next_spin_at).getTime() > new Date(row.server_now).getTime()) {
          const err = new Error('Your Daily Spin is still cooling down.');
          err.code = 'DAILY_SPIN_COOLDOWN';
          err.nextSpinAt = new Date(row.next_spin_at).toISOString();
          throw err;
        }
      }
      const segmentIndex = crypto.randomInt(DAILY_SPIN_REWARDS.length);
      const reward = DAILY_SPIN_REWARDS[segmentIndex];
      const before = Number(wallet.rows[0].balance);
      const after = before + reward;
      const spin = await client.query(
        `INSERT INTO daily_spins(user_id, reward, segment_index)
         VALUES ($1, $2, $3)
         RETURNING id, spun_at, spun_at + INTERVAL '24 hours' AS next_spin_at`,
        [userId, reward, segmentIndex]
      );
      await client.query('UPDATE wallets SET balance = $2, updated_at = NOW() WHERE user_id = $1', [userId, after]);
      await client.query(
        `INSERT INTO wallet_transactions(user_id, amount, balance_before, balance_after, reason)
         VALUES ($1, $2, $3, $4, 'daily_spin_reward')`,
        [userId, reward, before, after]
      );
      const account = await accountById(client, userId);
      await client.query('COMMIT');
      return {
        reward,
        segmentIndex,
        spunAt: new Date(spin.rows[0].spun_at).toISOString(),
        nextSpinAt: new Date(spin.rows[0].next_spin_at).toISOString(),
        account
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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

  async function topUpPlayer(playerToken, amount) {
    amount = Math.floor(Number(amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > 10_000) throw new Error('Invalid top-up amount.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query(
        `SELECT * FROM table_sessions WHERE player_token = $1 FOR UPDATE`,
        [playerToken]
      );
      if (!session.rowCount || session.rows[0].status !== 'active') throw new Error('This table seat is no longer active.');
      const row = session.rows[0];
      const wallet = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [row.user_id]);
      if (!wallet.rowCount) throw new Error('Player wallet not found.');
      const before = Number(wallet.rows[0].balance);
      if (before < amount) throw new Error(`You need ${amount.toLocaleString()} Sivel Chips for that top-up.`);
      const after = before - amount;
      await client.query('UPDATE wallets SET balance = $2, updated_at = NOW() WHERE user_id = $1', [row.user_id, after]);
      await client.query(
        `UPDATE table_sessions SET buy_in = buy_in + $2, updated_at = NOW() WHERE id = $1`,
        [row.id, amount]
      );
      await client.query(
        `INSERT INTO wallet_transactions(user_id, amount, balance_before, balance_after, reason, table_id, room_code)
         VALUES ($1, $2, $3, $4, 'table_top_up', $5, $6)`,
        [row.user_id, -amount, before, after, row.table_id, row.room_code]
      );
      const account = await accountById(client, row.user_id);
      await client.query('COMMIT');
      return { amount, account };
    } catch (err) {
      await client.query('ROLLBACK');
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
      if (!session.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const row = session.rows[0];
      if (row.status !== 'active') {
        const account = await accountById(client, row.user_id);
        await client.query('COMMIT');
        return account;
      }
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
      const account = await accountById(client, row.user_id);
      await client.query('COMMIT');
      return account;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function cashOutPlayer(playerToken, payout, reason = 'table_cash_out') {
    payout = Math.max(0, Math.floor(Number(payout) || 0));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query(
        `SELECT * FROM table_sessions WHERE player_token = $1 FOR UPDATE`,
        [playerToken]
      );
      if (!session.rowCount) {
        await client.query('COMMIT');
        return { changed: false, payout: 0, account: null };
      }
      const row = session.rows[0];
      if (row.status !== 'active') {
        const account = await accountById(client, row.user_id);
        await client.query('COMMIT');
        return { changed: false, payout: Number(row.payout) || 0, account };
      }
      const wallet = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [row.user_id]);
      if (!wallet.rowCount) throw new Error('Player wallet not found.');
      const before = Number(wallet.rows[0].balance);
      const after = before + payout;
      await client.query('UPDATE wallets SET balance = $2, updated_at = NOW() WHERE user_id = $1', [row.user_id, after]);
      await client.query(
        `UPDATE table_sessions SET status = 'cashed_out', payout = $2, updated_at = NOW() WHERE id = $1`,
        [row.id, payout]
      );
      await client.query(
        `INSERT INTO wallet_transactions(user_id, amount, balance_before, balance_after, reason, table_id, room_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.user_id, payout, before, after, reason, row.table_id, row.room_code]
      );
      const account = await accountById(client, row.user_id);
      await client.query('COMMIT');
      return { changed: true, payout, account };
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


  function orderedPair(a, b) {
    const first = BigInt(a), second = BigInt(b);
    return first < second ? [String(first), String(second)] : [String(second), String(first)];
  }

  async function touchUser(userId) {
    await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]);
  }

  async function friendIds(userId) {
    const result = await pool.query(
      `SELECT CASE WHEN user_id_low = $1 THEN user_id_high ELSE user_id_low END AS friend_id
       FROM friendships WHERE user_id_low = $1 OR user_id_high = $1`,
      [userId]
    );
    return result.rows.map(row => Number(row.friend_id));
  }

  async function areFriends(userId, otherId, client = pool) {
    const [low, high] = orderedPair(userId, otherId);
    const result = await client.query(
      'SELECT 1 FROM friendships WHERE user_id_low = $1 AND user_id_high = $2',
      [low, high]
    );
    return result.rowCount > 0;
  }

  async function blockExists(userId, otherId, client = pool) {
    const result = await client.query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [userId, otherId]
    );
    return result.rowCount > 0;
  }

  function mapSocialUser(row) {
    return {
      id: Number(row.id),
      username: row.username,
      role: row.role || 'player',
      isAdmin: row.role === 'admin',
      displayName: row.display_name,
      avatar: row.avatar,
      bio: row.bio || '',
      level: Number(row.level || 1),
      xp: Number(row.xp || 0),
      tablesPlayed: Number(row.tables_played || 0),
      tablesWon: Number(row.tables_won || 0),
      handsPlayed: Number(row.hands_played || 0),
      handsWon: Number(row.hands_won || 0),
      biggestPot: Number(row.biggest_pot || 0),
      lastSeen: row.last_seen_at || null
    };
  }

  async function publicProfile(viewerId, targetId) {
    const result = await pool.query(
      `SELECT u.id, u.username, u.last_seen_at, u.role,
              p.display_name, p.avatar, p.bio, p.level, p.xp,
              p.tables_played, p.tables_won, p.hands_played, p.hands_won, p.biggest_pot
       FROM users u JOIN player_profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [targetId]
    );
    if (!result.rowCount) throw new Error('Player not found.');
    const user = mapSocialUser(result.rows[0]);
    const [friends, blocks, incoming, outgoing] = await Promise.all([
      areFriends(viewerId, targetId),
      blockExists(viewerId, targetId),
      pool.query(`SELECT id FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'`, [targetId, viewerId]),
      pool.query(`SELECT id FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'`, [viewerId, targetId])
    ]);
    const blockedByMe = await pool.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [viewerId, targetId]);
    return {
      ...user,
      isSelf: Number(viewerId) === Number(targetId),
      isFriend: friends,
      blocked: blocks,
      blockedByMe: blockedByMe.rowCount > 0,
      incomingRequestId: incoming.rowCount ? Number(incoming.rows[0].id) : null,
      outgoingRequestId: outgoing.rowCount ? Number(outgoing.rows[0].id) : null
    };
  }

  async function searchUsers(userId, query) {
    const q = String(query || '').trim().slice(0, 40);
    if (q.length < 2) return [];
    const result = await pool.query(
      `SELECT u.id, u.username, u.last_seen_at, u.role,
              p.display_name, p.avatar, p.bio, p.level, p.xp,
              p.tables_played, p.tables_won, p.hands_played, p.hands_won, p.biggest_pot,
              EXISTS(
                SELECT 1 FROM friendships f
                WHERE (f.user_id_low = $1 AND f.user_id_high = u.id)
                   OR (f.user_id_high = $1 AND f.user_id_low = u.id)
              ) AS is_friend,
              EXISTS(SELECT 1 FROM user_blocks b WHERE b.blocker_id = $1 AND b.blocked_id = u.id) AS blocked_by_me,
              (SELECT fr.id FROM friend_requests fr WHERE fr.sender_id = $1 AND fr.receiver_id = u.id AND fr.status = 'pending' LIMIT 1) AS outgoing_request_id,
              (SELECT fr.id FROM friend_requests fr WHERE fr.sender_id = u.id AND fr.receiver_id = $1 AND fr.status = 'pending' LIMIT 1) AS incoming_request_id
       FROM users u JOIN player_profiles p ON p.user_id = u.id
       WHERE u.id <> $1
         AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $1)
         AND (u.username ILIKE $2 OR p.display_name ILIKE $2)
       ORDER BY CASE WHEN LOWER(u.username) = LOWER($3) THEN 0 ELSE 1 END,
                p.tables_won DESC, u.username
       LIMIT 20`,
      [userId, `%${q}%`, q]
    );
    return result.rows.map(row => ({
      ...mapSocialUser(row),
      isFriend: !!row.is_friend,
      blockedByMe: !!row.blocked_by_me,
      outgoingRequestId: row.outgoing_request_id ? Number(row.outgoing_request_id) : null,
      incomingRequestId: row.incoming_request_id ? Number(row.incoming_request_id) : null
    }));
  }

  async function sendFriendRequest(senderId, receiverId) {
    receiverId = Number(receiverId);
    if (!receiverId || Number(senderId) === receiverId) throw new Error('Choose another player.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query('SELECT id FROM users WHERE id = $1', [receiverId]);
      if (!target.rowCount) throw new Error('Player not found.');
      if (await blockExists(senderId, receiverId, client)) throw new Error('A block prevents this friend request.');
      if (await areFriends(senderId, receiverId, client)) throw new Error('You are already friends.');
      const reverse = await client.query(
        `SELECT id FROM friend_requests
         WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending' FOR UPDATE`,
        [receiverId, senderId]
      );
      if (reverse.rowCount) {
        const [low, high] = orderedPair(senderId, receiverId);
        await client.query(`INSERT INTO friendships(user_id_low, user_id_high) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [low, high]);
        await client.query(`UPDATE friend_requests SET status = 'accepted', responded_at = NOW() WHERE id = $1`, [reverse.rows[0].id]);
        await client.query('COMMIT');
        return { accepted: true, requestId: Number(reverse.rows[0].id), targetId: receiverId };
      }
      const existing = await client.query(
        `SELECT id FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'`,
        [senderId, receiverId]
      );
      if (existing.rowCount) throw new Error('Friend request already sent.');
      const inserted = await client.query(
        `INSERT INTO friend_requests(sender_id, receiver_id) VALUES ($1,$2) RETURNING id`,
        [senderId, receiverId]
      );
      await client.query('COMMIT');
      return { accepted: false, requestId: Number(inserted.rows[0].id), targetId: receiverId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }

  async function respondFriendRequest(userId, requestId, action) {
    if (!['accept','decline'].includes(action)) throw new Error('Invalid friend request action.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT * FROM friend_requests WHERE id = $1 AND receiver_id = $2 AND status = 'pending' FOR UPDATE`,
        [requestId, userId]
      );
      if (!result.rowCount) throw new Error('Friend request is no longer available.');
      const row = result.rows[0];
      if (action === 'accept') {
        if (await blockExists(row.sender_id, row.receiver_id, client)) throw new Error('A block prevents this friendship.');
        const [low, high] = orderedPair(row.sender_id, row.receiver_id);
        await client.query(`INSERT INTO friendships(user_id_low, user_id_high) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [low, high]);
      }
      await client.query(
        `UPDATE friend_requests SET status = $2, responded_at = NOW() WHERE id = $1`,
        [requestId, action === 'accept' ? 'accepted' : 'declined']
      );
      await client.query('COMMIT');
      return { senderId: Number(row.sender_id), receiverId: Number(row.receiver_id), accepted: action === 'accept' };
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }

  async function cancelFriendRequest(userId, requestId) {
    const result = await pool.query(
      `UPDATE friend_requests SET status = 'cancelled', responded_at = NOW()
       WHERE id = $1 AND sender_id = $2 AND status = 'pending' RETURNING receiver_id`,
      [requestId, userId]
    );
    if (!result.rowCount) throw new Error('Friend request is no longer available.');
    return Number(result.rows[0].receiver_id);
  }

  async function removeFriend(userId, otherId) {
    const [low, high] = orderedPair(userId, otherId);
    const result = await pool.query(
      `DELETE FROM friendships WHERE user_id_low = $1 AND user_id_high = $2`,
      [low, high]
    );
    if (!result.rowCount) throw new Error('That player is not on your friends list.');
  }

  async function blockUser(userId, otherId) {
    if (Number(userId) === Number(otherId)) throw new Error('You cannot block yourself.');
    const [low, high] = orderedPair(userId, otherId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO user_blocks(blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, otherId]);
      await client.query(`DELETE FROM friendships WHERE user_id_low = $1 AND user_id_high = $2`, [low, high]);
      await client.query(
        `UPDATE friend_requests SET status = 'cancelled', responded_at = NOW()
         WHERE status = 'pending' AND ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1))`,
        [userId, otherId]
      );
      await client.query(
        `UPDATE table_invites SET status = 'cancelled', responded_at = NOW()
         WHERE status = 'pending' AND ((inviter_id=$1 AND invitee_id=$2) OR (inviter_id=$2 AND invitee_id=$1))`,
        [userId, otherId]
      );
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }

  async function unblockUser(userId, otherId) {
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [userId, otherId]);
  }

  async function sendDirectMessage(senderId, receiverId, body) {
    const text = cleanDirectMessage(body);
    if (!text) throw new Error('Enter a message first.');
    if (!(await areFriends(senderId, receiverId))) throw new Error('You can only message friends.');
    if (await blockExists(senderId, receiverId)) throw new Error('A block prevents this message.');
    const result = await pool.query(
      `INSERT INTO direct_messages(sender_id, receiver_id, body)
       VALUES ($1,$2,$3) RETURNING id, created_at`,
      [senderId, receiverId, text]
    );
    return { id: Number(result.rows[0].id), senderId: Number(senderId), receiverId: Number(receiverId), text, createdAt: result.rows[0].created_at };
  }

  async function conversation(userId, otherId, limit = 100) {
    if (!(await areFriends(userId, otherId))) throw new Error('You can only message friends.');
    limit = Math.max(1, Math.min(150, Math.floor(Number(limit) || 100)));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT id, sender_id, receiver_id, body, created_at, read_at
         FROM direct_messages
         WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)
         ORDER BY created_at DESC LIMIT $3`,
        [userId, otherId, limit]
      );
      await client.query(
        `UPDATE direct_messages SET read_at = NOW()
         WHERE sender_id=$2 AND receiver_id=$1 AND read_at IS NULL`,
        [userId, otherId]
      );
      await client.query('COMMIT');
      return result.rows.reverse().map(row => ({
        id: Number(row.id), senderId: Number(row.sender_id), receiverId: Number(row.receiver_id),
        text: row.body, createdAt: row.created_at, readAt: row.read_at, isSelf: Number(row.sender_id) === Number(userId)
      }));
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }

  async function sendTableInvite({ inviterId, inviteeId, targetType, tableId = null, roomCode = null, tableName }) {
    if (!(await areFriends(inviterId, inviteeId))) throw new Error('You can only invite friends.');
    if (await blockExists(inviterId, inviteeId)) throw new Error('A block prevents this invitation.');
    await pool.query(
      `UPDATE table_invites SET status = 'expired', responded_at = NOW()
       WHERE status = 'pending' AND expires_at <= NOW()`
    );
    const recent = await pool.query(
      `SELECT COUNT(*)::int AS count FROM table_invites
       WHERE inviter_id=$1 AND invitee_id=$2 AND created_at > NOW() - INTERVAL '2 minutes'`,
      [inviterId, inviteeId]
    );
    if (Number(recent.rows[0].count) >= 3) throw new Error('Please wait before sending another invitation.');
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO table_invites(id, inviter_id, invitee_id, target_type, table_id, room_code, table_name, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + INTERVAL '15 minutes')`,
      [id, inviterId, inviteeId, targetType, tableId, roomCode, String(tableName || 'Sivel Poker Table').slice(0,80)]
    );
    return { id, inviteeId: Number(inviteeId) };
  }

  async function respondTableInvite(userId, inviteId, action) {
    if (!['accept','decline'].includes(action)) throw new Error('Invalid invitation action.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT i.*, u.username, p.display_name, p.avatar
         FROM table_invites i
         JOIN users u ON u.id=i.inviter_id JOIN player_profiles p ON p.user_id=u.id
         WHERE i.id=$1 AND i.invitee_id=$2 AND i.status='pending' FOR UPDATE`,
        [inviteId, userId]
      );
      if (!result.rowCount) throw new Error('This invitation is no longer available.');
      const row = result.rows[0];
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query(`UPDATE table_invites SET status='expired', responded_at=NOW() WHERE id=$1`, [inviteId]);
        await client.query('COMMIT');
        throw new Error('This invitation has expired.');
      }
      await client.query(
        `UPDATE table_invites SET status=$2, responded_at=NOW() WHERE id=$1`,
        [inviteId, action === 'accept' ? 'accepted' : 'declined']
      );
      await client.query('COMMIT');
      return {
        id: row.id, inviterId: Number(row.inviter_id), inviteeId: Number(row.invitee_id),
        inviterName: row.display_name, inviterAvatar: row.avatar,
        targetType: row.target_type, tableId: row.table_id, roomCode: row.room_code,
        tableName: row.table_name, accepted: action === 'accept'
      };
    } catch (err) { try { await client.query('ROLLBACK'); } catch (_) {} throw err; }
    finally { client.release(); }
  }

  async function socialSnapshot(userId) {
    await pool.query(`UPDATE table_invites SET status='expired', responded_at=NOW() WHERE status='pending' AND expires_at <= NOW()`);
    const [friendsResult, incomingResult, outgoingResult, invitesResult, blockedResult, account] = await Promise.all([
      pool.query(
        `WITH friend_ids AS (
           SELECT CASE WHEN user_id_low=$1 THEN user_id_high ELSE user_id_low END AS friend_id, created_at
           FROM friendships WHERE user_id_low=$1 OR user_id_high=$1
         )
         SELECT u.id, u.username, u.last_seen_at, u.role, p.display_name, p.avatar, p.bio, p.level, p.xp,
                p.tables_played, p.tables_won, p.hands_played, p.hands_won, p.biggest_pot,
                f.created_at AS friends_since,
                (SELECT COUNT(*)::int FROM direct_messages dm WHERE dm.sender_id=u.id AND dm.receiver_id=$1 AND dm.read_at IS NULL) AS unread_count,
                (SELECT dm.body FROM direct_messages dm WHERE (dm.sender_id=$1 AND dm.receiver_id=u.id) OR (dm.sender_id=u.id AND dm.receiver_id=$1) ORDER BY dm.created_at DESC LIMIT 1) AS last_message,
                (SELECT dm.created_at FROM direct_messages dm WHERE (dm.sender_id=$1 AND dm.receiver_id=u.id) OR (dm.sender_id=u.id AND dm.receiver_id=$1) ORDER BY dm.created_at DESC LIMIT 1) AS last_message_at
         FROM friend_ids f JOIN users u ON u.id=f.friend_id JOIN player_profiles p ON p.user_id=u.id
         ORDER BY COALESCE((SELECT dm.created_at FROM direct_messages dm WHERE (dm.sender_id=$1 AND dm.receiver_id=u.id) OR (dm.sender_id=u.id AND dm.receiver_id=$1) ORDER BY dm.created_at DESC LIMIT 1), f.created_at) DESC`,
        [userId]
      ),
      pool.query(
        `SELECT fr.id, fr.created_at, u.id AS user_id, u.username, u.last_seen_at, u.role, p.display_name, p.avatar, p.bio, p.level
         FROM friend_requests fr JOIN users u ON u.id=fr.sender_id JOIN player_profiles p ON p.user_id=u.id
         WHERE fr.receiver_id=$1 AND fr.status='pending' ORDER BY fr.created_at DESC`, [userId]),
      pool.query(
        `SELECT fr.id, fr.created_at, u.id AS user_id, u.username, u.last_seen_at, u.role, p.display_name, p.avatar, p.bio, p.level
         FROM friend_requests fr JOIN users u ON u.id=fr.receiver_id JOIN player_profiles p ON p.user_id=u.id
         WHERE fr.sender_id=$1 AND fr.status='pending' ORDER BY fr.created_at DESC`, [userId]),
      pool.query(
        `SELECT i.id, i.target_type, i.table_id, i.room_code, i.table_name, i.created_at, i.expires_at,
                u.id AS inviter_id, u.username, u.role, p.display_name, p.avatar
         FROM table_invites i JOIN users u ON u.id=i.inviter_id JOIN player_profiles p ON p.user_id=u.id
         WHERE i.invitee_id=$1 AND i.status='pending' AND i.expires_at>NOW() ORDER BY i.created_at DESC`, [userId]),
      pool.query(
        `SELECT u.id, u.username, u.last_seen_at, u.role, p.display_name, p.avatar, p.bio, p.level
         FROM user_blocks b JOIN users u ON u.id=b.blocked_id JOIN player_profiles p ON p.user_id=u.id
         WHERE b.blocker_id=$1 ORDER BY b.created_at DESC`, [userId]),
      accountById(pool, userId)
    ]);
    return {
      account,
      friends: friendsResult.rows.map(row => ({
        ...mapSocialUser(row), friendsSince: row.friends_since,
        unreadCount: Number(row.unread_count || 0), lastMessage: row.last_message || '', lastMessageAt: row.last_message_at || null
      })),
      incomingRequests: incomingResult.rows.map(row => ({ id:Number(row.id), createdAt:row.created_at, user:{...mapSocialUser({...row,id:row.user_id}), level:Number(row.level||1)} })),
      outgoingRequests: outgoingResult.rows.map(row => ({ id:Number(row.id), createdAt:row.created_at, user:{...mapSocialUser({...row,id:row.user_id}), level:Number(row.level||1)} })),
      invites: invitesResult.rows.map(row => ({
        id:row.id, targetType:row.target_type, tableId:row.table_id, roomCode:row.room_code,
        tableName:row.table_name, createdAt:row.created_at, expiresAt:row.expires_at,
        inviter:{id:Number(row.inviter_id), username:row.username, role:row.role||'player', isAdmin:row.role==='admin', displayName:row.display_name, avatar:row.avatar}
      })),
      blocked: blockedResult.rows.map(row => mapSocialUser(row))
    };
  }


  async function requireAdmin(rawToken) {
    const account = await requireAuth(rawToken);
    if (!account.isAdmin) throw new Error('Administrator access required.');
    return account;
  }

  async function recordAdminAction(adminUserId, targetUserId, action, details = {}) {
    await pool.query(
      `INSERT INTO admin_audit_log(admin_user_id, target_user_id, action, details)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [adminUserId, targetUserId || null, String(action || 'admin_action').slice(0,64), JSON.stringify(details || {})]
    );
  }

  async function adminOverview() {
    const [counts, recent] = await Promise.all([
      pool.query(`SELECT
        (SELECT COUNT(*)::int FROM users) AS accounts,
        (SELECT COUNT(*)::int FROM auth_sessions WHERE expires_at > NOW() AND last_seen > NOW() - INTERVAL '15 minutes') AS active_sessions,
        (SELECT COALESCE(SUM(balance),0)::bigint FROM wallets) AS total_chips,
        (SELECT COUNT(*)::int FROM friendships) AS friendships`),
      pool.query(`SELECT a.id, a.action, a.details, a.created_at,
                         admin.username AS admin_username, target.username AS target_username
                  FROM admin_audit_log a
                  JOIN users admin ON admin.id=a.admin_user_id
                  LEFT JOIN users target ON target.id=a.target_user_id
                  ORDER BY a.created_at DESC LIMIT 20`)
    ]);
    const row = counts.rows[0];
    return {
      accounts: Number(row.accounts || 0),
      activeSessions: Number(row.active_sessions || 0),
      totalChips: Number(row.total_chips || 0),
      friendships: Number(row.friendships || 0),
      recentActions: recent.rows.map(item => ({
        id: Number(item.id), action: item.action, details: item.details || {},
        adminUsername: item.admin_username, targetUsername: item.target_username || '', createdAt: item.created_at
      }))
    };
  }

  async function adminSearchUsers(query) {
    const q = String(query || '').trim().slice(0,40);
    if (q.length < 2) return [];
    const result = await pool.query(
      `SELECT u.id, u.username, u.role, u.created_at, u.last_seen_at,
              p.display_name, p.avatar, p.level, p.xp, p.tables_played, p.tables_won,
              w.balance
       FROM users u JOIN player_profiles p ON p.user_id=u.id JOIN wallets w ON w.user_id=u.id
       WHERE u.username ILIKE $1 OR p.display_name ILIKE $1
       ORDER BY CASE WHEN LOWER(u.username)=LOWER($2) THEN 0 ELSE 1 END, u.username
       LIMIT 30`,
      [`%${q}%`, q]
    );
    return result.rows.map(row => ({
      id:Number(row.id), username:row.username, role:row.role||'player', isAdmin:row.role==='admin',
      displayName:row.display_name, avatar:row.avatar, level:Number(row.level), xp:Number(row.xp),
      bankroll:Number(row.balance), tablesPlayed:Number(row.tables_played), tablesWon:Number(row.tables_won),
      createdAt:row.created_at, lastSeen:row.last_seen_at
    }));
  }

  async function adminAdjustBankroll({ adminUserId, targetUserId, amount, reason }) {
    amount = Math.trunc(Number(amount));
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1_000_000) throw new Error('Adjustment must be between -1,000,000 and 1,000,000 chips.');
    const cleanReason = String(reason || '').replace(/[<>]/g,'').replace(/\s+/g,' ').trim().slice(0,120);
    if (cleanReason.length < 4) throw new Error('Enter a clear reason for the adjustment.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query(`SELECT u.id,u.username,w.balance FROM users u JOIN wallets w ON w.user_id=u.id WHERE u.id=$1 FOR UPDATE`, [targetUserId]);
      if (!target.rowCount) throw new Error('Player account not found.');
      const before = Number(target.rows[0].balance);
      const after = before + amount;
      if (after < 0) throw new Error('This adjustment would make the bankroll negative.');
      await client.query('UPDATE wallets SET balance=$2,updated_at=NOW() WHERE user_id=$1', [targetUserId, after]);
      await client.query(`INSERT INTO wallet_transactions(user_id,amount,balance_before,balance_after,reason)
                          VALUES ($1,$2,$3,$4,'admin_adjustment')`, [targetUserId, amount, before, after]);
      await client.query(`INSERT INTO admin_audit_log(admin_user_id,target_user_id,action,details)
                          VALUES ($1,$2,'bankroll_adjustment',$3::jsonb)`, [adminUserId,targetUserId,JSON.stringify({amount,before,after,reason:cleanReason})]);
      await client.query('COMMIT');
      return { userId:Number(targetUserId), username:target.rows[0].username, amount, balanceBefore:before, balanceAfter:after };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally { client.release(); }
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
    dailySpinStatus,
    claimDailySpin,
    reserveBuyIn,
    topUpPlayer,
    refundPlayer,
    cashOutPlayer,
    refundTable,
    recoverInterruptedTables,
    settleTable,
    touchUser,
    friendIds,
    publicProfile,
    searchUsers,
    sendFriendRequest,
    respondFriendRequest,
    cancelFriendRequest,
    removeFriend,
    blockUser,
    unblockUser,
    sendDirectMessage,
    conversation,
    sendTableInvite,
    respondTableInvite,
    socialSnapshot,
    requireAdmin,
    recordAdminAction,
    adminOverview,
    adminSearchUsers,
    adminAdjustBankroll,
    recentTransactions,
    health,
    close: () => pool.end()
  };
}

module.exports = { createAccountStore, cleanDisplayName, cleanAvatar, cleanBio, cleanDirectMessage };
