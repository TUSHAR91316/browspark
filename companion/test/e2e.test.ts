// End-to-end: real Chrome + real extension + real MCP client over stdio.
// Run with: E2E=1 bun test    (needs Google Chrome; uses a throwaway profile)
import { describe, test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = resolve(import.meta.dirname, '../..');
const skip = !process.env.E2E;

let chrome: ChildProcess, http: Server, appUrl: string, cdp: Cdp, client: Client, profile: string, tabId: number;

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

describe.skipIf(skip)('e2e', () => {
beforeAll(async () => {
  // static server for the deterministic test app
  http = createServer((req, res) => {
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
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
  const msg = (m: unknown) => cdp.send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage(${JSON.stringify(m)})`, awaitPromise: true, returnByValue: true }, sessionId).then((r) => r.result.value);
  // the target starts as about:blank; wait until app.html is loaded and extension APIs exist
  for (let i = 0; i < 50; i++) { const r = await cdp.send('Runtime.evaluate', { expression: 'typeof chrome !== "undefined" && !!chrome.runtime?.sendMessage', returnByValue: true }, sessionId); if (r.result.value) break; await new Promise((r) => setTimeout(r, 100)); }
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
});
