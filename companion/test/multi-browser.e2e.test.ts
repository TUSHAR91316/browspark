import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startTestServer } from '../../test-apps/server.ts';
import { callers, companionTab, dashboard, launchExtensionChrome, pairAndShare, ROOT, startCompanion, type Ext } from './harness.ts';

describe.skipIf(!process.env.E2E)('multi-browser e2e', () => {
test('simultaneous extension browsers route tools, policies, new tabs and reconnects independently', async () => {
  const { server, url } = await startTestServer(join(ROOT, 'test-apps'));
  const browsers: Ext[] = [];
  let client: Awaited<ReturnType<typeof startCompanion>> | undefined;
  try {
    const first = await launchExtensionChrome(); browsers.push(first);
    const second = await launchExtensionChrome(process.env.BROWSPARK_TEST_SECOND_BROWSER ?? process.env.CHROME_SECOND); browsers.push(second);
    client = await startCompanion();
    const { call, ok, okJson } = callers(client);
    const firstUrl = `${url}basic.html?browser=first`, secondUrl = `${url}basic.html?browser=second`;
    await first.cdp.send('Target.createTarget', { url: firstUrl });
    await second.cdp.send('Target.createTarget', { url: secondUrl });
    const firstTab = await pairAndShare(first, ok, firstUrl), secondTab = await pairAndShare(second, ok, secondUrl);
    const firstInfo = await companionTab(ok, firstUrl), secondInfo = await companionTab(ok, secondUrl);
    assert.notEqual(firstTab, secondTab);
    assert.ok(firstInfo.browserId && secondInfo.browserId);
    assert.notEqual(firstInfo.browserId, secondInfo.browserId);
    const status = await ok('browser_status');
    assert.ok(status.includes(firstInfo.browserId) && status.includes(secondInfo.browserId), status);
    for (const [tabId, marker] of [[firstTab, 'first'], [secondTab, 'second']] as const) {
      assert.equal((await okJson('devtools_evaluate', { tabId, expression: `window.browserMarker = '${marker}'` })).value, marker);
      await ok('devtools_session', { action: 'start', tabId });
      await ok('devtools_evaluate', { tabId, expression: `console.log('browser-${marker}'); browserMarker` });
    }
    assert.equal((await okJson('devtools_evaluate', { tabId: firstTab, expression: 'browserMarker' })).value, 'first');
    assert.equal((await okJson('devtools_evaluate', { tabId: secondTab, expression: 'browserMarker' })).value, 'second');
    const firstLogs = await okJson('devtools_console', { tabId: firstTab, query: 'browser-' });
    const secondLogs = await okJson('devtools_console', { tabId: secondTab, query: 'browser-' });
    assert.ok(firstLogs.items.some((entry: any) => entry.text === 'browser-first'));
    assert.ok(secondLogs.items.some((entry: any) => entry.text === 'browser-second'));
    assert.ok(!firstLogs.items.some((entry: any) => entry.text === 'browser-second'));
    assert.ok(!secondLogs.items.some((entry: any) => entry.text === 'browser-first'));
    const ambiguousTab = await call('browser_snapshot');
    assert.ok(ambiguousTab.err && /tabId is required/.test(ambiguousTab.txt), ambiguousTab.txt);
    const ambiguousBrowser = await call('browser_tabs', { action: 'new', url: 'about:blank' });
    assert.ok(ambiguousBrowser.err && /browserId/.test(ambiguousBrowser.txt), ambiguousBrowser.txt);

    const firstMsg = await dashboard(first), secondMsg = await dashboard(second);
    await firstMsg({ type: 'setToolEnabled', name: 'browser_snapshot', enabled: false });
    let disabled = await call('browser_snapshot', { tabId: firstTab });
    for (let i = 0; !disabled.err && i < 20; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); disabled = await call('browser_snapshot', { tabId: firstTab }); }
    assert.ok(disabled.err && /disabled|switched off/.test(disabled.txt), disabled.txt);
    assert.match(await ok('browser_snapshot', { tabId: secondTab }), /Test App/);
    await firstMsg({ type: 'setToolEnabled', name: 'browser_snapshot', enabled: true });
    await ok('browser_tabs'); // serialize a round trip after the policy update

    const openedUrl = `${url}page2.html?opened=second`;
    const opened = await ok('browser_tabs', { action: 'new', browserId: secondInfo.browserId, url: openedUrl });
    const openedId = Number(/tab (\d+)/.exec(opened)![1]);
    assert.equal((await companionTab(ok, openedUrl)).browserId, secondInfo.browserId);
    assert.match(await ok('browser_snapshot', { tabId: openedId }), /Page Two/);
    assert.equal((await firstMsg({ type: 'getState' })).tabs.some((tab: any) => tab.url === openedUrl), false);
    assert.equal((await secondMsg({ type: 'getState' })).tabs.some((tab: any) => tab.url === openedUrl && tab.agent), true);
    await ok('browser_tabs', { action: 'close', tabId: openedId });

    const beforeReconnect = await firstMsg({ type: 'getState' });
    const reconnect = firstMsg({ type: 'setConfig', port: beforeReconnect.port });
    assert.equal((await okJson('devtools_evaluate', { tabId: secondTab, expression: 'browserMarker' })).value, 'second');
    await reconnect;
    let reconnected: any;
    for (let i = 0; i < 50; i++) {
      reconnected = await firstMsg({ type: 'getState' });
      if (reconnected.connected && reconnected.connectedAt > beforeReconnect.connectedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(reconnected.connected && reconnected.connectedAt > beforeReconnect.connectedAt, 'first browser reconnected');
    assert.equal((await companionTab(ok, firstUrl)).id, firstTab, 'same browser session keeps companion tab ids');
    assert.equal((await companionTab(ok, secondUrl)).id, secondTab);
    assert.equal((await okJson('devtools_session', { action: 'status', tabId: secondTab })).active, true, 'other browser inspection survives reconnect');
    assert.match(await ok('browser_snapshot', { tabId: firstTab }), /Test App/);

    await firstMsg({ type: 'stop' });
    assert.equal((await okJson('devtools_evaluate', { tabId: secondTab, expression: 'browserMarker' })).value, 'second');
    assert.equal((await okJson('devtools_session', { action: 'status', tabId: secondTab })).active, true, 'other browser inspection survives disconnect');
    assert.equal((await call('browser_snapshot', { tabId: firstTab })).err, true);
    assert.ok(!(await ok('browser_status')).includes(firstInfo.browserId), 'disconnected browser is removed from status');
    await ok('devtools_session', { action: 'stop', tabId: secondTab });
  } finally {
    await client?.close().catch(() => {});
    for (const browser of browsers) await browser.cleanup();
    server.close();
  }
}, 120_000);
});
