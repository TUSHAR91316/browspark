import type { TabInfo } from '../../shared/protocol.ts';
import type { PopupMsg, State } from './state.ts';

// ---------- helpers ----------
const ask = (m: PopupMsg) => chrome.runtime.sendMessage(m) as Promise<State>;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Props = Record<string, unknown>;
const h = (tag: string, attrs: Record<string, unknown> = {}, ...kids: (Node | string | null | undefined | false)[]) => {
  const e = document.createElement(tag);
  const props: Props = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k.startsWith('on') || (k in e && typeof v !== 'string')) { (e as any)[k] = v; props[k] = v; }
    else if (k === 'html') e.innerHTML = String(v);
    else e.setAttribute(k, String(v));
  }
  (e as any).__p = props;
  for (const k of kids) if (k) e.append(k);
  return e;
};

/** Patch `a` to look like `b`, keeping node identity where possible (no flicker, hover and scroll survive). */
function morph(a: Node, b: Node) {
  if (a.nodeType !== b.nodeType || (a as Element).tagName !== (b as Element).tagName) { a.parentNode!.replaceChild(b, a); return; }
  if (a.nodeType !== Node.ELEMENT_NODE) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  const ea = a as HTMLElement, eb = b as HTMLElement;
  for (const at of [...ea.attributes]) if (!eb.hasAttribute(at.name)) ea.removeAttribute(at.name);
  for (const at of [...eb.attributes]) if (ea.getAttribute(at.name) !== at.value) ea.setAttribute(at.name, at.value);
  const pa: Props = (ea as any).__p ?? {}, pb: Props = (eb as any).__p ?? {};
  const focused = document.activeElement === ea;
  for (const k in pb) { if (k === 'value' && focused) continue; if ((ea as any)[k] !== pb[k]) (ea as any)[k] = pb[k]; }
  for (const k in pa) if (!(k in pb)) (ea as any)[k] = typeof pa[k] === 'boolean' ? false : typeof pa[k] === 'function' ? null : '';
  (ea as any).__p = pb;
  if (ea.tagName === 'svg') { if (ea.innerHTML !== eb.innerHTML) ea.innerHTML = eb.innerHTML; return; }
  const next = [...eb.childNodes];
  const keyed = new Map<string, Node>();
  for (const n of ea.childNodes) { const k = (n as HTMLElement).dataset?.key; if (k) keyed.set(k, n); }
  next.forEach((nb, i) => {
    const key = (nb as HTMLElement).dataset?.key;
    let na: Node | undefined = key ? keyed.get(key) : ea.childNodes[i];
    if (na && na !== ea.childNodes[i]) ea.insertBefore(na, ea.childNodes[i] ?? null);
    if (!na) ea.insertBefore(nb, ea.childNodes[i] ?? null); else morph(na, nb);
  });
  while (ea.childNodes.length > next.length) ea.removeChild(ea.lastChild!);
}
const patch = (container: HTMLElement, ...kids: (Node | null | undefined | false)[]) => { const tmp = container.cloneNode(false) as HTMLElement; tmp.append(...kids.filter((k): k is Node => !!k)); morph(container, tmp); };
const I = {
  home: '<path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z"/>',
  tabs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  play: '<path d="m6 4 14 8-14 8z"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
};
const icon = (name: keyof typeof I) => h('span', { html: `<svg class="i" viewBox="0 0 24 24">${I[name]}</svg>` }).firstElementChild as SVGElement;
const host = (u: string) => { try { return new URL(u).host; } catch { return ''; } };
const initial = (t: TabInfo) => (host(t.url).replace(/^www\./, '') || t.title || '?')[0]?.toUpperCase() ?? '?';
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const ago = (t: number) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
const OWN = chrome.runtime.getURL('');
const isOwn = (t: TabInfo) => t.url.startsWith(OWN);

