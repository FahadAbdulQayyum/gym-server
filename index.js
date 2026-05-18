require('dotenv').config();

const dns = require('dns');
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { version } = require('./package.json');

const PORT = Number(process.env.PORT) || 3847;
const MONGODB_DB = process.env.MONGODB_DB || 'gym';
const SYNC_API_KEY = process.env.SYNC_API_KEY || '';

function buildMongoUri() {
  const user = process.env.MONGODB_USER?.trim();
  const password = process.env.MONGODB_PASSWORD;
  const host = process.env.MONGODB_HOST?.trim();

  if (user && password && host) {
    const normalizedHost = host.replace(/^mongodb(\+srv)?:\/\//, '').replace(/\/$/, '');
    return `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${normalizedHost}/?retryWrites=true&w=majority&authSource=admin`;
  }

  const uri = process.env.MONGODB_URI?.trim();
  if (uri) {
    return uri;
  }

  return 'mongodb://localhost:27017';
}

const MONGODB_URI = buildMongoUri();

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));

let client;
let studentsCollection;
let usersCollection;

function parseSince(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isNewer(a, b) {
  if (!b) return true;
  if (!a) return false;
  return new Date(a).getTime() > new Date(b).getTime();
}

function authorize(req, res, next) {
  if (!SYNC_API_KEY) {
    res.status(503).json({ error: 'Sync API is not configured (missing SYNC_API_KEY)' });
    return;
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== SYNC_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
// 
app.get('/health', async (_req, res) => {
  const payload = {
    ok: true,
    service: 'gym-sync',
    version,
    timestamp: new Date().toISOString(),
    runtime: process.env.FUNCTION_TARGET ? 'firebase' : 'local',
    mongodb: 'unknown',
  };

  if (!client) {
    payload.ok = false;
    payload.mongodb = 'not_initialized';
    res.status(503).json(payload);
    return;
  }

  try {
    await client.db(MONGODB_DB).command({ ping: 1 });
    payload.mongodb = 'connected';
    res.json(payload);
  } catch (error) {
    payload.ok = false;
    payload.mongodb = 'error';
    payload.error = error.message;
    res.status(503).json(payload);
  }
});

async function applyIncomingRecords(collection, gymId, records, deletions, serverTime) {
  for (const record of records) {
    const id = String(record?.id ?? '').trim();
    if (!id) continue;

    const filter = { gymId, id };
    const existing = await collection.findOne(filter);

    if (existing?.deletedAt) {
      continue;
    }

    if (!existing || isNewer(record.updatedAt, existing.updatedAt)) {
      await collection.updateOne(
        filter,
        {
          $set: {
            ...record,
            gymId,
            id,
            deletedAt: null,
            syncedAt: serverTime,
          },
        },
        { upsert: true }
      );
    }
  }

  for (const deletion of deletions) {
    const id = String(deletion?.id ?? '').trim();
    const deletedAt = deletion?.deletedAt;
    if (!id || !deletedAt) continue;

    const filter = { gymId, id };
    const existing = await collection.findOne(filter);
    if (existing && !isNewer(deletedAt, existing.deletedAt)) {
      continue;
    }

    if (existing && isNewer(existing.updatedAt, deletedAt)) {
      continue;
    }

    await collection.updateOne(
      filter,
      {
        $set: {
          gymId,
          id,
          deletedAt,
          updatedAt: deletedAt,
          syncedAt: serverTime,
        },
      },
      { upsert: true }
    );
  }
}

async function pullChangedRecords(collection, gymId, since) {
  const sinceQuery = since
    ? {
        $or: [{ updatedAt: { $gt: since.toISOString() } }, { deletedAt: { $gt: since.toISOString() } }],
      }
    : {};

  const changed = await collection
    .find({ gymId, ...sinceQuery })
    .project({ _id: 0, gymId: 0, syncedAt: 0 })
    .toArray();

  const records = [];
  const deletions = [];

  for (const doc of changed) {
    if (doc.deletedAt) {
      deletions.push({ id: doc.id, deletedAt: doc.deletedAt });
    } else {
      const { deletedAt: _removed, ...record } = doc;
      records.push(record);
    }
  }

  return { records, deletions };
}

app.post('/api/sync', authorize, async (req, res) => {
  try {
    const gymId = String(req.body?.gymId ?? '').trim();
    if (!gymId) {
      res.status(400).json({ error: 'gymId is required' });
      return;
    }

    const since = parseSince(req.body?.since);
    const incomingStudents = Array.isArray(req.body?.students) ? req.body.students : [];
    const incomingDeletions = Array.isArray(req.body?.deletions) ? req.body.deletions : [];
    const incomingUsers = Array.isArray(req.body?.users) ? req.body.users : [];
    const incomingUserDeletions = Array.isArray(req.body?.userDeletions) ? req.body.userDeletions : [];
    const serverTime = new Date().toISOString();

    await applyIncomingRecords(studentsCollection, gymId, incomingStudents, incomingDeletions, serverTime);
    await applyIncomingRecords(usersCollection, gymId, incomingUsers, incomingUserDeletions, serverTime);

    const studentsPull = await pullChangedRecords(studentsCollection, gymId, since);
    const usersPull = await pullChangedRecords(usersCollection, gymId, since);

    res.json({
      students: studentsPull.records,
      deletions: studentsPull.deletions,
      users: usersPull.records,
      userDeletions: usersPull.deletions,
      serverTime,
    });
  } catch (error) {
    console.error('Sync failed:', error);
    res.status(500).json({ error: 'Sync failed' });
  }
});

function configureMongoDns() {
  if (!MONGODB_URI.startsWith('mongodb+srv://')) {
    return;
  }

  const servers = (process.env.MONGODB_DNS_SERVERS || '8.8.8.8,1.1.1.1')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  dns.setServers(servers);
}

async function initialize() {
  configureMongoDns();
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);
  studentsCollection = db.collection('students');
  usersCollection = db.collection('users');

  for (const collection of [studentsCollection, usersCollection]) {
    await collection.createIndex({ gymId: 1, id: 1 }, { unique: true });
    await collection.createIndex({ gymId: 1, updatedAt: 1 });
    await collection.createIndex({ gymId: 1, deletedAt: 1 });
  }

  return app;
}

async function start() {
  await initialize();
  app.listen(PORT, () => {
    console.log(`Gym sync API listening on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

function logStartupError(error) {
  console.error('Failed to start sync server:', error.message || error);
  if (error.code === 'ECONNREFUSED' && String(error.syscall) === 'querySrv') {
    console.error(
      'DNS could not resolve MongoDB Atlas (mongodb+srv). Add MONGODB_DNS_SERVERS=8.8.8.8,1.1.1.1 to server/.env or use a standard mongodb:// URI from Atlas.'
    );
  }
  if (error.code === 8000 || /bad auth/i.test(String(error.message))) {
    console.error(
      'MongoDB rejected the username or password. In Atlas: Database Access → edit user → reset password, then update server/.env (MONGODB_URI or MONGODB_USER + MONGODB_PASSWORD).'
    );
  }
}

if (require.main === module) {
  start().catch((error) => {
    logStartupError(error);
    process.exit(1);
  });
}

module.exports = { app, initialize };

process.on('SIGINT', async () => {
  await client?.close();
  process.exit(0);
});
