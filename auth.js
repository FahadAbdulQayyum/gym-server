const crypto = require('crypto');

function newId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256');
  return {
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

function verifyPassword(password, saltBase64, hashBase64) {
  const salt = Buffer.from(saltBase64, 'base64');
  const expected = Buffer.from(hashBase64, 'base64');
  const actual = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function normalizeUsername(username) {
  const normalized = String(username ?? '').trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 32) {
    throw new Error('Username must be 3–32 characters');
  }
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    throw new Error('Username may only use letters, numbers, and underscores');
  }
  return normalized;
}

function validatePassword(password) {
  const value = String(password ?? '');
  if (value.length < 4) {
    throw new Error('Password must be at least 4 characters');
  }
  if (value.length > 128) {
    throw new Error('Password must be 128 characters or fewer');
  }
  return value;
}

function toStoredUser({ id, username, passwordSalt, passwordHash, role, createdAt, updatedAt }) {
  return {
    id,
    username,
    passwordSalt,
    passwordHash,
    role: role === 'admin' ? 'admin' : 'staff',
    createdAt,
    updatedAt,
    deletedAt: null,
  };
}

function registerAuthRoutes(app, { accountsCollection, authorize }) {
  app.post('/api/auth/login', authorize, async (req, res) => {
    try {
      const username = normalizeUsername(req.body?.username);
      const password = validatePassword(req.body?.password);

      const account = await accountsCollection.findOne({
        username,
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      });

      if (!account || !verifyPassword(password, account.passwordSalt, account.passwordHash)) {
        res.status(401).json({ error: 'Invalid username or password' });
        return;
      }

      const user = toStoredUser(account);
      res.json({ user });
    } catch (error) {
      const status = /username|password/i.test(error.message) ? 400 : 500;
      res.status(status).json({ error: error.message || 'Login failed' });
    }
  });

  app.post('/api/auth/signup', authorize, async (req, res) => {
    try {
      const username = normalizeUsername(req.body?.username);
      const password = validatePassword(req.body?.password);

      if (username === 'admin') {
        res.status(400).json({
          error: 'Username "admin" is reserved. Pick another username.',
        });
        return;
      }

      const existing = await accountsCollection.findOne({ username });
      if (existing && !existing.deletedAt) {
        res.status(409).json({ error: `Username "${username}" is already registered` });
        return;
      }

      const timestamp = nowIso();
      const { salt, hash } = hashPassword(password);
      const user = toStoredUser({
        id: newId(),
        username,
        passwordSalt: salt,
        passwordHash: hash,
        role: 'staff',
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      await accountsCollection.updateOne(
        { username },
        { $set: user },
        { upsert: true }
      );

      res.status(201).json({ user });
    } catch (error) {
      const status = /username|password|reserved/i.test(error.message) ? 400 : 500;
      res.status(status).json({ error: error.message || 'Signup failed' });
    }
  });

  app.post('/api/auth/register', authorize, async (req, res) => {
    try {
      const username = normalizeUsername(req.body?.username);
      const password = validatePassword(req.body?.password);
      const requestedId = String(req.body?.id ?? '').trim();

      const byName = await accountsCollection.findOne({ username });
      if (byName && !byName.deletedAt && byName.id !== requestedId) {
        res.status(409).json({ error: `Username "${username}" is already registered` });
        return;
      }

      let account = requestedId
        ? await accountsCollection.findOne({ id: requestedId })
        : null;

      if (account && account.username !== username && !account.deletedAt) {
        res.status(409).json({ error: 'Account id is already linked to another username' });
        return;
      }

      const timestamp = nowIso();
      const { salt, hash } = hashPassword(password);
      const user = toStoredUser({
        id: account?.id || requestedId || newId(),
        username,
        passwordSalt: salt,
        passwordHash: hash,
        role: account?.role || 'staff',
        createdAt: account?.createdAt || timestamp,
        updatedAt: timestamp,
      });

      await accountsCollection.updateOne({ id: user.id }, { $set: user }, { upsert: true });
      res.json({ user });
    } catch (error) {
      const status = /username|password/i.test(error.message) ? 400 : 500;
      res.status(status).json({ error: error.message || 'Register failed' });
    }
  });
}

module.exports = { registerAuthRoutes };
