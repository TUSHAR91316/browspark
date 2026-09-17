import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Bridge, BridgeConnection } from '../src/bridge.ts';
import type { Sessions } from '../src/session.ts';
import { clients } from '../src/context.ts';
import { installConnectionGraph } from '../src/graph.ts';
import { isConnectionGraph, type ConnectionGraph } from '../../shared/protocol.ts';

test('graph subscriptions publish current metadata without page data or duplicate updates', async () => {
  const connections: BridgeConnection[] = [
    { id: 'chrome', browser: 'Chrome', browserEngine: 'chromium', policy: { disabled: [], graph: true }, tabs: [{ id: 1, url: 'https://private.example', title: 'Private title', windowId: 1, shared: true, attached: false }] },
    { id: 'brave', browser: 'Brave', policy: { disabled: [] }, tabs: [] },
  ];
  const received: { id: string; graph: ConnectionGraph }[] = [];
  const bridge = Object.assign(new EventEmitter(), {
    connections: () => connections,
    request: async (method: string, graph: ConnectionGraph, _timeout: number, id: string) => { assert.equal(method, 'graph.state'); received.push({ id, graph }); return { received: true }; },
  }) as unknown as Bridge;
  const sessions = { runningDevs: () => [{ name: 'dev-firefox', browserName: 'firefox', browserType: 'firefox', version: 'Firefox 153', listTabs: () => [{ url: 'https://secret.example' }] }] } as unknown as Sessions;
  clients.set('graph-test-a', { id: 'graph-test-a', name: 'Same agent', initialized: true, ownedTabs: new Set([1]) });
  clients.set('graph-test-b', { id: 'graph-test-b', name: 'Same agent', initialized: true, ownedTabs: new Set() });
  clients.set('graph-test-pending', { id: 'graph-test-pending', name: 'Not initialized', ownedTabs: new Set() });
  const stop = installConnectionGraph(bridge, sessions);
  const publish = async () => { bridge.emit('tools.policy'); await new Promise(resolve => setImmediate(resolve)); };
  try {
    await publish();
    assert.equal(received.length, 1);
    const first = received[0].graph;
    assert.ok(isConnectionGraph(first));
    assert.equal(first.thisBrowserId, 'chrome');
    assert.deepEqual(first.agents.filter(a => a.id.startsWith('graph-test-')).map(a => a.id), ['graph-test-a', 'graph-test-b']);
    assert.deepEqual(first.browsers.map(b => [b.name, b.mode, b.sharedTabs]), [['Chrome', 'extension', 1], ['Brave', 'extension', 0], ['Firefox 153', 'dev', 1]]);
    assert.deepEqual(first.browsers.map(b => b.browserEngine), ['chromium', undefined, 'firefox']);
    assert.ok(isConnectionGraph({ ...first, browsers: first.browsers.map(({ browserEngine, ...browser }) => browser) }), 'older graphs without engine metadata remain valid');
    assert.equal(isConnectionGraph({ ...first, browsers: [{ ...first.browsers[0], browserEngine: 'webkit' }] }), false);
    assert.ok(!/private|secret|title|url|ownedTabs/i.test(JSON.stringify(first)));
    assert.equal(isConnectionGraph({ ...first, browsers: [{ ...first.browsers[0], sharedTabs: -1 }] }), false);
    assert.equal(isConnectionGraph({ ...first, agents: [first.agents[0], first.agents[0]] }), false);
    await publish(); assert.equal(received.length, 1, 'unchanged topology is not resent');

    connections[1].policy!.graph = true;
    await publish(); assert.equal(received.at(-1)!.id, 'brave');
    connections[0].policy!.graph = false;
    clients.delete('graph-test-b');
    await publish(); assert.equal(received.at(-1)!.id, 'brave', 'disabling one profile leaves another subscribed');
    assert.ok(!received.at(-1)!.graph.agents.some(a => a.id === 'graph-test-b'));
    const beforeEnable = received.length;
    connections[0].policy!.graph = true;
    await publish(); assert.equal(received.length, beforeEnable + 1, 're-enabling delivers a fresh graph');
    connections[0] = { ...connections[0] };
    await publish(); assert.equal(received.length, beforeEnable + 2, 'same-session reconnect receives its graph again');
    connections.splice(1, 1);
    await publish(); assert.ok(!received.at(-1)!.graph.browsers.some(b => b.id === 'brave'));
  } finally {
    stop();
    for (const id of ['graph-test-a', 'graph-test-b', 'graph-test-pending']) clients.delete(id);
  }
});

test('re-enabling the graph retries a delivery acknowledged after disabling', async () => {
  for (const received of [false, true]) {
    const connection: BridgeConnection = { id: 'chrome', browser: 'Chrome', policy: { disabled: [], graph: true }, tabs: [] };
    const acknowledgements: ((result: { received: boolean }) => void)[] = [];
    const bridge = Object.assign(new EventEmitter(), {
      connections: () => [connection],
      request: () => new Promise(resolve => acknowledgements.push(resolve)),
    }) as unknown as Bridge;
    const stop = installConnectionGraph(bridge, { runningDevs: () => [] } as unknown as Sessions);
    const publish = async () => { bridge.emit('tools.policy'); await new Promise(resolve => setImmediate(resolve)); };
    try {
      await publish();
      assert.equal(acknowledgements.length, 1);
      connection.policy!.graph = false;
      await publish();
      connection.policy!.graph = true;
      await publish();
      assert.equal(acknowledgements.length, 1, 'only one delivery can be in flight');
      acknowledgements[0]({ received });
      await new Promise(resolve => setImmediate(resolve));
      await publish();
      assert.equal(acknowledgements.length, 2, `a late received:${received} acknowledgement must not suppress a fresh graph`);
      acknowledgements[1]({ received: true });
      await new Promise(resolve => setImmediate(resolve));
      await publish();
      assert.equal(acknowledgements.length, 2, 'successful delivery still suppresses unchanged updates');
    } finally {
      for (const acknowledge of acknowledgements) acknowledge({ received: true });
      stop();
    }
  }
});
