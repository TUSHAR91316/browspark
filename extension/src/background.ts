import {
  DEFAULT_PORT, PROTOCOL_VERSION, isReq, unsupportedReason,
  type CdpParams, type Evt, type HelloParams, type Msg, type Req, type Res, type TabInfo, type ToolInfo,
} from '../../shared/protocol.ts';
import type { OpLog, PopupMsg, State } from './state.ts';

const shared = new Set<number>();
let shareAll = false; // user opted to share every tab, including ones opened later
let activityLog = false; // off by default: no per-command records are kept
let toolCatalog: ToolInfo[] = [];
let disabledTools = new Set<string>();
let companionVersion: string | undefined;
const sendToolPolicy = () => evt('tools.policy', { disabled: [...disabledTools], haveCatalog: toolCatalog.length > 0 && !!companionVersion, devMode });
const isShared = (tabId: number) => shareAll || shared.has(tabId);
const attached = new Set<number>();
const agentTabs = new Set<number>();     // tabs the agent opened (in the user's current window)
let devMode: 'auto' | 'always' | 'never' = 'auto';
const held = new Set<number>();          // tabs with an active inspection session: never idle-detach
const windowBounds = new Map<number, { width?: number; height?: number; state?: string }>(); // originals, restored after emulation
const lastUsed = new Map<number, number>();
const IDLE_DETACH_MS_DEFAULT = 30_000;
const recent: OpLog[] = [];
const totals = { ops: 0, errors: 0 };
let opSeq = 0;
let connectedAt: number | undefined;
let ws: WebSocket | undefined;
let stopped = false;
let lastError: string | undefined;
let backoff = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

const cfg = async () => {
  const s = await chrome.storage.local.get(['token', 'port', 'shareAll', 'stopped', 'activityLog', 'toolCatalog', 'disabledTools', 'devMode']);
  const ss = await chrome.storage.session.get(['shared']); // per-tab grants must not outlive the browser session
  return { token: (s.token as string) || '', port: (s.port as number) || DEFAULT_PORT, shared: (ss.shared as number[]) || [], shareAll: !!s.shareAll, stopped: !!s.stopped, activityLog: !!s.activityLog, toolCatalog: (s.toolCatalog as ToolInfo[]) || [], disabledTools: (s.disabledTools as string[]) || [], devMode: ((s.devMode as string) || 'auto') as 'auto' | 'always' | 'never' };
};
const send = (m: Msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const evt = (event: Evt['event'], params?: unknown) => send({ event, params });
const log = (e: Omit<OpLog, 'id'>) => { totals.ops++; if (!e.ok) totals.errors++; if (!activityLog) return; recent.unshift({ id: ++opSeq, ...e }); if (recent.length > 200) recent.pop(); };
const APP_URL = chrome.runtime.getURL('app.html');

async function listTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.id !== undefined).map((t) => ({
    id: t.id!, url: t.url || '', title: t.title || '', shared: isShared(t.id!), attached: attached.has(t.id!),
    windowId: t.windowId, active: !!t.active, agent: agentTabs.has(t.id!) || undefined, favIconUrl: t.favIconUrl, unsupported: unsupportedReason(t.url || ''),
  }));
}
const tabLabel = async (tabId: number) => { try { const t = await chrome.tabs.get(tabId); return new URL(t.url || '').host || t.title || String(tabId); } catch { return String(tabId); } };

async function openApp() {
  const [existing] = await chrome.tabs.query({ url: APP_URL });
  if (existing?.id) { await chrome.tabs.update(existing.id, { active: true }); await chrome.windows.update(existing.windowId, { focused: true }); }
  else await chrome.tabs.create({ url: APP_URL });
}
chrome.action.onClicked.addListener(openApp);
const pushTabs = async () => evt('tabs', await listTabs());

