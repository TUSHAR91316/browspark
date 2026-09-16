// Firefox's native BiDi network/storage events, translated at the transport boundary.
import { globToRegex } from './devtools/network.ts';

type Send = (method: string, params?: any) => Promise<any>;
type Emit = (tabId: number, method: string, params: any) => void;
type Pattern = { urlPattern?: string; requestStage?: string; resourceType?: string };
interface State {
  context: string; enabled: boolean; subscription?: string; collector?: string; bodyError?: string;
  intercept?: string; patterns: Pattern[]; blocked: string[];
  changing?: Promise<void>;
  pending: Map<string, 'Request' | 'Response'>;
  requests: Map<string, { ts: number; response?: any }>;
}
const events = ['network.beforeRequestSent', 'network.responseStarted', 'network.responseCompleted', 'network.fetchError'];
const bytes = (v: any): string => v?.type === 'base64' ? Buffer.from(v.value, 'base64').toString('utf8') : String(v?.value ?? '');
const headers = (hs: any[] = []): Record<string, string> => {
  const result: Record<string, string> = Object.create(null);
  for (const h of hs) { const name = h.name.toLowerCase(); result[name] = result[name] === undefined ? bytes(h.value) : result[name] + '\n' + bytes(h.value); }
  return result;
};
const bidiHeaders = (hs: { name: string; value: string }[]) => hs.map(({ name, value }) => ({ name, value: { type: 'string', value } }));
const resourceType = (r: any) => ({ document: 'Document', iframe: 'Document', script: 'Script', style: 'Stylesheet', image: 'Image', font: 'Font', audio: 'Media', video: 'Media' } as Record<string, string>)[r.destination] ?? (r.initiatorType === 'xmlhttprequest' ? 'XHR' : r.initiatorType === 'fetch' ? 'Fetch' : 'Other');
const unsupported = (method: string, detail = '') => new Error(`${method} is unsupported in Firefox WebDriver BiDi${detail ? ': ' + detail : '.'}`);
const cookieMatches = (c: any, u: URL) => {
  const domain = c.domain.replace(/^\./, '').toLowerCase(), path = c.path || '/';
  return (u.hostname === domain || c.domain.startsWith('.') && u.hostname.endsWith('.' + domain)) &&
    (!c.secure || u.protocol === 'https:') && (u.pathname === path || u.pathname.startsWith(path.endsWith('/') ? path : path + '/'));
};

export class FirefoxNetwork {
  private send: Send;
  private emit: Emit;
  private states = new Map<number, State>();
  constructor(send: Send, emit: Emit) { this.send = send; this.emit = emit; }
  handles(method: string) { return /^(Network|Fetch)\./.test(method) || /^Storage\.(getCookies|setCookies|clearCookies)$/.test(method); }

  private state(tabId: number, context: string): State {
    let st = this.states.get(tabId);
    if (!st) { st = { context, enabled: false, patterns: [], blocked: [], pending: new Map(), requests: new Map() }; this.states.set(tabId, st); }
    return st;
  }
  private async subscribe(st: State) {
    if (!st.subscription) st.subscription = (await this.send('session.subscribe', { events, contexts: [st.context] })).subscription;
  }
  private async unsubscribe(st: State) {
    if (st.subscription && !st.enabled && !st.intercept) {
      await this.send('session.unsubscribe', { subscriptions: [st.subscription] }); st.subscription = undefined;
    }
  }
  private intercept(st: State, changes: { patterns?: Pattern[]; blocked?: string[] }): Promise<void> {
    // Several MCP clients can update the same tab; replacing a native intercept takes two commands.
    return st.changing = (st.changing ?? Promise.resolve()).catch(() => {}).then(async () => {
      const previous = { patterns: st.patterns, blocked: st.blocked }, patterns = changes.patterns ?? st.patterns, blocked = changes.blocked ?? st.blocked;
      let next: string | undefined;
      st.patterns = patterns; st.blocked = blocked;
      try {
        if (patterns.length || blocked.length) {
          await this.subscribe(st);
          // ponytail: broad interception preserves our existing arbitrary URL globs; optimize only if matching becomes a bottleneck.
          const phases = ['beforeRequestSent'];
          if (patterns.some((p) => p.requestStage === 'Response')) phases.push('responseStarted');
          next = (await this.send('network.addIntercept', { contexts: [st.context], phases })).intercept;
        }
        if (st.intercept) await this.send('network.removeIntercept', { intercept: st.intercept });
      } catch (e) {
        Object.assign(st, previous);
        if (next) await this.send('network.removeIntercept', { intercept: next });
        throw e;
      }
      st.intercept = next;
      if (!next) for (const [request, phase] of st.pending) {
        await this.send(phase === 'Response' ? 'network.continueResponse' : 'network.continueRequest', { request }); st.pending.delete(request);
      }
      await this.unsubscribe(st);
    });
  }

