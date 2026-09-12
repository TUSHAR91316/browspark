// End-to-end: real Chrome + real extension + real MCP client over stdio.
// Run with: E2E=1 bun test    (needs Google Chrome; uses a throwaway profile)
import { describe, test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isNewTab } from '../../shared/protocol.ts';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = resolve(import.meta.dirname, '../..');
const skip = !process.env.E2E;

let chrome: ChildProcess, http: Server, appUrl: string, cdp: Cdp, client: Client, profile: string, tabId: number, dashboardSession: string;

/** Minimal CDP client for the browser target (test harness only). */
class Cdp {
  private id = 0; private pending = new Map<number, (r: any) => void>(); events: any[] = [];
  private ws: WebSocket;
  constructor(ws: WebSocket) { this.ws = ws; ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id) this.pending.get(m.id)?.(m); else this.events.push(m); }); }
  static async connect(profile: string) {
    for (let i = 0; i < 100; i++) {
      // Chrome writes "<port>\n<path>" here when launched with --remote-debugging-port=0
      try { const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }); return new Cdp(ws); }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    throw new Error('Chrome did not start');
  }
  send(method: string, params?: unknown, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))));
  }
  close() { this.ws.close(); }
}

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args }) as { content: any[]; isError?: boolean };
  const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { txt, img: r.content.find((c) => c.type === 'image'), err: !!r.isError };
};
const ok = async (name: string, args?: Record<string, unknown>) => { const r = await call(name, args); assert.ok(!r.err, `${name} failed: ${r.txt}`); return r.txt; };
const evaluate = async (expression: string) => {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, dashboardSession);
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.text);
  return result.result.value;
};
const waitFor = async (expression: string) => {
  for (let i = 0; i < 50; i++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Dashboard did not render: ${expression}`);
};

describe.skipIf(skip)('e2e', () => {
beforeAll(async () => {
  // static server for the deterministic test app
  http = createServer((req, res) => {
    if (req.url?.startsWith('/download?')) {
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', 'attachment; filename="browspark-test.txt"');
      res.end('download fixture'); return;
    }
    const p = join(ROOT, 'test-apps', req.url === '/' ? 'basic.html' : req.url!);
    try { res.setHeader('content-type', extname(p) === '.html' ? 'text/html' : 'text/plain'); res.end(readFileSync(p)); } catch { res.statusCode = 404; res.end(); }
  }).listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  appUrl = `http://127.0.0.1:${(http.address() as any).port}/`;

  // throwaway Chrome with the extension loaded via CDP (Chrome 137+ ignores --load-extension in branded builds)
  profile = mkdtempSync(join(tmpdir(), 'bmcp-e2e-'));
  chrome = spawn(CHROME, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  cdp = await Cdp.connect(profile);
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: join(ROOT, 'extension') });

  // companion over stdio, as an MCP client would run it
  client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StdioClientTransport({ command: 'bun', args: [join(ROOT, 'companion/src/index.ts'), '--port', '0'], stderr: 'pipe' }));
  const status = await ok('browser_status');
  const token = /token: (\w+)/.exec(status)![1];
  const PORT = Number(/port:\s+(\d+)/.exec(status)![1]);
  assert.notEqual(PORT, 0);
  assert.match(status, /NOT CONNECTED/);

  // pair the extension the way the popup does, by messaging the worker from an extension page
  const app = await cdp.send('Target.createTarget', { url: appUrl });
  await cdp.send('Target.createTarget', { url: appUrl + 'page2.html' }); // stays unshared
  const popup = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/app.html` });
  ({ sessionId: dashboardSession } = await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true }));
  const msg = (m: unknown) => cdp.send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage(${JSON.stringify(m)})`, awaitPromise: true, returnByValue: true }, dashboardSession).then((r) => r.result.value);
  // the target starts as about:blank; wait until app.html is loaded and extension APIs exist
  for (let i = 0; i < 50; i++) { const r = await cdp.send('Runtime.evaluate', { expression: 'typeof chrome !== "undefined" && !!chrome.runtime?.sendMessage', returnByValue: true }, dashboardSession); if (r.result.value) break; await new Promise((r) => setTimeout(r, 100)); }
  await msg({ type: 'setConfig', token, port: PORT });
  for (let i = 0; i < 50 && !(await msg({ type: 'getState' })).connected; i++) await new Promise((r) => setTimeout(r, 100));
  const st = await msg({ type: 'getState' });
  assert.equal(st.connected, true, `extension did not connect: ${JSON.stringify({ ...st, tabs: undefined, recent: undefined })}`);
  tabId = st.tabs.find((t: any) => t.url.startsWith(appUrl)).id;
  await msg({ type: 'setShared', tabIds: [tabId], shared: true });
  void app;
}, 120_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  cdp?.close();
  chrome?.kill();
  http?.close();
  if (profile) setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500).unref();
}, 30_000);

