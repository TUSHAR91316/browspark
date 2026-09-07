import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge, loadToken } from './bridge.ts';
import { Sessions } from './session.ts';
import { Page } from './page.ts';
import { Capture } from './devtools/capture.ts';
import { installLiveView } from './live.ts';
import { type Ctx, toolCatalog, setDisabledTools, devGate } from './context.ts';
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
await bridge.listen().catch((e) => { console.error(`browsermcp: cannot listen on 127.0.0.1:${port}: ${e.message}`); process.exit(1); });
const VERSION = '0.2.1';
const sendCatalog = () => bridge.request('tools.catalog', { tools: toolCatalog, version: VERSION }).catch((e) => console.error(`browsermcp: could not send tool catalog: ${e.message}`));
bridge.on('connected', () => { console.error('browsermcp: extension connected'); sendCatalog(); });
bridge.on('tools.policy', (p: ToolPolicy) => { setDisabledTools(p.disabled ?? []); devGate.policy = p.devMode ?? 'auto'; console.error(`browsermcp: ${p.disabled?.length ?? 0} tool(s) disabled from the dashboard; developer browser: ${devGate.policy}`); if (!p.haveCatalog) sendCatalog(); });
bridge.on('disconnected', () => console.error('browsermcp: extension disconnected'));

const sessions = new Sessions(bridge);
const server = new McpServer({ name: 'browsermcp', version: VERSION });
const ctx: Ctx = { server, sessions, page: new Page(sessions), capture: new Capture(sessions) };
installFetchHandler(ctx);
installLiveView(bridge, sessions);
for (const reg of [registerBrowserTools, registerSessionTools, registerConsoleTools, registerNetworkTools, registerSourcesTools, registerDebuggerTools, registerElementsTools, registerProfilingTools, registerApplicationTools, registerEnvironmentTools, registerLighthouseTools, registerRecorderTools]) reg(ctx);

await server.connect(new StdioServerTransport());
console.error(`browsermcp: ready on ws://127.0.0.1:${bridge.port} (pairing token ${bridge.token})`);

const shutdown = async () => { bridge.close(); await sessions.closeAll(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
