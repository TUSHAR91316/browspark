// Routes tab-scoped CDP traffic to the right transport and enforces access rules.
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Bridge } from './bridge.ts';
import { DirectChrome, type LaunchOptions } from './cdp.ts';
import { isNewTab, type TabInfo } from '../../shared/protocol.ts';
import { currentClient, clients } from './context.ts';

export type Mode = 'extension' | 'dev';
export interface TabRecord { id: number; mode: Mode; url: string; title: string; shared: boolean; attached: boolean; unsupported?: string; windowId?: number; agent?: boolean; context?: string }

const profilesDir = () => process.env.BROWSERMCP_PROFILES ?? join(homedir(), '.browsermcp', 'profiles');
export const profileDirFor = (context: string) => (context === 'default' ? process.env.BROWSERMCP_PROFILE ?? join(homedir(), '.browsermcp', 'profile') : join(profilesDir(), context));

/**
 * One object the rest of the companion talks to. Emits, for every tab regardless of transport:
 *  'cdp.event' {tabId, method, params} · 'detached' {tabId, reason} · 'disconnected' (extension) · 'dev.closed' {context}
 * Developer mode can run several named browsers ("contexts") at once, each with its own persistent profile.
 */
export class Sessions extends EventEmitter {
  readonly bridge: Bridge;
  readonly devs = new Map<string, DirectChrome>();

  constructor(bridge: Bridge) {
    super();
    this.bridge = bridge;
    bridge.on('cdp.event', (e) => this.emit('cdp.event', e));
    bridge.on('detached', (e) => this.emit('detached', e));
    bridge.on('disconnected', () => this.emit('disconnected'));
    this.on('detached', ({ tabId, reason }) => { if (/closed/.test(reason)) for (const c of clients.values()) c.ownedTabs.delete(tabId); });
  }

  /** The default developer browser (running or not). */
  get dev(): DirectChrome { return this.devFor('default'); }
  devFor(context: string): DirectChrome {
    let d = this.devs.get(context);
    if (!d) {
      if (!/^[a-z0-9_-]{1,40}$/i.test(context)) throw new Error('context names: letters, digits, - and _ only');
      d = new DirectChrome(profileDirFor(context), context);
      this.devs.set(context, d);
      d.on('cdp.event', (e) => this.emit('cdp.event', e));
      d.on('detached', (e) => this.emit('detached', e));
      d.on('closed', () => this.emit('dev.closed', { context }));
    }
    return d;
  }
  runningDevs(): DirectChrome[] { return [...this.devs.values()].filter((d) => d.running); }
  devOfTab(tabId: number): DirectChrome | undefined { return this.runningDevs().find((d) => d.tab(tabId)); }
  listContexts(): { name: string; profileDir: string; running: boolean; tabs: number }[] {
    const names = new Set<string>(['default', ...this.devs.keys()]);
    if (existsSync(profilesDir())) for (const n of readdirSync(profilesDir())) names.add(n);
    return [...names].map((name) => { const d = this.devs.get(name); return { name, profileDir: profileDirFor(name), running: !!d?.running, tabs: d?.running ? d.listTabs().length : 0 }; });
  }
  async launch(context: string, opts: LaunchOptions) { const d = this.devFor(context); await d.launch(opts); return d; }
  async deleteContext(context: string) {
    const d = this.devs.get(context); if (d?.running) throw new Error(`Context "${context}" is running; close it first`);
    const dir = profileDirFor(context); if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    this.devs.delete(context);
  }

  modeOf(tabId: number): Mode { return this.devOfTab(tabId) ? 'dev' : 'extension'; }

