import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { requireAuth, requireRole } from '../src/middlewares/auth.middleware';
import { errorHandler } from '../src/middlewares/error.middleware';
import { UserModel } from '../src/models/user.model';
import { hashPassword } from '../src/utils/password';

// Integration tests: real Express app + real MongoDB, using a separate database.
const TEST_DB_NAME = 'it-helpdesk-test';
const PASSWORD = 'Test@12345';

let server: Server;
let baseUrl: string;
let tiUserId: string;

async function request(path: string, init: RequestInit = {}, url = baseUrl) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  return { status: response.status, body: await response.json() };
}

function login(email: string, password: string, extra: Record<string, unknown> = {}) {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, ...extra }),
  });
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function listen(handler: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const httpServer = handler.listen(0, () => {
      const { port } = httpServer.address() as AddressInfo;
      resolve({ server: httpServer, url: `http://127.0.0.1:${port}` });
    });
  });
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await UserModel.syncIndexes();

  const passwordHash = await hashPassword(PASSWORD);
  const ti = await UserModel.create({ name: 'TI', email: 'ti@test.local', passwordHash, role: 'ti' });
  await UserModel.create({ name: 'Requester', email: 'req@test.local', passwordHash, role: 'solicitante' });
  tiUserId = ti.id;

  ({ server, url: baseUrl } = await listen(app));
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('GET /api/health', () => {
  it('still returns ok', async () => {
    const { status, body } = await request('/api/health');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok' });
  });
});

describe('POST /api/auth/login', () => {
  it('returns a token and only the public user fields', async () => {
    const { status, body } = await login('ti@test.local', PASSWORD);
    assert.equal(status, 200);
    assert.equal(typeof body.token, 'string');
    assert.deepEqual(Object.keys(body.user).sort(), ['email', 'id', 'name', 'role']);
    assert.equal(body.user.role, 'ti');
  });

  it('normalizes the email (case and spaces)', async () => {
    const { status } = await login('  TI@Test.Local ', PASSWORD);
    assert.equal(status, 200);
  });

  it('rejects a wrong password with a generic message', async () => {
    const { status, body } = await login('ti@test.local', 'wrong-password');
    assert.equal(status, 401);
    assert.equal(body.message, 'Invalid email or password');
  });

  it('rejects an unknown user with the same generic message', async () => {
    const { status, body } = await login('ghost@test.local', PASSWORD);
    assert.equal(status, 401);
    assert.equal(body.message, 'Invalid email or password');
  });

  it('validates the request body', async () => {
    const { status, body } = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    assert.equal(status, 400);
    assert.ok(body.errors.email);
    assert.ok(body.errors.password);
  });

  it('ignores a role sent by the client', async () => {
    const { body } = await login('req@test.local', PASSWORD, { role: 'ti' });
    assert.equal(body.user.role, 'solicitante');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the authenticated user without passwordHash', async () => {
    const { body: loginBody } = await login('ti@test.local', PASSWORD);
    const { status, body } = await request('/api/auth/me', { headers: bearer(loginBody.token) });
    assert.equal(status, 200);
    assert.equal(body.user.email, 'ti@test.local');
    assert.equal('passwordHash' in body.user, false);
  });

  it('requires a token', async () => {
    const { status } = await request('/api/auth/me');
    assert.equal(status, 401);
  });

  it('rejects an invalid token', async () => {
    const { status, body } = await request('/api/auth/me', { headers: bearer('abc.def.ghi') });
    assert.equal(status, 401);
    assert.equal(body.message, 'Invalid token');
  });

  it('rejects a token signed with another secret', async () => {
    const forged = jwt.sign({}, 'another-secret-with-more-than-32-chars!!', { subject: tiUserId });
    const { status } = await request('/api/auth/me', { headers: bearer(forged) });
    assert.equal(status, 401);
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign({ exp: Math.floor(Date.now() / 1000) - 60 }, env.JWT_SECRET, {
      subject: tiUserId,
    });
    const { status, body } = await request('/api/auth/me', { headers: bearer(expired) });
    assert.equal(status, 401);
    assert.equal(body.message, 'Token expired');
  });

  it('rejects a valid token whose user was deleted', async () => {
    const temp = await UserModel.create({
      name: 'Temp',
      email: 'temp@test.local',
      passwordHash: await hashPassword(PASSWORD),
      role: 'solicitante',
    });
    const { body: loginBody } = await login('temp@test.local', PASSWORD);
    await temp.deleteOne();

    const { status, body } = await request('/api/auth/me', { headers: bearer(loginBody.token) });
    assert.equal(status, 401);
    assert.equal(body.message, 'User no longer exists');
  });
});

describe('requireRole', () => {
  let roleServer: Server;
  let roleUrl: string;

  before(async () => {
    const roleApp = express();
    roleApp.get('/ti-only', requireAuth, requireRole('ti'), (_req, res) => {
      res.json({ ok: true });
    });
    roleApp.use(errorHandler);
    ({ server: roleServer, url: roleUrl } = await listen(roleApp));
  });

  after(() => {
    roleServer.close();
  });

  it('allows a user with the required role', async () => {
    const { body: loginBody } = await login('ti@test.local', PASSWORD);
    const { status } = await request('/ti-only', { headers: bearer(loginBody.token) }, roleUrl);
    assert.equal(status, 200);
  });

  it('returns 403 for an authenticated user without the role', async () => {
    const { body: loginBody } = await login('req@test.local', PASSWORD);
    const { status } = await request('/ti-only', { headers: bearer(loginBody.token) }, roleUrl);
    assert.equal(status, 403);
  });

  it('returns 401 when not authenticated', async () => {
    const { status } = await request('/ti-only', {}, roleUrl);
    assert.equal(status, 401);
  });
});

describe('User model', () => {
  it('enforces a unique email', async () => {
    await assert.rejects(
      UserModel.create({
        name: 'Duplicate',
        email: 'TI@test.local',
        passwordHash: 'x',
        role: 'ti',
      }),
      (error: { code?: number }) => error.code === 11000,
    );
  });
});