async function ensureAttached(tabId: number) {
  if (attached.has(tabId)) return;
  const tab = await chrome.tabs.get(tabId);
  const bad = unsupportedReason(tab.url || '');
  if (bad) throw new Error(`Cannot attach to ${bad} (${tab.url})`);
  try { await chrome.debugger.attach({ tabId }, '1.3'); }
  catch (e) {
    const m = (e as Error).message || String(e);
    throw new Error(/already attached/i.test(m) ? `Another extension's debugger is attached to tab ${tabId}. Chrome DevTools itself can stay open; another debugging extension cannot. Disable it for this tab and retry.` : m);
  }
  attached.add(tabId);
  pushTabs();
}
async function detach(tabId: number) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch {}
  evt('detached', { tabId, reason: 'unshared by user' }); // onDetach does not fire for our own detach
}

async function handle(req: Req): Promise<Res> {
  await ready;
  try {
    if (req.method === 'tabs.list') return { id: req.id, result: await listTabs() };
    if (req.method === 'tools.catalog') {
      const p = req.params as { tools: ToolInfo[]; version?: string };
      toolCatalog = p.tools; companionVersion = p.version;
      await chrome.storage.local.set({ toolCatalog });
      sendToolPolicy(); // the companion applies whatever the user had switched off
      return { id: req.id, result: { received: toolCatalog.length } };
    }
    if (req.method === 'tabs.create') {
      // Tabs the agent opens are ordinary tabs in the user's current window, shared automatically (it created them).
      const { url, active } = req.params as { url: string; active?: boolean };
      const t = await chrome.tabs.create({ url, active: active ?? true });
      agentTabs.add(t.id!); shared.add(t.id!); await chrome.storage.session.set({ shared: [...shared] }); pushTabs();
      return { id: req.id, result: { id: t.id, windowId: t.windowId } };
    }
    if (req.method === 'window.size') {
      // Shrink the window to a device size while emulating (so the emulated viewport fills it); omit width/height to restore.
      const { tabId, width, height } = req.params as { tabId: number; width?: number; height?: number };
      if (!isShared(tabId)) throw new Error(`Tab ${tabId} is not shared by the user`);
      const { windowId } = await chrome.tabs.get(tabId);
      if (width && height) {
        if (!windowBounds.has(windowId)) { const w = await chrome.windows.get(windowId); windowBounds.set(windowId, { width: w.width, height: w.height, state: w.state }); }
        const w = await chrome.windows.update(windowId, { state: 'normal', width, height });
        return { id: req.id, result: { width: w.width, height: w.height } };
      }
      const orig = windowBounds.get(windowId);
      if (orig) { windowBounds.delete(windowId); await chrome.windows.update(windowId, orig.state === 'maximized' || orig.state === 'fullscreen' ? { state: orig.state as chrome.windows.WindowState } : { state: 'normal', width: orig.width, height: orig.height }); }
      return { id: req.id, result: { restored: !!orig } };
    }
    if (req.method === 'downloads.list') {
      // Downloads started from shared tabs (the agent may not see the user's other downloads).
      const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 50 });
      const shown = items.filter((d) => shareAll || (d.referrer && [...shared].length));
      return { id: req.id, result: shown.map((d) => ({ guid: String(d.id), url: d.finalUrl || d.url, filename: d.filename.split('/').pop() ?? d.filename, path: d.filename, state: d.state === 'complete' ? 'completed' : d.state === 'interrupted' ? 'canceled' : 'inProgress', receivedBytes: d.bytesReceived, totalBytes: d.totalBytes, startedAt: Date.parse(d.startTime) })) };
    }
    if (req.method === 'tabs.hold') {
      const { tabId, hold } = req.params as { tabId: number; hold: boolean };
      if (hold) held.add(tabId); else held.delete(tabId);
      return { id: req.id, result: {} };
    }
    if (req.method === 'tabs.close' || req.method === 'tabs.activate') {
      const { tabId } = req.params as { tabId: number };
      if (!isShared(tabId)) throw new Error(`Tab ${tabId} is not shared by the user`);
      if (req.method === 'tabs.close') await chrome.tabs.remove(tabId);
      else { const t = await chrome.tabs.update(tabId, { active: true }); if (t?.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true }); }
      return { id: req.id, result: {} };
    }
    if (req.method === 'cdp') {
      const { tabId, method, params, sessionId } = req.params as CdpParams;
      // Trust boundary: only user-shared tabs may be driven, regardless of what the companion asks.
      if (!isShared(tabId)) throw new Error(`Tab ${tabId} is not shared by the user`);
      await ensureAttached(tabId);
      // The user may have unshared the tab while attachment was in flight: re-check before sending anything.
      if (!isShared(tabId)) { await detach(tabId); throw new Error(`Tab ${tabId} was unshared by the user`); }
      lastUsed.set(tabId, Date.now());
      // Real input and screenshots need a rendered tab; Chrome drops input to background tabs.
      // Activating only switches the tab within its own window; the user's focused window is untouched.
      if (/^(Input\.|Page\.captureScreenshot)/.test(method)) {
        const t = await chrome.tabs.get(tabId);
        if (!t.active) await chrome.tabs.update(tabId, { active: true });
      }
      const t0 = Date.now();
      try {
        const result = await chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params as Record<string, unknown> | undefined);
        log({ at: t0, ms: Date.now() - t0, tabId, tabLabel: await tabLabel(tabId), method, ok: true });
        return { id: req.id, result };
      } catch (e) {
        const error = (e as Error).message || String(e);
        log({ at: t0, ms: Date.now() - t0, tabId, tabLabel: await tabLabel(tabId), method, ok: false, error });
        return { id: req.id, error };
      }
    }
    throw new Error(`Unknown method ${(req as Req).method}`);
  } catch (e) {
    return { id: req.id, error: (e as Error).message || String(e) };
  }
}

