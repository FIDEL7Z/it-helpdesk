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
let keepVisible;
let visibilityRecoveries = 0;

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
  process.env.DEMO_MODE = 'true';
  process.env.VITE_DEMO_MODE = 'true';
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
    // Keep rendering when Windows reports the window as occluded (locked or sleeping screen);
    // otherwise frames, requestAnimationFrame and captures can stop mid-run.
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
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
  // Windows can mark the headless page hidden (seen with a locked or sleeping screen); a hidden page
  // stops rendering and throttles timers, which looks like a slow or frozen app. That is the
  // environment, not the product: keep the page in front and report every recovery.
  keepVisible = setInterval(() => {
    command('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true })
      .then((result) => {
        if (result.result.value === 'visible') return;
        visibilityRecoveries += 1;
        console.log(`RECOVER page was ${result.result.value}; bringing it to the front`);
        return command('Page.bringToFront');
      })
      .catch(() => {});
  }, 500);
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
  // Evidence images only (assertions come before them). On Windows, headless Edge sometimes marks the
  // page as hidden after a viewport change (seen with a locked or sleeping screen) and stops rendering, so
  // a capture never answers. The page is brought back to the front first; every recovery is printed and
  // three failed attempts still fail the run.
  const ensureVisible = async (file) => {
    const state = await evaluate('document.visibilityState');
    if (state === 'visible') return;
    console.log(`RECOVER page was ${state} before ${basename(file)}; bringing it to the front`);
    diagnostics.push({ event: 'page-hidden-before-screenshot', file: basename(file) });
    await command('Page.bringToFront');
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  };
  const snap = async (file) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await ensureVisible(file);
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        const { data } = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(file, Buffer.from(data, 'base64'));
        return;
      } catch (error) {
        if (attempt >= 3 || !String(error.message).includes('timed out')) throw error;
        console.log(`RETRY screenshot ${basename(file)} after: ${error.message}`);
        diagnostics.push({ event: 'screenshot-retry', file: basename(file), attempt });
        await command('Page.bringToFront').catch(() => {});
      }
    }
  };
  const dashboard = async (expected, role) => {
    await waitDom(`${role} dashboard data`, 'document.querySelectorAll(".stat-card__value").length >= 4');
    const values = await evaluate('Array.from(document.querySelectorAll(".stat-card__value")).slice(0,4).map(el => Number(el.textContent))');
    check(JSON.stringify(values) === JSON.stringify(expected), `${role}: dashboard counts match persisted fixtures`);
    // The personal queue ("Meus atendimentos") is for people who can be assigned: TI and managers.
    const personalQueue = await evaluate('document.querySelectorAll(".my-queue").length');
    check(personalQueue === (role === 'solicitante' ? 0 : 1), `${role}: personal queue visibility`);
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
      check(await evaluate(`document.querySelectorAll('.pie-chart svg').length >= 1 && document.querySelectorAll('.line-chart .recharts-area').length === 2 && document.querySelector('[data-chart=hours]').dataset.observations === '24'`), 'Manager renders shadcn-style area and priority charts with all 24 hours');
      check(await evaluate(`Array.from(document.querySelectorAll('.pie-chart .chart-legend li')).every(el => el.textContent.includes('%')) && !Array.from(document.querySelectorAll('.pie-chart path, .line-chart polyline')).some(el => /NaN|Infinity/.test(el.getAttribute('d') ?? el.getAttribute('points'))) `), 'Charts expose percentages and contain valid finite coordinates');
      check(report.current.total === 4 && report.period.created === 4, 'Manager counts exclude demonstration by default');
      check(report.period.resolutions === 2 && report.period.resolvedTickets === 2 && report.period.reopenings === 1, 'Manager resolutions survive reopen and count one event per cycle');
      check(report.team.find(row => row.id === users.ti.id).resolutions === 1 && report.team.find(row => row.id === secondAnalyst.id).resolutions === 0, 'Manager productivity uses resolver rather than current assignee');
      check(report.team.find(row => row.id === zeroAnalyst.id).assigned === 0 && await evaluate('document.getElementById("manager-team").parentElement.textContent.includes("Zero-load analyst")'), 'Zero-load analysts appear in the real manager table');
      check(report.requesters[0].created === 2 && report.requesters[0].name === users.solicitante.name, 'Requester ranking is based on persisted period creations');
      check(report.coverage.resolvedWithoutStructuredHistory === 1 && await evaluate(`Array.from(document.querySelectorAll('.manager-help')).some(el => el.textContent.includes('sem autoria comprovada'))`), 'Legacy resolution is disclosed and excluded from productivity');
      const select = (id, value) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      for (const period of ['today', 'week', 'month', 'year']) {
        await select('manager-period', period);
        await waitDom(`manager period ${period}`, `location.search.includes('period=${period}') && document.querySelectorAll('.manager-page .stat-card__value').length === 6`);
        const filtered = (await browserApi('GET', `/dashboard/manager?period=${period}`)).body.dashboard;
        check(filtered.filters.period === period && filtered.period.created === 4, `Manager ${period} filter reaches backend`);
      }
      await select('manager-dataOrigin', 'demo');
      await waitDom('demonstration indicators', 'document.querySelector(".manager-source--demo") && Array.from(document.querySelectorAll(".manager-page .stat-card")).find(el => el.querySelector(".stat-card__label")?.textContent === "Criados no período")?.querySelector(".stat-card__value")?.textContent === "1"');
      check((await browserApi('GET', '/dashboard/manager?dataOrigin=demo')).body.dashboard.current.total === 1, 'Demonstration indicators remain separate and visibly identified');
      await select('manager-dataOrigin', 'operational');
      await waitDom('operational indicators restored', 'Array.from(document.querySelectorAll(".manager-page .stat-card")).find(el => el.querySelector(".stat-card__label")?.textContent === "Criados no período")?.querySelector(".stat-card__value")?.textContent === "4"');
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
      // Rich demonstration fixtures use the same valid audit schema, in the temporary DB only.
      const { demoTickets, insertDemoTickets } = await import('../src/services/manager-demo.ts');
      check((await insertDemoTickets(demoTickets([users.solicitante, other, users.ti, secondAnalyst, users.gestor]))).created === 24, 'Structured demonstration seed inserts 24 isolated new fixtures');
      check((await insertDemoTickets(demoTickets([users.solicitante, other, users.ti, secondAnalyst, users.gestor]))).skipped === 24, 'Second seed run preserves all fixtures without duplicates');
      const oldDate = new Date(Date.now() - 10 * 86400000);
      await TicketModel.create({ dataOrigin: 'demo', title: '[DEMO] Aging and inactivity fixture', description: 'Explicitly fictitious isolated E2E fixture for alerts.', category: 'hardware', priority: 'alta', status: 'em_andamento', requester: other._id, assignee: secondAnalyst._id, createdAt: oldDate, updatedAt: new Date(), revision: 1, activeCycleId: 1, history: [{ type: 'assigned', author: users.gestor._id, at: oldDate, message: 'Fictitious assignment', audit: { schemaVersion: 2, eventId: randomUUID(), operationId: randomUUID(), actorId: users.gestor._id, actorSnapshot: { name: users.gestor.name, role: 'gestor' }, eventType: 'assigned', occurredAt: oldDate, revision: 1, eventIndex: 0, cycleId: 1, from: { assignee: null }, to: { assignee: secondAnalyst._id }, assigneeAtEvent: secondAnalyst._id, dataOrigin: 'demo' } }] });
      await select('manager-dataOrigin', 'demo');
      await waitDom('rich demonstration dashboard', 'document.querySelector(".manager-source--demo") && document.querySelectorAll(".alert-card").length === 3 && Array.from(document.querySelectorAll(".manager-page .stat-card")).find(el => el.querySelector(".stat-card__label")?.textContent === "Criados no período")?.querySelector(".stat-card__value")?.textContent !== "4"');
      const demoReport = (await browserApi('GET', '/dashboard/manager?dataOrigin=demo')).body.dashboard;
      check(demoReport.current.total === 26 && demoReport.period.resolutions === 14 && demoReport.period.reopenings === 4, 'Demo aggregates reflect actual structured cycles and remain separate from four operational tickets');
      for (const attention of ['high_unassigned', 'oldest', 'inactive']) {
        const href = await evaluate(`Array.from(document.querySelectorAll('.alert-card')).find(el => el.href.includes('attention=${attention}')).getAttribute('href')`);
        const result = await browserApi('GET', href);
        const count = attention === 'high_unassigned' ? demoReport.alerts.highUnassigned : attention === 'oldest' ? demoReport.alerts.oldPending : demoReport.alerts.inactive;
        check(result.status === 200 && result.body.pagination.total === count && count > 0, `Actionable ${attention} alert matches the authorized queue count`);
      }
      await evaluate(`Array.from(document.querySelectorAll('.alert-card')).find(el => el.href.includes('attention=inactive')).click()`);
      await waitDom('inactive queue', 'location.pathname === "/tickets" && location.search.includes("attention=inactive") && !!document.querySelector(".ticket-table tbody tr")');
      check(await evaluate('document.querySelector(".ticket-table tbody").textContent.includes("Aging and inactivity fixture")'), 'Inactivity alert loads the real queue using structured activity despite recent updatedAt');
      await evaluate('document.querySelector(".ticket-table__title a").click()');
      await waitDom('inactive history', '!!document.querySelector(".timeline")');
      await evaluate('document.querySelector(".back-link").click()');
      await waitDom('inactive queue restored', 'location.search.includes("attention=inactive") && !!document.querySelector(".ticket-table tbody tr")');
      check(true, 'Activity and origin filters survive list-detail-return navigation');
      await go('/manager?dataOrigin=demo');
      await waitDom('demo restored for visual review', '!!document.querySelector(".manager-source--demo") && document.querySelectorAll(".manager-page .stat-card__value").length === 6');
      // Controlled browser-only fetch failures exercise states without stopping any service.
      await evaluate(`window.__e2eRealFetch = window.fetch; window.fetch = (input, options) => String(input).includes('/api/tickets?') ? new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify({ message: 'Controlled E2E queue failure' }), { status: 503, headers: { 'Content-Type': 'application/json' } })), 700)) : window.__e2eRealFetch(input, options)`);
      await evaluate(`document.querySelector('.app-nav a[href="/tickets"]').click()`);
      await waitDom('queue loading state', 'document.querySelector("[role=status]")?.textContent.includes("Carregando chamados")');
      check(true, 'Queue exposes accessible loading state');
      await waitDom('queue error state', 'document.querySelector("[role=alert]")?.textContent.includes("erro inesperado")');
      check(true, 'Queue exposes error and recovery action');
      await evaluate(`window.fetch = window.__e2eRealFetch; delete window.__e2eRealFetch; Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Tentar novamente').click()`);
      await waitDom('queue recovery', '!!document.querySelector(".ticket-table tbody tr")');
      check(true, 'Queue retry recovers real persisted tickets');
      // Origin policy: the queue opens on operational data; other origins only when chosen, and labelled.
      check(await evaluate('!document.querySelector(".ticket-table tbody").textContent.includes("Aging and inactivity fixture") && !document.querySelector(".ticket-table .origin-tag") && !document.querySelector(".origin-notice") && document.getElementById("list-origin").value === "operational"'), 'The queue opens on operational data, without fictitious rows');
      await select('list-origin', 'all');
      await waitDom('all origins chosen', 'location.search.includes("dataOrigin=all") && !!document.querySelector(".origin-notice")');
      await fill('ticket-search', 'Aging and inactivity fixture');
      await evaluate('document.querySelector("form[role=search]").requestSubmit()');
      await waitDom('all origins labelled', 'Array.from(document.querySelectorAll(".ticket-table tbody tr")).some(row => row.textContent.includes("Aging and inactivity fixture") && row.querySelector(".origin-tag--demo")?.textContent === "Demonstração")');
      check(await evaluate('document.querySelector(".origin-notice")?.textContent.includes("todas as origens")'), 'Choosing all origins labels each demonstration row and keeps a notice on screen');
      await go('/tickets');
      await waitDom('back to operational', '!!document.querySelector(".ticket-table tbody tr") && !document.querySelector(".origin-notice")');
      await fill('ticket-search', 'Requester open ticket');
      await evaluate('document.querySelector("form[role=search]").requestSubmit()');
      await waitDom('literal queue search', 'location.search.includes("search=") && document.querySelectorAll(".ticket-table tbody tr").length === 1');
      check(await evaluate('document.querySelector(".ticket-table tbody").textContent.includes("Requester open ticket")'), 'Search reaches the API and filters actual queue rows');
      await fill('ticket-search', 'No matching fictitious ticket 987654321');
      await evaluate('document.querySelector("form[role=search]").requestSubmit()');
      await waitDom('queue empty state', '!document.querySelector(".ticket-table tbody tr") && document.querySelector(".card--empty")?.textContent.includes("Nenhum")');
      check(true, 'Queue shows understandable empty search results');
      await go('/tickets?dataOrigin=demo');
      await waitDom('demo queue for mobile', '!!document.querySelector(".ticket-table tbody tr")');
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      check(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth && Array.from(document.querySelectorAll('select')).every(el => !!document.querySelector('label[for="' + el.id + '"]'))`), 'Real queue fits mobile and associates every selector with its label');
      await snap(resolve(root, 'backend/e2e-results/tickets-mobile.png'));
      await command('Emulation.clearDeviceMetricsOverride');
      await evaluate(`window.__e2eRealFetch = window.fetch; window.fetch = (input, options) => String(input).includes('/api/dashboard/manager?') ? new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify({ message: 'Controlled E2E manager failure' }), { status: 503, headers: { 'Content-Type': 'application/json' } })), 700)) : window.__e2eRealFetch(input, options)`);
      await evaluate(`document.querySelector('.app-nav a[href="/manager"]').click()`);
      await waitDom('manager loading state', 'document.querySelector(".manager-page [role=status]")?.textContent.includes("Carregando")');
      check(true, 'Manager exposes accessible loading state');
      await waitDom('manager error state', 'document.querySelector(".manager-page [role=alert]")?.textContent.includes("erro inesperado")');
      check(true, 'Manager exposes error and recovery action');
      await evaluate(`window.fetch = window.__e2eRealFetch; delete window.__e2eRealFetch; Array.from(document.querySelectorAll('button')).find(el => el.textContent === 'Tentar novamente').click()`);
      await waitDom('manager recovery', 'document.querySelectorAll(".manager-page .stat-card__value").length === 6');
      check(true, 'Manager retry recovers actual analytics');
      await go('/manager?dataOrigin=demo');
      await waitDom('rich dashboard for screenshots', '!!document.querySelector(".manager-source--demo") && document.querySelectorAll(".manager-page .stat-card__value").length === 6');
      const output = resolve(root, 'backend/e2e-results');
      await mkdir(output, { recursive: true });
      await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      // The system preference is dark here on purpose: the app must still start in the light theme.
      await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await delay(200); // Let palette transitions settle before visual capture.
      check(await evaluate('getComputedStyle(document.documentElement).colorScheme === "light" && !document.documentElement.dataset.theme && document.querySelector(".theme-toggle")?.getAttribute("aria-pressed") === "false"'), 'Light theme is the default, even when the system prefers dark');
      const contrast = () => evaluate(`(() => {
        const rgb = value => value.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 });
        const luminance = value => { const [r,g,b] = rgb(value); return .2126*r + .7152*g + .0722*b; };
        return Array.from(document.querySelectorAll('.button--primary, .button--secondary')).every(el => { const s = getComputedStyle(el); const a = luminance(s.color), b = luminance(s.backgroundColor); return (Math.max(a,b) + .05) / (Math.min(a,b) + .05) >= 4.5; });
      })()`);
      check(await contrast(), 'Light theme action buttons meet 4.5:1 text contrast');
      await snap(join(output, 'manager-desktop-light.png'));
      await evaluate('document.getElementById("manager-team").scrollIntoView({ block: "start" })');
      await snap(join(output, 'manager-team-desktop.png'));
      await evaluate('document.getElementById("manager-trends").scrollIntoView({ block: "start" })');
      await waitDom('populated area chart for visual review', 'document.querySelectorAll(".line-chart .recharts-area-curve").length === 2');
      check(await evaluate('Array.from(document.querySelectorAll(".chart-container .recharts-surface")).every(el => el.getBoundingClientRect().width > 100 && el.getBoundingClientRect().height > 100) && Array.from(document.querySelectorAll(".line-chart .recharts-area-curve")).every(el => el.getAttribute("d")?.length > 20)'), 'Rich area chart renders actual paths after navigation and resizing');
      await evaluate('(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()');
      await writeFile(join(output, 'manager-chart-diagnostics.json'), JSON.stringify(await evaluate('Array.from(document.querySelectorAll(".chart-container")).map(el => ({ label: el.getAttribute("aria-label"), width: el.clientWidth, height: el.clientHeight, svgs: el.querySelectorAll("svg").length, paths: el.querySelectorAll("path").length }))'), null, 2));
      await snap(join(output, 'manager-lines-desktop.png'));
      await evaluate('window.scrollTo(0,0)');
      check(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'Manager dashboard fits desktop without page overflow');
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await waitDom('manager charts resized to mobile', 'document.documentElement.scrollWidth <= document.documentElement.clientWidth');
      check(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'Exclusive manager dashboard fits 390px; tables scroll inside cards');
      await snap(join(output, 'manager-mobile-light.png'));
      await evaluate('document.querySelector(".theme-toggle").click()');
      await waitDom('dark theme chosen', 'document.documentElement.dataset.theme === "dark"');
      await delay(200);
      check(await contrast(), 'Dark theme action buttons meet 4.5:1 text contrast');
      await snap(join(output, 'manager-mobile-dark.png'));
      check(await evaluate('getComputedStyle(document.documentElement).colorScheme === "dark" && document.querySelector(".theme-toggle").getAttribute("aria-pressed") === "true" && localStorage.getItem("it-helpdesk:theme") === "dark"'), 'The header switch turns the dark theme on and remembers it');
      await command('Page.reload', { ignoreCache: true });
      await waitDom('dark theme after reload', 'document.documentElement.dataset.theme === "dark" && document.querySelector(".theme-toggle")?.getAttribute("aria-pressed") === "true"');
      check(true, 'The dark choice survives a reload, applied before the app renders');
      await evaluate('document.querySelector(".theme-toggle").click()');
      await waitDom('light theme again', '!document.documentElement.dataset.theme && localStorage.getItem("it-helpdesk:theme") === "light"');
      check(await evaluate('getComputedStyle(document.documentElement).colorScheme === "light"'), 'The same switch returns to the light theme');
      await command('Emulation.clearDeviceMetricsOverride');
      await command('Emulation.setEmulatedMedia', { features: [] });
    }
    await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent === "Sair").click()');
    await waitDom(`${role} logout`, 'location.pathname === "/login" && !!document.getElementById("email")');
    check(await evaluate('localStorage.getItem("it-helpdesk:token") === null'), `${role}: logout clears session`);
  }

  // Shared incidents, after the per-role counts above: its own ticket, so no earlier expectation changes.
  const { SharedIncidentModel, IncidentParticipationModel } = await import('../src/models/incident.model.ts');
  await Promise.all([SharedIncidentModel.syncIndexes(), IncidentParticipationModel.syncIndexes()]);
  const outage = await ticket('Rede do terceiro andar fora do ar', other, 'em_andamento', users.ti);
  const boardOpen = await ticket('Quadro: monitor piscando', other);
  const boardOther = await ticket('Quadro: atribuído ao Carlos', other, 'em_andamento', secondAnalyst);
  const login = async (role) => {
    await go(`/login?incidents=${role}`);
    await waitDom(`${role} incident login form`, 'location.pathname === "/login" && !!document.getElementById("email")');
    await fill('email', users[role].email);
    await fill('password', password);
    await submit();
    await waitDom(`${role} incident login`, `document.querySelector('.user-menu__name')?.textContent === ${JSON.stringify(users[role].name)}`);
  };
  const logout = async (role) => {
    await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent === "Sair").click()');
    await waitDom(`${role} incident logout`, 'location.pathname === "/login"');
  };
  // Waits for the button: panels and forms render after their data loads.
  const clickButton = async (text) => {
    const find = `Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === ${JSON.stringify(text)} && !el.disabled)`;
    await waitDom(`button ${text}`, `!!${find}`);
    await evaluate(`${find}.click()`);
  };
  const cardCount = '(document.querySelector(".incident-card .incident-card__count")?.textContent ?? "")';

  await login('ti');
  await go(`/tickets/${outage.id}`);
  await waitDom('incident panel', '!!document.querySelector(".incident-panel")');
  await clickButton('Publicar como incidente');
  await waitDom('incident publish form', '!!document.getElementById("incident-title")');
  await fill('incident-title', 'Rede do terceiro andar indisponível');
  await fill('incident-message', 'A rede cabeada do terceiro andar está fora do ar. A equipe já está atuando.');
  await evaluate('document.getElementById("incident-title").closest("form").requestSubmit()');
  await waitDom('incident published', 'document.querySelector(".incident-panel .incident-status")?.textContent === "Publicado"');
  check((await browserApi('GET', `/tickets/${outage.id}`)).body.ticket.revision === outage.revision, 'Publishing an incident does not change the ticket revision');
  await go('/tickets?search=terceiro');
  await waitDom('incident tag in queue', '!!document.querySelector(".ticket-table .incident-tag")');
  check(await evaluate('document.querySelector(".ticket-table .incident-tag").textContent.includes("0 pessoas afetadas")'), 'TI queue marks the ticket as a shared incident');

  // Knowledge base, in the same TI session: an article whose text contains markup, and a draft.
  const { KnowledgeArticleModel, ArticleFeedbackModel } = await import('../src/models/article.model.ts');
  await Promise.all([KnowledgeArticleModel.syncIndexes(), ArticleFeedbackModel.syncIndexes()]);
  const choose = (id, value) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await go('/help/manage/new');
  await waitDom('article editor', '!!document.getElementById("article-title")');
  await fill('article-title', 'Teclado sem resposta no notebook');
  await fill('article-summary', 'O que verificar quando o teclado para de responder.');
  await choose('article-category', 'hardware');
  await choose('article-status', 'published');
  await fill('article-body', 'Verifique se o teclado está conectado.\n\n- Reinicie o computador.\n- <script>window.__kbInjected = true</script><img src=x onerror="window.__kbInjected = true"> continua como texto.');
  await evaluate('document.getElementById("article-title").closest("form").requestSubmit()');
  await waitDom('article saved and published', 'location.pathname.startsWith("/help/manage/") && !location.pathname.endsWith("/new") && document.querySelector(".page__subtitle")?.textContent.startsWith("Publicado")');
  check(true, 'TI writes and publishes a help article through the editor');
  const draft = await browserApi('POST', '/articles', { title: 'Rascunho interno de VPN', summary: 'Texto ainda em revisão pela equipe.', category: 'rede', body: 'Rascunho que os solicitantes não podem ler nem encontrar.', status: 'draft' });
  check(draft.status === 201, 'TI saves a draft article');
  // Kanban (Quadro), same TI session: same data and rules as the list, explicit actions only.
  const cardOf = (title) => `Array.from(document.querySelectorAll('.board-card')).find(card => card.querySelector('.board-card__title').textContent === ${JSON.stringify(title)})`;
  const columnOf = (title) => `(${cardOf(title)}?.closest('.board-column')?.className ?? '')`;
  const cardButton = (title, text) => `Array.from(${cardOf(title)}?.querySelectorAll('button') ?? []).find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
  await go('/tickets?view=board&search=Quadro');
  await waitDom('board loaded', `${columnOf('Quadro: monitor piscando')}.includes('board-column--aberto') && ${columnOf('Quadro: atribuído ao Carlos')}.includes('board-column--em_andamento')`);
  const openTotal = (await browserApi('GET', '/tickets?search=Quadro&status=aberto')).body.pagination.total;
  check(await evaluate(`document.querySelector('.board-column--aberto .board-column__count').textContent === '${openTotal}' && document.querySelectorAll('.board-column').length === 3`), 'Board columns show the same tickets and totals as the list API');
  await clickButton('Lista');
  await waitDom('list keeps filters', 'location.search.includes("search=Quadro") && !location.search.includes("view=") && document.querySelectorAll(".ticket-table tbody tr").length === 2');
  await clickButton('Quadro');
  await waitDom('board keeps filters', `location.search.includes("view=board") && location.search.includes("search=Quadro") && !!${cardOf('Quadro: monitor piscando')}`);
  check(true, 'Switching between list and board keeps the filters in the URL');
  // Keyboard only: focus the card action and press Enter.
  await evaluate(`${cardButton('Quadro: monitor piscando', 'Iniciar atendimento')}.focus()`);
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' && { text: '\r' }) });
  await waitDom('card moved to in progress', `${columnOf('Quadro: monitor piscando')}.includes('board-column--em_andamento')`);
  const started = (await browserApi('GET', `/tickets/${boardOpen.id}`)).body.ticket;
  check(started.status === 'em_andamento' && started.assignee.id === users.ti.id && started.history.at(-1).audit.actorId === users.ti.id, 'Starting work from a card, by keyboard, is audited and assigns the operator');
  await evaluate(`${cardButton('Quadro: atribuído ao Carlos', 'Resolver')}.click()`);
  await waitDom('justification on card', `!!${cardOf('Quadro: atribuído ao Carlos')}.querySelector('textarea')`);
  check(await evaluate(`${cardButton('Quadro: atribuído ao Carlos', 'Confirmar resolução')}.disabled`), 'Resolving someone else\'s ticket from the board requires a justification');
  await fill(`resolve-${boardOther.id}`, 'Cabo de vídeo trocado durante a visita ao setor.');
  await evaluate(`${cardButton('Quadro: atribuído ao Carlos', 'Confirmar resolução')}.click()`);
  await waitDom('card moved to resolved', `${columnOf('Quadro: atribuído ao Carlos')}.includes('board-column--resolvido')`);
  const resolvedOnBoard = (await browserApi('GET', `/tickets/${boardOther.id}`)).body.ticket;
  check(resolvedOnBoard.resolvedBy.id === users.ti.id && resolvedOnBoard.assignee.id === secondAnalyst.id && resolvedOnBoard.history.at(-1).audit.reason.startsWith('Cabo'), 'Board resolution keeps the assignee, records the resolver and the justification');
  // A change made elsewhere after the board loaded: the card action gets 409 and the board reloads.
  check((await browserApi('PATCH', `/tickets/${boardOpen.id}`, { category: 'rede' })).status === 200, 'Concurrent change after the board loaded');
  await evaluate(`${cardButton('Quadro: monitor piscando', 'Resolver')}.click()`);
  await evaluate(`${cardButton('Quadro: monitor piscando', 'Confirmar resolução')}.click()`);
  await waitDom('stale card rejected', 'document.querySelector(".board-wrapper [role=alert]")?.textContent.includes("alterado por outra pessoa")');
  check((await browserApi('GET', `/tickets/${boardOpen.id}`)).body.ticket.status === 'em_andamento', 'A stale card cannot resolve: 409 and nothing is written');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await waitDom('board on mobile', `!!${cardOf('Quadro: monitor piscando')}`);
  check(await evaluate('document.documentElement.scrollWidth <= 390 && !!document.querySelector(".board-jump")'), 'Board fits 390px with links to each column');
  check(await evaluate('getComputedStyle(document.getElementById("ticket-filters")).display === "none" && document.querySelector(".toolbar__toggle")?.getAttribute("aria-expanded") === "false"'), 'On a phone the filters start collapsed, so the queue comes first');
  await evaluate('document.querySelector(".toolbar__toggle").click()');
  await waitDom('filters expanded', 'getComputedStyle(document.getElementById("ticket-filters")).display !== "none" && !!document.getElementById("filter-status")?.offsetParent');
  check(await evaluate('document.documentElement.scrollWidth <= 390'), 'Expanded filters still fit 390px');
  await command('Emulation.clearDeviceMetricsOverride');
  check(await evaluate('getComputedStyle(document.querySelector(".toolbar__toggle")).display === "none" && getComputedStyle(document.getElementById("ticket-filters")).display !== "none"'), 'Larger screens always show the filters, without the toggle');
  await logout('ti');

  await login('solicitante');
  await go('/dashboard');
  await waitDom('requester known problems', '!!document.querySelector(".incident-card")');
  const publicView = (await browserApi('GET', '/incidents')).body.incidents[0];
  check(!('ticketId' in publicView) && !('history' in publicView) && !JSON.stringify(publicView).includes('Problema de teste'), 'Requester receives only the public incident fields');
  await clickButton('Também estou com esse problema');
  await waitDom('requester follows', `document.querySelector(".incident-card button")?.getAttribute("aria-pressed") === "true" && ${cardCount} === "1 pessoa afetada"`);
  const again = await browserApi('PUT', `/incidents/${publicView.id}/participation`, {});
  check(again.status === 200 && again.body.incident.affectedCount === 1, 'Following twice keeps one participation');
  await command('Page.reload', { ignoreCache: true });
  await waitDom('follow survives reload', `document.querySelector(".incident-card button")?.getAttribute("aria-pressed") === "true" && ${cardCount} === "1 pessoa afetada"`);
  await clickButton('Não estou mais com esse problema');
  await waitDom('requester leaves', `document.querySelector(".incident-card button")?.getAttribute("aria-pressed") === "false" && ${cardCount} === "0 pessoas afetadas"`);
  await clickButton('Também estou com esse problema');
  await waitDom('requester follows again', `${cardCount} === "1 pessoa afetada"`);
  check(true, 'Requester follows, leaves and follows again with the count kept exact');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'Requester home with known problems fits 390px');
  await command('Emulation.clearDeviceMetricsOverride');

  await go('/help?q=teclado');
  await waitDom('help search results', 'document.querySelectorAll(".article-card").length === 1');
  check(await evaluate('!document.body.textContent.includes("Rascunho interno")'), 'Drafts are not listed for requesters');
  await evaluate('document.querySelector(".article-card__title").click()');
  await waitDom('article page', '!!document.querySelector(".article-body")');
  check(await evaluate('!window.__kbInjected && !document.querySelector(".article-body script, .article-body img") && document.querySelector(".article-body").textContent.includes("<script>")'), 'Article markup is shown as text and never executed');
  await clickButton('Isso resolveu meu problema.');
  await waitDom('article feedback saved', '!!document.querySelector(".article-feedback__thanks")');
  check(true, 'Requester tells that the article helped');
  await go(`/help/${draft.body.article.id}`);
  await waitDom('draft hidden', 'document.querySelector("[role=alert]")?.textContent.includes("não está disponível")');
  check(true, 'A draft article answers as unavailable to requesters');

  // Guided request: "still need help" brings the subject and the article; answers survive a subject change.
  const keyboardArticle = (await browserApi('GET', '/articles?q=teclado')).body.articles[0];
  await go(`/help/${keyboardArticle.id}`);
  await waitDom('article page again', '!!document.querySelector(".article-feedback")');
  await clickButton('Ainda preciso de ajuda.');
  await waitDom('guided form from article', 'location.pathname === "/tickets/new" && document.querySelector("input[name=subject][value=hardware]")?.checked && !!document.querySelector(".context-chip") && !!document.querySelector(".guided-questions")');
  check(true, 'Still needing help opens the request form with the subject and the article as context');
  const pick = (name, value) => evaluate(`document.querySelector('input[name=${JSON.stringify(name)}][value=${JSON.stringify(value)}]').click()`);
  await pick('question-equipment', 'Notebook');
  await pick('question-powersOn', 'Sim');
  await pick('subject', 'rede');
  await waitDom('network questions', '!!document.querySelector("input[name=question-connection]")');
  await pick('subject', 'hardware');
  await waitDom('hardware answers kept', 'document.querySelector("input[name=question-equipment][value=Notebook]")?.checked === true');
  check(true, 'Answers are kept when the subject is changed and changed back');
  await fill('title', 'Teclado do notebook parou');
  await fill('description', 'O teclado do notebook parou de responder depois da atualização.');
  await submit();
  await waitDom('guided ticket created', 'location.pathname.startsWith("/tickets/") && !!document.querySelector(".intake-card")');
  const guidedId = await evaluate('location.pathname.split("/").pop()');
  const guided = (await browserApi('GET', `/tickets/${guidedId}`)).body.ticket;
  check(guided.category === 'hardware' && guided.priority === 'media' && guided.description === 'O teclado do notebook parou de responder depois da atualização.'
    && JSON.stringify(guided.intake.answers.map((item) => item.answer)) === JSON.stringify(['Notebook', 'Sim']) && guided.intake.article.id === keyboardArticle.id,
  'Guided request keeps the description, the answers of the final subject and the article read');
  check(await evaluate('document.querySelector(".intake-card").textContent.includes("Qual equipamento está com problema?")'), 'The request page shows the guided answers');

  // "Seu problema foi resolvido?" on the ticket TI resolved earlier: the requester says it continues.
  await go(`/tickets/${own.id}`);
  await waitDom('resolution question', 'document.querySelector(".resolution-answer")?.textContent.includes("Seu problema foi resolvido?")');
  await clickButton('Não, o problema continua.');
  await waitDom('contest form', '!!document.getElementById("contest-reason")');
  check(await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent.trim() === "Reabrir pedido").disabled'), 'Contesting requires a reason');
  await fill('contest-reason', 'O programa voltou a fechar sozinho hoje.');
  await evaluate('document.getElementById("contest-reason").closest("form").requestSubmit()');
  await waitDom('contested', '!!document.querySelector(".resolution-answer--contested")');
  const contested = (await browserApi('GET', `/tickets/${own.id}`)).body.ticket;
  check(contested.status === 'em_andamento' && contested.resolutionFeedback.status === 'contested' && contested.history.at(-1).type === 'reopened', 'Requester contests the resolution and the request goes back to the team');
  check((await browserApi('POST', `/tickets/${own.id}/resolution/contest`, { cycleId: contested.resolutionFeedback.cycleId, reason: 'Repetindo a contestação.' })).status === 409, 'A repeated contest does not reopen again');
  await logout('solicitante');

  await login('gestor');
  const overview = '(document.querySelector(".incidents-overview dl")?.textContent ?? "")';
  await waitDom('manager incident block', `${overview}.includes("Ativos1") && ${overview}.includes("Pessoas afetadas nos ativos1")`);
  check(true, 'Manager sees active incidents and affected people');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check(await evaluate('document.querySelector(".incidents-overview .table-scroll") && document.documentElement.scrollWidth <= 390'), 'Manager page with an incident table fits 390px');
  await command('Emulation.clearDeviceMetricsOverride');
  const closed = await browserApi('PATCH', `/tickets/${outage.id}/status`, { status: 'resolvido', reason: 'Switch substituído; rede normalizada.' });
  check(closed.status === 200, 'Manager resolves the main ticket');
  await go('/manager');
  await waitDom('manager sees closed incident', `${overview}.includes("Ativos0") && ${overview}.includes("Encerrados1")`);
  const managed = (await browserApi('GET', '/incidents/manage')).body.incidents[0];
  check(managed.status === 'closed' && managed.closeReason === 'ticket_resolved' && managed.closedBy.id === users.gestor.id, 'Resolving the ticket closes the incident, attributed to the resolver');
  await waitDom('manager quality section', 'document.querySelector(".quality-overview")?.textContent.includes("Qualidade do atendimento")');
  check(true, 'Manager sees the service quality section');
  await go('/tickets?status=em_andamento&search=Requester%20open');
  await waitDom('contested tag in queue', 'document.querySelector(".ticket-table .attention-tag")?.textContent === "Reaberto pelo solicitante"');
  check(true, 'The queue shows the reopening by the requester');
  const reResolved = await browserApi('PATCH', `/tickets/${own.id}/status`, { status: 'resolvido', reason: 'Atualização do programa reaplicada e validada.' });
  check(reResolved.status === 200 && reResolved.body.ticket.activeCycleId === 2, 'The team resolves the contested request in a new cycle');
  await logout('gestor');

  await login('solicitante');
  await go('/dashboard');
  await waitDom('requester sees result', '!!document.getElementById("followed-incidents")');
  check(await evaluate('!document.getElementById("known-incidents") && document.querySelector(".incident-card--closed .incident-status")?.textContent === "Resolvido"'), 'Requester sees the closed problem as resolved and no longer as active');
  check(await evaluate('Array.from(document.querySelectorAll(".attention-tag")).some(el => el.textContent === "Confirme se resolveu")'), 'The requester home points to the resolution waiting for an answer');
  await go(`/tickets/${own.id}`);
  await waitDom('resolution question again', 'document.querySelector(".resolution-answer")?.textContent.includes("Seu problema foi resolvido?")');
  await clickButton('Sim, foi resolvido.');
  await waitDom('rating form', '!!document.querySelector(".resolution-rating")');
  await pick('rating', '4');
  await fill('rating-comment', 'Resolveram rápido na segunda vez.');
  await evaluate('document.querySelector(".resolution-rating").requestSubmit()');
  await waitDom('rated', 'document.querySelector(".resolution-answer")?.textContent.includes("4 de 5")');
  const answered = (await browserApi('GET', `/tickets/${own.id}`)).body.ticket;
  check(answered.resolutionFeedback.status === 'confirmed' && answered.resolutionFeedback.rating === 4 && answered.history.filter((event) => event.type === 'resolution_confirmed').length === 1, 'Requester confirms the resolution and rates it once');
  await logout('solicitante');

  // Switching profiles in the same tab: the next person never lands on the previous person's page.
  // This section signs in more than the 10-per-window limit allows, so it starts with fresh counters.
  const { resetLoginRateLimit } = await import('../src/middlewares/rate-limit.middleware.ts');
  await resetLoginRateLimit();
  const signInHere = async (role) => {
    await waitDom(`${role} login form`, 'location.pathname === "/login" && !!document.getElementById("email")');
    await fill('email', users[role].email);
    await fill('password', password);
    await submit();
    await waitDom(`${role} signed in`, `document.querySelector('.user-menu__name')?.textContent === ${JSON.stringify(users[role].name)}`);
  };
  const landedOn = () => evaluate('location.pathname + location.search');
  await login('solicitante');
  await go(`/tickets/${own.id}`);
  await waitDom('requester ticket page', `location.pathname === "/tickets/${own.id}" && !!document.querySelector("h1")`);
  await logout('solicitante');
  check(await evaluate('history.state?.usr?.from === undefined'), 'Sair keeps no return page for the next person');
  await signInHere('ti');
  check(await landedOn() === '/dashboard', 'Requester → Sair → TI lands on the TI home, not the requester ticket');
  await go('/help/manage');
  await waitDom('TI article management', '!!document.querySelector(".status-tab")');
  await logout('ti');
  await signInHere('gestor');
  check(await landedOn() === '/manager', 'TI → Sair → manager lands on the management view, not Articles');
  await go('/tickets?status=aberto');
  await waitDom('manager queue', '!!document.querySelector(".queue-panel")');
  await logout('gestor');
  await signInHere('solicitante');
  check(await landedOn() === '/dashboard', 'Manager → Sair → requester lands on the requester home');
  await logout('solicitante');
  // A visitor who opens a protected page goes back to it after signing in, and a refresh keeps it.
  await go('/tickets?status=aberto');
  await waitDom('protected page asks for login', 'location.pathname === "/login" && history.state?.usr?.from === "/tickets?status=aberto"');
  await signInHere('ti');
  check(await landedOn() === '/tickets?status=aberto', 'Login from a protected URL returns to that URL');
  await command('Page.reload', { ignoreCache: true });
  await waitDom('refresh keeps session and page', `location.pathname + location.search === "/tickets?status=aberto" && document.querySelector('.user-menu__name')?.textContent === ${JSON.stringify(users.ti.name)}`);
  check(true, 'A refresh after login keeps the session and the page');
  await logout('ti');
  await go('/manager');
  await waitDom('manager page asks for login', 'location.pathname === "/login"');
  await signInHere('ti');
  check(await landedOn() === '/dashboard', 'A return page the profile cannot open falls back to its home');
  await logout('ti');
  // Invalid session: a stored token the API rejects. Its owner is read only to compare people.
  const rejectedToken = (userId) => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: String(userId) })).toString('base64url')}.invalid-signature`;
  await evaluate(`localStorage.setItem('it-helpdesk:token', ${JSON.stringify(rejectedToken(users.gestor._id))})`);
  await go('/tickets?status=resolvido');
  await waitDom('invalid session sent to login', 'location.pathname === "/login" && localStorage.getItem("it-helpdesk:token") === null');
  await signInHere('ti');
  check(await landedOn() === '/dashboard', 'After someone else\'s invalid session, the next person starts at their own home');
  await logout('ti');
  await evaluate(`localStorage.setItem('it-helpdesk:token', ${JSON.stringify(rejectedToken(users.ti._id))})`);
  await go('/tickets?status=resolvido');
  await waitDom('own invalid session sent to login', 'location.pathname === "/login"');
  await signInHere('ti');
  check(await landedOn() === '/tickets?status=resolvido', 'After their own expired session, the same person returns to the page they were on');
  await logout('ti');

  check(!diagnostics.some((item) => item.event === 'response' && item.status >= 500), 'No API response with a 5xx status during the whole run');
  check(!diagnostics.some((item) => item.event === 'browser-exception'), 'No uncaught browser exceptions');
  console.log(`\n${checks} E2E checks passed. Dashboard: initial load + 3 reloads per role.`);
  if (visibilityRecoveries) console.log(`The browser page was brought back to the front ${visibilityRecoveries} time(s) (hidden by the OS).`);
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
  clearInterval(keepVisible);
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
