import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FirefoxNetwork } from '../src/firefox-network.ts';
import { installFetchHandler } from '../src/devtools/network.ts';
import { policies } from '../src/devtools/intercept.ts';

function harness() {
  const calls: { method: string; params: any }[] = [], events: { tabId: number; method: string; params: any }[] = [];
  const replies = new Map<string, any>(); let next = 0;
  const bus = new EventEmitter();
  const network = new FirefoxNetwork(async (method, params) => {
    calls.push({ method, params });
    const reply = replies.get(method); if (reply instanceof Error) throw reply;
    return reply ?? (method === 'session.subscribe' ? { subscription: `s${++next}` } : method === 'network.addIntercept' ? { intercept: `i${++next}` } : method === 'network.addDataCollector' ? { collector: `c${++next}` } : {});
  }, (tabId, method, params) => { events.push({ tabId, method, params }); bus.emit('cdp.event', { tabId, method, params }); });
  const handle = (method: string, p?: any, tabId = 1) => network.handle(tabId, `context-${tabId}`, method, p);
  return { network, calls, events, replies, bus, handle };
}
const request = (id = 'r1', url = 'https://app.test/api') => ({ context: 'context-1', timestamp: 1000, redirectCount: 0, isBlocked: false,
  request: { request: id, url, method: 'GET', headers: [{ name: 'X-Test', value: { type: 'base64', value: 'b2s=' } }], bodySize: 0, destination: '', initiatorType: 'fetch', timings: { timeOrigin: 0, requestTime: 990, dnsStart: 991, dnsEnd: 992, connectStart: 992, connectEnd: 995, tlsStart: 993, requestStart: 998, responseStart: 1050 } } });
const response = { url: 'https://app.test/api', status: 200, statusText: 'OK', protocol: 'http/2', mimeType: 'application/json', headers: [{ name: 'Set-Cookie', value: { type: 'string', value: 'a=1' } }, { name: 'set-cookie', value: { type: 'string', value: 'b=2' } }], fromCache: false, bytesReceived: 120, bodySize: 20, content: { size: 30 } };

test('Firefox network capture maps BiDi headers, timing, redirects, bodies and errors', async () => {
  const h = harness(); await h.handle('Network.enable');
  assert.deepEqual(h.calls[0].params.contexts, ['context-1']);
  h.network.onEvent(1, 'network.beforeRequestSent', request());
  h.network.onEvent(1, 'network.responseStarted', { ...request(), timestamp: 1050, response });
  h.network.onEvent(1, 'network.responseCompleted', { ...request(), timestamp: 1100, response });
  assert.equal(h.events[0].params.type, 'Fetch');
  assert.equal(h.events[0].params.request.headers['x-test'], 'ok');
  const r = h.events.find((e) => e.method === 'Network.responseReceived')!.params.response;
  assert.equal(r.headers['set-cookie'], 'a=1\nb=2');
  assert.equal(r.timing.requestTime, .99); assert.equal(r.timing.receiveHeadersEnd, 60);
  assert.equal(h.events.find((e) => e.method === 'Network.loadingFinished')!.params.timestamp, 1.1);
  h.replies.set('network.getData', { bytes: { type: 'base64', value: 'e30=' } });
  assert.deepEqual(await h.handle('Network.getResponseBody', { requestId: 'r1' }), { body: 'e30=', base64Encoded: true });
  await assert.rejects(h.handle('Network.getResponseBody', { requestId: 'other-tab-request' }), /Unknown Firefox requestId/);
  h.network.onEvent(1, 'network.beforeRequestSent', { ...request('r1', 'https://app.test/redirected'), redirectCount: 1 });
  assert.equal(h.events.at(-1)!.params.redirectResponse.status, 200);
  h.network.onEvent(1, 'network.fetchError', { ...request(), errorText: 'NS_ERROR_ABORT' });
  assert.equal(h.events.at(-1)!.params.canceled, true);
  await h.handle('Network.disable');
  assert.ok(h.calls.some((c) => c.method === 'network.removeDataCollector'));
  assert.equal(h.calls.at(-1)!.method, 'session.unsubscribe');
});

