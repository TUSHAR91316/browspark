// devtools_lighthouse: run the official Lighthouse CLI against the developer-mode Chrome.
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ctx, tool, tabArg } from '../context.ts';
import { artifactDir, saveArtifact } from '../artifacts.ts';
import { mkdirSync } from 'node:fs';

const CLI = join(import.meta.dirname, '..', '..', '..', 'node_modules', 'lighthouse', 'cli', 'index.js');

function runCli(runtime: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(runtime, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve({ code: null, stderr: stderr + '\n(timed out)', stdout }); }, timeoutMs);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, stderr, stdout }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stderr: String(e), stdout }); });
  });
}

export function registerLighthouseTools(ctx: Ctx) {
  const { sessions, page } = ctx;

  tool(ctx, 'devtools_lighthouse', 'Run Lighthouse (official CLI) against the developer-mode browser and return category scores, key metrics, failing audits, plus HTML and JSON report artifacts. Developer mode only; Lighthouse opens its own tab in that browser.', {
    tabId: tabArg, url: z.string().optional().describe('Defaults to the current URL of the tab'), device: z.enum(['mobile', 'desktop']).optional(),
    categories: z.array(z.enum(['performance', 'accessibility', 'best-practices', 'seo', 'pwa'])).optional(), timeoutMs: z.number().int().max(600_000).optional(), extraArgs: z.array(z.string()).optional(),
  }, async (a) => {
    const id = await sessions.resolve(a.tabId);
    const dev = sessions.devOfTab(id) ?? sessions.runningDevs()[0];
    if (!dev) throw new Error('Lighthouse needs developer mode. Launch it with browser_session {action:"launch"}.');
    if (dev.browserType === 'firefox') throw new Error('Lighthouse is unsupported in Firefox. The official Lighthouse CLI requires a Chromium browser.');
    if (!existsSync(CLI)) throw new Error(`Lighthouse is not installed at ${CLI}. Run: bun add lighthouse`);
    const url = a.url ?? await page.evaluate<string>(id, 'location.href');
    mkdirSync(artifactDir(), { recursive: true });
    const base = join(artifactDir(), `${new Date().toISOString().replace(/[:.]/g, '-')}-lighthouse`);
    const args = [url, `--port=${dev.port}`, '--output=json', '--output=html', `--output-path=${base}`, '--quiet', '--disable-storage-reset', ...(a.device === 'desktop' ? ['--preset=desktop'] : []), ...(a.categories?.length ? [`--only-categories=${a.categories.join(',')}`] : []), ...(a.extraArgs ?? [])];
    const timeout = a.timeoutMs ?? 180_000;
    let r = await runCli('bun', args, timeout);
    if (r.code !== 0 && !existsSync(`${base}.report.json`)) { const n = await runCli('node', args, timeout); if (n.code === 0 || existsSync(`${base}.report.json`)) r = n; else throw new Error(`Lighthouse failed (bun: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}; node: ${n.stderr.trim().split('\n').slice(-3).join(' | ')})`); }
    const jsonPath = `${base}.report.json`, htmlPath = `${base}.report.html`;
    if (!existsSync(jsonPath)) throw new Error(`Lighthouse produced no report: ${r.stderr.trim().split('\n').slice(-5).join(' | ')}`);
    const lhr = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const audits = lhr.audits ?? {};
    const metric = (k: string) => audits[k]?.displayValue ?? audits[k]?.numericValue;
    const failing = Object.values(audits).filter((x: any) => x.score !== null && x.score < 0.9 && x.scoreDisplayMode !== 'informative' && x.scoreDisplayMode !== 'notApplicable' && x.scoreDisplayMode !== 'manual').sort((x: any, y: any) => (x.score ?? 0) - (y.score ?? 0)).slice(0, 25).map((x: any) => ({ id: x.id, title: x.title, score: x.score, displayValue: x.displayValue }));
    const summary = { url: lhr.finalDisplayedUrl ?? url, lighthouseVersion: lhr.lighthouseVersion, formFactor: lhr.configSettings?.formFactor, scores: Object.fromEntries(Object.entries(lhr.categories ?? {}).map(([k, v]: any) => [k, v.score !== null ? Math.round(v.score * 100) : null])), metrics: { FCP: metric('first-contentful-paint'), LCP: metric('largest-contentful-paint'), TBT: metric('total-blocking-time'), CLS: metric('cumulative-layout-shift'), SpeedIndex: metric('speed-index'), TTI: metric('interactive') }, failingAudits: failing, runWarnings: lhr.runWarnings, reports: { html: htmlPath, json: jsonPath } };
    saveArtifact('lighthouse-summary', 'json', JSON.stringify(summary, null, 1));
    return summary;
  });
}