test('connected dashboard keeps setup first and follows activity logging settings', async () => {
  const previousLog = await evaluate('chrome.runtime.sendMessage({type:"getState"}).then(state => state.activityLog)');
  const navigate = async (route: string, title: string) => {
    await evaluate(`document.querySelector('#nav a[href="#/${route}"]').click()`);
    await waitFor(`document.querySelector('#main h1')?.textContent === ${JSON.stringify(title)}`);
  };
  const overview = async (logging: boolean) => {
    await waitFor(`document.querySelector('.setup-card') && document.querySelectorAll('.metric-grid .stat').length === ${logging ? 4 : 2}`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.setup-card .step h3')].map(step => step.textContent)`), ['Run the companion', 'Pair this extension', 'Share tabs']);
    assert.ok(await evaluate(`[...document.querySelectorAll('.setup-card .step')].every(step => step.getBoundingClientRect().height > 0) && ['.connection-panel', '.metric-grid', '.overview-grid'].every(selector => document.querySelector('.setup-card').getBoundingClientRect().bottom <= document.querySelector(selector).getBoundingClientRect().top)`), 'setup stays visible above connection, metrics, and lower cards');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.metric-grid .k')].map(label => label.textContent)`), logging ? ['Shared tabs', 'Enabled tools', 'Operations', 'Errors'] : ['Shared tabs', 'Enabled tools']);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.overview-grid .card-h h2')].map(heading => heading.textContent)`), ['Shared tabs', 'Recent activity']);
    assert.equal(await evaluate(`!!document.querySelector('#main input[aria-label="Pairing token"]')`), false, 'paired setup keeps the token input hidden until Change');
    assert.ok(await evaluate(`document.querySelector('.setup-card').textContent.includes('Paired') && [...document.querySelectorAll('.setup-card button')].some(button => button.textContent === 'Change')`));
    if (!logging) assert.ok(await evaluate(`document.querySelector('.overview-grid').textContent.includes('Activity log is off')`));
  };
  try {
    if (previousLog) await evaluate('chrome.runtime.sendMessage({type:"setActivityLog",on:false})');
    await waitFor(`document.querySelector('.connection-panel')?.textContent.includes('Your browser is connected') && document.querySelector('.shared-preview')?.textContent.includes('Browspark Test App')`);
    await overview(false);
    await navigate('tools', 'Tools');
    await waitFor(`!!document.querySelector('input[aria-label="Enable browser_status"]')`);
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Enable browser_status"]').checked`), true);
    await navigate('settings', 'Settings');
    const port = await evaluate('chrome.runtime.sendMessage({type:"getState"}).then(state => state.port)');
    assert.equal(await evaluate(`document.querySelector('input[aria-label="Bridge port"]').valueAsNumber`), port);
    assert.ok(await evaluate(`!!document.querySelector('input[aria-label="Pairing token"]')`));
    for (const on of [true, false]) {
      await waitFor(`document.querySelector('input[aria-label="Activity log"]').checked === ${!on}`);
      await evaluate(`document.querySelector('input[aria-label="Activity log"]').click()`);
      await waitFor(`chrome.runtime.sendMessage({type:'getState'}).then(state => state.activityLog === ${on})`);
      await navigate('overview', 'Overview');
      await overview(on);
      if (on) await navigate('settings', 'Settings');
    }
    await navigate('tabs', 'Tabs');
    assert.ok(await evaluate(`document.querySelector('[data-key="${tabId}"] input[type="checkbox"]').checked`), 'fixture tab must remain shared');
    assert.ok(await evaluate(`!!document.querySelector('input[aria-label="Search tabs"]')`));
    await navigate('overview', 'Overview');
  } finally {
    await evaluate(`chrome.runtime.sendMessage({type:'setActivityLog',on:${previousLog}})`);
  }
}, 30_000);

