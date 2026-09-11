// Messages between the dashboard page and the service worker.
import type { TabInfo, ToolInfo } from '../../shared/protocol.ts';

export interface OpLog { id: number; at: number; ms: number; tabId: number; tabLabel: string; method: string; ok: boolean; error?: string; client?: string }
export interface WindowInfo { id: number; focused: boolean; incognito: boolean }
export interface State {
  connected: boolean;
  stopped: boolean;
  /** Every tab, current and future, is shared. */
  shareAll: boolean;
  /** Record per-command activity (off by default: nothing is stored). */
  activityLog: boolean;
  /** Tools the companion offers (received on connect, cached) and the ones the user switched off. */
  toolCatalog: ToolInfo[];
  disabledTools: string[];
  /** Reported by the companion with its catalog; undefined means an old companion (or not connected yet). */
  companionVersion?: string;
  /** When the agent may launch the developer-mode browser. */
  devMode: 'auto' | 'always' | 'never';
  /** Pairing token, shown so the user can build the HTTP endpoint URL for URL-based clients. */
  token?: string;
  port: number;
  hasToken: boolean;
  lastError?: string;
  connectedAt?: number;
  extensionVersion: string;
  windows: WindowInfo[];
  tabs: TabInfo[];
  recent: OpLog[];
  totals: { ops: number; errors: number };
}
export type PopupMsg =
  | { type: 'getState' }
  | { type: 'setConfig'; token: string; port: number }
  | { type: 'setShared'; tabIds: number[]; shared: boolean }
  | { type: 'setShareAll'; on: boolean }
  | { type: 'setActivityLog'; on: boolean }
  | { type: 'setToolEnabled'; name: string; enabled: boolean }
  | { type: 'setDevMode'; mode: 'auto' | 'always' | 'never' }
  | { type: 'setToolsEnabled'; names: string[]; enabled: boolean }
  | { type: 'connect' }
  | { type: 'stop' }
  | { type: 'clearLog' }
  | { type: 'focusTab'; tabId: number };
