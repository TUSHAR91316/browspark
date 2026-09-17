import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const extension = resolve(root, 'extension');
const firefox = resolve(root, 'dist/firefox-extension');
const files = ['app.html', 'app.css', 'assets', 'dist'];
const result = await Bun.build({
  entrypoints: [resolve(extension, 'src/background.ts'), resolve(extension, 'src/app.ts')],
  outdir: resolve(extension, 'dist'),
  target: 'browser',
});
if (!result.success) throw new AggregateError(result.logs, 'Extension build failed.');

await rm(firefox, { recursive: true, force: true });
await mkdir(firefox, { recursive: true });
await cp(resolve(extension, 'manifest.firefox.json'), resolve(firefox, 'manifest.json'));
for (const file of files) await cp(resolve(extension, file), resolve(firefox, file), { recursive: true });
console.log('Built Chromium extension/ and Firefox dist/firefox-extension/.');

if (process.argv.includes('--package')) {
  for (const [cwd, name] of [[extension, 'browspark-extension.zip'], [firefox, 'browspark-firefox-extension.zip']] as const) {
    const archive = resolve(root, 'dist', name);
    await rm(archive, { force: true });
    const child = Bun.spawn(['zip', '-qr', archive, 'manifest.json', ...files], { cwd, stdout: 'inherit', stderr: 'inherit' });
    if (await child.exited !== 0) throw new Error(`Packaging ${name} failed.`);
    console.log(`Packaged dist/${name}`);
  }
}
