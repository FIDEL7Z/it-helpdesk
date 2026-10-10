// Minimal browser regression using Node's WebSocket and the installed Edge/Chrome.
// No browser library, demo credentials, development server or development data required.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import mongoose from 'mongoose';

const root = fileURLToPath(new URL('../../', import.meta.url));
const database = `it-helpdesk-test-e2e-${randomUUID()}`;
const password = randomUUID();
const diagnostics = [];
const timings = [];
let checks = 0;
let apiServer, vite, browserProcess, profile, socket, evaluate, command;
let databaseConnected = false;
let browserFailure;

function check(condition, label) {
  assert.ok(condition, label);
  checks++;
  console.log(`PASS ${label}`);
}

async function waitFor(label, action, timeout = 15000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    if (browserFailure) throw browserFailure;
    const value = await action();
    if (value) {
      timings.push({ label, ms: Math.round(performance.now() - started) });
      return value;
    }
    await delay(100);
  }
  throw new Error(`Timed out after ${timeout} ms: ${label}`);
}

async function findBrowser() {
  const candidates = process.env.E2E_BROWSER_PATH
    ? [process.env.E2E_BROWSER_PATH]
    : [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next executable. */ }
  }
  throw new Error('Edge/Chrome not found. Set E2E_BROWSER_PATH to its executable.');
}