// ---------- state ----------
let state: State | undefined;
let route = location.hash.replace(/^#\/?/, '') || 'overview';
let editing = false;
const ui = { search: '', tabFilter: 'all' as 'all' | 'shared' | 'available', logFilter: 'all' as 'all' | 'errors', theme: 'system', toolSearch: '', toolFilter: 'all' as 'all' | 'on' | 'off', expanded: new Set<string>() };
try { ui.theme = localStorage.getItem('theme') || 'system'; } catch {}
applyTheme();

function applyTheme() {
  if (ui.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', ui.theme);
}

// ---------- shell ----------
const NAV: [string, string, string][] = [['overview', '🏠', 'Overview'], ['tabs', '🗂️', 'Tabs'], ['tools', '🧰', 'Tools'], ['activity', '📈', 'Activity'], ['settings', '⚙️', 'Settings']];
const EMOJI = Object.fromEntries(NAV.map(([r, e]) => [r, e]));
function renderShell(s: State) {
  $('ver').textContent = `v${s.extensionVersion} · extension mode`;
  patch($('nav'), ...NAV.filter(([r]) => r !== 'activity' || s.activityLog).map(([r, ic, label]) => {
    const n = r === 'tabs' ? s.tabs.filter((t) => t.shared).length : r === 'activity' ? s.totals.errors : r === 'tools' ? s.disabledTools.length : 0;
    return h('a', { href: `#/${r}`, class: route === r ? 'on' : '', 'data-key': r }, h('span', { class: 'emoji' }, ic), label, n ? h('span', { class: 'n' }, String(n)) : null);
  }));
  const [cls, l1, l2] = s.connected ? ['ok', `Connected${s.companionVersion ? ' · companion v' + s.companionVersion : ''}`, `127.0.0.1:${s.port} · ${ago(s.connectedAt!)}`] : s.stopped ? ['bad', 'Stopped', 'agent access paused'] : s.hasToken ? ['warn', 'Connecting…', `127.0.0.1:${s.port}`] : ['', 'Not paired', 'see Overview'];
  $('conn').className = `conn ${cls}`;
  patch($('conn'), h('span', { class: 'dot' }), h('div', {}, h('div', { class: 'l1' }, l1), h('div', { class: 'l2', ...(s.connected && { 'data-ago': String(s.connectedAt), 'data-ago-fmt': `127.0.0.1:${s.port} · {ago}` }) }, l2)));
  patch($('theme'), ...([['system', 'monitor'], ['light', 'sun'], ['dark', 'moon']] as [string, keyof typeof I][]).map(([t, ic]) =>
    h('button', { class: ui.theme === t ? 'on' : '', title: `${t[0].toUpperCase()}${t.slice(1)} theme`, role: 'radio', 'aria-checked': String(ui.theme === t), onclick: () => { ui.theme = t; try { localStorage.setItem('theme', t); } catch {} applyTheme(); repaint(); } }, icon(ic))));
}

// ---------- views ----------
const pageHeader = (title: string, sub: string, ...actions: (Node | null)[]) => h('div', { class: 'page-h' }, h('span', { class: 'icon emoji' }, EMOJI[route] ?? '📄'), h('h1', {}, title), h('p', {}, sub), actions.filter(Boolean).length ? h('div', { class: 'actions' }, ...actions) : null);
const stat = (k: string, v: string | number, extra?: string, cls = '', agoTs?: number) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: `v ${cls}` }, String(v), extra ? h('small', agoTs ? { 'data-ago': String(agoTs), 'data-ago-fmt': '{ago}' } : {}, extra) : null));
const empty = (ic: keyof typeof I, title: string, sub?: string, action?: Node) => h('div', { class: 'empty' }, icon(ic), h('b', {}, title), sub ? h('span', {}, sub) : null, action ?? null);
const stopResume = (s: State) => s.stopped
  ? h('button', { class: 'btn primary', onclick: () => ask({ type: 'connect' }).then(paint) }, icon('play'), 'Resume access')
  : h('button', { class: 'btn danger', disabled: !s.connected && !s.hasToken, onclick: () => ask({ type: 'stop' }).then(paint), title: 'Detach from every tab and disconnect' }, icon('stop'), 'Stop');

function copyBtn(text: string) {
  return h('button', { class: 'btn sm icon ghost', title: 'Copy', onclick: async (e: Event) => { const b = e.currentTarget as HTMLElement; await navigator.clipboard.writeText(text); b.replaceChildren(icon('check')); setTimeout(() => b.replaceChildren(icon('copy')), 1200); } }, icon('copy'));
}
const inputValue = (id: string) => $<HTMLInputElement>(id)?.value ?? '';
const checked = (e: Event) => (e.currentTarget as HTMLInputElement).checked;

function pairForm(s: State) {
  const token = h('input', { id: 'token', class: 'mono', placeholder: 'paste token', spellcheck: false, autocomplete: 'off' }) as HTMLInputElement;
  const port = h('input', { id: 'port', type: 'number', value: String(s.port), class: 'mono' }) as HTMLInputElement;
  const submit = () => { editing = false; ask({ type: 'setConfig', token: inputValue('token').trim(), port: Number(inputValue('port')) || 9223 }).then(paint); }; // empty token keeps the stored one
  token.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  return h('div', { class: 'row' },
    h('label', { class: 'field', style: 'flex:1;max-width:320px' }, h('span', {}, 'token'), token),
    h('label', { class: 'field', style: 'width:130px' }, h('span', {}, 'port'), port),
    h('button', { class: 'btn primary', onclick: submit }, s.connected ? 'Reconnect' : 'Connect'),
    editing ? h('button', { class: 'btn ghost', onclick: () => { editing = false; repaint(); } }, 'Cancel') : null);
}

