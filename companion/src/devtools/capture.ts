// Per-tab inspection state: everything CDP streams at us while a devtools session is active,
// kept in bounded ring buffers so searches are cheap and memory stays flat.
import type { Sessions } from '../session.ts';
import { applyFetch } from './intercept.ts';

export interface StackFrame { functionName: string; url: string; line: number; col: number; scriptId?: string }
export interface ArgSummary { type: string; subtype?: string; description: string; objectId?: string; className?: string }
export interface ConsoleMsg {
  id: number; ts: number; kind: 'console' | 'exception' | 'log'; level: string; text: string; args?: ArgSummary[];
  url?: string; line?: number; col?: number; stack?: StackFrame[]; frameId?: string; contextId?: number; source?: string; exceptionObjectId?: string;
}
export interface Body { text?: string; base64?: boolean; bytes: number; truncated?: boolean; missing?: string }
export interface WsFrame { ts: number; dir: 'sent' | 'received'; opcode: number; payload: string }
export interface SseMsg { ts: number; event: string; data: string; eventId: string }
export interface NetReq {
  id: string; seq: number; ts: number; url: string; method: string; type: string; frameId?: string; documentURL?: string;
  initiator?: { type: string; url?: string; line?: number; stack?: StackFrame[] };
  requestHeaders: Record<string, string>; postData?: string; hasPostData?: boolean;
  status?: number; statusText?: string; responseHeaders?: Record<string, string>; mimeType?: string; remoteIP?: string; protocol?: string;
  fromCache?: boolean; fromServiceWorker?: boolean; timing?: Record<string, number>; securityState?: string; securityDetails?: Record<string, unknown>;
  encodedLength?: number; dataLength: number; finishedTs?: number; durationMs?: number; failed?: string; canceled?: boolean; blockedReason?: string;
  redirects: { url: string; status: number }[]; body?: Body; ws?: WsFrame[]; sse?: SseMsg[]; overridden?: string; mocked?: boolean;
}
export interface ScriptInfo { scriptId: string; url: string; startLine: number; endLine: number; length?: number; sourceMapURL?: string; isModule?: boolean; hash?: string; contextId?: number; embedderName?: string }
export interface StyleSheetInfo { styleSheetId: string; sourceURL: string; frameId?: string; origin: string; title?: string; length?: number; isInline?: boolean; sourceMapURL?: string }
export interface FrameInfo { id: string; parentId?: string; url: string; name?: string }
export interface ContextInfo { id: number; origin: string; name: string; frameId?: string; isDefault?: boolean; type?: string; uniqueId?: string }
export interface Paused { ts: number; reason: string; data?: unknown; hitBreakpoints?: string[]; callFrames: any[]; asyncStackTrace?: any }
export interface Issue { id: number; ts: number; code: string; details: unknown }
export interface Evt { id: number; ts: number; method: string; summary: string; params?: unknown }
export interface SwRegistration { registrationId: string; scopeURL: string; isDeleted?: boolean }
export interface SwVersion { versionId: string; registrationId: string; scriptURL: string; runningStatus: string; status: string; targetId?: string; controlledClients?: string[] }

export interface TabState {
  tabId: number; active: boolean; startedAt: number; stoppedAt?: number;
  opts: { bodies: boolean; maxBodyBytes: number; maxConsole: number; maxNetwork: number; maxEvents: number };
  dropped: { console: number; network: number; events: number; issues: number };
  seq: number;
  console: ConsoleMsg[]; network: NetReq[]; netIndex: Map<string, NetReq>; events: Evt[]; issues: Issue[];
  scripts: Map<string, ScriptInfo>; styleSheets: Map<string, StyleSheetInfo>; frames: Map<string, FrameInfo>; contexts: Map<number, ContextInfo>;
  paused?: Paused; pauseHistory: Paused[]; breakpoints: Map<string, { kind: string; description: string; enabled: boolean; raw?: unknown }>;
  security?: unknown; swRegistrations: Map<string, SwRegistration>; swVersions: Map<string, SwVersion>; swErrors: { ts: number; message: string; url?: string; line?: number }[];
  animations: { ts: number; id: string; name?: string; type: string; duration?: number; delay?: number; iterations?: number; easing?: string; playbackRate?: number }[];
  overrides: Map<string, { body: string; contentType?: string; status?: number; headers?: Record<string, string>; kind: 'override' | 'mock' }>;
  blocked: string[]; fetchEnabled: boolean; vitalsScriptId?: string; cleanups: (() => Promise<void>)[];
  waiters: Set<{ pred: (e: Evt) => boolean; resolve: (e: Evt) => void }>;
  recordings: { kind: string; startedAt: number; done: boolean; artifact?: string }[];
  /** MCP connection IDs using this session. stop() only tears down when the last one leaves. */
  users: Set<string>;
}

