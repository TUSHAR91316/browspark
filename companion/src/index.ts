import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Bridge, loadToken } from './bridge.ts';
import { Sessions } from './session.ts';
import { Page } from './page.ts';
import { Capture } from './devtools/capture.ts';
import { installLiveView } from './live.ts';
import { type Ctx, type ClientState, clients, toolCatalog, setDisabledTools, devGate } from './context.ts';
import type { ToolPolicy } from '../../shared/protocol.ts';
import { registerBrowserTools } from './tools.ts';
import { registerSessionTools } from './devtools/session.ts';
import { registerConsoleTools } from './devtools/console.ts';
import { registerNetworkTools, installFetchHandler } from './devtools/network.ts';
import { registerSourcesTools } from './devtools/sources.ts';
import { registerDebuggerTools } from './devtools/debugger.ts';
import { registerElementsTools } from './devtools/elements.ts';
import { registerProfilingTools } from './devtools/profiling.ts';
import { registerApplicationTools } from './devtools/application.ts';
import { registerEnvironmentTools } from './devtools/environment.ts';
import { registerLighthouseTools } from './devtools/lighthouse.ts';
import { registerRecorderTools } from './devtools/recorder.ts';
import { DEFAULT_PORT } from '../../shared/protocol.ts';

const portArg = process.argv.indexOf('--port');
const port = portArg > -1 ? Number(process.argv[portArg + 1]) : Number(process.env.BROWSERMCP_PORT ?? DEFAULT_PORT);

const bridge = new Bridge(loadToken(), port);
await bridge.listen().catch(async (e) => {
  if (e?.code !== 'EADDRINUSE' && !/in use|EADDRINUSE/i.test(String(e?.message))) { console.error(`browsermcp: cannot listen on 127.0.0.1:${port}: ${e.message}`); process.exit(1); }
  // Another companion already owns the port (another agent launched it). Become a thin stdio relay to it, so every
  // client shares one companion, one extension, and one set of shared tabs.
  await relayTo(`http://127.0.0.1:${port}/mcp?token=${bridge.token}`);
});

async function relayTo(url: string): Promise<never> {
  const relay = new Server({ name: 'browsermcp', version: '0.2.1' }, { capabilities: { tools: {} } });
  // Connect upstream only once we know who the downstream client is, so the companion can name this agent correctly.
  let upstreamReady!: Promise<Client>;
  relay.oninitialized = () => {
    const who = relay.getClientVersion()?.name ?? 'relay';
    upstreamReady = (async () => { const c = new Client({ name: `relay:${who}`, version: '0' }); await c.connect(new StreamableHTTPClientTransport(new URL(url))); return c; })();
    upstreamReady.catch((err) => { console.error(`browsermcp: port ${port} is in use but the companion there did not answer (${(err as Error).message}). Stop the other process or use --port.`); process.exit(1); });
  };
  relay.setRequestHandler(ListToolsRequestSchema, async () => (await upstreamReady).listTools());
  relay.setRequestHandler(CallToolRequestSchema, async (req) => (await upstreamReady).callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }) as any);
  await relay.connect(new StdioServerTransport());
  console.error(`browsermcp: relaying stdio to the companion already running on port ${port}`);
  process.stdin.on('close', () => process.exit(0));
  await new Promise(() => {});
  throw new Error('unreachable');
}
const VERSION = '0.2.1';
const sendCatalog = () => bridge.request('tools.catalog', { tools: toolCatalog, version: VERSION }).catch((e) => console.error(`browsermcp: could not send tool catalog: ${e.message}`));
bridge.on('connected', () => { console.error('browsermcp: extension connected'); sendCatalog(); });
bridge.on('tools.policy', (p: ToolPolicy) => { setDisabledTools(p.disabled ?? []); devGate.policy = p.devMode ?? 'auto'; console.error(`browsermcp: ${p.disabled?.length ?? 0} tool(s) disabled from the dashboard; developer browser: ${devGate.policy}`); if (!p.haveCatalog) sendCatalog(); });
bridge.on('disconnected', () => console.error('browsermcp: extension disconnected'));

const sessions = new Sessions(bridge);
const page = new Page(sessions), capture = new Capture(sessions);
/** Each MCP transport gets its own McpServer; browser state, capture buffers, and the tool registry are shared. */
let clientSeq = 0;
function buildServer(label: string): McpServer {
  const server = new McpServer({ name: 'browsermcp', version: VERSION });
  const client: ClientState = { id: `c${++clientSeq}`, name: label, ownedTabs: new Set() };
  clients.set(client.id, client);
  const ctx: Ctx = { server, sessions, page, capture, client, registry: new Map() };
  for (const reg of [registerBrowserTools, registerSessionTools, registerConsoleTools, registerNetworkTools, registerSourcesTools, registerDebuggerTools, registerElementsTools, registerProfilingTools, registerApplicationTools, registerEnvironmentTools, registerLighthouseTools, registerRecorderTools]) reg(ctx);
  // Name the agent after what the MCP client calls itself (opencode, claude-code, gemini…); a relay passes the real name through.
  server.server.oninitialized = () => { const v = server.server.getClientVersion(); if (v?.name) client.name = v.name.replace(/^relay:/, ''); console.error(`browsermcp: agent connected: ${client.name}`); };
  server.server.onclose = () => { clients.delete(client.id); console.error(`browsermcp: agent disconnected: ${client.name}`); };
  return server;
}
installFetchHandler({ sessions, capture });
installLiveView(bridge, sessions);

// MCP over Streamable HTTP for clients that take a URL (Gemini connected apps, web agents). Same token as pairing:
// Authorization: Bearer <token>, or ?token=<token> for clients that cannot set headers.
const httpSessions = new Map<string, StreamableHTTPServerTransport>();
bridge.mcpHandler = async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || u.searchParams.get('token');
  if (presented !== bridge.token) { res.statusCode = 401; res.setHeader('content-type', 'text/plain'); res.end('unauthorized: pass the pairing token as ?token=… or Authorization: Bearer …'); return; }
  const sid = req.headers['mcp-session-id'];
  let transport = typeof sid === 'string' ? httpSessions.get(sid) : undefined;
  if (!transport) {
    if (req.method !== 'POST') { res.statusCode = 400; res.end('no MCP session; initialize with a POST first'); return; }
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { httpSessions.set(id, t); console.error(`browsermcp: http client session ${id.slice(0, 8)}`); } });
    t.onclose = () => { if (t.sessionId) httpSessions.delete(t.sessionId); };
    await buildServer('http').connect(t);
    transport = t;
  }
  await transport.handleRequest(req, res);
};

if (!process.argv.includes('--http-only')) await buildServer('stdio').connect(new StdioServerTransport());
console.error(`browsermcp: ready on ws://127.0.0.1:${bridge.port} (pairing token ${bridge.token}); MCP over HTTP at http://127.0.0.1:${bridge.port}/mcp?token=${bridge.token}`);

const shutdown = async () => { bridge.close(); await sessions.closeAll(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (!process.argv.includes('--http-only')) process.stdin.on('close', shutdown);
