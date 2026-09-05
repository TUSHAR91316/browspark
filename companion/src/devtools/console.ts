// devtools_console and devtools_evaluate
import { z } from 'zod';
import { type Ctx, tool, tabArg, matcher, paginate, pageArgs, clip } from '../context.ts';
import { summarizeArg, type ConsoleMsg } from './capture.ts';

export const fmtConsole = (m: ConsoleMsg, full = false) => ({
  id: m.id, ts: new Date(m.ts).toISOString(), kind: m.kind, level: m.level, text: full ? m.text : clip(m.text, 500),
  ...(m.url && { location: `${m.url}:${m.line ?? '?'}${m.col ? ':' + m.col : ''}` }), ...(m.source && m.kind === 'log' && { source: m.source }),
  ...(m.args?.some((a) => a.objectId) && { objects: m.args.filter((a) => a.objectId).map((a) => ({ objectId: a.objectId, description: clip(a.description, 200) })) }),
  ...(full && m.stack && { stack: m.stack.map((f) => `${f.functionName} (${f.url}:${f.line}:${f.col})`) }),
  ...(!full && m.stack?.length && { topFrame: `${m.stack[0].functionName} (${m.stack[0].url}:${m.stack[0].line}:${m.stack[0].col})` }),
});

export async function describeObject(ctx: Ctx, tabId: number, objectId: string, depth = 1, maxProps = 60): Promise<Record<string, unknown>> {
  const r = await ctx.sessions.cdp(tabId, 'Runtime.getProperties', { objectId, ownProperties: true, accessorPropertiesOnly: false, generatePreview: true });
  const out: Record<string, unknown> = {};
  let n = 0;
  const props: any[] = (r.result ?? []).filter((p: any) => p.name !== '__proto__');
  const isArray = props.some((p: any) => p.name === 'length') && props.every((p: any) => p.name === 'length' || /^\d+$/.test(p.name));
  for (const p of props) {
    if (isArray && p.name === 'length') continue;
    if (n++ >= maxProps) { out['…'] = `${props.length - maxProps} more properties`; break; }
    const v = p.value ?? p.get;
    if (!v) { out[p.name] = p.set ? '(setter)' : undefined; continue; }
    if ((v.type === 'object' || v.type === 'function') && v.objectId && depth > 0 && v.subtype !== 'null') out[p.name] = await describeObject(ctx, tabId, v.objectId, depth - 1, 30).catch(() => summarizeArg(v).description);
    else out[p.name] = summarizeArg(v).description;
  }
  const internal = (r.internalProperties ?? []).filter((p: any) => p.name !== '[[Prototype]]');
  if (internal.length) out['[[internal]]'] = internal.map((p: any) => `${p.name}: ${summarizeArg(p.value).description}`);
  return isArray ? (Object.values(out) as unknown as Record<string, unknown>) : out;
}

