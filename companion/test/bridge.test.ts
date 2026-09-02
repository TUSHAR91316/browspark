import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Bridge } from '../src/bridge.ts';
import { PROTOCOL_VERSION, unsupportedReason, type Req } from '../../shared/protocol.ts';

const hello = (token: string) => JSON.stringify({ event: 'hello', params: { token, version: PROTOCOL_VERSION, extensionVersion: 't' } });
const open = (ws: WebSocket) => new Promise<void>((r) => ws.once('open', () => r()));
const closed = (ws: WebSocket) => new Promise<number>((r) => ws.once('close', (c) => r(c)));

test('bridge pairs, routes requests, rejects pending on disconnect', async () => {
  const bridge = new Bridge('secret', 0);
  await bridge.listen();
  const port = bridge.port;
  assert.notEqual(port, 0);

  // wrong token is refused
  const bad = new WebSocket(`ws://127.0.0.1:${port}`);
  await open(bad);
  bad.send(hello('nope'));
  assert.equal(await closed(bad), 4003);

  // good token pairs; request/response round-trips; tab events land
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await open(ws);
  const connected = new Promise<void>((r) => bridge.once('connected', r));
  ws.send(hello('secret'));
  await connected;
  assert.equal(bridge.connected, true);

  ws.on('message', (d) => {
    const req = JSON.parse(d.toString()) as Req;
    if (req.method === 'cdp') ws.send(JSON.stringify({ id: req.id, result: { ok: (req.params as any).method } }));
    if (req.method === 'tabs.list') ws.send(JSON.stringify({ id: req.id, error: 'boom' }));
  });
  assert.deepEqual(await bridge.cdp(1, 'Page.enable'), { ok: 'Page.enable' });
  await assert.rejects(bridge.request('tabs.list'), /boom/);

  ws.send(JSON.stringify({ event: 'tabs', params: [{ id: 1, url: 'https://x', title: 'x', shared: true, attached: false }] }));
  await new Promise((r) => bridge.once('tabs', r));
  assert.equal(bridge.tabs.length, 1);

  // in-flight request fails when the extension drops; nothing is retried
  const inflight = bridge.cdp(1, 'Runtime.evaluate');
  ws.close();
  await assert.rejects(inflight, /disconnected/);
  assert.equal(bridge.connected, false);
  bridge.close();
});

test('bridge rejects non-object JSON without crashing', async () => {
  const bridge = new Bridge('secret', 0);
  await bridge.listen();
  for (const payload of ['null', '42', '"hi"', '[1]']) {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    await open(ws); ws.send(payload);
    assert.equal(await closed(ws), 1003, payload);
  }
  assert.equal(bridge.connected, false);
  bridge.close();
});

test('unsupportedReason flags internal pages', () => {
  assert.ok(unsupportedReason('chrome://extensions'));
  assert.ok(unsupportedReason('https://chromewebstore.google.com/detail/x'));
  assert.equal(unsupportedReason('https://example.com'), undefined);
  assert.equal(unsupportedReason('about:blank'), undefined);
  assert.ok(unsupportedReason('chrome://newtab/'));
});
