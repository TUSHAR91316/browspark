// devtools_debugger: breakpoints of every kind, pause/step, stacks, scopes, watches, variable edits, blackboxing.
import { z } from 'zod';
import { type Ctx, tool, tabArg, refArg, clip } from '../context.ts';
import { describeObject } from './console.ts';
import { originalLocation, generatedLocation } from './sources.ts';
import { summarizeArg, type TabState } from './capture.ts';
import { resolveNode } from './elements.ts';

export function registerDebuggerTools(ctx: Ctx) {
  const { sessions, capture } = ctx;
  const tab = (id?: number) => sessions.resolve(id);
  const domBreakpoint = (kind: string) => ({ dom: 'DOM', event: 'EventListener', xhr: 'XHR' } as Record<string, string>)[kind];

  // `since` is the event watermark taken before the command was sent: a pause that lands before we start waiting must still count.
  const waitPause = async (id: number, st: TabState, timeoutMs = 5000, since = st.seq) => {
    const before = since;
    const e = await capture.waitFor(id, (e) => e.method === 'Debugger.paused', timeoutMs, before);
    return e ? await stack(id, st) : { paused: false, note: `Not paused within ${timeoutMs}ms; the code may not have run yet. Use devtools_events wait with method "Debugger.paused".`, recentDebuggerEvents: st.events.filter((x) => x.method.startsWith('Debugger.') || x.method.startsWith('companion.')).slice(-6).map((x) => `${x.id} ${x.method} ${x.summary}`), pausedFlag: !!st.paused };
  };
  const stack = async (id: number, st: TabState) => {
    if (!st.paused) return { paused: false };
    const frames = await Promise.all(st.paused.callFrames.slice(0, 30).map(async (f: any, i: number) => {
      const loc = f.location, url = f.url || st.scripts.get(loc.scriptId)?.url || `script:${loc.scriptId}`;
      const orig = await originalLocation(ctx, id, st, loc.scriptId, loc.lineNumber + 1, loc.columnNumber + 1).catch(() => undefined);
      return { index: i, callFrameId: f.callFrameId, functionName: f.functionName || '(anonymous)', location: `${url}:${loc.lineNumber + 1}:${loc.columnNumber + 1}`, ...(orig && { original: `${orig.source}:${orig.line}:${orig.column}` }), scopes: f.scopeChain.map((s: any, j: number) => `${j}:${s.type}${s.name ? '(' + s.name + ')' : ''}`).join(' ') };
    }));
    const asyncFrames: string[] = [];
    let a = st.paused.asyncStackTrace; while (a && asyncFrames.length < 20) { asyncFrames.push(`— ${a.description ?? 'async'} —`); for (const f of a.callFrames.slice(0, 5)) asyncFrames.push(`${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`); a = a.parent; }
    return { paused: true, reason: st.paused.reason, hitBreakpoints: st.paused.hitBreakpoints, data: st.paused.data, since: new Date(st.paused.ts).toISOString(), frames, ...(asyncFrames.length && { asyncStack: asyncFrames }) };
  };
  const frameOf = (st: TabState, index = 0) => { if (!st.paused) throw new Error('Not paused'); const f = st.paused.callFrames[index]; if (!f) throw new Error(`No call frame ${index}`); return f; };

  tool(ctx, 'devtools_debugger', 'JavaScript debugger. Breakpoints: set (by url/scriptId or original source via source map; line 1-based; optional condition or logMessage), remove, enable, disable, list; exceptions (none|uncaught|all); dom (subtree-modified|attribute-modified|node-removed on a ref/selector); event (listener breakpoints, e.g. "click"); xhr (URL substring). Execution: pause, resume, stepInto, stepOver, stepOut, continueTo. Inspection while paused: stack (sync+async, mapped to original sources), scope (variables of frame/scope), variables (all scopes of a frame), evaluate/watch (expressions in a frame), setVariable. blackbox ignores library scripts while stepping.', {
    tabId: tabArg, action: z.enum(['list', 'set', 'remove', 'enable', 'disable', 'exceptions', 'dom', 'event', 'xhr', 'pause', 'resume', 'stepInto', 'stepOver', 'stepOut', 'continueTo', 'stack', 'scope', 'variables', 'evaluate', 'watch', 'setVariable', 'blackbox', 'breakOnAsync']),
    url: z.string().optional().describe('Script URL (exact or substring) for set/continueTo'), scriptId: z.string().optional(), source: z.string().optional().describe('Original source path (source-mapped) for set/continueTo'),
    line: z.number().int().optional().describe('1-based'), column: z.number().int().optional(), condition: z.string().optional(), logMessage: z.string().optional().describe('Logpoint: log this expression instead of pausing'),
    breakpointId: z.string().optional(), all: z.boolean().optional(),
    state: z.enum(['none', 'uncaught', 'all']).optional().describe('For exceptions'),
    ref: refArg.optional(), selector: z.string().optional(), domType: z.enum(['subtree-modified', 'attribute-modified', 'node-removed']).optional(),
    eventName: z.string().optional(), targetName: z.string().optional().describe('Optional event target interface, e.g. "xmlhttprequest", "window"'), urlSubstring: z.string().optional().describe('For xhr breakpoints'), remove: z.boolean().optional().describe('For dom/event/xhr: remove instead of set'),
    frameIndex: z.number().int().optional(), scopeIndex: z.number().int().optional(), name: z.string().optional().describe('Variable name for setVariable'), expression: z.string().optional(), expressions: z.array(z.string()).optional(),
    patterns: z.array(z.string()).optional().describe('Blackbox regexes, e.g. ["node_modules", "vendor\\\\.js"]'), depth: z.number().int().min(0).max(3).optional(), timeoutMs: z.number().int().optional(),
    maxDepth: z.number().int().optional().describe('For breakOnAsync: async stack depth (default 8)'),
  }, async (a) => {
    const id = await tab(a.tabId);
    const st = capture.require(id);
    const removeBreakpoint = async (breakpointId: string) => {
      const b = st.breakpoints.get(breakpointId);
      if (!b) throw new Error(`Unknown breakpoint ${breakpointId}`);
      if (!b.enabled) return;
      const kind = domBreakpoint(b.kind);
      await sessions.cdp(id, kind ? `DOMDebugger.remove${kind}Breakpoint` : 'Debugger.removeBreakpoint', kind ? b.raw : { breakpointId });
    };
    const findScript = () => a.scriptId ? st.scripts.get(a.scriptId) : a.url ? [...st.scripts.values()].find((s) => s.url === a.url) ?? [...st.scripts.values()].find((s) => s.url.includes(a.url!)) : undefined;
    const locate = async () => {
      if (a.line === undefined) throw new Error('line required');
      if (a.source) { const g = await generatedLocation(ctx, id, st, a.source, a.line, a.column); if (!g) throw new Error(`No source map maps ${a.source}:${a.line}. Check devtools_sources sourcemap.`); return { url: g.url, scriptId: g.scriptId, line: g.line, column: g.column, label: `${a.source}:${a.line} → ${g.url}:${g.line}:${g.column}` }; }
      const s = findScript();
      if (!s && !a.url) throw new Error('Provide url, scriptId, or source');
      return { url: s?.url ?? a.url!, scriptId: s?.scriptId, line: a.line, column: a.column, label: `${s?.url ?? a.url}:${a.line}${a.column ? ':' + a.column : ''}` };
    };
    switch (a.action) {
      case 'list': return { paused: !!st.paused, breakpoints: [...st.breakpoints.entries()].map(([bid, b]) => ({ breakpointId: bid, ...b, raw: undefined })) };
      case 'set': {
        const loc = await locate();
        const condition = a.logMessage ? `console.log(${a.logMessage}), false` : a.condition;
        const r = await sessions.cdp(id, 'Debugger.setBreakpointByUrl', { url: loc.url, lineNumber: loc.line - 1, columnNumber: loc.column !== undefined ? loc.column - 1 : undefined, condition });
        st.breakpoints.set(r.breakpointId, { kind: a.logMessage ? 'logpoint' : 'line', description: loc.label + (condition ? ` if (${a.condition ?? a.logMessage})` : ''), enabled: true, raw: { url: loc.url, lineNumber: loc.line - 1, columnNumber: loc.column !== undefined ? loc.column - 1 : undefined, condition } });
        return { breakpointId: r.breakpointId, at: loc.label, resolvedLocations: r.locations.map((l: any) => `${st.scripts.get(l.scriptId)?.url ?? l.scriptId}:${l.lineNumber + 1}:${l.columnNumber + 1}`), note: r.locations.length ? undefined : 'No script matched yet; it binds when a matching script loads (reload if needed).' };
      }
      case 'remove': {
        const ids = a.all ? [...st.breakpoints.keys()] : a.breakpointId ? [a.breakpointId] : [];
        if (!ids.length) throw new Error('breakpointId or all:true required');
        for (const b of ids) { await removeBreakpoint(b); st.breakpoints.delete(b); }
        return `Removed ${ids.length} breakpoint(s)`;
      }
      case 'disable': case 'enable': {
        if (a.all) { await sessions.cdp(id, 'Debugger.setBreakpointsActive', { active: a.action === 'enable' }); for (const b of st.breakpoints.values()) b.enabled = a.action === 'enable'; return `All breakpoints ${a.action}d`; }
        const b = a.breakpointId && st.breakpoints.get(a.breakpointId); if (!b) throw new Error('breakpointId (or all:true) required');
        if (a.action === 'disable') { await removeBreakpoint(a.breakpointId!); b.enabled = false; return `Disabled ${a.breakpointId} (kept; enable re-arms it)`; }
        if (b.enabled) return 'Already enabled';
        const kind = domBreakpoint(b.kind);
        const r = await sessions.cdp(id, kind ? `DOMDebugger.set${kind}Breakpoint` : 'Debugger.setBreakpointByUrl', b.raw);
        const breakpointId = kind ? a.breakpointId! : r.breakpointId;
        st.breakpoints.delete(a.breakpointId!); st.breakpoints.set(breakpointId, { ...b, enabled: true });
        return `Enabled as ${breakpointId}`;
      }
      case 'exceptions': { await sessions.cdp(id, 'Debugger.setPauseOnExceptions', { state: a.state ?? 'uncaught' }); st.cleanups.push(() => sessions.cdp(id, 'Debugger.setPauseOnExceptions', { state: 'none' })); return `Pause on exceptions: ${a.state ?? 'uncaught'}`; }
      case 'dom': {
        const nodeId = await resolveNode(ctx, id, { ref: a.ref, selector: a.selector });
        const type = a.domType ?? 'subtree-modified';
        await sessions.cdp(id, a.remove ? 'DOMDebugger.removeDOMBreakpoint' : 'DOMDebugger.setDOMBreakpoint', { nodeId, type });
        const key = `dom:${nodeId}:${type}`;
        if (a.remove) st.breakpoints.delete(key); else st.breakpoints.set(key, { kind: 'dom', description: `${type} on ${a.ref ?? a.selector}`, enabled: true, raw: { nodeId, type } });
        if (!a.remove) st.cleanups.push(() => sessions.cdp(id, 'DOMDebugger.removeDOMBreakpoint', { nodeId, type }).catch(() => {}));
        return `${a.remove ? 'Removed' : 'Set'} DOM breakpoint ${type} on ${a.ref ?? a.selector}`;
      }
      case 'event': {
        if (!a.eventName) throw new Error('eventName required');
        await sessions.cdp(id, a.remove ? 'DOMDebugger.removeEventListenerBreakpoint' : 'DOMDebugger.setEventListenerBreakpoint', { eventName: a.eventName, targetName: a.targetName });
        const key = `event:${a.eventName}:${a.targetName ?? '*'}`;
        if (a.remove) st.breakpoints.delete(key); else { st.breakpoints.set(key, { kind: 'event', description: `event ${a.eventName}${a.targetName ? ' on ' + a.targetName : ''}`, enabled: true, raw: { eventName: a.eventName, targetName: a.targetName } }); st.cleanups.push(() => sessions.cdp(id, 'DOMDebugger.removeEventListenerBreakpoint', { eventName: a.eventName, targetName: a.targetName }).catch(() => {})); }
        return `${a.remove ? 'Removed' : 'Set'} event listener breakpoint for ${a.eventName}`;
      }
      case 'xhr': {
        const url = a.urlSubstring ?? a.url ?? '';
        await sessions.cdp(id, a.remove ? 'DOMDebugger.removeXHRBreakpoint' : 'DOMDebugger.setXHRBreakpoint', { url });
        const key = `xhr:${url}`;
        if (a.remove) st.breakpoints.delete(key); else { st.breakpoints.set(key, { kind: 'xhr', description: `XHR/fetch URL contains "${url}"`, enabled: true, raw: { url } }); st.cleanups.push(() => sessions.cdp(id, 'DOMDebugger.removeXHRBreakpoint', { url }).catch(() => {})); }
        return `${a.remove ? 'Removed' : 'Set'} XHR/fetch breakpoint for "${url || 'any'}"`;
      }
      case 'pause': { const since = st.seq; await sessions.cdp(id, 'Debugger.pause'); return waitPause(id, st, a.timeoutMs ?? 3000, since); }
      case 'resume': if (!st.paused) return 'Not paused'; await sessions.cdp(id, 'Debugger.resume'); return 'Resumed';
      case 'stepInto': case 'stepOver': case 'stepOut': {
        if (!st.paused) throw new Error('Not paused');
        const since = st.seq;
        await sessions.cdp(id, `Debugger.${a.action}`, a.action === 'stepInto' ? { breakOnAsyncCall: true } : undefined);
        return waitPause(id, st, a.timeoutMs ?? 5000, since);
      }
      case 'continueTo': {
        if (!st.paused) throw new Error('Not paused');
        const loc = await locate();
        const scriptId = loc.scriptId ?? findScript()?.scriptId; if (!scriptId) throw new Error('Could not resolve scriptId for continueTo');
        const since = st.seq;
        await sessions.cdp(id, 'Debugger.continueToLocation', { location: { scriptId, lineNumber: loc.line - 1, columnNumber: loc.column !== undefined ? loc.column - 1 : undefined } });
        return waitPause(id, st, a.timeoutMs ?? 5000, since);
      }
      case 'stack': return stack(id, st);
      case 'scope': {
        const f = frameOf(st, a.frameIndex); const sc = f.scopeChain[a.scopeIndex ?? 0]; if (!sc) throw new Error(`No scope ${a.scopeIndex}`);
        return { type: sc.type, name: sc.name, variables: await describeObject(ctx, id, sc.object.objectId, a.depth ?? 1, 100) };
      }
      case 'variables': {
        const f = frameOf(st, a.frameIndex);
        const out: Record<string, unknown> = {};
        for (const sc of f.scopeChain) { if (sc.type === 'global') { out.global = '(omitted; use scope with its index)'; continue; } out[`${sc.type}${sc.name ? ':' + sc.name : ''}`] = await describeObject(ctx, id, sc.object.objectId, a.depth ?? 0, 60); }
        if (f.this) out.this = summarizeArg(f.this).description;
        return out;
      }
      case 'evaluate': case 'watch': {
        const f = frameOf(st, a.frameIndex);
        const exprs = a.expressions ?? (a.expression ? [a.expression] : []); if (!exprs.length) throw new Error('expression(s) required');
        const out: Record<string, unknown> = {};
        for (const e of exprs) {
          const r = await sessions.cdp(id, 'Debugger.evaluateOnCallFrame', { callFrameId: f.callFrameId, expression: e, returnByValue: false, generatePreview: true });
          out[e] = r.exceptionDetails ? `⚠ ${r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text}` : r.result.objectId && (a.depth ?? 1) > 0 && r.result.subtype !== 'null' ? await describeObject(ctx, id, r.result.objectId, (a.depth ?? 1) - 1) : summarizeArg(r.result).description;
        }
        return out;
      }
      case 'setVariable': {
        if (!a.name || a.expression === undefined) throw new Error('name and expression required');
        const f = frameOf(st, a.frameIndex);
        const scopeNumber = a.scopeIndex ?? f.scopeChain.findIndex((s: any) => s.type === 'local' || s.type === 'block');
        const v = await sessions.cdp(id, 'Debugger.evaluateOnCallFrame', { callFrameId: f.callFrameId, expression: a.expression, returnByValue: false });
        if (v.exceptionDetails) throw new Error(v.exceptionDetails.exception?.description ?? 'value expression failed');
        const newValue = v.result.objectId ? { objectId: v.result.objectId } : v.result.unserializableValue ? { unserializableValue: v.result.unserializableValue } : { value: v.result.value };
        await sessions.cdp(id, 'Debugger.setVariableValue', { scopeNumber: Math.max(0, scopeNumber), variableName: a.name, newValue, callFrameId: f.callFrameId });
        return `Set ${a.name} = ${clip(summarizeArg(v.result).description, 100)} in scope ${scopeNumber}`;
      }
      case 'blackbox': { await sessions.cdp(id, 'Debugger.setBlackboxPatterns', { patterns: a.patterns ?? [] }); return `Blackboxed: ${(a.patterns ?? []).join(', ') || '(none)'}`; }
      case 'breakOnAsync': { await sessions.cdp(id, 'Runtime.setAsyncCallStackDepth', { maxDepth: a.maxDepth ?? 8 }); return `Async stack depth ${a.maxDepth ?? 8}`; }
    }
  });
}