test('setup client selection shows valid configuration and survives navigation and reload', async () => {
  const previousHash = await evaluate('location.hash');
  const previousClient = await evaluate('localStorage.getItem("setupClient")');
  const port = await evaluate('chrome.runtime.sendMessage({type:"getState"}).then(state => state.port)');
  const args = ['/absolute/path/to/browspark/companion/src/index.ts', ...(port === 9223 ? [] : ['--port', String(port)])];
  const clients = [['claude', 'Claude'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['cursor', 'Cursor'], ['kilo', 'Kilo'], ['antigravity', 'Antigravity']] as const;
  const selected = (id: string) => `document.querySelector('.setup-clients button[data-client="${id}"]')?.getAttribute('aria-pressed') === 'true'`;
  try {
    await evaluate('location.hash = "#/overview"');
    await waitFor(`document.querySelectorAll('.setup-clients button').length === 6`);
    await waitFor(`document.querySelector('.connection-panel')?.textContent.includes('127.0.0.1:${port}')`);
    assert.deepEqual(await evaluate(`(() => { const group = document.querySelector('.setup-clients'); return [group.getAttribute('role'), group.getAttribute('aria-label')]; })()`), ['group', 'MCP client']);
    for (const [id, name] of clients) {
      await evaluate(`document.querySelector('.setup-clients button[data-client="${id}"]').click()`);
      await waitFor(selected(id));
      assert.equal(await evaluate(`document.querySelectorAll('.setup-clients button[aria-pressed="true"]').length`), 1);
      await waitFor(`(() => { const image = document.querySelector('.setup-clients button[data-client="${id}"] img'); return image?.complete && image.naturalWidth > 0 && image.src.startsWith(chrome.runtime.getURL('assets/')); })()`);
      const snippet = await evaluate(`document.querySelector('.setup-code code').textContent`);
      if (id === 'claude' || id === 'codex') {
        assert.match(snippet, new RegExp(`^${id} mcp add\\b`));
        assert.ok(snippet.endsWith(`bun "${args[0]}"${port === 9223 ? '' : ` --port ${port}`}`));
      }
      else {
        const config = JSON.parse(snippet);
        if (id === 'opencode' || id === 'kilo') {
          assert.equal(config.mcp.browspark.type, 'local');
          assert.deepEqual(config.mcp.browspark.command, ['bun', ...args]);
        } else {
          assert.equal(config.mcpServers.browspark.command, 'bun');
          assert.deepEqual(config.mcpServers.browspark.args, args);
          if (id === 'cursor') assert.equal(config.mcpServers.browspark.type, 'stdio');
        }
      }
      assert.equal(await evaluate(`document.querySelector('.setup-code .btn').getAttribute('aria-label')`), `Copy ${name} setup`);
      assert.ok(await evaluate(`(() => { const instructions = document.querySelector('.setup-instructions'); return instructions?.textContent.trim().length > 0 && [...instructions.querySelectorAll('a')].some(link => link.href.startsWith('https://')); })()`), `${name} setup includes instructions and documentation`);
      // Capture the browser API call without overwriting the user's system clipboard.
      assert.equal(await evaluate(`(async () => { const original = navigator.clipboard.writeText; let copied; navigator.clipboard.writeText = async text => { copied = text; }; try { document.querySelector('.setup-code .btn').click(); await Promise.resolve(); return copied; } finally { navigator.clipboard.writeText = original; } })()`), snippet);
    }
    await evaluate('document.querySelector(\'#nav a[href="#/settings"]\').click()');
    await waitFor(`document.querySelector('#main h1')?.textContent === 'Settings'`);
    await evaluate('document.querySelector(\'#nav a[href="#/overview"]\').click()');
    await waitFor(selected('antigravity'));
    assert.equal(await evaluate('localStorage.getItem("setupClient")'), 'antigravity');
    await evaluate('window.__setupBeforeReload = true');
    await cdp.send('Page.reload', {}, dashboardSession);
    await waitFor(`!window.__setupBeforeReload && ${selected('antigravity')}`);
    assert.equal(await evaluate(`document.querySelector('.setup-code .btn').getAttribute('aria-label')`), 'Copy Antigravity setup');
  } finally {
    await evaluate(`document.querySelector('.setup-clients button[data-client="${previousClient || 'claude'}"]')?.click(); ${previousClient === null ? 'localStorage.removeItem("setupClient")' : `localStorage.setItem("setupClient", ${JSON.stringify(previousClient)})`}; location.hash = ${JSON.stringify(previousHash)}`);
  }
}, 30_000);

test('status, tabs, and access enforcement', async () => {
  assert.match(await ok('browser_status'), /Extension mode: connected to .*Chrome[\s\S]*Usable tabs \(1\)/);
  const tabs = await ok('browser_tabs', { onlyUsable: false });
  assert.match(tabs, new RegExp(`\\[${tabId}\\] extension shared`));
  const unshared = tabs.split('\n').find((l) => l.includes('not shared') && !l.includes('unsupported'));
  assert.ok(unshared, 'expected an unshared normal tab');
  const other = Number(/\[(\d+)\]/.exec(unshared!)![1]);
  const r = await call('browser_snapshot', { tabId: other });
  assert.ok(r.err && /not shared/.test(r.txt), r.txt);
  const gone = await call('browser_snapshot', { tabId: 999999 });
  assert.ok(gone.err && /does not exist/.test(gone.txt), gone.txt);
});

test('snapshot, fill, select, click, read, key, wait, scroll, frames', async () => {
  const snap = await ok('browser_snapshot');
  assert.match(snap, /heading "Test App" level=1/);
  assert.match(snap, /textbox "Name"/);
  assert.match(snap, /combobox "Color" value="Red"/);
  assert.match(snap, /checkbox "Agree" unchecked/);
  assert.match(snap, /iframe "inner"[\s\S]*button "Frame button"/, 'same-origin frame contents are walked');
  const ref = (re: RegExp) => { const m = re.exec(snap); assert.ok(m, `no match for ${re}`); return m![1]; };
  const name = ref(/textbox "Name"[^\n]*\[ref=(e\d+)\]/), color = ref(/combobox "Color"[^\n]*\[ref=(e\d+)\]/);
  const agree = ref(/checkbox "Agree"[^\n]*\[ref=(e\d+)\]/), submit = ref(/button "Submit"[^\n]*\[ref=(e\d+)\]/);
  const frameBtn = ref(/button "Frame button"[^\n]*\[ref=(e\d+)\]/), later = ref(/button "Load later"[^\n]*\[ref=(e\d+)\]/);

  await ok('browser_fill', { ref: name, text: 'Ada' });
  assert.match(await ok('browser_select', { ref: color, values: ['Blue'] }), /Selected Blue/);
  await ok('browser_click', { ref: agree });
  await ok('browser_click', { ref: submit });
  assert.match(await ok('browser_read', { what: 'text' }), /submitted:Ada:b:true/);

  await ok('browser_click', { ref: frameBtn });
  assert.match(await ok('browser_snapshot'), /button "frame clicked"/);

  await ok('browser_click', { ref: later });
  assert.match(await ok('browser_wait', { text: 'Loaded!', timeoutMs: 3000 }), /Condition met/);
  const to = await call('browser_wait', { text: 'never-appears', timeoutMs: 500 });
  assert.ok(to.err && /Timed out/.test(to.txt));

  const tables = await ok('browser_read', { what: 'tables' });
  assert.deepEqual(JSON.parse(tables), [[['A', 'B'], ['1', '2']]]);
  assert.match(await ok('browser_read', { what: 'links' }), /Page 2/);

  await ok('browser_fill', { ref: name, text: '' });
  await ok('browser_click', { ref: name });
  await ok('browser_key', { text: 'xyz' });
  await ok('browser_key', { key: process.platform === 'darwin' ? 'Meta+a' : 'Control+a' });
  await ok('browser_key', { key: 'Backspace' });
  await ok('browser_key', { text: 'Bob' });
  await ok('browser_key', { key: 'Enter' });
  assert.match(await ok('browser_read', { what: 'text' }), /submitted:Bob/);

  assert.match(await ok('browser_scroll', { direction: 'down', amount: 5000 }), /Scrolled down/);
  const shot = await call('browser_screenshot');
  assert.ok(shot.img?.data.length > 1000 && shot.img.mimeType === 'image/png');
});

test('downloads stay scoped to their originating shared tab on the same origin', async () => {
  await ok('browser_navigate', { tabId, url: appUrl });
  await ok('browser_snapshot', { tabId }); // attach and enable Page events
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(profile, 'downloads'), eventsEnabled: true });
  const { targetInfos } = await cdp.send('Target.getTargets');
  const privateTarget = targetInfos.find((t: any) => t.type === 'page' && t.url === appUrl + 'page2.html');
  const sharedTarget = targetInfos.find((t: any) => t.type === 'page' && t.url === appUrl);
  assert.ok(privateTarget && sharedTarget);
  const { sessionId: privateSession } = await cdp.send('Target.attachToTarget', { targetId: privateTarget.targetId, flatten: true });
  const { sessionId: sharedSession } = await cdp.send('Target.attachToTarget', { targetId: sharedTarget.targetId, flatten: true });
  const download = async (sessionId: string, suffix: string) => {
    const url = appUrl + 'download?' + suffix;
    await cdp.send('Runtime.evaluate', { expression: `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(url)}; document.body.append(a); a.click(); a.remove(); })()`, userGesture: true }, sessionId);
    for (let i = 0; i < 100; i++) {
      const event = cdp.events.find((e) => e.method === 'Browser.downloadWillBegin' && e.params.url === url);
      if (event && cdp.events.some((e) => e.method === 'Browser.downloadProgress' && e.params.guid === event.params.guid && e.params.state === 'completed')) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('fixture download did not complete: ' + suffix);
  };
  try {
    await download(privateSession, 'private');
    assert.doesNotMatch(await ok('browser_download', { action: 'list' }), /download\?private/, 'an unshared same-origin tab cannot expose download metadata');
    await download(sharedSession, 'shared');
    const result = await ok('browser_download', { action: 'wait', urlContains: 'download?shared', timeoutMs: 2000 });
    assert.match(result, /completed/);
    assert.match(result, /browspark-test.txt/);
    assert.doesNotMatch(result, /download\?private/);
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId: privateSession });
    await cdp.send('Target.detachFromTarget', { sessionId: sharedSession });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  }
});

