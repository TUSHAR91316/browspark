// devtools_elements: Elements panel — search, inspect/edit HTML and attributes, styles, computed, box model, listeners, pseudo states, overlays.
import { z } from 'zod';
import { type Ctx, tool, tabArg, refArg, clip } from '../context.ts';

const REF_FN = `function(){ var W = window; try { W.top.__bmcp; W = W.top; } catch (e) {} var S = W.__bmcp || (W.__bmcp = { els: [], idx: new WeakMap() }); if (!S.idx) S.idx = new WeakMap(); var i = S.idx.get(this); if (i === undefined) { i = S.els.push(this) - 1; S.idx.set(this, i); } return 'e' + i; }`;

/** Resolve {ref|selector|nodeId} to a DOM nodeId. */
export async function resolveNode(ctx: Ctx, tabId: number, t: { ref?: string; selector?: string; nodeId?: number }): Promise<number> {
  const cdp = (m: string, p?: unknown) => ctx.sessions.cdp(tabId, m, p);
  if (t.nodeId) return t.nodeId;
  if (t.ref) { const objectId = await ctx.page.objectId(tabId, t.ref); const r = await cdp('DOM.requestNode', { objectId }); return r.nodeId; }
  if (t.selector) { const doc = await cdp('DOM.getDocument', { depth: 0 }); const r = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: t.selector }); if (!r.nodeId) throw new Error(`No element matches ${t.selector}`); return r.nodeId; }
  throw new Error('Provide ref, selector, or nodeId');
}
export async function refForNode(ctx: Ctx, tabId: number, nodeId: number): Promise<string | undefined> {
  try {
    const { object } = await ctx.sessions.cdp(tabId, 'DOM.resolveNode', { nodeId });
    const r = await ctx.sessions.cdp(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: REF_FN, returnByValue: true });
    return r.result.value;
  } catch { return undefined; }
}
const nodeSummary = (n: any) => { const attrs: Record<string, string> = {}; for (let i = 0; i < (n.attributes?.length ?? 0); i += 2) attrs[n.attributes[i]] = n.attributes[i + 1]; return `<${n.nodeName.toLowerCase()}${attrs.id ? '#' + attrs.id : ''}${attrs.class ? '.' + attrs.class.trim().split(/\s+/).join('.') : ''}>`; };

