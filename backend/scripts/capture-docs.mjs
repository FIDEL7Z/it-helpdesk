// Documentation screenshots from an isolated environment: its own temporary database, API and
// frontend, seeded only with the clear fictitious scenarios. The development database is never
// read or changed, and everything created here is dropped at the end.
import 'dotenv/config';
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
const output = resolve(root, 'docs/assets/screenshots');
const database = `it-helpdesk-docs-${randomUUID()}`;
const password = randomUUID();
let socket, browser, profile, apiServer, vite;
let databaseConnected = false;
const diagnostics = [], captures = [];
let authenticatedRole = null;

// The reserved fictitious identities, with the names used by `npm run seed`.
const PEOPLE = {
  requester: { name: 'Mariana Souza', email: 'solicitante@helpdesk.local', role: 'solicitante' },
  tech: { name: 'Carlos Andrade', email: 'ti@helpdesk.local', role: 'ti' },
  manager: { name: 'Ana Ribeiro', email: 'gestor@helpdesk.local', role: 'gestor' },
  requester2: { name: 'Maria Oliveira', email: 'demo.solicitante2@helpdesk.local', role: 'solicitante' },
  tech2: { name: 'João Silva', email: 'demo.ti2@helpdesk.local', role: 'ti' },
};
const LOGIN = { solicitante: PEOPLE.requester.email, ti: PEOPLE.tech.email, gestor: PEOPLE.manager.email };
const VIEWPORTS = { desktop: [1440, 900], amplo: [1920, 1080], tablet: [768, 1024], mobile: [390, 844] };

