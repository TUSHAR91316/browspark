import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';
import { Capture } from '../src/devtools/capture.ts';
import { registerSessionTools } from '../src/devtools/session.ts';
import { clients, type Ctx } from '../src/context.ts';
import type { Sessions } from '../src/session.ts';

function fixture() {
  const calls: { tabId: number; method: string; params?: any }[] = [];
  const holds: { tabId: number; on: boolean }[] = [];
  const sessions = Object.assign(new EventEmitter(), {
    resolve: async (id = 1) => id,
    modeOf: () => 'dev',
    devOfTab: () => ({ version: 'inspection-lifecycle-test' }),
    hold: async (tabId: number, _reason: string, on: boolean) => { holds.push({ tabId, on }); },
    cdp: async (tabId: number, method: string, params?: any): Promise<any> => { calls.push({ tabId, method, params }); return {}; },
  });
  const capture = new Capture(sessions as unknown as Sessions);
  const connect = (id: string, name = 'codex') => {
    const client = { id, name, ownedTabs: new Set<number>() };
    clients.set(id, client);
    const ctx = { server: new McpServer({ name: 'test', version: '0' }), sessions, capture, client, registry: new Map(), page: {} } as unknown as Ctx;
    registerSessionTools(ctx);
    return { client, call: async (name: string, args: Record<string, unknown>) => {
      const result = await ctx.registry.get(name)!(args);
      assert.ok(!result.isError, JSON.stringify(result));
      return (result.content[0] as { text: string }).text;
    } };
  };
  return { sessions, capture, calls, holds, connect };
}

test('same-name inspection clients leave independently, even after renaming', async () => {
  const f = fixture(), first = f.connect('lifecycle-1'), second = f.connect('lifecycle-2');
  try {
    await first.call('devtools_session', { action: 'start', tabId: 1 });
    await second.call('devtools_session', { action: 'start', tabId: 1 });
    const st = f.capture.require(1);
    assert.deepEqual([...st.users], ['lifecycle-1', 'lifecycle-2']);
    const status = JSON.parse(await first.call('devtools_session', { action: 'status', tabId: 1 }));
    assert.deepEqual(status.users, ['codex', 'codex']);
    let cleanups = 0; st.cleanups.push(async () => { cleanups++; });
    first.client.name = 'renamed';
    assert.match(await first.call('devtools_session', { action: 'stop', tabId: 1 }), /still in use by codex; session kept/);
    assert.equal(st.active, true);
    assert.equal(cleanups, 0);
    assert.deepEqual([...st.users], ['lifecycle-2']);
    await second.call('devtools_session', { action: 'stop', tabId: 1 });
    assert.equal(st.active, false);
    assert.equal(cleanups, 1);
    assert.deepEqual(f.holds, [{ tabId: 1, on: true }, { tabId: 1, on: false }]);
  } finally { clients.delete(first.client.id); clients.delete(second.client.id); }
});

test('disconnect releases every joined tab and preserves other clients until they leave', async () => {
  const f = fixture();
  await f.capture.start(1, {}, 'departing');
  await f.capture.start(2, {}, 'departing');
  await f.capture.start(2, {}, 'remaining');
  let cleanups = 0;
  f.capture.require(1).cleanups.push(async () => { cleanups++; });
  await f.capture.release('departing');
  assert.equal(f.capture.require(1).active, false);
  assert.equal(f.capture.require(2).active, true);
  assert.deepEqual([...f.capture.require(2).users], ['remaining']);
  assert.equal(cleanups, 1);
  const count = f.calls.length;
  await f.capture.release('departing');
  assert.equal(f.calls.length, count, 'duplicate close notifications do not repeat teardown');
  await f.capture.stop(2, 'remaining');
  assert.equal(f.capture.require(2).active, false);
  assert.deepEqual(f.holds.filter((h) => !h.on).map((h) => h.tabId), [1, 2]);
});

