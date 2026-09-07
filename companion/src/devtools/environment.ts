// devtools_emulation, devtools_accessibility (tree + browser-reported issues), devtools_security
import { z } from 'zod';
import { type Ctx, tool, tabArg, refArg, matcher, clip } from '../context.ts';
import { resolveNode, refForNode } from './elements.ts';

const DEVICES: Record<string, { width: number; height: number; scale: number; mobile: boolean; ua: string }> = {
  'iphone-14': { width: 390, height: 844, scale: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'iphone-se': { width: 375, height: 667, scale: 2, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'pixel-7': { width: 412, height: 915, scale: 2.625, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36' },
  'ipad': { width: 820, height: 1180, scale: 2, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'desktop': { width: 1280, height: 800, scale: 1, mobile: false, ua: '' },
};
const NET: Record<string, object> = { none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, slow3g: { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 }, fast3g: { offline: false, latency: 563, downloadThroughput: 180_000, uploadThroughput: 84_000 }, '4g': { offline: false, latency: 170, downloadThroughput: 1_100_000, uploadThroughput: 700_000 } };
const emuState = new Map<number, Record<string, unknown>>();

export function registerEnvironmentTools(ctx: Ctx) {
  const { sessions, capture, page } = ctx;
  const tab = (id?: number) => sessions.resolve(id);

  tool(ctx, 'devtools_emulation', 'Device and rendering emulation. device (preset or custom viewport, scale, touch, user agent), viewport, cpu (throttle rate), network (preset), geolocation, media (color scheme, reduced motion, forced colors, print), locale/timezone, vision (deficiency), animations (playback rate, list observed), status, reset. Everything is undone by devtools_session stop or action:reset.', {
    tabId: tabArg, action: z.enum(['device', 'viewport', 'cpu', 'network', 'geolocation', 'media', 'locale', 'vision', 'animations', 'status', 'reset']),
    preset: z.string().optional().describe('device: iphone-14, iphone-se, pixel-7, ipad, desktop · network: none, offline, slow3g, fast3g, 4g'),
    width: z.number().int().optional(), height: z.number().int().optional(), scale: z.number().optional(), mobile: z.boolean().optional(), touch: z.boolean().optional(), userAgent: z.string().optional(),
    rate: z.number().optional().describe('cpu: slowdown factor, 1 = none'), latitude: z.number().optional(), longitude: z.number().optional(), accuracy: z.number().optional(), clear: z.boolean().optional(),
    colorScheme: z.enum(['light', 'dark']).optional(), reducedMotion: z.enum(['reduce', 'no-preference']).optional(), forcedColors: z.enum(['active', 'none']).optional(), contrast: z.enum(['more', 'less', 'no-preference']).optional(), media: z.enum(['screen', 'print']).optional(),
    locale: z.string().optional(), timezone: z.string().optional(), deficiency: z.enum(['none', 'achromatopsia', 'blurredVision', 'deuteranopia', 'protanopia', 'tritanopia', 'reducedContrast']).optional(),
    playbackRate: z.number().optional(),
    resizeWindow: z.boolean().optional().describe('device/viewport: also resize the browser window to the device size so the emulated viewport fills it (default true). reset restores the window.'),
  }, async (a) => {
    const id = await tab(a.tabId);
    const cdp = (m: string, p?: unknown) => sessions.cdp(id, m, p);
    const st = capture.get(id);
    const state = emuState.get(id) ?? emuState.set(id, {}).get(id)!;
    const remember = (k: string, v: unknown, undo: () => Promise<unknown>) => { state[k] = v; st?.cleanups.push(async () => { await undo().catch(() => {}); delete state[k]; }); };
    switch (a.action) {
      case 'device': case 'viewport': {
        const d = a.preset ? DEVICES[a.preset] : undefined; if (a.preset && !d) throw new Error(`Unknown preset. Known: ${Object.keys(DEVICES).join(', ')}`);
        const width = a.width ?? d?.width ?? 1280, height = a.height ?? d?.height ?? 800, deviceScaleFactor = a.scale ?? d?.scale ?? 1, mobile = a.mobile ?? d?.mobile ?? false, touch = a.touch ?? mobile;
        await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile, screenWidth: width, screenHeight: height });
        await cdp('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
        const ua = a.userAgent ?? d?.ua; if (ua) { const orig = state.originalUA ?? await page.evaluate<string>(id, 'navigator.userAgent'); state.originalUA = orig; await cdp('Emulation.setUserAgentOverride', { userAgent: ua }); st?.cleanups.push(() => cdp('Emulation.setUserAgentOverride', { userAgent: orig }).catch(() => {})); }
        let win = '';
        if (a.resizeWindow !== false) {
          // Without DevTools' device frame the emulated viewport sits in the window's corner; make the window the device.
          const r = await sessions.windowSize(id, Math.max(width, 400), height + 90).catch((e) => ({ error: (e as Error).message }));
          win = 'error' in r ? ` (window not resized: ${r.error})` : `; window resized to ${r.width}x${r.height}`;
          state.windowResized = true;
        }
        remember('device', { preset: a.preset, width, height, deviceScaleFactor, mobile, touch, userAgent: ua }, async () => { await cdp('Emulation.clearDeviceMetricsOverride'); await cdp('Emulation.setTouchEmulationEnabled', { enabled: false }); if (state.windowResized) { await sessions.windowSize(id).catch(() => {}); delete state.windowResized; } });
        return `Emulating ${a.preset ?? 'custom'}: ${width}x${height} @${deviceScaleFactor}x${mobile ? ' mobile' : ''}${touch ? ' touch' : ''}${ua ? ' with UA override' : ''}${win}`;
      }
      case 'cpu': await cdp('Emulation.setCPUThrottlingRate', { rate: a.rate ?? 1 }); remember('cpu', a.rate ?? 1, () => cdp('Emulation.setCPUThrottlingRate', { rate: 1 })); return `CPU throttling ${a.rate ?? 1}x`;
      case 'network': { const c = NET[a.preset ?? 'none']; if (!c) throw new Error(`Unknown preset. Known: ${Object.keys(NET).join(', ')}`); await cdp('Network.emulateNetworkConditions', c); remember('network', a.preset, () => cdp('Network.emulateNetworkConditions', NET.none)); return `Network: ${a.preset ?? 'none'}`; }
      case 'geolocation': { if (a.clear) { await cdp('Emulation.clearGeolocationOverride'); delete state.geolocation; return 'Geolocation override cleared'; } if (a.latitude === undefined || a.longitude === undefined) throw new Error('latitude and longitude required'); await cdp('Emulation.setGeolocationOverride', { latitude: a.latitude, longitude: a.longitude, accuracy: a.accuracy ?? 10 }); remember('geolocation', { latitude: a.latitude, longitude: a.longitude }, () => cdp('Emulation.clearGeolocationOverride')); return `Geolocation ${a.latitude}, ${a.longitude}`; }
      case 'media': {
        const features = [a.colorScheme && { name: 'prefers-color-scheme', value: a.colorScheme }, a.reducedMotion && { name: 'prefers-reduced-motion', value: a.reducedMotion }, a.forcedColors && { name: 'forced-colors', value: a.forcedColors }, a.contrast && { name: 'prefers-contrast', value: a.contrast }].filter(Boolean);
        await cdp('Emulation.setEmulatedMedia', { media: a.media ?? '', features }); remember('media', { media: a.media, features }, () => cdp('Emulation.setEmulatedMedia', { media: '', features: [] }));
        return `Emulated media: ${a.media ?? 'screen'} ${features.map((f: any) => `${f.name}=${f.value}`).join(' ')}`;
      }
      case 'locale': { if (a.locale) { await cdp('Emulation.setLocaleOverride', { locale: a.locale }); remember('locale', a.locale, () => cdp('Emulation.setLocaleOverride', {})); } if (a.timezone) { await cdp('Emulation.setTimezoneOverride', { timezoneId: a.timezone }); remember('timezone', a.timezone, () => cdp('Emulation.setTimezoneOverride', { timezoneId: '' })); } return `Locale ${a.locale ?? '(unchanged)'}, timezone ${a.timezone ?? '(unchanged)'}`; }
      case 'vision': await cdp('Emulation.setEmulatedVisionDeficiency', { type: a.deficiency ?? 'none' }); remember('vision', a.deficiency, () => cdp('Emulation.setEmulatedVisionDeficiency', { type: 'none' })); return `Vision deficiency: ${a.deficiency ?? 'none'}`;
      case 'animations': { await cdp('Animation.enable').catch(() => {}); if (a.playbackRate !== undefined) { await cdp('Animation.setPlaybackRate', { playbackRate: a.playbackRate }); remember('animationRate', a.playbackRate, () => cdp('Animation.setPlaybackRate', { playbackRate: 1 })); } const rate = await cdp('Animation.getPlaybackRate').catch(() => ({ playbackRate: undefined })); return { playbackRate: rate.playbackRate, observed: (st?.animations ?? []).slice(-30).map((x) => ({ ...x, ts: new Date(x.ts).toISOString() })), note: st ? undefined : 'Start a devtools session to observe animations.' }; }
      case 'status': return state;
      case 'reset': { if (state.windowResized) await sessions.windowSize(id).catch(() => {}); await cdp('Emulation.clearDeviceMetricsOverride').catch(() => {}); await cdp('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {}); await cdp('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {}); await cdp('Network.emulateNetworkConditions', NET.none).catch(() => {}); await cdp('Emulation.clearGeolocationOverride').catch(() => {}); await cdp('Emulation.setEmulatedMedia', { media: '', features: [] }).catch(() => {}); await cdp('Emulation.setEmulatedVisionDeficiency', { type: 'none' }).catch(() => {}); if (state.originalUA) await cdp('Emulation.setUserAgentOverride', { userAgent: state.originalUA }).catch(() => {}); emuState.set(id, {}); return 'Emulation reset'; }
    }
  });

  tool(ctx, 'devtools_accessibility', 'Accessibility tree and browser-reported issues. tree returns roles, names, and states for the page or a subtree (by ref/selector); node returns full properties for one element; check runs a quick audit (missing alt/labels/names, duplicate ids); issues lists problems Chrome reported (Audits domain: cookies, CORS, CSP, mixed content, deprecations, low contrast, quirks…) with affected node refs.', {
    tabId: tabArg, action: z.enum(['tree', 'node', 'check', 'issues']), ref: refArg.optional(), selector: z.string().optional(), depth: z.number().int().optional(), limit: z.number().int().optional(),
    code: z.string().optional().describe('issues: filter by issue code substring, e.g. "Cookie", "MixedContent", "Cors", "ContentSecurityPolicy", "LowTextContrast"'), query: z.string().optional(), resolveNodes: z.boolean().optional(),
  }, async (a) => {
    const id = await tab(a.tabId);
    const cdp = (m: string, p?: unknown) => sessions.cdp(id, m, p);
    switch (a.action) {
      case 'tree': case 'node': {
        await cdp('Accessibility.enable').catch(() => {});
        let nodes: any[];
        if (a.ref || a.selector) { const nodeId = await resolveNode(ctx, id, a); nodes = (await cdp('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: a.action === 'tree' })).nodes; }
        else if (a.action === 'node') throw new Error('ref or selector required for node');
        else nodes = (await cdp('Accessibility.getFullAXTree', { depth: a.depth ?? 12 })).nodes;
        const byId = new Map(nodes.map((n: any) => [n.nodeId, n]));
        const fmt = (n: any) => { const props = (n.properties ?? []).filter((p: any) => p.value?.value !== false && p.name !== 'focusable').map((p: any) => `${p.name}=${p.value?.value ?? ''}`).join(' '); return `${n.role?.value ?? 'unknown'}${n.name?.value ? ` "${clip(String(n.name.value), 80)}"` : ''}${n.value?.value ? ` value="${clip(String(n.value.value), 40)}"` : ''}${props ? ' [' + props + ']' : ''}${n.ignored ? ' (ignored)' : ''}`; };
        if (a.action === 'node') { const n = nodes.find((x: any) => !x.ignored && x.backendDOMNodeId) ?? nodes[0]; return { role: n.role?.value, name: n.name?.value, nameSources: n.name?.sources?.filter((s: any) => s.value?.value !== undefined).map((s: any) => `${s.type}${s.attribute ? ':' + s.attribute : ''} → "${s.value.value}"`), description: n.description?.value, value: n.value?.value, properties: Object.fromEntries((n.properties ?? []).map((p: any) => [p.name, p.value?.value])), ignored: n.ignored, ignoredReasons: n.ignoredReasons?.map((r: any) => r.name) }; }
        const lines: string[] = []; const max = a.limit ?? 400;
        const roots = nodes.filter((n: any) => !n.parentId || !byId.has(n.parentId));
        const walk = (n: any, d: number) => { if (lines.length >= max) return; if (!n.ignored) lines.push(`${'  '.repeat(d)}- ${fmt(n)}`); for (const c of n.childIds ?? []) { const ch = byId.get(c); if (ch) walk(ch, n.ignored ? d : d + 1); } };
        for (const r of roots) walk(r, 0);
        return `${lines.join('\n')}${nodes.length > lines.length ? `\n… ${nodes.length - lines.length} more nodes (raise limit)` : ''}`;
      }
      case 'check': {
        const problems = await page.evaluate<any[]>(id, `(function(){
          var out = []; var S = window.__bmcp || (window.__bmcp = { els: [], idx: new WeakMap() }); if (!S.idx) S.idx = new WeakMap(); var ref = function(el){ var i = S.idx.get(el); if (i === undefined) { i = S.els.push(el) - 1; S.idx.set(el, i); } return 'e' + i; };
          var vis = function(el){ var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          for (var img of document.querySelectorAll('img:not([alt])')) if (vis(img)) out.push({ rule: 'image-alt', ref: ref(img), detail: (img.getAttribute('src') || '').slice(0, 80) });
          for (var b of document.querySelectorAll('button, [role=button], a[href]')) if (vis(b) && !(b.innerText || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby') && !b.getAttribute('title') && !b.querySelector('img[alt]:not([alt=""])')) out.push({ rule: b.tagName === 'A' ? 'link-name' : 'button-name', ref: ref(b) });
          for (var i of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')) { var lab = i.id && document.querySelector('label[for="' + CSS.escape(i.id) + '"]'); if (vis(i) && !lab && !i.closest('label') && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby') && !i.getAttribute('title') && !i.getAttribute('placeholder')) out.push({ rule: 'form-label', ref: ref(i), detail: i.name || i.type }); }
          var ids = {}; for (var el of document.querySelectorAll('[id]')) { ids[el.id] = (ids[el.id] || 0) + 1; } for (var k in ids) if (ids[k] > 1) out.push({ rule: 'duplicate-id', detail: k + ' x' + ids[k] });
          if (!document.documentElement.getAttribute('lang')) out.push({ rule: 'html-lang', detail: 'missing lang attribute' });
          var h1 = document.querySelectorAll('h1').length; if (h1 !== 1) out.push({ rule: 'single-h1', detail: h1 + ' h1 elements' });
          for (var f of document.querySelectorAll('iframe:not([title])')) out.push({ rule: 'frame-title', ref: ref(f) });
          for (var t of document.querySelectorAll('[tabindex]')) if (Number(t.getAttribute('tabindex')) > 0) out.push({ rule: 'positive-tabindex', ref: ref(t), detail: t.getAttribute('tabindex') });
          return out.slice(0, ${a.limit ?? 100}); })()`);
        return { problems, note: 'Heuristic checks only; color contrast is not evaluated. Chrome-reported issues: action:issues.' };
      }
      case 'issues': {
        const st = capture.require(id);
        const cm = matcher(a.code), qm = matcher(a.query);
        const items = st.issues.filter((i) => cm(i.code) && qm(JSON.stringify(i.details))).slice(-(a.limit ?? 50));
        const out = [];
        for (const i of items) {
          const d: any = i.details; const key = Object.keys(d)[0]; const det = d[key] ?? {};
          const row: any = { id: i.id, ts: new Date(i.ts).toISOString(), code: i.code, summary: clip(summarizeIssue(i.code, det), 300) };
          const backendIds = [det.violatingNodeId, ...(det.affectedNodes ?? []).map((n: any) => n.backendNodeId ?? n), det.frontendNodeId].filter((x) => typeof x === 'number');
          if (a.resolveNodes && backendIds.length) { try { await cdp('DOM.getDocument', { depth: 0 }); const r = await cdp('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: backendIds.slice(0, 5) }); row.nodes = (await Promise.all(r.nodeIds.map((n: number) => refForNode(ctx, id, n)))).filter(Boolean); } catch {} }
          out.push(row);
        }
        return { total: st.issues.length, dropped: st.dropped.issues, items: out };
      }
    }
  });

  tool(ctx, 'devtools_security', 'Security panel. state: connection security, certificate (subject, issuer, validity, protocol, cipher), and Chrome security issue ids. certificate: details for the main document or a URL. mixedContent: insecure subresources on a secure page. issues: security-related browser-reported issues (mixed content, CSP, CORS, insecure cookies, SAB…).', {
    tabId: tabArg, action: z.enum(['state', 'certificate', 'mixedContent', 'issues']), url: z.string().optional(),
  }, async (a) => {
    const id = await tab(a.tabId);
    const st = capture.get(id);
    switch (a.action) {
      case 'state': {
        const s: any = st?.security;
        if (!s) return { note: 'No security state received yet. Start a devtools session (Security domain) and reload; or use action:certificate which reads the document response.' };
        const c = s.certificateSecurityState;
        return { securityState: s.securityState, issues: s.securityStateIssueIds, safetyTip: s.safetyTipInfo?.safetyTipStatus, certificate: c && { subject: c.subjectName, issuer: c.issuer, validFrom: new Date(c.validFrom * 1000).toISOString(), validTo: new Date(c.validTo * 1000).toISOString(), protocol: c.protocol, keyExchange: c.keyExchange, cipher: c.cipher, mac: c.mac, certificateHasWeakSignature: c.certificateHasWeakSignature, certificateHasSha1Signature: c.certificateHasSha1Signature, modernSSL: c.modernSSL, obsoleteSslProtocol: c.obsoleteSslProtocol, obsoleteSslKeyExchange: c.obsoleteSslKeyExchange, obsoleteSslCipher: c.obsoleteSslCipher, certificateNetworkError: c.certificateNetworkError } };
      }
      case 'certificate': {
        const s2 = capture.require(id);
        const r = a.url ? s2.network.find((x) => x.url === a.url || x.url.includes(a.url!)) : [...s2.network].reverse().find((x) => x.type === 'Document' && x.securityDetails) ?? [...s2.network].reverse().find((x) => x.securityDetails);
        if (!r) return { note: 'No request with TLS details in the network log. Reload with the session active.' };
        return { url: r.url, securityState: r.securityState, ...r.securityDetails };
      }
      case 'mixedContent': {
        const s2 = capture.require(id);
        const pageUrl = await page.evaluate<string>(id, 'location.href');
        const insecure = s2.network.filter((r) => /^http:/.test(r.url) && /^https:/.test(r.documentURL ?? pageUrl)).map((r) => ({ url: r.url, type: r.type, status: r.status, blocked: r.blockedReason, initiator: r.initiator?.url }));
        const issues = s2.issues.filter((i) => i.code === 'MixedContentIssue').map((i) => summarizeIssue(i.code, (i.details as any).mixedContentIssueDetails));
        return { page: pageUrl, secure: /^https:/.test(pageUrl), insecureRequests: insecure, mixedContentIssues: issues };
      }
      case 'issues': { const s2 = capture.require(id); return s2.issues.filter((i) => /MixedContent|ContentSecurityPolicy|Cors|Cookie|SharedArrayBuffer|TrustedWebActivity|AttributionReporting|HeavyAd|Federated|Bounce|ClientHint/.test(i.code)).slice(-50).map((i) => ({ id: i.id, code: i.code, summary: clip(summarizeIssue(i.code, (i.details as any)[Object.keys(i.details as object)[0]] ?? {}), 300) })); }
    }
  });
}

function summarizeIssue(code: string, d: any): string {
  switch (code) {
    case 'CookieIssue': return `${(d.cookieExclusionReasons ?? d.cookieWarningReasons ?? []).join(', ')} cookie=${d.cookie?.name ?? d.rawCookieLine ?? ''} url=${d.cookieUrl ?? ''}`;
    case 'MixedContentIssue': return `${d.resolutionStatus} ${d.resourceType ?? ''} ${d.insecureURL} on ${d.mainResourceURL}`;
    case 'ContentSecurityPolicyIssue': return `${d.contentSecurityPolicyViolationType} directive=${d.violatedDirective} blocked=${d.blockedURL ?? ''} at ${d.sourceCodeLocation?.url ?? ''}:${d.sourceCodeLocation?.lineNumber ?? ''}`;
    case 'CorsIssue': return `${d.corsErrorStatus?.corsError} ${d.request?.url ?? ''} initiator=${d.initiatorOrigin ?? ''}`;
    case 'LowTextContrastIssue': return `contrast ${d.contrastRatio} (threshold AA ${d.thresholdsAA}) ${d.violatingNodeSelector} font ${d.fontSize}/${d.fontWeight}`;
    case 'DeprecationIssue': return `${d.type} at ${d.sourceCodeLocation?.url ?? ''}:${d.sourceCodeLocation?.lineNumber ?? ''}`;
    case 'GenericIssue': return `${d.errorType} ${d.violatingNodeAttribute ?? ''}`;
    case 'QuirksModeIssue': return `${d.isLimitedQuirksMode ? 'limited-quirks' : 'quirks'} mode ${d.url}`;
    case 'SharedArrayBufferIssue': return `${d.type} ${d.isWarning ? '(warning)' : ''} at ${d.sourceCodeLocation?.url ?? ''}`;
    case 'HeavyAdIssue': return `${d.resolution} ${d.reason} ${d.frame?.frameId ?? ''}`;
    default: return JSON.stringify(d);
  }
}
