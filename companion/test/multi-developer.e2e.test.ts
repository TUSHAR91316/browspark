// MULTI_BROWSER_E2E=1 bun test companion/test/multi-developer.e2e.test.ts
// Optional executable overrides: BROWSPARK_CHROME, BROWSPARK_BRAVE, BROWSPARK_FIREFOX, BROWSPARK_ZEN.
import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestServer } from '../../test-apps/server.ts';
import { callers, companionTab, ROOT } from './harness.ts';

describe.skipIf(process.env.MULTI_BROWSER_E2E !== '1')('multiple developer browsers', () => {
  test('Chrome, Brave, Firefox and Zen preserve context routing and independent state', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'browspark-multi-developer-'));
    let client: Client | undefined, server: Server | undefined, c: ReturnType<typeof callers> | undefined;
    const browsers = ['chrome', 'brave', 'firefox', 'zen'] as const;
    const contexts = browsers.map((browser) => ({ browser, name: `multi-${browser}`, firefox: browser === 'firefox' || browser === 'zen', tabId: 0 }));
    try {
      const fixture = join(temp, 'fixture'); mkdirSync(fixture);
      writeFileSync(join(fixture, 'basic.html'), `<!doctype html><title>Multi browser fixture</title><h1>Multi browser fixture</h1>
        <button onclick="document.querySelector('output').textContent = confirm('Keep this dialog?') ? 'confirmed' : 'cancelled'">Confirm</button><output>ready</output>`);
      writeFileSync(join(fixture, 'page2.html'), '<!doctype html><title>Context page</title><h1>Context page</h1><p>Read through the selected browser.</p>');
      const app = await startTestServer(fixture); server = app.server;
      client = new Client({ name: 'multi-developer-e2e', version: '0' });
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [join(ROOT, 'companion/src/index.ts'), '--port', '0'], stderr: 'inherit',
        env: { ...process.env, BROWSPARK_PROFILE: join(temp, 'default-profile'), BROWSPARK_PROFILES: join(temp, 'profiles'), BROWSPARK_ARTIFACTS: join(temp, 'artifacts') },
      }));
      c = callers(client); const { call, ok, okJson } = c;
      const launches = await Promise.allSettled(contexts.map(({ browser, name }) => ok('browser_session', {
        action: 'launch', browser, context: name, userRequested: true, headless: true,
        url: `${app.url}basic.html?browser=${browser}`, downloadDir: join(temp, 'downloads', browser),
      })));
      for (let i = 0; i < launches.length; i++) {
        const launch = launches[i];
        assert.equal(launch.status, 'fulfilled', `${contexts[i].browser} launch: ${launch.status === 'rejected' ? launch.reason : ''}`);
      }
      const saved = await okJson('browser_session', { action: 'contexts' });
      const status = await ok('browser_session', { action: 'status' });
      const profileDirs = new Set<string>();
      for (const context of contexts) {
        const { name, browser, firefox } = context;
        const stored = saved.find((entry: any) => entry.name === name && entry.browser === browser);
        assert.ok(stored?.running, `${browser} context is running`);
        assert.ok(stored.profileDir.startsWith(join(temp, 'profiles')), stored.profileDir);
        profileDirs.add(stored.profileDir);
        const statusLine = status.split('\n').find((line) => line.startsWith(`[${name}]`));
        assert.ok(statusLine?.includes(`${browser}:`) && statusLine.includes(firefox ? 'BiDi ws://' : 'CDP ws://'), statusLine);
        const listed = await companionTab(ok, `${app.url}basic.html?browser=${browser}`);
        context.tabId = listed.id;
        assert.ok(listed.line.includes(`dev${firefox ? ':firefox' : ''}:${name}`), listed.line);
        assert.ok(listed.line.includes(`(${browser})`), listed.line);
        assert.match(await ok('browser_snapshot', { tabId: listed.id }), /heading "Multi browser fixture"/);
        assert.equal((await okJson('devtools_evaluate', { tabId: listed.id, expression: `window.browserMarker = '${browser}'` })).value, browser);
        await ok('devtools_session', { action: 'start', tabId: listed.id });
        await ok('devtools_evaluate', { tabId: listed.id, expression: `console.log('context-${browser}'); browserMarker` });
        if (firefox) {
          const raw = await call('devtools_cdp', { tabId: listed.id, method: 'Runtime.evaluate', params: { expression: '1' } });
          assert.ok(raw.err && /Raw CDP is unsupported.*Firefox/.test(raw.txt), raw.txt);
        } else {
          const raw = await okJson('devtools_cdp', { target: 'browser', context: name, method: 'Browser.getVersion' });
          assert.match(raw.product, /Chrome|Chromium/);
        }
      }
      assert.equal(profileDirs.size, 4, 'all four browsers have independent profiles');
      assert.equal(new Set(contexts.map((context) => context.tabId)).size, 4, 'all four browsers have unique companion tab ids');
      for (const { browser, tabId } of contexts) {
        const logs = await okJson('devtools_console', { tabId, query: 'context-' });
        assert.deepEqual(logs.items.map((entry: any) => entry.text), [`context-${browser}`], `${browser} console stays isolated`);
      }

      for (const [tool, args] of [['browser_tabs', { action: 'new', url: 'about:blank' }], ['browser_fetch', { url: app.url + 'page2.html' }]] as const) {
        const ambiguous = await call(tool, args);
        assert.ok(ambiguous.err && /context is required/.test(ambiguous.txt), ambiguous.txt);
      }
      for (const { name, browser } of contexts) {
        const pageUrl = `${app.url}page2.html?context=${browser}`;
        const opened = await ok('browser_tabs', { action: 'new', context: name, url: pageUrl });
        const tabId = Number(/Opened tab (\d+)/.exec(opened)![1]);
        assert.ok((await companionTab(ok, pageUrl)).line.includes(`:${name}`));
        assert.match(await ok('browser_snapshot', { tabId }), /heading "Context page"/);
        await ok('browser_tabs', { action: 'close', tabId });
        const before = await ok('browser_tabs', { context: name });
        const fetched = await okJson('browser_fetch', { context: name, url: pageUrl });
        assert.equal(fetched.url, pageUrl); assert.equal(fetched.title, 'Context page');
        assert.match(fetched.content, /^# Context page/m);
        assert.equal(await ok('browser_tabs', { context: name }), before, 'fetch closes its temporary tab in the chosen context');
      }

      const zen = contexts.find((context) => context.browser === 'zen')!;
      const snapshot = await ok('browser_snapshot', { tabId: zen.tabId });
      const confirm = /button "Confirm"[^\n]*\[ref=(e\d+)\]/.exec(snapshot)![1];
      assert.match(await ok('browser_click', { tabId: zen.tabId, ref: confirm }), /confirm dialog opened/);
      assert.match(await ok('browser_session', { action: 'close', context: 'multi-chrome' }), /Closed multi-chrome/);
      const afterClose = await ok('browser_status');
      assert.match(afterClose, /DIALOG OPEN: confirm "Keep this dialog\?"/);
      assert.doesNotMatch(afterClose, /Developer mode \[multi-chrome\]/);
      await ok('browser_dialog', { tabId: zen.tabId, accept: true });
      assert.match(await ok('browser_read', { tabId: zen.tabId }), /confirmed/);
      for (const { browser, tabId } of contexts.filter((context) => context.browser !== 'chrome')) {
        assert.equal((await okJson('devtools_session', { action: 'status', tabId })).active, true, `${browser} capture survives Chrome closing`);
        assert.equal((await okJson('devtools_evaluate', { tabId, expression: 'browserMarker' })).value, browser);
        assert.match(await ok('browser_snapshot', { tabId }), /Multi browser fixture/);
      }
      await ok('browser_session', { action: 'close', all: true });
      assert.equal(await ok('browser_session', { action: 'status' }), 'no developer browser running');
      assert.ok((await okJson('browser_session', { action: 'contexts' })).every((context: any) => !context.running));
      assert.equal((await call('browser_snapshot', { tabId: zen.tabId })).err, true);
    } finally {
      if (c) await c.call('browser_session', { action: 'close', all: true }).catch(() => {});
      await client?.close().catch(() => {});
      if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
      rmSync(temp, { recursive: true, force: true });
    }
  }, 240_000);
});