const CMD = 'claude mcp add browsermcp -- bun /path/to/browsermcp/companion/src/index.ts';
function viewOverview(s: State) {
  const shared = s.tabs.filter((t) => t.shared);
  const paired = s.hasToken && !editing;
  const step = !paired ? 2 : shared.length || s.shareAll ? 4 : 3;
  const companionOk = s.connected; // only verifiable once the bridge answers
  const onboarding = h('div', { class: 'card' },
    h('div', { class: 'card-h' }, h('h2', {}, 'Get started'), h('span', { class: 'sub' }, 'Three steps to let an agent drive your tabs')),
    h('div', { class: 'card-b steps' },
      h('div', { class: `step ${companionOk ? 'done' : step === 2 ? 'now' : ''}` }, h('div', { class: 'num' }, companionOk ? icon('check') : '1'), h('div', {},
        h('h3', {}, 'Run the companion'),
        h('p', {}, 'Register it with your MCP client. It starts the local bridge on ', h('code', {}, `127.0.0.1:${s.port}`), '.'),
        h('div', { class: 'cmd' }, h('code', { title: CMD }, CMD), copyBtn(CMD)))),
      h('div', { class: `step ${step > 2 ? 'done' : step === 2 ? 'now' : ''}` }, h('div', { class: 'num' }, step > 2 ? icon('check') : '2'), h('div', {},
        h('h3', {}, 'Pair this extension'),
        h('p', {}, 'Ask the agent to call ', h('code', {}, 'browser_status'), '. It prints a one-time pairing token.'),
        paired ? h('div', { class: 'row' }, h('span', { class: 'pill ok' }, icon('check'), 'Paired'), h('span', { class: 'mono', style: 'color:var(--fg-3)' }, `127.0.0.1:${s.port}`), h('button', { class: 'btn sm ghost', onclick: () => { editing = true; repaint(); $('token')?.focus(); } }, 'Change')) : pairForm(s),
        s.lastError && !s.connected ? h('div', { class: 'notice bad', style: 'margin-top:10px' }, icon('alert'), s.lastError) : null)),
      h('div', { class: `step ${step > 3 ? 'done' : step === 3 ? 'now' : ''}` }, h('div', { class: 'num' }, step > 3 ? icon('check') : '3'), h('div', {},
        h('h3', {}, 'Share tabs'),
        h('p', {}, 'Only tabs you switch on can be seen or driven. Revoke any time.'),
        h('a', { href: '#/tabs', class: 'btn' }, icon('tabs'), s.shareAll ? 'Sharing everything · manage' : shared.length ? `${shared.length} shared · manage` : 'Choose tabs')))));

  const recent = s.recent.slice(0, 8);
  return h('div', { class: 'page' },
    pageHeader('Overview', s.connected ? 'The companion is connected. Shared tabs are ready for the agent.' : 'Pair the companion and choose which tabs the agent may drive.', stopResume(s)),
    s.stopped ? h('div', { class: 'notice warn', style: 'margin-bottom:16px' }, icon('alert'), 'Access is stopped. The agent cannot reach any tab until you resume.', h('button', { class: 'btn sm', onclick: () => ask({ type: 'connect' }).then(paint) }, 'Resume')) : null,
    h('div', { class: 'grid c4', style: 'margin-bottom:16px' },
      stat('Connection', s.connected ? 'Live' : s.stopped ? 'Stopped' : s.hasToken ? 'Connecting' : 'Unpaired', s.connected ? ago(s.connectedAt!) : undefined, s.connected ? 'ok' : s.stopped ? 'bad' : '', s.connected ? s.connectedAt : undefined),
      stat('Shared tabs', s.shareAll ? 'All' : shared.length, s.shareAll ? 'incl. new tabs' : `of ${s.tabs.filter((t) => !t.unsupported).length}`),
      stat('Operations', s.totals.ops, 'this session'),
      stat('Errors', s.totals.errors, undefined, s.totals.errors ? 'bad' : '')),
    h('div', { class: 'grid c2' },
      onboarding,
      h('div', { class: 'card' },
        h('div', { class: 'card-h' }, h('h2', {}, 'Recent activity'), h('div', { class: 'right' }, s.activityLog ? h('a', { href: '#/activity', class: 'btn sm ghost' }, 'View all') : null)),
        !s.activityLog ? empty('activity', 'Activity log is off', 'Nothing is recorded. Turn it on in Settings to see what the agent does.', h('a', { href: '#/settings', class: 'btn sm', style: 'margin-top:8px' }, 'Open Settings'))
        : recent.length ? h('table', { class: 'table' }, h('tbody', {}, ...recent.map((r) => h('tr', {},
          h('td', { class: 'mono muted', style: 'width:1%' }, time(r.at)),
          h('td', { class: 'trunc' }, h('span', { class: `st ${r.ok ? '' : 'bad'}` }), h('span', { class: 'mono' }, r.method)),
          h('td', { class: 'muted trunc', style: 'width:30%' }, r.tabLabel)))))
          : empty('inbox', 'Nothing yet', s.connected ? 'Operations the agent performs show up here.' : 'Connect the companion to see activity.'))));
}

