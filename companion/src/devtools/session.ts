// devtools_session, devtools_events, devtools_capabilities, devtools_cdp
import { z } from 'zod';
import { type Ctx, clients, tool, tabArg, matcher, paginate } from '../context.ts';

/** Read-only probes; commands without a query deliberately omit required arguments, so validation rejects them before mutation. */
const PROBES: [string, string, unknown?][] = [
  ['Runtime', 'Runtime.evaluate', { expression: '1' }], ['Log', 'Log.startViolationsReport'], ['Network', 'Network.getResponseBody'], ['Page', 'Page.getFrameTree'], ['DOM', 'DOM.getDocument', { depth: 0 }],
  ['CSS', 'CSS.getMediaQueries'], ['Debugger', 'Debugger.getScriptSource'], ['DOMDebugger', 'DOMDebugger.getEventListeners'], ['Input', 'Input.dispatchKeyEvent'],
  ['Emulation', 'Emulation.canEmulate'], ['Fetch', 'Fetch.getResponseBody'], ['Overlay', 'Overlay.getHighlightObjectForTest'], ['Accessibility', 'Accessibility.getRootAXNode'], ['Audits', 'Audits.getEncodedResponse'],
  ['Security', 'Security.setIgnoreCertificateErrors'], ['Profiler', 'Profiler.setSamplingInterval'], ['HeapProfiler', 'HeapProfiler.getHeapObjectId'], ['Tracing', 'Tracing.getCategories'], ['Performance', 'Performance.getMetrics'],
  ['Storage', 'Storage.getUsageAndQuota'], ['DOMStorage', 'DOMStorage.getDOMStorageItems'], ['IndexedDB', 'IndexedDB.requestDatabase'], ['CacheStorage', 'CacheStorage.requestEntries'],
  ['ServiceWorker', 'ServiceWorker.setForceUpdateOnPageLoad'], ['Animation', 'Animation.getPlaybackRate'], ['WebAudio', 'WebAudio.getRealtimeData'], ['WebAuthn', 'WebAuthn.getCredentials'], ['Target', 'Target.getTargets'], ['Browser', 'Browser.getVersion'],
];
const capCache = new Map<string, Record<string, string>>();

