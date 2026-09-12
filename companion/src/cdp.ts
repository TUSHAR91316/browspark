// Direct CDP connection to a Chrome the companion launched itself (full developer mode).
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

export interface DevTab { id: number; targetId: string; url: string; title: string; type: string; sessionId?: string; attachedAt?: number }
export interface LaunchOptions {
  url?: string; headless?: boolean; profileDir?: string; chromePath?: string; args?: string[]; windowSize?: string;
  /** Open Chrome DevTools automatically for every tab (default: on when not headless). */ devtools?: boolean;
  /** Proxy server, e.g. "http://proxy.corp:8080" or "socks5://127.0.0.1:1080". */ proxy?: string;
  /** Unpacked extension directories to load into this browser. */ extensions?: string[];
  /** Where downloads land (default ~/.browspark/downloads/<context>). */ downloadDir?: string;
}
export interface Download { guid: string; url: string; filename: string; path: string; state: 'inProgress' | 'completed' | 'canceled'; receivedBytes: number; totalBytes: number; startedAt: number; tabId?: number }
// Chrome tab ids are int32; developer-mode ids start above that range so the two namespaces can never collide.
let nextDevTabId = 2 ** 31;

const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
};
export function findChrome(explicit?: string): string {
  const c = explicit ?? process.env.BROWSPARK_CHROME;
  if (c) { if (existsSync(c)) return c; throw new Error(`Chrome not found at ${c}`); }
  for (const p of CHROME_CANDIDATES[platform()] ?? []) if (existsSync(p)) return p;
  throw new Error('Could not find Chrome. Set BROWSPARK_CHROME to the browser executable.');
}

/**
 * Launches Chrome with a dedicated profile and speaks CDP to it over the browser WebSocket.
 * Page targets get numeric tab ids (starting at 1) so the tools can address them like extension tabs.
 * Emits 'cdp.event' {tabId, method, params}, 'detached' {tabId, reason}, 'closed'.
 */
export class DirectChrome extends EventEmitter {
  private proc?: ChildProcess;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private bySession = new Map<string, DevTab>();
  private tabs = new Map<number, DevTab>();
  readonly profileDir: string;
  readonly name: string;
  port = 0;
  version?: string;
  wsEndpoint?: string;
  headless = false;
  proxy?: string;
  downloadDir = '';
  readonly downloads = new Map<string, Download>();
  readonly loadedExtensions: { id: string; path: string }[] = [];
  private ownsProcess = false;

  constructor(profileDir = join(homedir(), '.browspark', 'profile'), name = 'default') { super(); this.profileDir = profileDir; this.name = name; }

  get running(): boolean { return this.ws?.readyState === 1; }
  get pid(): number | undefined { return this.proc?.pid; }