function viewTabs(s: State) {
  const q = ui.search.trim().toLowerCase();
  const all = s.tabs.filter((t) => !isOwn(t));
  const list = all.filter((t) => (ui.tabFilter === 'all' || (ui.tabFilter === 'shared' ? t.shared : !t.unsupported)) && (!q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)));
  const shareable = list.filter((t) => !t.unsupported);
  const windows = s.windows.map((w, i) => ({ ...w, label: `Window ${i + 1}${w.focused ? ' · current' : ''}${w.incognito ? ' · incognito' : ''}` }));
  const groups = windows.map((w) => ({ w, tabs: list.filter((t) => t.windowId === w.id) })).filter((g) => g.tabs.length);
  const search = h('input', { id: 'search', placeholder: 'Search tabs by title or URL…  /', value: ui.search, oninput: (e: Event) => { ui.search = (e.target as HTMLInputElement).value; repaint(); } });
  const seg = (v: typeof ui.tabFilter, label: string) => h('button', { class: ui.tabFilter === v ? 'on' : '', onclick: () => { ui.tabFilter = v; repaint(); } }, label);
  const setMany = (ids: number[], shared: boolean) => ids.length && ask({ type: 'setShared', tabIds: ids, shared }).then(paint);

  const row = (t: TabInfo) => {
    const cb = h('input', { type: 'checkbox', checked: t.shared, disabled: !!t.unsupported || s.shareAll, title: t.unsupported ? `Chrome does not allow automation on ${t.unsupported}s` : s.shareAll ? 'Shared because "Share everything" is on' : t.shared ? 'Stop sharing' : 'Share with agent', onchange: (e: Event) => ask({ type: 'setShared', tabIds: [t.id], shared: checked(e) }).then(paint) }) as HTMLInputElement;
    const fav = h('div', { class: 'fav' });
    if (t.favIconUrl) { const img = h('img', { src: t.favIconUrl, alt: '' }) as HTMLImageElement; img.onerror = () => fav.replaceChildren(initial(t)); fav.append(img); } else fav.textContent = initial(t);
    return h('div', { class: `tab ${t.unsupported ? 'off' : ''}`, 'data-key': String(t.id) },
      fav,
      h('div', {}, h('div', { class: 't' }, h('button', { onclick: () => ask({ type: 'focusTab', tabId: t.id }), title: 'Switch to this tab' }, t.title || host(t.url) || 'Loading…')), h('div', { class: 'u' }, t.url || '')),
      h('div', { class: 'badges' },
        t.agent ? h('span', { class: 'pill accent' }, 'agent') : null,
        s.shareAll && !t.unsupported ? h('span', { class: 'pill accent' }, 'all') : t.active ? h('span', { class: 'pill' }, 'active') : null,
        t.attached ? h('span', { class: 'pill ok', title: 'The debugger is attached: Chrome shows its "started debugging" bar. It detaches after 30s of inactivity unless an inspection session is running.' }, 'debugging') : null,
        t.unsupported ? h('span', { class: 'pill' }, t.unsupported) : null),
      h('label', { class: 'switch' }, cb));
  };

  const allCb = h('input', { type: 'checkbox', checked: s.shareAll, onchange: (e: Event) => ask({ type: 'setShareAll', on: checked(e) }).then(paint) }) as HTMLInputElement;
  return h('div', { class: 'page' },
    pageHeader('Tabs', 'Switch on the tabs the agent may see and control. Tabs the agent opens itself appear here in your current window and are shared automatically.',
      h('button', { class: 'btn', disabled: s.shareAll || !shareable.some((t) => !t.shared), onclick: () => setMany(shareable.filter((t) => !t.shared).map((t) => t.id), true) }, `Share ${q || ui.tabFilter !== 'all' ? 'matching' : 'listed'}`),
      h('button', { class: 'btn', disabled: s.shareAll || !list.some((t) => t.shared), onclick: () => setMany(list.filter((t) => t.shared).map((t) => t.id), false) }, 'Unshare'),
      stopResume(s)),
    h('div', { class: `callout`, style: 'margin-bottom:12px' },
      h('span', { class: 'emoji' }, s.shareAll ? '🌐' : '🔒'),
      h('div', { class: 'body' }, h('b', {}, 'Share everything'), h('div', { class: 'muted' }, s.shareAll ? 'Every window and tab is shared, including tabs opened from now on. Per-tab switches are locked while this is on.' : 'Give the agent every window and tab, including ones you open later. Handy for long sessions; turn off to go back to picking tabs.')),
      h('label', { class: 'switch ctl' }, allCb)),
    h('div', { class: 'card' },
      h('div', { class: 'toolbar' },
        h('label', { class: 'field' }, icon('search'), search),
        h('div', { class: 'seg' }, seg('all', `All ${all.length}`), seg('available', 'Available'), seg('shared', `Shared ${all.filter((t) => t.shared).length}`)),
        h('div', { class: 'right' }, h('span', { class: 'sub', style: 'color:var(--fg-3);font-size:12.5px' }, `${list.length} shown`))),
      groups.length ? h('div', {}, ...groups.flatMap((g) => [h('div', { class: 'group' }, icon('globe'), g.w.label, h('span', { style: 'font-weight:500;text-transform:none;letter-spacing:0' }, `· ${g.tabs.length}`)), ...g.tabs.map(row)]))
        : empty('search', 'No tabs match', q ? `Nothing for “${ui.search}”.` : 'Open a page in Chrome and it will appear here.')));
}

