import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Ctx, type Result } from '../src/context.ts';
import { Capture } from '../src/devtools/capture.ts';
import { registerProfilingTools } from '../src/devtools/profiling.ts';
import { registerEnvironmentTools } from '../src/devtools/environment.ts';

const heap = JSON.stringify({ snapshot: { meta: { node_fields: ['type', 'name', 'self_size'], node_types: [['object']] } }, nodes: [0, 0, 24], strings: ['Widget'] });
const cpuProfile = { nodes: [{ id: 1, callFrame: { functionName: 'work', url: 'https://test/app.js', lineNumber: 0 }, children: [] }], samples: [1], startTime: 0, endTime: 1000 };

class FakeSessions extends EventEmitter {
  calls: string[] = [];
  active = new Set<string>();
  failTraceStart = false;
  locale = ''; timezone = ''; playbackRate = 1;
  async resolve(id = 1) { return id; }
  devOfTab() { return undefined; }
  modeOf() { return 'dev' as const; }
  async hold() {}
  async cdp(tabId: number, method: string, params: any = {}) {
    this.calls.push(method);
    const emit = (method: string, params: unknown, sessionId?: string) => this.emit('cdp.event', { tabId, method, params, sessionId });
    switch (method) {
      case 'Tracing.start':
        if (this.failTraceStart) { this.failTraceStart = false; throw new Error('Tracing unavailable'); }
        assert.ok(!this.active.has('trace')); this.active.add('trace'); break;
      case 'Tracing.end':
        assert.ok(this.active.delete('trace'));
        emit('Tracing.dataCollected', { value: [{ name: 'FunctionCall', ph: 'X', ts: 1000, dur: 3000 }] });
        emit('Tracing.dataCollected', { value: [{ name: 'child session', ph: 'X', ts: 0, dur: 9000 }] }, 'worker');
        emit('Tracing.tracingComplete', {}); break;
      case 'Profiler.start': assert.ok(!this.active.has('cpu')); this.active.add('cpu'); break;
      case 'Profiler.stop': assert.ok(this.active.delete('cpu')); return { profile: cpuProfile };
      case 'Profiler.startPreciseCoverage': this.active.add('coverage'); break;
      case 'Profiler.takePreciseCoverage': return { result: [] };
      case 'Profiler.stopPreciseCoverage': assert.ok(this.active.delete('coverage')); break;
      case 'CSS.startRuleUsageTracking': this.active.add('cssCoverage'); break;
      case 'CSS.stopRuleUsageTracking': assert.ok(this.active.delete('cssCoverage')); return { ruleUsage: [] };
      case 'HeapProfiler.startSampling': assert.ok(!this.active.has('allocation')); this.active.add('allocation'); break;
      case 'HeapProfiler.stopSampling':
        assert.ok(this.active.delete('allocation'));
        return { profile: { head: { callFrame: { functionName: 'allocate' }, selfSize: 24, children: [] } } };
      case 'HeapProfiler.takeHeapSnapshot':
        emit('HeapProfiler.addHeapSnapshotChunk', { chunk: heap.slice(0, 20) });
        emit('HeapProfiler.addHeapSnapshotChunk', { chunk: 'unrelated child data' }, 'worker');
        emit('HeapProfiler.addHeapSnapshotChunk', { chunk: heap.slice(20) }); break;
      case 'Emulation.setLocaleOverride': this.locale = params.locale ?? ''; break;
      case 'Emulation.setTimezoneOverride': this.timezone = params.timezoneId; break;
      case 'Animation.setPlaybackRate': this.playbackRate = params.playbackRate; break;
      case 'Animation.getPlaybackRate': return { playbackRate: this.playbackRate };
    }
    return {};
  }
}

function fixture() {
  const sessions = new FakeSessions();
  const capture = new Capture(sessions as unknown as Ctx['sessions']);
  const client = (id: string) => {
    const ctx = { sessions, capture, page: { evaluate: async () => ({}) }, server: { registerTool() {} }, client: { id, name: id, ownedTabs: new Set() }, registry: new Map() } as unknown as Ctx;
    registerProfilingTools(ctx); registerEnvironmentTools(ctx);
    return async (name: string, args: Record<string, unknown>) => {
      const result: Result = await ctx.registry.get(name)!({ tabId: 1, ...args });
      const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      assert.ok(!result.isError, text);
      try { return JSON.parse(text); } catch { return text; }
    };
  };
  return { sessions, capture, client };
}

