import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { launchExtensionChrome, dashboard } from './harness.ts';

// Real extension boundary: verify background input, screenshot, focus guards and persisted fallback.
describe.skipIf(!process.env.E2E)('Background Mode', () => {
test('Background Mode preserves user focus and supports foreground opt-out', async () => {
  const ext = await launchExtensionChrome();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  try {
    await new Promise<void>(r => server.once('listening', r));
    const connected = new Promise<any>(r => server.once('connection', r));
    const msg = await dashboard(ext);
    assert.equal((await msg({ type: 'getState' })).backgroundMode, true);
    await msg({ type: 'setConfig', port: (server.address() as any).port });
    const socket = await connected;
    let id = 0;
    const request = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10000);
      const listener = (data: any) => { const m = JSON.parse(String(data)); if (m.id !== n) return; clearTimeout(timer); socket.off('message', listener); resolve(m); };
      socket.on('message', listener); socket.send(JSON.stringify({ id: n, method, params }));
    });
    const command = async (tabId: number, method: string, params: any = {}) => {
      const r = await request('cdp', { tabId, method, params }); assert.equal(r.error, undefined); return r.result;
    };
    const active = () => ext.eval!('chrome.tabs.query({active:true}).then(ts => ts.map(t => t.id).sort())');
    const focused = () => ext.eval!('chrome.windows.getLastFocused().then(w => w.id)');
    const before = await active(), windowBefore = await focused();
    const created = await request('tabs.create', { url: 'about:blank', active: true });
    const tabId = created.result.id;
    assert.deepEqual(await active(), before);
    await command(tabId, 'Runtime.evaluate', { expression: 'document.body.innerHTML = `<input id="input"><button style="position:absolute;left:10px;top:100px;width:100px;height:40px" onclick="this.textContent=\'clicked\'">click</button>`' });
    await command(tabId, 'Runtime.evaluate', { expression: 'document.querySelector("input").focus()' });
    await command(tabId, 'Input.insertText', { text: 'background text' });
    await command(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 120, button: 'left', clickCount: 1 });
    await command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 120, button: 'left', clickCount: 1 });
    const result = await command(tabId, 'Runtime.evaluate', { expression: '[document.querySelector("input").value, document.querySelector("button").textContent]', returnByValue: true });
    assert.deepEqual(result.result.value, ['background text', 'clicked']);
    assert.ok((await command(tabId, 'Page.captureScreenshot')).data.length > 100);
    for (const method of ['Page.bringToFront', 'Target.activateTarget', 'Target.createTarget', 'Browser.setWindowBounds']) assert.match((await request('cdp', { tabId, method })).error, /Work in background/);
    assert.match((await request('tabs.activate', { tabId })).error, /Work in background/);
    assert.match((await request('window.size', { tabId, width: 700, height: 600 })).error, /Work in background/);
    assert.deepEqual(await active(), before);
    assert.equal(await focused(), windowBefore);
    assert.match((await request('cdp', { tabId: before[0], method: 'Page.bringToFront' })).error, /not shared/);
    await msg({ type: 'setBackgroundMode', on: false });
    assert.equal(await ext.eval!('chrome.storage.local.get("backgroundMode").then(s => s.backgroundMode)'), false);
    assert.equal((await request('tabs.activate', { tabId })).error, undefined);
    assert.ok((await active()).includes(tabId));
    await msg({ type: 'setBackgroundMode', on: true });
    assert.equal((await msg({ type: 'getState' })).backgroundMode, true);
    assert.equal(await ext.eval!('chrome.storage.local.get("backgroundMode").then(s => s.backgroundMode)'), true);
  } finally {
    for (const socket of server.clients) socket.terminate();
    server.close(); await ext.cleanup();
  }
}, 60000);

});