const TOOL_GROUPS: [RegExp, string][] = [
  [/^browser_/, 'Browser automation'], [/^devtools_(session|events|capabilities|cdp)$/, 'Sessions & protocol'], [/^devtools_(console|evaluate)$/, 'Console'], [/^devtools_network$/, 'Network'],
  [/^devtools_(sources|debugger)$/, 'Sources & debugger'], [/^devtools_elements$/, 'Elements'], [/^devtools_(performance|profile|memory|coverage)$/, 'Performance & memory'],
  [/^devtools_(storage|workers)$/, 'Application'], [/^devtools_(emulation|accessibility|security)$/, 'Emulation & audits'], [/^devtools_lighthouse$/, 'Lighthouse'], [/^devtools_recorder$/, 'Recorder'],
];
const groupOf = (name: string) => TOOL_GROUPS.find(([re]) => re.test(name))?.[1] ?? 'Other';

function viewTools(s: State) {
  const off = new Set(s.disabledTools);
  const q = ui.toolSearch.trim().toLowerCase();
  const all = s.toolCatalog;
  const list = all.filter((t) => (ui.toolFilter === 'all' || (ui.toolFilter === 'on' ? !off.has(t.name) : off.has(t.name))) && (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)));
  const groups = [...new Set(list.map((t) => groupOf(t.name)))].map((g) => ({ g, tools: list.filter((t) => groupOf(t.name) === g) }));
  const setMany = (names: string[], enabled: boolean) => names.length && ask({ type: 'setToolsEnabled', names, enabled }).then(paint);
  const seg = (v: typeof ui.toolFilter, label: string) => h('button', { class: ui.toolFilter === v ? 'on' : '', onclick: () => { ui.toolFilter = v; repaint(); } }, label);
  const row = (t: { name: string; description: string }) => {
    const open = ui.expanded.has(t.name);
    return h('div', { class: `tab tool ${off.has(t.name) ? 'off' : ''}`, 'data-key': t.name },
      h('div', { class: 'fav', title: groupOf(t.name) }, t.name.startsWith('browser_') ? '🖱️' : '🛠️'),
      h('div', {}, h('div', { class: 't' }, h('code', {}, t.name)), h('div', { class: `desc ${open ? 'open' : ''}`, onclick: () => { open ? ui.expanded.delete(t.name) : ui.expanded.add(t.name); repaint(); }, title: open ? 'Click to collapse' : 'Click to expand' }, t.description)),
      h('div', { class: 'badges' }, off.has(t.name) ? h('span', { class: 'pill bad' }, 'off') : null),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !off.has(t.name), onchange: (e: Event) => ask({ type: 'setToolEnabled', name: t.name, enabled: checked(e) }).then(paint) })));
  };
  return h('div', { class: 'page' },
    pageHeader('Tools', 'Everything the agent can call, with what each tool does. Switch a tool off and the agent is told to ask you before it can use it.',
      h('button', { class: 'btn', disabled: !list.some((t) => off.has(t.name)), onclick: () => setMany(list.filter((t) => off.has(t.name)).map((t) => t.name), true) }, `Enable ${q || ui.toolFilter !== 'all' ? 'matching' : 'all'}`),
      h('button', { class: 'btn', disabled: !list.some((t) => !off.has(t.name)), onclick: () => setMany(list.filter((t) => !off.has(t.name)).map((t) => t.name), false) }, `Disable ${q || ui.toolFilter !== 'all' ? 'matching' : 'all'}`)),
    h('div', { class: 'card' },
      h('div', { class: 'toolbar' },
        h('label', { class: 'field' }, icon('search'), h('input', { id: 'toolsearch', placeholder: 'Search tools…', value: ui.toolSearch, oninput: (e: Event) => { ui.toolSearch = (e.target as HTMLInputElement).value; repaint(); } })),
        h('div', { class: 'seg' }, seg('all', `All ${all.length}`), seg('on', `On ${all.length - off.size}`), seg('off', `Off ${off.size}`)),
        h('div', { class: 'right' }, h('span', { style: 'color:var(--fg-3);font-size:12.5px' }, `${list.length} shown`))),
      !all.length ? empty('inbox', 'No tool list yet', !s.connected ? 'Connect the companion to load the list of tools.' : 'The connected companion is an older build that does not send its tool list. Restart the MCP server in your agent client (new session, or reconnect the MCP) so the companion restarts on the current code.')
        : groups.length ? h('div', {}, ...groups.flatMap(({ g, tools }) => [h('div', { class: 'group' }, g, h('span', { style: 'font-weight:500;text-transform:none;letter-spacing:0' }, `· ${tools.length}`)), ...tools.map(row)]))
        : empty('search', 'No tools match', `Nothing for “${ui.toolSearch}”.`)));
}