async function withArtifacts(run: () => Promise<void>) {
  const previous = process.env.BROWSPARK_ARTIFACTS;
  const dir = mkdtempSync(join(tmpdir(), 'browspark-profiling-test-'));
  process.env.BROWSPARK_ARTIFACTS = dir;
  try { await run(); }
  finally { if (previous === undefined) delete process.env.BROWSPARK_ARTIFACTS; else process.env.BROWSPARK_ARTIFACTS = previous; rmSync(dir, { recursive: true, force: true }); }
}

test('two MCP registrations ingest trace events and heap chunks exactly once', () => withArtifacts(async () => {
  const { sessions, capture, client } = fixture();
  const first = client('first'), second = client('second');
  await capture.start(1, {}, 'first');
  await first('devtools_performance', { action: 'start' });
  const trace = await second('devtools_performance', { action: 'stop' });
  assert.equal(trace.events, 1);
  assert.equal(trace.timeByCategoryMs.scripting, 3);
  const snapshot = await second('devtools_memory', { action: 'snapshot' });
  assert.equal(snapshot.nodes, 1);
  assert.equal(readFileSync(snapshot.artifact, 'utf8'), heap);
  await capture.stop(1, 'first');
  assert.equal(sessions.calls.filter((m) => m === 'Tracing.end').length, 1);
}));

test('last inspection user leaving stops active recordings and allows a fresh trace', () => withArtifacts(async () => {
  const { sessions, capture, client } = fixture();
  const call = client('first'); client('second');
  await capture.start(1, {}, 'first'); await capture.start(1, {}, 'second');
  await call('devtools_performance', { action: 'start' });
  await call('devtools_profile', { action: 'start' });
  await call('devtools_memory', { action: 'sampling', phase: 'start' });
  await call('devtools_coverage', { action: 'start', reload: false });
  await capture.stop(1, 'first');
  assert.equal(sessions.active.size, 5, 'another inspection user still owns the recordings');
  assert.deepEqual(await capture.stop(1, 'second'), []);
  assert.equal(sessions.active.size, 0);
  assert.ok(capture.get(1)!.recordings.every((r) => r.done));
  await capture.start(1, {}, 'first');
  await call('devtools_performance', { action: 'start' });
  await call('devtools_performance', { action: 'stop' });
  await capture.stop(1, 'first');
  assert.equal(sessions.calls.filter((m) => m === 'Tracing.end').length, 2);
}));

test('explicitly stopped CPU, allocation and coverage recordings are not stopped again during teardown', () => withArtifacts(async () => {
  const { sessions, capture, client } = fixture();
  const call = client('first');
  await capture.start(1, {}, 'first');
  for (let i = 0; i < 2; i++) {
    await call('devtools_profile', { action: 'start' }); await call('devtools_profile', { action: 'stop' });
    await call('devtools_memory', { action: 'sampling', phase: 'start' }); await call('devtools_memory', { action: 'sampling', phase: 'stop' });
    await call('devtools_coverage', { action: 'start', reload: false }); await call('devtools_coverage', { action: 'stop' });
  }
  assert.deepEqual(await capture.stop(1, 'first'), []);
  assert.equal(sessions.calls.filter((m) => m === 'Profiler.stop').length, 2);
  assert.equal(sessions.calls.filter((m) => m === 'HeapProfiler.stopSampling').length, 2);
  assert.equal(sessions.calls.filter((m) => m === 'Profiler.stopPreciseCoverage').length, 2);
  assert.equal(sessions.calls.filter((m) => m === 'CSS.stopRuleUsageTracking').length, 2);
}));

test('a failed trace start can be retried without a stale recording', async () => {
  const { sessions, capture, client } = fixture();
  const call = client('first'); await capture.start(1, {}, 'first');
  sessions.failTraceStart = true;
  await assert.rejects(call('devtools_performance', { action: 'start' }), /Tracing unavailable/);
  await call('devtools_performance', { action: 'start' });
  assert.deepEqual(await capture.stop(1, 'first'), []);
  assert.equal(sessions.active.size, 0);
});

test('emulation reset restores locale, timezone and frozen animations', async () => {
  const { sessions, client } = fixture();
  const call = client('first');
  await call('devtools_emulation', { action: 'locale', locale: 'fr-FR', timezone: 'Europe/Paris' });
  await call('devtools_emulation', { action: 'animations', playbackRate: 0 });
  assert.deepEqual([sessions.locale, sessions.timezone, sessions.playbackRate], ['fr-FR', 'Europe/Paris', 0]);
  await call('devtools_emulation', { action: 'reset' });
  assert.deepEqual([sessions.locale, sessions.timezone, sessions.playbackRate], ['', '', 1]);
  assert.deepEqual(await call('devtools_emulation', { action: 'status' }), {});
});