test('dialogs block evaluation until handled', async () => {
  const snap = await ok('browser_snapshot');
  const confirmBtn = /button "Confirm"[^\n]*\[ref=(e\d+)\]/.exec(snap)![1];
  assert.match(await ok('browser_click', { ref: confirmBtn }), /confirm dialog opened/);
  assert.match(await ok('browser_status'), /DIALOG OPEN: confirm "Sure\?"/);
  const blocked = await call('browser_read');
  assert.ok(blocked.err && /dialog is open/.test(blocked.txt), blocked.txt);
  assert.match(await ok('browser_dialog', { accept: true }), /Accepted confirm/);
  assert.match(await ok('browser_read'), /confirmed/);
});

test('navigation, history, stale refs, unsupported pages', async () => {
  const snap = await ok('browser_snapshot');
  const link = /link "Page 2"[^\n]*\[ref=(e\d+)\]/.exec(snap)![1];
  assert.match(await ok('browser_navigate', { action: 'goto', url: appUrl + 'page2.html' }), /Page Two/);
  const stale = await call('browser_click', { ref: link });
  assert.ok(stale.err && /snapshot/i.test(stale.txt), stale.txt);
  assert.match(await ok('browser_navigate', { action: 'back' }), /Test App/);
  assert.match(await ok('browser_navigate', { action: 'forward' }), /Page Two/);
  assert.match(await ok('browser_navigate', { action: 'reload' }), /Page Two/);
  const bad = await call('browser_navigate', { action: 'goto', url: 'http://127.0.0.1:1/' });
  assert.ok(bad.err && /Navigation failed/.test(bad.txt), bad.txt);
  await ok('browser_navigate', { action: 'goto', url: appUrl });
  const tabs = await ok('browser_tabs', { onlyUsable: false });
  assert.match(tabs, /unsupported: browser-internal page/, 'chrome-extension popup tab is reported unsupported');
});