const LAYOUT_PROPS = ['display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'margin', 'padding', 'border', 'box-sizing', 'flex', 'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'grid-template-rows', 'overflow', 'z-index', 'float', 'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'opacity', 'visibility', 'transform', 'transition', 'cursor', 'pointer-events'];

export function registerElementsTools(ctx: Ctx) {
  const { sessions, capture, page } = ctx;
  const tab = (id?: number) => sessions.resolve(id);

  tool(ctx, 'devtools_elements', 'Elements panel. Target an element by ref (from browser_snapshot), CSS selector, or nodeId. Actions: search (CSS selector, XPath, or text; returns refs), describe, html (get/set outerHTML), attributes (get/set/remove), classes (add/remove/toggle), styles (matched rules + inline; setStyle edits inline; setRuleText edits a matched rule), computed, box (box model), listeners (event listeners with source locations), pseudo (force :hover/:active/:focus/…), highlight/hide (overlay), overlays (layout shift regions, paint rects, FPS, grid).', {
    tabId: tabArg, action: z.enum(['search', 'describe', 'html', 'attributes', 'classes', 'styles', 'computed', 'box', 'listeners', 'pseudo', 'highlight', 'hide', 'overlays']),
    ref: refArg.optional(), selector: z.string().optional(), nodeId: z.number().int().optional(),
    query: z.string().optional().describe('For search: selector, XPath, or text'), limit: z.number().int().optional(),
    set: z.string().optional().describe('html: new outerHTML'), depth: z.number().int().optional(),
    name: z.string().optional().describe('Attribute/property name'), value: z.string().optional(), remove: z.boolean().optional(),
    add: z.array(z.string()).optional(), removeClasses: z.array(z.string()).optional(), toggle: z.array(z.string()).optional(),
    property: z.string().optional().describe('styles setStyle: CSS property'), important: z.boolean().optional(),
    styleSheetId: z.string().optional(), range: z.object({ startLine: z.number(), startColumn: z.number(), endLine: z.number(), endColumn: z.number() }).optional(), text: z.string().optional().describe('styles setRuleText: new declarations text'),
    properties: z.array(z.string()).optional().describe('computed: which properties (default common layout props)'), all: z.boolean().optional(),
    states: z.array(z.enum(['active', 'focus', 'focus-visible', 'focus-within', 'hover', 'visited', 'target'])).optional(),
    show: z.object({ layoutShiftRegions: z.boolean().optional(), paintRects: z.boolean().optional(), fps: z.boolean().optional(), grid: z.boolean().optional(), flex: z.boolean().optional() }).optional(),
  }, async (a) => {
    const id = await tab(a.tabId);
    const cdp = (m: string, p?: unknown) => sessions.cdp(id, m, p);
    const st = capture.get(id);
    const node = () => resolveNode(ctx, id, a);
    switch (a.action) {
      case 'search': {
        if (!a.query) throw new Error('query required');
        await cdp('DOM.getDocument', { depth: 0 });
        const { searchId, resultCount } = await cdp('DOM.performSearch', { query: a.query, includeUserAgentShadowDOM: false });
        const n = Math.min(resultCount, a.limit ?? 25);
        const ids: number[] = n ? (await cdp('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: n })).nodeIds : [];
        await cdp('DOM.discardSearchResults', { searchId }).catch(() => {});
        const items = [];
        for (const nodeId of ids) {
          const d = await cdp('DOM.describeNode', { nodeId, depth: 0 }).catch(() => undefined); if (!d || d.node.nodeType !== 1) continue;
          const ref = await refForNode(ctx, id, nodeId);
          const text = await cdp('Runtime.callFunctionOn', { objectId: (await cdp('DOM.resolveNode', { nodeId })).object.objectId, functionDeclaration: 'function(){ return (this.innerText || this.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80); }', returnByValue: true }).then((r) => r.result.value).catch(() => '');
          items.push({ nodeId, ref, element: nodeSummary(d.node), text });
        }
        return { total: resultCount, items };
      }
      case 'describe': { const nodeId = await node(); const d = await cdp('DOM.describeNode', { nodeId, depth: a.depth ?? 1, pierce: true }); return { nodeId, ref: await refForNode(ctx, id, nodeId), ...d.node, backendNodeId: undefined }; }
      case 'html': {
        const nodeId = await node();
        if (a.set !== undefined) { await cdp('DOM.setOuterHTML', { nodeId, outerHTML: a.set }); return `Replaced outerHTML (${a.set.length} chars). Refs to the old node are stale; re-snapshot.`; }
        const r = await cdp('DOM.getOuterHTML', { nodeId }); return { nodeId, chars: r.outerHTML.length, html: clip(r.outerHTML, a.limit ?? 20000) };
      }
      case 'attributes': {
        const nodeId = await node();
        if (a.name && a.remove) { await cdp('DOM.removeAttribute', { nodeId, name: a.name }); return `Removed ${a.name}`; }
        if (a.name && a.value !== undefined) { await cdp('DOM.setAttributeValue', { nodeId, name: a.name, value: a.value }); return `Set ${a.name}="${a.value}"`; }
        const r = await cdp('DOM.getAttributes', { nodeId }); const out: Record<string, string> = {}; for (let i = 0; i < r.attributes.length; i += 2) out[r.attributes[i]] = r.attributes[i + 1]; return out;
      }
      case 'classes': {
        const nodeId = await node();
        const r = await cdp('DOM.getAttributes', { nodeId }); let i = r.attributes.indexOf('class'); const cur = new Set<string>(i >= 0 ? r.attributes[i + 1].trim().split(/\s+/).filter(Boolean) : []);
        for (const c of a.add ?? []) cur.add(c); for (const c of a.removeClasses ?? []) cur.delete(c); for (const c of a.toggle ?? []) cur.has(c) ? cur.delete(c) : cur.add(c);
        await cdp('DOM.setAttributeValue', { nodeId, name: 'class', value: [...cur].join(' ') });
        return { classes: [...cur] };
      }
      case 'styles': {
        const nodeId = await node();
        if (a.property) {
          const { object } = await cdp('DOM.resolveNode', { nodeId });
          await cdp('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function(p, v, i){ v === '' ? this.style.removeProperty(p) : this.style.setProperty(p, v, i ? 'important' : ''); }`, arguments: [{ value: a.property }, { value: a.value ?? '' }, { value: !!a.important }] });
          return `Inline style ${a.property}: ${a.value || '(removed)'}`;
        }
        if (a.styleSheetId && a.range && a.text !== undefined) { const r = await cdp('CSS.setStyleTexts', { edits: [{ styleSheetId: a.styleSheetId, range: a.range, text: a.text }] }); return { edited: r.styles.map((s: any) => s.cssText) }; }
        const m = await cdp('CSS.getMatchedStylesForNode', { nodeId });
        const rule = (r: any) => ({ selector: r.rule.selectorList.text, origin: r.rule.origin, styleSheetId: r.rule.styleSheetId, source: r.rule.styleSheetId && st?.styleSheets.get(r.rule.styleSheetId)?.sourceURL, range: r.rule.style.range, declarations: r.rule.style.cssProperties.filter((p: any) => p.text || p.value).map((p: any) => `${p.name}: ${p.value}${p.important ? ' !important' : ''}${p.disabled ? ' (disabled)' : ''}`) });
        return {
          inline: m.inlineStyle?.cssProperties.filter((p: any) => p.text).map((p: any) => `${p.name}: ${p.value}`), matched: (m.matchedCSSRules ?? []).map(rule).reverse(),
          pseudo: (m.pseudoElements ?? []).map((p: any) => ({ pseudoType: p.pseudoType, rules: p.matches.map(rule) })),
          inherited: (m.inherited ?? []).slice(0, 5).map((i: any, k: number) => ({ ancestor: k + 1, rules: (i.matchedCSSRules ?? []).map(rule).filter((r: any) => r.declarations.length) })),
          note: 'Edit a matched rule with action:styles + styleSheetId + range + text; set an inline property with property/value.',
        };
      }
      case 'computed': {
        const nodeId = await node();
        const r = await cdp('CSS.getComputedStyleForNode', { nodeId });
        const want = a.all ? undefined : new Set(a.properties ?? LAYOUT_PROPS);
        return Object.fromEntries(r.computedStyle.filter((p: any) => !want || want.has(p.name)).map((p: any) => [p.name, p.value]));
      }
      case 'box': {
        const nodeId = await node();
        const r = await cdp('DOM.getBoxModel', { nodeId });
        const q = (quad: number[]) => ({ x: Math.round(quad[0]), y: Math.round(quad[1]), width: Math.round(quad[2] - quad[0]), height: Math.round(quad[5] - quad[1]) });
        return { width: r.model.width, height: r.model.height, content: q(r.model.content), padding: q(r.model.padding), border: q(r.model.border), margin: q(r.model.margin) };
      }
      case 'listeners': {
        const nodeId = await node();
        const { object } = await cdp('DOM.resolveNode', { nodeId });
        const r = await cdp('DOMDebugger.getEventListeners', { objectId: object.objectId, depth: a.depth ?? 1, pierce: true });
        return r.listeners.map((l: any) => ({ type: l.type, capture: l.useCapture, passive: l.passive, once: l.once, location: `${st?.scripts.get(l.scriptId)?.url ?? l.scriptId}:${l.lineNumber + 1}:${l.columnNumber + 1}`, handler: clip(l.handler?.description ?? '', 200) }));
      }
      case 'pseudo': {
        const nodeId = await node();
        await cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: a.states ?? [] });
        if (st && a.states?.length) st.cleanups.push(() => cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {}));
        return `Forced ${(a.states ?? []).map((s) => ':' + s).join(' ') || 'none'} on node ${nodeId}`;
      }
      case 'highlight': {
        const nodeId = await node();
        await cdp('Overlay.enable');
        await cdp('Overlay.highlightNode', { nodeId, highlightConfig: { showInfo: true, showStyles: true, contentColor: { r: 111, g: 168, b: 220, a: .66 }, paddingColor: { r: 147, g: 196, b: 125, a: .55 }, borderColor: { r: 255, g: 229, b: 153, a: .66 }, marginColor: { r: 246, g: 178, b: 107, a: .66 } } });
        st?.cleanups.push(() => cdp('Overlay.hideHighlight').catch(() => {}));
        return `Highlighted node ${nodeId} (hide with action:hide)`;
      }
      case 'hide': await cdp('Overlay.hideHighlight'); return 'Highlight hidden';
      case 'overlays': {
        await cdp('Overlay.enable');
        const s = a.show ?? {};
        if (s.layoutShiftRegions !== undefined) await cdp('Overlay.setShowLayoutShiftRegions', { result: s.layoutShiftRegions });
        if (s.paintRects !== undefined) await cdp('Overlay.setShowPaintRects', { result: s.paintRects });
        if (s.fps !== undefined) await cdp('Overlay.setShowFPSCounter', { show: s.fps });
        if (s.grid !== undefined || s.flex !== undefined) {
          const nodeId = a.ref || a.selector || a.nodeId ? await node() : undefined;
          if (nodeId) { if (s.grid !== undefined) await cdp('Overlay.setShowGridOverlays', { gridNodeHighlightConfigs: s.grid ? [{ nodeId, gridHighlightConfig: { showGridExtensionLines: true, showLineNumbers: true, gridBorderColor: { r: 255, g: 0, b: 255, a: .8 }, rowLineColor: { r: 255, g: 0, b: 255, a: .5 }, columnLineColor: { r: 255, g: 0, b: 255, a: .5 } } }] : [] }); if (s.flex !== undefined) await cdp('Overlay.setShowFlexOverlays', { flexNodeHighlightConfigs: s.flex ? [{ nodeId, flexContainerHighlightConfig: { containerBorder: { color: { r: 0, g: 150, b: 255, a: .8 }, pattern: 'dashed' } } }] : [] }); }
        }
        st?.cleanups.push(() => cdp('Overlay.disable').catch(() => {}));
        return `Overlays: ${JSON.stringify(s)}`;
      }
    }
    void page;
  });
}
