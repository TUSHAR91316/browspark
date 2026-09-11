// Wire protocol between the companion (Node) and the extension, over a local WebSocket.
// Requests flow companion -> extension. Events flow extension -> companion.

export const DEFAULT_PORT = 9223;
export const PROTOCOL_VERSION = 1;

export interface Req { id: number; method: ReqMethod; params?: unknown }
export interface Res { id: number; result?: unknown; error?: string }
export interface Evt { event: EvtName; params?: unknown }
export type Msg = Req | Res | Evt;

export type ReqMethod = 'tabs.list' | 'tabs.create' | 'tabs.close' | 'tabs.activate' | 'tabs.hold' | 'window.size' | 'downloads.list' | 'tools.catalog' | 'cdp';
export type EvtName = 'hello' | 'tabs' | 'cdp.event' | 'detached' | 'ping' | 'tools.policy';

export interface ToolInfo { name: string; description: string }
/** Extension -> companion: tools the user switched off in the dashboard. */
export type DevModePolicy = 'auto' | 'always' | 'never';
export interface ToolPolicy { disabled: string[]; /** Extension already holds a catalog from this companion version. */ haveCatalog?: boolean; /** auto: developer browser only when a capability needed it; always: whenever the agent asks; never. */ devMode?: DevModePolicy }

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  shared: boolean;
  attached: boolean;
  windowId: number;
  active: boolean;
  /** Opened by the agent (lives in the agent window). */
  agent?: boolean;
  favIconUrl?: string;
  /** Set when chrome.debugger cannot attach (chrome://, web store, etc.). */
  unsupported?: string;
}

export interface HelloParams { token: string; version: number; extensionVersion: string; browser?: string; userAgent?: string }
export interface CdpParams { tabId: number; method: string; params?: unknown; sessionId?: string; /** Name of the agent issuing the command. */ client?: string }
export interface CdpEventParams { tabId: number; method: string; params: unknown; sessionId?: string }
export interface DetachedParams { tabId: number; reason: string }

export const isReq = (m: Msg): m is Req => 'method' in m && 'id' in m;
export const isRes = (m: Msg): m is Res => 'id' in m && !('method' in m);
export const isEvt = (m: Msg): m is Evt => 'event' in m;

/** Pages chrome.debugger refuses to attach to. */
export function unsupportedReason(url: string): string | undefined {
  if (url === 'about:blank' || url === '') return undefined; // blank tabs can be automated
  if (/^(chrome|chrome-extension|devtools|edge|brave|about|view-source):/.test(url)) return 'browser-internal page';
  if (/^https:\/\/chrome(web)?store\.google\.com/.test(url)) return 'Chrome Web Store';
  return undefined;
}
