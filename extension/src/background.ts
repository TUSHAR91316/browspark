import {
  DEFAULT_PORT, PROTOCOL_VERSION, isReq, isNewTab, unsupportedReason,
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
const agentTabs = new Set<number>();     // ordinary browser tabs the agent opened
let devMode: 'auto' | 'always' | 'never' = 'auto';
const held = new Set<number>();          // tabs with an active inspection session: never idle-detach
const ownedDownloads = new Map<string, { guid: string; tabId: number; url: string; filename: string; state: string; receivedBytes: number; totalBytes: number; startedAt: number }>();
const windowBounds = new Map<number, { width?: number; height?: number; state?: string }>(); // originals, restored after emulation
const lastUsed = new Map<number, number>();
const IDLE_DETACH_MS_DEFAULT = 30_000;
const recent: OpLog[] = [];
const totals = { ops: 0, errors: 0 };
let opSeq = 0;
let connectedAt: number | undefined;
let connecting = false;
let connectionAttempt = 0;
let ws: WebSocket | undefined;
let stopped = false;
let lastError: string | undefined;
let backoff = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connectionTimer: ReturnType<typeof setTimeout> | undefined;

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
    id: t.id!, url: t.url || '', title: t.title || '', shared: isShared(t.id!) && (!unsupportedReason(t.url || '') || isNewTab(t.url || '')), attached: attached.has(t.id!),
    windowId: t.windowId, agent: agentTabs.has(t.id!) || undefined, favIconUrl: t.favIconUrl, unsupported: unsupportedReason(t.url || ''),
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
    if (req.method === 'tabs.prepare') {
      const { tabId } = req.params as { tabId: number };
      if (!isShared(tabId)) throw new Error(`Tab ${tabId} is not shared by the user`);
      const tab = await chrome.tabs.get(tabId);
      if (!isNewTab(tab.url || '')) return { id: req.id, result: { prepared: false } };
      // Chrome blocks debugger attachment to its New Tab UI. Prepare the same tab
      // only for an explicit navigation; the destination still uses normal CDP.
      await chrome.tabs.update(tabId, { url: 'about:blank' });
      for (let i = 0; i < 100; i++) {
        const current = await chrome.tabs.get(tabId);
        if (!isShared(tabId)) throw new Error(`Tab ${tabId} was unshared by the user`);
        if (current.url === 'about:blank' && !current.pendingUrl && current.status === 'complete') {
          await pushTabs();
          return { id: req.id, result: { prepared: true } };
        }
        if (current.url && current.url !== 'about:blank' && !isNewTab(current.url)) throw new Error(`Tab ${tabId} navigated elsewhere while preparing; retry with its current state`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out preparing New Tab ${tabId} for navigation`);
    }
    if (req.method === 'tools.catalog') {
      const p = req.params as { tools: ToolInfo[]; version?: string };
      toolCatalog = p.tools; companionVersion = p.version;
      await chrome.storage.local.set({ toolCatalog });
      sendToolPolicy(); // the companion applies whatever the user had switched off
      return { id: req.id, result: { received: toolCatalog.length } };
    }
    if (req.method === 'tabs.create') {
      // Tabs the agent opens are ordinary Chrome tabs, shared automatically because it created them.
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
      // CDP identifies the originating tab. The downloads API has no tab id, so
      // matching its URLs/referrers can leak another tab's files on the same site.
      return { id: req.id, result: [...ownedDownloads.values()].filter((d) => isShared(d.tabId)).reverse() };
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
      const { tabId, method, params, sessionId, client } = req.params as CdpParams;
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
        log({ at: t0, ms: Date.now() - t0, tabId, tabLabel: await tabLabel(tabId), method, ok: true, client });
        return { id: req.id, result };
      } catch (e) {
        const error = (e as Error).message || String(e);
        log({ at: t0, ms: Date.now() - t0, tabId, tabLabel: await tabLabel(tabId), method, ok: false, error, client });
        return { id: req.id, error };
      }
    }
    throw new Error(`Unknown method ${(req as Req).method}`);
  } catch (e) {
    return { id: req.id, error: (e as Error).message || String(e) };
  }
}

async function connect(force = false) {
  if (stopped || (!force && (ws || connecting))) return;
  const attempt = ++connectionAttempt;
  clearTimeout(reconnectTimer);
  clearTimeout(connectionTimer);
  const previous = ws;
  ws = undefined; connecting = true; connectedAt = undefined; companionVersion = undefined;
  if (force) { backoff = 1000; lastError = undefined; }
  // Finish closing the old connection before opening its replacement.
  if (previous && previous.readyState !== WebSocket.CLOSED) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      previous.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      previous.close(1000, 'reconnecting');
    });
  }
  const { token, port } = await cfg();
  if (attempt !== connectionAttempt || stopped) return;
  if (!token) { connecting = false; return; } // unpaired is expected, not an error
  let sock: WebSocket;
  try { sock = new WebSocket(`ws://127.0.0.1:${port}`); }
  catch { connecting = false; lastError = 'Invalid bridge address. Check the port in Settings.'; return; }
  ws = sock;
  const disconnected = (error?: string) => {
    if (ws !== sock) return;
    clearTimeout(connectionTimer);
    ws = undefined; connecting = false; connectedAt = undefined; companionVersion = undefined; lastError = error;
    if (!stopped) { reconnectTimer = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15_000); }
  };
  connectionTimer = setTimeout(() => {
    if (ws !== sock) return;
    disconnected('Companion did not respond. Check that the MCP server is running.');
    sock.close(1000, 'connection timed out');
  }, 10_000);
  sock.onopen = () => {
    if (ws !== sock) return;
    const brands = ((navigator as any).userAgentData?.brands ?? []) as { brand: string; version: string }[];
    const named = brands.find((b) => !/Chromium|not.*brand/i.test(b.brand)) ?? brands.find((b) => /Chromium/.test(b.brand));
    const hello: HelloParams = { token, version: PROTOCOL_VERSION, extensionVersion: chrome.runtime.getManifest().version, browser: named ? `${named.brand} ${named.version}` : undefined, userAgent: navigator.userAgent };
    evt('hello', hello);
    pushTabs();
    sendToolPolicy();
  };
  sock.onmessage = async (m) => {
    if (ws !== sock) return;
    let msg: Msg;
    try { msg = JSON.parse(m.data as string); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (isReq(msg)) {
      // A response from the paired companion confirms readiness, not merely an open socket.
      if (connecting) { connecting = false; connectedAt = Date.now(); lastError = undefined; backoff = 1000; clearTimeout(connectionTimer); }
      const response = await handle(msg);
      if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(response));
    }
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    if (e.code === 4003) { stopped = true; disconnected('Companion rejected the token'); return; }
    if (e.code === 4002) { stopped = true; disconnected(e.reason || 'Protocol version mismatch; update the extension'); return; }
    disconnected(lastError ?? (e.code === 1000 ? 'Companion disconnected. Retrying automatically.' : `Disconnected (${e.code}). Retrying automatically.`));
  };
  sock.onerror = () => { if (ws === sock) lastError = 'Companion not reachable; is the MCP server running?'; };
}

async function stop(persist = true) {
  stopped = true;
  connectionAttempt++;
  clearTimeout(reconnectTimer);
  clearTimeout(connectionTimer);
  const previous = ws;
  ws = undefined; connecting = false; connectedAt = undefined; companionVersion = undefined; lastError = undefined;
  previous?.close(1000, 'stopped by user');
  for (const id of [...attached]) await detach(id);
  shared.clear(); shareAll = false;
  if (persist) { await chrome.storage.session.set({ shared: [] }); await chrome.storage.local.set({ shareAll: false, stopped: true }); }
}

async function state(): Promise<State> {
  const { port, token } = await cfg();
  const windows = (await chrome.windows.getAll()).filter((w) => w.id !== undefined).map((w) => ({ id: w.id!, incognito: w.incognito }));
  return {
    connected: ws?.readyState === WebSocket.OPEN && connectedAt !== undefined, connecting: connecting && !lastError, stopped, shareAll, activityLog, toolCatalog, disabledTools: [...disabledTools], companionVersion, devMode, token, port, hasToken: !!token, lastError, connectedAt,
    extensionVersion: chrome.runtime.getManifest().version, windows, tabs: await listTabs(), recent, totals,
  };
}

chrome.runtime.onMessage.addListener((msg: PopupMsg, _s, reply) => {
  (async () => {
    await ready; // a suspended worker restarts on this message; settings must be loaded before answering
    switch (msg.type) {
      case 'setConfig': {
        const token = msg.token || (await cfg()).token; // empty token = keep the current one (port-only change)
        stopped = false;
        await chrome.storage.local.set({ token, port: msg.port, stopped: false });
        await connect(true); break;
      }
      case 'connect': stopped = false; await chrome.storage.local.set({ stopped: false }); await connect(true); break;
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
  if (tabId === undefined) return;
  if (method === 'Page.downloadWillBegin' && isShared(tabId)) {
    const p = params as { guid: string; url: string; suggestedFilename: string };
    ownedDownloads.set(p.guid, { guid: p.guid, tabId, url: p.url, filename: p.suggestedFilename, state: 'inProgress', receivedBytes: 0, totalBytes: 0, startedAt: Date.now() });
    if (ownedDownloads.size > 50) ownedDownloads.delete(ownedDownloads.keys().next().value!);
  } else if (method === 'Page.downloadProgress') {
    const p = params as { guid: string; state: string; receivedBytes: number; totalBytes: number };
    const download = ownedDownloads.get(p.guid);
    if (download?.tabId === tabId) Object.assign(download, { state: p.state, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes });
  }
  evt('cdp.event', { tabId, method, params, sessionId });
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
