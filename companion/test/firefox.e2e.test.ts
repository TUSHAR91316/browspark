// Native Firefox + the real companion over MCP. Run separately from Chrome E2E:
// FIREFOX_E2E=1 FIREFOX=/path/to/firefox bun test companion/test/firefox.e2e.test.ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { findFirefox } from '../src/firefox.ts';
import { startTestServer } from '../../test-apps/server.ts';
import { callers, ROOT } from './harness.ts';

describe.skipIf(process.env.FIREFOX_E2E !== '1')('Firefox native BiDi e2e', () => {
  let client: Client, http: Server, temp: string, appUrl: string, tabId: number;
  let call: ReturnType<typeof callers>['call'], ok: ReturnType<typeof callers>['ok'], okJson: ReturnType<typeof callers>['okJson'];
  const context = 'firefox-e2e';
  const refOf = (snapshot: string, name: string) => {
    const line = snapshot.split('\n').find((line) => /^\s*- (button|textbox|combobox|checkbox|link|radio|slider)\b/.test(line) && line.includes(`"${name}"`) && /\[ref=e\d+\]/.test(line));
    assert.ok(line, `No ref for ${name}:\n${snapshot}`);
    return /\[ref=(e\d+)\]/.exec(line)![1];
  };
  const evaluate = async (expression: string) => {
    const result = await okJson('devtools_evaluate', { tabId, expression });
    assert.ok(!result.exception, JSON.stringify(result));
    return result.value;
  };
  const fetchItems = () => evaluate("fetch('/api/items').then(async r => ({status:r.status, body:await r.json()}), () => ({blocked:true}))");
  const navigate = async (url: string) => {
    const result = await ok('browser_navigate', { tabId, url, timeoutMs: 5000 });
    assert.doesNotMatch(result, /Load event not seen/, result);
  };

  beforeAll(async () => {
    const firefoxPath = realpathSync(findFirefox(process.env.FIREFOX));
    temp = mkdtempSync(join(realpathSync(tmpdir()), 'browspark-firefox-e2e-'));
    ({ server: http, url: appUrl } = await startTestServer(join(ROOT, 'test-apps')));
    client = new Client({ name: 'firefox-e2e', version: '0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'companion/src/index.ts'), '--port', '0'],
      stderr: 'inherit',
      env: { ...process.env, BROWSPARK_FIREFOX: firefoxPath, BROWSPARK_PROFILE: join(temp, 'chrome-default'), BROWSPARK_PROFILES: join(temp, 'profiles'), BROWSPARK_ARTIFACTS: join(temp, 'artifacts') },
    }));
    ({ call, ok, okJson } = callers(client));
    const launch = await ok('browser_session', { action: 'launch', browser: 'firefox', context, headless: true, userRequested: true, url: appUrl, downloadDir: join(temp, 'downloads') });
    assert.match(launch, /Firefox/i);
    assert.doesNotMatch(launch, /CDP endpoint|DevTools opens/);
    const tabs = await ok('browser_tabs', { action: 'list' });
    const line = tabs.split('\n').find((line) => line.includes(`dev:firefox:${context}`) && line.includes(appUrl));
    assert.ok(line, tabs);
    tabId = Number(/\[(\d+)\]/.exec(line)![1]);
  }, 120_000);

  beforeEach(async () => {
    await navigate(appUrl);
    await ok('devtools_session', { action: 'start', tabId });
  }, 20_000);

  afterEach(async () => {
    if (!call || tabId === undefined) return;
    // Cleanup after assertion failures must release modal dialogs and interception.
    await call('browser_dialog', { tabId, accept: false }).catch(() => {});
    await call('browser_policy', { action: 'clear', tabId }).catch(() => {});
    await call('devtools_session', { action: 'stop', tabId }).catch(() => {});
  }, 20_000);

  afterAll(async () => {
    try {
      if (typeof ok === 'function') await ok('browser_session', { action: 'close', all: true });
    } finally {
      await client?.close();
      if (http) { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); }
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
  }, 30_000);

  test('launch schema, isolated profile, tabs, and capability reporting', async () => {
    const schema = (await client.listTools()).tools.find((tool) => tool.name === 'browser_session')!.inputSchema;
    assert.ok((schema.properties?.browser as { enum: string[] }).enum.includes('firefox'));
    const contexts = await okJson('browser_session', { action: 'contexts' });
    const firefox = contexts.find((item: any) => item.name === context && item.browser === 'firefox');
    assert.equal(firefox.profileDir, join(temp, 'profiles', '.firefox', context));
    assert.equal(firefox.running, true);
    assert.ok(existsSync(firefox.profileDir));
    assert.notEqual(firefox.profileDir, contexts.find((item: any) => item.browser === 'chromium' && item.name === 'default').profileDir);
    const status = await ok('browser_status');
    assert.match(status, /Firefox/i);
    assert.doesNotMatch(status, /connectOverCDP|Live view:.*\/live/);
    const caps = await okJson('devtools_capabilities', { tabId });
    assert.equal(caps.mode, 'dev');
    assert.match(caps.browser, /Firefox/i);
    assert.equal(caps.protocol, 'webdriver-bidi');
    assert.match(caps.domains.Runtime, /^partial/);
    assert.match(caps.domains.Tracing, /^unsupported/);

    const opened = await ok('browser_tabs', { action: 'new', mode: 'dev', context, url: appUrl + 'page2.html' });
    const other = Number(/Opened tab (\d+)/.exec(opened)![1]);
    assert.notEqual(other, tabId);
    assert.match(await ok('browser_snapshot', { tabId: other }), /Page Two/);
    await ok('browser_tabs', { action: 'activate', tabId: other });
    await ok('browser_tabs', { action: 'close', tabId: other });
    assert.doesNotMatch(await ok('browser_tabs'), new RegExp(`\\[${other}\\]`));
  }, 30_000);

  test('stable refs, trusted text/mouse/key input, selection, reading, and waits', async () => {
    const snap = await ok('browser_snapshot', { tabId });
    assert.match(snap, /heading "Test App" level=1/);
    assert.match(snap, /iframe "inner"[\s\S]*button "Frame button"/);
    const name = refOf(snap, 'Name'), color = refOf(snap, 'Color'), agree = refOf(snap, 'Agree'), submit = refOf(snap, 'Submit');
    assert.equal(refOf(await ok('browser_snapshot', { tabId }), 'Name'), name);
    await evaluate(`window.inputEvents = []; for (const type of ['click', 'input', 'keydown']) document.addEventListener(type, event => inputEvents.push({type, target:event.target.id, trusted:event.isTrusted}), true)`);
    await ok('browser_fill', { tabId, ref: name, text: 'Ada' });
    await ok('browser_select', { tabId, ref: color, values: ['Blue'] });
    await ok('browser_click', { tabId, ref: agree });
    await ok('browser_click', { tabId, ref: submit });
    assert.match(await ok('browser_read', { tabId, what: 'text' }), /submitted:Ada:b:true/);
    await ok('browser_click', { tabId, ref: name });
    await ok('browser_key', { tabId, key: 'End' });
    await ok('browser_key', { tabId, key: '!' });
    assert.equal(await evaluate('document.querySelector("#name").value'), 'Ada!');
    const events = await evaluate('inputEvents');
    for (const [type, target] of [['click', 'agree'], ['input', 'name'], ['keydown', 'name']]) {
      assert.ok(events.some((event: any) => event.type === type && event.target === target && event.trusted), `Missing native ${type} on ${target}: ${JSON.stringify(events)}`);
    }
    await ok('browser_fill', { tabId, ref: name, text: '' });
    assert.equal(await evaluate('document.querySelector("#name").value'), '');
    await ok('browser_click', { tabId, ref: refOf(snap, 'Frame button') });
    assert.match(await ok('browser_snapshot', { tabId }), /button "frame clicked"/);
    assert.deepEqual(await okJson('browser_read', { tabId, what: 'tables' }), [[['A', 'B'], ['1', '2']]]);
    assert.match(await ok('browser_read', { tabId, what: 'markdown' }), /# Test App/);
    const links = await okJson('browser_extract', { tabId, items: 'nav a', fields: { text: '.', href: { attr: 'href' } } });
    assert.equal(links[1].href, appUrl + 'page2.html');
    await ok('browser_click', { tabId, ref: refOf(snap, 'Load later') });
    await ok('browser_wait', { tabId, text: 'Loaded!', timeoutMs: 3000 });
    await ok('browser_scroll', { tabId, direction: 'down', amount: 500 });
    assert.ok(await evaluate('scrollY > 0'));
  }, 30_000);

  test('file upload delivers local contents to the page', async () => {
    const file = join(temp, 'attachment.txt');
    writeFileSync(file, 'Firefox upload fixture');
    await evaluate(`const label = document.createElement('label'); label.textContent = 'Attachment'; const input = document.createElement('input'); input.id = 'attachment'; input.type = 'file'; label.append(input); document.body.prepend(label)`);
    const ref = refOf(await ok('browser_snapshot', { tabId }), 'Attachment');
    await ok('browser_upload', { tabId, ref, files: [file] });
    assert.equal(await evaluate('document.querySelector("#attachment").files[0].name'), 'attachment.txt');
    assert.equal(await evaluate('document.querySelector("#attachment").files[0].text()'), 'Firefox upload fixture');
  });

  test('downloads report the completed file in the isolated download directory', async () => {
    const url = await evaluate(`const link = document.createElement('a'); link.textContent = 'Download fixture'; link.download = 'firefox-download.txt'; link.href = URL.createObjectURL(new Blob(['Firefox download fixture'], {type:'text/plain'})); document.body.prepend(link); link.href`);
    const ref = refOf(await ok('browser_snapshot', { tabId }), 'Download fixture');
    await ok('browser_click', { tabId, ref });
    const download = await okJson('browser_download', { tabId, action: 'wait', urlContains: url, timeoutMs: 5000 });
    assert.equal(download.state, 'completed');
    assert.equal(download.filename, 'firefox-download.txt');
    assert.equal(download.path, join(temp, 'downloads', 'firefox-download.txt'));
    assert.equal(readFileSync(download.path, 'utf8'), 'Firefox download fixture');
  }, 15_000);

  test('elements resolve refs and selectors for search, attributes, HTML, and styles', async () => {
    const ref = refOf(await ok('browser_snapshot', { tabId }), 'Name');
    const described = await okJson('devtools_elements', { tabId, action: 'describe', ref });
    assert.equal(described.nodeName, 'INPUT');
    await ok('devtools_elements', { tabId, action: 'attributes', ref, name: 'data-firefox', value: 'native' });
    assert.equal((await okJson('devtools_elements', { tabId, action: 'attributes', selector: '#name' }))['data-firefox'], 'native');
    const found = await okJson('devtools_elements', { tabId, action: 'search', query: '#name' });
    assert.equal(found.total, 1);
    assert.equal(found.items[0].ref, ref);
    assert.match(found.items[0].element, /input#name/);
    await ok('devtools_elements', { tabId, action: 'styles', selector: '#name', property: 'color', value: 'rgb(1, 2, 3)' });
    assert.equal((await okJson('devtools_elements', { tabId, action: 'computed', ref, properties: ['color'] })).color, 'rgb(1, 2, 3)');
    await ok('devtools_elements', { tabId, action: 'html', selector: '#out', set: '<p id="out">Firefox edited this element</p>' });
    assert.equal((await okJson('devtools_elements', { tabId, action: 'html', selector: '#out' })).html, '<p id="out">Firefox edited this element</p>');
    assert.match(await ok('browser_read', { tabId, what: 'text' }), /Firefox edited this element/);
  }, 20_000);

  test('navigation invalidates refs and back/forward/reload report real load events', async () => {
    const stale = refOf(await ok('browser_snapshot', { tabId }), 'Name');
    await navigate(appUrl + 'page2.html');
    assert.equal((await okJson('devtools_sources', { tabId, kind: 'frames' })).frames.length, 1, 'Navigation must remove the old iframe');
    const failure = await call('browser_click', { tabId, ref: stale });
    assert.equal(failure.err, true);
    assert.match(failure.txt, /snapshot|ref|stale|navigation/i);
    for (const [action, title] of [['back', 'Browspark Test App'], ['forward', 'Page Two'], ['reload', 'Page Two']]) {
      const result = await ok('browser_navigate', { tabId, action, timeoutMs: 5000 });
      assert.doesNotMatch(result, /Load event not seen/);
      assert.equal(await evaluate('document.title'), title);
      const frames = (await okJson('devtools_sources', { tabId, kind: 'frames' })).frames;
      assert.equal(frames.length, action === 'back' ? 2 : 1, JSON.stringify(frames));
    }
  }, 30_000);

  test('screenshots preserve format and full-page/element bounds, and PDF is valid', async () => {
    const screenshot = async (args: Record<string, unknown> = {}) => {
      const result = await call('browser_screenshot', { tabId, ...args });
      assert.equal(result.err, false, result.txt);
      assert.ok(result.img, result.txt);
      return { mimeType: result.img.mimeType, bytes: Buffer.from(result.img.data, 'base64') };
    };
    const viewport = await screenshot();
    assert.equal(viewport.mimeType, 'image/png');
    assert.equal(viewport.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const full = await screenshot({ fullPage: true });
    assert.ok(full.bytes.readUInt32BE(20) > viewport.bytes.readUInt32BE(20));
    assert.ok(full.bytes.readUInt32BE(20) >= 3000);
    const name = refOf(await ok('browser_snapshot', { tabId }), 'Name');
    const element = await screenshot({ ref: name });
    assert.ok(element.bytes.readUInt32BE(16) > 0 && element.bytes.readUInt32BE(16) < viewport.bytes.readUInt32BE(16));
    assert.ok(element.bytes.readUInt32BE(20) > 0 && element.bytes.readUInt32BE(20) < viewport.bytes.readUInt32BE(20));
    const jpeg = await screenshot({ format: 'jpeg', quality: 65 });
    assert.equal(jpeg.mimeType, 'image/jpeg');
    assert.equal(jpeg.bytes.subarray(0, 2).toString('hex'), 'ffd8');
    const pdf = join(temp, 'page.pdf');
    await ok('browser_pdf', { tabId, path: pdf, format: 'A4', printBackground: true });
    assert.equal(readFileSync(pdf).subarray(0, 5).toString(), '%PDF-');
  }, 45_000);

  test('native dialogs remain available to accept and dismiss without hanging input', async () => {
    const ref = refOf(await ok('browser_snapshot', { tabId }), 'Confirm');
    for (const [accept, text] of [[true, 'confirmed'], [false, 'cancelled']] as const) {
      await ok('browser_click', { tabId, ref });
      assert.match(await ok('browser_status'), /DIALOG OPEN: confirm "Sure\?"/);
      await ok('browser_dialog', { tabId, accept });
      await ok('browser_wait', { tabId, text, timeoutMs: 3000 });
    }
  }, 20_000);

  test('console, exceptions, live object inspection, and awaited evaluation', async () => {
    const frames = (await okJson('devtools_sources', { tabId, kind: 'frames' })).frames;
    const contexts = (await okJson('devtools_sources', { tabId, kind: 'contexts' })).contexts;
    const mainFrame = frames.find((frame: any) => !frame.parentId && frame.url === appUrl);
    assert.ok(mainFrame, JSON.stringify(frames));
    const mainContext = contexts.find((context: any) => context.isDefault && context.frameId === mainFrame.id);
    assert.ok(mainContext, JSON.stringify(contexts));
    assert.equal((await okJson('devtools_evaluate', { tabId, contextId: mainContext.id, expression: 'document.title' })).value, 'Browspark Test App');
    const childFrame = frames.find((frame: any) => frame.parentId === mainFrame.id);
    assert.ok(childFrame, JSON.stringify(frames));
    assert.ok(contexts.some((context: any) => context.isDefault && context.frameId === childFrame.id), JSON.stringify(contexts));
    assert.equal((await okJson('devtools_evaluate', { tabId, frameId: childFrame.id, expression: 'document.querySelector("#fb").textContent' })).value, 'Frame button');
    assert.deepEqual(await evaluate('Promise.resolve({answer:42, values:[true, null, "value"]})'), { answer: 42, values: [true, null, 'value'] });
    await evaluate('console.log("Firefox console fixture", {answer:42}); true');
    const message = await okJson('devtools_console', { tabId, action: 'wait', query: 'Firefox console fixture', timeoutMs: 5000 });
    assert.match(message.text, /Firefox console fixture/);
    const live = await okJson('devtools_evaluate', { tabId, expression: '({answer:42, nested:{enabled:true}})', returnByValue: false });
    assert.ok(live.objectId);
    const inspected = await okJson('devtools_console', { tabId, action: 'inspect', objectId: live.objectId, depth: 2 });
    assert.equal(inspected.answer, '42');
    assert.deepEqual(inspected.nested, { enabled: 'true' });
    await evaluate('setTimeout(() => { throw new Error("Firefox uncaught fixture"); }, 0); true');
    const exception = await okJson('devtools_console', { tabId, action: 'wait', kind: ['exception'], query: 'Firefox uncaught fixture', timeoutMs: 5000 });
    assert.match(exception.text, /Firefox uncaught fixture/);
    assert.match((await okJson('devtools_evaluate', { tabId, expression: 'throw new Error("evaluation fixture")' })).exception, /evaluation fixture/);
    const vitals = await okJson('devtools_performance', { tabId, action: 'vitals' });
    assert.ok(Number.isFinite(vitals.TTFB?.value), JSON.stringify(vitals));
    assert.equal(vitals.TTFB.value, await evaluate("Math.round(performance.getEntriesByType('navigation')[0].responseStart)"));
  }, 20_000);

  test('network capture, HAR, mocks, and independent domain policy teardown', async () => {
    assert.equal((await fetchItems()).status, 200);
    await ok('devtools_events', { tabId, method: 'Network.loadingFinished', wait: true, afterId: 0, timeoutMs: 5000 });
    const request = (await okJson('devtools_network', { tabId, query: '/api/items' })).items.at(-1);
    assert.ok(request, 'Expected the real fetch in network capture');
    const details = await okJson('devtools_network', { tabId, action: 'get', requestId: request.id });
    assert.equal(details.method, 'GET');
    assert.equal(details.status, 200);
    assert.match(details.responseHeaders['content-type'], /application\/json/);
    const harResult = await ok('devtools_network', { tabId, action: 'har' });
    const harPath = /to (.+\.har) \(/.exec(harResult)![1];
    assert.ok(harPath.startsWith(join(temp, 'artifacts')));
    assert.ok(JSON.parse(readFileSync(harPath, 'utf8')).log.entries.some((entry: any) => entry.request.url.endsWith('/api/items') && entry.response.status === 200));
    await ok('devtools_network', { tabId, action: 'cache', disabled: true });
    await ok('devtools_network', { tabId, action: 'mock', pattern: '*/api/items', response: { status: 202, json: { mocked: true } } });
    assert.deepEqual(await fetchItems(), { status: 202, body: { mocked: true } });
    await ok('browser_policy', { tabId, action: 'set', block: ['127.0.0.1'] });
    assert.deepEqual(await fetchItems(), { blocked: true }, 'Domain policy must take precedence over mocks');
    await ok('devtools_session', { tabId, action: 'stop' });
    assert.deepEqual(await fetchItems(), { blocked: true }, 'Stopping inspection must preserve an independent domain policy');
    await ok('browser_policy', { tabId, action: 'clear' });
    const restored = await fetchItems();
    assert.equal(restored.status, 200);
    assert.equal(restored.body.items[0].name, 'alpha', 'Stopping inspection must remove the mock');
  }, 30_000);

  test('cookies and DOM-backed storage use the Firefox context', async () => {
    await ok('devtools_storage', { tabId, area: 'cookies', action: 'set', cookie: { name: 'firefox_e2e', value: 'cookie-value', path: '/', sameSite: 'Lax' } });
    const cookies = await okJson('devtools_storage', { tabId, area: 'cookies', url: appUrl });
    assert.ok(cookies.some((cookie: any) => cookie.name === 'firefox_e2e' && cookie.value === 'cookie-value'));
    assert.match(await evaluate('document.cookie'), /firefox_e2e=cookie-value/);
    await ok('devtools_storage', { tabId, area: 'cookies', action: 'delete', name: 'firefox_e2e' });
    assert.doesNotMatch(await evaluate('document.cookie'), /firefox_e2e=/);
    const otherOrigin = 'https://unrelated.example.invalid/';
    for (const [url, path, value] of [[appUrl, '/', 'root'], [appUrl + 'admin', '/admin', 'admin'], [otherOrigin, '/', 'unrelated']]) {
      await ok('devtools_storage', { tabId, area: 'cookies', action: 'set', url, cookie: { name: 'firefox_scope', value, path } });
    }
    assert.equal((await okJson('devtools_storage', { tabId, area: 'cookies', url: appUrl + 'admin' })).filter((cookie: any) => cookie.name === 'firefox_scope').length, 2);
    await ok('devtools_storage', { tabId, area: 'clear', origin: new URL(appUrl).origin, types: ['cookies'] });
    assert.equal((await okJson('devtools_storage', { tabId, area: 'cookies', url: appUrl + 'admin' })).filter((cookie: any) => cookie.name === 'firefox_scope').length, 0);
    assert.equal((await okJson('devtools_storage', { tabId, area: 'cookies', url: otherOrigin })).find((cookie: any) => cookie.name === 'firefox_scope')?.value, 'unrelated');
    await ok('devtools_storage', { tabId, area: 'local', action: 'set', key: 'preserve-on-error', value: 'retained' });
    const unsupported = await call('devtools_storage', { tabId, area: 'clear', types: ['local_storage', 'shader_cache'] });
    assert.equal(unsupported.err, true, unsupported.txt);
    assert.match(unsupported.txt, /shader_cache/);
    assert.match(unsupported.txt, /unsupported|unavailable/i);
    assert.equal((await okJson('devtools_storage', { tabId, area: 'local' })).items['preserve-on-error'], 'retained');
    for (const area of ['local', 'session']) {
      await ok('devtools_storage', { tabId, area, action: 'set', key: 'firefox-e2e', value: area });
      assert.equal((await okJson('devtools_storage', { tabId, area })).items['firefox-e2e'], area);
      await ok('devtools_storage', { tabId, area, action: 'remove', key: 'firefox-e2e' });
      assert.equal((await okJson('devtools_storage', { tabId, area })).items['firefox-e2e'], undefined);
    }
  });

  test('Chromium-only operations return explicit errors', async () => {
    for (const [name, args] of [
      ['devtools_cdp', { method: 'Runtime.evaluate', params: { expression: '1' } }],
      ['devtools_lighthouse', {}],
      ['devtools_performance', { action: 'start' }],
      ['devtools_profile', { action: 'start' }],
      ['devtools_memory', { action: 'snapshot' }],
      ['devtools_coverage', { action: 'start' }],
      ['devtools_debugger', { action: 'pause' }],
      ['devtools_network', { action: 'throttle', preset: 'slow3g' }],
    ] as const) {
      const result = await call(name, { tabId, ...args });
      assert.equal(result.err, true, `${name} must fail explicitly: ${result.txt}`);
      assert.match(result.txt, /Firefox|Chromium|BiDi/i, result.txt);
      assert.match(result.txt, /unsupported|unavailable|not available|requires|does not support/i, result.txt);
      assert.doesNotMatch(result.txt, /timed out|connection closed|ENOENT/i, result.txt);
    }
  }, 30_000);
});
