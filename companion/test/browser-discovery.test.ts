import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserEngine, findBrowser, type BrowserName } from '../src/browsers.ts';
import { DirectChrome } from '../src/cdp.ts';
import { DirectFirefox } from '../src/firefox.ts';

test('browser brands retain their engine and use their own executable override', () => {
  const root = mkdtempSync(join(tmpdir(), 'browspark-discovery-'));
  const names: BrowserName[] = ['chromium', 'chrome', 'brave', 'firefox', 'zen'];
  const envs = [...new Set(names.map(name => `BROWSPARK_${name === 'chromium' ? 'CHROME' : name.toUpperCase()}`))];
  const original = new Map(envs.map(name => [name, process.env[name]]));
  try {
    const explicit = join(root, 'explicit'); writeFileSync(explicit, '');
    for (const name of names) {
      const env = `BROWSPARK_${name === 'chromium' ? 'CHROME' : name.toUpperCase()}`;
      const path = join(root, name); writeFileSync(path, ''); process.env[env] = path;
      assert.equal(findBrowser(name), path);
      assert.equal(findBrowser(name, explicit), explicit);
      process.env[env] = join(root, 'missing');
      assert.throws(() => findBrowser(name), /not found/);
      assert.equal(findBrowser(name, explicit), explicit);
      const browser = name === 'firefox' || name === 'zen' ? new DirectFirefox(root, 'work', name) : new DirectChrome(root, 'work', name);
      assert.equal(browser.browserName, name); assert.equal(browser.browserType, browserEngine(name));
    }
  } finally {
    for (const [name, value] of original) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(root, { recursive: true, force: true });
  }
});

test('browser shutdown keeps the profile busy until the owned process exits', async () => {
  for (const browser of [new DirectChrome(), new DirectFirefox()]) {
    const proc = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null as string | null, kills: 0, kill() { this.kills++; return true; } });
    (browser as any).proc = proc;
    assert.equal(browser.running, false); assert.equal(browser.busy, true);
    const closing = browser.close();
    assert.equal(browser.close(), closing); assert.equal(browser.busy, true);
    await assert.rejects(browser.launch(), /already running/);
    proc.signalCode = 'SIGTERM'; proc.emit('exit');
    await closing;
    assert.equal(proc.kills, 1); assert.equal(browser.busy, false);
  }
});

describe.skipIf(process.platform === 'win32')('POSIX launchers', () => {
test('closing a launch in progress cancels startup and preserves launcher symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browspark-startup-'));
  const executable = join(root, 'dispatcher'), launcher = join(root, 'browser-launcher');
  writeFileSync(executable, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 });
  symlinkSync(executable, launcher);
  const browsers = [new DirectChrome(join(root, 'brave'), 'work', 'brave'), new DirectFirefox(join(root, 'zen'), 'work', 'zen')];
  try {
    for (const browser of browsers) {
      const launch = browser.launch({ browserPath: launcher, headless: true, downloadDir: join(root, 'downloads') });
      const cancelled = assert.rejects(launch, /launch cancelled|exited before/);
      assert.equal((browser as any).proc.spawnfile, launcher);
      assert.equal(browser.busy, true); assert.equal(browser.running, false);
      await assert.rejects(browser.launch({ browserPath: launcher }), /already running/);
      await browser.close(); await cancelled;
      assert.equal(browser.busy, false); assert.equal(browser.running, false); assert.equal(browser.pid, undefined);
    }
  } finally { await Promise.all(browsers.map(browser => browser.close())); rmSync(root, { recursive: true, force: true }); }
});
});