test('native New Tab in another window can be shared and navigated without granting internal-page access', async () => {
  const previousHash = await evaluate('location.hash');
  const previousShareAll = await evaluate('chrome.runtime.sendMessage({type:"getState"}).then(state => state.shareAll)');
  let windowId: number | undefined;
  const checkbox = (id: number) => `document.querySelector('[data-key="${id}"] input[type="checkbox"]')`;
  try {
    if (previousShareAll) await evaluate('chrome.runtime.sendMessage({type:"setShareAll",on:false})');
    const secondWindow = await evaluate('chrome.windows.create({url:"chrome://newtab/",focused:false})');
    windowId = secondWindow.id;
    const newTabId = secondWindow.tabs[0].id;
    const originalWindowId = await evaluate(`chrome.tabs.get(${tabId}).then(tab => tab.windowId)`);
    assert.notEqual(windowId, originalWindowId);
    await waitFor(`chrome.tabs.get(${newTabId}).then(tab => tab.status === 'complete' && tab.url.startsWith('chrome://new'))`);
    const nativeUrl = await evaluate(`chrome.tabs.get(${newTabId}).then(tab => tab.url)`);
    assert.ok(isNewTab(nativeUrl), nativeUrl);
    await ok('browser_tabs', { onlyUsable: false });
    const unsharedSnapshot = await call('browser_snapshot', { tabId: newTabId });
    assert.ok(unsharedSnapshot.err && /not shared/.test(unsharedSnapshot.txt), unsharedSnapshot.txt);
    const unsharedNavigation = await call('browser_navigate', { tabId: newTabId, action: 'goto', url: appUrl + 'page2.html', timeoutMs: 5000 });
    assert.ok(unsharedNavigation.err && /not shared/.test(unsharedNavigation.txt), unsharedNavigation.txt);
    assert.equal(await evaluate(`chrome.tabs.get(${newTabId}).then(tab => tab.url)`), nativeUrl, 'unshared New Tab must not be replaced');

    await evaluate(`document.querySelector('#nav a[href="#/tabs"]').click()`);
    await waitFor(`${checkbox(newTabId)} && !${checkbox(newTabId)}.disabled`);
    assert.equal(await evaluate(`${checkbox(newTabId)}.checked`), false);
    await evaluate(`${checkbox(newTabId)}.click()`);
    await waitFor(`chrome.runtime.sendMessage({type:'getState'}).then(state => state.tabs.some(tab => tab.id === ${newTabId} && tab.shared))`);
    assert.match(await ok('browser_tabs', { onlyUsable: false }), new RegExp(`\\[${newTabId}\\] extension shared`));
    const nativeSnapshot = await call('browser_snapshot', { tabId: newTabId });
    assert.ok(nativeSnapshot.err && /browser-internal|does not allow automation/.test(nativeSnapshot.txt), nativeSnapshot.txt);
    assert.equal(await evaluate(`chrome.tabs.get(${newTabId}).then(tab => tab.url)`), nativeUrl, 'snapshot must not convert a native New Tab');
    assert.match(await ok('browser_navigate', { tabId: newTabId, action: 'goto', url: appUrl + 'page2.html', timeoutMs: 5000 }), /Page Two/);
    const navigated = await evaluate(`chrome.tabs.get(${newTabId})`);
    assert.equal(navigated.id, newTabId);
    assert.equal(navigated.windowId, windowId);
    assert.equal(navigated.url, appUrl + 'page2.html');
    assert.match(await ok('browser_snapshot', { tabId: newTabId }), /heading "Page Two"/);
    await waitFor(`${checkbox(newTabId)}?.checked && !${checkbox(newTabId)}.disabled`);
    const groups = await evaluate(`[...document.querySelectorAll('#main .group')].map(group => group.textContent)`);
    assert.equal(groups.length, 2, 'both browser windows are listed');
    assert.doesNotMatch(groups.join(' '), /current/i);
    const allTabs = await ok('browser_tabs', { onlyUsable: false });
    for (const [id, win] of [[tabId, originalWindowId], [newTabId, windowId]]) {
      assert.match(allTabs.split('\n').find(line => line.startsWith(`[${id}]`))!, new RegExp(`\\(window ${win}\\)`));
    }
    for (const [focusedWindow, target, heading] of [[windowId, tabId, 'Test App'], [originalWindowId, newTabId, 'Page Two']] as const) {
      await evaluate(`chrome.windows.update(${focusedWindow}, {focused:true})`);
      const ambiguous = await call('browser_snapshot');
      assert.ok(ambiguous.err && /tabId is required/.test(ambiguous.txt), ambiguous.txt);
      for (const id of [tabId, newTabId]) assert.match(ambiguous.txt, new RegExp(`\\b${id}\\b`));
      assert.match(await ok('browser_snapshot', { tabId: target }), new RegExp(`heading "${heading}"`));
    }

    await evaluate(`document.querySelector('input[aria-label="Share everything"]').click()`);
    await waitFor('chrome.runtime.sendMessage({type:"getState"}).then(state => state.shareAll)');
    const automatic = await evaluate(`chrome.tabs.create({windowId:${windowId},url:'chrome://newtab/',active:false})`);
    await waitFor(`chrome.tabs.get(${automatic.id}).then(tab => tab.status === 'complete' && tab.url.startsWith('chrome://new'))`);
    assert.ok(isNewTab(await evaluate(`chrome.tabs.get(${automatic.id}).then(tab => tab.url)`)));
    await waitFor(`${checkbox(automatic.id)}?.checked && ${checkbox(automatic.id)}.disabled`);
    const settings = await evaluate(`chrome.tabs.create({windowId:${windowId},url:'chrome://settings/',active:false})`);
    await waitFor(`${checkbox(settings.id)}?.disabled && !${checkbox(settings.id)}.checked`);
    assert.equal(await evaluate(`${checkbox(settings.id)}.checked`), false, 'Settings remains unavailable even while sharing everything');
    await evaluate(`document.querySelector('input[aria-label="Share everything"]').click()`);
    await waitFor(`!${checkbox(automatic.id)}?.checked && ${checkbox(automatic.id)} && !${checkbox(automatic.id)}.disabled`);
    assert.ok(await evaluate(`${checkbox(newTabId)}.checked`), 'manual sharing must survive turning Share everything off');
    assert.ok(await evaluate(`${checkbox(tabId)}.checked`), 'the existing fixture tab must remain shared');
    assert.ok(await evaluate(`${checkbox(settings.id)}.disabled`), 'Settings must remain disabled');
  } finally {
    if (windowId !== undefined) await evaluate(`chrome.windows.remove(${windowId})`).catch(() => {});
    await evaluate(`chrome.runtime.sendMessage({type:'setShareAll',on:${previousShareAll}}).finally(() => { location.hash = ${JSON.stringify(previousHash)}; })`);
  }
}, 60_000);

