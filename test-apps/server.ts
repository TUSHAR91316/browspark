// Deterministic test server: static files, JSON API, slow endpoint, echo, WebSocket. Used by the e2e suite.
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { WebSocketServer } from 'ws';

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.map': 'application/json', '.json': 'application/json', '.css': 'text/css', '.txt': 'text/plain' };
export function startTestServer(root: string): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/api/items') return json(res, 200, { items: [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }] });
    if (u.pathname === '/api/missing') return json(res, 404, { error: 'not found', path: u.pathname });
    if (u.pathname === '/api/slow') { await new Promise((r) => setTimeout(r, 400)); return json(res, 200, { slow: true }); }
    if (u.pathname === '/download.txt') { res.setHeader('content-type', 'text/plain'); res.setHeader('content-disposition', 'attachment; filename="hello.txt"'); res.end('hello download'); return; }
    if (u.pathname === '/api/echo') { let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => json(res, 200, { method: req.method, body })); return; }
    const p = join(root, u.pathname === '/' ? 'basic.html' : u.pathname);
    try { res.setHeader('content-type', TYPES[extname(p)] ?? 'application/octet-stream'); res.setHeader('cache-control', 'no-store'); res.end(readFileSync(p)); } catch { res.statusCode = 404; res.end('missing'); }
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send('pong:' + m.toString())));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${(server.address() as any).port}/` })));
}
function json(res: any, status: number, body: unknown) { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); }