export function registerConsoleTools(ctx: Ctx) {
  const { sessions, capture, page } = ctx;
  const tab = (id?: number) => sessions.resolve(id);

  tool(ctx, 'devtools_console', 'Search collected console output: logs, warnings, errors, uncaught exceptions, and browser log entries with stack traces. Preserved across reloads while the session runs. Actions: search (default), get (one message with full stack), inspect (an object logged by id/objectId), wait (block until a matching message), clear.', {
    tabId: tabArg, action: z.enum(['search', 'get', 'inspect', 'wait', 'clear']).default('search'),
    query: z.string().optional().describe('Text or regex to match against message text'), regex: z.boolean().optional(),
    level: z.array(z.enum(['log', 'info', 'warning', 'error', 'debug', 'trace', 'verbose'])).optional(), kind: z.array(z.enum(['console', 'exception', 'log'])).optional(),
    url: z.string().optional().describe('Filter by source URL substring'), frameId: z.string().optional(), contextId: z.number().int().optional(),
    since: z.string().optional().describe('ISO time or ms; only messages after this'), until: z.string().optional(),
    id: z.number().int().optional().describe('Message id for get/inspect'), objectId: z.string().optional().describe('Remote object id for inspect'), depth: z.number().int().min(0).max(4).optional(),
    timeoutMs: z.number().int().max(120_000).optional(), ...pageArgs,
  }, async ({ tabId, action, query, regex, level, kind, url, frameId, contextId, since, until, id: msgId, objectId, depth, timeoutMs, offset, limit }) => {
    const id = await tab(tabId);
    const st = capture.require(id);
    if (action === 'clear') { capture.clear(id, 'console'); return 'Console cleared'; }
    if (action === 'get') { const m = st.console.find((x) => x.id === msgId); if (!m) throw new Error(`No console message with id ${msgId}`); return fmtConsole(m, true); }
    if (action === 'inspect') {
      let oid = objectId;
      if (!oid && msgId !== undefined) { const m = st.console.find((x) => x.id === msgId); oid = m?.exceptionObjectId ?? m?.args?.find((a) => a.objectId)?.objectId; if (!oid) throw new Error(`Message ${msgId} has no inspectable object`); }
      if (!oid) throw new Error('Provide id or objectId');
      return await describeObject(ctx, id, oid, depth ?? 1);
    }
    const qm = matcher(query, regex), um = matcher(url);
    const t0 = since ? new Date(isNaN(Number(since)) ? since : Number(since)).getTime() : 0, t1 = until ? new Date(isNaN(Number(until)) ? until : Number(until)).getTime() : Infinity;
    const pred = (m: ConsoleMsg) => qm(m.text) && (!level || level.includes(m.level as any)) && (!kind || kind.includes(m.kind)) && um(m.url ?? m.stack?.[0]?.url) && (!frameId || m.frameId === frameId) && (contextId === undefined || m.contextId === contextId) && m.ts >= t0 && m.ts <= t1;
    if (action === 'wait') {
      const existing = st.console.filter(pred).at(-1);
      if (existing && (!since || existing.ts >= t0)) return fmtConsole(existing, true);
      const e = await capture.waitFor(id, (e) => { if (e.method !== 'console' && e.method !== 'Runtime.exceptionThrown') return false; const m = st.console.find((x) => x.id === (e.params as any)?.consoleId); return !!m && pred(m); }, timeoutMs ?? 30_000);
      if (!e) throw new Error(`No matching console message within ${timeoutMs ?? 30_000}ms`);
      return fmtConsole(st.console.find((x) => x.id === (e.params as any).consoleId)!, true);
    }
    const all = st.console.filter(pred);
    const pg = paginate(all, offset, limit);
    return { collectionStart: new Date(st.startedAt).toISOString(), dropped: st.dropped.console, ...pg, items: pg.items.map((m) => fmtConsole(m)) };
  });

  tool(ctx, 'devtools_evaluate', 'Evaluate JavaScript in the page (or a specific frame/context, or the paused call frame) and return the value or the exception. Objects come back as previews with an objectId for devtools_console inspect. awaitPromise defaults to true.', {
    tabId: tabArg, expression: z.string(), contextId: z.number().int().optional().describe('Execution context id from devtools_sources frames'), frameId: z.string().optional().describe('Frame id; picks its default context'),
    callFrameId: z.string().optional().describe('Evaluate in a paused call frame (devtools_debugger stack)'), awaitPromise: z.boolean().optional(), returnByValue: z.boolean().optional().describe('Default true; false keeps a live object handle'), depth: z.number().int().min(0).max(4).optional(),
  }, async ({ tabId, expression, contextId, frameId, callFrameId, awaitPromise, returnByValue, depth }) => {
    const id = await tab(tabId);
    if (page.dialogs.has(id)) throw new Error('A JavaScript dialog is open; handle it with browser_dialog first');
    let r: any;
    if (callFrameId) r = await sessions.cdp(id, 'Debugger.evaluateOnCallFrame', { callFrameId, expression, returnByValue: returnByValue ?? true, generatePreview: true });
    else {
      let cid = contextId;
      if (!cid && frameId) { const st = capture.get(id); cid = [...(st?.contexts.values() ?? [])].find((c) => c.frameId === frameId && c.isDefault)?.id; if (!cid) throw new Error(`No execution context known for frame ${frameId}; start a devtools session and reload`); }
      r = await sessions.cdp(id, 'Runtime.evaluate', { expression, contextId: cid, awaitPromise: awaitPromise ?? true, returnByValue: returnByValue ?? true, generatePreview: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true });
    }
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      return { exception: d.exception?.description ?? d.text, line: d.lineNumber + 1, column: d.columnNumber + 1, ...(d.exception?.objectId && { objectId: d.exception.objectId }) };
    }
    const v = r.result;
    if (v.type === 'undefined') return { type: 'undefined' };
    if (v.objectId) return { type: v.type, subtype: v.subtype, className: v.className, description: v.description, objectId: v.objectId, value: returnByValue === false ? undefined : await describeObject(ctx, id, v.objectId, depth ?? 1).catch(() => undefined) };
    return { type: v.type, value: 'value' in v ? v.value : v.unserializableValue ?? v.description };
  });
}
