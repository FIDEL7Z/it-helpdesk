import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { LOGIN_RATE_LIMIT, resetLoginRateLimit } from '../src/middlewares/rate-limit.middleware';
import { TicketModel } from '../src/models/ticket.model';
import { UserModel } from '../src/models/user.model';
import { signAccessToken } from '../src/utils/jwt';
import { hashPassword } from '../src/utils/password';

// Own database and own process (node:test runs files in parallel), so the in-memory
// rate limit counters of this file are not shared with other test files.
const TEST_DB_NAME = 'it-helpdesk-test-security';
const EMAIL = 'tech@test.local';
const PASSWORD = 'Test@12345';

let server: Server;
let baseUrl: string;
let token: string;

function login(password: string) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password }),
  });
}

function authenticatedGet(path: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes()]);

  const user = await UserModel.create({
    name: 'Tech',
    email: EMAIL,
    passwordHash: await hashPassword(PASSWORD),
    role: 'ti',
  });
  token = signAccessToken(user.id);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(async () => {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('Express hardening', () => {
  it('does not send the X-Powered-By header', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  it('rejects JSON bodies over the 100kb limit with 413', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: 'x'.repeat(120 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { message: 'Request body too large' });
  });
});

describe('POST /api/auth/login rate limit', () => {
  beforeEach(async () => {
    await resetLoginRateLimit();
  });

  it(`allows ${LOGIN_RATE_LIMIT.limit} attempts, then answers 429 with standard headers`, async () => {
    for (let attempt = 1; attempt <= LOGIN_RATE_LIMIT.limit; attempt += 1) {
      const response = await login('wrong-password');
      assert.equal(response.status, 401, `attempt ${attempt}`);
    }

    const blocked = await login('wrong-password');
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { message: 'Too many login attempts. Try again later' });
    assert.ok(blocked.headers.get('retry-after'), 'Retry-After header');
    assert.match(blocked.headers.get('ratelimit') ?? '', /r=0/);
  });

  it('successful logins also count, and the right password is blocked after the limit', async () => {
    for (let attempt = 1; attempt <= LOGIN_RATE_LIMIT.limit; attempt += 1) {
      assert.equal((await login(PASSWORD)).status, 200, `attempt ${attempt}`);
    }
    assert.equal((await login(PASSWORD)).status, 429);
  });

  it('does not affect other endpoints while the login is blocked', async () => {
    for (let attempt = 0; attempt <= LOGIN_RATE_LIMIT.limit; attempt += 1) await login('wrong-password');
    assert.equal((await login(PASSWORD)).status, 429);

    const responses = await Promise.all([
      fetch(`${baseUrl}/api/health`),
      authenticatedGet('/auth/me'),
      authenticatedGet('/tickets'),
      authenticatedGet('/dashboard/summary'),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200, response.url);
      assert.equal(response.headers.get('ratelimit'), null, `no rate limit headers on ${response.url}`);
    }
  });

  it('counters can be cleared (used by the test suite)', async () => {
    for (let attempt = 0; attempt <= LOGIN_RATE_LIMIT.limit; attempt += 1) await login('wrong-password');
    assert.equal((await login(PASSWORD)).status, 429);

    await resetLoginRateLimit();
    assert.equal((await login(PASSWORD)).status, 200);
  });
});