function viewActivity(s: State) {
  if (!s.activityLog) return h('div', { class: 'page' }, pageHeader('Activity', 'Every protocol command the agent has sent to your shared tabs this session.'),
    h('div', { class: 'card' }, empty('activity', 'Activity log is off', 'Nothing is being recorded. Enable it in Settings to see commands, latency, and errors here.', h('button', { class: 'btn primary sm', style: 'margin-top:8px', onclick: () => ask({ type: 'setActivityLog', on: true }).then(paint) }, 'Enable activity log'))));
  const list = ui.logFilter === 'errors' ? s.recent.filter((r) => !r.ok) : s.recent;
  const seg = (v: typeof ui.logFilter, label: string) => h('button', { class: ui.logFilter === v ? 'on' : '', onclick: () => { ui.logFilter = v; repaint(); } }, label);
  return h('div', { class: 'page' },
    pageHeader('Activity', 'Every protocol command the agent has sent to your shared tabs this session.',
      h('button', { class: 'btn ghost', disabled: !s.recent.length, onclick: () => ask({ type: 'clearLog' }).then(paint) }, icon('trash'), 'Clear')),
    h('div', { class: 'grid c4', style: 'margin-bottom:16px' },
      stat('Operations', s.totals.ops), stat('Errors', s.totals.errors, undefined, s.totals.errors ? 'bad' : ''),
      stat('Shown', list.length, 'of last 200'), stat('Avg latency', s.recent.length ? Math.round(s.recent.reduce((a, r) => a + r.ms, 0) / s.recent.length) : 0, 'ms')),
    h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('div', { class: 'seg' }, seg('all', 'All'), seg('errors', `Errors ${s.totals.errors ? '· ' + s.recent.filter((r) => !r.ok).length : ''}`))),
      list.length ? h('div', { style: 'overflow:auto' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', { style: 'width:1%' }, 'Time'), h('th', {}, 'Command'), h('th', {}, 'Tab'), h('th', { class: 'r', style: 'width:1%' }, 'Latency'), h('th', {}, 'Result'))),
        h('tbody', {}, ...list.map((r) => h('tr', { 'data-key': String(r.id) },
          h('td', { class: 'mono muted' }, time(r.at)),
          h('td', { class: 'mono' }, h('span', { class: `st ${r.ok ? '' : 'bad'}` }), r.method),
          h('td', { class: 'muted trunc', style: 'width:22%' }, r.tabLabel),
          h('td', { class: 'mono muted r' }, `${r.ms} ms`),
          h('td', { class: `trunc ${r.ok ? 'muted' : 'err-text'}`, title: r.error ?? '' }, r.ok ? 'ok' : r.error ?? 'failed'))))))
        : empty('activity', ui.logFilter === 'errors' ? 'No errors' : 'No activity yet', ui.logFilter === 'errors' ? 'Every command has succeeded so far.' : 'Commands appear here as the agent works.')));
}

