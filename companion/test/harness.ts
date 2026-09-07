// Shared e2e plumbing: throwaway Chrome with the extension, companion over stdio, pairing, tool-call helpers.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const ROOT = resolve(import.meta.dirname, '../..');

export class Cdp {
  private id = 0; private pending = new Map<number, (r: any) => void>(); events: any[] = [];
  private ws: WebSocket;
  constructor(ws: WebSocket) { this.ws = ws; ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id) this.pending.get(m.id)?.(m); else this.events.push(m); }); }
  static async connect(profile: string) {
    for (let i = 0; i < 100; i++) {
      try { const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }); return new Cdp(ws); }
      catch { await new Promise((r) => setTimeout(r, 100)); }
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

export interface Ext { chrome: ChildProcess; cdp: Cdp; profile: string; extId: string; cleanup: () => Promise<void>; msg?: (m: unknown) => Promise<any>; eval?: (expr: string) => Promise<any> }

/** Launch a throwaway Chrome with the extension loaded via CDP (Chrome 137+ ignores --load-extension in branded builds). */
export async function launchExtensionChrome(): Promise<Ext> {
  const profile = mkdtempSync(join(tmpdir(), 'bmcp-e2e-'));
  const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  const cdp = await Cdp.connect(profile);
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: join(ROOT, 'extension') });
  return { chrome, cdp, profile, extId, cleanup: async () => { cdp.close(); chrome.kill(); setTimeout(() => { try { chrome.kill('SIGKILL'); } catch {} rmSync(profile, { recursive: true, force: true }); }, 1500).unref(); } };
}

export async function startCompanion(): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StdioClientTransport({ command: 'bun', args: [join(ROOT, 'companion/src/index.ts'), '--port', '0'], stderr: 'inherit', env: { ...process.env, BROWSPARK_ARTIFACTS: mkdtempSync(join(tmpdir(), 'bmcp-artifacts-')), BROWSPARK_PROFILE: mkdtempSync(join(tmpdir(), 'bmcp-devprofile-')), BROWSPARK_PROFILES: mkdtempSync(join(tmpdir(), 'bmcp-profiles-')) } }));
  return client;
}

export function callers(client: Client) {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: any[]; isError?: boolean };
    const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { txt, img: r.content.find((c) => c.type === 'image'), err: !!r.isError };
  };
  const ok = async (name: string, args?: Record<string, unknown>) => { const r = await call(name, args); assert.ok(!r.err, `${name} ${JSON.stringify(args)} failed: ${r.txt}`); return r.txt; };
  const okJson = async <T = any>(name: string, args?: Record<string, unknown>): Promise<T> => JSON.parse(await ok(name, args));
  return { call, ok, okJson };
}

/** Pair the extension with a running companion and share the tab whose URL starts with `urlPrefix`. Returns its tab id. */
/** Talk to the extension worker the way the dashboard does (opens the dashboard page once). */
export async function dashboard(ext: Ext): Promise<(m: unknown) => Promise<any>> {
  if (ext.msg) return ext.msg;
  const app = await ext.cdp.send('Target.createTarget', { url: `chrome-extension://${ext.extId}/app.html` });
  const { sessionId } = await ext.cdp.send('Target.attachToTarget', { targetId: app.targetId, flatten: true });
  for (let i = 0; i < 50; i++) { const r = await ext.cdp.send('Runtime.evaluate', { expression: 'typeof chrome !== "undefined" && !!chrome.runtime?.sendMessage', returnByValue: true }, sessionId); if (r.result.value) break; await new Promise((r) => setTimeout(r, 100)); }
  ext.msg = (m: unknown) => ext.cdp.send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage(${JSON.stringify(m)})`, awaitPromise: true, returnByValue: true }, sessionId).then((r) => r.result.value);
  ext.eval = (expr: string) => ext.cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId).then((r) => r.result.value);
  return ext.msg;
}

export async function pairAndShare(ext: Ext, ok: (n: string, a?: Record<string, unknown>) => Promise<string>, urlPrefix: string, shareAll = false): Promise<number> {
  const status = await ok('browser_status');
  const token = /token: (\w+)/.exec(status)![1];
  const port = Number(/port:\s+(\d+)/.exec(status)![1]);
  const msg = await dashboard(ext);
  await msg({ type: 'setConfig', token, port });
  let st: any;
  for (let i = 0; i < 50 && !(st = await msg({ type: 'getState' })).connected; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(st.connected, true, `extension did not connect: ${JSON.stringify({ ...st, tabs: undefined, recent: undefined })}`);
  const tabId = st.tabs.find((t: any) => t.url.startsWith(urlPrefix)).id;
  if (shareAll) await msg({ type: 'setShareAll', on: true }); else await msg({ type: 'setShared', tabIds: [tabId], shared: true });
  return tabId;
}
