import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const preview = Bun.argv.includes('--preview');
const root = resolve(import.meta.dir, preview ? 'dist' : '.');
const port = Number(Bun.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535.');
if (!await Bun.file(resolve(root, 'index.html')).exists()) throw new Error(preview ? 'Run bun run build first.' : 'Missing index.html.');

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const reply = (message: string, status: number) => new Response(request.method === 'HEAD' ? null : message, { status });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return reply('Bad request', 400); }
    if (pathname === '/') pathname = '/index.html';
    if (!['/index.html', '/styles.css', '/main.js', '/setup.sh', '/robots.txt', '/sitemap.xml', ...(!preview ? ['/highlight.js'] : [])].includes(pathname) && !pathname.startsWith('/assets/')) {
      return reply('Not found', 404);
    }
    try {
      const path = await realpath(resolve(root, `.${pathname}`));
      const boundary = pathname.startsWith('/assets/') ? resolve(root, 'assets') : root;
      if (!path.startsWith(`${boundary}${sep}`) || !(await stat(path)).isFile()) return reply('Not found', 404);
      const file = Bun.file(path);
      return new Response(request.method === 'HEAD' ? null : file, {
        headers: {
          'Content-Type': file.type,
          'Content-Length': String(file.size),
          'Cache-Control': preview ? 'public, max-age=0, must-revalidate' : 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch { return reply('Not found', 404); }
  },
});
console.log(`Browspark ${preview ? 'preview' : 'development'}: ${server.url}`);