  async handle(tabId: number, context: string, method: string, p: any = {}): Promise<any> {
    const st = this.state(tabId, context), partition = { type: 'context', context };
    switch (method) {
      case 'Network.enable': {
        await this.subscribe(st); st.enabled = true;
        if (!st.collector && !st.bodyError) {
          try { st.collector = (await this.send('network.addDataCollector', { contexts: [context], dataTypes: ['response'], maxEncodedDataSize: p.maxResourceBufferSize ?? 50_000_000 })).collector; }
          catch (e) { st.bodyError = `Firefox response body capture unavailable: ${(e as Error).message}`; this.emit(tabId, 'companion.enableFailed', { method: 'network.addDataCollector', message: st.bodyError }); }
        }
        return {};
      }
      case 'Network.disable': {
        if (st.collector) { await this.send('network.removeDataCollector', { collector: st.collector }); st.collector = undefined; }
        st.enabled = false; st.bodyError = undefined; st.requests.clear(); await this.unsubscribe(st); return {};
      }
      case 'Network.getResponseBody': {
        if (!st.collector) throw unsupported(method, st.bodyError ?? 'start an inspection session before the request');
        if (!st.requests.has(p.requestId)) throw new Error(`Unknown Firefox requestId ${p.requestId} for tab ${tabId}`);
        const r = await this.send('network.getData', { collector: st.collector, request: p.requestId, dataType: 'response' });
        return { body: r.bytes.value, base64Encoded: r.bytes.type === 'base64' };
      }
      case 'Network.setCacheDisabled': return this.send('network.setCacheBehavior', { contexts: [context], cacheBehavior: p.cacheDisabled ? 'bypass' : 'default' });
      case 'Network.setExtraHTTPHeaders': return this.send('network.setExtraHeaders', { contexts: [context], headers: bidiHeaders(Object.entries(p.headers).map(([name, value]) => ({ name, value: String(value) }))) });
      case 'Network.setBlockedURLs': await this.intercept(st, { blocked: p.urls }); return {};
      case 'Fetch.enable': {
        if (p.handleAuthRequests) throw unsupported(method, 'authentication interception');
        const patterns: Pattern[] = p.patterns ?? [{}];
        if (patterns.some((v) => v.requestStage && !['Request', 'Response'].includes(v.requestStage))) throw new Error('Unknown Fetch requestStage');
        await this.intercept(st, { patterns }); return {};
      }
      case 'Fetch.disable': await this.intercept(st, { patterns: [] }); return {};
      case 'Fetch.continueRequest': case 'Fetch.continueResponse': case 'Fetch.failRequest': case 'Fetch.fulfillRequest': {
        const phase = st.pending.get(p.requestId);
        if (!phase) throw new Error(`Unknown paused Firefox requestId ${p.requestId} for tab ${tabId}`);
        let command: string, params: any = { request: p.requestId };
        if (method === 'Fetch.failRequest') command = 'network.failRequest';
        else if (method === 'Fetch.continueRequest') {
          if (p.interceptResponse !== undefined) throw unsupported(method, 'per-request response interception');
          command = phase === 'Response' ? 'network.continueResponse' : 'network.continueRequest';
          if (phase === 'Response' && ['url', 'method', 'headers', 'postData'].some((k) => p[k] !== undefined)) throw unsupported(method, 'request changes after response started');
          for (const k of ['url', 'method']) if (p[k] !== undefined) params[k] = p[k];
          if (p.headers !== undefined) params.headers = bidiHeaders(p.headers);
          if (p.postData !== undefined) params.body = { type: 'base64', value: p.postData };
        } else {
          command = method === 'Fetch.fulfillRequest' ? 'network.provideResponse' : 'network.continueResponse';
          if (method === 'Fetch.fulfillRequest' && phase !== 'Request') throw unsupported(method, 'Firefox can only replace a response at the request stage');
          if (method === 'Fetch.continueResponse' && phase !== 'Response') throw new Error('Request is not paused at response stage');
          if (p.binaryResponseHeaders !== undefined) throw unsupported(method, 'binary response headers');
          if (method === 'Fetch.continueResponse' && p.responseHeaders !== undefined) throw unsupported(method, 'Firefox cannot reliably replace all response headers; use a request-stage mock');
          if (p.responseCode !== undefined) params.statusCode = p.responseCode;
          if (p.responsePhrase !== undefined) params.reasonPhrase = p.responsePhrase;
          if (p.responseHeaders !== undefined) params.headers = bidiHeaders(p.responseHeaders);
          if (p.body !== undefined) params.body = { type: 'base64', value: p.body };
        }
        const r = await this.send(command, params); st.pending.delete(p.requestId); return r;
      }
      case 'Network.getCookies': case 'Network.getAllCookies': case 'Storage.getCookies': {
        let urls: URL[] | undefined;
        if (method === 'Network.getCookies') urls = (p.urls ?? [(await this.send('browsingContext.getTree', { root: context, maxDepth: 0 })).contexts[0].url]).map((url: string) => new URL(url));
        const r = await this.send('storage.getCookies', { partition });
        return { cookies: r.cookies.filter((c: any) => !urls || urls.some((u) => cookieMatches(c, u))).map((c: any) => ({ ...c, value: bytes(c.value), expires: c.expiry ?? -1, session: c.expiry == null, sameSite: c.sameSite && c.sameSite !== 'default' ? c.sameSite[0].toUpperCase() + c.sameSite.slice(1) : undefined })) };
      }
      case 'Network.setCookie': case 'Network.setCookies': case 'Storage.setCookies': {
        for (const c of method === 'Network.setCookie' ? [p] : p.cookies) {
          for (const key of ['partitionKey', 'sameParty', 'sourceScheme', 'sourcePort', 'priority']) if (c[key] !== undefined) throw unsupported(method, `cookie ${key}`);
          const u = c.url ? new URL(c.url) : undefined;
          if (u && !/^https?:$/.test(u.protocol)) throw new Error('Cookie URL must be HTTP or HTTPS');
          if (!c.domain && !u) throw new Error('Cookie requires url or domain');
          const cookie: any = { name: c.name, value: { type: 'string', value: c.value }, domain: c.domain ?? u!.hostname, path: c.path ?? '/', secure: c.secure ?? u?.protocol === 'https:' };
          if (c.httpOnly !== undefined) cookie.httpOnly = c.httpOnly;
          if (c.sameSite !== undefined) cookie.sameSite = c.sameSite.toLowerCase();
          if (c.expires !== undefined && c.expires >= 0) cookie.expiry = c.expires;
          await this.send('storage.setCookie', { partition, cookie });
        }
        return method === 'Network.setCookie' ? { success: true } : {};
      }
      case 'Network.deleteCookies': {
        if (p.partitionKey !== undefined) throw unsupported(method, 'explicit cookie partition keys');
        if (!p.url && !p.domain) throw new Error('Cookie deletion requires url or domain');
        const r = await this.send('storage.getCookies', { partition, filter: { name: p.name } });
        const url = p.url ? new URL(p.url) : undefined;
        for (const c of r.cookies) if ((!url || cookieMatches(c, url)) && (!p.domain || p.domain === c.domain) && (!p.path || p.path === c.path)) {
          await this.send('storage.deleteCookies', { partition, filter: { name: c.name, domain: c.domain, path: c.path } });
        }
        return {};
      }
      case 'Network.clearBrowserCookies': case 'Storage.clearCookies': return this.send('storage.deleteCookies', { partition });
      default: throw unsupported(method);
    }
  }

