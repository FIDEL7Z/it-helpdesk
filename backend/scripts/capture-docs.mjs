// Read-only application evidence: isolated browser profile, existing local demo data.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
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
  child = spawn(await findBrowser(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const debugUrl = `http://127.0.0.1:${port}`;
  await waitFor('browser startup', async () => { try { return (await fetch(`${debugUrl}/json/list`)).ok; } catch { return false; } });
  const pages = await (await fetch(`${debugUrl}/json/list`)).json();
  const command = connectCdp(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open'); await command('Page.enable'); await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const evaluate = async expression => { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error('Browser evaluation failed'); return result.result.value; };
  const ready = (label, expression) => waitFor(label, () => evaluate(expression));
  async function go(path, expression) { await command('Page.navigate', { url: origin + path }); await ready(path, expression); }
  async function capture(name, section) {
    if (section) await evaluate(`document.querySelector(${JSON.stringify(section)}).scrollIntoView({ block: 'start' })`);
    await evaluate('(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()');
    if (await evaluate(`!!document.querySelector('[role=alert], [role=dialog], .is-loading, [aria-busy=true]')`)) throw new Error('Capture blocked by visible error, modal or loading state');
    const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(output, name), Buffer.from(image.data, 'base64'));
    captures.push({ file: name, viewport: await evaluate('({ width: innerWidth, height: innerHeight })'), path: await evaluate('location.pathname + location.search') });
    console.log(`Captured ${name}`);
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
  }
  async function logout() { await evaluate('Array.from(document.querySelectorAll("button")).find(el => el.textContent === "Sair").click()'); await ready('logout', '!!document.getElementById("email")'); }
  await mkdir(output, { recursive: true });
  await go('/login', '!!document.getElementById("email") && document.querySelector("input[type=password]").value === ""');
  await capture('login-desktop.png');
  await login('SOLICITANTE');
  await go('/dashboard', '!!document.getElementById("dashboard-origin") && !!document.querySelector(".stat-card__value")');
  await evaluate('const source = document.getElementById("dashboard-origin"); source.value = "demo"; source.dispatchEvent(new Event("change", { bubbles: true }));');
  await ready('requester demo data', '!!document.querySelector(".stat-card__value") && document.getElementById("dashboard-origin").value === "demo" && !document.querySelector("[aria-busy=true]")');
  await delay(150); await capture('dashboard-solicitante-desktop.png');
  await go('/tickets/new', '!!document.getElementById("title")');
  await capture('abertura-chamado-desktop.png');
  await logout();
  await login('TI');
  await go('/dashboard', '!!document.getElementById("dashboard-origin") && !!document.querySelector(".stat-card__value")');
  await evaluate('const source = document.getElementById("dashboard-origin"); source.value = "demo"; source.dispatchEvent(new Event("change", { bubbles: true }));');
  await ready('TI demo data', '!!document.querySelector(".stat-card__value") && !document.querySelector("[aria-busy=true]")');
  await delay(150); await capture('dashboard-ti-desktop.png');
  await go('/tickets?dataOrigin=demo&search=%5BDEMO%20GERENCIAL%20v1%5D', '!!document.querySelector(".ticket-table tbody tr") && !document.querySelector("[aria-busy=true]")');
  await capture('lista-chamados-desktop.png');
  const selected = await evaluate(`(async () => { const response = await fetch('http://localhost:3000/api/tickets?dataOrigin=demo&search=' + encodeURIComponent('[DEMO GERENCIAL v1]') + '&limit=50', { headers: { Authorization: 'Bearer ' + localStorage.getItem('it-helpdesk:token') } }); const data = await response.json(); return data.tickets.find(ticket => ticket.status === 'resolvido' && ticket.resolvedById !== ticket.assigneeId)?.id; })()`);
  if (!selected) throw new Error('No explicit structured cross-assignee demo resolution exists');
  await go(`/tickets/${selected}`, '!!document.querySelector(".timeline")');
  await capture('auditoria-chamado-desktop.png', '.timeline');
  await logout();
  await login('GESTOR');
  await go('/manager?dataOrigin=demo', '!!document.querySelector(".manager-source--demo") && document.querySelectorAll(".chart-container .recharts-surface").length === 4 && document.querySelectorAll(".stat-card__value").length === 6');
  await ready('charts visibly drawn', 'Array.from(document.querySelectorAll(".chart-container .recharts-surface")).every(el => el.getBoundingClientRect().width > 100) && document.querySelectorAll(".recharts-area-curve").length === 2');
  await capture('gestor-visao-geral-desktop.png');
  await capture('gestor-equipe-carga-desktop.png', '#manager-team');
  await capture('gestor-solicitantes-desktop.png', '#manager-requesters');
  await capture('gestor-graficos-desktop.png', '#manager-trends');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('window.scrollTo(0,0)');
  await ready('mobile charts resized', 'document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll(".chart-container .recharts-surface")).every(el => el.getBoundingClientRect().width <= el.closest(".chart-container").clientWidth + 1)');
  await capture('gestor-mobile.png');
  await writeFile(join(output, 'capture-info.json'), JSON.stringify({ capturedAt: new Date().toISOString(), timezone: 'America/Fortaleza', origin: 'demo', mode: 'read-only', tool: 'Edge headless via Chrome DevTools Protocol', captures }, null, 2) + '\n');
  console.log(`${captures.length} real application screenshots saved. No tickets or users were changed.`);
}
run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  socket?.close();
  if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await Promise.race([closed, delay(5000)]); }
  if (profile && dirname(resolve(profile)) === resolve(tmpdir()) && basename(profile).startsWith('it-helpdesk-docs-')) await rm(profile, { recursive: true, force: true, maxRetries: 3 });
});
