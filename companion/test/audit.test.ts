import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { registerAuditTools } from '../src/devtools/audit.ts';

test('devtools_audit registers and audits page with simulated issues and captures', async () => {
  let registeredHandler: ((args: any) => Promise<any>) | undefined;

  const mockTabId = 101;
  const mockCapture = {
    get: (id: number) => {
      if (id !== mockTabId) return undefined;
      return {
        console: [
          { kind: 'exception', level: 'error', text: 'Uncaught TypeError: Cannot read properties of undefined', args: [] },
          { kind: 'console', level: 'info', text: 'App initialized', args: [] },
        ],
        network: [
          { url: 'https://example.com/api/broken', status: 500 },
          { url: 'https://example.com/api/ok', status: 200 },
          { url: 'https://tracker.test/pixel.gif', blockedReason: 'inspector' },
        ],
      };
    },
  };

  const mockPage = {
    evaluate: async (id: number, script: string) => {
      if (script === 'location.href') return 'https://example.com/checkout';
      if (script === 'document.title') return 'Checkout';
      // In-page scanner evaluation mock
      return {
        layout: [
          { rule: 'horizontal-overflow', ref: 'e1', detail: 'Element overflows viewport: right edge is 1450px', severity: 'error' },
          { rule: 'small-touch-target', ref: 'e2', detail: 'Interactive target is 16x16px', severity: 'warning' },
        ],
        accessibility: [
          { rule: 'button-name', ref: 'e3', detail: '<button> element has no accessible name', severity: 'error' },
          { rule: 'image-alt', ref: 'e4', detail: 'Missing alt attribute on <img src="/logo.png">', severity: 'warning' },
          { rule: 'duplicate-id', detail: 'Duplicate ID #user-id found 2 times in DOM', severity: 'error' },
        ],
        seo: [
          { rule: 'missing-viewport-meta', detail: '<meta name="viewport"> is missing or has no content', severity: 'error' },
        ],
        performance: {
          fcp: 420,
          ttfb: 65,
          domNodes: 450,
          domDepth: 12,
          issues: [],
        },
        security: [],
        brokenAssets: [
          { type: 'image', url: 'https://example.com/missing.png', ref: 'e5', detail: 'Image failed to load: https://example.com/missing.png' },
        ],
      };
    },
  };

  const mockSessions = {
    resolve: async (id?: number) => id ?? mockTabId,
  };

  const ctx: any = {
    sessions: mockSessions,
    capture: mockCapture,
    page: mockPage,
    registry: new Map(),
  };

  // Helper tool wrapper mimicking context.ts
  const mockTool = (c: any, name: string, desc: string, schema: any, handler: any) => {
    if (name === 'devtools_audit') {
      registeredHandler = handler;
    }
  };

  // Mock global tool function behavior
  const auditModule = await import('../src/devtools/audit.ts');
  const fakeCtx = {
    ...ctx,
    server: {
      registerTool: () => {},
    },
  };

  registerAuditTools(fakeCtx);
  // Get registered tool handler from registry or registeredHandler
  const handler = fakeCtx.registry.get('devtools_audit') ?? fakeCtx.server;

  // Let's call registered handler via fakeCtx.registry
  assert.ok(fakeCtx.registry.has('devtools_audit'), 'devtools_audit should be registered in ctx.registry');
  const auditFn = fakeCtx.registry.get('devtools_audit');

  // Helper to extract JSON from tool Result
  const parseResult = async (args: any) => {
    const res = await auditFn(args);
    assert.ok(res && res.content && res.content[0], 'Tool should return MCP Result');
    return JSON.parse(res.content[0].text);
  };

  // 1. Full audit
  const fullReport = await parseResult({ tabId: mockTabId, saveReport: false });
  assert.equal(fullReport.url, 'https://example.com/checkout');
  assert.equal(fullReport.title, 'Checkout');
  assert.equal(fullReport.status, 'fail'); // Due to error severity items
  assert.ok(fullReport.score < 90, `Score should be docked for errors, got ${fullReport.score}`);
  assert.ok(fullReport.findings.length > 5, 'Should collect multiple findings across categories');
  assert.ok(fullReport.metrics.fcpMs === 420, 'FCP metric preserved');
  assert.ok(fullReport.metrics.captureSessionActive === true, 'Capture session active recognized');

  // Verify finding refs
  const buttonIssue = fullReport.findings.find((f: any) => f.rule === 'button-name');
  assert.ok(buttonIssue && buttonIssue.ref === 'e3', 'Ref preserved on finding');

  // 2. Filter by category
  const layoutOnly = await parseResult({ tabId: mockTabId, categories: ['layout'], saveReport: false });
  assert.ok(layoutOnly.findings.every((f: any) => f.category === 'layout'), 'Only layout category returned');

  // 3. Filter by threshold (errors only)
  const errorsOnly = await parseResult({ tabId: mockTabId, threshold: 'errors', saveReport: false });
  assert.ok(errorsOnly.findings.every((f: any) => f.severity === 'error'), 'Only error severity returned');

  // 4. Summary only
  const summary = await parseResult({ tabId: mockTabId, summaryOnly: true, saveReport: false });
  assert.equal(summary.findings, undefined, 'Findings omitted in summaryOnly mode');
  assert.ok(summary.categories.layout.errors > 0, 'Category counts preserved');
});