  onEvent(tabId: number, method: string, p: any): void {
    const st = this.states.get(tabId); if (!st || !p.request?.request) return;
    const id = p.request.request, type = resourceType(p.request), timestamp = p.timestamp / 1000;
    const request = { url: p.request.url, method: p.request.method, headers: headers(p.request.headers), hasPostData: p.request.bodySize > 0 || (p.request.bodySize == null && !['GET', 'HEAD'].includes(p.request.method)) };
    if (method === 'network.fetchError') st.pending.delete(id);
    if (st.enabled) {
      if (method === 'network.beforeRequestSent') {
        const previous = st.requests.get(id);
        st.requests.set(id, { ts: p.timestamp });
        // Match the inspection ring buffer's default ceiling without retaining completed requests forever.
        if (st.requests.size > 5000) st.requests.delete(st.requests.keys().next().value!);
        this.emit(tabId, 'Network.requestWillBeSent', { requestId: id, request, type, frameId: p.context, wallTime: timestamp, timestamp, initiator: { type: p.initiator?.type ?? 'other' }, redirectResponse: p.redirectCount ? previous?.response : undefined });
      } else if (p.response && (method === 'network.responseStarted' || method === 'network.responseCompleted')) {
        const t = p.request.timings ?? {}, record = st.requests.get(id), ts = t.requestTime ? (t.timeOrigin ?? 0) + t.requestTime : record?.ts ?? p.timestamp;
        const offset = (key: string) => t[key] > 0 && t.requestTime ? t[key] - t.requestTime : -1;
        const response = { ...p.response, headers: headers(p.response.headers), fromDiskCache: p.response.fromCache,
          timing: { requestTime: ts / 1000, dnsStart: offset('dnsStart'), dnsEnd: offset('dnsEnd'), connectStart: offset('connectStart'), connectEnd: offset('connectEnd'), sslStart: offset('tlsStart'), sslEnd: t.tlsStart > 0 ? offset('connectEnd') : -1, sendStart: offset('requestStart'), sendEnd: offset('requestStart'), receiveHeadersEnd: offset('responseStart') } };
        if (record) record.response = response;
        this.emit(tabId, 'Network.responseReceived', { requestId: id, response, type, timestamp });
        if (method === 'network.responseCompleted') {
          this.emit(tabId, 'Network.dataReceived', { requestId: id, dataLength: p.response.content?.size ?? p.response.bodySize ?? 0 });
          this.emit(tabId, 'Network.loadingFinished', { requestId: id, timestamp, encodedDataLength: p.response.bytesReceived ?? p.response.bodySize ?? 0 });
        }
      } else if (method === 'network.fetchError') {
        this.emit(tabId, 'Network.loadingFailed', { requestId: id, timestamp, errorText: p.errorText, canceled: /ABORT/.test(p.errorText ?? '') });
      }
    }
    if (p.isBlocked && ['network.beforeRequestSent', 'network.responseStarted'].includes(method)) {
      const stage = method === 'network.beforeRequestSent' ? 'Request' : 'Response';
      st.pending.set(id, stage);
      const blocked = st.blocked.some((pat) => globToRegex(pat).test(request.url));
      const matches = st.patterns.some((pat) => (pat.requestStage ?? 'Request') === stage && (!pat.resourceType || pat.resourceType === type) && globToRegex(pat.urlPattern ?? '*').test(request.url));
      if (blocked || !matches) {
        void this.send(blocked ? 'network.failRequest' : stage === 'Response' ? 'network.continueResponse' : 'network.continueRequest', { request: id })
          .then(() => st.pending.delete(id)).catch((e) => this.emit(tabId, 'companion.interceptFailed', { requestId: id, message: String(e.message ?? e) }));
      } else this.emit(tabId, 'Fetch.requestPaused', { requestId: id, networkId: id, request, frameId: p.context, resourceType: type, ...(stage === 'Response' && { responseStatusCode: p.response.status, responseStatusText: p.response.statusText, responseHeaders: Object.entries(headers(p.response.headers)).map(([name, value]) => ({ name, value })) }) });
    }
  }

  /** Called after a tab closes; the native context is already gone. */
  async clear(tabId: number): Promise<void> {
    const st = this.states.get(tabId); if (!st) return;
    this.states.delete(tabId);
    await st.changing?.catch(() => {});
    const results = await Promise.allSettled([
      ...(st.intercept ? [this.send('network.removeIntercept', { intercept: st.intercept })] : []),
      ...(st.collector ? [this.send('network.removeDataCollector', { collector: st.collector })] : []),
      ...(st.subscription ? [this.send('session.unsubscribe', { subscriptions: [st.subscription] })] : []),
    ]);
    for (const r of results) if (r.status === 'rejected') this.emit(tabId, 'companion.cleanupFailed', { message: String(r.reason) });
  }
}