test('Activity counts only recorded commands and clears errors with its history', async () => {
  const previousHash = await evaluate('location.hash');
  const before = await evaluate('chrome.runtime.sendMessage({type:"getState"})');
  const failure = async () => {
    const result = await call('devtools_elements', { tabId, action: 'describe', nodeId: -1 });
    assert.ok(result.err && /node/i.test(result.txt), result.txt);
  };
  const counts = (n: number) => waitFor(`['Operations', 'Errors'].every(label => [...document.querySelectorAll('#main .stat')].find(el => el.querySelector('.k')?.textContent === label)?.querySelector('.v')?.textContent === '${n}') && !document.querySelector('#nav a[href="#/activity"] .n')`);
  try {
    await evaluate('chrome.runtime.sendMessage({type:"setActivityLog",on:false})');
    await failure();
    const off = await evaluate('chrome.runtime.sendMessage({type:"getState"})');
    assert.equal(off.totals.errors, before.totals.errors + 1);
    assert.equal(off.recent.length, 0);
    await evaluate(`document.querySelector('#nav a[href="#/activity"]').click()`);
    await waitFor(`document.querySelector('#main')?.textContent.includes('Activity log is off')`);
    assert.equal(await evaluate(`!!document.querySelector('#nav a[href="#/activity"] .n')`), false);
    await evaluate(`[...document.querySelectorAll('#main button')].find(button => button.textContent.trim() === 'Enable activity log').click()`);
    await counts(0);

    await failure();
    await counts(1);
    await evaluate(`[...document.querySelectorAll('#main .toolbar button')].find(button => button.textContent.trim() === 'Errors · 1').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('#main tbody tr').length`), 1);
    await evaluate(`[...document.querySelectorAll('#main button')].find(button => button.textContent.trim() === 'Clear').click()`);
    await counts(0);
    assert.equal(await evaluate(`document.querySelectorAll('#main tbody tr').length`), 0);

    await failure();
    await counts(1);
    await evaluate('chrome.runtime.sendMessage({type:"setActivityLog",on:false})');
    await waitFor(`document.querySelector('#main')?.textContent.includes('Activity log is off')`);
    await evaluate(`[...document.querySelectorAll('#main button')].find(button => button.textContent.trim() === 'Enable activity log').click()`);
    await counts(0);
    assert.equal(await evaluate('chrome.runtime.sendMessage({type:"getState"}).then(state => state.recent.length)'), 0);
  } finally {
    await evaluate(`chrome.runtime.sendMessage({type:'setActivityLog',on:${before.activityLog}}).finally(() => { location.hash = ${JSON.stringify(previousHash)}; })`);
  }
}, 30_000);