const headersOf = (h?: Record<string, string>) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
const frames = (st?: { callFrames?: any[]; parent?: any }): StackFrame[] | undefined => {
  if (!st?.callFrames) return undefined;
  const out: StackFrame[] = st.callFrames.map((f: any) => ({ functionName: f.functionName || '(anonymous)', url: f.url, line: f.lineNumber + 1, col: f.columnNumber + 1, scriptId: f.scriptId }));
  if (st.parent) { const p = frames(st.parent); if (p) out.push({ functionName: `— async ${st.parent.description ?? ''} —`, url: '', line: 0, col: 0 }, ...p); }
  return out.slice(0, 40);
};
export const summarizeArg = (a: any): ArgSummary => {
  if (!a) return { type: 'undefined', description: 'undefined' };
  if (a.type !== 'object' && a.type !== 'function') return { type: a.type, description: a.unserializableValue ?? (a.type === 'string' ? a.value : String(a.value ?? a.description)) };
  let description = a.description ?? a.className ?? a.type;
  if (a.preview?.properties) {
    const props = a.preview.properties.slice(0, 8).map((p: any) => `${p.name}: ${p.value ?? p.type}`).join(', ');
    description = a.subtype === 'array' ? `[${props}${a.preview.overflow ? ', …' : ''}]` : `${a.className ?? 'Object'} {${props}${a.preview.overflow ? ', …' : ''}}`;
  }
  return { type: a.type, subtype: a.subtype, description, objectId: a.objectId, className: a.className };
};

const VITALS_SCRIPT = `(() => { if (window.__bmcpVitalsInstalled) return; window.__bmcpVitalsInstalled = true;
  const V = window.__bmcpVitals = window.__bmcpVitals || {};
  const po = (type, cb, extra) => { try { new PerformanceObserver((l) => cb(l.getEntries())).observe(Object.assign({ type, buffered: true }, extra || {})); } catch {} };
  po('largest-contentful-paint', (es) => { const e = es[es.length - 1]; if (e) V.LCP = { value: Math.round(e.startTime), element: e.element && e.element.tagName, url: e.url || undefined }; });
  po('layout-shift', (es) => { let s = (V.CLS && V.CLS.value) || 0; for (const e of es) if (!e.hadRecentInput) s += e.value; V.CLS = { value: Math.round(s * 1000) / 1000 }; });
  po('event', (es) => { for (const e of es) { if (!V.INP || e.duration > V.INP.value) V.INP = { value: Math.round(e.duration), name: e.name, target: e.target && e.target.tagName }; } }, { durationThreshold: 16 });
  po('first-input', (es) => { const e = es[0]; if (e) V.FID = { value: Math.round(e.processingStart - e.startTime), name: e.name }; });
  po('paint', (es) => { for (const e of es) if (e.name === 'first-contentful-paint') V.FCP = { value: Math.round(e.startTime) }; });
  po('navigation', (es) => { const n = es[0]; if (n) V.TTFB = { value: Math.round(n.responseStart) }; });
  po('longtask', (es) => { V.longTasks = (V.longTasks || 0) + es.length; V.totalBlocking = Math.round((V.totalBlocking || 0) + es.reduce((a, e) => a + Math.max(0, e.duration - 50), 0)); });
})();`;

export class Capture {
  readonly states = new Map<number, TabState>();
  private sessions: Sessions;

  constructor(sessions: Sessions) {
    this.sessions = sessions;
    sessions.on('cdp.event', (e) => { if (e.sessionId) return; const st = this.states.get(e.tabId); if (st?.active) this.ingest(st, e.method, e.params); });
    sessions.on('detached', ({ tabId, reason }) => { const st = this.states.get(tabId); if (st?.active) { st.active = false; st.stoppedAt = Date.now(); this.push(st, 'companion.detached', `debugger detached: ${reason}`); } });
    sessions.on('disconnected', () => { for (const st of this.states.values()) if (st.active && sessions.modeOf(st.tabId) === 'extension') { st.active = false; st.stoppedAt = Date.now(); } });
  }

