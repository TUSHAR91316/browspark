// Routes tab-scoped CDP traffic to the right transport and enforces access rules.
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Bridge } from './bridge.ts';
import { DirectChrome, type LaunchOptions } from './cdp.ts';
import { DirectFirefox } from './firefox.ts';
import { browserEngine, type BrowserName, type BrowserEngine } from './browsers.ts';
import { isNewTab } from '../../shared/protocol.ts';
import { currentClient, clients } from './context.ts';
import { onDetached as interceptDetached, pendingRestore, restoreFetch } from './devtools/intercept.ts';

export type Mode = 'extension' | 'dev';
export type BrowserType = BrowserEngine;
type DevBrowser = DirectChrome | DirectFirefox;
export interface TabRecord { id: number; mode: Mode; url: string; title: string; shared: boolean; attached: boolean; unsupported?: string; windowId?: number; agent?: boolean; context?: string; browser?: BrowserType; browserId?: string; browserName?: string }

const profilesDir = () => process.env.BROWSPARK_PROFILES ?? join(homedir(), '.browspark', 'profiles');
const CONTEXT_NAME = /^[a-z0-9_-]{1,40}$/i;
/** Context names become directory names under ~/.browspark; reject anything that is not a plain name. */
export const assertContextName = (context: string) => { if (!CONTEXT_NAME.test(context)) throw new Error('context names: letters, digits, - and _ only'); };
export const profileDirFor = (context: string, browser: BrowserName = 'chromium') => {
  assertContextName(context);
  return browser !== 'chromium' && browser !== 'chrome' ? join(profilesDir(), `.${browser}`, context) : context === 'default' ? process.env.BROWSPARK_PROFILE ?? join(homedir(), '.browspark', 'profile') : join(profilesDir(), context);
};

/**
 * One object the rest of the companion talks to. Emits, for every tab regardless of transport:
 *  'cdp.event' {tabId, method, params} · 'detached' {tabId, reason} · 'disconnected' (extension) · 'dev.closed' {context}
 * Developer mode can run several named browsers ("contexts") at once, each with its own persistent profile.
 */
export class Sessions extends EventEmitter {
  readonly bridge: Bridge;
  readonly devs = new Map<string, DevBrowser>();

  constructor(bridge: Bridge) {
    super();
    this.bridge = bridge;
    bridge.on('cdp.event', (e) => this.emit('cdp.event', e));
    bridge.on('detached', (e) => { interceptDetached(e.tabId); this.holds.delete(e.tabId); this.emit('detached', e); });
    bridge.on('disconnected', (connection) => this.emit('disconnected', connection));
    this.on('detached', ({ tabId, reason }) => { if (/closed/.test(reason)) for (const c of clients.values()) c.ownedTabs.delete(tabId); });
  }