async function waitFor(label, action) {
  const start = Date.now();
  while (Date.now() - start < 15000) { if (await action()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
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

/** Temporary database with the demo accounts, the help articles and the fictitious scenarios. */
async function seedEnvironment() {
  process.env.DEMO_MODE = 'true';
  process.env.VITE_DEMO_MODE = 'true';
  process.env.JWT_SECRET = randomUUID();
  const [{ default: app }, { env }, { UserModel, toPublicUser }, { hashPassword }, { ensureDemoArticles }, { createDemoScenarios }] = await Promise.all([
    import('../src/app.ts'), import('../src/config/env.ts'), import('../src/models/user.model.ts'), import('../src/utils/password.ts'),
    import('../src/services/demo-articles.ts'), import('../src/services/demo-scenarios.ts'),
  ]);
  await mongoose.connect(env.MONGODB_URI, { dbName: database, serverSelectionTimeoutMS: 10000 });
  databaseConnected = true;
  await mongoose.syncIndexes();
  const passwordHash = await hashPassword(password);
  const people = {};
  for (const [key, person] of Object.entries(PEOPLE)) people[key] = toPublicUser(await UserModel.create({ ...person, passwordHash }));
  await ensureDemoArticles(people.tech.id);
  const scenarios = await createDemoScenarios(people);
  if (scenarios.skipped.length || scenarios.created.length === 0) throw new Error('Demo scenarios were not fully created');
  console.log(`Isolated database seeded: ${scenarios.created.length} fictitious scenarios and the demo help articles.`);

  apiServer = app.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  const apiUrl = `http://127.0.0.1:${apiServer.address().port}/api`;
  process.env.VITE_API_URL = apiUrl;
  const { createServer } = await import('../../frontend/node_modules/vite/dist/node/index.js');
  vite = await createServer({ root: join(root, 'frontend'), server: { host: '127.0.0.1', port: 0, open: false }, logLevel: 'error',
    // Discover every page's dependencies up front, so a lazy page does not trigger a reload mid-capture.
    optimizeDeps: { entries: ['index.html', 'src/**/*.tsx'] } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  env.CORS_ORIGIN.push(origin);
  return { apiUrl, origin };
}

async function run() {
  const executable = await findBrowser();
  const { apiUrl, origin } = await seedEnvironment();
  profile = await mkdtemp(join(tmpdir(), 'it-helpdesk-docs-'));
  browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  // The browser writes its chosen debugging port to DevToolsActivePort in the profile.
  let debugUrl;
  await waitFor('browser startup', async () => {
    try {
      const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      debugUrl = `http://127.0.0.1:${port.trim()}`;
      return (await fetch(`${debugUrl}/json/list`)).ok;
    } catch { return false; }
  });
  const pages = await (await fetch(`${debugUrl}/json/list`)).json();
  const command = connectCdp(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open'); await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  const evaluate = async expression => { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error('Browser evaluation failed'); return result.result.value; };
  const ready = (label, expression) => waitFor(label, () => evaluate(expression));
  async function go(path, expression) { await command('Page.navigate', { url: origin + path }); await ready(path, expression); }
  async function setViewport(name, theme = 'light') {
    const [width, height] = VIEWPORTS[name];
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: name === 'mobile' });
    // The theme is the person's choice saved in the browser (light by default); the next navigation applies it.
    await evaluate(`(() => { try { localStorage.setItem('it-helpdesk:theme', ${JSON.stringify(theme)}) } catch { /* about:blank has no storage */ } return true })()`);
  }
  const apiGet = (path) => evaluate(`(async () => { const response = await fetch(${JSON.stringify(apiUrl)} + ${JSON.stringify(path)}, { headers: { Authorization: 'Bearer ' + localStorage.getItem('it-helpdesk:token') } }); return response.json(); })()`);

  async function capture(name, section, fullPage = false) {
    if (section) await evaluate(`document.querySelector(${JSON.stringify(section)}).scrollIntoView({ block: 'start' })`);
    else await evaluate('window.scrollTo(0,0)');
    // Headless Edge on Windows may mark the page hidden (locked or sleeping screen) and stop rendering.
    if (await evaluate('document.visibilityState') !== 'visible') { await command('Page.bringToFront'); await command('Emulation.setFocusEmulationEnabled', { enabled: true }); }
    await evaluate('(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()');
    if (await evaluate(`!!document.querySelector('[role=alert], [role=dialog], .is-loading, [aria-busy=true], .spinner')`)) throw new Error(`${name}: capture blocked by error or loading state`);
    let identity = null;
    if (authenticatedRole) {
      identity = await evaluate(`(async () => { const response = await fetch(${JSON.stringify(apiUrl)} + '/auth/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('it-helpdesk:token') } }); if (!response.ok) throw new Error('Session verification failed'); const { user } = await response.json(); return { id: user.id, name: user.name, role: user.role }; })()`);
      if (identity.role !== authenticatedRole || await evaluate('document.querySelector(".user-menu__name").textContent') !== identity.name) throw new Error('Profile mismatch');
    }
    const page = await evaluate('({ path: location.pathname + location.search, title: document.title, heading: document.querySelector("h1")?.textContent, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light" })');
    if (page.overflow) throw new Error(`${name}: horizontal page overflow`);
    if (fullPage) {
      const home = { gestor: ['/manager', 'Visão gerencial', 'Visão gerencial'], ti: ['/dashboard', 'Atendimento', 'Atendimento'], solicitante: ['/dashboard', 'Início', 'Como podemos ajudar?'] }[authenticatedRole];
      if (page.path.split('?')[0] !== home[0] || !page.title.startsWith(home[1])) throw new Error('Incorrect home URL/title');
      if (page.heading !== home[2]) throw new Error('Incorrect home heading');
      if (authenticatedRole === 'gestor') await ready('all charts complete', 'document.querySelectorAll(".chart-container .recharts-surface").length === 4');
      else if (authenticatedRole === 'solicitante') {
        // The requester home has no origin selector: in demo mode it counts every origin, like "Meus pedidos".
        const { summary } = await apiGet('/dashboard/summary');
        if (summary.scope !== 'mine' || summary.byStatus.total <= 0) throw new Error('Incorrect requester scope or unexpectedly empty data');
        await ready('requester totals match UI', `document.querySelector('.portal-summary .stat-card__value')?.textContent === ${JSON.stringify(String(summary.byStatus.total))} && document.querySelectorAll('.request-card').length === ${Math.min(5, summary.byStatus.total)}`);
        if (!(await evaluate('!!document.getElementById("known-incidents")'))) throw new Error('No active known problem');
        if (!(await evaluate(`!!document.querySelector('a[href="/tickets/new"]')`))) throw new Error('Missing support request action');
      } else {
        // No operational tickets here: the service desk switches to the demonstration origin and says so.
        const { summary } = await apiGet('/dashboard/summary?dataOrigin=demo');
        if (summary.scope !== 'all' || summary.byStatus.total <= 0) throw new Error('Incorrect dashboard scope or unexpectedly empty data');
        await ready('queue totals match UI', `document.getElementById('dashboard-origin')?.value === 'demo' && document.querySelector('.service-desk .stat-card__value')?.textContent === ${JSON.stringify(String(summary.byStatus.total))}`);
        if (await evaluate('document.querySelectorAll(".action-card").length') !== 4) throw new Error('Missing "needs action" cards');
        if (!(await evaluate('!!document.querySelector(".my-queue")'))) throw new Error('Missing personal queue');
        if (!(await evaluate(`!!document.querySelector('a[href="/tickets/new"]')`))) throw new Error('Missing creation action');
      }
    }
    const metrics = await command('Page.getLayoutMetrics');
    const size = metrics.cssContentSize;
    // A locked Windows session can stall a frame; bring the page back and retry, like the E2E does.
    let screenshot;
    for (let attempt = 1; !screenshot; attempt++) {
      try {
        screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(fullPage && { clip: { x: 0, y: 0, width: page.width, height: Math.ceil(size.height), scale: 1 } }) });
      } catch (error) {
        if (attempt >= 3 || !/timed out/.test(error.message)) throw error;
        console.log(`${name}: screenshot timed out, retrying (${attempt}/2)`);
        await command('Page.bringToFront');
        await evaluate('(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()');
      }
    }
    const png = Buffer.from(screenshot.data, 'base64');
    await writeFile(join(output, name), png);
    captures.push({ file: name, viewport: { width: page.width, height: page.height }, theme: page.theme, path: page.path, title: page.title, heading: page.heading, ...(identity && { user: identity }), capturedAt: new Date().toISOString(), fullPage, imageDimensions: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } });
    console.log(`Captured ${name}: ${identity?.name ?? 'public'} / ${identity?.role ?? 'public'}, ${page.theme}, ${page.path}, ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  }
  async function login(role) {
    await go('/login', '!!document.getElementById("email")');
    for (const [id, value] of [['email', LOGIN[role]], ['password', password]]) {
      await evaluate(`(() => { const input = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    }
    await evaluate('document.querySelector("form").requestSubmit()');
    await ready('authenticated home', '!!document.querySelector(".app-nav")');
    authenticatedRole = role;
  }
  async function logout() { await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent === "Sair").click()'); await ready('logout', '!!document.getElementById("email")'); authenticatedRole = null; }
  await mkdir(output, { recursive: true });

  await setViewport('desktop');
  await go('/login', '!!document.getElementById("email") && document.querySelector("input[type=password]").value === ""');
  await capture('login-desktop.png');

  // ---------- Requester ----------
  await login('solicitante');
  const requesterHome = '!!document.querySelector(".portal-hero") && !!document.querySelector(".portal-summary .stat-card__value") && !document.querySelector(".spinner")';
  await go('/dashboard', requesterHome);
  await capture('dashboard-solicitante-desktop.png', null, true);
  await go('/help', '!!document.querySelector(".article-card") && !document.querySelector(".spinner")');
  await capture('central-ajuda-desktop.png');
  const wifiArticle = (await apiGet('/articles?q=wi-fi')).articles[0];
  if (!wifiArticle) throw new Error('No Wi-Fi help article');
  await go(`/help/${wifiArticle.id}`, '!!document.querySelector(".article-feedback")');
  await capture('artigo-desktop.png');
  // Guided form for "Internet e conexão": subject, known problem, articles and questions. Nothing is sent.
  await go('/tickets/new?category=rede', '!!document.querySelector(".guided-questions") && !!document.querySelector(".incident-card")');
  await capture('abertura-chamado-desktop.png');
  await capture('perguntas-contextuais-desktop.png', '.guided-questions');
  // "Seu problema foi resolvido?" on a fictitious resolved request; the question is only shown.
  const awaiting = (await apiGet('/tickets?status=resolvido&limit=50')).tickets.find((ticket) => ticket.awaitingConfirmation);
  if (!awaiting) throw new Error('No resolution waiting for confirmation');
  await go(`/tickets/${awaiting.id}`, '!!document.querySelector(".resolution-answer")');
  await capture('confirmacao-resolucao-desktop.png');
  // Mariana says she is affected too: only in this temporary database.
  await go('/dashboard', requesterHome);
  const card = 'document.querySelector("[aria-labelledby=known-incidents] .incident-card button")';
  await ready('known problem card', `${card}?.getAttribute("aria-pressed") === "false"`);
  await evaluate(`${card}.click()`);
  await ready('requester following', `${card}?.getAttribute("aria-pressed") === "true" && !${card}.disabled`);
  await capture('incidente-solicitante-desktop.png', '[aria-labelledby=known-incidents]');
  await setViewport('mobile');
  await go('/dashboard', requesterHome);
  await capture('dashboard-solicitante-mobile.png', null, true);
  await setViewport('mobile', 'dark');
  await go('/help', '!!document.querySelector(".article-card") && !document.querySelector(".spinner")');
  await capture('central-ajuda-escuro-mobile.png');
  await setViewport('desktop');
  await logout();

  // ---------- IT ----------
  await login('ti');
  const tiHome = '!!document.querySelector(".action-card") && document.getElementById("dashboard-origin")?.value === "demo" && !document.querySelector("[aria-busy=true]") && !document.querySelector(".spinner")';
  await go('/dashboard', tiHome);
  await capture('dashboard-ti-desktop.png', null, true);
  await setViewport('desktop', 'dark');
  await go('/dashboard', tiHome);
  await capture('dashboard-ti-escuro-desktop.png', null, true);
  await setViewport('desktop');
  await go('/tickets?dataOrigin=demo', '!!document.querySelector(".ticket-table tbody tr") && !document.querySelector("[aria-busy=true]")');
  await capture('lista-chamados-desktop.png');
  const board = '!!document.querySelector(".board-card") && !document.querySelector("[aria-busy=true]")';
  await go('/tickets?view=board&dataOrigin=demo', `document.querySelectorAll(".board-column").length === 3 && ${board}`);
  await capture('quadro-ti-desktop.png');
  await setViewport('amplo', 'dark');
  await go('/tickets?view=board&dataOrigin=demo&status=em_andamento', `document.querySelectorAll(".board-column").length === 1 && ${board}`);
  await capture('quadro-ti-escuro-amplo.png');
  await setViewport('mobile');
  await go('/tickets?view=board&dataOrigin=demo', board);
  await capture('quadro-ti-mobile.png');
  await setViewport('desktop');
  const crossResolved = (await apiGet('/tickets?dataOrigin=demo&status=resolvido&limit=50')).tickets.find((ticket) => ticket.resolvedById && ticket.resolvedById !== ticket.assigneeId);
  if (!crossResolved) throw new Error('No resolution by someone other than the assignee');
  await go(`/tickets/${crossResolved.id}`, '!!document.querySelector(".timeline")');
  await capture('auditoria-chamado-desktop.png', '.timeline');
  const incidentTicket = (await apiGet('/incidents/manage?status=active')).incidents[0]?.ticketId;
  if (!incidentTicket) throw new Error('No active incident');
  await go(`/tickets/${incidentTicket}`, '!!document.querySelector(".incident-panel__public")');
  await capture('incidente-ti-desktop.png', '.incident-panel');
  await logout();

  // ---------- Manager ----------
  await login('gestor');
  const managerReady = '!!document.querySelector(".manager-source--demo") && document.querySelectorAll(".chart-container .recharts-surface").length === 4 && Array.from(document.querySelectorAll(".chart-container .recharts-surface")).every(el => el.getBoundingClientRect().width > 100) && !document.querySelector(".spinner")';
  await go('/manager?dataOrigin=demo', managerReady);
  await capture('gestor-visao-geral-desktop.png', null, true);
  await capture('gestor-equipe-carga-desktop.png', '#manager-team');
  await capture('gestor-solicitantes-desktop.png', '#manager-requesters');
  await capture('gestor-graficos-desktop.png', '#manager-trends');
  await setViewport('tablet');
  await go('/manager?dataOrigin=demo', managerReady);
  await capture('gestor-tablet.png', null, true);
  await setViewport('mobile');
  await go('/manager?dataOrigin=demo', '!!document.querySelector(".manager-source--demo") && document.querySelectorAll(".chart-container .recharts-surface").length === 4 && Array.from(document.querySelectorAll(".chart-container .recharts-surface")).every(el => el.getBoundingClientRect().width <= el.closest(".chart-container").clientWidth + 1)');
  await capture('gestor-mobile.png', null, true);
  await setViewport('desktop');
  await go('/help/manage', '!!document.querySelector(".article-table tbody tr") && !!document.querySelector(".status-tab__count") && !document.querySelector(".is-loading")');
  await capture('artigos-gerenciar-desktop.png');

  await writeFile(join(output, 'capture-info.json'), JSON.stringify({ capturedAt: new Date().toISOString(), timezone: 'America/Fortaleza', origin: 'demo', mode: 'isolated', environment: 'Temporary database, API and frontend started by the script, seeded only with the fictitious demo scenarios and help articles, and dropped at the end. The development database is not used.', tool: `${basename(executable)} headless via Chrome DevTools Protocol`, captures }, null, 2) + '\n');
  console.log(`${captures.length} real application screenshots saved from the isolated environment.`);
}

run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  socket?.close();
  if (browser && browser.exitCode === null) { const closed = once(browser, 'exit'); browser.kill(); await Promise.race([closed, delay(5000)]); }
  await vite?.close();
  if (apiServer) await new Promise((done) => { apiServer.close(done); apiServer.closeAllConnections(); });
  // Only the unique database created by this run is dropped; never the configured development DB.
  if (databaseConnected && mongoose.connection.name === database && database.startsWith('it-helpdesk-docs-')) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (profile && dirname(resolve(profile)) === resolve(tmpdir()) && basename(profile).startsWith('it-helpdesk-docs-')) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
