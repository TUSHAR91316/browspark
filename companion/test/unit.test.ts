// Fast checks for the non-trivial pure logic: source-map decoding, glob matching, snapshot diff, artifacts.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSourceMap, toOriginal, toGenerated, decodeDataUrl, resolveMapUrl } from '../src/devtools/sourcemap.ts';
import { globToRegex } from '../src/devtools/network.ts';
import { lineDiff } from '../src/page.ts';
import { ROOT } from './harness.ts';
import { saveArtifact, readArtifact, listArtifacts } from '../src/artifacts.ts';

test('source map: generated <-> original round trip on the test app', () => {
  if (!existsSync(join(ROOT, 'test-apps/dist/app.js.map'))) spawnSync('bun', ['build', 'test-apps/src/app.ts', '--outdir', 'test-apps/dist', '--sourcemap=linked', '--format=iife'], { cwd: ROOT });
  const map = parseSourceMap(readFileSync(join(ROOT, 'test-apps/dist/app.js.map'), 'utf8'));
  assert.ok(map.sources.some((s) => s.endsWith('src/app.ts')));
  const src = readFileSync(join(ROOT, 'test-apps/src/app.ts'), 'utf8').split('\n');
  const origLine0 = src.findIndex((l) => l.includes("throw new Error('Boom: '"));
  const gen = toGenerated(map, 'src/app.ts', origLine0);
  assert.ok(gen, 'original line maps to generated code');
  const built = readFileSync(join(ROOT, 'test-apps/dist/app.js'), 'utf8').split('\n');
  assert.match(built[gen!.line], /Boom/);
  const back = toOriginal(map, gen!.line, gen!.column);
  assert.equal(back?.line, origLine0);
  assert.equal(decodeDataUrl('data:application/json;base64,' + Buffer.from('{"a":1}').toString('base64')), '{"a":1}');
  assert.equal(resolveMapUrl('https://x.test/js/app.js', 'app.js.map'), 'https://x.test/js/app.js.map');
});

test('glob matching for mocks and blocks', () => {
  assert.ok(globToRegex('*/api/missing*').test('http://h/api/missing?x=1'));
  assert.ok(!globToRegex('*/api/missing').test('http://h/api/missing?x=1'));
  assert.ok(globToRegex('https://cdn.example.com/*.js').test('https://cdn.example.com/a/b.js'));
});

test('snapshot line diff', () => {
  const d = lineDiff('- a\n- b\n- c', '- a\n- c\n- d');
  assert.equal(d, '- - b\n+ - d');
  assert.equal(lineDiff('x', 'x'), '(no changes)');
});

test('artifacts round trip', async () => {
  process.env.BROWSPARK_ARTIFACTS = join(ROOT, 'test-apps/dist/.artifacts-test');
  const a = saveArtifact('trace', 'json', '{"ok":1}', 'unit');
  assert.ok(existsSync(a.path) && a.bytes === 8);
  assert.equal(readArtifact(a.id), '{"ok":1}');
  assert.ok(listArtifacts().some((x) => x.id === a.id));
  rmSync(process.env.BROWSPARK_ARTIFACTS, { recursive: true, force: true });
});