async function connect() {
  clearTimeout(reconnectTimer);
  if (stopped || ws) return;
  const { token, port } = await cfg();
  if (!token) return; // unpaired is the expected initial state, not an error
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  ws = sock;
  sock.onopen = () => {
    backoff = 1000; lastError = undefined; connectedAt = Date.now(); companionVersion = undefined;
    const brands = ((navigator as any).userAgentData?.brands ?? []) as { brand: string; version: string }[];
    const named = brands.find((b) => !/Chromium|not.*brand/i.test(b.brand)) ?? brands.find((b) => /Chromium/.test(b.brand));
    const hello: HelloParams = { token, version: PROTOCOL_VERSION, extensionVersion: chrome.runtime.getManifest().version, browser: named ? `${named.brand} ${named.version}` : undefined, userAgent: navigator.userAgent };
    evt('hello', hello);
    pushTabs();
    sendToolPolicy();
  };
  sock.onmessage = async (m) => {
    let msg: Msg;
    try { msg = JSON.parse(m.data as string); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (isReq(msg)) send(await handle(msg));
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = undefined; connectedAt = undefined;
    if (e.code === 4003) { lastError = 'Companion rejected the token'; stopped = true; return; }
    if (e.code === 4002) { lastError = e.reason || 'Protocol version mismatch; update the extension'; stopped = true; return; }
    lastError = e.code === 1000 ? undefined : `Disconnected (${e.code})`;
    if (!stopped) { reconnectTimer = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15_000); }
  };
  sock.onerror = () => { lastError = 'Companion not reachable; is the MCP server running?'; };
}

async function stop(persist = true) {
  stopped = true;
  clearTimeout(reconnectTimer);
  for (const id of [...attached]) await detach(id);
  shared.clear(); shareAll = false;
  ws?.close(1000, 'stopped by user');
  ws = undefined;
  if (persist) { await chrome.storage.session.set({ shared: [] }); await chrome.storage.local.set({ shareAll: false, stopped: true }); }
}

async function state(): Promise<State> {
  const { port, token } = await cfg();
  const windows = (await chrome.windows.getAll()).filter((w) => w.id !== undefined).map((w) => ({ id: w.id!, focused: !!w.focused, incognito: w.incognito }));
  return {
    connected: ws?.readyState === WebSocket.OPEN, stopped, shareAll, activityLog, toolCatalog, disabledTools: [...disabledTools], companionVersion, devMode, port, hasToken: !!token, lastError, connectedAt,
    extensionVersion: chrome.runtime.getManifest().version, windows, tabs: await listTabs(), recent, totals,
  };
}

