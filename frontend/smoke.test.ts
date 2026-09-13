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
    for (const [path, mime, content] of [
      ['/', 'text/html'], ['/main.js', 'javascript'], ['/styles.css', 'text/css'],
      ['/assets/logo.png', 'image/png'], ['/assets/clients/codex.svg', 'image/svg+xml'],
      ['/robots.txt', 'text/plain', 'User-agent: *\nAllow: /\nSitemap: https://browspark.krishm.dev/sitemap.xml'],
      ['/sitemap.xml', 'xml', '<loc>https://browspark.krishm.dev/</loc>'],
    ]) {
      const get = await fetch(new URL(path, base));
      expect(get.status).toBe(200);
      expect(get.headers.get('content-type')).toContain(mime);
      const body = await get.arrayBuffer();
      const size = body.byteLength;
      expect(size).toBeGreaterThan(0);
      if (content) expect(new TextDecoder().decode(body).replace(/\n\s*\n/g, '\n')).toContain(content);
      const head = await fetch(new URL(path, base), { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toContain(mime);
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

test('built search metadata stays consistent', async () => {
  const values: Record<string, string[]> = { title: [], canonical: [], jsonld: [] };
  await new HTMLRewriter()
    .on('head title', {
      element() { values.title.push(''); },
      text(chunk) { values.title[values.title.length - 1] += chunk.text; },
    })
    .on('head meta', { element(element) {
      const key = element.getAttribute('name') ?? element.getAttribute('property');
      if (key) (values[key] ??= []).push(element.getAttribute('content') ?? '');
    } })
    .on('head link[rel="canonical"]', { element(element) { values.canonical.push(element.getAttribute('href') ?? ''); } })
    .on('head script[type="application/ld+json"]', {
      element() { values.jsonld.push(''); },
      text(chunk) { values.jsonld[values.jsonld.length - 1] += chunk.text; },
    })
    .transform(new Response(Bun.file(resolve(import.meta.dir, 'dist/index.html')))).text();

  for (const key of ['title', 'description', 'canonical', 'og:site_name', 'og:image', 'jsonld']) {
    expect(values[key]).toHaveLength(1);
    expect(values[key][0].trim()).not.toBe('');
  }
  for (const [key, source] of [
    ['og:title', 'title'], ['twitter:title', 'title'],
    ['og:description', 'description'], ['twitter:description', 'description'],
    ['og:url', 'canonical'], ['twitter:image', 'og:image'],
  ]) expect(values[key]).toEqual(values[source]);

  const canonical = new URL(values.canonical[0]);
  expect(canonical.protocol).toBe('https:');
  const data = JSON.parse(values.jsonld[0]);
  expect(data['@context']).toBe('https://schema.org');
  expect(data['@graph']).toEqual(expect.arrayContaining([
    expect.objectContaining({ '@type': 'WebSite', name: values['og:site_name'][0], url: canonical.href }),
    expect.objectContaining({
      '@type': 'SoftwareApplication', name: values['og:site_name'][0], url: canonical.href,
      description: values.description[0], image: values['og:image'][0],
    }),
  ]));
  const image = new URL(values['og:image'][0]);
  expect(image.origin).toBe(canonical.origin);
  expect(await Bun.file(resolve(import.meta.dir, 'dist', image.pathname.slice(1))).exists()).toBe(true);
});