test('closing a stdio relay terminates its upstream inspection membership', async () => {
  const owner = new Client({ name: 'codex', version: '0' });
  const relay = new Client({ name: 'codex', version: '0' });
  let ws: WebSocket | undefined;
  const connect = (client: Client, port: number) => client.connect(new StdioClientTransport({ command: 'bun', args: [new URL('../src/index.ts', import.meta.url).pathname, '--port', String(port)], stderr: 'pipe' }));
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name} failed`);
    return (result.content as { type: string; text: string }[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  };
  try {
    await connect(owner, 0);
    const status = await call(owner, 'browser_status');
    const port = Number(/port:\s+(\d+)/.exec(status)?.[1]);
    assert.ok(port, 'isolated companion is ready');
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const tabs = [{ id: 71, url: 'https://example.test/', title: 'Fixture', shared: true, attached: true }];
    ws.on('message', (raw) => {
      const req = JSON.parse(raw.toString());
      if (!req.id) return;
      const result = req.method === 'tabs.list' ? tabs : {};
      ws!.send(JSON.stringify({ id: req.id, result }));
    });
    await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject); });
    ws.send(JSON.stringify({ event: 'hello', params: { version: PROTOCOL_VERSION, extensionVersion: 'test' } }));
    ws.send(JSON.stringify({ event: 'tabs', params: tabs }));
    await connect(relay, port);
    await call(owner, 'devtools_session', { action: 'start', tabId: 71 });
    await call(relay, 'devtools_session', { action: 'start', tabId: 71 });
    const inspection = async () => JSON.parse(await call(owner, 'devtools_session', { action: 'status', tabId: 71 }));
    assert.equal((await inspection()).users.length, 2);
    await relay.close();
    for (let i = 0; i < 50 && (await inspection()).users.length !== 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const remaining = await inspection();
    assert.deepEqual(remaining.users, ['codex']);
    assert.equal(remaining.active, true);
    await call(owner, 'devtools_session', { action: 'stop', tabId: 71 });
    assert.equal((await inspection()).active, false);
  } finally { await relay.close().catch(() => {}); ws?.terminate(); await owner.close().catch(() => {}); }
}, 10_000);

test('capability reporting leaves active browser state intact and uses protocol-valid passive probes', async () => {
  const f = fixture(), client = f.connect('lifecycle-probes');
  const domains = ['browser', 'js'].flatMap((kind) => JSON.parse(readFileSync(new URL(`../../node_modules/devtools-protocol/json/${kind}_protocol.json`, import.meta.url), 'utf8')).domains);
  const active = { media: 'print', profiler: true, heap: true, fetch: true, webauthn: true, subscriptions: true };
  const before = { ...active };
  f.sessions.cdp = async (tabId, method, params) => {
    f.calls.push({ tabId, method, params });
    const [domain, name] = method.split('.');
    const command = domains.find((d: any) => d.domain === domain)?.commands?.find((c: any) => c.name === name);
    assert.ok(command, `Unknown protocol method: ${method}`);
    if ((command.parameters ?? []).some((p: any) => !p.optional && params?.[p.name] === undefined)) throw new Error('Invalid parameters');
    if (method === 'Emulation.setEmulatedMedia') active.media = '';
    if (method === 'Profiler.disable') active.profiler = false;
    if (method === 'HeapProfiler.disable') active.heap = false;
    if (method === 'Fetch.disable') active.fetch = false;
    if (method === 'WebAuthn.disable') active.webauthn = false;
    if (/\.disable$/.test(method)) active.subscriptions = false;
    if (method === 'Browser.getVersion') throw new Error("'Browser.getVersion' wasn't found");
    return {};
  };
  try {
    const caps = JSON.parse(await client.call('devtools_capabilities', { tabId: 1, refresh: true }));
    assert.deepEqual(active, before);
    assert.ok(!f.calls.some((c) => /\.(enable|disable)$/.test(c.method)), 'reporting cannot toggle existing domain subscriptions');
    for (const domain of ['Emulation', 'Profiler', 'HeapProfiler', 'Fetch', 'WebAuthn', 'Log', 'Security']) assert.equal(caps.domains[domain], 'supported', domain);
    assert.match(caps.domains.Media, /^unprobed:/);
    assert.ok(!caps.unsupportedOperations.includes('Media.* commands'));
    assert.ok(caps.unsupportedOperations.includes('Browser.* commands'));
    const count = f.calls.length;
    await client.call('devtools_capabilities', { tabId: 1 });
    assert.equal(f.calls.length, count, 'cached capabilities do not repeat probes');
  } finally { clients.delete(client.client.id); }
});
