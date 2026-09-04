import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('built static site serves its assets and rejects private paths', async () => {
  const child = Bun.spawn([process.execPath, 'serve.ts', '--preview'], {
    cwd: import.meta.dir,
    env: { ...process.env, PORT: '0' },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  try {
    const reader = child.stdout.getReader();
    let output = '';
    while (!output.includes('http://')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Preview server exited before listening.');
      output += new TextDecoder().decode(chunk.value);
    }
    const base = output.match(/http:\/\/[^\s]+/)![0];
    for (const [path, mime] of [
      ['/', 'text/html'], ['/main.js', 'javascript'], ['/styles.css', 'text/css'],
      ['/assets/logo.png', 'image/png'], ['/assets/clients/codex.svg', 'image/svg+xml'],
    ]) {
      const get = await fetch(new URL(path, base));
      expect(get.status).toBe(200);
      expect(get.headers.get('content-type')).toContain(mime);
      const size = (await get.arrayBuffer()).byteLength;
      expect(size).toBeGreaterThan(0);
      const head = await fetch(new URL(path, base), { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(Number(head.headers.get('content-length'))).toBe(size);
      expect(await head.text()).toBe('');
    }
    for (const path of ['/missing.html', '/serve.ts', '/assets/%2e%2e%2fserve.ts', '/assets/%2e%2e%2f%2e%2e%2fpackage.json']) {
      expect((await fetch(new URL(path, base))).status).toBe(404);
    }
    const post = await fetch(base, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');

    const html = await Bun.file(resolve(import.meta.dir, 'dist/index.html')).text();
    const localReferences = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
      .map(match => match[1]).filter(path => !/^(?:https?:|mailto:)/.test(path));
    expect(localReferences.length).toBeGreaterThan(0);
    for (const path of localReferences) {
      expect(await Bun.file(resolve(import.meta.dir, 'dist', path.replace(/^\//, '').split(/[?#]/)[0])).exists()).toBe(true);
    }
  } finally {
    child.kill();
    await child.exited;
  }
}, 10_000);
