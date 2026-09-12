import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { sourceMapFor } from '../src/devtools/sources.ts';
import type { Ctx } from '../src/context.ts';
import type { TabState } from '../src/devtools/capture.ts';

const mapText = JSON.stringify({ version: 3, sources: ['original.ts'], sourcesContent: ['export const x = 1;'], names: [], mappings: 'AAAA' });
const state = (sourceMapURL: string): TabState => ({ scripts: new Map([['forged', { scriptId: 'forged', url: 'http://127.0.0.1:9223/forged.js', hash: sourceMapURL, sourceMapURL }]]) }) as TabState;

test('forged sourceURL cannot make the companion fetch a map rejected by the page', async () => {
  const fetchBefore = globalThis.fetch;
  let companionRequests = 0, pageRequests = 0;
  globalThis.fetch = Object.assign(async () => { companionRequests++; return new Response(mapText); }, fetchBefore);
  try {
    const ctx = { page: { evaluate: async () => { pageRequests++; throw new Error('Blocked by Content Security Policy'); } } } as unknown as Ctx;
    assert.equal(await sourceMapFor(ctx, 990001, state('private.map'), 'forged'), undefined);
    assert.equal(pageRequests, 1);
    assert.equal(companionRequests, 0, 'untrusted script origins never authorize companion network requests');
  } finally { globalThis.fetch = fetchBefore; }
});

test('source maps still load through the page or inline data URLs', async () => {
  let requests = 0;
  const ctx = { page: { evaluate: async () => { requests++; return mapText; } } } as unknown as Ctx;
  assert.deepEqual((await sourceMapFor(ctx, 990002, state('allowed.map'), 'forged'))?.sources, ['original.ts']);
  const inline = `data:application/json;base64,${Buffer.from(mapText).toString('base64')}`;
  assert.deepEqual((await sourceMapFor(ctx, 990003, state(inline), 'forged'))?.sources, ['original.ts']);
  assert.equal(requests, 1, 'inline maps need no fetch');
});
