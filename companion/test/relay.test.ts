import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const companion = async (name: string, port: number) => {
  const client = new Client({ name, version: '0' });
  const scriptPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [scriptPath, '--port', String(port)], stderr: 'pipe' });
  await client.connect(transport);
  return Object.assign(client, { pid: transport.pid! });
};
const status = async (client: Client) => {
  const result = await client.callTool({ name: 'browser_status', arguments: {} });
  assert.ok(!result.isError, 'browser_status failed');
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
};

/** Owner + relay on a fresh port; `stop` removes the owner; the relay must keep working on the same port and become the owner for later clients. */
const handover = async (stop: (owner: Client & { pid: number }) => Promise<void>) => {
  const clients: Client[] = [];
  const owner = await companion('owner', 0);
  try {
    const port = Number(/port:\s+(\d+)/.exec(await status(owner))?.[1]);
    const relay = await companion('relay', port); clients.push(relay);
    assert.match(await status(relay), /other agents connected: owner/);
    await stop(owner);
    const after = await status(relay);
    assert.match(after, new RegExp(`port:\\s+${port}`));
    assert.doesNotMatch(after, /owner/);
    const late = await companion('late', port); clients.push(late);
    assert.match(await status(late), /other agents connected: relay/);
  } finally { for (const c of clients) await c.close().catch(() => {}); await owner.close().catch(() => {}); }
};

test('a relay takes the port over when the owner\'s client shuts down', () => handover((owner) => owner.close()), 20000);
test('a relay takes the port over when the owner is killed', () => handover(async (owner) => { process.kill(owner.pid, 'SIGKILL'); }), 20000);

test('a port held by something that is not a companion yields a tool error, not a dead process', async () => {
  const blocker = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = (blocker.address() as { port: number }).port;
  const client = await companion('blocked', port);
  try {
    await assert.rejects(client.listTools(), /did not answer/);
    await assert.rejects(client.listTools(), /did not answer/); // still alive: same answer, not "Connection closed"
  } finally { await client.close().catch(() => {}); blocker.close(); }
}, 20000);