test('Firefox policy blocks requests without a capture session, including redirected child requests', async () => {
  const h = harness();
  const sessions = Object.assign(h.bus, { cdp: (tabId: number, method: string, params: any) => h.handle(method, params, tabId) });
  installFetchHandler({ sessions, capture: { get: () => undefined } } as any);
  policies.set(1, { allow: ['app.test'] });
  try {
    await h.handle('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    h.network.onEvent(1, 'network.beforeRequestSent', { ...request('blocked', 'https://evil.test/'), context: 'iframe-1', isBlocked: true, redirectCount: 1 });
    await Promise.resolve();
    assert.ok(h.calls.some((c) => c.method === 'network.failRequest' && c.params.request === 'blocked'));
    h.network.onEvent(1, 'network.beforeRequestSent', { ...request('allowed'), isBlocked: true });
    await Promise.resolve();
    assert.ok(h.calls.some((c) => c.method === 'network.continueRequest' && c.params.request === 'allowed'));
    assert.ok(!h.events.some((e) => e.method === 'Network.requestWillBeSent'));
  } finally { policies.delete(1); }
});

test('Firefox mocks, URL blocking and Fetch cleanup preserve independent rules', async () => {
  const h = harness();
  await Promise.all([h.handle('Fetch.enable', { patterns: [{ urlPattern: '*/api*' }] }), h.handle('Network.setBlockedURLs', { urls: ['*tracker*'] })]);
  h.network.onEvent(1, 'network.beforeRequestSent', { ...request(), isBlocked: true });
  await h.handle('Fetch.fulfillRequest', { requestId: 'r1', responseCode: 201, responseHeaders: [{ name: 'content-type', value: 'text/plain' }], body: 'bW9jaw==' });
  assert.deepEqual(h.calls.at(-1), { method: 'network.provideResponse', params: { request: 'r1', statusCode: 201, headers: [{ name: 'content-type', value: { type: 'string', value: 'text/plain' } }], body: { type: 'base64', value: 'bW9jaw==' } } });
  h.replies.set('network.addIntercept', new Error('failed to replace intercept'));
  await assert.rejects(h.handle('Network.setBlockedURLs', { urls: ['*different*'] }), /failed to replace/);
  h.replies.delete('network.addIntercept');
  await h.handle('Fetch.disable');
  h.network.onEvent(1, 'network.beforeRequestSent', { ...request('tracker', 'https://app.test/tracker'), isBlocked: true });
  await Promise.resolve();
  assert.equal(h.calls.at(-1)!.method, 'network.failRequest');
  h.network.onEvent(1, 'network.beforeRequestSent', { ...request('allowed'), isBlocked: true });
  await Promise.resolve();
  assert.equal(h.calls.at(-1)!.method, 'network.continueRequest');
  await h.handle('Network.setBlockedURLs', { urls: [] });
  assert.equal(h.calls.at(-1)!.method, 'session.unsubscribe');
});

test('Firefox cookie commands honor URL domain/path boundaries and context partitions', async () => {
  const h = harness();
  const cookie = { name: 'session', value: { type: 'string', value: 'secret' }, domain: '.app.test', path: '/api', secure: true, sameSite: 'lax' };
  h.replies.set('storage.getCookies', { cookies: [cookie, { ...cookie, domain: 'evil.test' }, { ...cookie, path: '/apix' }] });
  const result = await h.handle('Network.getCookies', { urls: ['https://sub.app.test/api/v1'] });
  assert.equal(result.cookies.length, 1); assert.equal(result.cookies[0].sameSite, 'Lax'); assert.equal(result.cookies[0].expires, -1);
  await h.handle('Network.deleteCookies', { name: 'session', url: 'https://sub.app.test/api/v1' });
  assert.deepEqual(h.calls.at(-1), { method: 'storage.deleteCookies', params: { partition: { type: 'context', context: 'context-1' }, filter: { name: 'session', domain: '.app.test', path: '/api' } } });
  await h.handle('Network.setCookie', { name: 'n', value: 'v', url: 'https://app.test/', httpOnly: true, sameSite: 'Strict', expires: 2000000000 });
  assert.deepEqual(h.calls.at(-1)!.params.cookie, { name: 'n', value: { type: 'string', value: 'v' }, domain: 'app.test', path: '/', secure: true, httpOnly: true, sameSite: 'strict', expiry: 2000000000 });
  await assert.rejects(h.handle('Network.deleteCookies', { name: 'n' }), /url or domain/);
});

test('Firefox reports unsupported mutations and body collectors without losing metadata capture', async () => {
  const h = harness(); h.replies.set('network.addDataCollector', new Error('unknown command'));
  await h.handle('Network.enable');
  h.network.onEvent(1, 'network.beforeRequestSent', request());
  assert.ok(h.events.some((e) => e.method === 'Network.requestWillBeSent'));
  await assert.rejects(h.handle('Network.getResponseBody', { requestId: 'r1' }), /capture unavailable/);
  await assert.rejects(h.handle('Network.emulateNetworkConditions', { latency: 100 }), /unsupported in Firefox/);
  await h.handle('Fetch.enable', { patterns: [{ requestStage: 'Response' }] });
  h.network.onEvent(1, 'network.responseStarted', { ...request(), isBlocked: true, response });
  await assert.rejects(h.handle('Fetch.fulfillRequest', { requestId: 'r1', responseCode: 200 }), /request stage/);
  await h.handle('Fetch.continueResponse', { requestId: 'r1' });
  assert.equal(h.calls.at(-1)!.method, 'network.continueResponse');
  await h.network.clear(1);
  assert.ok(h.calls.some((c) => c.method === 'network.removeIntercept'));
});
