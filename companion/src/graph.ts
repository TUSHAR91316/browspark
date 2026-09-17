import type { Bridge, BridgeConnection } from './bridge.ts';
import type { Sessions } from './session.ts';
import { clients } from './context.ts';
import type { ConnectionGraph } from '../../shared/protocol.ts';

/** Publish only changed connection metadata, and only to profiles that enable the graph. */
export function installConnectionGraph(bridge: Bridge, sessions: Sessions) {
  const sent = new WeakMap<BridgeConnection, string>(), pending = new WeakSet<BridgeConnection>();
  const publish = () => {
    const connections = bridge.connections();
    for (const c of connections) if (!c.policy?.graph) sent.delete(c);
    if (!connections.some(c => c.policy?.graph)) return;
    const agents = [...clients.values()].filter(c => c.initialized).map(c => ({ id: c.id, name: c.name }));
    const browsers: ConnectionGraph['browsers'] = [
      ...connections.map(c => ({ id: c.id, name: c.browser ?? 'Browser profile', mode: 'extension' as const, sharedTabs: c.tabs.filter(t => t.shared).length })),
      ...sessions.runningDevs().map(d => ({ id: `dev:${d.name}`, name: d.version || d.browserName, mode: 'dev' as const, context: d.name, sharedTabs: d.listTabs().length })),
    ];
    for (const c of connections) {
      if (!c.policy?.graph || pending.has(c)) continue;
      const graph: ConnectionGraph = { thisBrowserId: c.id, agents, browsers };
      const serialized = JSON.stringify(graph);
      if (sent.get(c) === serialized) continue;
      pending.add(c);
      void bridge.request('graph.state', graph, 5000, c.id).then(() => sent.set(c, serialized), () => sent.delete(c)).finally(() => pending.delete(c));
    }
  };
  bridge.on('tools.policy', publish);
  // Agent names and developer tabs can change without an extension event.
  const timer = setInterval(publish, 1000);
  timer.unref();
  return () => { clearInterval(timer); bridge.off('tools.policy', publish); };
}