function viewSettings(s: State) {
  const token = h('input', { id: 'token', class: 'mono', placeholder: s.hasToken ? '•••••••• (set)' : 'paste token', spellcheck: false }) as HTMLInputElement;
  const port = h('input', { id: 'port', type: 'number', value: String(s.port), class: 'mono' }) as HTMLInputElement;
  const save = () => { ask({ type: 'setConfig', token: inputValue('token').trim(), port: Number(inputValue('port')) || 9223 }).then(paint); }; // empty token keeps the stored one
  return h('div', { class: 'page' },
    pageHeader('Settings', 'Pairing, connection, and emergency controls.'),
    h('div', { class: 'card', style: 'margin-bottom:16px' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Companion')),
      h('div', { class: 'setting' }, h('div', {}, h('h3', {}, 'Pairing token'), h('p', {}, 'Printed by ', h('code', {}, 'browser_status'), '. Stored only in this browser profile.')), h('div', { class: 'ctl' }, h('label', { class: 'field' }, token))),
      h('div', { class: 'setting' }, h('div', {}, h('h3', {}, 'Bridge port'), h('p', {}, 'Where the companion listens on localhost. Change it if you run the companion with ', h('code', {}, '--port'), '.')), h('div', { class: 'ctl' }, h('label', { class: 'field narrow' }, port))),
      h('div', { class: 'setting' }, h('div', {}, h('h3', {}, 'Connection'), h('p', s.connected ? { 'data-ago': String(s.connectedAt), 'data-ago-fmt': 'Connected for {ago}.' } : {}, s.connected ? `Connected for ${ago(s.connectedAt!)}.` : s.lastError ?? 'Not connected.')), h('div', { class: 'ctl' }, h('button', { class: 'btn ghost', onclick: () => ask({ type: 'connect' }).then(paint) }, icon('refresh'), 'Reconnect'), h('button', { class: 'btn primary', onclick: save }, 'Save')))),
    h('div', { class: 'card', style: 'margin-bottom:16px' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Developer browser')),
      h('div', { class: 'setting' }, h('div', {}, h('h3', {}, 'When the agent may open a separate Chrome'), h('p', {}, 'Everyday work happens in your tabs. A developer-mode Chrome is only needed for things Chrome blocks for extensions: heap snapshots, Lighthouse, raw protocol commands.')),
        h('div', { class: 'ctl' }, h('div', { class: 'seg', style: 'display:flex;gap:2px;background:var(--callout);border-radius:6px;padding:2px' }, ...([['auto', 'Only when needed'], ['always', 'Always'], ['never', 'Never']] as const).map(([v, label]) =>
          h('button', { class: 'btn sm ghost', style: s.devMode === v ? 'background:var(--bg);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.12)' : '', onclick: () => ask({ type: 'setDevMode', mode: v }).then(paint) }, label)))))),
    h('div', { class: 'card', style: 'margin-bottom:16px' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Privacy')),
      h('div', { class: 'setting' }, h('div', {}, h('h3', {}, 'Activity log'), h('p', {}, s.activityLog ? 'Recording every command the agent sends (last 200, in memory only). The Activity page is visible.' : 'Off. No per-command records are kept and the Activity page is hidden. Counters on the Overview still work.')), h('div', { class: 'ctl' }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: s.activityLog, onchange: (e: Event) => ask({ type: 'setActivityLog', on: checked(e) }).then(paint) }))))),
    h('div', { class: 'card danger-card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Emergency stop')),
      h('div', { class: 'setting' }, h('div', {}, h('h3', {}, s.stopped ? 'Access is stopped' : 'Stop all agent access'), h('p', {}, 'Detaches the debugger from every tab, clears the shared list, and disconnects. Nothing is retried on resume.')), h('div', { class: 'ctl' }, stopResume(s)))),
    h('p', { style: 'color:var(--fg-3);font-size:12px;margin-top:24px' }, `BrowserMCP extension v${s.extensionVersion} · Chrome restricts automation on browser-internal pages and the Web Store.`));
}

