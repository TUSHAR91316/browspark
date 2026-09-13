import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = import.meta.dir;
const outdir = resolve(root, 'dist');
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(root, 'main.js'), resolve(root, 'styles.css')],
  outdir,
  target: 'browser',
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, 'Frontend build failed.');
for (const file of ['index.html', 'robots.txt', 'sitemap.xml']) {
  await cp(resolve(root, file), resolve(outdir, file));
}
await cp(resolve(root, '..', 'setup.sh'), resolve(outdir, 'setup.sh'));
await cp(resolve(root, 'assets'), resolve(outdir, 'assets'), { recursive: true });
console.log('Built static site in frontend/dist.');