test('Settings Reconnect replaces a live connection and preserves access', async () => {
  const previousHash = await evaluate('location.hash');
  const before = await evaluate('chrome.runtime.sendMessage({type:"getState"})');
  assert.equal(before.connected, true);
  try {
    await evaluate(`document.querySelector('#nav a[href="#/settings"]').click()`);
    await waitFor(`document.querySelector('#reconnect') && !document.querySelector('#reconnect').disabled`);
    const immediate = await evaluate(`(() => {
      document.querySelector('#reconnect').click();
      return { button: document.querySelector('#reconnect').textContent.trim(), disabled: document.querySelector('#reconnect').disabled, header: document.querySelector('#session-status').textContent.trim(), sidebar: document.querySelector('#conn').textContent.includes('Reconnecting…'), settings: [...document.querySelectorAll('.setting')].find(row => row.querySelector('h3')?.textContent === 'Connection').querySelector('p').textContent.includes('Reconnecting…') };
    })()`);
    assert.deepEqual(immediate, { button: 'Reconnecting…', disabled: true, header: 'Reconnecting…', sidebar: true, settings: true });
    await waitFor(`chrome.runtime.sendMessage({type:'getState'}).then(state => state.connected && !state.connecting && state.connectedAt > ${before.connectedAt})`);
    await waitFor(`document.querySelector('#session-status').textContent.trim() === 'Connected' && document.querySelector('#conn .l1').textContent === 'Connected' && document.querySelector('#main').textContent.includes('Connected for') && !document.querySelector('#reconnect').disabled`);
    const after = await evaluate('chrome.runtime.sendMessage({type:"getState"})');
    assert.deepEqual(after.tabs.filter((tab: any) => tab.shared).map((tab: any) => tab.id).sort(), before.tabs.filter((tab: any) => tab.shared).map((tab: any) => tab.id).sort());
    assert.deepEqual(after.disabledTools, before.disabledTools);
    assert.deepEqual(after.toolCatalog, before.toolCatalog);
    assert.match(await ok('browser_snapshot', { tabId }), /heading "Test App"/);
  } finally {
    await evaluate(`location.hash = ${JSON.stringify(previousHash)}`);
  }
}, 30_000);

