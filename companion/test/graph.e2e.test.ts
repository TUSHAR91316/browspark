import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestServer } from '../../test-apps/server.ts';
import { callers, dashboard, launchExtensionChrome, pairAndShare, ROOT, startCompanion, type Ext } from './harness.ts';

describe.skipIf(!process.env.E2E)('connection graph e2e', () => {
test('graph follows multiple browsers and agents, with a persistent per-browser visibility setting', async () => {
  const { server, url } = await startTestServer(join(ROOT, 'test-apps'));
  const browsers: Ext[] = [];
  let client: Client | undefined, secondClient: Client | undefined, secondTransport: StreamableHTTPClientTransport | undefined;
  const waitFor = async (check: () => Promise<unknown>, description: string) => {
    for (let i = 0; i < 100; i++) {
      if (await check().catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(description);
  };
  try {
    const first = await launchExtensionChrome(); browsers.push(first);
    const second = await launchExtensionChrome(process.env.BROWSPARK_TEST_SECOND_BROWSER ?? process.env.CHROME_SECOND); browsers.push(second);
    client = await startCompanion();
    const { ok } = callers(client);
    const firstUrl = `${url}basic.html?private-graph-fixture=first`, secondUrl = `${url}page2.html?private-graph-fixture=second`;
    await first.cdp.send('Target.createTarget', { url: firstUrl });
    await second.cdp.send('Target.createTarget', { url: secondUrl });
    await pairAndShare(first, ok, firstUrl);
    await pairAndShare(second, ok, secondUrl);
    const firstMsg = await dashboard(first), secondMsg = await dashboard(second);
    const port = Number(/ws:\/\/127\.0\.0\.1:(\d+)/.exec(await ok('browser_status'))![1]);
    secondClient = new Client({ name: 'Graph Designer', version: '0' });
    secondTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await secondClient.connect(secondTransport);
    await callers(secondClient).ok('browser_status');

    const state = () => firstMsg({ type: 'getState' });
    await waitFor(async () => {
      const s = await state();
      return s.graphEnabled && s.graph?.agents.length === 2 && s.graph?.browsers.length === 2;
    }, 'both browsers and initialized MCP agents appear in the graph');
    const firstState = await state();
    await waitFor(async () => (await secondMsg({ type: 'getState' })).graph?.agents.length === 2, 'second browser receives the graph');
    const secondState = await secondMsg({ type: 'getState' });
    assert.notEqual(firstState.graph.thisBrowserId, secondState.graph.thisBrowserId);
    const byId = (nodes: any[]) => [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(byId(firstState.graph.browsers), byId(secondState.graph.browsers));
    assert.deepEqual(byId(firstState.graph.agents), byId(secondState.graph.agents));
    assert.deepEqual(firstState.graph.agents.map((agent: any) => agent.name).sort(), ['Graph Designer', 'e2e']);
    assert.equal(new Set(firstState.graph.agents.map((agent: any) => agent.id)).size, 2);
    assert.ok(firstState.graph.browsers.every((browser: any) => browser.mode === 'extension' && browser.sharedTabs === 1));
    assert.doesNotMatch(JSON.stringify(firstState.graph), /private-graph-fixture|Browspark Test App|Page Two|https?:\/\//, 'graph does not expose tab URLs or titles');

    await waitFor(() => first.eval!(`!!document.querySelector('#nav a[href="#/graph"]') && document.querySelector('#main h1')?.textContent === 'Overview'`), 'Graph link appears in the Overview sidebar');
    assert.equal(await first.eval!(`document.body.textContent.includes('Use browsers together')`), false, 'old informational card is removed from Overview');
    await first.eval!(`document.querySelector('#nav a[href="#/graph"]').click()`);
    await waitFor(() => first.eval!(`!!document.querySelector('#connection-graph') && document.querySelectorAll('.graph-browser').length === 2 && document.querySelectorAll('.graph-agent').length === 2`), 'Graph page renders both browser and agent nodes');
    assert.equal(await first.eval!(`document.querySelector('.graph-browser[data-current-browser="true"]')?.dataset.browserId`), firstState.graph.thisBrowserId);
    for (const browser of firstState.graph.browsers) {
      assert.ok(await first.eval!(`[...document.querySelectorAll('.graph-browser')].some(node => node.dataset.browserId === ${JSON.stringify(browser.id)} && node.textContent.includes(${JSON.stringify(browser.name)}))`));
    }
    for (const agent of firstState.graph.agents) assert.ok(await first.eval!(`[...document.querySelectorAll('.graph-agent')].some(node => node.dataset.agentId === ${JSON.stringify(agent.id)} && node.textContent.includes(${JSON.stringify(agent.name)}))`));

    const targets = await first.cdp.send('Target.getTargets');
    const graphTarget = targets.targetInfos.find((target: any) => target.url === `chrome-extension://${first.extId}/app.html#/graph`);
    assert.ok(graphTarget, 'graph dashboard target exists');
    const { sessionId } = await first.cdp.send('Target.attachToTarget', { targetId: graphTarget.targetId, flatten: true });
    for (const [width, path] of [[1200, '/tmp/browspark-graph.png'], [390, '/tmp/browspark-graph-mobile.png']] as const) {
      await first.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 1400 : 900, deviceScaleFactor: 1, mobile: false }, sessionId);
      await waitFor(() => first.eval!(`window.innerWidth === ${width}`), `graph viewport resized to ${width}`);
      assert.ok(await first.eval!(`document.documentElement.scrollWidth <= window.innerWidth`), 'dashboard fits the viewport without page overflow');
      const { cssContentSize } = await first.cdp.send('Page.getLayoutMetrics', {}, sessionId);
      const screenshot = await first.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...cssContentSize, scale: 1 } }, sessionId);
      writeFileSync(path, Buffer.from(screenshot.data, 'base64'));
    }
    await first.cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

    await first.eval!(`location.hash = '#/settings'`);
    await waitFor(() => first.eval!(`document.querySelector('#graph-enabled')?.checked === true`), 'Settings contains enabled graph switch');
    await first.eval!(`document.querySelector('#graph-enabled').click()`);
    await waitFor(async () => {
      const s = await state();
      return s.graphEnabled === false && !s.graph && await first.eval!(`!document.querySelector('#nav a[href="#/graph"]')`);
    }, 'disabling the graph clears its snapshot and hides its sidebar item');
    assert.equal((await secondMsg({ type: 'getState' })).graphEnabled, true, 'graph visibility belongs to each browser profile');
    await first.eval!('location.reload()');
    await waitFor(() => first.eval!(`document.querySelector('#graph-enabled')?.checked === false && !document.querySelector('#nav a[href="#/graph"]')`), 'graph visibility persists after dashboard reload');
    await first.eval!(`location.hash = '#/graph'`);
    await waitFor(() => first.eval!(`document.body.textContent.includes('Connection graph is off') && !document.querySelector('#connection-graph')`), 'disabled direct route does not render the graph');
    await first.eval!(`location.hash = '#/settings'`);
    await waitFor(() => first.eval!(`!!document.querySelector('#graph-enabled')`), 'Settings returns after the disabled route');
    await first.eval!(`document.querySelector('#graph-enabled').click()`);
    await waitFor(async () => (await state()).graph?.browsers.length === 2, 'enabling the graph requests current connections');
    await waitFor(() => first.eval!(`!!document.querySelector('#nav a[href="#/graph"]')`), 'enabled graph returns to the sidebar');
    await first.eval!(`document.querySelector('#nav a[href="#/graph"]').click()`);
    await waitFor(() => first.eval!(`document.querySelectorAll('.graph-browser').length === 2`), 'graph is visible again');

    await secondMsg({ type: 'stop' });
    await waitFor(async () => (await state()).graph?.browsers.length === 1 && await first.eval!(`document.querySelectorAll('.graph-browser').length === 1`), 'disconnected browser disappears from the graph');
    assert.equal((await secondMsg({ type: 'getState' })).graph, undefined, 'disconnected dashboard clears its remote graph');
    await secondTransport.terminateSession();
    await secondClient.close(); secondClient = undefined; secondTransport = undefined;
    await waitFor(async () => (await state()).graph?.agents.length === 1 && await first.eval!(`document.querySelectorAll('.graph-agent').length === 1`), 'disconnected MCP agent disappears from the graph');
    assert.deepEqual((await state()).graph.agents.map((agent: any) => agent.name), ['e2e']);
  } finally {
    await secondTransport?.terminateSession().catch(() => {});
    await secondClient?.close().catch(() => {});
    await client?.close().catch(() => {});
    for (const browser of browsers) await browser.cleanup();
    server.close();
  }
}, 120_000);
});
