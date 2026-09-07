// devtools_storage and devtools_workers: Application panel.
import { z } from 'zod';
import { type Ctx, tool, tabArg, clip } from '../context.ts';
import { summarizeArg } from './capture.ts';

export function registerApplicationTools(ctx: Ctx) {
  const { sessions, capture, page } = ctx;
  const tab = (id?: number) => sessions.resolve(id);
  const originOf = async (id: number, o?: string) => o ?? await page.evaluate<string>(id, 'location.origin');

  tool(ctx, 'devtools_storage', 'Application storage. area: cookies (list/set/delete), local or session storage (list/set/remove/clear), indexeddb (databases/stores/data/put/clearStore/deleteDatabase), cache (list/entries/delete), usage (quota and per-type usage), clear (explicitly named storage types for one origin). Origin defaults to the page origin.', {
    tabId: tabArg, area: z.enum(['cookies', 'local', 'session', 'indexeddb', 'cache', 'usage', 'clear']), action: z.string().optional().describe('See area description; default list'),
    origin: z.string().optional(), url: z.string().optional().describe('cookies: URL to list/set for'), name: z.string().optional(), value: z.string().optional(), key: z.string().optional(),
    cookie: z.object({ name: z.string(), value: z.string(), domain: z.string().optional(), path: z.string().optional(), secure: z.boolean().optional(), httpOnly: z.boolean().optional(), sameSite: z.enum(['Strict', 'Lax', 'None']).optional(), expires: z.number().optional() }).optional(),
    database: z.string().optional(), store: z.string().optional(), index: z.string().optional(), json: z.unknown().optional().describe('indexeddb put: value'), skip: z.number().int().optional(), pageSize: z.number().int().optional(),
    cacheName: z.string().optional(), pathFilter: z.string().optional(), request: z.string().optional().describe('cache delete: request URL'),
    types: z.array(z.enum(['cookies', 'local_storage', 'session_storage', 'indexeddb', 'cache_storage', 'service_workers', 'websql', 'shader_cache', 'all'])).optional().describe('clear: which storage types'),
  }, async (a) => {
    const id = await tab(a.tabId);
    const cdp = (m: string, p?: unknown) => sessions.cdp(id, m, p);
    const act = a.action ?? 'list';
    switch (a.area) {
      case 'cookies': {
        if (act === 'set') { if (!a.cookie) throw new Error('cookie required'); const url = a.url ?? await page.evaluate<string>(id, 'location.href'); const r = await cdp('Network.setCookie', { url, ...a.cookie }); return r.success ? `Set cookie ${a.cookie.name}` : 'Chrome rejected the cookie'; }
        if (act === 'delete') { if (!a.name) throw new Error('name required'); await cdp('Network.deleteCookies', { name: a.name, url: a.url ?? await page.evaluate<string>(id, 'location.href') }); return `Deleted cookie ${a.name}`; }
        const r = await cdp('Network.getCookies', { urls: a.url ? [a.url] : undefined });
        return r.cookies.map((c: any) => ({ name: c.name, value: clip(c.value, 200), domain: c.domain, path: c.path, expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session', size: c.size, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite }));
      }
      case 'local': case 'session': {
        const store = a.area === 'local' ? 'localStorage' : 'sessionStorage';
        if (act === 'set') { if (!a.key || a.value === undefined) throw new Error('key and value required'); await page.evaluate(id, `${store}.setItem(${JSON.stringify(a.key)}, ${JSON.stringify(a.value)})`); return `Set ${store}[${a.key}]`; }
        if (act === 'remove') { if (!a.key) throw new Error('key required'); await page.evaluate(id, `${store}.removeItem(${JSON.stringify(a.key)})`); return `Removed ${a.key}`; }
        if (act === 'clear') { await page.evaluate(id, `${store}.clear()`); return `Cleared ${store}`; }
        const items = await page.evaluate<Record<string, string>>(id, `Object.fromEntries(Object.keys(${store}).map(k => [k, String(${store}.getItem(k)).slice(0, 500)]))`);
        return { origin: await originOf(id, a.origin), items };
      }
      case 'indexeddb': {
        if (act === 'databases' || act === 'list') return { origin: await originOf(id, a.origin), databases: await page.evaluate<string[]>(id, 'indexedDB.databases().then(d => d.map(x => x.name))') };
        if (!a.database) throw new Error('database required');
        const open = `new Promise((res, rej) => { const q = indexedDB.open(${JSON.stringify(a.database)}); q.onerror = () => rej(q.error); q.onblocked = () => rej(new Error('blocked')); q.onsuccess = () => res(q.result); })`;
        if (act === 'stores') return await page.evaluate(id, `${open}.then(db => { const out = { name: db.name, version: db.version, stores: [] }; for (const n of db.objectStoreNames) { const tx = db.transaction(n); const s = tx.objectStore(n); out.stores.push({ name: n, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes: [...s.indexNames].map(i => { const x = s.index(i); return { name: i, keyPath: x.keyPath, unique: x.unique, multiEntry: x.multiEntry }; }) }); } db.close(); return out; })`);
        if (act === 'deleteDatabase') { await page.evaluate(id, `new Promise((res, rej) => { const q = indexedDB.deleteDatabase(${JSON.stringify(a.database)}); q.onsuccess = () => res(1); q.onerror = () => rej(q.error); q.onblocked = () => rej(new Error('blocked: close other tabs using it')); })`); return `Deleted database ${a.database}`; }
        if (!a.store) throw new Error('store required');
        const tx = (mode: string, body: string) => `${open}.then(db => new Promise((res, rej) => { const tx = db.transaction(${JSON.stringify(a.store)}, '${mode}'); const st = tx.objectStore(${JSON.stringify(a.store)}); ${body} tx.onerror = () => rej(tx.error); tx.oncomplete = () => db.close(); }))`;
        if (act === 'clearStore') { await page.evaluate(id, tx('readwrite', 'st.clear(); tx.oncomplete = () => { db.close(); res(1); };')); return `Cleared ${a.database}/${a.store}`; }
        if (act === 'put') { if (a.json === undefined) throw new Error('json required'); await page.evaluate(id, tx('readwrite', `const r = st.put(${JSON.stringify(a.json)}${a.key !== undefined ? ', ' + JSON.stringify(a.key) : ''}); r.onsuccess = () => res(String(r.result)); r.onerror = () => rej(r.error);`)); return `Put into ${a.database}/${a.store}`; }
        if (act === 'delete') { if (a.key === undefined) throw new Error('key required'); await page.evaluate(id, tx('readwrite', `const r = st.delete(${JSON.stringify(a.key)}); r.onsuccess = () => res(1); r.onerror = () => rej(r.error);`)); return `Deleted key ${a.key}`; }
        const skip = a.skip ?? 0, size = a.pageSize ?? 50;
        const entries = await page.evaluate<any[]>(id, tx('readonly', `const src = ${a.index ? `st.index(${JSON.stringify(a.index)})` : 'st'}; const out = []; let i = 0; const c = src.openCursor(); c.onerror = () => rej(c.error); c.onsuccess = () => { const cur = c.result; if (!cur || out.length >= ${size}) { res(out); return; } if (i++ >= ${skip}) out.push({ key: JSON.stringify(cur.key), primaryKey: JSON.stringify(cur.primaryKey), value: JSON.stringify(cur.value).slice(0, 500) }); cur.continue(); };`));
        return { database: a.database, store: a.store, skip, entries, hasMore: entries.length >= size };
      }
      case 'cache': {
        if (act === 'list') return await page.evaluate<string[]>(id, 'caches.keys()').then((ks) => ks.map((cacheName) => ({ cacheName })));
        if (!a.cacheName) throw new Error('cacheName required');
        if (act === 'deleteCache') { await page.evaluate(id, `caches.delete(${JSON.stringify(a.cacheName)})`); return `Deleted cache ${a.cacheName}`; }
        if (act === 'delete') { if (!a.request) throw new Error('request URL required'); const okd = await page.evaluate<boolean>(id, `caches.open(${JSON.stringify(a.cacheName)}).then(c => c.delete(${JSON.stringify(a.request)}))`); return okd ? `Deleted ${a.request} from ${a.cacheName}` : `No entry ${a.request} in ${a.cacheName}`; }
        const entries = await page.evaluate<any[]>(id, `caches.open(${JSON.stringify(a.cacheName)}).then(async c => { const ks = await c.keys(); const out = []; for (const k of ks.slice(${a.skip ?? 0}, ${(a.skip ?? 0) + (a.pageSize ?? 50)})) { if (${JSON.stringify(a.pathFilter ?? '')} && !k.url.includes(${JSON.stringify(a.pathFilter ?? '')})) continue; const r = await c.match(k); out.push({ url: k.url, method: k.method, status: r && r.status, type: r && r.type, contentType: r && r.headers.get('content-type') }); } return out; })`);
        return { cacheName: a.cacheName, entries };
      }
      case 'usage': {
        const origin = await originOf(id, a.origin);
        const r = await cdp('Storage.getUsageAndQuota', { origin }).catch(() => undefined);
        if (r) return { origin, usageBytes: r.usage, quotaBytes: r.quota, overrideActive: r.overrideActive, breakdown: r.usageBreakdown.filter((b: any) => b.usage).map((b: any) => ({ type: b.storageType, bytes: b.usage })) };
        const est = await page.evaluate<any>(id, 'navigator.storage.estimate()');
        return { origin, usageBytes: est.usage, quotaBytes: est.quota, breakdown: Object.entries(est.usageDetails ?? {}).map(([type, bytes]) => ({ type, bytes })), note: 'Storage domain unavailable in this mode; using navigator.storage.estimate()' };
      }
      case 'clear': {
        if (!a.types?.length) throw new Error('types required (explicit list)');
        const origin = await originOf(id, a.origin);
        const r = await cdp('Storage.clearDataForOrigin', { origin, storageTypes: a.types.join(',') }).catch(() => undefined);
        if (r) return `Cleared ${a.types.join(', ')} for ${origin}`;
        const done: string[] = [];
        for (const t of a.types) {
          if (t === 'local_storage' || t === 'all') { await page.evaluate(id, 'localStorage.clear()'); done.push('local_storage'); }
          if (t === 'session_storage' || t === 'all') { await page.evaluate(id, 'sessionStorage.clear()'); done.push('session_storage'); }
          if (t === 'cache_storage' || t === 'all') { await page.evaluate(id, 'caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))))'); done.push('cache_storage'); }
          if (t === 'indexeddb' || t === 'all') { await page.evaluate(id, 'indexedDB.databases().then(ds => Promise.all(ds.map(d => new Promise(r => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = () => r(1); }))))'); done.push('indexeddb'); }
          if (t === 'cookies' || t === 'all') { const cs = await cdp('Network.getCookies'); for (const ck of cs.cookies) await cdp('Network.deleteCookies', { name: ck.name, domain: ck.domain, path: ck.path }); done.push('cookies'); }
          if (t === 'service_workers' || t === 'all') { await page.evaluate(id, 'navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister())))'); done.push('service_workers'); }
        }
        return `Cleared ${done.join(', ')} for ${origin} (in-page; Storage domain unavailable in this mode)`;
      }
    }
  });

  tool(ctx, 'devtools_workers', 'Service workers and PWA. list registrations, versions, and worker targets; update, unregister, skipWaiting, start, stop a worker; bypass routes requests around service workers; forceUpdate reloads the worker on every navigation; manifest reads the web app manifest and installability errors; evaluate runs JavaScript inside a worker (attaches to its target).', {
    tabId: tabArg, action: z.enum(['list', 'update', 'unregister', 'skipWaiting', 'start', 'stop', 'bypass', 'forceUpdate', 'manifest', 'evaluate', 'errors']),
    scope: z.string().optional().describe('Registration scope URL (defaults to the only registration)'), versionId: z.string().optional(), targetId: z.string().optional(), enabled: z.boolean().optional(), expression: z.string().optional(),
  }, async (a) => {
    const id = await tab(a.tabId);
    const cdp = (m: string, p?: unknown) => sessions.cdp(id, m, p);
    const st = capture.get(id);
    const swDomain = await cdp('ServiceWorker.enable').then(() => true).catch(() => false);
    // The page's own view of registrations works in every mode; the ServiceWorker domain adds versions/targets where available.
    const pageRegs = () => page.evaluate<any[]>(id, `navigator.serviceWorker.getRegistrations().then(rs => rs.map(r => ({ scopeURL: r.scope, active: r.active && { scriptURL: r.active.scriptURL, state: r.active.state }, waiting: r.waiting && { scriptURL: r.waiting.scriptURL, state: r.waiting.state }, installing: r.installing && { scriptURL: r.installing.scriptURL, state: r.installing.state }, updateViaCache: r.updateViaCache })))`).catch(() => [] as any[]);
    const scopeOf = async () => { if (a.scope) return a.scope; const regs = [...(st?.swRegistrations.values() ?? [])].filter((r) => !r.isDeleted).map((r) => r.scopeURL); const fromPage = regs.length ? regs : (await pageRegs()).map((r) => r.scopeURL); if (fromPage.length === 1) return fromPage[0]; throw new Error(fromPage.length ? `scope required; registrations: ${fromPage.join(', ')}` : 'No service worker registrations found for this page.'); };
    const viaPage = (fn: string) => async (scope: string) => page.evaluate(id, `navigator.serviceWorker.getRegistration(${JSON.stringify(scope)}).then(r => { if (!r) throw new Error('no registration for ' + ${JSON.stringify(scope)}); return ${fn}; })`);
    switch (a.action) {
      case 'list': {
        const targets = await cdp('Target.getTargets').then((r) => r.targetInfos.filter((t: any) => /worker/.test(t.type)).map((t: any) => ({ targetId: t.targetId, type: t.type, url: t.url, title: t.title }))).catch((e) => `Target domain unavailable in this mode (${e.message.replace(/[{}"]/g, '')})`);
        const fromPage = await pageRegs();
        const cdpRegs = [...(st?.swRegistrations.values() ?? [])];
        return { registrations: fromPage.length ? fromPage : cdpRegs, versions: [...(st?.swVersions.values() ?? [])].map((v) => ({ versionId: v.versionId, registrationId: v.registrationId, scriptURL: v.scriptURL, status: v.status, running: v.runningStatus, targetId: v.targetId, controlledClients: v.controlledClients?.length })), workerTargets: targets, serviceWorkerDomain: swDomain ? 'available' : 'unavailable in this mode; using the page\'s navigator.serviceWorker view', controller: await page.evaluate(id, 'navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL').catch(() => null) };
      }
      case 'update': { const scope = await scopeOf(); if (swDomain) await cdp('ServiceWorker.updateRegistration', { scopeURL: scope }).catch(() => viaPage('r.update().then(() => 1)')(scope)); else await viaPage('r.update().then(() => 1)')(scope); return `Update requested for ${scope}.${swDomain ? ' Watch devtools_events for ServiceWorker.workerVersionUpdated.' : ''}`; }
      case 'unregister': { const scope = await scopeOf(); if (swDomain) await cdp('ServiceWorker.unregister', { scopeURL: scope }).catch(() => viaPage('r.unregister()')(scope)); else await viaPage('r.unregister()')(scope); return `Unregistered ${scope}`; }
      case 'skipWaiting': { const scope = await scopeOf(); if (!swDomain) throw new Error('skipWaiting needs the ServiceWorker domain (developer mode); from a page, post a message the worker handles by calling self.skipWaiting()'); await cdp('ServiceWorker.skipWaiting', { scopeURL: scope }); return `skipWaiting sent to ${scope}`; }
      case 'start': { const scope = await scopeOf(); if (!swDomain) throw new Error('startWorker needs the ServiceWorker domain (developer mode)'); await cdp('ServiceWorker.startWorker', { scopeURL: scope }); return `Started worker for ${scope}`; }
      case 'stop': { const vid = a.versionId ?? [...(st?.swVersions.values() ?? [])].find((v) => v.runningStatus === 'running')?.versionId; if (!vid) throw new Error('versionId required'); await cdp('ServiceWorker.stopWorker', { versionId: vid }); return `Stopped worker version ${vid}`; }
      case 'bypass': await cdp('Network.setBypassServiceWorker', { bypass: !!a.enabled }); if (a.enabled) st?.cleanups.push(() => cdp('Network.setBypassServiceWorker', { bypass: false })); return `Bypass service worker: ${!!a.enabled}`;
      case 'forceUpdate': await cdp('ServiceWorker.setForceUpdateOnPageLoad', { forceUpdateOnPageLoad: !!a.enabled }); if (a.enabled) st?.cleanups.push(() => cdp('ServiceWorker.setForceUpdateOnPageLoad', { forceUpdateOnPageLoad: false })); return `Force update on page load: ${!!a.enabled}`;
      case 'manifest': {
        const m = await cdp('Page.getAppManifest');
        let parsed: unknown; try { parsed = m.data && JSON.parse(m.data); } catch { parsed = m.data; }
        const inst = await cdp('Page.getInstallabilityErrors').catch(() => undefined);
        return { url: m.url, errors: m.errors, manifest: parsed, installabilityErrors: inst?.installabilityErrors?.map((e: any) => e.errorId) };
      }
      case 'errors': return st?.swErrors ?? [];
      case 'evaluate': {
        if (!a.expression) throw new Error('expression required');
        const targetId = a.targetId ?? (a.versionId ? st?.swVersions.get(a.versionId)?.targetId : [...(st?.swVersions.values() ?? [])].find((v) => v.runningStatus === 'running')?.targetId);
        if (!targetId) throw new Error('No running worker target; provide targetId or versionId (see list)');
        const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
        try {
          await sessions.cdpSession(id, sessionId, 'Runtime.enable').catch(() => {});
          const r = await sessions.cdpSession(id, sessionId, 'Runtime.evaluate', { expression: a.expression, awaitPromise: true, returnByValue: true, generatePreview: true });
          if (r.exceptionDetails) return { exception: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
          return { type: r.result.type, value: 'value' in r.result ? r.result.value : summarizeArg(r.result).description };
        } finally { await cdp('Target.detachFromTarget', { sessionId }).catch(() => {}); }
      }
    }
  });
}