chrome.runtime.onMessage.addListener((msg: PopupMsg, _s, reply) => {
  (async () => {
    await ready; // a suspended worker restarts on this message; settings must be loaded before answering
    switch (msg.type) {
      case 'setConfig': {
        const token = msg.token || (await cfg()).token; // empty token = keep the current one (port-only change)
        await chrome.storage.local.set({ token, port: msg.port, stopped: false });
        stopped = false; ws?.close(1000, 'reconfigured'); ws = undefined; backoff = 1000;
        await connect(); break;
      }
      case 'connect': stopped = false; await chrome.storage.local.set({ stopped: false }); await connect(); break;
      case 'stop': await stop(); break;
      case 'clearLog': recent.length = 0; break;
      case 'setShared':
        for (const id of msg.tabIds) { if (msg.shared) shared.add(id); else { shared.delete(id); await detach(id); } }
        await chrome.storage.session.set({ shared: [...shared] });
        pushTabs(); break;
      case 'setDevMode': devMode = msg.mode; await chrome.storage.local.set({ devMode }); sendToolPolicy(); break;
      case 'setToolEnabled':
        if (msg.enabled) disabledTools.delete(msg.name); else disabledTools.add(msg.name);
        await chrome.storage.local.set({ disabledTools: [...disabledTools] }); sendToolPolicy(); break;
      case 'setToolsEnabled':
        for (const n of msg.names) { if (msg.enabled) disabledTools.delete(n); else disabledTools.add(n); }
        await chrome.storage.local.set({ disabledTools: [...disabledTools] }); sendToolPolicy(); break;
      case 'setActivityLog':
        activityLog = msg.on; if (!activityLog) recent.length = 0;
        await chrome.storage.local.set({ activityLog }); break;
      case 'setShareAll':
        shareAll = msg.on;
        if (!shareAll) for (const id of [...attached]) if (!shared.has(id)) await detach(id);
        await chrome.storage.local.set({ shareAll });
        pushTabs(); break;
      case 'focusTab': {
        const t = await chrome.tabs.update(msg.tabId, { active: true });
        if (t?.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true });
        break;
      }
    }
    reply(await state());
  })();
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const { tabId, sessionId } = source as { tabId?: number; sessionId?: string };
  if (tabId !== undefined) evt('cdp.event', { tabId, method, params, sessionId });
});
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (tabId === undefined) return;
  attached.delete(tabId);
  evt('detached', { tabId, reason });
  pushTabs();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (shared.delete(tabId)) chrome.storage.session.set({ shared: [...shared] });
  attached.delete(tabId); agentTabs.delete(tabId); held.delete(tabId); lastUsed.delete(tabId);
  pushTabs();
});

// Idle detach: the debugger (and Chrome's "started debugging" bar) only stays on tabs the agent is actively using,
// unless an inspection session holds the tab.
setInterval(async () => {
  const { idleDetachMs } = await chrome.storage.local.get('idleDetachMs');
  const limit = (idleDetachMs as number) || IDLE_DETACH_MS_DEFAULT;
  for (const id of [...attached]) if (!held.has(id) && Date.now() - (lastUsed.get(id) ?? 0) > limit) await detach(id);
}, 2000);
chrome.tabs.onCreated.addListener(() => pushTabs());
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.title || info.status === 'complete') pushTabs(); });

// Keepalive: WebSocket traffic keeps the MV3 worker alive; the alarm retries when disconnected.
setInterval(() => evt('ping'), 20_000);
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { if (!ws && !stopped) connect(); });

const ready = cfg().then((c) => { for (const id of c.shared) shared.add(id); shareAll = c.shareAll; activityLog = c.activityLog; toolCatalog = c.toolCatalog; disabledTools = new Set(c.disabledTools); devMode = c.devMode; stopped = c.stopped; if (!stopped) connect(); });