  /** The default developer browser (running or not). */
  get dev(): DevBrowser { return this.devFor('default'); }
  devFor(context: string, browser?: BrowserName): DevBrowser {
    assertContextName(context);
    let d = this.devs.get(context);
    if (d && browser && d.browserName !== browser) {
      if (d.busy) throw new Error(`Context "${context}" is running ${d.browserName} or changing state; close it first or choose another context name.`);
      this.devs.delete(context); d = undefined;
    }
    if (!d) {
      const selected = browser ?? 'chromium';
      d = selected === 'firefox' || selected === 'zen' ? new DirectFirefox(profileDirFor(context, selected), context, selected) : new DirectChrome(profileDirFor(context, selected), context, selected);
      this.devs.set(context, d);
      d.on('cdp.event', (e) => this.emit('cdp.event', e));
      d.on('detached', (e) => this.emit('detached', e));
      d.on('closed', () => this.emit('dev.closed', { context }));
    }
    return d;
  }
  runningDevs(): DevBrowser[] { return [...this.devs.values()].filter((d) => d.running); }
  devOfTab(tabId: number): DevBrowser | undefined { return this.runningDevs().find((d) => d.tab(tabId)); }
  listContexts(): { name: string; browser: BrowserName; profileDir: string; running: boolean; tabs: number }[] {
    return (['chromium', 'brave', 'firefox', 'zen'] as const).flatMap((browser) => {
      const names = new Set<string>(browser === 'chromium' ? ['default'] : []);
      for (const d of this.devs.values()) if (d.browserName === browser || browser === 'chromium' && d.browserName === 'chrome') names.add(d.name);
      const dir = browser === 'chromium' ? profilesDir() : join(profilesDir(), `.${browser}`);
      if (existsSync(dir)) for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && CONTEXT_NAME.test(entry.name)) names.add(entry.name);
      return [...names].map((name) => { const d = this.devs.get(name), profileDir = profileDirFor(name, browser); const matches = d?.profileDir === profileDir; return { name, browser: matches ? d.browserName : browser, profileDir, running: !!(matches && d.running), tabs: matches && d.running ? d.listTabs().length : 0 }; });
    });
  }
  async launch(context: string, opts: LaunchOptions) {
    const browser = opts.browser ?? this.devs.get(context)?.browserName ?? 'chromium';
    if (browserEngine(browser) === 'firefox' && opts.chromePath) throw new Error('Use browserPath or firefoxPath for Firefox/Zen, not chromePath.');
    if (browserEngine(browser) === 'chromium' && opts.firefoxPath) throw new Error('firefoxPath requires browser:"firefox" or "zen".');
    const d = this.devFor(context, browser); await d.launch(opts); return d;
  }
  async deleteContext(context: string, browser?: BrowserName) {
    assertContextName(context);
    const d = this.devs.get(context), selected = browser ?? d?.browserName ?? 'chromium';
    const dir = profileDirFor(context, selected);
    if (d?.profileDir === dir && d.busy) throw new Error(`Context "${context}" is running or changing state; close it first`);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    if (d?.profileDir === dir) this.devs.delete(context);
  }

  modeOf(tabId: number): Mode { return this.devOfTab(tabId) ? 'dev' : 'extension'; }

  async cdp<T = any>(tabId: number, method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const d = this.devOfTab(tabId);
    // A tab whose debugger detached with policies or mocks in force gets its interception back before anything else runs.
    if (!d && pendingRestore(tabId) && !method.startsWith('Fetch.')) await restoreFetch(this, tabId).catch(() => {});
    return d ? d.cdp<T>(tabId, method, params, timeoutMs) : this.bridge.cdp<T>(tabId, method, params, timeoutMs);
  }

  /** Command on a child session (worker, out-of-process frame) obtained via Target.attachToTarget on the tab. */
  cdpSession<T = any>(tabId: number, sessionId: string, method: string, params?: unknown): Promise<T> {
    const d = this.devOfTab(tabId);
    return d ? d.session<T>(sessionId, method, params) : this.bridge.cdp<T>(tabId, method, params, undefined, sessionId);
  }

  async tabs(refresh = false): Promise<TabRecord[]> {
    const out: TabRecord[] = [];
    if (this.bridge.connected) {
      const ext = await this.bridge.listTabs(refresh);
      for (const t of ext) out.push({ ...t, mode: 'extension', browser: t.browserEngine ?? 'chromium' });
    }
    for (const d of this.runningDevs()) for (const t of d.listTabs()) out.push({ id: t.id, mode: 'dev', browser: d.browserType, browserName: d.browserName, url: t.url, title: t.title, shared: true, attached: !!t.sessionId, agent: true, context: d.name });
    return out;
  }

  /** Resolve and authorize a tab. Extension tabs must be shared by the user; dev tabs are always allowed. */
  async resolve(tabId?: number, allowNewTab = false): Promise<number> {
    if (tabId !== undefined && this.devOfTab(tabId)) return tabId;
    if (tabId === undefined) {
      const usable = (await this.tabs()).filter((t) => t.shared && (!t.unsupported || (allowNewTab && isNewTab(t.url))));
      // Prefer tabs this particular agent opened, so several agents never default to each other's pages.
      const me = currentClient();
      const mine = me ? usable.filter((t) => me.ownedTabs.has(t.id)) : [];
      if (mine.length) return mine[mine.length - 1].id;
      const own = usable.filter((t) => t.agent && ![...clients.values()].some((c) => c !== me && c.ownedTabs.has(t.id)));
      if (own.length && !me) return own[own.length - 1].id;
      if (usable.length === 1) return usable[0].id;
      if (!usable.length) throw new Error(this.bridge.connected ? 'No usable tabs in the user\'s browser. Ask the user to share a tab in the extension dashboard (or open your own with browser_tabs {action:"new", url}). Do not launch the developer browser unless the user asked for it.' : this.runningDevs().length ? 'No usable tabs; open one with browser_tabs {action:"new", url}.' : 'Nothing is connected. Call browser_status and ask the user to open the Browspark extension dashboard and share a tab. Do not launch the developer browser unless the user asked for it.');
      throw new Error(`tabId is required; usable tabs: ${usable.map((t) => `${t.id} (${t.browserName ?? t.mode}, ${t.browserId ?? t.context}: ${t.title || t.url})`).join(', ')}`);
    }
    if (!this.bridge.connected) throw new Error(`Tab ${tabId} is not a development-browser tab and the extension is not connected.`);
    let t = (await this.tabs()).find((x) => x.id === tabId);
    if (!t) t = (await this.tabs(true)).find((x) => x.id === tabId);
    if (!t) throw new Error(`Tab ${tabId} does not exist (it may have been closed). Call browser_tabs.`);
    if (!t.shared) throw new Error(`Tab ${tabId} is not shared. The user must share it from the extension dashboard.`);
    if (t.unsupported && !(allowNewTab && isNewTab(t.url))) throw new Error(`Tab ${tabId} is a ${t.unsupported}; Chrome does not allow automation there.`);
    return tabId;
  }

  async newTab(url: string, mode?: Mode, context?: string, active = true, browserId?: string): Promise<number> {
    const devs = this.runningDevs();
    if (context !== undefined) assertContextName(context);
    if (browserId !== undefined && !browserId) throw new Error('browserId must be a connected browser ID from browser_status.');
    if (context && browserId) throw new Error('Choose context for a developer browser or browserId for an extension browser, not both.');
    if (context && mode === 'extension' || browserId && mode === 'dev') throw new Error('context requires mode:"dev"; browserId requires mode:"extension".');
    // Prefer the user's browser when it is connected; developer browsers only when asked for or nothing else exists.
    const m = mode ?? (context ? 'dev' : browserId || this.bridge.connected ? 'extension' : devs.length ? 'dev' : 'extension');
    let id: number;
    if (m === 'dev') {
      if (!context && devs.length > 1) throw new Error(`context is required; running developer browsers: ${devs.map(d => `${d.name} (${d.browserName})`).join(', ')}`);
      const d = context ? this.devs.get(context) : devs[0];
      if (!d?.running) throw new Error(context ? `Context "${context}" is not running` : 'No developer browser is running');
      id = await d.newTab(url);
    } else {
      if (!this.bridge.connected) throw new Error('Extension not connected');
      const r = await this.bridge.request<{ id: number }>('tabs.create', { url, active }, undefined, browserId);
      this.bridge.invalidateTabs(this.bridge.connectionForTab(r.id)?.id);
      id = r.id;
    }
    currentClient()?.ownedTabs.add(id);
    return id;
  }
  async closeTab(tabId: number) {
    for (const c of clients.values()) c.ownedTabs.delete(tabId);
    const d = this.devOfTab(tabId);
    if (d) return d.closeTab(tabId);
    const browserId = this.bridge.connectionForTab(tabId)?.id;
    await this.bridge.request('tabs.close', { tabId }); this.bridge.invalidateTabs(browserId);
  }
  /** Resize the window holding a tab; omit width/height to restore. */
  windowSize(tabId: number, width?: number, height?: number): Promise<{ width?: number; height?: number; restored?: boolean }> {
    const d = this.devOfTab(tabId);
    return d ? d.windowSize(tabId, width, height) : this.bridge.request('window.size', { tabId, width, height });
  }
  private holds = new Map<number, Set<string>>();
  /** Keep the debugger attached to a tab regardless of idle time. Reasons are counted, so a policy and an inspection session release independently. */
  async hold(tabId: number, reason: string, on: boolean) {
    const set = this.holds.get(tabId) ?? new Set<string>();
    const before = set.size > 0;
    if (on) set.add(reason); else set.delete(reason);
    if (set.size) this.holds.set(tabId, set); else this.holds.delete(tabId);
    if (before === set.size > 0 || this.devOfTab(tabId) || !this.bridge.connected) return;
    await this.bridge.request('tabs.hold', { tabId, hold: set.size > 0 }).catch(() => {});
  }
  async activate(tabId: number) {
    const d = this.devOfTab(tabId);
    if (d) return d.activate(tabId);
    await this.bridge.request('tabs.activate', { tabId });
  }
  async closeAll() { for (const d of this.devs.values()) if (d.busy) await d.close().catch(() => {}); }
}