// ---------- paint loop ----------
const VIEWS: Record<string, (s: State) => HTMLElement> = { overview: viewOverview, tabs: viewTabs, tools: viewTools, activity: viewActivity, settings: viewSettings };
let lastKey = '', lastRoute = '';
/** Everything that should trigger a re-render; timers are updated in place by tick(). */
const fingerprint = (s: State) => JSON.stringify(s, (k, v) => (k === 'connectedAt' ? undefined : v));
/** Refresh relative times without rebuilding the DOM. */
function tick() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-ago]')) el.textContent = el.dataset.agoFmt!.replace('{ago}', ago(Number(el.dataset.ago)));
}
/** Older workers (before an extension reload) omit newer fields; never let that blank the page. */
function normalize(s: Partial<State> | undefined): State {
  const x = (s ?? {}) as Partial<State>;
  const defaults: State = { connected: false, stopped: false, shareAll: false, activityLog: false, port: 9223, hasToken: false, extensionVersion: '?', windows: [], tabs: [], recent: [], totals: { ops: 0, errors: 0 }, toolCatalog: [], disabledTools: [], devMode: 'auto' };
  const out: State = { ...defaults, ...x } as State;
  for (const k of ['windows', 'tabs', 'recent', 'toolCatalog', 'disabledTools'] as const) if (!Array.isArray(out[k])) (out as any)[k] = [];
  if (!out.totals) out.totals = { ops: 0, errors: 0 };
  return out;
}
let rawState: Partial<State> | undefined;
function paint(raw: State) {
  rawState = raw;
  const s = normalize(raw);
  state = s;
  try { paintInner(s); }
  catch (e) {
    // a rendering bug must never leave a blank page
    $('main').replaceChildren(h('div', { class: 'notice bad', style: 'margin:16px' }, icon('alert'), h('span', {}, `The dashboard failed to render: ${(e as Error).message}. Try reloading the extension at chrome://extensions and reopening this page.`), h('button', { class: 'btn sm', onclick: () => chrome.runtime.reload() }, 'Reload extension')));
  }
}
function paintInner(s: State) {
  const key = fingerprint(s);
  if (key === lastKey && route === lastRoute) { tick(); return; }
  lastKey = key;
  const main = $('main');
  const sameRoute = route === lastRoute;
  lastRoute = route;
  // preserve focus and caret across re-renders
  const a = document.activeElement as HTMLInputElement | null;
  const keep = a && a.id && 'selectionStart' in a ? { id: a.id, value: a.value, s: a.selectionStart, e: a.selectionEnd } : null;
  renderShell(s);
  document.title = `${NAV.find((n) => n[0] === route)?.[2] ?? 'BrowserMCP'} · BrowserMCP`;
  // The worker only picks up new code when the extension is reloaded; this page reloads on its own. Detect the mismatch.
  const onDisk = chrome.runtime.getManifest().version;
  const stale = !rawState || rawState.disabledTools === undefined || rawState.shareAll === undefined || s.extensionVersion !== onDisk;
  const view = (VIEWS[route] ?? viewOverview)(s);
  if (!sameRoute) view.classList.add('enter');
  const banner = stale ? h('div', { class: 'notice warn', style: 'margin:16px 16px 0' }, icon('alert'), h('span', {}, `The extension was updated on disk (worker v${s.extensionVersion ?? '?'}, files v${onDisk}). Reload it to pick up the new background code, then reopen this page.`), h('button', { class: 'btn sm', onclick: () => chrome.runtime.reload() }, icon('refresh'), 'Reload extension')) : null;
  if (sameRoute) patch(main, banner, view); else { main.replaceChildren(...[banner, view].filter((x): x is HTMLElement => !!x)); main.scrollTop = 0; }
  if (keep) { const el = $<HTMLInputElement>(keep.id); if (el) { el.value = keep.value; el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch {} } }
}
/** Force a rebuild (route change, local UI state change) even when worker state is unchanged. */
const repaint = () => { lastKey = ''; if (state) paint(state); };
const typing = () => { const a = document.activeElement as HTMLElement | null; return !!a && (a.tagName === 'INPUT') && a.id !== 'search' && a.id !== 'toolsearch'; };
window.addEventListener('hashchange', () => { route = location.hash.replace(/^#\/?/, '') || 'overview'; editing = false; repaint(); });
document.addEventListener('keydown', (e) => { if (e.key === '/' && !(e.target as HTMLElement).matches('input')) { const s = $('search') ?? $('toolsearch'); if (s) { e.preventDefault(); s.focus(); } } });
ask({ type: 'getState' }).then(paint);
setInterval(() => { if (!typing()) ask({ type: 'getState' }).then(paint); }, 1000);
