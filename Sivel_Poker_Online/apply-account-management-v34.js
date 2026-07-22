'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const serverPath = path.join(root, 'server.js');
const storePath = path.join(root, 'account-store.js');

function fail(message) {
  console.error(`\nAccount-management upgrade stopped: ${message}\n`);
  process.exit(1);
}

function replaceOnce(source, find, replacement, label) {
  const count = source.split(find).length - 1;
  if (count !== 1) fail(`${label} anchor was found ${count} times. Apply this patch to the reviewed Sivel Poker backend.`);
  return source.replace(find, replacement);
}

if (!fs.existsSync(serverPath) || !fs.existsSync(storePath)) {
  fail('Place this file beside server.js and account-store.js, then run: node apply-account-management-v34.js');
}

let server = fs.readFileSync(serverPath, 'utf8');
let store = fs.readFileSync(storePath, 'utf8');

if (server.includes("pathname === '/api/account/password'") && store.includes('async function changePassword(')) {
  console.log('Account-management backend upgrade is already installed.');
  process.exit(0);
}

fs.copyFileSync(serverPath, `${serverPath}.pre-account-management-v34.bak`);
fs.copyFileSync(storePath, `${storePath}.pre-account-management-v34.bak`);

const logoutAnchor = `  async function logout(rawToken) {
    if (rawToken) await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(rawToken)]);
  }

`;

const accountFunctions = `${logoutAnchor}  async function changePassword(userId, rawToken, { currentPassword, newPassword } = {}) {
    currentPassword = validatePassword(currentPassword);
    newPassword = validatePassword(newPassword);
    if (currentPassword === newPassword) throw new Error('Choose a new password that is different from the current password.');

    const current = await pool.query(
      'SELECT password_salt, password_hash FROM users WHERE id = $1',
      [userId]
    );
    if (!current.rowCount) throw new Error('Account not found.');
    const valid = await verifyPassword(currentPassword, current.rows[0].password_salt, current.rows[0].password_hash);
    if (!valid) throw new Error('The current password is incorrect.');

    const passwordData = await hashPassword(newPassword);
    const activeHash = tokenHash(rawToken);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET password_salt=$2, password_hash=$3 WHERE id=$1',
        [userId, passwordData.saltHex, passwordData.hashHex]
      );
      const revoked = await client.query(
        'DELETE FROM auth_sessions WHERE user_id=$1 AND token_hash<>$2',
        [userId, activeHash]
      );
      const account = await accountById(client, userId);
      await client.query('COMMIT');
      return { account, sessionsRevoked: revoked.rowCount };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  async function logoutOtherSessions(userId, rawToken) {
    const result = await pool.query(
      'DELETE FROM auth_sessions WHERE user_id=$1 AND token_hash<>$2',
      [userId, tokenHash(rawToken)]
    );
    return { sessionsRevoked: result.rowCount };
  }

`;

store = replaceOnce(store, logoutAnchor, accountFunctions, 'account security functions');

store = replaceOnce(
  store,
  `    logout,
    updateProfile,`,
  `    logout,
    changePassword,
    logoutOtherSessions,
    updateProfile,`,
  'account-store exports'
);

const profileRoute = `    if (pathname === '/api/profile') {
      const account = await accounts.requireAuth(authTokenFrom(req, body));
      const updated = await accounts.updateProfile(account.id, body);
      return json(res, 200, { ok: true, account: updated });
    }
`;

const accountRoutes = `${profileRoute}    if (pathname === '/api/account/password') {
      const rawToken = authTokenFrom(req, body);
      const account = await accounts.requireAuth(rawToken);
      const result = await accounts.changePassword(account.id, rawToken, body);
      return json(res, 200, { ok: true, ...result });
    }
    if (pathname === '/api/account/logout-others') {
      const rawToken = authTokenFrom(req, body);
      const account = await accounts.requireAuth(rawToken);
      const result = await accounts.logoutOtherSessions(account.id, rawToken);
      return json(res, 200, { ok: true, ...result });
    }
`;

server = replaceOnce(server, profileRoute, accountRoutes, 'account API routes');

fs.writeFileSync(serverPath, server);
fs.writeFileSync(storePath, store);
console.log('Account-management backend upgrade installed successfully.');
console.log('Backups were created beside server.js and account-store.js.');
console.log('Run npm test, then restart or redeploy the service.');
