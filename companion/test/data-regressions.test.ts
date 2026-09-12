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
