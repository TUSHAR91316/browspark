import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { LIVE_HTML } from './live.ts';
import { currentClient } from './context.ts';
import {
  isEvt, isRes, type CdpEventParams, type DetachedParams, type HelloParams, type Msg, type Req,
  type ReqMethod, type TabInfo, PROTOCOL_VERSION,
} from '../../shared/protocol.ts';

const REQUEST_TIMEOUT_MS = 30_000;

export function loadToken(dir = join(homedir(), '.browsermcp')): string {
  const file = join(dir, 'token');
  try { return readFileSync(file, 'utf8').trim(); } catch {}
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(4).toString('hex');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/**
 * Local WebSocket server the extension connects to. One extension at a time.
 * Emits: 'connected', 'disconnected', 'tabs' (TabInfo[]), 'cdp.event' (CdpEventParams), 'detached' (DetachedParams).
 */
export class Bridge extends EventEmitter {
  private wss?: WebSocketServer;
  private http?: Server;
  /** Set by installLiveView: handles a browser viewer connection for a tab. */
  viewerHandler?: (ws: WebSocket, tabId: number) => void;
  /** Set by the entry point: MCP over Streamable HTTP at /mcp for URL-based clients (Gemini, web apps). */
  mcpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  tabs: TabInfo[] = [];
  extensionVersion?: string;
  /** Browser brand reported by the extension, e.g. "Brave 1.80" or "Google Chrome 152". */
  browser?: string;

  readonly token: string;
  /** Requested port; replaced by the bound port after listen() (relevant when 0 was requested). */
  port: number;
  constructor(token: string, port: number) { super(); this.token = token; this.port = port; }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http = createServer((req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        if (u.pathname === '/mcp' && this.mcpHandler) { this.mcpHandler(req, res).catch((e) => { if (!res.headersSent) { res.statusCode = 500; res.end(String(e?.message ?? e)); } }); return; }
        const live = /^\/live\/(\d+)$/.exec(u.pathname);
        if (live) {
          if (u.searchParams.get('token') !== this.token) { res.statusCode = 403; res.end('bad token'); return; }
          res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(LIVE_HTML(Number(live[1]), this.token)); return;
        }
        res.statusCode = u.pathname === '/' ? 200 : 404; res.setHeader('content-type', 'text/plain'); res.end(u.pathname === '/' ? 'browsermcp companion' : 'not found');
      });
      this.wss = new WebSocketServer({ noServer: true });
      this.http.on('upgrade', (req, socket, head) => {
        const u = new URL(req.url ?? '/', 'http://x');
        if (u.pathname === '/live-ws') {
          const tabId = Number(u.searchParams.get('tab'));
          if (u.searchParams.get('token') !== this.token || !tabId || !this.viewerHandler) { socket.destroy(); return; }
          this.wss!.handleUpgrade(req, socket, head, (ws) => this.viewerHandler!(ws, tabId));
          return;
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
      });
      this.http.once('error', reject);
      this.http.listen(this.port, '127.0.0.1', () => { this.port = (this.http!.address() as { port: number }).port; resolve(); });
    });
  }

  get connected(): boolean { return this.ws?.readyState === 1; }

  private accept(ws: WebSocket) {
    let paired = false;
    ws.on('message', (data) => {
      let msg: Msg;
      try { msg = JSON.parse(data.toString()); } catch { return ws.close(1003, 'bad json'); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return ws.close(1003, 'message must be a JSON object');
      if (!paired) {
        if (!isEvt(msg) || msg.event !== 'hello') return ws.close(4001, 'hello required');
        const p = msg.params as HelloParams;
        if (p?.token !== this.token) return ws.close(4003, 'bad token');
        if (p.version !== PROTOCOL_VERSION) return ws.close(4002, `protocol ${PROTOCOL_VERSION} required`);
        paired = true;
        this.ws?.close(1000, 'replaced by new connection');
        this.ws = ws;
        this.extensionVersion = p.extensionVersion;
        this.browser = p.browser ?? (p.userAgent && /Chrome\/(\d+)/.exec(p.userAgent) ? `Chromium-based ${/Chrome\/(\d+)/.exec(p.userAgent)![1]}` : undefined);
        this.emit('connected');
        return;
      }
      this.handle(msg);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.tabs = [];
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('extension disconnected')); this.pending.delete(id); }
      this.emit('disconnected');
    });
  }

  private handle(msg: Msg) {
    if (isRes(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
      return;
    }
    if (!isEvt(msg)) return;
    switch (msg.event) {
      case 'tabs': this.tabs = msg.params as TabInfo[]; this.emit('tabs', this.tabs); break;
      case 'cdp.event': this.emit('cdp.event', msg.params as CdpEventParams); break;
      case 'detached': this.emit('detached', msg.params as DetachedParams); break;
      case 'ping': break;
      case 'tools.policy': this.emit('tools.policy', msg.params); break;
    }
  }

  request<T = unknown>(method: ReqMethod, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('extension not connected'));
    const id = this.nextId++;
    const req: Req = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws!.send(JSON.stringify(req));
    });
  }

  cdp<T = unknown>(tabId: number, method: string, params?: unknown, timeoutMs?: number, sessionId?: string): Promise<T> {
    return this.request<T>('cdp', { tabId, method, params, sessionId, client: currentClient()?.name }, timeoutMs);
  }

  close() {
    this.ws?.close(1000, 'companion shutting down');
    this.wss?.close();
    this.http?.close();
  }
}
