import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { type Ctx } from '../src/context.ts';
import { type Sessions } from '../src/session.ts';
import { Page } from '../src/page.ts';
import { Capture } from '../src/devtools/capture.ts';
import { registerApplicationTools } from '../src/devtools/application.ts';
import { registerDebuggerTools } from '../src/devtools/debugger.ts';
import { registerBrowserTools } from '../src/tools.ts';

function fixture() {
  const sessions = Object.assign(new EventEmitter(), {
    resolve: async (id = 1) => id, hold: async () => {},
    cdp: async (_id: number, _method: string, _params?: any): Promise<any> => ({}),
    bridge: { request: async (_method: string): Promise<any> => [] },
    devOfTab: (_id: number): any => undefined,
  });
  const capture = new Capture(sessions as unknown as Sessions);
  const ctx = { sessions, capture, registry: new Map(), page: {},
    client: { id: 'regression', name: 'regression', ownedTabs: new Set() },
    server: { registerTool() {} },
  } as unknown as Ctx;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await ctx.registry.get(name)!(args);
    assert.ok(!r.isError, JSON.stringify(r));
    return (r.content[0] as { text: string }).text;
  };
  return { sessions, ctx, capture, call };
}

test('extraction preserves letters and normalizes spaces, tabs, and line breaks', async () => {
  const document = { querySelectorAll: () => [{ innerText: ' Mississippi   state\nuses\ttabs ' }] };
  const page = { evaluate: async (_id: number, expression: string) => Function('document', `return ${expression}`)(document) };
  const result = await Page.prototype.extract.call(page as unknown as Page, 1, { items: 'p', fields: { text: '.' } });
  assert.deepEqual(result, [{ text: 'Mississippi state uses tabs' }]);
});

test('IndexedDB clearStore resolves after completion and closes the database', async () => {
  const { ctx, call } = fixture();
  let cleared = false, closed = false;
  const tx: any = { objectStore: () => ({ clear: () => {
    queueMicrotask(() => { cleared = true; tx.oncomplete?.(); });
  } }) };
  const db = { transaction: () => tx, close: () => { closed = true; } };
  const indexedDB = { open: () => {
    const request: any = { result: db };
    queueMicrotask(() => request.onsuccess());
    return request;
  } };
  ctx.page.evaluate = async <T>(_id: number, expression: string): Promise<T> => Function('indexedDB', `return ${expression}`)(indexedDB);
  registerApplicationTools(ctx);
  assert.equal(await call('devtools_storage', { area: 'indexeddb', action: 'clearStore', database: 'app', store: 'items' }), 'Cleared app/items');
  assert.ok(cleared && closed);
}, 500);

test('generic breakpoint removal and individual toggles use the matching CDP domain', async () => {
  const { sessions, ctx, capture, call } = fixture();
  const active = new Map<string, unknown>();
  sessions.cdp = async (_id, method, params) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 7 };
    if (method === 'Debugger.setBreakpointByUrl') { active.set('line', params); return { breakpointId: 'line', locations: [] }; }
    if (method === 'Debugger.removeBreakpoint') { assert.ok(active.delete(params.breakpointId), 'valid line breakpoint ID'); return {}; }
    const op = /^DOMDebugger\.(set|remove)(.+Breakpoint)$/.exec(method);
    if (op) {
      const key = op[2] + JSON.stringify(params);
      if (op[1] === 'set') active.set(key, params); else assert.ok(active.delete(key), `active ${key}`);
    }
    return {};
  };
  const st = await capture.start(1);
  registerDebuggerTools(ctx);
  for (const args of [
    { action: 'set', url: 'https://example.test/app.js', line: 3 },
    { action: 'dom', selector: '#app', domType: 'attribute-modified' },
    { action: 'event', eventName: 'custom:event', targetName: 'window' },
    { action: 'xhr', urlSubstring: 'https://example.test/api' },
  ]) await call('devtools_debugger', args);
  assert.equal(active.size, 4);
  for (const [breakpointId, bp] of [...st.breakpoints]) {
    if (bp.kind === 'line') continue;
    await call('devtools_debugger', { action: 'disable', breakpointId });
    assert.equal(active.size, 3);
    await call('devtools_debugger', { action: 'enable', breakpointId });
    assert.equal(active.size, 4);
  }
  assert.equal(await call('devtools_debugger', { action: 'remove', all: true }), 'Removed 4 breakpoint(s)');
  assert.equal(active.size, 0);
  assert.equal(st.breakpoints.size, 0);
});

