// Application evidence from existing local demo data, in an isolated browser profile.
// Read-only, except one follow/leave on the demo incident (see the requester section).
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://localhost:5173';
const output = resolve(root, 'docs/assets/screenshots');
let socket, child, profile;
const diagnostics = [], captures = [];
let authenticatedRole = null;
const profilesOnly = process.argv.includes('--profiles-only');
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


async function run() {
  for (const endpoint of [origin, 'http://localhost:3000/api/health']) if (!(await fetch(endpoint)).ok) throw new Error('Local services are unavailable');
  if (process.env.DEMO_MODE !== 'true') throw new Error('Capture requires explicit local DEMO_MODE=true');
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  profile = await mkdtemp(join(tmpdir(), 'it-helpdesk-docs-'));
  const executable = await findBrowser();
  child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const debugUrl = `http://127.0.0.1:${port}`;
  await waitFor('browser startup', async () => { try { return (await fetch(`${debugUrl}/json/list`)).ok; } catch { return false; } });
  const pages = await (await fetch(`${debugUrl}/json/list`)).json();
  const command = connectCdp(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open'); await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const evaluate = async expression => { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error('Browser evaluation failed'); return result.result.value; };
  const ready = (label, expression) => waitFor(label, () => evaluate(expression));
  async function go(path, expression) { await command('Page.navigate', { url: origin + path }); await ready(path, expression); }
  async function capture(name, section, fullPage = false) {
    if (section) await evaluate(`document.querySelector(${JSON.stringify(section)}).scrollIntoView({ block: 'start' })`);
    else await evaluate('window.scrollTo(0,0)');
    // Headless Edge on Windows may mark the page hidden (locked or sleeping screen) and stop rendering.
    if (await evaluate('document.visibilityState') !== 'visible') { await command('Page.bringToFront'); await command('Emulation.setFocusEmulationEnabled', { enabled: true }); }
    await evaluate('(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()');
    if (await evaluate(`!!document.querySelector('[role=alert], [role=dialog], .is-loading, [aria-busy=true], .spinner')`)) throw new Error('Capture blocked by error or loading state');
    let identity = null;
    if (authenticatedRole) {
      identity = await evaluate(`(async () => { const response = await fetch('http://localhost:3000/api/auth/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('it-helpdesk:token') } }); if (!response.ok) throw new Error('Session verification failed'); const { user } = await response.json(); return { id: user.id, name: user.name, role: user.role }; })()`);
      if (identity.role !== authenticatedRole || await evaluate('document.querySelector(".user-menu__name").textContent') !== identity.name) throw new Error('Profile mismatch');
    }
    const page = await evaluate('({ path: location.pathname + location.search, title: document.title, heading: document.querySelector("h1")?.textContent, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth })');
    if (fullPage) {
      const manager = authenticatedRole === 'gestor';
      const home = { gestor: ['/manager', 'Visão gerencial', 'Visão gerencial'], ti: ['/dashboard', 'Atendimento', 'Atendimento'], solicitante: ['/dashboard', 'Início', 'Como podemos ajudar?'] }[authenticatedRole];
      if (page.path.split('?')[0] !== home[0] || !page.title.startsWith(home[1]) || page.overflow) throw new Error('Incorrect home URL/title or page overflow');
      if (page.heading !== home[2]) throw new Error('Incorrect home heading');
      if (manager) await ready('all charts complete', 'document.querySelectorAll(".chart-container .recharts-surface").length === 4 && document.querySelectorAll(".recharts-area-curve").length === 2');
      else if (authenticatedRole === 'solicitante') {
        // The requester home has no origin selector: in demo mode it counts every origin, like "Meus pedidos".
        const expected = await evaluate(`(async () => { const r = await fetch('http://localhost:3000/api/dashboard/summary', { headers: { Authorization: 'Bearer ' + localStorage.getItem('it-helpdesk:token') } }); return (await r.json()).summary; })()`);
        if (expected.scope !== 'mine' || expected.byStatus.total <= 0) throw new Error('Incorrect requester scope or unexpectedly empty data');
        await ready('requester totals match UI', `document.querySelector('.stat-card__value')?.textContent === ${JSON.stringify(String(expected.byStatus.total))} && document.querySelectorAll('.request-card').length === ${Math.min(5, expected.byStatus.total)}`);
        if (!(await evaluate('!!document.getElementById("known-incidents")'))) throw new Error('No active known problem: run npm run seed:incidents first');
        if (!(await evaluate(`!!document.querySelector('a[href="/tickets/new"]')`))) throw new Error('Missing support request action');
      } else {
        const expected = await evaluate(`(async () => { const r = await fetch('http://localhost:3000/api/dashboard/summary?dataOrigin=demo', { headers: { Authorization: 'Bearer ' + localStorage.getItem('it-helpdesk:token') } }); return (await r.json()).summary; })()`);
        if (expected.scope !== (authenticatedRole === 'solicitante' ? 'mine' : 'all') || expected.byStatus.total <= 0) throw new Error('Incorrect dashboard scope or unexpectedly empty data');
        await ready('persisted demo totals match UI', `document.querySelector('.stat-card__value')?.textContent === ${JSON.stringify(String(expected.byStatus.total))} && document.querySelectorAll('.recent-list__item').length === ${expected.recent.length}`);
        if (await evaluate('!!document.querySelector(".stats--workload")') !== (authenticatedRole === 'ti')) throw new Error('Wrong support workload visibility');
        if (!(await evaluate(`!!document.querySelector('a[href="/tickets/new"]')`))) throw new Error('Missing creation action');
      }
    }
    const metrics = await command('Page.getLayoutMetrics');
    const size = metrics.cssContentSize;
    const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(fullPage && { clip: { x: 0, y: 0, width: page.width, height: Math.ceil(size.height), scale: 1 } }) });
    const png = Buffer.from(screenshot.data, 'base64');
    await writeFile(join(output, name), png);
    captures.push({ file: name, viewport: { width: page.width, height: page.height }, path: page.path, title: page.title, heading: page.heading, ...(identity && { user: identity }), capturedAt: new Date().toISOString(), fullPage, imageDimensions: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } });
    console.log(`Captured ${name}: ${identity?.name ?? 'public'} / ${identity?.role ?? 'public'}, ${page.path}, ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  }
  async function login(role) {
    const defaults = { SOLICITANTE: ['solicitante@helpdesk.local', 'Solicitante@2026'], TI: ['ti@helpdesk.local', 'TiDemo@2026'], GESTOR: ['gestor@helpdesk.local', 'Gestor@2026'] };
    const email = process.env[`SEED_${role}_EMAIL`] ?? defaults[role][0];
    const password = process.env[`SEED_${role}_PASSWORD`] ?? defaults[role][1];
    if (email !== defaults[role][0]) throw new Error('Capture accepts only the reserved fictitious demonstration identities');
    await go('/login', '!!document.getElementById("email")');
    for (const [id, value] of [['email', email], ['password', password]]) {
      if (!value) throw new Error('Missing demonstration login variables');
      await evaluate(`(() => { const input = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    }
    await evaluate('document.querySelector("form").requestSubmit()');
    await ready('authenticated dashboard', '!!document.querySelector(".app-nav")');
    authenticatedRole = role === 'TI' ? 'ti' : role.toLowerCase();
  }
  async function logout() { await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent === "Sair").click()'); await ready('logout', '!!document.getElementById("email")'); authenticatedRole = null; }
  await mkdir(output, { recursive: true });
  if (!profilesOnly) {
  await go('/login', '!!document.getElementById("email") && document.querySelector("input[type=password]").value === ""');
  await capture('login-desktop.png');
  }
  await login('SOLICITANTE');
  const requesterHome = '!!document.querySelector(".requester-hero") && !!document.querySelector(".stat-card__value") && !document.querySelector(".spinner")';
  await go('/dashboard', requesterHome);
  await delay(150); await capture('dashboard-solicitante-desktop.png', null, true);
  if (!profilesOnly) {
  // Help center and an article, read only.
  await go('/help', '!!document.querySelector(".article-card") && !document.querySelector(".spinner")');
  await capture('central-ajuda-desktop.png');
  const apiGet = (path) => evaluate(`(async () => { const response = await fetch('http://localhost:3000/api' + ${JSON.stringify(path)}, { headers: { Authorization: 'Bearer ' + localStorage.getItem('it-helpdesk:token') } }); return response.json(); })()`);
  const wifiArticle = (await apiGet('/articles?q=wi-fi')).articles[0];
  if (!wifiArticle) throw new Error('No Wi-Fi help article: run npm run seed:articles first');
  await go(`/help/${wifiArticle.id}`, '!!document.querySelector(".article-feedback")');
  await capture('artigo-desktop.png');
  // Guided form for "Internet e conexão": subject, known problem, articles and questions. Nothing is sent.
  await go('/tickets/new?category=rede', '!!document.querySelector(".guided-questions") && !!document.querySelector(".incident-card")');
  await capture('abertura-chamado-desktop.png');
  await capture('perguntas-contextuais-desktop.png', '.guided-questions');
  // "Seu problema foi resolvido?" on a fictitious resolved request; the question is only shown, not answered.
  const awaiting = (await apiGet('/tickets?status=resolvido&dataOrigin=demo&limit=50')).tickets
    .find((ticket) => ticket.awaitingConfirmation && ticket.title.startsWith('[DEMO GERENCIAL v1]'));
  if (!awaiting) throw new Error('No demo resolution waiting for confirmation');
  await go(`/tickets/${awaiting.id}`, '!!document.querySelector(".resolution-answer")');
  await capture('confirmacao-resolucao-desktop.png');
  // The only write in this script: follow the demo incident for one capture, then leave it,
  // so the requester's public state ends as it started. Tickets and users are not touched.
  await go('/dashboard', requesterHome);
  const card = 'document.querySelector("[aria-labelledby=known-incidents] .incident-card button")';
  await ready('known problem card', `!!${card}`);
  if (await evaluate(`${card}?.getAttribute("aria-pressed") === "false"`)) {
    await evaluate(`${card}.click()`);
    await ready('requester following', `${card}?.getAttribute("aria-pressed") === "true" && !${card}.disabled`);
    await capture('incidente-solicitante-desktop.png', '[aria-labelledby=known-incidents]');
    await evaluate(`${card}.click()`);
    await ready('requester left again', `${card}?.getAttribute("aria-pressed") === "false" && !${card}.disabled`);
  } else {
    await capture('incidente-solicitante-desktop.png', '[aria-labelledby=known-incidents]');
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await go('/dashboard', requesterHome);
  await delay(150); await capture('dashboard-solicitante-mobile.png', null, true);
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  await logout();
  await login('TI');
  await go('/dashboard', '!!document.getElementById("dashboard-origin") && !!document.querySelector(".stat-card__value") && !!document.querySelector(".incident-row")');
  await evaluate('const source = document.getElementById("dashboard-origin"); source.value = "demo"; source.dispatchEvent(new Event("change", { bubbles: true }));');
  await ready('TI demo data', '!!document.querySelector(".stat-card__value") && !document.querySelector("[aria-busy=true]")');
  await delay(150); await capture('dashboard-ti-desktop.png', null, true);
  if (!profilesOnly) {
  await go('/tickets?dataOrigin=demo&search=%5BDEMO%20GERENCIAL%20v1%5D', '!!document.querySelector(".ticket-table tbody tr") && !document.querySelector("[aria-busy=true]")');
  await capture('lista-chamados-desktop.png');
  await go('/tickets?view=board&dataOrigin=demo&search=%5BDEMO%20GERENCIAL%20v1%5D', 'document.querySelectorAll(".board-column").length === 3 && !!document.querySelector(".board-card") && !document.querySelector("[aria-busy=true]")');
  await capture('quadro-ti-desktop.png');
  const selected = await evaluate(`(async () => { const response = await fetch('http://localhost:3000/api/tickets?dataOrigin=demo&search=' + encodeURIComponent('[DEMO GERENCIAL v1]') + '&limit=50', { headers: { Authorization: 'Bearer ' + localStorage.getItem('it-helpdesk:token') } }); const data = await response.json(); return data.tickets.find(ticket => ticket.status === 'resolvido' && ticket.resolvedById !== ticket.assigneeId)?.id; })()`);
  if (!selected) throw new Error('No explicit structured cross-assignee demo resolution exists');
  await go(`/tickets/${selected}`, '!!document.querySelector(".timeline")');
  await capture('auditoria-chamado-desktop.png', '.timeline');
  const incidentTicket = await evaluate(`(async () => { const response = await fetch('http://localhost:3000/api/incidents/manage?status=active', { headers: { Authorization: 'Bearer ' + localStorage.getItem('it-helpdesk:token') } }); return (await response.json()).incidents[0]?.ticketId; })()`);
  if (!incidentTicket) throw new Error('No active incident: run npm run seed:incidents first');
  await go(`/tickets/${incidentTicket}`, '!!document.querySelector(".incident-panel__public")');
  await capture('incidente-ti-desktop.png', '.incident-panel');
  }
  await logout();
  await login('GESTOR');
  await go('/manager?dataOrigin=demo', '!!document.querySelector(".manager-source--demo") && document.querySelectorAll(".chart-container .recharts-surface").length === 4 && document.querySelectorAll(".stat-card__value").length === 6');
  await ready('charts visibly drawn', 'Array.from(document.querySelectorAll(".chart-container .recharts-surface")).every(el => el.getBoundingClientRect().width > 100) && document.querySelectorAll(".recharts-area-curve").length === 2');
  await capture('gestor-visao-geral-desktop.png', null, true);
  if (!profilesOnly) {
  await capture('gestor-equipe-carga-desktop.png', '#manager-team');
  await capture('gestor-solicitantes-desktop.png', '#manager-requesters');
  await capture('gestor-graficos-desktop.png', '#manager-trends');
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('window.scrollTo(0,0)');
  await ready('mobile charts resized', 'document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll(".chart-container .recharts-surface")).every(el => el.getBoundingClientRect().width <= el.closest(".chart-container").clientWidth + 1)');
  await capture('gestor-mobile.png', null, true);
  if (profilesOnly) {
    const previous = JSON.parse(await readFile(join(output, 'capture-info.json'), 'utf8'));
    for (const capture of previous.captures) if (!captures.some(current => current.file === capture.file)) captures.push({ ...capture, capturedAt: capture.capturedAt ?? previous.capturedAt });
  }
  await writeFile(join(output, 'capture-info.json'), JSON.stringify({ capturedAt: new Date().toISOString(), timezone: 'America/Fortaleza', origin: 'demo', mode: 'read-only', exception: 'The requester follows the demo incident for one capture and leaves it right after; tickets and users are not changed.', tool: `${basename(executable)} headless via Chrome DevTools Protocol`, captures }, null, 2) + '\n');
  console.log(`${captures.length} real application screenshots saved. No tickets or users were changed; the demo incident follow was undone.`);
}
run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  socket?.close();
  if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await Promise.race([closed, delay(5000)]); }
  if (profile && dirname(resolve(profile)) === resolve(tmpdir()) && basename(profile).startsWith('it-helpdesk-docs-')) await rm(profile, { recursive: true, force: true, maxRetries: 3 });
});