  get(tabId: number): TabState | undefined { return this.states.get(tabId); }
  require(tabId: number): TabState {
    const st = this.states.get(tabId);
    if (!st) throw new Error(`No inspection session for tab ${tabId}. Call devtools_session {action:"start", tabId:${tabId}} first.`);
    return st;
  }

  async start(tabId: number, opts: Partial<TabState['opts']> = {}, user = 'agent'): Promise<TabState> {
    let st = this.states.get(tabId);
    if (st?.active) { st.users.add(user); st.opts = { ...st.opts, ...opts }; return st; }
    if (!st) {
      st = {
        tabId, active: true, startedAt: Date.now(), opts: { bodies: false, maxBodyBytes: 1_000_000, maxConsole: 5000, maxNetwork: 5000, maxEvents: 5000, ...opts },
        dropped: { console: 0, network: 0, events: 0, issues: 0 }, seq: 0, console: [], network: [], netIndex: new Map(), events: [], issues: [],
        scripts: new Map(), styleSheets: new Map(), frames: new Map(), contexts: new Map(), pauseHistory: [], breakpoints: new Map(),
        swRegistrations: new Map(), swVersions: new Map(), swErrors: [], animations: [], overrides: new Map(), blocked: [], fetchEnabled: false, cleanups: [], waiters: new Set(), recordings: [], users: new Set(),
      };
      this.states.set(tabId, st);
    } else { st.active = true; st.stoppedAt = undefined; st.opts = { ...st.opts, ...opts }; }
    st.users.add(user);
    await this.sessions.hold(tabId, 'session', true);
    const cdp = (m: string, p?: unknown) => this.sessions.cdp(tabId, m, p).catch((e) => { this.push(st!, 'companion.enableFailed', `${m}: ${e.message}`); });
    await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Network.enable', { maxResourceBufferSize: 50_000_000, maxTotalBufferSize: 200_000_000 });
    await cdp('Debugger.enable'); await cdp('DOM.enable'); await cdp('CSS.enable'); await cdp('Audits.enable'); await cdp('Security.enable'); await cdp('ServiceWorker.enable'); await cdp('Animation.enable');
    await cdp('Runtime.setAsyncCallStackDepth', { maxDepth: 8 });
    // web vitals observer on every document from now on, and on the current one
    const r = await this.sessions.cdp(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source: VITALS_SCRIPT }).catch(() => undefined);
    st.vitalsScriptId = r?.identifier;
    await this.sessions.cdp(tabId, 'Runtime.evaluate', { expression: VITALS_SCRIPT }).catch(() => {});
    const tree = await this.sessions.cdp(tabId, 'Page.getFrameTree').catch(() => undefined);
    const walk = (n: any) => { if (!n) return; st!.frames.set(n.frame.id, { id: n.frame.id, parentId: n.frame.parentId, url: n.frame.url, name: n.frame.name }); for (const c of n.childFrames ?? []) walk(c); };
    walk(tree?.frameTree);
    return st;
  }

  /** Stop collecting and undo everything this session put in the browser. Data stays until clear().
   *  With several agents on the session, only the last one to leave triggers the teardown. */
  async stop(tabId: number, user = 'agent', force = false): Promise<string[]> {
    const st = this.states.get(tabId); if (!st) return [];
    st.users.delete(user);
    if (st.users.size && !force) return [`still in use by ${[...st.users].join(', ')}; session kept`];
    st.users.clear();
    st.active = false; st.stoppedAt = Date.now();
    const notes: string[] = [];
    const cdp = (m: string, p?: unknown) => this.sessions.cdp(tabId, m, p).catch((e) => { notes.push(`${m}: ${e.message}`); });
    for (const bp of st.breakpoints.keys()) await cdp('Debugger.removeBreakpoint', { breakpointId: bp });
    st.breakpoints.clear();
    if (st.paused) await cdp('Debugger.resume');
    st.overrides.clear();
    st.fetchEnabled = await applyFetch(this.sessions, tabId, []).catch(() => false); // keeps Fetch on only if a navigation policy needs it
    if (st.blocked.length) { await cdp('Network.setBlockedURLs', { urls: [] }); st.blocked = []; }
    for (const fn of st.cleanups.splice(0)) await fn().catch((e) => notes.push(String(e.message ?? e)));
    if (st.vitalsScriptId) { await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: st.vitalsScriptId }); st.vitalsScriptId = undefined; }
    await cdp('Debugger.setBlackboxPatterns', { patterns: [] });
    await cdp('Overlay.hideHighlight');
    for (const m of ['Animation.disable', 'ServiceWorker.disable', 'Security.disable', 'Audits.disable', 'CSS.disable', 'DOM.disable', 'Debugger.disable', 'Network.disable', 'Log.disable']) await cdp(m);
    await this.sessions.hold(tabId, 'session', false);
    return notes;
  }

  /** A disconnected transport leaves every inspection it joined, including inactive tabs. */
  async release(user: string): Promise<void> {
    await Promise.all([...this.states.values()].filter((st) => st.users.has(user)).map((st) => this.stop(st.tabId, user)));
  }

  clear(tabId: number, what: 'all' | 'console' | 'network' | 'events' | 'issues' = 'all') {
    const st = this.require(tabId);
    if (what === 'all' || what === 'console') { st.console = []; st.dropped.console = 0; }
    if (what === 'all' || what === 'network') { st.network = []; st.netIndex.clear(); st.dropped.network = 0; }
    if (what === 'all' || what === 'events') { st.events = []; st.dropped.events = 0; }
    if (what === 'all' || what === 'issues') { st.issues = []; st.dropped.issues = 0; }
    if (what === 'all') { st.pauseHistory = []; st.animations = []; st.swErrors = []; st.startedAt = Date.now(); }
  }

  /** Resolve when an event matching pred arrives (or null on timeout). Checks the buffer first when `sinceId` is given. */
  waitFor(tabId: number, pred: (e: Evt) => boolean, timeoutMs: number, sinceId?: number): Promise<Evt | null> {
    const st = this.require(tabId);
    if (sinceId !== undefined) { const hit = st.events.find((e) => e.id > sinceId && pred(e)); if (hit) return Promise.resolve(hit); }
    return new Promise((resolve) => {
      const w = { pred, resolve: (e: Evt) => { clearTimeout(t); st.waiters.delete(w); resolve(e); } };
      const t = setTimeout(() => { st.waiters.delete(w); resolve(null); }, timeoutMs);
      st.waiters.add(w);
    });
  }

  push(st: TabState, method: string, summary: string, params?: unknown): Evt {
    const e: Evt = { id: ++st.seq, ts: Date.now(), method, summary, params };
    st.events.push(e); if (st.events.length > st.opts.maxEvents) { st.events.shift(); st.dropped.events++; }
    for (const w of [...st.waiters]) if (w.pred(e)) w.resolve(e);
    return e;
  }

  private ingest(st: TabState, method: string, p: any) {
    const tabId = st.tabId;
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const args = (p.args ?? []).map(summarizeArg);
        const top = p.stackTrace?.callFrames?.[0];
        const level = ({ error: 'error', warning: 'warning', warn: 'warning', info: 'info', debug: 'debug', assert: 'error', trace: 'trace' } as Record<string, string>)[p.type] ?? 'log';
        this.addConsole(st, { kind: 'console', level, text: args.map((a: ArgSummary) => a.description).join(' '), args, url: top?.url, line: top && top.lineNumber + 1, col: top && top.columnNumber + 1, stack: frames(p.stackTrace), contextId: p.executionContextId, source: p.type });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails;
        const text = d.exception?.description ?? d.text ?? 'Uncaught exception';
        this.addConsole(st, { kind: 'exception', level: 'error', text: text.split('\n')[0] + (d.exception?.description && !d.exception.description.includes('\n') ? '' : ''), url: d.url ?? d.stackTrace?.callFrames?.[0]?.url, line: d.lineNumber + 1, col: d.columnNumber + 1, stack: frames(d.stackTrace) ?? (d.exception?.description ? parseStack(d.exception.description) : undefined), contextId: d.executionContextId, exceptionObjectId: d.exception?.objectId, args: d.exception ? [summarizeArg(d.exception)] : undefined });
        break;
      }
      case 'Log.entryAdded': {
        const e = p.entry;
        this.addConsole(st, { kind: 'log', level: e.level, text: e.text, url: e.url, line: e.lineNumber !== undefined ? e.lineNumber + 1 : undefined, stack: frames(e.stackTrace), source: e.source });
        break;
      }
      case 'Runtime.executionContextCreated': { const c = p.context; st.contexts.set(c.id, { id: c.id, origin: c.origin, name: c.name, frameId: c.auxData?.frameId, isDefault: c.auxData?.isDefault, type: c.auxData?.type, uniqueId: c.uniqueId }); break; }
      case 'Runtime.executionContextDestroyed': st.contexts.delete(p.executionContextId); break;
      case 'Runtime.executionContextsCleared': st.contexts.clear(); break;

      case 'Network.requestWillBeSent': {
        let r = st.netIndex.get(p.requestId);
        if (r && p.redirectResponse) { r.redirects.push({ url: r.url, status: p.redirectResponse.status }); r.url = p.request.url; r.requestHeaders = headersOf(p.request.headers); r.ts = p.wallTime * 1000; break; }
        r = { id: p.requestId, seq: ++st.seq, ts: Math.round(p.wallTime * 1000), url: p.request.url, method: p.request.method, type: p.type ?? 'Other', frameId: p.frameId, documentURL: p.documentURL,
          initiator: p.initiator && { type: p.initiator.type, url: p.initiator.url, line: p.initiator.lineNumber !== undefined ? p.initiator.lineNumber + 1 : undefined, stack: frames(p.initiator.stack) },
          requestHeaders: headersOf(p.request.headers), postData: p.request.postData, hasPostData: p.request.hasPostData, dataLength: 0, redirects: [] };
        st.network.push(r); st.netIndex.set(r.id, r);
        if (st.network.length > st.opts.maxNetwork) { const gone = st.network.shift()!; st.netIndex.delete(gone.id); st.dropped.network++; }
        this.push(st, method, `${r.method} ${r.url}`, { requestId: r.id });
        break;
      }
      case 'Network.requestWillBeSentExtraInfo': { const r = st.netIndex.get(p.requestId); if (r) r.requestHeaders = { ...r.requestHeaders, ...headersOf(p.headers) }; break; }
      case 'Network.responseReceived': {
        const r = st.netIndex.get(p.requestId); if (!r) break;
        const s = p.response;
        Object.assign(r, { status: s.status, statusText: s.statusText, responseHeaders: { ...(r.responseHeaders ?? {}), ...headersOf(s.headers) }, mimeType: s.mimeType, remoteIP: s.remoteIPAddress, protocol: s.protocol, fromCache: s.fromDiskCache || s.fromPrefetchCache, fromServiceWorker: s.fromServiceWorker, timing: s.timing, securityState: s.securityState, type: p.type ?? r.type });
        if (s.securityDetails) r.securityDetails = { protocol: s.securityDetails.protocol, cipher: s.securityDetails.cipher, keyExchange: s.securityDetails.keyExchange, subjectName: s.securityDetails.subjectName, issuer: s.securityDetails.issuer, validFrom: s.securityDetails.validFrom, validTo: s.securityDetails.validTo, sanList: s.securityDetails.sanList?.slice(0, 10) };
        break;
      }
      case 'Network.responseReceivedExtraInfo': { const r = st.netIndex.get(p.requestId); if (r) { r.responseHeaders = { ...(r.responseHeaders ?? {}), ...headersOf(p.headers) }; if (p.statusCode && !r.status) r.status = p.statusCode; } break; }
      case 'Network.dataReceived': { const r = st.netIndex.get(p.requestId); if (r) r.dataLength += p.dataLength; break; }
      case 'Network.loadingFinished': {
        const r = st.netIndex.get(p.requestId); if (!r) break;
        r.encodedLength = p.encodedDataLength; r.finishedTs = Date.now(); r.durationMs = r.timing ? Math.round((p.timestamp - r.timing.requestTime) * 1000) : undefined;
        this.push(st, method, `${r.status ?? '?'} ${r.method} ${r.url} (${p.encodedDataLength} B)`, { requestId: r.id });
        if (st.opts.bodies && r.type !== 'WebSocket') this.fetchBody(st, r);
        else if (!r.body) r.body = { missing: st.opts.bodies ? 'not captured' : 'body capture is off; start the session with bodies:true or fetch with devtools_network {action:"body"}', bytes: r.dataLength };
        break;
      }
      case 'Network.loadingFailed': {
        const r = st.netIndex.get(p.requestId); if (!r) break;
        r.failed = p.errorText; r.canceled = p.canceled; r.blockedReason = p.blockedReason; r.finishedTs = Date.now();
        this.push(st, method, `FAILED ${r.method} ${r.url}: ${p.errorText}${p.blockedReason ? ` (${p.blockedReason})` : ''}`, { requestId: r.id });
        break;
      }
      case 'Network.webSocketCreated': {
        const r: NetReq = { id: p.requestId, seq: ++st.seq, ts: Date.now(), url: p.url, method: 'GET', type: 'WebSocket', requestHeaders: {}, dataLength: 0, redirects: [], ws: [], initiator: p.initiator && { type: p.initiator.type, url: p.initiator.url, stack: frames(p.initiator.stack) } };
        st.network.push(r); st.netIndex.set(r.id, r); this.push(st, method, `WS ${p.url}`, { requestId: r.id }); break;
      }
      case 'Network.webSocketWillSendHandshakeRequest': { const r = st.netIndex.get(p.requestId); if (r) r.requestHeaders = headersOf(p.request.headers); break; }
      case 'Network.webSocketHandshakeResponseReceived': { const r = st.netIndex.get(p.requestId); if (r) { r.status = p.response.status; r.statusText = p.response.statusText; r.responseHeaders = headersOf(p.response.headers); } break; }
      case 'Network.webSocketFrameSent': case 'Network.webSocketFrameReceived': {
        const r = st.netIndex.get(p.requestId); if (!r?.ws) break;
        r.ws.push({ ts: Date.now(), dir: method.endsWith('Sent') ? 'sent' : 'received', opcode: p.response.opcode, payload: String(p.response.payloadData).slice(0, 10_000) });
        if (r.ws.length > 1000) r.ws.shift();
        break;
      }
      case 'Network.webSocketClosed': { const r = st.netIndex.get(p.requestId); if (r) r.finishedTs = Date.now(); break; }
      case 'Network.eventSourceMessageReceived': { const r = st.netIndex.get(p.requestId); if (!r) break; (r.sse ??= []).push({ ts: Date.now(), event: p.eventName, data: String(p.data).slice(0, 10_000), eventId: p.eventId }); if (r.sse.length > 1000) r.sse.shift(); break; }

      case 'Debugger.scriptParsed': st.scripts.set(p.scriptId, { scriptId: p.scriptId, url: p.url, startLine: p.startLine, endLine: p.endLine, length: p.length, sourceMapURL: p.sourceMapURL || undefined, isModule: p.isModule, hash: p.hash, contextId: p.executionContextId, embedderName: p.embedderName }); break;
      case 'Debugger.paused': {
        st.paused = { ts: Date.now(), reason: p.reason, data: p.data, hitBreakpoints: p.hitBreakpoints, callFrames: p.callFrames, asyncStackTrace: p.asyncStackTrace };
        st.pauseHistory.push(st.paused); if (st.pauseHistory.length > 50) st.pauseHistory.shift();
        const top = p.callFrames?.[0];
        this.push(st, method, `paused (${p.reason}) at ${top?.functionName || '(anonymous)'} ${top?.url ?? ''}:${(top?.location?.lineNumber ?? -1) + 1}`, { reason: p.reason, hitBreakpoints: p.hitBreakpoints });
        break;
      }
      case 'Debugger.resumed': st.paused = undefined; this.push(st, method, 'resumed'); break;
      case 'CSS.styleSheetAdded': { const h = p.header; st.styleSheets.set(h.styleSheetId, { styleSheetId: h.styleSheetId, sourceURL: h.sourceURL, frameId: h.frameId, origin: h.origin, title: h.title, length: h.length, isInline: h.isInline, sourceMapURL: h.sourceMapURL || undefined }); break; }
      case 'CSS.styleSheetRemoved': st.styleSheets.delete(p.styleSheetId); break;
      case 'Page.frameNavigated': { const f = p.frame; st.frames.set(f.id, { id: f.id, parentId: f.parentId, url: f.url, name: f.name }); if (!f.parentId) { st.scripts.clear(); st.styleSheets.clear(); this.push(st, method, `navigated to ${f.url}`, { url: f.url, type: p.type }); } break; }
      case 'Page.frameDetached': st.frames.delete(p.frameId); break;
      case 'Page.loadEventFired': this.push(st, method, 'load'); break;
      case 'Page.domContentEventFired': this.push(st, method, 'DOMContentLoaded'); break;
      case 'Page.javascriptDialogOpening': this.push(st, method, `${p.type} dialog: ${p.message}`, p); break;
      case 'Audits.issueAdded': { const i = p.issue; st.issues.push({ id: ++st.seq, ts: Date.now(), code: i.code, details: i.details }); if (st.issues.length > 1000) { st.issues.shift(); st.dropped.issues++; } this.push(st, method, i.code, { code: i.code }); break; }
      case 'Security.visibleSecurityStateChanged': st.security = p.visibleSecurityState; break;
      case 'ServiceWorker.workerRegistrationUpdated': for (const r of p.registrations) st.swRegistrations.set(r.registrationId, r); break;
      case 'ServiceWorker.workerVersionUpdated': for (const v of p.versions) { st.swVersions.set(v.versionId, v); } this.push(st, method, p.versions.map((v: any) => `${v.status}/${v.runningStatus} ${v.scriptURL}`).join('; ')); break;
      case 'ServiceWorker.workerErrorReported': { const e = p.errorMessage; st.swErrors.push({ ts: Date.now(), message: e.errorMessage, url: e.sourceURL, line: e.lineNumber }); this.push(st, method, e.errorMessage); break; }
      case 'Animation.animationStarted': { const a = p.animation; st.animations.push({ ts: Date.now(), id: a.id, name: a.name, type: a.type, duration: a.source?.duration, delay: a.source?.delay, iterations: a.source?.iterations, easing: a.source?.easing, playbackRate: a.playbackRate }); if (st.animations.length > 500) st.animations.shift(); this.push(st, method, `${a.type} ${a.name || a.id} ${a.source?.duration ?? '?'}ms`); break; }
      case 'Tracing.tracingComplete': this.push(st, method, 'tracing complete'); break;
      default: if (/^(Fetch\.|Media\.|WebAudio\.|WebAuthn\.|Target\.)/.test(method)) this.push(st, method, JSON.stringify(p).slice(0, 200), p);
    }
    void tabId;
  }

  private addConsole(st: TabState, m: Omit<ConsoleMsg, 'id' | 'ts'>) {
    const msg: ConsoleMsg = { id: ++st.seq, ts: Date.now(), ...m };
    st.console.push(msg); if (st.console.length > st.opts.maxConsole) { st.console.shift(); st.dropped.console++; }
    this.push(st, msg.kind === 'exception' ? 'Runtime.exceptionThrown' : 'console', `[${msg.level}] ${msg.text.slice(0, 200)}`, { consoleId: msg.id, level: msg.level });
  }

  async fetchBody(st: TabState, r: NetReq): Promise<Body> {
    try {
      const b = await this.sessions.cdp(st.tabId, 'Network.getResponseBody', { requestId: r.id });
      const bytes = b.base64Encoded ? Math.floor(b.body.length * 3 / 4) : Buffer.byteLength(b.body);
      const max = st.opts.maxBodyBytes;
      const truncated = bytes > max;
      r.body = { text: truncated ? b.body.slice(0, max) : b.body, base64: b.base64Encoded, bytes, truncated };
    } catch (e) { r.body = { missing: `unavailable: ${(e as Error).message.replace(/^.*?: /, '')}`, bytes: r.dataLength }; }
    return r.body!;
  }
}

function parseStack(desc: string): StackFrame[] | undefined {
  const out: StackFrame[] = [];
  for (const line of desc.split('\n').slice(1)) {
    const m = /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line.trim());
    if (m) out.push({ functionName: m[1] || '(anonymous)', url: m[2], line: Number(m[3]), col: Number(m[4]) });
  }
  return out.length ? out : undefined;
}