test('failed breakpoint removal preserves the local entry and reports the failure', async () => {
  const { sessions, ctx, capture } = fixture();
  const st = await capture.start(1);
  st.breakpoints.set('line', { kind: 'line', description: 'line', enabled: true });
  sessions.cdp = async () => { throw new Error('transport lost'); };
  registerDebuggerTools(ctx);
  const result = await ctx.registry.get('devtools_debugger')!({ action: 'remove', breakpointId: 'line' });
  assert.ok(result.isError);
  assert.match((result.content[0] as { text: string }).text, /transport lost/);
  assert.ok(st.breakpoints.has('line'));
});

for (const mode of ['extension', 'dev']) test(`download wait returns the newest already completed match in ${mode} mode`, async () => {
  const { sessions, ctx, call } = fixture();
  const make = (guid: string, startedAt: number, url = 'https://example.test/report.csv') => ({
    guid, startedAt, url, filename: 'report.csv', path: `/downloads/${guid}`, state: 'completed', receivedBytes: 10, totalBytes: 10,
  });
  const downloads = [make('old', 1), make('new', 2), make('unrelated', 3, 'https://example.test/other.txt')];
  sessions.bridge.request = async () => downloads;
  sessions.devOfTab = () => mode === 'dev' ? { downloads: new Map(downloads.map((d) => [d.guid, d])) } : undefined;
  registerBrowserTools(ctx);
  const result = JSON.parse(await call('browser_download', { action: 'wait', urlContains: 'report.csv', timeoutMs: 100 }));
  assert.equal(result.path, '/downloads/new');
});

test('download wait waits for a newer pending match instead of returning an older file', async () => {
  const { sessions, ctx, call } = fixture();
  let polls = 0;
  sessions.bridge.request = async () => [
    { guid: 'old', startedAt: 1, url: 'https://example.test/report.csv', state: 'completed', path: '/old' },
    { guid: 'new', startedAt: 2, url: 'https://example.test/report.csv', state: ++polls > 1 ? 'completed' : 'inProgress', path: '/new' },
  ];
  registerBrowserTools(ctx);
  const result = JSON.parse(await call('browser_download', { action: 'wait', urlContains: 'report.csv', timeoutMs: 1000 }));
  assert.equal(result.path, '/new');
  assert.equal(polls, 2);
});

test('WebSockets and HTTP share the network limit, including indexes and dropped counts', async () => {
  const { sessions, capture } = fixture();
  const st = await capture.start(1, { maxNetwork: 2 });
  const emit = (method: string, params: object) => sessions.emit('cdp.event', { tabId: 1, method, params });
  for (const requestId of ['ws1', 'ws2', 'ws3']) emit('Network.webSocketCreated', { requestId, url: `wss://example.test/${requestId}` });
  assert.deepEqual(st.network.map((r) => r.id), ['ws2', 'ws3']);
  assert.deepEqual([...st.netIndex.keys()], ['ws2', 'ws3']);
  assert.equal(st.dropped.network, 1);
  emit('Network.requestWillBeSent', { requestId: 'http', wallTime: 1, request: { url: 'https://example.test/', method: 'GET' } });
  emit('Network.webSocketFrameReceived', { requestId: 'ws1', response: { opcode: 1, payloadData: 'ignored' } });
  emit('Network.webSocketFrameReceived', { requestId: 'ws3', response: { opcode: 1, payloadData: 'retained' } });
  assert.deepEqual(st.network.map((r) => r.id), ['ws3', 'http']);
  assert.deepEqual([...st.netIndex.keys()], ['ws3', 'http']);
  assert.equal(st.dropped.network, 2);
  assert.equal(st.netIndex.get('ws3')!.ws![0].payload, 'retained');
});
