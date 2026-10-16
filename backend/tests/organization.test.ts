import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import app from '../src/app';
import { env } from '../src/config/env';
import { DepartmentModel, RoomModel } from '../src/models/organization.model';
import { UserModel, type UserRole } from '../src/models/user.model';
import { signAccessToken } from '../src/utils/jwt';

// Departments, rooms and where people work.
const TEST_DB_NAME = 'it-helpdesk-test-organization';

let server: Server;
let baseUrl: string;
type TestUser = { id: string; token: string };
type Json = { [key: string]: any };
let requester: TestUser, tech: TestUser, manager: TestUser;

async function api(method: string, path: string, user: TestUser, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: (raw ? JSON.parse(raw) : null) as Json };
}

async function createUser(name: string, role: UserRole): Promise<TestUser> {
  const user = await UserModel.create({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@org.test`, passwordHash: 'not-used', role });
  return { id: user.id, token: signAccessToken(user.id) };
}

let finance: Json, room203: Json;

before(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB_NAME });
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.syncIndexes(), DepartmentModel.syncIndexes(), RoomModel.syncIndexes()]);
  requester = await createUser('Maria Teste', 'solicitante');
  tech = await createUser('Carlos Teste', 'ti');
  manager = await createUser('Ana Teste', 'gestor');
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('departments and rooms', () => {
  it('only managers create and edit the structure; names are unique without case or accents', async () => {
    const created = await api('POST', '/organization/departments', manager, { name: 'Financeiro', code: 'fin' });
    assert.equal(created.status, 201);
    finance = created.body.department;
    assert.equal(finance.code, 'FIN');
    assert.equal((await api('POST', '/organization/departments', manager, { name: 'FINANCEIRO' })).status, 409);
    assert.equal((await api('POST', '/organization/departments', manager, { name: 'Contábil', code: 'FIN' })).status, 409, 'codes are unique too');
    assert.equal((await api('POST', '/organization/departments', tech, { name: 'RH' })).status, 403);
    assert.equal((await api('POST', '/organization/departments', requester, { name: 'RH' })).status, 403);
    assert.equal((await api('POST', '/organization/departments', manager, { name: '', extra: 1 })).status, 400);
  });

  it('a room belongs to one active department and its name is unique there', async () => {
    const created = await api('POST', '/organization/rooms', manager, { departmentId: finance.id, name: 'Sala 203', floor: '2' });
    assert.equal(created.status, 201);
    room203 = created.body.room;
    assert.equal((await api('POST', '/organization/rooms', manager, { departmentId: finance.id, name: 'sala 203' })).status, 409);
    const hr = (await api('POST', '/organization/departments', manager, { name: 'Recursos Humanos' })).body.department;
    assert.equal((await api('POST', '/organization/rooms', manager, { departmentId: hr.id, name: 'Sala 203' })).status, 201, 'same name in another department');
    assert.equal((await api('POST', '/organization/rooms', manager, { departmentId: '0123456789abcdef01234567', name: 'Sala X' })).status, 400);
    assert.equal((await api('PATCH', `/organization/rooms/${room203.id}`, manager, { departmentId: hr.id })).status, 400, 'a room never moves to another department');
  });

  it('everyone reads the active structure; deactivation hides without deleting', async () => {
    const closed = (await api('POST', '/organization/departments', manager, { name: 'Expedição' })).body.department;
    assert.equal((await api('PATCH', `/organization/departments/${closed.id}`, manager, { active: false })).status, 200);
    const asRequester = (await api('GET', '/organization?includeInactive=true', requester)).body.departments.map((d: Json) => d.name);
    assert.ok(asRequester.includes('Financeiro') && !asRequester.includes('Expedição'), 'requesters only see active entries');
    const asManager = (await api('GET', '/organization?includeInactive=true', manager)).body.departments.map((d: Json) => d.name);
    assert.ok(asManager.includes('Expedição'));
    assert.ok(await DepartmentModel.exists({ _id: closed.id }), 'kept in the database');
    assert.equal((await api('GET', '/organization', requester)).body.departments.find((d: Json) => d.name === 'Financeiro').rooms[0].name, 'Sala 203');
  });
});

describe('where people work', () => {
  it('managers set it, validating that the room belongs to the department', async () => {
    const other = (await api('GET', '/organization', manager)).body.departments.find((d: Json) => d.name === 'Recursos Humanos');
    assert.equal((await api('PATCH', `/organization/people/${requester.id}`, manager, { departmentId: other.id, roomId: room203.id })).status, 400);
    const set = await api('PATCH', `/organization/people/${requester.id}`, manager, { departmentId: finance.id, roomId: room203.id, jobTitle: 'Analista financeira' });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body.person.room, { id: room203.id, name: 'Sala 203' });
    const mine = (await api('GET', '/organization', requester)).body.myLocation;
    assert.deepEqual(mine, { department: { id: finance.id, name: 'Financeiro' }, room: { id: room203.id, name: 'Sala 203' } });
  });

  it('nobody sets their own department: requesters and IT get 403', async () => {
    assert.equal((await api('PATCH', `/organization/people/${requester.id}`, requester, { departmentId: finance.id, roomId: null })).status, 403);
    assert.equal((await api('PATCH', `/organization/people/${tech.id}`, tech, { departmentId: finance.id, roomId: null })).status, 403);
  });

  it('the team lists people with their location, without contact data; requesters cannot', async () => {
    const people = await api('GET', '/organization/people', tech);
    assert.equal(people.status, 200);
    const maria = people.body.people.find((p: Json) => p.id === requester.id);
    assert.deepEqual(Object.keys(maria).sort(), ['department', 'id', 'jobTitle', 'name', 'role', 'room']);
    assert.equal((await api('GET', '/organization/people', requester)).status, 403);
  });

  it('an inactive room is no longer a valid location', async () => {
    const spare = (await api('POST', '/organization/rooms', manager, { departmentId: finance.id, name: 'Sala 204' })).body.room;
    await api('PATCH', `/organization/rooms/${spare.id}`, manager, { active: false });
    assert.equal((await api('PATCH', `/organization/people/${tech.id}`, manager, { departmentId: finance.id, roomId: spare.id })).status, 400);
    assert.equal((await api('PATCH', `/organization/people/${tech.id}`, manager, { departmentId: null, roomId: null })).status, 200, 'clearing is allowed');
  });
});
