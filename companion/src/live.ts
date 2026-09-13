// Live view: stream a tab's screencast to a browser page served by the companion, with click-through input.
// Useful for headless developer browsers; works for any tab the agent can drive.
import type { WebSocket } from 'ws';
import type { Sessions } from './session.ts';
import type { Bridge } from './bridge.ts';

const MODS: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

export function installLiveView(bridge: Bridge, sessions: Sessions) {
  const viewers = new Map<number, Set<WebSocket>>();
  const stop = (tabId: number) => sessions.cdp(tabId, 'Page.stopScreencast').catch(() => {});

  sessions.on('cdp.event', async ({ tabId, method, params }) => {
    if (method !== 'Page.screencastFrame') return;
    const set = viewers.get(tabId);
    if (set?.size) { const msg = JSON.stringify({ type: 'frame', data: params.data, meta: params.metadata }); for (const ws of set) if (ws.readyState === 1) ws.send(msg); }
    await sessions.cdp(tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  });

  bridge.viewerHandler = async (ws, tabId) => {
    try { await sessions.resolve(tabId); } catch (e) { ws.send(JSON.stringify({ type: 'error', message: (e as Error).message })); ws.close(); return; }
    const set = viewers.get(tabId) ?? new Set(); viewers.set(tabId, set); set.add(ws);
    if (set.size === 1) await sessions.cdp(tabId, 'Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 }).catch((e) => ws.send(JSON.stringify({ type: 'error', message: `screencast unavailable: ${e.message}` })));
    ws.send(JSON.stringify({ type: 'hello', tabId }));
    ws.on('message', async (raw) => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      const modifiers = (m.modifiers ?? []).reduce((a: number, k: string) => a | (MODS[k] ?? 0), 0);
      try {
        if (m.type === 'mouse') {
          const x = Math.round(m.x * m.width), y = Math.round(m.y * m.height); // normalized -> CSS px of the viewport
          if (m.kind === 'wheel') await sessions.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: m.deltaX ?? 0, deltaY: m.deltaY ?? 0, modifiers });
          else await sessions.cdp(tabId, 'Input.dispatchMouseEvent', { type: m.kind === 'down' ? 'mousePressed' : m.kind === 'up' ? 'mouseReleased' : 'mouseMoved', x, y, button: m.button ?? 'none', clickCount: m.clickCount ?? 0, modifiers });
        } else if (m.type === 'key') {
          const text = m.text && !(modifiers & ~8) ? m.text : undefined;
          await sessions.cdp(tabId, 'Input.dispatchKeyEvent', { type: m.kind === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown', key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, nativeVirtualKeyCode: m.keyCode, text, unmodifiedText: text, modifiers });
        }
      } catch (e) { ws.send(JSON.stringify({ type: 'error', message: (e as Error).message })); }
    });
    ws.on('close', () => { set.delete(ws); if (!set.size) { viewers.delete(tabId); stop(tabId); } });
  };
}

export const LIVE_HTML = (tabId: number) => `<!doctype html><meta charset="utf-8"><title>Live view · tab ${tabId}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #191919; color: #d4d4d4; font: 13px ui-sans-serif, -apple-system, "Segoe UI", sans-serif; display: grid; grid-template-rows: auto 1fr; height: 100vh; }
  header { display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: #202020; border-bottom: 1px solid #2f2f2f; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6e6e6e; } .dot.on { background: #4dab9a; }
  .muted { color: #9b9b9b; } .grow { flex: 1; }
  kbd { font-family: ui-monospace, Menlo, monospace; font-size: 11px; border: 1px solid #383840; border-radius: 4px; padding: 0 4px; }
  main { display: grid; place-items: center; overflow: auto; padding: 16px; }
  img { max-width: 100%; max-height: 100%; background: #fff; box-shadow: 0 8px 30px rgba(0,0,0,.5); border-radius: 4px; outline: none; cursor: default; }
  img:focus { box-shadow: 0 0 0 2px #529cca, 0 8px 30px rgba(0,0,0,.5); }
</style>
<header><span class="dot" id="dot"></span><b>Browspark live view</b><span class="muted">tab ${tabId}</span><span class="grow"></span><span class="muted" id="status">connecting…</span><span class="muted">click the page to type · <kbd>Esc</kbd> releases</span></header>
<main><img id="v" tabindex="0" alt="live view"></main>
<script>
  const img = document.getElementById('v'), status = document.getElementById('status'), dot = document.getElementById('dot');
  let meta = { deviceWidth: 1, deviceHeight: 1 }, frames = 0;
  const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/live-ws?tab=${tabId}');
  ws.onopen = () => { dot.className = 'dot on'; status.textContent = 'connected'; };
  ws.onclose = () => { dot.className = 'dot'; status.textContent = 'disconnected'; };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'frame') { img.src = 'data:image/jpeg;base64,' + m.data; meta = m.meta; if (++frames % 10 === 1) status.textContent = m.meta.deviceWidth + '×' + m.meta.deviceHeight + ' · ' + frames + ' frames'; } else if (m.type === 'error') status.textContent = m.message; };
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const mods = (e) => [e.altKey && 'alt', e.ctrlKey && 'ctrl', e.metaKey && 'meta', e.shiftKey && 'shift'].filter(Boolean);
  const pos = (e) => { const r = img.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, width: meta.deviceWidth, height: meta.deviceHeight }; };
  const btn = (e) => ['left', 'middle', 'right'][e.button] || 'left';
  img.addEventListener('mousemove', (e) => send({ type: 'mouse', kind: 'move', ...pos(e), modifiers: mods(e) }));
  img.addEventListener('mousedown', (e) => { img.focus(); send({ type: 'mouse', kind: 'down', button: btn(e), clickCount: e.detail || 1, ...pos(e), modifiers: mods(e) }); e.preventDefault(); });
  img.addEventListener('mouseup', (e) => send({ type: 'mouse', kind: 'up', button: btn(e), clickCount: e.detail || 1, ...pos(e), modifiers: mods(e) }));
  img.addEventListener('contextmenu', (e) => e.preventDefault());
  img.addEventListener('wheel', (e) => { send({ type: 'mouse', kind: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY, ...pos(e), modifiers: mods(e) }); e.preventDefault(); }, { passive: false });
  const key = (kind) => (e) => { if (e.key === 'Escape' && kind === 'down') { img.blur(); return; } send({ type: 'key', kind, key: e.key, code: e.code, keyCode: e.keyCode, text: e.key.length === 1 ? e.key : (e.key === 'Enter' ? '\\r' : undefined), modifiers: mods(e) }); e.preventDefault(); };
  img.addEventListener('keydown', key('down')); img.addEventListener('keyup', key('up'));
</script>`;