function connectCdp(url) {
  socket = new WebSocket(url);
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method === 'Network.responseReceived') {
      const { response, type } = message.params;
      if (['Document', 'Fetch', 'XHR'].includes(type)) {
        // Only URLs/statuses: never log request headers, tokens or response bodies.
        diagnostics.push({ event: 'response', url: response.url, status: response.status });
      }
    } else if (message.method === 'Network.loadingFailed') {
      diagnostics.push({ event: 'network-failure', ...message.params });
    } else if (message.method === 'Runtime.exceptionThrown') {
      diagnostics.push({ event: 'browser-exception', text: message.params.exceptionDetails.text });
    }
  });
  const rejectPending = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Browser debugging connection closed'));
    }
    pending.clear();
  };
  socket.addEventListener('close', rejectPending);
  socket.addEventListener('error', rejectPending);
  return async function command(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 15000);
      pending.set(id, { resolve: resolveCommand, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
}

async function run() {
  const executable = await findBrowser();
  // Set only this test process's signing secret; dotenv still supplies the MongoDB URI.
  process.env.JWT_SECRET = randomUUID();
  const [{ default: app }, { env }, { UserModel }, { TicketModel }, { hashPassword }, { signAccessToken }] =
    await Promise.all([
      import('../src/app.ts'), import('../src/config/env.ts'),
      import('../src/models/user.model.ts'), import('../src/models/ticket.model.ts'),
      import('../src/utils/password.ts'), import('../src/utils/jwt.ts'),
    ]);
  await mongoose.connect(env.MONGODB_URI, { dbName: database, serverSelectionTimeoutMS: 10000 });
  databaseConnected = true;
  await Promise.all([UserModel.syncIndexes(), TicketModel.syncIndexes()]);
  const users = {};
  const passwordHash = await hashPassword(password);
  for (const role of ['solicitante', 'ti', 'gestor']) {
    users[role] = await UserModel.create({ name: `E2E ${role}`, email: `${role}@e2e.local`, role, passwordHash });
  }
  const other = await UserModel.create({ name: 'Other requester', email: 'other@e2e.local', role: 'solicitante', passwordHash });
  const ticket = (title, requester, status = 'aberto', assignee = null) => TicketModel.create({
    title, description: 'Problema de teste com descrição suficiente.', category: 'software', priority: 'media',
    requester: requester._id, status, assignee: assignee?._id ?? null,
    history: [{ type: 'created', author: requester._id, message: 'Chamado aberto' }],
  });
  const own = await ticket('Requester open ticket', users.solicitante);
  await ticket('Requester resolved ticket', users.solicitante, 'resolvido', users.ti);
  const foreign = await ticket('Other requester private ticket', other, 'em_andamento', users.ti);
  const managerOwn = await ticket('Manager own open ticket', users.gestor);

  apiServer = app.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  const apiUrl = `http://127.0.0.1:${apiServer.address().port}/api`;
  process.env.VITE_API_URL = apiUrl;
  const { createServer } = await import('../../frontend/node_modules/vite/dist/node/index.js');
  vite = await createServer({ root: join(root, 'frontend'), server: { host: '127.0.0.1', port: 0, open: false }, logLevel: 'error' });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  env.CORS_ORIGIN.push(origin);

  profile = await mkdtemp(join(tmpdir(), 'it-helpdesk-e2e-'));
  browserProcess = spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  browserProcess.once('error', (error) => { browserFailure = error; });
  browserProcess.once('exit', (code) => { browserFailure = new Error(`Browser exited: ${code}`); });
  const portFile = await waitFor('browser startup', async () => {
    try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; }
  });
  const debugUrl = `http://127.0.0.1:${portFile.split('\n')[0]}`;
  const pages = await (await fetch(`${debugUrl}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
  const page = pages.find((item) => item.type === 'page');
  assert.ok(page, 'Browser must expose a page');
  command = connectCdp(page.webSocketDebuggerUrl);
  await once(socket, 'open');
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Network.enable');
  evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const waitDom = (label, expression) => waitFor(label, () => evaluate(expression));
  const waitDocument = (label, previousOrigin) => waitDom(label,
    `performance.timeOrigin !== ${previousOrigin} && document.readyState !== 'loading'`);
  const go = async (path) => {
    const previousOrigin = await evaluate('performance.timeOrigin');
    await command('Page.navigate', { url: `${origin}${path}` });
    await waitDocument(`document navigation: ${path}`, previousOrigin);
  };
  const fill = (id, value) => evaluate(`(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const submit = () => evaluate('document.querySelector("form").requestSubmit()');
  const browserApi = (method, path, body) => evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(apiUrl + path)}, {
      method: ${JSON.stringify(method)},
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('it-helpdesk:token') },
      ${body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(body))},`}
      signal: AbortSignal.timeout(10000)
    });
    return { status: response.status, body: await response.json() };
  })()`);
  const dashboard = async (expected, role) => {
    await waitDom(`${role} dashboard data`, 'document.querySelectorAll(".stat-card__value").length >= 4');
    const values = await evaluate('Array.from(document.querySelectorAll(".stat-card__value")).slice(0,4).map(el => Number(el.textContent))');
    check(JSON.stringify(values) === JSON.stringify(expected), `${role}: dashboard counts match persisted fixtures`);
    const workload = await evaluate('document.querySelectorAll(".stats--workload .stat-card").length');
    check(workload === (role === 'ti' ? 2 : 0), `${role}: personal workload visibility`);
  };

  await go('/dashboard');
  await waitDom('unauthenticated redirect', 'location.pathname === "/login" && !!document.getElementById("email")');
  check(true, 'Protected route redirects to login');
  await fill('email', users.solicitante.email);
  await fill('password', 'incorrect-password');
  await submit();
  await waitDom('invalid login feedback', 'document.querySelector("[role=alert]")?.textContent.includes("E-mail ou senha incorretos")');
  check(await evaluate('localStorage.getItem("it-helpdesk:token") === null'), 'Wrong password does not create a session');

  for (const role of ['solicitante', 'ti', 'gestor']) {
    // Login may return to the previous protected route; verify the session before navigating.
    await go('/login');
    await waitDom(`${role} login form`, 'location.pathname === "/login" && !!document.getElementById("email")');
    await fill('email', users[role].email);
    await fill('password', password);
    await submit();
    await waitDom(`${role} login`, `document.querySelector('.user-menu__name')?.textContent === ${JSON.stringify(users[role].name)}`);
    await evaluate('Array.from(document.querySelectorAll(".app-nav a")).find(el => el.getAttribute("href") === "/dashboard").click()');
    await waitDom(`${role} dashboard route`, 'location.pathname === "/dashboard"');
    const expected = role === 'solicitante' ? [2, 1, 0, 1] : [4, 2, 1, 1];
    await dashboard(expected, role);
    for (let reload = 1; reload <= 3; reload++) {
      const previousOrigin = await evaluate('performance.timeOrigin');
      await command('Page.reload', { ignoreCache: true });
      await waitDocument(`${role} reload ${reload}: new document`, previousOrigin);
      await dashboard(expected, role);
    }
    const listing = await browserApi('GET', '/tickets');
    check(listing.status === 200 && listing.body.pagination.total === expected[0], `${role}: API list matches dashboard scope`);
    const detail = await browserApi('GET', `/tickets/${foreign.id}`);
    check(detail.status === (role === 'solicitante' ? 404 : 200), `${role}: foreign ticket access`);
    await go('/tickets');
    await waitDom(`${role} ticket table`, '!!document.querySelector(".ticket-table tbody tr")');
    const titles = await evaluate('Array.from(document.querySelectorAll(".ticket-table__title a")).map(el => el.textContent)');
    check(titles.length === expected[0] && titles.includes('Other requester private ticket') === (role !== 'solicitante'), `${role}: visible ticket list isolation`);

    if (role === 'gestor') {
      await go(`/tickets/${own.id}`);
      await waitDom('manager foreign detail', 'document.querySelector("h1")?.textContent === "Requester open ticket"');
      check(await evaluate('!document.querySelector(".action-stack") && !Array.from(document.querySelectorAll("button")).some(el => el.textContent.trim() === "Editar chamado")'), 'Manager cannot see operation or foreign text editing controls');
      for (const [path, body] of [
        [`/${own.id}/status`, { status: 'em_andamento' }],
        [`/${own.id}/assignee`, { assigneeId: users.ti.id }],
        [`/${own.id}`, { priority: 'alta' }],
        [`/${own.id}`, { category: 'hardware' }],
        [`/${own.id}`, { title: 'Forbidden manager edit' }],
      ]) {
        check((await browserApi('PATCH', `/tickets${path}`, body)).status === 403, `Manager API rejects ${Object.keys(body)[0]} change`);
      }
      await go(`/tickets/${managerOwn.id}`);
      await waitDom('manager own detail', 'document.querySelector("h1")?.textContent === "Manager own open ticket"');
      await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent.trim() === "Editar chamado").click()');
      await waitDom('manager own edit form', '!!document.getElementById("edit-title")');
      check(await evaluate('!!document.querySelector(".ticket-layout__main form") && !document.querySelector(".action-stack")'), 'Manager sees own text editing controls without operation controls');
      await fill('edit-title', 'Manager edited own ticket');
      await submit();
      await waitDom('manager own edit saved', 'document.querySelector("h1")?.textContent === "Manager edited own ticket"');
      const saved = await browserApi('GET', `/tickets/${managerOwn.id}`);
      check(saved.status === 200 && saved.body.ticket.title === 'Manager edited own ticket', 'Manager can edit own open ticket through the UI with real persistence');
      const assignment = await fetch(`${apiUrl}/tickets/${own.id}/assignee`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signAccessToken(users.ti.id)}` },
        body: JSON.stringify({ assigneeId: users.gestor.id }), signal: AbortSignal.timeout(10000),
      });
      check(assignment.status === 400, 'IT cannot assign a manager');
      await assignment.text();
      await go('/dashboard');
      await dashboard(expected, role);
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      check(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'Manager dashboard fits a 390px viewport');
      await command('Emulation.clearDeviceMetricsOverride');
    }
    await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent === "Sair").click()');
    await waitDom(`${role} logout`, 'location.pathname === "/login" && !!document.getElementById("email")');
    check(await evaluate('localStorage.getItem("it-helpdesk:token") === null'), `${role}: logout clears session`);
  }
  check(!diagnostics.some((item) => item.event === 'browser-exception'), 'No uncaught browser exceptions');
  console.log(`\n${checks} E2E checks passed. Dashboard: initial load + 3 reloads per role.`);
  console.log(`Longest observed wait: ${Math.max(...timings.map((item) => item.ms))} ms.`);
}

try {
  await run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  const output = resolve(root, 'backend/e2e-results');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'diagnostics.json'), JSON.stringify({ error: error.message, checks, timings, network: diagnostics }, null, 2));
  if (command && socket?.readyState === WebSocket.OPEN) {
    try {
      const screenshot = await command('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(output, 'failure.png'), Buffer.from(screenshot.data, 'base64'));
    } catch (captureError) { console.error(`Screenshot unavailable: ${captureError.message}`); }
  }
  console.error('Diagnostics: backend/e2e-results/diagnostics.json (and failure.png when available).');
} finally {
  socket?.close();
  if (browserProcess && browserProcess.exitCode === null && !browserProcess.killed) {
    const exited = once(browserProcess, 'exit').catch(() => {});
    browserProcess.kill();
    await Promise.race([exited, delay(3000)]);
  }
  await vite?.close();
  if (apiServer) await new Promise((done) => { apiServer.close(done); apiServer.closeAllConnections(); });
  // This is the unique database created by this run; never drop the configured development DB.
  if (databaseConnected && mongoose.connection.name === database && database.startsWith('it-helpdesk-test-e2e-')) {
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
  if (profile) {
    assert.equal(dirname(resolve(profile)), resolve(tmpdir()), 'Profile cleanup must stay in the temporary directory');
    assert.ok(basename(profile).startsWith('it-helpdesk-e2e-'), 'Only remove the generated test profile');
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