  cdp<T = any>(tabId: number, method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const d = this.devOfTab(tabId);
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
      const ext = refresh || !this.bridge.tabs.length ? (this.bridge.tabs = await this.bridge.request<TabInfo[]>('tabs.list')) : this.bridge.tabs;
      for (const t of ext) out.push({ id: t.id, mode: 'extension', url: t.url, title: t.title, shared: t.shared, attached: t.attached, unsupported: t.unsupported, windowId: t.windowId, agent: t.agent });
    }
    for (const d of this.runningDevs()) for (const t of d.listTabs()) out.push({ id: t.id, mode: 'dev', url: t.url, title: t.title, shared: true, attached: !!t.sessionId, agent: true, context: d.name });
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
      if (!usable.length) throw new Error(this.bridge.connected ? 'No usable tabs in the user\'s browser. Ask the user to share a tab in the extension dashboard (or open your own with browser_tabs {action:"new", url}). Do not launch the developer browser unless the user asked for it.' : this.runningDevs().length ? 'No usable tabs; open one with browser_tabs {action:"new", url}.' : 'Nothing is connected. Call browser_status for pairing instructions and ask the user to pair the extension. Do not launch the developer browser unless the user asked for it.');
      throw new Error(`tabId is required; usable tabs: ${usable.map((t) => `${t.id} (${t.mode}${t.context ? ':' + t.context : ''}: ${t.title || t.url})`).join(', ')}`);
    }
    if (!this.bridge.connected) throw new Error(`Tab ${tabId} is not a development-browser tab and the extension is not connected.`);
    let t = (await this.tabs()).find((x) => x.id === tabId);
    if (!t) t = (await this.tabs(true)).find((x) => x.id === tabId);
    if (!t) throw new Error(`Tab ${tabId} does not exist (it may have been closed). Call browser_tabs.`);
    if (!t.shared) throw new Error(`Tab ${tabId} is not shared. The user must share it from the extension dashboard.`);
    if (t.unsupported && !(allowNewTab && isNewTab(t.url))) throw new Error(`Tab ${tabId} is a ${t.unsupported}; Chrome does not allow automation there.`);
    return tabId;
  }

  async newTab(url: string, mode?: Mode, context?: string, active = true): Promise<number> {
    const devs = this.runningDevs();
    // Prefer the user's browser when it is connected; developer browsers only when asked for or nothing else exists.
    const m = mode ?? (this.bridge.connected ? 'extension' : devs.length ? 'dev' : 'extension');
    let id: number;
    if (m === 'dev') {
      const d = context ? this.devs.get(context) : devs.length === 1 ? devs[0] : this.devs.get('default')?.running ? this.devs.get('default') : devs[0];
      if (!d?.running) throw new Error(context ? `Context "${context}" is not running` : 'No developer browser is running');
      id = await d.newTab(url);
    } else {
      if (!this.bridge.connected) throw new Error('Extension not connected');
      const r = await this.bridge.request<{ id: number }>('tabs.create', { url, active });
      this.bridge.tabs = [];
      id = r.id;
    }
    currentClient()?.ownedTabs.add(id);
    return id;
  }
  async closeTab(tabId: number) {
    for (const c of clients.values()) c.ownedTabs.delete(tabId);
    const d = this.devOfTab(tabId);
    if (d) return d.closeTab(tabId);
    await this.bridge.request('tabs.close', { tabId }); this.bridge.tabs = [];
  }
  /** Resize the window holding a tab; omit width/height to restore. */
  windowSize(tabId: number, width?: number, height?: number): Promise<{ width?: number; height?: number; restored?: boolean }> {
    const d = this.devOfTab(tabId);
    return d ? d.windowSize(tabId, width, height) : this.bridge.request('window.size', { tabId, width, height });
  }
  /** Keep the debugger attached to a tab regardless of idle time (active inspection session). */
  async hold(tabId: number, hold: boolean) {
    if (this.devOfTab(tabId) || !this.bridge.connected) return;
    await this.bridge.request('tabs.hold', { tabId, hold }).catch(() => {});
  }
  async activate(tabId: number) {
    const d = this.devOfTab(tabId);
    if (d) return d.activate(tabId);
    await this.bridge.request('tabs.activate', { tabId });
  }
  async closeAll() { for (const d of this.runningDevs()) await d.close().catch(() => {}); }
}