export function registerSessionTools(ctx: Ctx) {
  const { sessions, capture } = ctx;
  const tab = (id?: number) => sessions.resolve(id);
  const userName = (id: string) => clients.get(id)?.name ?? id;

  tool(ctx, 'devtools_session', 'Start or stop an inspection session on a tab. While active, console, network, exceptions, issues, scripts, and debugger events are collected across reloads. Stop removes every breakpoint, override, and emulation the session set. clear drops collected data.', {
    action: z.enum(['start', 'stop', 'status', 'clear']), tabId: tabArg,
    bodies: z.boolean().optional().describe('Capture response bodies (default false; bodies can also be fetched on demand)'),
    maxBodyBytes: z.number().int().optional().describe('Per-body cap, default 1000000'),
    what: z.enum(['all', 'console', 'network', 'events', 'issues']).optional().describe('For clear'),
  }, async ({ action, tabId, bodies, maxBodyBytes, what }) => {
    const id = await tab(tabId);
    if (action === 'start') { const st = await capture.start(id, { ...(bodies !== undefined && { bodies }), ...(maxBodyBytes && { maxBodyBytes }) }, ctx.client.id); return `Inspecting tab ${id} (${sessions.modeOf(id)} mode). bodies=${st.opts.bodies}. ${st.frames.size} frame(s), ${st.contexts.size} context(s).${st.users.size > 1 ? ` Shared with: ${[...st.users].filter((u) => u !== ctx.client.id).map(userName).join(', ')}.` : ''}`; }
    if (action === 'stop') { const notes = await capture.stop(id, ctx.client.id); return notes.some((n) => n.includes('session kept')) ? `Left the inspection session on tab ${id}; still in use by ${[...capture.require(id).users].map(userName).join(', ')}; session kept.` : `Stopped inspecting tab ${id}. Cleanup done.${notes.length ? ' Notes: ' + notes.join('; ') : ''}`; }
    if (action === 'clear') { capture.clear(id, what); return `Cleared ${what ?? 'all'} for tab ${id}`; }
    const st = capture.get(id);
    if (!st) return `Tab ${id}: not inspecting.`;
    return { tabId: id, active: st.active, users: [...st.users].map(userName), mode: sessions.modeOf(id), startedAt: new Date(st.startedAt).toISOString(), stoppedAt: st.stoppedAt && new Date(st.stoppedAt).toISOString(), options: st.opts, counts: { console: st.console.length, network: st.network.length, events: st.events.length, issues: st.issues.length, scripts: st.scripts.size, styleSheets: st.styleSheets.size, frames: st.frames.size, breakpoints: st.breakpoints.size, overrides: st.overrides.size, blocked: st.blocked.length }, dropped: st.dropped, paused: !!st.paused, recordings: st.recordings };
  });

  tool(ctx, 'devtools_events', 'Read or wait for events collected in the inspection session: console messages, exceptions, request start/finish/fail, breakpoint pauses, navigations, issues, service worker and animation events, recording completion. Use afterId to page forward; wait:true blocks until a matching event arrives.', {
    tabId: tabArg, method: z.string().optional().describe('Filter by event method substring or regex, e.g. "Debugger.paused", "loadingFailed", "console"'), regex: z.boolean().optional(),
    text: z.string().optional().describe('Filter by summary text'), afterId: z.number().int().optional().describe('Only events with id greater than this'),
    wait: z.boolean().optional(), timeoutMs: z.number().int().max(120_000).optional(), limit: z.number().int().max(500).optional(), includeParams: z.boolean().optional(),
  }, async ({ tabId, method, regex, text: t, afterId, wait, timeoutMs, limit, includeParams }) => {
    const id = await tab(tabId);
    const st = capture.require(id);
    const mm = matcher(method, regex), tm = matcher(t, regex);
    const pred = (e: { method: string; summary: string }) => mm(e.method) && tm(e.summary);
    if (wait) {
      const e = await capture.waitFor(id, pred, timeoutMs ?? 30_000, afterId ?? st.seq);
      if (!e) throw new Error(`No matching event within ${timeoutMs ?? 30_000}ms`);
      return { event: { ...e, ts: new Date(e.ts).toISOString(), params: includeParams ? e.params : undefined } };
    }
    const items = st.events.filter((e) => (afterId === undefined || e.id > afterId) && pred(e)).slice(-(limit ?? 50));
    return { collectionStart: new Date(st.startedAt).toISOString(), dropped: st.dropped.events, lastId: st.seq, events: items.map((e) => ({ id: e.id, ts: new Date(e.ts).toISOString(), method: e.method, summary: e.summary, ...(includeParams && { params: e.params }) })) };
  });

  tool(ctx, 'devtools_capabilities', 'Report the browser version, connection mode, and which CDP domains work for a tab (probed live, cached per browser). Extension mode blocks some domains that direct CDP allows.', {
    tabId: tabArg, refresh: z.boolean().optional(),
  }, async ({ tabId, refresh }) => {
    const id = await tab(tabId);
    const mode = sessions.modeOf(id);
    const key = mode === 'dev' ? `dev:${sessions.devOfTab(id)?.version}` : `ext:${sessions.bridge.extensionVersion}`;
    if (refresh) capCache.delete(key);
    let caps = capCache.get(key);
    if (!caps) {
      caps = { Media: 'unprobed: this domain only supports enable/disable' };
      for (const [domain, method, params] of PROBES) {
        try { await sessions.cdp(id, method, params, 5000); caps[domain] = 'supported'; }
        catch (e) {
          const m = (e as Error).message;
          // A validation error means the domain answered; only "not allowed"/"not found" means unsupported.
          caps[domain] = /not allowed|isn't allowed|wasn't found|method.*not found|Domain.*not|restricted/i.test(m) ? `unsupported: ${m.slice(0, 80)}` : 'supported';
        }
      }
      capCache.set(key, caps);
    }
    const version = mode === 'dev' ? sessions.devOfTab(id)?.version : (await sessions.cdp(id, 'Browser.getVersion').catch(() => undefined))?.product ?? (await ctx.page.evaluate(id, 'navigator.userAgent').catch(() => 'unknown'));
    const unsupported = Object.entries(caps).filter(([, v]) => v.startsWith('unsupported:')).map(([k]) => k);
    return {
      mode, browser: version, tools: [...(ctx.server as any)._registeredTools ? Object.keys((ctx.server as any)._registeredTools) : []],
      domains: caps, unsupportedOperations: [
        ...(mode === 'extension' ? ['browser_session launch (use developer mode)', 'devtools_cdp raw commands (developer mode only)', 'devtools_lighthouse (developer mode only)', 'browser-wide storage clearing (developer mode only)'] : []),
        ...unsupported.map((d) => `${d}.* commands`),
      ],
    };
  });

  tool(ctx, 'devtools_cdp', 'Developer mode only: run any Chrome DevTools Protocol command on a tab (or on the browser target with target:"browser"). Params must be a JSON object valid for the method.', {
    tabId: tabArg, target: z.enum(['tab', 'browser']).default('tab'), method: z.string().regex(/^[A-Z][A-Za-z]+\.[a-zA-Z]+$/, 'method must look like Domain.command'),
    params: z.record(z.string(), z.unknown()).optional(), timeoutMs: z.number().int().max(300_000).optional(), context: z.string().optional().describe('Developer browser context for target:browser (default: the only running one)'),
  }, async ({ tabId, target, method, params, timeoutMs, context }) => {
    const running = sessions.runningDevs();
    if (!running.length) throw new Error('devtools_cdp requires developer mode. Launch it with browser_session {action:"launch"}.');
    if (target === 'browser') { const d = context ? sessions.devs.get(context) : running.length === 1 ? running[0] : sessions.devs.get('default'); if (!d?.running) throw new Error(`Context ${context ?? 'default'} is not running; running: ${running.map((x) => x.name).join(', ')}`); return await d.browser(method, params, timeoutMs); }
    const id = await tab(tabId);
    const d = sessions.devOfTab(id);
    if (!d) throw new Error(`Tab ${id} is an extension-mode tab. devtools_cdp only runs against developer-mode tabs.`);
    return await d.cdp(id, method, params, timeoutMs);
  });

  void paginate;
}