  async launch(opts: LaunchOptions = {}): Promise<void> {
    if (this.running) throw new Error('Development browser already running');
    const exe = findChrome(opts.chromePath);
    mkdirSync(this.profileDir, { recursive: true });
    try { rmSync(join(this.profileDir, 'DevToolsActivePort')); } catch {}
    const args = [
      `--user-data-dir=${this.profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      `--window-size=${opts.windowSize ?? '1280,900'}`, ...(opts.headless ? ['--headless=new'] : []), ...((opts.devtools ?? !opts.headless) ? ['--auto-open-devtools-for-tabs'] : []),
      ...(opts.proxy ? [`--proxy-server=${opts.proxy}`] : []), ...(opts.extensions?.length ? ['--enable-unsafe-extension-debugging', `--load-extension=${opts.extensions.join(',')}`] : []),
      ...(opts.args ?? []), opts.url ?? 'about:blank',
    ];
    this.headless = !!opts.headless; this.proxy = opts.proxy;
    this.downloadDir = opts.downloadDir ?? join(homedir(), '.browspark', 'downloads', this.name);
    mkdirSync(this.downloadDir, { recursive: true });
    this.proc = spawn(exe, args, { stdio: 'ignore', detached: false });
    this.ownsProcess = true;
    this.proc.once('exit', () => { this.ws?.close(); this.proc = undefined; });
    let endpoint: string | undefined;
    for (let i = 0; i < 150 && !endpoint; i++) {
      try {
        const [port] = readFileSync(join(this.profileDir, 'DevToolsActivePort'), 'utf8').split('\n');
        this.port = Number(port);
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string; Browser: string };
        endpoint = v.webSocketDebuggerUrl; this.version = v.Browser; this.wsEndpoint = endpoint;
      } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    if (!endpoint) { this.proc?.kill(); throw new Error('Chrome started but never exposed its DevTools endpoint'); }
    await this.connect(endpoint);
    await this.browser('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.downloadDir, eventsEnabled: true }).catch(() => {});
    // Chrome 137+ ignores --load-extension in branded builds; load through the protocol as well.
    for (const path of opts.extensions ?? []) {
      const r = await this.browser('Extensions.loadUnpacked', { path }).catch((e) => ({ error: e.message }));
      if ('id' in r) this.loadedExtensions.push({ id: r.id, path }); else this.emit('warning', `extension ${path}: ${r.error}`);
    }
  }

  private async connect(endpoint: string) {
    const ws = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 1024 * 1024 * 1024 });
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    this.ws = ws;
    ws.on('message', (d) => this.onMessage(JSON.parse(d.toString())));
    ws.on('close', () => {
      for (const [id, p] of this.pending) { p.reject(new Error('development browser disconnected')); this.pending.delete(id); }
      for (const t of this.tabs.values()) this.emit('detached', { tabId: t.id, reason: 'browser closed' });
      this.tabs.clear(); this.bySession.clear(); this.ws = undefined;
      this.emit('closed');
    });
    await this.browser('Target.setDiscoverTargets', { discover: true });
  }

  private onMessage(m: any) {
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!; this.pending.delete(m.id);
      m.error ? p.reject(new Error(`${m.error.message}${m.error.data ? `: ${m.error.data}` : ''}`)) : p.resolve(m.result);
      return;
    }
    if (!m.method) return;
    if (m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged') {
      const info = m.params.targetInfo;
      if (info.type !== 'page') return;
      let tab = [...this.tabs.values()].find((t) => t.targetId === info.targetId);
      if (!tab) { tab = { id: nextDevTabId++, targetId: info.targetId, url: info.url, title: info.title, type: info.type }; this.tabs.set(tab.id, tab); }
      else { tab.url = info.url; tab.title = info.title; }
      return;
    }
    if (m.method === 'Target.targetDestroyed') {
      const tab = [...this.tabs.values()].find((t) => t.targetId === m.params.targetId);
      if (tab) { this.tabs.delete(tab.id); if (tab.sessionId) this.bySession.delete(tab.sessionId); this.emit('detached', { tabId: tab.id, reason: 'target closed' }); }
      return;
    }
    if (m.method === 'Target.detachedFromTarget') {
      const tab = this.bySession.get(m.params.sessionId);
      if (tab) { this.bySession.delete(m.params.sessionId); tab.sessionId = undefined; this.emit('detached', { tabId: tab.id, reason: 'detached' }); }
      return;
    }
    if (m.sessionId) {
      const tab = this.bySession.get(m.sessionId);
      if (tab) this.emit('cdp.event', { tabId: tab.id, method: m.method, params: m.params });
      else this.emit('cdp.event.other', { sessionId: m.sessionId, method: m.method, params: m.params });
    } else {
      if (m.method === 'Browser.downloadWillBegin') { const p = m.params; const tab = [...this.tabs.values()].find((t) => t.targetId === p.frameId || t.sessionId === m.sessionId); this.downloads.set(p.guid, { guid: p.guid, url: p.url, filename: p.suggestedFilename, path: join(this.downloadDir, p.guid), state: 'inProgress', receivedBytes: 0, totalBytes: 0, startedAt: Date.now(), tabId: tab?.id }); }
      else if (m.method === 'Browser.downloadProgress') { const d = this.downloads.get(m.params.guid); if (d) { d.state = m.params.state; d.receivedBytes = m.params.receivedBytes; d.totalBytes = m.params.totalBytes; } }
      this.emit('browser.event', { method: m.method, params: m.params });
    }
  }

  private raw(method: string, params?: unknown, sessionId?: string, timeoutMs = 60_000): Promise<any> {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('development browser is not running; call browser_session launch'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws!.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  /** Browser-level command (no target). */
  browser<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> { return this.raw(method, params, undefined, timeoutMs); }

  /** Command on a page target, attaching on first use. */
  async cdp<T = any>(tabId: number, method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Dev tab ${tabId} does not exist`);
    if (!tab.sessionId) {
      const { sessionId } = await this.raw('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
      tab.sessionId = sessionId; tab.attachedAt = Date.now(); this.bySession.set(sessionId, tab);
    }
    return this.raw(method, params, tab.sessionId, timeoutMs);
  }

  /** Raw command on an arbitrary session (workers, iframes) — used by the dev-mode raw CDP tool. */
  session<T = any>(sessionId: string, method: string, params?: unknown): Promise<T> { return this.raw(method, params, sessionId); }

  listTabs(): DevTab[] { return [...this.tabs.values()]; }
  tab(tabId: number): DevTab | undefined { return this.tabs.get(tabId); }

  async newTab(url = 'about:blank'): Promise<number> {
    const { targetId } = await this.browser('Target.createTarget', { url });
    for (let i = 0; i < 50; i++) { const t = [...this.tabs.values()].find((x) => x.targetId === targetId); if (t) return t.id; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error('Tab was created but never reported by Chrome');
  }
  async closeTab(tabId: number) {
    const t = this.tabs.get(tabId); if (!t) throw new Error(`Dev tab ${tabId} does not exist`);
    await this.browser('Target.closeTarget', { targetId: t.targetId });
    for (let i = 0; i < 100 && this.tabs.has(tabId); i++) await new Promise((r) => setTimeout(r, 20)); // listings stay consistent
  }
  async activate(tabId: number) { const t = this.tabs.get(tabId); if (t) await this.browser('Target.activateTarget', { targetId: t.targetId }); }

  private windowBounds = new Map<number, any>();
  /** Resize the window holding a tab (device emulation); omit width/height to restore the original bounds. */
  async windowSize(tabId: number, width?: number, height?: number) {
    const t = this.tabs.get(tabId); if (!t) throw new Error(`Dev tab ${tabId} does not exist`);
    const { windowId, bounds } = await this.browser('Browser.getWindowForTarget', { targetId: t.targetId });
    if (width && height) {
      if (!this.windowBounds.has(windowId)) this.windowBounds.set(windowId, bounds);
      await this.browser('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width, height } });
      return { width, height };
    }
    const orig = this.windowBounds.get(windowId);
    if (orig) { this.windowBounds.delete(windowId); await this.browser('Browser.setWindowBounds', { windowId, bounds: orig.windowState === 'normal' ? { windowState: 'normal', width: orig.width, height: orig.height } : { windowState: orig.windowState } }); }
    return { restored: !!orig };
  }

  async close() {
    if (this.ws?.readyState === 1) { try { await this.browser('Browser.close', undefined, 3000); } catch {} }
    this.ws?.close();
    if (this.ownsProcess && this.proc) { const p = this.proc; setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 2000).unref(); try { p.kill(); } catch {} }
    this.proc = undefined;
  }
}
