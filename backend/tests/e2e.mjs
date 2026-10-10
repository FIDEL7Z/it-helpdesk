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
  const secondAnalyst = await UserModel.create({ name: 'Carlos Andrade', email: 'second-ti@e2e.local', role: 'ti', passwordHash });
  const zeroAnalyst = await UserModel.create({ name: 'Zero-load analyst', email: 'zero-ti@e2e.local', role: 'ti', passwordHash });
  const other = await UserModel.create({ name: 'Other requester', email: 'other@e2e.local', role: 'solicitante', passwordHash });
  const ticket = (title, requester, status = 'aberto', assignee = null) => TicketModel.create({
    dataOrigin: 'operational', title, description: 'Problema de teste com descrição suficiente.', category: 'software', priority: 'media',
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
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const submit = () => evaluate('document.querySelector("form").requestSubmit()');
  const browserApi = async (method, path, body) => {
    if (method === 'PATCH' && body && body.expectedRevision === undefined) {
      const read = await browserApi('GET', path.replace(/\/(status|assignee)$/, ''));
      body = { ...body, expectedRevision: read.body.ticket?.revision ?? 0 };
    }
    return evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(apiUrl + path)}, {
      method: ${JSON.stringify(method)},
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('it-helpdesk:token') },
      ${body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(body))},`}
      signal: AbortSignal.timeout(10000)
    });
    return { status: response.status, body: await response.json() };
  })()`);
  };
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
    // A distinct login URL starts a fresh navigation, rather than reloading the
    // previous login history entry carrying a protected return route.
    await go(`/login?profile=${role}`);
    await waitDom(`${role} login form`, 'location.pathname === "/login" && !!document.getElementById("email")');
    await fill('email', users[role].email);
    await fill('password', password);
    await submit();
    await waitDom(`${role} login`, `document.querySelector('.user-menu__name')?.textContent === ${JSON.stringify(users[role].name)}`);
    if (role === 'gestor') {
      await waitDom('manager default landing', 'location.pathname === "/manager"');
      check(true, 'Manager normal login opens exclusive management page');
    }
    if (role === 'gestor') await go('/dashboard');
    else await evaluate('Array.from(document.querySelectorAll(".app-nav a")).find(el => el.getAttribute("href") === "/dashboard").click()');
    await waitDom(`${role} dashboard route`, 'location.pathname === "/dashboard"');
    if (role !== 'gestor') {
      check((await browserApi('GET', '/dashboard/manager')).status === 403, `${role}: manager API is forbidden`);
      await go('/manager');
      await waitDom(`${role} cannot enter manager page`, 'location.pathname === "/dashboard"');
      check(await evaluate(`!document.querySelector('.manager-page') && !document.querySelector('.app-nav a[href="/manager"]')`), `${role}: manager page and navigation are restricted`);
    }
    let expected = role === 'solicitante' ? [2, 1, 0, 1] : role === 'gestor' ? [4, 1, 1, 2] : [4, 2, 1, 1];
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

    if (role === 'ti') {
      await go(`/tickets/${own.id}`);
      await waitDom('TI assignment form', '!!document.getElementById("assignee")');
      const stale = await browserApi('PATCH', `/tickets/${own.id}`, { category: 'hardware' });
      check(stale.status === 200, 'Concurrent API action changes the revision loaded by the UI');
      await evaluate(`(() => { const select = document.getElementById('assignee'); select.value = ${JSON.stringify(secondAnalyst.id)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await evaluate('document.getElementById("assignee").closest("form").requestSubmit()');
      await waitDom('stale UI action rejected', 'document.querySelector("[role=alert]")?.textContent.includes("Os dados foram atualizados")');
      check((await browserApi('GET', `/tickets/${own.id}`)).body.ticket.assignee === null, 'Stale frontend revision cannot assign or append a successful event');
      await waitDom('conflict reload finishes', 'document.getElementById("triage-category")?.value === "hardware"');
      await evaluate(`(() => { const select = document.getElementById('assignee'); select.value = ${JSON.stringify(secondAnalyst.id)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await evaluate('document.getElementById("assignee").closest("form").requestSubmit()');
      await waitDom('TI assigned to Carlos', 'Array.from(document.querySelectorAll("dd")).some(el => el.textContent === "Carlos Andrade")');
      await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent.trim() === "Iniciar atendimento").click()');
      await waitDom('TI resolution justification input', '!!document.getElementById("status-reason")');
      check(await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent.trim() === "Marcar como resolvido").disabled'), 'Resolution by another operator requires justification in the UI');
      check((await browserApi('PATCH', `/tickets/${own.id}/status`, { status: 'resolvido' })).status === 400, 'API rejects unjustified resolution by another operator');
      await fill('status-reason', 'Realizei a correção em colaboração com Carlos.');
      await evaluate('document.getElementById("status-reason").closest("form").requestSubmit()');
      await waitDom('explicit resolver in history', 'Array.from(document.querySelectorAll(".timeline__message")).some(el => el.textContent === "Resolvido por E2E ti")');
      const resolution = (await browserApi('GET', `/tickets/${own.id}`)).body.ticket;
      check(resolution.assignee.id === secondAnalyst.id && resolution.resolvedBy.id === users.ti.id, 'Responsible Carlos and authenticated resolver TI remain distinct');
      check(resolution.history.at(-1).audit.reason.includes('Carlos') && resolution.history.at(-1).audit.assigneeAtEvent === secondAnalyst.id, 'Resolution persists structured justification and assignee at event');
      await go('/tickets');
      await waitDom('resolver column', 'Array.from(document.querySelectorAll(".ticket-table tbody tr")).some(el => el.textContent.includes("Carlos Andrade"))');
      check(await evaluate('Array.from(document.querySelectorAll("td")).some(el => el.dataset.label === "Resolvido por" && el.textContent === "E2E ti")'), 'Ticket table identifies the resolver separately');
    }

    if (role === 'gestor') {
      await go(`/tickets/${own.id}`);
      await waitDom('manager foreign detail', 'document.querySelector("h1")?.textContent === "Requester open ticket"');
      check(await evaluate('!!document.querySelector(".action-stack") && !Array.from(document.querySelectorAll("button")).some(el => el.textContent.trim() === "Editar chamado")'), 'Manager sees operational controls without foreign text editing');
      check((await browserApi('PATCH', `/tickets/${own.id}`, { title: 'Forbidden manager edit' })).status === 403, 'Manager still cannot edit foreign text');
      await go(`/tickets/${managerOwn.id}`);
      await waitDom('manager own detail', 'document.querySelector("h1")?.textContent === "Manager own open ticket"');
      await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent.trim() === "Editar chamado").click()');
      await waitDom('manager own edit form', '!!document.getElementById("edit-title")');
      check(await evaluate('!!document.querySelector(".ticket-layout__main form") && !!document.querySelector(".action-stack")'), 'Manager sees own text editing and operational controls');
      await fill('edit-title', 'Manager edited own ticket');
      await submit();
      await waitDom('manager own edit saved', 'document.querySelector("h1")?.textContent === "Manager edited own ticket"');
      const saved = await browserApi('GET', `/tickets/${managerOwn.id}`);
      check(saved.status === 200 && saved.body.ticket.title === 'Manager edited own ticket', 'Manager can edit own open ticket through the UI with real persistence');
      const assignment = await browserApi('PATCH', `/tickets/${managerOwn.id}/assignee`, { assigneeId: users.gestor.id });
      check(assignment.status === 200, 'Manager can assign and assume responsibility');
      const triaged = await browserApi('PATCH', `/tickets/${managerOwn.id}`, { priority: 'alta', reason: 'Prioridade operacional revisada pela gestão.' });
      check(triaged.status === 200 && triaged.body.ticket.history.at(-1).audit.actorId === users.gestor.id, 'Manager changes priority with authenticated audit and justification');
      const started = await browserApi('PATCH', `/tickets/${managerOwn.id}/status`, { status: 'em_andamento' });
      check(started.status === 200 && started.body.ticket.history.at(-1).audit.actorId === users.gestor.id, 'Manager starts work as authenticated actor');
      check((await browserApi('PATCH', `/tickets/${managerOwn.id}/assignee`, { assigneeId: secondAnalyst.id })).status === 400, 'Manager cannot reassign active work without reason');
      const reassigned = await browserApi('PATCH', `/tickets/${managerOwn.id}/assignee`, { assigneeId: secondAnalyst.id, reason: 'Redistribuição justificada da equipe.' });
      const assumedAgain = await browserApi('PATCH', `/tickets/${managerOwn.id}/assignee`, { assigneeId: users.gestor.id, reason: 'Gestão retoma atendimento autorizado.' });
      check(reassigned.status === 200 && assumedAgain.status === 200 && assumedAgain.body.ticket.history.at(-1).audit.actorId === users.gestor.id, 'Manager reassigns and resumes active work with structured audit');
      const completed = await browserApi('PATCH', `/tickets/${managerOwn.id}/status`, { status: 'resolvido' });
      check(completed.status === 200 && completed.body.ticket.resolvedBy.id === users.gestor.id, 'Manager resolves with explicit authenticated authorship');
      const reopened = await browserApi('PATCH', `/tickets/${managerOwn.id}/status`, { status: 'em_andamento', reason: 'Problema reapareceu no teste do segundo ciclo.' });
      check(reopened.status === 200 && reopened.body.ticket.activeCycleId === 2 && reopened.body.ticket.resolvedBy === null, 'Manager reopens into a new cycle without deleting prior resolution');
      expected = [4, 0, 2, 2];
      await go('/dashboard');
      await dashboard(expected, role);
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      check(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'Manager dashboard fits a 390px viewport');
      await command('Emulation.clearDeviceMetricsOverride');
      const demo = await ticket('Separate demonstration fixture', users.solicitante);
      await TicketModel.updateOne({ _id: demo._id }, { $set: { dataOrigin: 'demo' } });
      await go('/manager');
      await waitDom('manager analytics loaded', 'document.querySelectorAll(".manager-page .stat-card__value").length === 6');
      const report = (await browserApi('GET', '/dashboard/manager')).body.dashboard;
      check(report.current.total === 4 && report.period.created === 4, 'Manager counts exclude demonstration by default');
      check(report.period.resolutions === 2 && report.period.resolvedTickets === 2 && report.period.reopenings === 1, 'Manager resolutions survive reopen and count one event per cycle');
      check(report.team.find(row => row.id === users.ti.id).resolutions === 1 && report.team.find(row => row.id === secondAnalyst.id).resolutions === 0, 'Manager productivity uses resolver rather than current assignee');
      check(report.team.find(row => row.id === zeroAnalyst.id).assigned === 0 && await evaluate('document.getElementById("manager-team").parentElement.textContent.includes("Zero-load analyst")'), 'Zero-load analysts appear in the real manager table');
      check(report.requesters[0].created === 2 && report.requesters[0].name === users.solicitante.name, 'Requester ranking is based on persisted period creations');
      check(report.coverage.resolvedWithoutStructuredHistory === 1 && await evaluate('document.querySelector(".manager-page [role=status]")?.textContent.includes("sem evidência válida")'), 'Legacy resolution is disclosed and excluded from productivity');
      const select = (id, value) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      for (const period of ['today', 'week', 'month', 'year']) {
        await select('manager-period', period);
        await waitDom(`manager period ${period}`, `location.search.includes('period=${period}') && document.querySelectorAll('.manager-page .stat-card__value').length === 6`);
        const filtered = (await browserApi('GET', `/dashboard/manager?period=${period}`)).body.dashboard;
        check(filtered.filters.period === period && filtered.period.created === 4, `Manager ${period} filter reaches backend`);
      }
      await select('manager-dataOrigin', 'demo');
      await waitDom('demonstration indicators', 'document.querySelector(".manager-source--demo") && document.querySelector(".manager-page .stat-card__value")?.textContent === "1"');
      check((await browserApi('GET', '/dashboard/manager?dataOrigin=demo')).body.dashboard.current.total === 1, 'Demonstration indicators remain separate and visibly identified');
      await select('manager-dataOrigin', 'operational');
      await waitDom('operational indicators restored', 'document.querySelector(".manager-page .stat-card__value")?.textContent === "4"');
      await evaluate('document.querySelector(".manager-filters__advanced").open = true');
      await select('manager-analystId', secondAnalyst.id);
      await waitDom('analyst filter', `location.search.includes('analystId=${secondAnalyst.id}') && document.querySelectorAll('.manager-page .stat-card__value').length === 6`);
      check((await browserApi('GET', `/dashboard/manager?analystId=${secondAnalyst.id}`)).body.dashboard.period.resolutions === 0, 'Analyst filter does not credit assigned ticket resolution to Carlos');
      await evaluate('Array.from(document.querySelectorAll(".manager-table a")).find(el => el.textContent === "Ver chamados").click()');
      await waitDom('analyst operational queue', `location.pathname === '/tickets' && location.search.includes('assigneeId=${secondAnalyst.id}') && document.querySelectorAll('.ticket-table tbody tr').length === 1`);
      const queueUrl = await evaluate('location.pathname + location.search');
      await evaluate('document.querySelector(".ticket-table__title a").click()');
      await waitDom('queue detail', '!!document.querySelector(".timeline")');
      await evaluate('document.querySelector(".back-link").click()');
      await waitDom('filtered queue restored', `location.pathname + location.search === ${JSON.stringify(queueUrl)} && !!document.querySelector('.ticket-table tbody tr')`);
      check(true, 'Manager drills into analyst queue and returns from history with filters preserved');
      await evaluate(`document.querySelector('.app-nav a[href="/manager"]').click()`);
      await waitDom('manager navigation from operation', 'location.pathname === "/manager" && document.querySelectorAll(".manager-page .stat-card__value").length === 6');
      check(true, 'Manager navigation separates supervision and operation');
      const output = resolve(root, 'backend/e2e-results');
      await mkdir(output, { recursive: true });
      await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await delay(200); // Let palette transitions settle before visual capture.
      const contrast = () => evaluate(`(() => {
        const rgb = value => value.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 });
        const luminance = value => { const [r,g,b] = rgb(value); return .2126*r + .7152*g + .0722*b; };
        return Array.from(document.querySelectorAll('.button--primary, .button--secondary')).every(el => { const s = getComputedStyle(el); const a = luminance(s.color), b = luminance(s.backgroundColor); return (Math.max(a,b) + .05) / (Math.min(a,b) + .05) >= 4.5; });
      })()`);
      check(await contrast(), 'Light theme action buttons meet 4.5:1 text contrast');
      await writeFile(join(output, 'manager-desktop-light.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      await evaluate('document.getElementById("manager-team").scrollIntoView({ block: "start" })');
      await writeFile(join(output, 'manager-team-desktop.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      await evaluate('window.scrollTo(0,0)');
      check(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'Manager dashboard fits desktop without page overflow');
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      check(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'Exclusive manager dashboard fits 390px; tables scroll inside cards');
      await writeFile(join(output, 'manager-mobile-light.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await delay(200);
      check(await contrast(), 'Dark theme action buttons meet 4.5:1 text contrast');
      await writeFile(join(output, 'manager-mobile-dark.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      check(await evaluate('getComputedStyle(document.documentElement).colorScheme === "dark"'), 'Manager dark theme uses the shared system palette');
      await command('Emulation.clearDeviceMetricsOverride');
      await command('Emulation.setEmulatedMedia', { features: [] });
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