test('an unanswered companion handshake stays reconnecting and shows rejection', async () => {
  const previousHash = await evaluate('location.hash');
  const before = await evaluate('chrome.runtime.sendMessage({type:"getState"})');
  const delayed = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => delayed.once('listening', resolve));
  let attempts = 0;
  let helloTimer: ReturnType<typeof setTimeout>;
  const hello = new Promise<WebSocket>((resolve, reject) => {
    helloTimer = setTimeout(() => reject(new Error('Extension did not send its handshake')), 5000);
    delayed.on('connection', (socket) => {
      attempts++;
      socket.once('message', (data) => {
        clearTimeout(helloTimer);
        if (JSON.parse(data.toString()).event === 'hello') resolve(socket);
        else reject(new Error('Expected the extension hello message'));
      });
    });
  });
  try {
    await evaluate(`document.querySelector('#nav a[href="#/settings"]').click()`);
    await waitFor(`!!document.querySelector('#port')`);
    await evaluate(`document.querySelector('#token').value = 'unsaved token'; document.querySelector('#port').value = '54321'; document.querySelector('#port').focus()`);
    await evaluate(`chrome.runtime.sendMessage({type:'setConfig',token:'',port:${(delayed.address() as { port: number }).port}})`);
    const socket = await hello; // Deliberately send no companion request: an open WebSocket is not a completed handshake.
    await waitFor(`chrome.runtime.sendMessage({type:'getState'}).then(state => state.connecting && !state.connected)`);
    await waitFor(`document.querySelector('#reconnect')?.disabled && ['#session-status', '#conn'].every(selector => document.querySelector(selector).textContent.includes('Reconnecting…'))`);
    assert.deepEqual(await evaluate(`[document.querySelector('#token').value, document.querySelector('#port').value, document.activeElement.id]`), ['unsaved token', '54321', 'port'], 'connection updates preserve Settings drafts and focus');
    await evaluate(`document.querySelector('#nav a[href="#/overview"]').click()`);
    await waitFor(`document.querySelector('.connection-panel')?.textContent.includes('Reconnecting…')`);
    await evaluate(`document.querySelector('#nav a[href="#/settings"]').click()`);
    socket.close(4003, 'test rejection');
    await waitFor(`chrome.runtime.sendMessage({type:'getState'}).then(state => !state.connecting && !state.connected && state.stopped && state.lastError === 'Companion rejected the token')`);
    await waitFor(`document.querySelector('#main').textContent.includes('Companion rejected the token') && !document.querySelector('#reconnect').disabled`);
    assert.equal(await evaluate(`['#session-status', '#conn'].some(selector => document.querySelector(selector).textContent.includes('Reconnecting…'))`), false);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(attempts, 1, 'rejected connections must not keep retrying while stopped');
  } finally {
    clearTimeout(helloTimer!);
    for (const socket of delayed.clients) socket.terminate();
    await new Promise<void>((resolve) => delayed.close(() => resolve()));
    await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'setConfig', token: before.token, port: before.port })}).finally(() => { location.hash = ${JSON.stringify(previousHash)}; })`);
    await waitFor(`chrome.runtime.sendMessage({type:'getState'}).then(state => state.connected && !state.connecting)`);
  }
}, 30_000);

test('automatic retries stay visibly disconnected until the companion responds', async () => {
  const previousHash = await evaluate('location.hash');
  const before = await evaluate('chrome.runtime.sendMessage({type:"getState"})');
  const companion = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => companion.once('listening', resolve));
  let first!: WebSocket;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  companion.once('connection', (socket) => {
    first = socket;
    socket.once('message', (data) => {
      if (JSON.parse(data.toString()).event === 'hello') socket.send(JSON.stringify({ id: 1, method: 'tabs.list' }));
    });
  });
  try {
    await evaluate(`chrome.runtime.sendMessage({type:'setConfig',token:'',port:${(companion.address() as { port: number }).port}})`);
    await waitFor(`chrome.runtime.sendMessage({type:'getState'}).then(state => state.connected && !state.connecting)`);
    const retry = new Promise<WebSocket>((resolve, reject) => {
      retryTimer = setTimeout(() => reject(new Error('Extension did not retry the disconnected companion')), 5000);
      companion.once('connection', (socket) => socket.once('message', (data) => {
        clearTimeout(retryTimer);
        if (JSON.parse(data.toString()).event === 'hello') resolve(socket);
        else reject(new Error('Expected the retry hello message'));
      }));
    });
    first.close(1000, 'companion restart');
    const retrySocket = await retry; // Keep the automatic retry open without completing its handshake.
    await waitFor(`chrome.runtime.sendMessage({type:'getState'}).then(state => !state.connected && !state.connecting && !!state.lastError)`);
    await evaluate(`document.querySelector('#nav a[href="#/settings"]').click()`);
    await waitFor(`document.querySelector('#session-status').textContent.trim() === 'Disconnected' && document.querySelector('#conn .l1').textContent === 'Disconnected' && document.querySelector('#reconnect') && !document.querySelector('#reconnect').disabled && [...document.querySelectorAll('.setting')].find(row => row.querySelector('h3')?.textContent === 'Connection')?.querySelector('p')?.textContent.startsWith('Disconnected')`);
    await evaluate(`document.querySelector('#nav a[href="#/overview"]').click()`);
    await waitFor(`document.querySelector('.connection-panel h2')?.textContent === 'Disconnected' && document.querySelector('#session-status').textContent.trim() === 'Disconnected' && document.querySelector('#conn .l1').textContent === 'Disconnected'`);
    assert.equal(await evaluate(`document.querySelector('#main').textContent.includes('Reconnecting…')`), false);

    retrySocket.send(JSON.stringify({ id: 2, method: 'tabs.list' }));
    await waitFor(`chrome.runtime.sendMessage({type:'getState'}).then(state => state.connected && !state.connecting && !state.lastError)`);
    await waitFor(`document.querySelector('#session-status').textContent.trim() === 'Connected' && document.querySelector('#conn .l1').textContent === 'Connected' && document.querySelector('.connection-panel h2')?.textContent === 'Your browser is connected'`);
  } finally {
    clearTimeout(retryTimer);
    for (const socket of companion.clients) socket.terminate();
    await new Promise<void>((resolve) => companion.close(() => resolve()));
    await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type: 'setConfig', token: before.token, port: before.port })}).finally(() => { location.hash = ${JSON.stringify(previousHash)}; })`);
    await waitFor(`chrome.runtime.sendMessage({type:'getState'}).then(state => state.connected && !state.connecting)`);
  }
}, 30_000);
});
