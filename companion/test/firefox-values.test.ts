import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { DirectFirefox, decodeBiDiValue } from '../src/firefox.ts';
import { summarizeArg } from '../src/devtools/capture.ts';

test('Firefox by-value decoding preserves repeated references and rejects cycles without dropping data', async () => {
  const value = { type: 'array', value: [{ type: 'object', internalId: 'shared', value: [['x', { type: 'number', value: 1 }]] }, { type: 'object', internalId: 'shared' }] };
  const decoded = decodeBiDiValue(value);
  assert.deepEqual(decoded, [{ x: 1 }, { x: 1 }]); assert.equal(decoded[0], decoded[1]);
  assert.equal(JSON.stringify(decoded), '[{"x":1},{"x":1}]');
  const cycle = { type: 'object', internalId: 'cycle', value: [['self', { type: 'object', internalId: 'cycle' }]] };
  assert.throws(() => decodeBiDiValue(cycle), /cyclic object.*returnByValue:false/);
  assert.deepEqual(decodeBiDiValue(value), [{ x: 1 }, { x: 1 }], 'reference state belongs to one result');
  assert.equal(Object.getPrototypeOf(decodeBiDiValue({ type: 'object', value: [['__proto__', { type: 'object', value: [['polluted', { type: 'boolean', value: true }]] }]] })), Object.prototype);
  const browser = new DirectFirefox() as any, tab = browser.addContext({ context: 'context', url: 'https://app.test' });
  browser.bidi = async () => ({ type: 'success', realm: 'realm', result: cycle });
  await assert.rejects(browser.cdp(tab.id, 'Runtime.evaluate', { expression: 'cyclic', returnByValue: true }), /cyclic object/);
});

test('Firefox logged object snapshots retain bounded nested previews without inventing live handles', () => {
  const browser = new DirectFirefox() as any;
  browser.addContext({ context: 'context', url: 'https://app.test' });
  const emitted: any[] = []; browser.on('cdp.event', (event: any) => emitted.push(event));
  const object = { type: 'object', value: [['request', { type: 'object', value: [['token', { type: 'string', value: 'needle' }]] }], ['items', { type: 'array', value: [{ type: 'number', value: 7 }, { type: 'null' }] }]] };
  browser.onMessage({ method: 'log.entryAdded', params: { type: 'console', method: 'log', timestamp: 1, source: { context: 'context', realm: 'realm' }, args: [object] } });
  const arg = emitted[0].params.args[0], summary = summarizeArg(arg);
  assert.match(summary.description!, /request: \{token: needle\}/); assert.match(summary.description!, /items: \[7, null\]/);
  assert.equal(summary.objectId, undefined); assert.equal(browser.objects.size, 0);
  const many = browser.remoteObject(1, { type: 'array', value: Array.from({ length: 100 }, (_, n) => ({ type: 'number', value: n })) }, 'realm', false);
  assert.equal(many.preview.properties.length, 8); assert.equal(many.preview.overflow, true);
  const cyclic = browser.remoteObject(1, { type: 'object', internalId: 'self', value: [['self', { type: 'object', internalId: 'self' }]] }, 'realm', false);
  assert.equal(summarizeArg(cyclic).description, 'Object {self: object}');
});
