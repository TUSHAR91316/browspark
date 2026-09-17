import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';
import { startTestServer } from '../../test-apps/server.ts';
import { callers, dashboard, launchExtensionChrome, pairAndShare, ROOT, startCompanion, type Ext } from './harness.ts';

describe.skipIf(!process.env.E2E)('connection graph e2e', () => {
test('graph follows multiple browsers and agents, with a persistent per-browser visibility setting', async () => {
  const { server, url } = await startTestServer(join(ROOT, 'test-apps'));
  const browsers: Ext[] = [];
  let client: Client | undefined, secondClient: Client | undefined, secondTransport: StreamableHTTPClientTransport | undefined;
  let otherClient: Client | undefined, otherTransport: StreamableHTTPClientTransport | undefined;
  const fallbackSockets: WebSocket[] = [];
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
    client = await startCompanion('Codex');
    const { ok } = callers(client);
    const firstUrl = `${url}basic.html?private-graph-fixture=first`, secondUrl = `${url}page2.html?private-graph-fixture=second`;
    await first.cdp.send('Target.createTarget', { url: firstUrl });
    await second.cdp.send('Target.createTarget', { url: secondUrl });
    await pairAndShare(first, ok, firstUrl);
    await pairAndShare(second, ok, secondUrl);
    const firstMsg = await dashboard(first), secondMsg = await dashboard(second);
    const port = Number(/ws:\/\/127\.0\.0\.1:(\d+)/.exec(await ok('browser_status'))![1]);
    secondClient = new Client({ name: 'Claude Code', version: '0' });
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
    assert.deepEqual(firstState.graph.agents.map((agent: any) => agent.name).sort(), ['Claude Code', 'Codex']);
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
    await waitFor(() => first.eval!(`document.querySelectorAll('.graph-browser img.graph-brand-logo').length === 2 && [...document.querySelectorAll('img.graph-brand-logo')].every(img => img.complete && img.naturalWidth > 0 && new URL(img.src).origin === location.origin)`), 'browser logos load from the extension package');
    for (const browser of firstState.graph.browsers) {
      const brand = /brave/i.test(browser.name) ? 'brave' : 'chrome';
      assert.ok(await first.eval!(`document.querySelector('[data-browser-id="${browser.id}"] img.graph-brand-logo')?.src.includes('/${brand}.')`), `${browser.name} displays its own logo`);
    }
    const claudeId = firstState.graph.agents.find((agent: any) => agent.name === 'Claude Code').id;
    assert.ok(await first.eval!(`document.querySelector('[data-agent-id="${claudeId}"] img.graph-brand-logo')?.src.includes('/claude.')`), 'recognized agent has its own packaged logo');
    const codexId = firstState.graph.agents.find((agent: any) => agent.name === 'Codex').id;
    assert.ok(await first.eval!(`(() => { const logo = document.querySelector('[data-agent-id="${codexId}"] img.graph-brand-logo'); return logo?.src.includes('/codex.') && logo.complete && logo.naturalWidth > 0; })()`), 'Codex logo decodes from its packaged asset');
    const nodeWidth = () => first.eval!(`document.querySelector('.graph-browser').getBoundingClientRect().width`) as Promise<number>;
    const initialWidth = await nodeWidth();
    await first.eval!(`document.querySelector('#graph-zoom-in').click()`);
    await waitFor(async () => await nodeWidth() > initialWidth, 'zoom in enlarges graph nodes');
    const zoomedWidth = await nodeWidth();
    await first.eval!(`document.querySelector('#graph-zoom-out').click()`);
    await waitFor(async () => await nodeWidth() < zoomedWidth, 'zoom out reduces graph nodes');

    const targets = await first.cdp.send('Target.getTargets');
    const graphTarget = targets.targetInfos.find((target: any) => target.url === `chrome-extension://${first.extId}/app.html#/graph`);
    assert.ok(graphTarget, 'graph dashboard target exists');
    const { sessionId } = await first.cdp.send('Target.attachToTarget', { targetId: graphTarget.targetId, flatten: true });
    await first.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, sessionId);
    assert.ok(await first.eval!(`document.querySelector('#graph-canvas') && getComputedStyle(document.querySelector('.graph-edge-flow')).animationName !== 'none'`), 'canvas connections animate while connected');
    await first.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
    await waitFor(() => first.eval!(`[...document.querySelectorAll('.graph-edge-flow')].every(edge => getComputedStyle(edge).animationName === 'none')`), 'reduced motion stops moving connection lines');
    await first.cdp.send('Emulation.setEmulatedMedia', { features: [] }, sessionId);
    // Pairing can briefly display the default companion's topology before the test companion's data arrives.
    await first.eval!(`document.querySelector('#graph-reset').click(); new Promise(requestAnimationFrame)`);
    const canvasPosition = () => first.eval!(`(() => { const canvas = document.querySelector('#graph-canvas'); return { left: Number(canvas.dataset.panX), top: Number(canvas.dataset.panY), zoom: Number(canvas.dataset.zoom) }; })()`);
    const nodePosition = (selector: string) => first.eval!(`(() => { const node = document.querySelector(${JSON.stringify(selector)}), r = node.getBoundingClientRect(); return { key: node.dataset.graphNode, x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const edgePaths = (key: string) => first.eval!(`[...document.querySelectorAll('.graph-edge')].filter(edge => edge.dataset.from === ${JSON.stringify(key)} || edge.dataset.to === ${JSON.stringify(key)}).map(edge => edge.querySelector('path').getAttribute('d'))`);
    const nodeLayout = () => first.eval!(`[...document.querySelectorAll('[data-graph-node]')].map(node => ({ key: node.dataset.graphNode, x: Number(node.dataset.x), y: Number(node.dataset.y) }))`);
    const originalNodes = await nodeLayout();
    for (const [selector, dx, dy] of [['.graph-agent', 70, -45], ['.graph-browser', -60, 40], ['.graph-hub', 20, -50]] as const) {
      const before = await nodePosition(selector), beforeCamera = await canvasPosition(), paths = await edgePaths(before.key);
      assert.ok(paths.length, `${selector} has a connection line`);
      const pointer = await first.eval!(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).querySelector('img').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await first.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pointer, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
      await first.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x + dx, y: pointer.y + dy, button: 'left', buttons: 1 }, sessionId);
      await waitFor(async () => {
        const moved = await nodePosition(selector);
        return Math.abs(moved.x - before.x - dx) < 2 && Math.abs(moved.y - before.y - dy) < 2;
      }, `${selector} follows the pointer before release`);
      assert.notDeepEqual(await edgePaths(before.key), paths, `${selector} connection follows the node during drag`);
      const afterCamera = await canvasPosition();
      assert.equal(afterCamera.zoom, beforeCamera.zoom, `${selector} dragging does not zoom the canvas`);
      assert.ok(Math.abs(afterCamera.left - beforeCamera.left) < .01 && Math.abs(afterCamera.top - beforeCamera.top) < .01, `${selector} dragging does not pan the canvas`);
      await first.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pointer.x + dx, y: pointer.y + dy, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
    }
    const keyboardBefore = await nodePosition('.graph-agent');
    await first.eval!(`document.querySelector('.graph-agent').focus()`);
    await first.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, sessionId);
    await first.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, sessionId);
    await waitFor(async () => (await nodePosition('.graph-agent')).x > keyboardBefore.x, 'focused nodes can be moved with the keyboard');
    const coalesced = await first.eval!(`(async () => {
      const node = document.querySelector('.graph-agent'), canvas = document.querySelector('#graph-canvas'), r = node.getBoundingClientRect();
      const pointer = { bubbles: true, pointerId: 12345, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
      let writes = 0;
      const observer = new MutationObserver(records => writes += records.length);
      observer.observe(node, { attributes: true, attributeFilter: ['style'] });
      node.dispatchEvent(new PointerEvent('pointerdown', pointer));
      for (let i = 1; i <= 20; i++) canvas.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: pointer.clientX + i }));
      const beforeFrame = writes + observer.takeRecords().length;
      await new Promise(requestAnimationFrame);
      const afterFrame = writes + observer.takeRecords().length;
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
      observer.disconnect();
      return { beforeFrame, afterFrame, movement: node.getBoundingClientRect().x - r.x };
    })()`);
    assert.equal(coalesced.beforeFrame, 0, 'a pointer event burst does not write node transforms before the next frame');
    assert.equal(coalesced.afterFrame, 1, 'a pointer event burst produces one transform write per animation frame');
    assert.ok(Math.abs(coalesced.movement - 20) < 2, 'the coalesced frame applies the full pointer movement');

    await first.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 }, sessionId);
    const touchBefore = await nodePosition('.graph-browser');
    const touch = { x: touchBefore.x + touchBefore.width / 2, y: touchBefore.y + touchBefore.height / 2, id: 0 };
    await first.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] }, sessionId);
    await first.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch, x: touch.x - 30, y: touch.y - 25 }] }, sessionId);
    await waitFor(async () => Math.abs((await nodePosition('.graph-browser')).x - touchBefore.x + 30) < 2, 'touch moves a browser node freely');
    await first.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    await first.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId);

    const beforePan = await canvasPosition();
    const pointer = await first.eval!(`(() => { const r = document.querySelector('#graph-canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 8 }; })()`);
    await first.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pointer, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await first.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x + 80, y: pointer.y + 20, button: 'left', buttons: 1 }, sessionId);
    await first.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pointer.x + 80, y: pointer.y + 20, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
    await waitFor(async () => Math.abs((await canvasPosition()).left - beforePan.left - 80) < 2, 'blank canvas pans freely at Fit without scroll overflow');

    const beforeWheel = await canvasPosition();
    await first.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...pointer, deltaX: 20, deltaY: 40 }, sessionId);
    await waitFor(async () => Math.abs((await canvasPosition()).top - beforeWheel.top) > 20, 'wheel scrolling pans the canvas');
    const anchor = await first.eval!(`(() => { const r = document.querySelector('#graph-canvas').getBoundingClientRect(); return { x: r.left + r.width * .6, y: r.top + r.height * .4, localX: r.width * .6, localY: r.height * .4 }; })()`);
    const beforeWheelZoom = await canvasPosition();
    await first.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: anchor.x, y: anchor.y, deltaX: 0, deltaY: -100, modifiers: 2 }, sessionId);
    await waitFor(async () => (await canvasPosition()).zoom > beforeWheelZoom.zoom, 'Ctrl-wheel zooms the graph');
    const afterWheelZoom = await canvasPosition();
    assert.ok(Math.abs((anchor.localX - beforeWheelZoom.left) / beforeWheelZoom.zoom - (anchor.localX - afterWheelZoom.left) / afterWheelZoom.zoom) < 2, 'zoom keeps the pointed world x coordinate in place');
    assert.ok(Math.abs((anchor.localY - beforeWheelZoom.top) / beforeWheelZoom.zoom - (anchor.localY - afterWheelZoom.top) / afterWheelZoom.zoom) < 2, 'zoom keeps the pointed world y coordinate in place');

    const panned = await canvasPosition();
    const arrangedNodes = await nodeLayout();
    const assertPosition = async (description: string) => {
      const position = await canvasPosition();
      assert.equal(position.zoom, panned.zoom, `${description}: zoom is preserved`);
      assert.ok(Math.abs(position.left - panned.left) <= 1 && Math.abs(position.top - panned.top) <= 1, `${description}: pan is preserved`);
      assert.deepEqual(await nodeLayout(), arrangedNodes, `${description}: node positions are preserved`);
    };
    await first.eval!(`globalThis.__graphFlow = document.querySelector('.graph-edge-flow'); globalThis.__graphAnimation = globalThis.__graphFlow.getAnimations()[0]`);
    await first.eval!(`document.querySelector('#theme button[aria-label="Dark theme"]').click()`);
    await assertPosition('theme repaint');
    const sharedTab = firstState.tabs.find((tab: any) => tab.url === firstUrl);
    assert.ok(sharedTab);
    await firstMsg({ type: 'setShared', tabIds: [sharedTab.id], shared: false });
    await waitFor(() => first.eval!(`document.querySelector('.graph-browser[data-current-browser="true"]').textContent.includes('0 tabs shared')`), 'polling repaints changed graph metadata');
    await assertPosition('connection metadata repaint');
    assert.ok(await first.eval!(`globalThis.__graphFlow === document.querySelector('.graph-edge-flow') && globalThis.__graphAnimation === globalThis.__graphFlow.getAnimations()[0]`), 'live metadata updates preserve the running connection animation');
    await firstMsg({ type: 'setShared', tabIds: [sharedTab.id], shared: true });
    await waitFor(() => first.eval!(`document.querySelector('.graph-browser[data-current-browser="true"]').textContent.includes('1 tab shared')`), 'shared tab is restored after the repaint check');
    await first.eval!(`location.hash = '#/settings'`);
    await waitFor(() => first.eval!(`!!document.querySelector('#graph-enabled')`), 'Settings opens without losing the graph layout');
    await first.eval!(`location.hash = '#/graph'`);
    await waitFor(() => first.eval!(`!!document.querySelector('#graph-canvas')`), 'graph route returns');
    await assertPosition('returning to Graph');
    for (const [width, theme, path] of [[1200, 'Dark', '/tmp/browspark-graph.png'], [1200, 'Light', '/tmp/browspark-graph-light.png'], [390, 'Dark', '/tmp/browspark-graph-mobile.png']] as const) {
      await first.eval!(`document.querySelector('#theme button[aria-label="${theme} theme"]').click()`);
      await waitFor(() => first.eval!(`document.documentElement.dataset.theme === '${theme.toLowerCase()}' && [...document.querySelectorAll('img.graph-brand-logo')].every(img => img.complete && img.naturalWidth > 0)`), `graph logos load in ${theme.toLowerCase()} theme`);
      await first.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 1400 : 900, deviceScaleFactor: 1, mobile: false }, sessionId);
      await waitFor(() => first.eval!(`window.innerWidth === ${width}`), `graph viewport resized to ${width}`);
      await first.eval!(`document.querySelector('#graph-fit').click()`);
      await waitFor(() => first.eval!(`(() => { const canvas = document.querySelector('#graph-canvas').getBoundingClientRect(); return [...document.querySelectorAll('[data-graph-node]')].every(node => { const r = node.getBoundingClientRect(); return r.left >= canvas.left - 1 && r.right <= canvas.right + 1 && r.top >= canvas.top - 1 && r.bottom <= canvas.bottom + 1; }); })()`), 'Fit brings every moved node and the companion inside the canvas');
      assert.ok(await first.eval!(`document.documentElement.scrollWidth <= window.innerWidth`), 'dashboard fits the viewport without page overflow');
      await new Promise((resolve) => setTimeout(resolve, 250)); // Let theme color transitions settle before visual review.
      const { cssContentSize } = await first.cdp.send('Page.getLayoutMetrics', {}, sessionId);
      const screenshot = await first.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...cssContentSize, scale: 1 } }, sessionId);
      writeFileSync(path, Buffer.from(screenshot.data, 'base64'));
      if (width === 1200 && theme === 'Dark') writeFileSync('/tmp/browspark-graph-freestyle.png', Buffer.from(screenshot.data, 'base64'));
    }
    await first.cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    await waitFor(() => first.eval!(`document.querySelector('#graph-canvas')?.dataset.layout === 'desktop'`), 'desktop layout returns');
    await first.eval!(`document.querySelector('#graph-reset').click()`);
    await waitFor(async () => JSON.stringify(await nodeLayout()) === JSON.stringify(originalNodes), 'Reset restores the original node arrangement').catch(async (error) => {
      assert.deepEqual(await nodeLayout(), originalNodes, error.message);
    });

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
    assert.deepEqual((await state()).graph.agents.map((agent: any) => agent.name), ['Codex']);

    otherClient = new Client({ name: 'mystery-agent-7', version: '0' });
    otherTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await otherClient.connect(otherTransport);
    for (const [browserEngine, browser] of [['chromium', 'Mystery Browser 1.0'], ['firefox', 'Private Browser 2.0']] as const) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`); fallbackSockets.push(socket);
      socket.on('message', data => {
        const request = JSON.parse(data.toString());
        if (request.method === 'tools.catalog' || request.method === 'tabs.list') socket.send(JSON.stringify({ id: request.id, result: request.method === 'tabs.list' ? [] : {} }));
      });
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      socket.send(JSON.stringify({ event: 'hello', params: { version: PROTOCOL_VERSION, extensionVersion: 'test', instanceId: `graph-fallback-${browserEngine}`, browserSessionId: 'test', browser, browserEngine } }));
      socket.send(JSON.stringify({ event: 'tabs', params: [] }));
    }
    await waitFor(() => first.eval!(`document.querySelectorAll('.graph-agent').length === 2 && document.querySelectorAll('.graph-browser').length === 3`), 'unrecognized clients and browser profiles appear alongside known connections');
    const fallbackGraph = (await state()).graph;
    for (const [selector, reported, label, asset] of [
      [`[data-agent-id="${fallbackGraph.agents.find((agent: any) => agent.name === 'mystery-agent-7').id}"]`, 'mystery-agent-7', 'Other agent', 'other-agent.svg'],
      [`[data-browser-id="${fallbackGraph.browsers.find((browser: any) => browser.name === 'Mystery Browser 1.0').id}"]`, 'Mystery Browser 1.0', 'Unknown Chromium', 'chromium.png'],
      [`[data-browser-id="${fallbackGraph.browsers.find((browser: any) => browser.name === 'Private Browser 2.0').id}"]`, 'Private Browser 2.0', 'Unknown Firefox', 'firefox.png'],
    ]) {
      await waitFor(() => first.eval!(`(() => { const node = document.querySelector(${JSON.stringify(selector)}), logo = node?.querySelector('img.graph-brand-logo'); return node?.querySelector('h3')?.textContent === ${JSON.stringify(label)} && node.title.startsWith(${JSON.stringify(reported + ' · ')}) && logo?.src.endsWith(${JSON.stringify('/' + asset)}) && logo.complete && logo.naturalWidth > 0 && new URL(logo.src).origin === location.origin; })()`), `${label} uses its packaged fallback logo and keeps the reported name in its tooltip`);
    }
    assert.equal(await first.eval!(`document.querySelector('[data-agent-id="${codexId}"] h3')?.textContent`), 'Codex', 'recognized agents retain their original display names');
    assert.equal(await first.eval!(`document.querySelector('[data-browser-id="${firstState.graph.thisBrowserId}"] h3')?.textContent`), firstState.graph.browsers.find((browser: any) => browser.id === firstState.graph.thisBrowserId).name, 'recognized browsers retain their original display names');
    await first.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await waitFor(() => first.eval!(`window.innerWidth === 1200 && document.querySelector('#graph-canvas')?.dataset.layout === 'desktop'`), 'fallback graph screenshot uses the desktop layout');
    await first.eval!(`document.querySelector('#graph-reset').click(); new Promise(requestAnimationFrame)`);
    const { cssContentSize } = await first.cdp.send('Page.getLayoutMetrics', {}, sessionId);
    const screenshot = await first.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...cssContentSize, scale: 1 } }, sessionId);
    writeFileSync('/tmp/browspark-graph-fallbacks.png', Buffer.from(screenshot.data, 'base64'));
  } finally {
    for (const socket of fallbackSockets) socket.terminate();
    await otherTransport?.terminateSession().catch(() => {});
    await otherClient?.close().catch(() => {});
    await secondTransport?.terminateSession().catch(() => {});
    await secondClient?.close().catch(() => {});
    await client?.close().catch(() => {});
    for (const browser of browsers) await browser.cleanup();
    server.close();
  }
}, 120_000);
});
