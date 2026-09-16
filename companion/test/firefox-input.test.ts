import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { DirectFirefox } from '../src/firefox.ts';

test('Firefox rejects text that could trigger control keys before sending any input', async () => {
  const browser = new DirectFirefox('/tmp/browspark-firefox-input-test');
  (browser as any).tabs.set(1, { id: 1, targetId: 'test-context', url: 'about:blank', title: '', type: 'page' });
  const commands: string[] = [];
  browser.bidi = async <T>(method: string): Promise<T> => { commands.push(method); return {} as T; };
  for (const text of ['first\nsecond', 'first\r\nsecond', 'first\rsecond', 'first\uE007second']) {
    await assert.rejects(browser.cdp(1, 'Input.insertText', { text }), /unsupported in Firefox/);
  }
  assert.deepEqual(commands, []);
});
